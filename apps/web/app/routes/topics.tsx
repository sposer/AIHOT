import { data as routeData, Link, useLoaderData } from "react-router";
import type { TopicSummary } from "@aihot/contracts/site";
import { DOMAIN_KEYS, DOMAIN_LABELS, isDomainKey } from "@aihot/contracts/taxonomy";
import { loadOr404, queryString } from "../lib/api.server";
import { listPath, pageMeta } from "../lib/seo";
import { DomainTabs, queryDomainHref } from "../features/feed/Filters";

export async function loader({ request }: { request: Request }) {
  const domain = new URL(request.url).searchParams.get("domain");
  if (domain !== null && !isDomainKey(domain)) throw routeData({ message: "bad_request" }, { status: 400 });
  const { topics } = await loadOr404<{ topics: TopicSummary[] }>(`/api/site/topics${queryString({ domain })}`, { signal: request.signal });
  return { topics, domain };
}

export function meta({ loaderData }: { loaderData: Awaited<ReturnType<typeof loader>> | undefined }) {
  const domain = isDomainKey(loaderData?.domain) ? loaderData.domain : null;
  const domains = DOMAIN_KEYS.map((key) => DOMAIN_LABELS[key]).join("、");
  return pageMeta({
    title: "主题",
    description: domain
      ? `${DOMAIN_LABELS[domain]}领域的主题，按机构与主体、专业方向、内容形态浏览。`
      : `按机构与主体、专业方向、内容形态浏览${domains}等领域的主题动态。`,
    path: listPath("/topics", { domain }),
    image: "/og/pages/topics.png",
  });
}

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

const GROUPS = [
  { key: "company", name: "机构与主体", blurb: "追踪公司、政府部门、研究机构与其他关键主体" },
  { key: "field", name: "专业方向", blurb: "按涉及行业与知识方向汇集相关动态" },
  { key: "genre", name: "内容形态", blurb: "按资料类型浏览，不受领域限制" },
] as const;

export default function TopicsPage() {
  const { topics, domain } = useLoaderData<typeof loader>();
  const scope = isDomainKey(domain) ? domain : "all";
  const domainQuery = listPath("", { domain: scope === "all" ? null : scope });
  return (
    <div className="pb-10">
      <header className="pb-2 pt-5 lg:pt-1">
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">主题</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">按机构与主体、专业方向、内容形态浏览主题动态</p>
      </header>
      <DomainTabs
        scope={scope}
        layoutId="topics-domains"
        label="主题领域"
        getHref={(target, params) => queryDomainHref("/topics", params, target)}
        className="mt-4"
      />
      {GROUPS.map((g) => (
        <section key={g.key} aria-labelledby={`topics-${g.key}`} className="pt-8">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h2 id={`topics-${g.key}`} className="text-[15px] font-bold text-ink">
              {g.name}
            </h2>
            <p className="text-[12px] text-ink-4">{g.blurb}</p>
          </div>
          <ul className="mt-3.5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {topics
              .filter((t) => t.group === g.key)
              .map((t) => (
                <li key={t.slug}>
                  <Link
                    to={`/topics/${t.slug}${domainQuery}`}
                    prefetch="intent"
                    aria-label={`查看${t.name}相关精选文章`}
                    className="card card-hover group flex h-full flex-col px-5 py-[18px]"
                  >
                    <span className="text-[15px] font-bold text-ink transition-colors group-hover:text-accent">{t.name}</span>
                    <span className="mt-1.5 line-clamp-2 flex-1 text-[12.5px] leading-[1.7] text-ink-3">{t.definition}</span>
                    <span className="mono mt-3 text-[11.5px] text-accent">
                      查看 {t.total} 条精选 <span className="inline-block transition-transform duration-200 group-hover:translate-x-0.5">→</span>
                    </span>
                  </Link>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
