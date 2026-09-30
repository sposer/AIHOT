// Outbound HTTP for collectors, the image proxy and the paid APIs: SSRF guard, routing, limits.
import net from "node:net";
import { AsyncLocalStorage } from "node:async_hooks";
import { addAbortListener } from "node:events";
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { config } from "../config.ts";
import { assertPublicUrl, guardedLookup } from "./url.ts";
import { SITE } from "@aihot/industry/site";

/**
 * Where a request leaves the host. "egress" (collection, bodies, images and leaderboard data) goes
 * through the egress proxy when EGRESS_PROXY_URL is set (for example a rule-based proxy that connects
 * .cn and .local names and Chinese or private addresses directly and sends the rest abroad); the names
 * and address literals such a proxy would connect directly are connected here instead, so the
 * connect-time address check still applies. "direct" is for paid APIs called straight (SocialData,
 * Dajiala) and the site's own addresses.
 */
export type EgressRoute = "egress" | "direct";

let proxyAgent: ProxyAgent | null = null;
let directAgent: Agent | null = null;

export interface FetchTraceEvent {
  host: string;
  origin: string;
  route: EgressRoute;
  proxied: boolean;
  method: string;
  status: number | null;
  waitMs: number;
  elapsedMs: number;
  bytes: number;
  redirect: boolean;
  retryAfterSeconds: number | null;
  error: string | null;
}

export type FetchTrace = FetchTraceEvent[];

export interface FetchTraceSummary {
  requests: number;
  proxied: number;
  bytes: number;
  waitMs: number;
  elapsedMs: number;
  maxMs: number;
  retryAfterSeconds: number | null;
  statuses: Record<string, number>;
  errors: Record<string, number>;
  origins: Array<{
    host: string;
    origin: string;
    route: EgressRoute;
    proxied: boolean;
    requests: number;
    bytes: number;
    waitMs: number;
    elapsedMs: number;
    maxMs: number;
    statuses: Record<string, number>;
    errors: Record<string, number>;
  }>;
}

// decision: carry one collection run's HTTP observations with AsyncLocalStorage; not thread an
// observer through every source, paid-provider and detail helper because nested fallbacks must keep
// one trace without widening all of their public interfaces.
const fetchTraceStorage = new AsyncLocalStorage<FetchTrace>();

export const createFetchTrace = (): FetchTrace => [];

export function withFetchTrace<T>(trace: FetchTrace, work: () => Promise<T>): Promise<T> {
  return fetchTraceStorage.run(trace, work);
}

const count = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
const sortedCounts = (map: Map<string, number>) => Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b)));

export function summarizeFetchTrace(trace: FetchTrace): FetchTraceSummary | null {
  if (trace.length === 0) return null;
  const statuses = new Map<string, number>();
  const errors = new Map<string, number>();
  const origins = new Map<string, {
    host: string;
    origin: string;
    route: EgressRoute;
    proxied: boolean;
    requests: number;
    bytes: number;
    waitMs: number;
    elapsedMs: number;
    maxMs: number;
    statuses: Map<string, number>;
    errors: Map<string, number>;
  }>();
  let proxied = 0;
  let bytes = 0;
  let waitMs = 0;
  let elapsedMs = 0;
  let maxMs = 0;
  let retryAfterSeconds: number | null = null;
  for (const event of trace) {
    const status = event.status === null ? null : String(event.status);
    if (status) count(statuses, status);
    if (event.error) count(errors, event.error);
    if (event.proxied) proxied += 1;
    bytes += event.bytes;
    waitMs += event.waitMs;
    elapsedMs += event.elapsedMs;
    maxMs = Math.max(maxMs, event.waitMs + event.elapsedMs);
    if (event.retryAfterSeconds !== null) retryAfterSeconds = Math.max(retryAfterSeconds ?? 0, event.retryAfterSeconds);
    const originKey = `${event.origin}\0${event.route}\0${event.proxied ? "proxy" : "direct"}`;
    const aggregate = origins.get(originKey) ?? {
      host: event.host, origin: event.origin, route: event.route, proxied: event.proxied,
      requests: 0, bytes: 0, waitMs: 0, elapsedMs: 0, maxMs: 0,
      statuses: new Map<string, number>(), errors: new Map<string, number>(),
    };
    aggregate.requests += 1;
    aggregate.bytes += event.bytes;
    aggregate.waitMs += event.waitMs;
    aggregate.elapsedMs += event.elapsedMs;
    aggregate.maxMs = Math.max(aggregate.maxMs, event.waitMs + event.elapsedMs);
    if (status) count(aggregate.statuses, status);
    if (event.error) count(aggregate.errors, event.error);
    origins.set(originKey, aggregate);
  }
  return {
    requests: trace.length, proxied, bytes, waitMs, elapsedMs, maxMs, retryAfterSeconds,
    statuses: sortedCounts(statuses), errors: sortedCounts(errors),
    origins: [...origins.values()]
      .sort((a, b) => a.origin.localeCompare(b.origin) || a.route.localeCompare(b.route) || Number(a.proxied) - Number(b.proxied))
      .map((value) => ({
        host: value.host,
        origin: value.origin,
        route: value.route,
        proxied: value.proxied,
        requests: value.requests,
        bytes: value.bytes,
        waitMs: value.waitMs,
        elapsedMs: value.elapsedMs,
        maxMs: value.maxMs,
        statuses: sortedCounts(value.statuses),
        errors: sortedCounts(value.errors),
      })),
  };
}

interface HostWaiter {
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  abort: ReturnType<typeof addAbortListener>;
}

interface HostState {
  active: number;
  cooldownUntil: number;
  nextStartAt: number;
  queue: HostWaiter[];
  timer: ReturnType<typeof setTimeout> | null;
}

const createHostState = (): HostState => ({ active: 0, cooldownUntil: 0, nextStartAt: 0, queue: [], timer: null });
const hostJitterMs = () => Math.round(Math.random() * config.outboundHostJitterMs);

// decision: key limits by target hostname; not full origin because alternate schemes or ports must not
// multiply one domain's configured concurrency allowance or escape its Retry-After cooldown.
class HostScheduler {
  private readonly states = new Map<string, HostState>();

  acquire(host: string, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    const state = this.states.get(host) ?? createHostState();
    this.states.set(host, state);
    return new Promise((resolve, reject) => {
      const waiter = {} as HostWaiter;
      waiter.signal = signal;
      waiter.resolve = resolve;
      waiter.reject = reject;
      waiter.abort = addAbortListener(signal, () => {
        const at = state.queue.indexOf(waiter);
        if (at >= 0) state.queue.splice(at, 1);
        reject(signal.reason);
        this.drain(host, state);
      });
      state.queue.push(waiter);
      this.drain(host, state);
    });
  }

  cooldown(host: string, seconds: number): void {
    if (seconds <= 0) return;
    const state = this.states.get(host) ?? createHostState();
    this.states.set(host, state);
    state.cooldownUntil = Math.max(state.cooldownUntil, performance.now() + seconds * 1000);
    this.drain(host, state);
  }

  private drain(host: string, state: HostState): void {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.queue.length === 0) {
      const keepUntil = Math.max(state.cooldownUntil, state.nextStartAt);
      if (state.active === 0 && keepUntil <= performance.now()) this.states.delete(host);
      else if (state.active === 0) this.schedule(host, state, keepUntil - performance.now(), false);
      return;
    }
    if (state.active >= config.outboundHostConcurrency) return;
    const delay = Math.max(state.cooldownUntil, state.nextStartAt) - performance.now();
    if (delay > 0) {
      this.schedule(host, state, delay);
      return;
    }
    const waiter = state.queue.shift()!;
    waiter.abort[Symbol.dispose]();
    if (waiter.signal.aborted) {
      waiter.reject(waiter.signal.reason);
      this.drain(host, state);
      return;
    }
    state.active += 1;
    state.nextStartAt = performance.now() + config.outboundHostMinIntervalMs + hostJitterMs();
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      state.active -= 1;
      this.drain(host, state);
    });
    this.drain(host, state);
  }

  private schedule(host: string, state: HostState, delay: number, keepAlive = true): void {
    state.timer = setTimeout(() => {
      state.timer = null;
      this.drain(host, state);
    }, Math.max(1, Math.ceil(delay)));
    if (!keepAlive) state.timer.unref?.();
  }
}

const hostScheduler = new HostScheduler();

function proxied(url: URL, route: EgressRoute): boolean {
  if (route !== "egress" || !config.egressProxyUrl) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return net.isIP(host) === 0 && !host.endsWith(".cn") && !host.endsWith(".local");
}

function dispatcherFor(viaProxy: boolean): Dispatcher | undefined {
  if (viaProxy) {
    proxyAgent ??= new ProxyAgent(config.egressProxyUrl!);
    return proxyAgent;
  }
  if (config.allowPrivateNetworkFetch) return undefined;
  // Direct connections resolve through the guarded lookup: the address actually dialled is checked.
  directAgent ??= new Agent({ connect: { lookup: guardedLookup as never } });
  return directAgent;
}

export interface GuardedFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Follow redirects manually so every hop passes the SSRF guard. */
  maxRedirects?: number;
  /** "egress" by default; see EgressRoute. */
  route?: EgressRoute;
}

export interface GuardedResponse {
  status: number;
  url: string;
  headers: Headers;
  body: Buffer;
  retryAfterSeconds: number | null;
  text(): string;
}

/** The transport was never invoked for this logical request, including all redirect hops. */
export class RequestNotSentError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    // Preserve callers' timeout/error classifications while carrying explicit delivery evidence.
    this.name = cause instanceof Error ? cause.name : "Error";
  }
}

function errorCategory(error: unknown): string {
  if (!(error instanceof Error)) return "Error";
  return "code" in error && typeof error.code === "string" ? error.code : error.name;
}

export function retryAfterSeconds(headers: Headers, now = Date.now()): number | null {
  const value = headers.get("retry-after")?.trim();
  if (!value || config.outboundRetryAfterMaxSeconds <= 0) return null;
  let seconds: number | null;
  if (/^\d+$/.test(value)) {
    const parsed = Number(value);
    seconds = Number.isFinite(parsed) ? parsed : null;
  } else {
    const at = Date.parse(value);
    seconds = Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : null;
  }
  return seconds === null ? null : Math.min(seconds, config.outboundRetryAfterMaxSeconds);
}

/** How the collectors introduce themselves: the site's own crawler name and address (industry/site.ts). */
export const DEFAULT_UA = `Mozilla/5.0 (compatible; ${SITE.crawlerName}/1.0; +${config.siteUrl}/about)`;

export async function guardedFetch(input: string, opts: GuardedFetchOptions = {}): Promise<GuardedResponse> {
  // One budget includes target-host queueing, DNS, every redirect and the body. Restarting it at each hop
  // allowed a nominal 20 s image request to occupy the API for minutes.
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
  const route = opts.route ?? "egress";
  const method = (opts.method ?? "GET").toUpperCase();
  const trace = fetchTraceStorage.getStore();
  const check = (target: string) => withinDeadline(
    assertPublicUrl(target, config.allowPrivateNetworkFetch, proxied(new URL(target), route)), signal,
  );
  const maxRedirects = opts.maxRedirects ?? 5;
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  let target = input;
  let dispatched = false;
  try {
    for (let hop = 0; ; hop++) {
      const url = new URL(target);
      const origin = url.origin;
      const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      const viaProxy = proxied(url, route);
      const startedAt = performance.now();
      let waitMs = 0;
      let release: (() => void) | null = null;
      let status: number | null = null;
      let size = 0;
      let retryAfter: number | null = null;
      let redirect = false;
      let nextUrl: string | null = null;
      let recorded = false;
      const record = (error: unknown = null) => {
        if (recorded) return;
        recorded = true;
        trace?.push({
          host, origin, route, proxied: viaProxy, method, status, waitMs,
          elapsedMs: Math.max(0, Math.round(performance.now() - startedAt - waitMs)), bytes: size, redirect,
          retryAfterSeconds: retryAfter, error: error ? errorCategory(error) : null,
        });
      };

      try {
        // DNS is part of this hop's observation, even when no socket can be opened.
        await check(target);
        const queuedAt = performance.now();
        try {
          release = await hostScheduler.acquire(host, signal);
        } finally {
          waitMs = Math.max(0, Math.round(performance.now() - queuedAt));
        }
        const dispatcher = dispatcherFor(viaProxy);
        signal.throwIfAborted();
        dispatched = true;
        const res = await undiciFetch(url, {
          method,
          headers: { "user-agent": DEFAULT_UA, "accept-language": "zh-CN,zh;q=0.9,en;q=0.8", ...(opts.headers ?? {}) },
          body: opts.body,
          redirect: "manual",
          dispatcher,
          signal,
        });
        status = res.status;
        const headers = res.headers as unknown as Headers;
        retryAfter = retryAfterSeconds(headers);
        if ((res.status === 429 || res.status === 503) && retryAfter !== null) hostScheduler.cooldown(host, retryAfter);
        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && location) {
          redirect = true;
          // Release the connection even when the next URL is refused or the redirect limit is reached.
          await res.body?.cancel();
          if (hop >= maxRedirects) throw new Error(`Too many redirects for ${input}`);
          nextUrl = new URL(location, url).toString();
          record();
        } else {
          const chunks: Buffer[] = [];
          if (res.body) {
            for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
              size += chunk.byteLength;
              if (size > maxBytes) throw new Error(`Response too large from ${url.hostname}`);
              chunks.push(Buffer.from(chunk));
            }
          }
          const body = Buffer.concat(chunks);
          record();
          return {
            status: res.status,
            url: url.toString(),
            headers,
            body,
            retryAfterSeconds: retryAfter,
            text: () => decodeBody(body, res.headers.get("content-type")),
          };
        }
      } catch (error) {
        record(error);
        throw error;
      } finally {
        release?.();
      }
      target = nextUrl!;
    }
  } catch (error) {
    // decision: classify by transport dispatch across the whole redirect chain; not by timeout
    // text because a timed-out later hop may follow a request the paid provider already accepted.
    if (!dispatched) throw new RequestNotSentError(error);
    throw error;
  }
}

/** DNS lookup cannot be cancelled, but a timed-out lookup must never continue into a fetch. */
async function withinDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let subscription: ReturnType<typeof addAbortListener> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      subscription = addAbortListener(signal, () => reject(signal.reason));
    })]);
  } finally {
    subscription?.[Symbol.dispose]();
  }
}

function decodeBody(body: Buffer, contentType: string | null): string {
  const m = /charset=([\w-]+)/i.exec(contentType ?? "");
  let charset = m?.[1]?.toLowerCase() ?? "utf-8";
  if (!m) {
    const head = body.subarray(0, 2048).toString("latin1");
    const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head) ?? /encoding=["']([\w-]+)["']/i.exec(head);
    if (meta) charset = meta[1]!.toLowerCase();
  }
  let text: string;
  try {
    text = new TextDecoder(charset === "gb2312" ? "gbk" : charset).decode(body);
  } catch {
    text = body.toString("utf8");
  }
  // A character lost on the way reads as one U+FFFD however many of its bytes were garbled (some
  // feeds send two or three for one character), so text cut to a length keeps the same cut.
  return text.replace(/\uFFFD+/g, "\uFFFD");
}
