// Checks the selection against your own labelled samples (a "gold set"): each case runs the site's
// selection steps (editorial/analyze.ts) — the prefilter, then the score prompt twice with every model in
// --models, the two scores deciding against the source tier's threshold — and is compared with your
// decision. A threshold sweep shows what another threshold would have done. The format of the gold file
// is in docs/selection.md (industry/gold.example.jsonl has two made-up cases).
// Usage: node --env-file=.env scripts/eval-selection.ts --gold .data/gold.jsonl [--models default,deepseek-flash] [--n 200] [--label "..."]
// Receipts make re-runs free; "either" cases are excluded from decisive metrics. Each run is also
// imported into SelectBench (admin → SelectBench) with every case, unless --no-import is given.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { ANALYZE_PROMPT_VERSION, normalizeAnalysis, runAnalysis, type AnalyzeInputArticle } from "@aihot/backend/editorial/analyze";
import { importSelectBenchRun, selectBenchDomains, summarizeSelectBench, type SelectBenchCase } from "@aihot/backend/admin/selectbench";
import type { DomainKey } from "@aihot/contracts/taxonomy";

const { values } = parseArgs({
  options: {
    gold: { type: "string", default: ".data/gold.jsonl" },
    models: { type: "string", default: "default" },
    n: { type: "string", default: "200" },
    split: { type: "string", default: "all" },
    concurrency: { type: "string", default: "6" },
    seed: { type: "string", default: "7" },
    label: { type: "string" },
    "no-import": { type: "boolean", default: false },
  },
});

interface GoldRow {
  caseId: string;
  material: { title: string; originalTitle: string | null; publishedAt: string | null; sourceName: string; bodyZh: string | null; bodyOriginal: string | null };
  sourceFacts: { sourceKind: string; sourceTier?: string; firstParty?: boolean; language?: string | null };
  /** Optional: a split (e.g. development / holdout) and a stratum for reading the mistakes. */
  samplingContext?: { benchmarkSplit?: string; samplingStratum?: string };
  gold: { decision: "select" | "reject" | "either"; domains?: DomainKey[] };
}

const rows: GoldRow[] = readFileSync(path.resolve(REPO_ROOT, values.gold!), "utf8")
  .split("\n").filter((l) => l.trim() && !l.trim().startsWith("//")).map((l) => {
    const r = JSON.parse(l) as GoldRow;
    return { ...r, gold: { ...r.gold, domains: selectBenchDomains(r.gold.domains) } };
  });

// Deterministic stratified sample.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const rand = rng(Number(values.seed));
const pool = values.split === "all" ? rows : rows.filter((r) => r.samplingContext?.benchmarkSplit === values.split);
const shuffled = pool.map((r) => ({ r, k: rand() })).sort((a, b) => a.k - b.k).map((x) => x.r);
const sample = shuffled.slice(0, Number(values.n));

function toInput(r: GoldRow): AnalyzeInputArticle {
  const m = r.material;
  const isX = r.sourceFacts.sourceKind === "x_search";
  const body = m.bodyOriginal || m.bodyZh || null;
  return {
    id: `gold-${r.caseId}`,
    revision: 1,
    bodyStatus: "ok",
    title: m.originalTitle || m.title,
    url: "https://example.invalid/" + r.caseId,
    author: null,
    publishedAt: m.publishedAt ? new Date(m.publishedAt) : null,
    bodyText: isX ? null : body,
    excerpt: null,
    xPost: isX ? { authorName: m.sourceName, handle: "", text: body ?? m.title } : null,
    media: [],
    source: { name: m.sourceName, kind: r.sourceFacts.sourceKind, tier: r.sourceFacts.sourceTier ?? "T2", firstParty: r.sourceFacts.firstParty ?? false },
  };
}

async function pmap<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]!);
    }
  }));
  return out;
}

const report: Record<string, unknown> = {};
for (const model of values.models!.split(",")) {
  const started = Date.now();
  const results = await pmap(sample, Number(values.concurrency), async (r) => {
    try {
      const res = await runAnalysis(toInput(r), { scoreModel: model, stages: "selection" });
      const out = normalizeAnalysis(res);
      return { r, out, receiptIds: [res.prefilter.receiptId, ...(res.scores?.receiptIds ?? [])], error: null as string | null };
    } catch (error) {
      return { r, out: null, receiptIds: [] as number[], error: String(error).slice(0, 200) };
    }
  });
  const cases: SelectBenchCase[] = results.map((x) => ({
    caseId: x.r.caseId,
    title: x.r.material.title,
    stratum: x.r.samplingContext?.samplingStratum ?? null,
    gold: x.r.gold.decision,
    domains: x.r.gold.domains ?? [],
    decision: x.out ? (x.out.selected ? "select" : "reject") : null,
    score: x.out?.score ?? null,
    relevance: x.out?.relevance ?? null,
    category: x.out?.category ?? null,
    reason: x.out?.reasonZh ?? null,
    receiptId: x.receiptIds[0] ?? null,
    error: x.error,
  }));
  const { summary: selectionSummary, sweep } = summarizeSelectBench(cases);
  const mistakes = cases.filter((c) => c.decision !== null && c.gold !== "either" && c.decision !== c.gold)
    .map((c) => ({ ...c, kind: c.decision === "select" ? "FP" : "FN" }));
  const receiptIds = results.flatMap((x) => x.receiptIds);
  const [usage] = receiptIds.length
    ? await sql<{ tin: number; tout: number; latency: number }[]>`
        SELECT sum((usage->>'prompt_tokens')::int) AS tin, sum((usage->>'completion_tokens')::int) AS tout,
               avg((response->>'_latencyMs')::int) AS latency
        FROM receipts WHERE id IN ${sql(receiptIds)}`
    : [{ tin: 0, tout: 0, latency: 0 }];
  const summary = {
    model, ...selectionSummary,
    tokensIn: Number(usage?.tin ?? 0), tokensOut: Number(usage?.tout ?? 0), avgLatencyMs: Math.round(Number(usage?.latency ?? 0)),
    wallSeconds: Math.round((Date.now() - started) / 1000),
  };
  console.log(JSON.stringify(summary));
  console.log(sweep.map((s) => `  t=${s.t} n=${s.n} decisive=${s.decisive} status=${s.status} acc=${s.acc} P=${s.P} R=${s.R} F1=${s.F1} sel=${s.sel}`).join("\n"));
  report[model] = { summary, sweep, mistakes, cases };
}
const outDir = path.join(REPO_ROOT, ".data/eval");
mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `selection-${values.split}-${values.n}-${Date.now()}.json`);
const meta = { split: values.split, n: sample.length, seed: Number(values.seed), promptVersion: ANALYZE_PROMPT_VERSION, createdAt: new Date().toISOString() };
writeFileSync(file, JSON.stringify({ meta, models: report }, null, 2));
console.log(`report: ${file}`);
if (!values["no-import"]) {
  const run = await importSelectBenchRun({ meta, models: report }, values.label ?? `${values.split} ${sample.length} 条 · ${Object.keys(report).join(" / ")}`, "script:eval-selection");
  console.log(`SelectBench run: ${run.id}`);
}
await closeDb();
