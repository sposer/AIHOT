import { SITE, withSubject } from "@aihot/industry/site";
import { data as withHeaders, redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/home";
import type { TimelineResponse } from "@aihot/contracts/site";
import { isCategoryKey, isChannelKey, isDomainKey } from "@aihot/contracts/taxonomy";
import { loadOr404, queryString, releaseBoundCache } from "../lib/api.server";
import { listPath, organizationLd, pageMeta } from "../lib/seo";
import { Wordmark } from "../components/Logo";
import { Timeline } from "../features/feed/Timeline";
import { HotTopics } from "../features/feed/HotTopics";
import { ColumnTabs, SearchField, SearchIconLink } from "../features/feed/Filters";
import { beijingDate, beijingWeekday } from "../lib/format";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const domain = url.searchParams.get("domain");
  if (domain !== null && !isDomainKey(domain)) throw withHeaders({ message: "bad_request" }, { status: 400 });
  const q = url.searchParams.get("q");
  // Search lives on /all; carry the domain in that page's canonical path.
  if (q && q.trim()) {
    url.searchParams.delete("domain");
    throw redirect(`${domain ? `/all/${domain}` : "/all"}${url.search}`);
  }
  const channelParam = url.searchParams.get("channel") ?? "all";
  const categoryParam = url.searchParams.get("category");
  const channel = isChannelKey(channelParam) ? channelParam : "all";
  const category = categoryParam && isCategoryKey(categoryParam) ? categoryParam : null;
  const tag = url.searchParams.get("tag")?.trim() || null;
  const upstream = new Headers();
  const data = await loadOr404<TimelineResponse>(`/api/site/timeline${queryString({ domain, channel: channel === "all" ? null : channel, category, tag })}`, { responseHeaders: upstream, signal: request.signal });
  return withHeaders({ data, filters: { domain, channel, category, tag, topic: null } }, { headers: releaseBoundCache(data.refreshAt, 60, Date.now(), upstream) });
}

export function meta({ loaderData }: Route.MetaArgs) {
  const f = loaderData?.filters;
  const path = listPath("/", { domain: f?.domain, channel: f && f.channel !== "all" ? f.channel : null, category: f?.category, tag: f?.tag });
  return pageMeta({ path, jsonLd: path === "/" ? organizationLd() : undefined });
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

function TodayLabel() {
  const today = beijingDate(Date.now());
  const [, m, d] = today.split("-").map(Number) as [number, number, number];
  return (
    <span className="text-[12.5px] text-ink-4" suppressHydrationWarning>
      {m}月{d}日 · {beijingWeekday(today).replace("星期", "周")}
    </span>
  );
}

export default function Home() {
  const { data, filters } = useLoaderData<typeof loader>();
  const searchBase = filters.domain ? `/all/${filters.domain}` : "/all";
  const keep = { category: filters.category, tag: filters.tag, channel: filters.channel === "all" ? null : filters.channel };
  return (
    <div className="pb-6">
      {/* Phones: brand bar, today's hot topics, then the feed under "最新精选". */}
      <div className="flex h-14 items-center justify-between lg:hidden">
        <Wordmark size={20} className="text-ink" />
        <TodayLabel />
      </div>
      <div className="hidden lg:block">
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">精选</h1>
        <div className="mb-5 mt-4 flex items-center justify-between gap-4">
          <ColumnTabs base="/" filters={filters} layoutId="home-cat-desk" className="min-w-0" />
          <SearchField action={searchBase} variant="track" keep={keep} />
        </div>
      </div>

      {data.hot && <HotTopics entries={data.hot} />}

      <h2 className="mt-6 text-[20px] font-bold text-ink lg:hidden">最新精选</h2>
      <div className="-mx-4 mt-3 flex items-center gap-2 pl-4 pr-2 lg:hidden">
        <ColumnTabs base="/" filters={filters} layoutId="home-cat-mobile" size="sm" className="min-w-0 flex-1" />
        <SearchIconLink base={searchBase} />
      </div>

      <Timeline initial={data} filters={data.filters} />
    </div>
  );
}
