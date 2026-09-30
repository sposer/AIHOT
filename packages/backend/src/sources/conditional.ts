// Conditional GET shared by source readers. Validators belong to the source's successful cursor:
// a failed parse or store must never advance them.
import { guardedFetch, type GuardedFetchOptions, type GuardedResponse } from "../lib/http-fetch.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import type { HttpValidator, SourceRow } from "./types.ts";

export interface ConditionalResponse {
  response: GuardedResponse;
  validator: HttpValidator;
  notModified: boolean;
}

function withoutConditionalHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => {
    const name = key.toLowerCase();
    return name !== "if-none-match" && name !== "if-modified-since";
  }));
}

/**
 * Reads one source-owned GET with validators from its cursor. Config changes and manual reads bypass
 * old validators; a redirect into another validator namespace is retried without conditional headers.
 */
export async function conditionalSourceFetch(
  source: SourceRow,
  cursorKey: string,
  input: string,
  opts: GuardedFetchOptions,
  force = false,
): Promise<ConditionalResponse> {
  // decision: keep validators in each source cursor; not a process-wide HTTP cache because first-import
  // windows, config edits and failed stores are business state owned by that source.
  const configHash = sha256(stableJson({ config: source.config, participationMode: source.participation_mode }));
  const saved = source.cursor?.[cursorKey] as HttpValidator | undefined;
  const previous = !force && saved?.configHash === configHash ? saved : null;
  // decision: strip caller-supplied conditional headers; not accept them because only the source cursor
  // can prove which representation a 304 validated, including after an unconditional redirect retry.
  const baseHeaders = withoutConditionalHeaders({ ...(opts.headers ?? {}) });
  const headers = { ...baseHeaders };
  if (previous?.etag) headers["if-none-match"] = previous.etag;
  if (previous?.lastModified) headers["if-modified-since"] = previous.lastModified;
  const sentValidator = !!(previous?.etag || previous?.lastModified);

  let response = await guardedFetch(input, { ...opts, headers });
  // A redirect may have moved to a server whose ETag namespace is unrelated to the old destination.
  if (response.status === 304 && previous && response.url !== previous.responseUrl) {
    response = await guardedFetch(input, { ...opts, headers: baseHeaders });
  }
  const validator: HttpValidator = {
    configHash,
    responseUrl: response.url,
    etag: response.headers.get("etag") ?? (response.status === 304 ? previous?.etag ?? null : null),
    lastModified: response.headers.get("last-modified") ?? (response.status === 304 ? previous?.lastModified ?? null : null),
  };
  const notModified = response.status === 304 && !!previous && sentValidator && response.url === previous.responseUrl;
  return { response, validator, notModified };
}
