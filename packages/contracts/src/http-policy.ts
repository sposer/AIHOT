// Outward HTTP behaviour, defined once: CORS, cache lifetimes, redirects and which process owns a path.
// The API server and the web server both read this module.
import { isReportScope, type ReportKind, type ReportScope } from "./site.ts";
import { feedColumns, isDomainKey } from "./taxonomy.ts";

/** Report identity is kind/scope/key; the latest overview omits its all scope in the page path. */
// decision: 共用报告路径生成器；not 网页与各公开出口分别拼接 because 日期详情必须在所有出口指向同一个范围身份。
export function reportPath(kind: ReportKind, scope: ReportScope, key?: string): string {
  if (key) return `/${kind}/${scope}/${key}`;
  return scope === "all" ? `/${kind}` : `/${kind}/${scope}`;
}

export function reportArchivePath(scope: ReportScope): string {
  return `${reportPath("daily", scope)}/archive`;
}

/** The URL owns content scope; other public pages may carry it as navigation context. */
export function domainScope(pathname: string, params: URLSearchParams): ReportScope | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "all") return isDomainKey(parts[1]) ? parts[1] : "all";
  if (["daily", "weekly", "monthly"].includes(parts[0])) return isReportScope(parts[1]) ? parts[1] : "all";
  const query = params.get("domain");
  if (isReportScope(query)) return query;
  if (pathname === "/" || ["hot", "story", "topics"].includes(parts[0])) return "all";
  return null;
}

/** One path owner for sidebar, phone navigation and links that leave scoped content. */
export function domainHref(pathname: string, scope: ReportScope, params = new URLSearchParams()): string {
  const sp = new URLSearchParams(params);
  const parts = pathname.split("/").filter(Boolean);
  let path = pathname;
  sp.delete("domain");
  if (parts[0] === "all") {
    path = scope === "all" ? "/all" : `/all/${scope}`;
  } else if (["daily", "weekly", "monthly"].includes(parts[0])) {
    const kind = parts[0] as ReportKind;
    const key = parts.length === 3 && parts[2] !== "archive" ? parts[2] : undefined;
    path = parts.includes("archive") ? reportArchivePath(scope) : reportPath(kind, scope, key);
  } else if (pathname === "/" || ["hot", "story", "topics"].includes(parts[0])) {
    if (scope !== "all") sp.set("domain", scope);
  } else {
    // Global objects and information pages keep their identity, not a filtered copy of their data.
    sp.set("domain", scope);
  }
  const query = sp.toString();
  return query ? `${path}?${query}` : path;
}

/** Change the current view's scope without carrying paging or unsupported subcolumns across it. */
export function switchDomainHref(pathname: string, params: URLSearchParams, scope: ReportScope): string {
  if (domainScope(pathname, params) === scope) {
    const query = params.toString();
    return query ? `${pathname}?${query}` : pathname;
  }
  const sp = new URLSearchParams(params);
  const columns = feedColumns(scope === "all" ? null : scope);
  const feed = pathname === "/" || /^\/all(?:\/[^/]+)?$/.test(pathname);
  // decision: clean only navigation to a new domain; not rewrite incoming filters because direct URLs remain valid API queries, even without a matching presentation preset.
  for (const key of ["category", "tag", "channel"] as const) {
    const value = sp.get(key);
    if (!feed || (scope !== "all" && value && !columns.some(({ filters }) => filters[key] === value))) sp.delete(key);
  }
  for (const key of ["page", "cursor", "search"]) sp.delete(key);
  let path = pathname.replace(/\/page\/\d+$/, "");
  // Report domain switches open that domain's latest issue, as the report navigation does.
  const kind = /^\/(daily|weekly|monthly)\/[^/]+\/[^/]+$/.exec(path)?.[1] as ReportKind | undefined;
  if (kind && !path.endsWith("/archive")) path = `/${kind}`;
  return domainHref(path, scope, sp);
}

/** CORS for /api/v1/* and /openapi-v1.json. */
export const PUBLIC_API_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Accept, If-None-Match, If-Modified-Since",
  "Access-Control-Expose-Headers": "ETag, Last-Modified, Retry-After, X-Request-Id, Link",
  "Access-Control-Max-Age": "86400",
};

/** Cache-Control per v1 operation. */
export const V1_CACHE_CONTROL = {
  items: "public, max-age=60, s-maxage=60, stale-while-revalidate=300",
  codexResets: "public, max-age=60, s-maxage=60, stale-while-revalidate=60",
  hotTopics: "public, max-age=60, s-maxage=60, stale-while-revalidate=60",
  storyByPublicId: "public, max-age=60, s-maxage=60, stale-while-revalidate=60",
  dailies: "public, max-age=60, s-maxage=60, stale-while-revalidate=300",
  latestDaily: "public, max-age=60, s-maxage=60, stale-while-revalidate=300",
  dailyByDate: "public, max-age=300, s-maxage=300, stale-while-revalidate=3600",
  selectedSnapshot: "public, max-age=300, s-maxage=300, stale-while-revalidate=900",
  selectedChanges: "public, max-age=60, s-maxage=60, stale-while-revalidate=60",
} as const;

export const RSS_CACHE_CONTROL = "public, max-age=300, s-maxage=300, stale-while-revalidate=900";
export const NO_STORE = "no-store";

export interface RedirectRule {
  match: "exact" | "regex" | "prefix";
  path: string;
  status: 301 | 302 | 307 | 308 | 404 | 410;
  /** Relative Location. `$1`… refer to regex groups; `*` appends the remainder for prefix rules. */
  location?: string;
  keepQuery?: boolean;
  headers?: Record<string, string>;
  why?: string;
}

/** Redirects. Locations are always relative, so they stay right behind any proxy. */
export const REDIRECTS: RedirectRule[] = [
  {
    match: "regex",
    path: "^/(all|about|agent|changelog|codex-reset|feedback|starred|more|privacy|terms)/+$",
    status: 301,
    location: "/$1",
    keepQuery: true,
  },
  {
    match: "regex",
    path: "^/(feed|rss|rss\\.xml|atom\\.xml)$",
    status: 301,
    location: "/feed.xml",
    keepQuery: true,
    why: "RSS reader aliases",
  },
  { match: "exact", path: "/leaderboard/methodology", status: 308, location: "/leaderboard/sources" },
  { match: "regex", path: "^/leaderboard/category/(aesthetics|writing)$", status: 307, location: "/leaderboard", why: "data-layer categories not yet public" },
  { match: "exact", path: "/leaderboard/category/overall", status: 404, why: "the overall board lives at /leaderboard" },
  { match: "prefix", path: "/sources", status: 302, location: "/admin/sources*", why: "admin bookmarks" },
];

export interface RedirectDecision {
  status: number;
  location: string | null;
  headers: Record<string, string>;
}

export function resolveRedirect(pathname: string, search: string): RedirectDecision | null {
  for (const rule of REDIRECTS) {
    let location: string | null = null;
    if (rule.match === "exact") {
      if (pathname !== rule.path) continue;
      location = rule.location ?? null;
    } else if (rule.match === "prefix") {
      const inTree = rule.path.endsWith("/")
        ? pathname.startsWith(rule.path)
        : pathname === rule.path || pathname.startsWith(`${rule.path}/`);
      if (!inTree) continue;
      location = rule.location ? rule.location.replace("*", pathname.slice(rule.path.length)) : null;
    } else {
      const m = new RegExp(rule.path).exec(pathname);
      if (!m) continue;
      location = rule.location ? rule.location.replace(/\$(\d)/g, (_s, i: string) => m[Number(i)] ?? "") : null;
    }
    if (location && rule.keepQuery && search) location += search;
    return { status: rule.status, location, headers: rule.headers ?? {} };
  }
  return null;
}

/** OAuth discovery probes from MCP clients: a cheap 404, never a rendered page. */
export const OAUTH_PROBE_PATHS = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/api/mcp",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/api/mcp",
  "/.well-known/openid-configuration",
  "/.well-known/openid-configuration/api/mcp",
  "/api/mcp/.well-known/oauth-protected-resource",
  "/api/mcp/.well-known/oauth-authorization-server",
  "/api/mcp/.well-known/openid-configuration",
];

/**
 * Paths served by the api process; everything else is the web process. The web server proxies these to
 * the api (a reverse proxy in front may also route them straight to it). Patterns are anchored so page
 * paths such as /feedback never fall into /feed.
 */
export const API_OWNED_PATTERNS: RegExp[] = [
  /^\/api\//,
  /^\/feed(\.xml|\/.*)?$/,
  /^\/(rss|rss\.xml|atom\.xml)$/,
  /^\/openapi-v1\.json$/,
  /^\/(llms\.txt|robots\.txt|sitemap\.xml|manifest\.webmanifest)$/,
  /^\/sitemaps\//,
  /^\/\.well-known\//,
  /^\/(favicon\.ico|icon\.png|icon-192\.png|apple-icon\.png|logo\.svg)$/,
  /^\/(model-providers|leaderboard-sources|og|contact)\//,
  /^\/[0-9a-f]{32}\.txt$/,
  /^\/items\/[^/]+\/markdown$/,
];

export function isApiOwned(pathname: string): boolean {
  return API_OWNED_PATTERNS.some((re) => re.test(pathname));
}
