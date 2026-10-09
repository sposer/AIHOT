import { SITE } from "@aihot/industry/site";
import { useRef } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/selectbench";
import type { ModelSummary } from "./selectbench-run";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { bj, num, pct } from "../../features/admin/format";
import { AdminPage, Badge, Button, Card, Empty } from "../../features/admin/ui";
import { toast } from "../../features/admin/toast";

interface RunRow {
  id: string;
  label: string;
  split: string | null;
  sample_size: number;
  prompt_version: string | null;
  models: string[];
  summary: Record<string, ModelSummary>;
  created_at: string;
  imported_by: string | null;
  cases: number;
}

export async function loader({ request }: Route.LoaderArgs) {
  return adminGet<{ runs: RunRow[] }>(request, "/api/admin/selectbench");
}

export const meta: Route.MetaFunction = () => [{ title: `SelectBench · ${SITE.name} 后台` }];

export default function SelectBench({ loaderData }: Route.ComponentProps) {
  const { run, pending } = useAdminAction();
  const file = useRef<HTMLInputElement>(null);
  return (
    <AdminPage
      title="SelectBench"
      subtitle="精选判断的模型对比：同一批人工金标样本，逐条比较各模型的入选决定。运行由 scripts/eval-selection.ts 产生并自动导入；也可以上传报告文件。"
      actions={
        <>
          <input
            ref={file}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              try {
                const report = JSON.parse(await f.text());
                await run("POST", "/api/admin/selectbench/import", { label: f.name.replace(/\.json$/, ""), report }, { label: "import", success: "已导入" });
              } catch {
                toast("文件不是合法的报告 JSON", "error");
              }
            }}
          />
          <Button busy={pending === "import"} onClick={() => file.current?.click()}>导入报告</Button>
        </>
      }
    >
      {loaderData.runs.length ? (
        <div className="space-y-4">
          {loaderData.runs.map((r) => {
            const ranked = r.models.filter((m) => {
              const s = r.summary[m];
              return s && (s.decisive ?? 0) > 0 && typeof s.f1 === "number" && Number.isFinite(s.f1);
            }).sort((a, b) => r.summary[b]!.f1! - r.summary[a]!.f1!);
            const best = ranked.length > 1 ? ranked[0] : undefined;
            return (
              <Card
                key={r.id}
                title={<Link to={`/admin/selectbench/${r.id}`} className="hover:text-accent">{r.label}</Link>}
                right={<span>{bj(r.created_at, true)} · {r.split ?? "—"} · {num(r.sample_size)} 条 · {r.prompt_version ?? "提示版本未记录"}</span>}
                pad={false}
              >
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[940px] text-[13px]">
                    <thead>
                      <tr className="border-b border-line text-left text-[12px] text-ink-3">
                        {["模型", "n / 决定性", "状态", "准确率", "精确率", "召回率", "F1", "入选比例", "金标入选", "失败", "平均耗时", "输入/输出 tokens"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {r.models.map((m) => {
                        const s = r.summary[m] ?? {};
                        const noSamples = s.n === 0 || s.status === "no_samples";
                        const noDecisive = noSamples || s.decisive === 0 || s.status === "no_decisive_samples";
                        const rates: ModelSummary = noDecisive ? {} : s;
                        return (
                          <tr key={m} className="border-b border-line/70 last:border-0">
                            <td className="px-3 py-2 font-medium text-ink">{m} {m === best && <Badge tone="accent">F1 最高</Badge>}</td>
                            <td className="num px-3 py-2">{num(s.n ?? r.sample_size)} / {num(s.decisive)}</td>
                            <td className="px-3 py-2 text-[12px] text-ink-3">
                              <div>{noSamples ? "无样本" : noDecisive ? "无决定性样本" : s.decisive === undefined ? "决定性样本未记录" : "有决定性样本"}</div>
                              <div className="mt-0.5 text-ink-4">{s.domainAnnotated ? `人工领域标注 ${num(s.domainAnnotated)} 条` : "无领域人工标注"}</div>
                            </td>
                            <td className="num px-3 py-2">{pct(rates.accuracy)}</td>
                            <td className="num px-3 py-2">{pct(rates.precision)}</td>
                            <td className="num px-3 py-2">{pct(rates.recall)}</td>
                            <td className="num px-3 py-2 font-semibold text-ink">{pct(rates.f1)}</td>
                            <td className="num px-3 py-2">{pct(rates.selectedRate)}</td>
                            <td className="num px-3 py-2">{pct(rates.goldSelectRate)}</td>
                            <td className="num px-3 py-2">{s.errors ? <span className="text-hot">{num(s.errors)}</span> : num(s.errors)}</td>
                            <td className="num px-3 py-2">{s.avgLatencyMs ? `${(s.avgLatencyMs / 1000).toFixed(1)}s` : "—"}</td>
                            <td className="num px-3 py-2 text-ink-3">{num(s.tokensIn)} / {num(s.tokensOut)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="flex items-center justify-between border-t border-line px-4 py-2 text-[12.5px] text-ink-3">
                  <span>{r.cases ? `${num(r.cases)} 条逐条结果` : "只有汇总（旧格式报告）"}</span>
                  {r.cases > 0 && <Link className="text-accent" to={`/admin/selectbench/${r.id}`}>逐条浏览</Link>}
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card><Empty>还没有对比运行。运行 scripts/eval-selection.ts 后会自动出现在这里。</Empty></Card>
      )}
    </AdminPage>
  );
}
