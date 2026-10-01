import { SITE, withSubject } from "@aihot/industry/site";
import { useLoaderData } from "react-router";
import type { Route } from "./+types/report-latest";
import type { ReportDetail, ReportNavigationEntry } from "@aihot/contracts/site";
import { loadOr404, queryString } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { beijingDate } from "../lib/format";
import { EmptyState } from "../components/ui/Page";
import { ReportLayout } from "../features/report/ReportLayout";
import { ReportPaper } from "../features/report/ReportPaper";
import { KIND_LABEL, kindFromPath, latestScope, reportTitle } from "../features/report/format";

export async function loader({ request, params }: Route.LoaderArgs) {
  const kind = kindFromPath(new URL(request.url).pathname);
  const scope = latestScope(params.domain);
  const { index, report } = await loadOr404<{ index: ReportNavigationEntry[]; report: ReportDetail | null }>(`/api/site/reports/${kind}/latest-page${queryString({ domain: scope === "all" ? null : scope })}`, { signal: request.signal });
  return { kind, scope, report, index, today: beijingDate(Date.now()) };
}

export function meta({ loaderData, location }: Route.MetaArgs) {
  const kind = loaderData?.kind ?? "daily";
  const report = loaderData?.report;
  return pageMeta({
    title: reportTitle(kind, loaderData?.scope ?? "all"),
    description: kind === "daily" ? `${SITE.name} 每天 08:00（北京时间）发布的${withSubject("日报")}。` : kind === "weekly" ? "每周综合回顾。" : "每月盘点。",
    path: location.pathname,
    image: report ? `/og/reports/${report.kind}/${report.scope}/${report.key}.png` : `/og/pages/${kind}.png`,
  });
}

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=300" };
}

export default function ReportLatestPage() {
  const { kind, scope, report, index, today } = useLoaderData<typeof loader>();
  return (
    <ReportLayout kind={kind} scope={scope} index={index} current={report?.key ?? null} today={today}>
      {report ? <ReportPaper report={report} index={index} /> : <EmptyState title={`还没有发布${reportTitle(kind, scope)}`}>第一期发布后会出现在这里。</EmptyState>}
    </ReportLayout>
  );
}
