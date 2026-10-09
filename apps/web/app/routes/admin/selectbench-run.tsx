import { SITE } from "@aihot/industry/site";
import { Fragment, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { CATEGORY_LABELS, DOMAIN_KEYS, DOMAIN_LABELS, type DomainKey } from "@aihot/contracts/taxonomy";
import type { Route } from "./+types/selectbench-run";
import { adminGet } from "../../lib/admin.server";
import { bj, num, pct } from "../../features/admin/format";
import { AdminPage, Badge, Card, Empty, FilterChips, Select } from "../../features/admin/ui";

interface Decision {
  decision: "select" | "reject" | null;
  score: number | null;
  relevance: string | null;
  category: string | null;
  reason: string | null;
  error: string | null;
  receiptId: number | null;
}
interface Metrics {
  n: number;
  decisive: number;
  either: number;
  errors: number;
  status: "ok" | "no_samples" | "no_decisive_samples";
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  accuracy: number | null;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  selectedRate: number | null;
  goldSelectRate: number | null;
}
interface ThresholdTrial {
  t: number;
  n?: number;
  decisive?: number;
  either?: number;
  errors?: number;
  status?: Metrics["status"];
  acc: number | null;
  P: number | null;
  R: number | null;
  F1: number | null;
  sel: number | null;
}
export interface ModelSummary extends Partial<Metrics> {
  model?: string;
  domainAnnotated?: number;
  byDomain?: Partial<Record<DomainKey, Metrics & { sweep: ThresholdTrial[] }>> | null;
  sweep?: ThresholdTrial[];
  tokensIn?: number;
  tokensOut?: number;
  avgLatencyMs?: number;
  wallSeconds?: number;
}
interface Data {
  run: { id: string; label: string; split: string | null; sample_size: number; prompt_version: string | null; models: string[]; summary: Record<string, ModelSummary>; created_at: string };
  rows: Array<{ case_id: string; title: string; stratum: string | null; gold: "select" | "reject" | "either"; domains: DomainKey[]; by_model: Record<string, Decision> }>;
  strata: Array<{ stratum: string | null; n: number }>;
  domain: DomainKey | null;
  stratum?: string | null;
}

export async function loader({ request, params }: Route.LoaderArgs) {
  return adminGet<Data>(request, `/api/admin/selectbench/${encodeURIComponent(params.runId)}${new URL(request.url).search}`);
}

export const meta: Route.MetaFunction = ({ loaderData }) => [{ title: `${loaderData?.run.label ?? "SelectBench"} · ${SITE.name} 后台` }];

const GOLD: Record<string, [string, "accent" | "muted" | "info"]> = { select: ["应入选", "accent"], reject: ["不选", "muted"], either: ["两可", "info"] };

function verdict(d: Decision | undefined, gold: string) {
  if (!d) return <span className="text-ink-4">—</span>;
  if (d.decision === null || d.error != null) return <Badge tone="bad" title={d.error ?? undefined}>失败</Badge>;
  const right = gold === "either" || d.decision === gold;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone={right ? (d.decision === "select" ? "ok" : "muted") : "bad"}>{d.decision === "select" ? "入选" : "不选"}</Badge>
      <span className="num text-[12px] text-ink-3">{d.score ?? "—"}</span>
    </span>
  );
}

function metricState(s: Partial<Metrics> | undefined, domain: DomainKey | null) {
  if (!s || s.n === 0) return domain ? "无领域人工标注" : "无样本";
  if (s.decisive === 0) return "无决定性样本";
  return null;
}

export default function SelectBenchRun({ loaderData: d }: Route.ComponentProps) {
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const [open, setOpen] = useState<string | null>(null);
  const model = sp.get("model") ?? d.run.models[0]!;
  const domain = d.domain;
  const scope = domain ? DOMAIN_LABELS[domain] : "总体（含未标注）";
  const summary = (m: string) => domain ? d.run.summary[m]?.byDomain?.[domain] : d.run.summary[m];
  const current = summary(model);
  const sweep = current?.sweep ?? [];
  const strata = d.stratum !== undefined && !d.strata.some((s) => s.stratum === d.stratum)
    ? [...d.strata, { stratum: d.stratum, n: 0 }] : d.strata;
  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(sp);
    if (v) next.set(k, v);
    else next.delete(k);
    navigate(`?${next}`, { preventScrollReset: true });
  };
  return (
    <AdminPage
      title={d.run.label}
      subtitle={<>{bj(d.run.created_at, true)} · {d.run.split ?? "—"} · {num(d.run.sample_size)} 条 · 提示 {d.run.prompt_version ?? "未记录"} · <Link className="text-accent" to="/admin/selectbench">全部运行</Link></>}
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="inline-flex items-center gap-2 text-[13px] text-ink-2">
          人工领域
          <Select className="!w-auto" value={domain ?? ""} onChange={(e) => set("domain", e.target.value || null)}>
            <option value="">总体（含未标注）</option>
            {DOMAIN_KEYS.map((key) => <option key={key} value={key}>{DOMAIN_LABELS[key]}</option>)}
          </Select>
        </label>
        <span className="text-[12.5px] text-ink-3">指标与样本范围：{scope} · 下方结果与分层筛选只缩小样本列表</span>
      </div>
      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {d.run.models.map((m) => {
          const s = summary(m);
          const state = metricState(s, domain);
          return (
            <button key={m} aria-pressed={m === model} onClick={() => set("model", m)} className={`rounded-panel p-4 text-left ring-1 transition-colors ${m === model ? "bg-accent-softer ring-accent/40" : "bg-surface ring-line hover:bg-bg-sunk/60"}`}>
              <div className="text-[13.5px] font-semibold text-ink">{m}</div>
              <div className={`num mt-1.5 font-semibold tracking-tight text-ink ${state ? "text-[16px]" : "text-[22px]"}`}>{state ?? `F1 ${pct(s?.f1)}`}</div>
              {!state && <div className="num mt-0.5 text-[12px] text-ink-3">准确 {pct(s?.accuracy)} · 精确 {pct(s?.precision)} · 召回 {pct(s?.recall)}</div>}
              <div className="num mt-1 text-[12px] text-ink-3">n {num(s?.n ?? (domain ? 0 : d.run.sample_size))} · 决定性 {num(s?.decisive)} · 两可 {num(s?.either)} · 失败 {num(s?.errors)}</div>
              <div className="num mt-0.5 text-[12px] text-ink-4">误选 {s?.fp ?? "—"} · 漏选 {s?.fn ?? "—"}</div>
              {!domain && <div className="mt-0.5 text-[12px] text-ink-4">{d.run.summary[m]?.domainAnnotated ? `人工领域标注 ${num(d.run.summary[m]?.domainAnnotated)} 条` : "无领域人工标注"}</div>}
            </button>
          );
        })}
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <FilterChips
          param="outcome"
          options={[
            { value: "", label: "全部" },
            { value: "fp", label: "误选" },
            { value: "fn", label: "漏选" },
            { value: "tp", label: "选对" },
            { value: "tn", label: "正确不选" },
            { value: "either", label: "两可" },
            { value: "error", label: "失败" },
          ]}
        />
        <Select className="!w-auto" aria-label="样本分层" value={d.stratum === undefined ? "" : JSON.stringify(d.stratum)} onChange={(e) => set("stratum", e.target.value || null)}>
          <option value="">全部分层</option>
          {strata.map((s) => <option key={JSON.stringify(s.stratum)} value={JSON.stringify(s.stratum)}>{s.stratum === "" ? "空分层名" : s.stratum ?? "未分层"}（{s.n}）</option>)}
        </Select>
        <label className="inline-flex items-center gap-2 text-[13px] text-ink-2">
          <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={sp.get("disagree") === "1"} onChange={(e) => set("disagree", e.target.checked ? "1" : null)} />
          只看模型之间有分歧的
        </label>
        <span className="text-[12.5px] text-ink-4">{d.rows.length === 400 ? "仅显示前 400 条" : `${d.rows.length} 条`} · 筛选按 {model}</span>
      </div>
      <Card pad={false}>
        {d.rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[12px] text-ink-3">
                  <th className="px-3 py-2 font-medium">样本</th>
                  <th className="px-3 py-2 font-medium">金标</th>
                  {d.run.models.map((m) => <th key={m} className="px-3 py-2 font-medium">{m}</th>)}
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <Fragment key={r.case_id}>
                    <tr className="cursor-pointer border-b border-line/70 hover:bg-bg-sunk/50" onClick={() => setOpen(open === r.case_id ? null : r.case_id)}>
                      <td className="max-w-[420px] px-3 py-2.5">
                        <div className="line-clamp-2 text-ink">{r.title}</div>
                        <div className="mt-0.5 text-[11.5px] text-ink-4">{r.stratum ?? "—"} · {r.case_id}</div>
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge tone={GOLD[r.gold]?.[1] ?? "muted"}>{GOLD[r.gold]?.[0] ?? r.gold}</Badge>
                        <div className="mt-1 text-[12px] leading-relaxed text-ink-3">人工领域：{r.domains.map((key) => DOMAIN_LABELS[key]).join(" · ") || "未标注"}</div>
                      </td>
                      {d.run.models.map((m) => <td key={m} className="px-3 py-2.5">{verdict(r.by_model[m], r.gold)}</td>)}
                    </tr>
                    {open === r.case_id && (
                      <tr className="border-b border-line/70 bg-bg-sunk/40">
                        <td colSpan={2 + d.run.models.length} className="px-3 py-3">
                          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                            {d.run.models.map((m) => {
                              const x = r.by_model[m];
                              return (
                                <div key={m} className="rounded-control bg-surface p-3 ring-1 ring-line">
                                  <div className="mb-1 flex items-center justify-between text-[12px] text-ink-3"><span className="font-medium text-ink-2">{m}</span>{x?.category && <span>{CATEGORY_LABELS[x.category as keyof typeof CATEGORY_LABELS] ?? x.category}</span>}</div>
                                  <div className="text-[12.5px] leading-relaxed text-ink-2">{x?.error ?? x?.reason ?? "（没有理由）"}</div>
                                  <div className="mt-1 text-[11.5px] text-ink-4">相关性 {x?.relevance ?? "—"}{x?.receiptId ? ` · 回执 #${x.receiptId}` : ""}</div>
                                </div>
                              );
                            })}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>没有符合条件的样本</Empty>
        )}
      </Card>
      <Card title={`门槛试算 · ${scope} · ${model}`} className="mt-4" pad={false}>
        {metricState(current, domain) ? <Empty>{metricState(current, domain)}，没有可评估的门槛结果</Empty> : sweep.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[540px] text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[12px] text-ink-3">
                  {["门槛", "决定性样本", "准确率", "精确率", "召回率", "F1", "入选比例"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {sweep.map((s) => (
                  <tr key={s.t} className="num border-b border-line/70 last:border-0">
                    <td className="px-3 py-2">{s.t}</td>
                    <td className="px-3 py-2">{num(s.decisive ?? current?.decisive)}</td>
                    <td className="px-3 py-2">{pct(s.acc)}</td>
                    <td className="px-3 py-2">{pct(s.P)}</td>
                    <td className="px-3 py-2">{pct(s.R)}</td>
                    <td className="px-3 py-2">{pct(s.F1)}</td>
                    <td className="px-3 py-2">{pct(s.sel)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>这次运行未记录门槛试算</Empty>}
      </Card>
    </AdminPage>
  );
}
