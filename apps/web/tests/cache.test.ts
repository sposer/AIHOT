// Run after `npm run build -w @aihot/web`. Real production server/router, synthetic HTTP API only.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import type { ReportKind } from "@aihot/contracts/site";
import { load } from "cheerio";
import { releaseBoundCache } from "../app/lib/api.server.ts";

let web: ChildProcess;
let origin: string;
let logs = "";
let deadline: number;
let refreshAt: string;
let metaDelayMs = 0;
const apiCookies: Array<string | undefined> = [];
const apiUrls: string[] = [];
let reportIndexLimit: number | null = null;
const reportKeys: Record<ReportKind, string[]> = {
  daily: ["2026-09-28", "2026-09-27", "2026-09-26", "2026-09-25"],
  weekly: ["2026-W39", "2026-W38", "2026-W37", "2026-W36"],
  monthly: ["2026-09", "2026-08", "2026-07", "2026-06"],
};
const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://api.local");
  apiUrls.push(url.pathname + url.search);
  apiCookies.push(req.headers.cookie);
  res.setHeader("Content-Type", "application/json");
  if (url.pathname === "/api/site/meta") {
    const respond = () => res.end(JSON.stringify({ changelogVersion: "2026-09-28T12:00" }));
    return metaDelayMs ? setTimeout(respond, metaDelayMs) : respond();
  }
  if (url.pathname === "/api/site/timeline") {
    const filters = { channel: "all", category: url.searchParams.get("category"), tag: null, topic: null };
    res.setHeader("X-Accel-Expires", `@${deadline}`);
    res.setHeader("Cache-Control", "public, max-age=30, s-maxage=30");
    return res.end(JSON.stringify({ filters, cards: [], nextCursor: null, refreshAt, dayCounts: [], hot: null, generatedAt: "2026-09-28T00:00:00Z" }));
  }
  if (url.pathname === "/api/site/pool") {
    const domain = url.searchParams.get("domain");
    return res.end(JSON.stringify({
      filters: { domain, channel: url.searchParams.get("channel") ?? "all", category: url.searchParams.get("category"), tag: url.searchParams.get("tag"), q: url.searchParams.get("q"), tab: "time" },
      items: [], page: Number(url.searchParams.get("page") ?? 1), pageCount: 3, total: 0, todayCount: 0, freshness: "2026-09-28T00:00:00Z", generatedAt: "2026-09-28T00:00:00Z",
    }));
  }
  const reportRoute = /^\/api\/site\/reports\/(daily|weekly|monthly)(?:\/|$)/.exec(url.pathname);
  if (reportRoute) {
    const kind = reportRoute[1] as ReportKind;
    const scope = url.searchParams.get("domain") ?? "all";
    const keys = reportKeys[kind];
    const last = url.pathname.split("/").at(-1)!;
    const key = keys.includes(last) ? last : keys[0]!;
    const at = keys.indexOf(key);
    const index = keys.slice(0, reportIndexLimit ?? keys.length).map((key, i) => ({ scope, key, title: i === 0 ? `edition-${scope}` : null, generatedAt: "2026-09-28T00:00:00Z", count: 0 }));
    const report = {
      kind, scope, key, title: `edition-${scope}`, windowStart: "2026-09-27T00:00:00Z", windowEnd: "2026-09-28T00:00:00Z",
      generatedAt: "2026-09-28T00:00:00Z", revision: 1, lead: at === 0 ? { title: `edition-${scope}`, leadParagraph: "临床研究" } : null,
      overview: null, highlights: [], sections: [], stories: [], flashes: [], cover: null, metrics: {}, readingMinutes: 1,
      prev: keys[at + 1] ?? null, next: keys[at - 1] ?? null,
    };
    if (url.pathname.endsWith("/latest-page")) return res.end(JSON.stringify({ scope, index, report: index.length ? report : null }));
    if (url.pathname === `/api/site/reports/${kind}` || url.pathname.includes("/navigation/") || url.pathname.includes("/months/")) return res.end(JSON.stringify({ scope, items: index }));
    return res.end(JSON.stringify(report));
  }
  if (url.pathname === "/api/site/hot") return res.end(JSON.stringify({ computedAt: "2026-09-28T00:00:00Z", entries: [{
    rank: 1, domains: ["ai", "medical"], story: { publicId: "scoped-story", title: "Cross-domain story" },
    heat: 20, trend: "flat", trendPct: 0, badges: [], participantCount: 2, sourceCount: 1, signalCount: 0, reportCount: 1,
    sourceNames: ["Source"], latestAt: "2026-09-28T00:00:00Z", firstReportAt: "2026-09-28T00:00:00Z",
    representative: { id: "medical-item", url: "https://example.org/medical", sourceName: "Source" },
    participants: [], spark: [], summary: null, latest: null, cover: null,
  }] }));
  const topic = { slug: "scoped-topic", name: "Scoped topic", group: "field", definition: "Topic definition", total: 21, recent: 21, indexable: true, latestAt: "2026-09-28T00:00:00Z" };
  if (url.pathname === "/api/site/topics") return res.end(JSON.stringify({ topics: [topic] }));
  if (url.pathname === "/api/site/topics/scoped-topic") return res.end(JSON.stringify({ topic: { ...topic, related: [{ slug: "related-topic", name: "Related" }] }, items: [], page: Number(url.searchParams.get("page") ?? 1), pageCount: 2 }));
  if (url.pathname === "/api/site/stories/scoped-story") return res.end(JSON.stringify({
    publicId: "scoped-story", title: "Cross-domain story", domains: ["ai", "medical"], status: "active", sourceCount: 1, reportCount: 1,
    firstReportAt: "2026-09-28T00:00:00Z", latestAt: "2026-09-28T00:00:00Z", digest: null, digestUpdatedAt: null,
    summary: null, excerpt: null, latest: null, whyHot: { participants48h: 2, newParticipants6h: 1, recentReports24h: 1, observationComplete: true, rank: 1, heat: 20 },
    developments: [], officialReports: [], timeline: [], heat: [], related: [{ publicId: "related-story", title: "Related", relation: "related", latestAt: "2026-09-28T00:00:00Z" }],
  }));
  if (url.pathname === "/api/site/echo-client") return res.end(JSON.stringify({ forwarded: req.headers["x-forwarded-for"], real: req.headers["x-real-ip"] }));
  if (url.pathname === "/api/site/items/long-lived") return res.end(JSON.stringify({ id: "long-lived", title: "t" }));
  if (url.pathname === "/api/site/contact") return res.end(JSON.stringify({ wechatQr: "/qr.png", feishuQr: "/qr.png" }));
  if (url.pathname === "/api/site/stories/merged") {
    res.statusCode = 308;
    return res.end(JSON.stringify({ mergedInto: "surviving-story" }));
  }
  res.statusCode = url.pathname.startsWith("/api/admin/") ? 401 : 404;
  res.end(JSON.stringify({ code: "not_found" }));
});

before(async () => {
  deadline = Math.floor(Date.now() / 1000) + 20;
  refreshAt = new Date((deadline + 5) * 1000).toISOString();
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  web = spawn(process.execPath, [fileURLToPath(new URL("../server.ts", import.meta.url))], {
    env: { ...process.env, WEB_PORT: "0", TRUST_PROXY: "false", API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`web did not start: ${logs}`)), 15_000);
    web.on("exit", () => { clearTimeout(timeout); reject(new Error(`web exited: ${logs}`)); });
    web.stderr!.on("data", (chunk) => { logs += String(chunk); });
    web.stdout!.on("data", (chunk) => {
      logs += String(chunk);
      const match = logs.match(/"msg":"web started","port":(\d+)/);
      if (match) {
        origin = `http://127.0.0.1:${match[1]}`;
        clearTimeout(timeout);
        resolve();
      }
    });
  });
});

after(async () => {
  if (web && web.exitCode === null) {
    web.kill("SIGTERM");
    await once(web, "exit");
  }
  api.closeAllConnections();
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

test("public route subsets produce the same complete navigation data; filters still differ", async () => {
  const answers = await Promise.all(["", "?_routes=root", "?_routes=routes%2Fhome", "?_routes=unknown"].map(async (query) => {
    const res = await fetch(`${origin}/_.data${query}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Cache-Control")!, /^public,/);
    assert.equal(res.headers.get("X-Accel-Expires"), `@${deadline}`);
    assert.doesNotMatch(res.headers.get("Cache-Control")!, /stale/);
    const body = await res.text();
    assert.ok(body.includes("root") && body.includes("routes/home"));
    return body;
  }));
  assert.ok(answers.every((body) => body === answers[0]));
  const category = CATEGORY_KEYS.at(-1)!;
  const filtered = await fetch(`${origin}/_.data?category=${category}&_routes=root`);
  const body = await filtered.text();
  assert.ok(body.includes(category));
  assert.notEqual(body, answers[0]);
});

test("HTML and navigation share freshness; cookies do not personalize public results", async () => {
  const html = await fetch(`${origin}/`);
  assert.equal(html.status, 200);
  assert.equal(html.headers.get("X-Accel-Expires"), `@${deadline}`);
  assert.match(await html.text(), /精选/);
  const plain = await fetch(`${origin}/about.data`);
  const signedIn = await fetch(`${origin}/about.data?_routes=root`, { headers: { cookie: "admin_session=private; aihot_vid=reader" } });
  assert.match(plain.headers.get("Cache-Control")!, /^public,/);
  assert.match(plain.headers.get("X-Accel-Expires")!, /^@\d+$/);
  assert.equal(plain.headers.get("Cache-Control"), "public, max-age=300, s-maxage=300, must-revalidate");
  assert.equal(Date.parse(plain.headers.get("Date")!) / 1000 + 300, Number(plain.headers.get("X-Accel-Expires")!.slice(1)));
  assert.equal(signedIn.headers.get("Set-Cookie"), null);
  assert.equal(await signedIn.text(), await plain.text());
  assert.ok(apiCookies.every((cookie) => !cookie));
});

test("missing routes cannot be hidden by a root-only request; errors and redirects stay uncached", async () => {
  for (const pathname of ["/items/missing.data?_routes=root", "/does-not-exist.data?_routes=root", "/items/missing"]) {
    const res = await fetch(origin + pathname);
    assert.equal(res.status, 404, pathname);
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
    assert.equal(res.headers.get("X-Accel-Expires"), "0");
    await res.text();
  }
  for (const [pathname, target] of [["/story/merged.data?_routes=root", "/story/surviving-story"], ["/story/merged.data?domain=medical&_routes=root", "/story/surviving-story?domain=medical"], ["/_.data?q=search&_routes=root", "/all?q=search"]]) {
    const res = await fetch(origin + pathname);
    assert.equal(res.status, 202);
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
    assert.match(await res.text(), new RegExp(target.replace("?", "\\?")));
  }
});

test("admin data and actions never become public cache entries", async () => {
  const admin = await fetch(`${origin}/admin/sources.data?_routes=admin-layout`);
  assert.equal(admin.status, 202);
  assert.equal(admin.headers.get("Cache-Control"), "private, no-store");
  assert.equal(admin.headers.get("X-Accel-Expires"), "0");
  assert.match(await admin.text(), /admin\/login/);
  const action = await fetch(`${origin}/hot.data`, { method: "POST" });
  assert.equal(action.status, 405);
  assert.equal(action.headers.get("Cache-Control"), "private, no-store");
  assert.equal(action.headers.get("X-Accel-Expires"), "0");
  await action.text();
});

test("an elapsed release deadline cannot be extended by a fresh page/data response", async () => {
  const saved = refreshAt;
  refreshAt = new Date(Date.now() - 1000).toISOString();
  try {
    for (const pathname of ["/", "/_.data?_routes=routes%2Fhome"]) {
      const res = await fetch(origin + pathname);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("Cache-Control"), "no-cache");
      assert.equal(res.headers.get("X-Accel-Expires"), "0");
      await res.text();
    }
  } finally {
    refreshAt = saved;
  }
  const now = Date.parse("2026-09-28T00:00:00Z");
  const upstream = new Headers({ "X-Accel-Expires": `@${now / 1000 + 7}` });
  const headers = releaseBoundCache(new Date(now + 20_000).toISOString(), 30, now + 2_000, upstream);
  assert.equal(headers["Cache-Control"], "public, max-age=0, s-maxage=5");
  assert.equal(headers["X-Accel-Expires"], upstream.get("X-Accel-Expires"));
});

test("browser freshness shares the selected deadline, including slow sibling loaders", async () => {
  const savedDeadline = deadline;
  const savedRefresh = refreshAt;
  try {
    deadline = Math.floor(Date.now() / 1000) + 20;
    refreshAt = new Date((deadline + 5) * 1000).toISOString();
    for (const pathname of ["/", "/_.data?_routes=routes%2Fhome"]) {
      const res = await fetch(origin + pathname);
      const cc = res.headers.get("Cache-Control")!;
      const browser = Number(cc.match(/(?:^|,)\s*max-age=(\d+)/)![1]);
      const shared = Number(cc.match(/(?:^|,)\s*s-maxage=(\d+)/)![1]);
      assert.ok(browser > 0 && browser === shared);
      assert.ok(Date.parse(res.headers.get("Date")!) / 1000 + browser <= deadline);
      assert.equal(res.headers.get("X-Accel-Expires"), `@${deadline}`);
      assert.match(cc, /must-revalidate/);
      assert.doesNotMatch(cc, /stale/);
      await res.text();
    }
    // The selected loader initially grants a positive TTL, but root metadata finishes after it.
    deadline = Math.floor(Date.now() / 1000) + 2;
    refreshAt = new Date((deadline + 5) * 1000).toISOString();
    metaDelayMs = 2300;
    await Promise.all(["/", "/_.data?_routes=routes%2Fhome"].map(async (pathname) => {
      const res = await fetch(origin + pathname);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("Cache-Control"), "no-cache");
      assert.equal(res.headers.get("X-Accel-Expires"), "0");
      await res.text();
    }));
  } finally {
    deadline = savedDeadline;
    refreshAt = savedRefresh;
    metaDelayMs = 0;
  }
});

test("the edge may keep a page longer than browsers, which a withdrawal purge cannot reach", async () => {
  const res = await fetch(`${origin}/items/long-lived.data`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=300, s-maxage=600, must-revalidate");
  await res.text();
});

test("browser caching preserves noindex and private sign-in responses", async () => {
  const feedback = await fetch(origin + "/feedback");
  assert.equal(feedback.status, 200);
  assert.match(await feedback.text(), /name="robots" content="noindex/);
  assert.equal(feedback.headers.get("Cache-Control"), "public, max-age=300, s-maxage=300, must-revalidate");
  const login = await fetch(origin + "/admin/login");
  assert.equal(login.status, 200);
  assert.equal(login.headers.get("Cache-Control"), "private, no-store");
  assert.equal(login.headers.get("X-Robots-Tag"), "noindex, nofollow");
  await login.text();
});

test("a visitor cannot name its own address to the api without a trusted proxy in front", async () => {
  const res = await fetch(`${origin}/api/site/echo-client`, { headers: { "X-Forwarded-For": "6.6.6.6", "X-Real-IP": "6.6.6.6" } });
  assert.deepEqual(await res.json(), { forwarded: "127.0.0.1", real: "127.0.0.1" });
});


test("domain pages and editions retain their scope through SSR, navigation and canonical URLs", async () => {
  const canonicalOf = (html: string) => html.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
  for (const pathname of ["/all/medical", "/daily", "/daily/medical", "/daily/all/2026-09-28", "/daily/medical/2026-09-28", "/daily/medical/archive"]) {
    const res = await fetch(origin + pathname);
    assert.equal(res.status, 200, pathname);
    const html = await res.text();
    const page = load(html);
    assert.equal(new URL(canonicalOf(html)!).pathname, pathname);
    const expectedTitle = new Map([
      ["/all/medical", "动态 · MyHOT"],
      ["/daily/medical", "日报 · MyHOT"],
      ["/daily/medical/2026-09-28", "日报 2026-09-28 · MyHOT"],
      ["/daily/medical/archive", "日报 · 历史存档 · MyHOT"],
    ]).get(pathname);
    if (expectedTitle) assert.equal(page("title").text(), expectedTitle);
    if (pathname === "/all/medical") assert.equal(page("h1").first().text().trim(), "动态");
    if (pathname === "/daily/medical") assert.match(page("h1").first().text().replace(/\s+/g, " ").trim(), /^日报 · /);
    if (pathname.startsWith("/daily/medical")) {
      assert.match(html, /href="\/daily\/medical\/2026-09-28"/);
      assert.match(html, /href="\/weekly\/medical"/);
      assert.match(html, /href="\/monthly\/medical"/);
      assert.doesNotMatch(html, /href="\/daily\/all\/2026-09-28"/);
      if (!pathname.endsWith("/archive")) {
        const image = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1];
        assert.equal(new URL(image!).pathname, "/og/reports/daily/medical/2026-09-28.png");
      }
    }
    const data = await fetch(`${origin}${pathname}.data`);
    assert.equal(data.status, 200, `${pathname}.data`);
    const body = await data.text();
    if (pathname.includes("medical")) assert.ok(body.includes("medical"));
  }
  for (const [kind, label] of [["daily", "日报"], ["weekly", "周报"], ["monthly", "月报"]] as const) {
    for (const scope of ["medical", "all"] as const) {
      const res = await fetch(`${origin}/${kind}/${scope}/${reportKeys[kind][2]}`);
      assert.equal(res.status, 200);
      const $ = load(await res.text());
      assert.equal($("title").text(), `${label} ${reportKeys[kind][2]} · MyHOT`);
      const neighbours = $(`nav[aria-label="${kind === "daily" ? "前后日报" : "前后各期"}"]`);
      for (const key of [reportKeys[kind][1]!, reportKeys[kind][3]!]) {
        const selector = `a[href="/${kind}/${scope}/${key}"]`;
        assert.equal(neighbours.find(selector).children("span").last().text(), `${label} · ${key}`);
        assert.equal($("aside nav").find(selector).children("span").last().text(), `${label} ${key}`);
        if (kind !== "daily") assert.equal($("#report-history").find(selector).children("span").last().text(), `MyHOT ${label} · ${key}`);
      }
    }
  }
  for (const pathname of ["/daily/2026-09-28", "/daily/all", "/daily/unknown", "/all/unknown"]) {
    const res = await fetch(origin + pathname);
    assert.equal(res.status, 404, pathname);
    await res.text();
  }
});


test("domain navigation preserves query context and forwards hot, story and topic scope", async () => {
  const paths = [
    "/all/medical?q=clinical&category=paper&channel=news&tag=clinical&page=3&cursor=old",
    "/hot?domain=medical", "/story/scoped-story?domain=medical", "/topics?domain=medical",
    "/topics/scoped-topic/page/2?domain=medical",
  ];
  apiUrls.length = 0;
  const pages = [];
  for (const path of paths) {
    const res = await fetch(origin + path);
    assert.equal(res.status, 200, path);
    pages.push(load(await res.text()));
  }
  const [all, hot, story, topics, topic] = pages;
  assert.equal(hot!("title").text(), "热点 · MyHOT");
  assert.equal(hot!("h1").first().text().trim(), "热点");
  const switchUrl = new URL(all!("nav[aria-label='动态领域'] a[href^='/all/legal']").first().attr("href")!, origin);
  assert.equal(switchUrl.pathname, "/all/legal");
  for (const [key, value] of Object.entries({ q: "clinical", category: "paper", channel: "news", tag: "clinical" })) assert.equal(switchUrl.searchParams.get(key), value);
  assert.equal(switchUrl.searchParams.has("page"), false);
  assert.equal(switchUrl.searchParams.has("cursor"), false);
  assert.ok(hot!("a[href='/story/scoped-story?domain=medical']").length > 0);
  assert.ok(story!("a[href='/hot?domain=medical']").length > 0);
  assert.ok(story!("a[href='/story/related-story?domain=medical']").length > 0);
  assert.ok(topics!("a[href='/topics/scoped-topic?domain=medical']").length > 0);
  assert.ok(topic!("nav[aria-label='分页'] a[href='/topics/scoped-topic?domain=medical']").length > 0);
  assert.ok(topic!("a[href='/topics/related-topic?domain=medical']").length > 0);
  assert.ok(topic!("nav[aria-label='主题领域'] a[href='/topics/scoped-topic?domain=ai']").length > 0);
  for (const path of ["/api/site/hot", "/api/site/stories/scoped-story", "/api/site/topics", "/api/site/topics/scoped-topic"]) {
    assert.ok(apiUrls.some((value) => {
      const u = new URL(value, "http://api.local");
      return u.pathname === path && u.searchParams.get("domain") === "medical";
    }), path);
  }
  assert.ok(apiUrls.some((value) => {
    const u = new URL(value, "http://api.local");
    return u.pathname === "/api/site/topics/scoped-topic" && u.searchParams.get("page") === "2";
  }));
});

test("daily archive stays available in desktop and phone navigation with empty or short histories", async () => {
  try {
    for (const count of [0, 2]) {
      reportIndexLimit = count;
      const res = await fetch(origin + "/daily/medical");
      assert.equal(res.status, 200);
      const $ = load(await res.text());
      const phone = $("nav[aria-label='报告领域']").parents(".lg\\:hidden").first();
      assert.equal(phone.find("a[href='/daily/medical/archive']").length, 1);
      const desktop = $("nav[aria-label='报告领域']").closest("aside");
      assert.equal(desktop.find("a[href='/daily/medical/archive']").length, 1);
      for (const nav of $("nav[aria-label='报告领域']").toArray()) {
        assert.ok($(nav).find("a[href='/daily']").length > 0);
        assert.ok($(nav).find("a[href='/daily/policy']").length > 0);
        assert.equal($(nav).find("a[href*='2026-09']").length, 0);
      }
    }
  } finally {
    reportIndexLimit = null;
  }
});
