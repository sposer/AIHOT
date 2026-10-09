// SelectBench: selection-model comparison runs on the human gold set. Runs come from
// scripts/eval-selection.ts (imported automatically) or an uploaded report; the admin compares
// models on the same cases and browses each case.
import { randomBytes } from "node:crypto";
import { DOMAIN_KEYS, isDomainKey, normalizeDomains, type DomainKey } from "@aihot/contracts/taxonomy";
import { sql } from "../db.ts";
import { audit } from "./auth.ts";

export interface SelectBenchCase {
  caseId: string;
  title: string;
  stratum?: string | null;
  gold: "select" | "reject" | "either";
  /** Per-case human labels; absent labels mean [], not source coverage or model output. */
  domains?: DomainKey[];
  decision: "select" | "reject" | null;
  score?: number | null;
  relevance?: string | null;
  category?: string | null;
  reason?: string | null;
  receiptId?: number | null;
  error?: string | null;
}

export interface SelectBenchMetrics {
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

export interface SelectBenchSweep extends Pick<SelectBenchMetrics, "n" | "decisive" | "either" | "errors" | "status"> {
  t: number;
  acc: number | null;
  P: number | null;
  R: number | null;
  F1: number | null;
  sel: number | null;
}

function invalidReport(detail: string): never {
  throw Object.assign(new Error(detail), { statusCode: 400 });
}

/** Gold-file and report imports share the registered identities, including disabled domains. */
export function selectBenchDomains(value: unknown): DomainKey[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isDomainKey)) return invalidReport("domains must be an array of registered domain keys");
  return normalizeDomains(value);
}

function metrics(cases: readonly SelectBenchCase[], threshold?: number): SelectBenchMetrics {
  let tp = 0, fp = 0, fn = 0, tn = 0, either = 0, errors = 0;
  for (const c of cases) {
    if (c.decision === null || c.error != null) { errors++; continue; }
    if (c.gold === "either") { either++; continue; }
    const selected = threshold === undefined ? c.decision === "select" : c.relevance === "pass" && c.score != null && c.score >= threshold;
    if (selected && c.gold === "select") tp++;
    else if (selected) fp++;
    else if (c.gold === "select") fn++;
    else tn++;
  }
  const decisive = tp + fp + fn + tn;
  const precision = tp / Math.max(1, tp + fp), recall = tp / Math.max(1, tp + fn);
  const rate = (value: number) => decisive ? +value.toFixed(3) : null;
  return {
    n: cases.length, decisive, either, errors,
    status: cases.length === 0 ? "no_samples" : decisive === 0 ? "no_decisive_samples" : "ok",
    tp, fp, fn, tn,
    accuracy: rate((tp + tn) / Math.max(1, decisive)), precision: rate(precision), recall: rate(recall),
    f1: rate(2 * precision * recall / Math.max(1e-9, precision + recall)),
    selectedRate: rate((tp + fp) / Math.max(1, decisive)), goldSelectRate: rate((tp + fn) / Math.max(1, decisive)),
  };
}

function thresholdSweep(cases: readonly SelectBenchCase[]): SelectBenchSweep[] {
  const sweep: SelectBenchSweep[] = [];
  for (let t = 40; t <= 90; t += 2) {
    const s = metrics(cases, t);
    sweep.push({ t, n: s.n, decisive: s.decisive, either: s.either, errors: s.errors, status: s.status, acc: s.accuracy, P: s.precision, R: s.recall, F1: s.f1, sel: s.selectedRate });
  }
  return sweep;
}

/** Overall and each human-labelled subset use exactly the same metrics and threshold trial. */
export function summarizeSelectBench(cases: readonly SelectBenchCase[]) {
  const labelled = cases.map((c) => ({ ...c, domains: selectBenchDomains(c.domains) }));
  const byDomain = Object.fromEntries(DOMAIN_KEYS.map((domain) => {
    const subset = labelled.filter((c) => c.domains.includes(domain));
    return [domain, { ...metrics(subset), sweep: thresholdSweep(subset) }];
  })) as Record<DomainKey, SelectBenchMetrics & { sweep: SelectBenchSweep[] }>;
  return {
    summary: { ...metrics(labelled), domainAnnotated: labelled.filter((c) => c.domains.length > 0).length, byDomain },
    sweep: thresholdSweep(labelled),
  };
}

interface ModelReport {
  summary: Record<string, unknown>;
  sweep?: unknown[];
  cases?: SelectBenchCase[];
}

/** Accepts { meta, models } or the older report shape keyed by model name. */
export async function importSelectBenchRun(report: unknown, label: string, actor: string) {
  const r = report as { meta?: Record<string, unknown>; models?: Record<string, ModelReport> } & Record<string, ModelReport>;
  const models = (r.models ?? Object.fromEntries(Object.entries(r).filter(([k]) => k !== "meta"))) as Record<string, ModelReport>;
  const names = Object.keys(models).filter((m) => models[m]?.summary);
  if (!names.length) throw new Error("report has no model summaries");
  const meta = r.meta ?? {};
  const id = `sb-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomBytes(3).toString("hex")}`;
  const labels = new Map<string, { gold: string; domains: DomainKey[] }>();
  let caseIds: Set<string> | undefined;
  const casesByModel = Object.fromEntries(names.map((m) => {
    const seen = new Set<string>();
    const cases = models[m]!.cases?.map((c) => {
      const domains = selectBenchDomains(c.domains);
      if (seen.has(c.caseId)) return invalidReport(`duplicate case ${c.caseId} for ${m}`);
      seen.add(c.caseId);
      const previous = labels.get(c.caseId);
      if (previous && (previous.gold !== c.gold || previous.domains.join(",") !== domains.join(","))) {
        return invalidReport(`human labels differ between models for case ${c.caseId}`);
      }
      labels.set(c.caseId, { gold: c.gold, domains });
      return { ...c, domains };
    });
    // Per-case models share one cohort; summary-only historical models have no case set to compare.
    if (cases) {
      if (caseIds && (caseIds.size !== seen.size || [...caseIds].some((id) => !seen.has(id)))) {
        return invalidReport(`case sets differ between models for ${m}`);
      }
      caseIds ??= seen;
    }
    return [m, cases];
  }));
  // decision: derive metrics from imported cases; not trust uploaded aggregates because stored
  // human labels and the browsable subsets must describe the same evaluation.
  const summary = Object.fromEntries(names.map((m) => {
    const cases = casesByModel[m];
    const result = cases ? summarizeSelectBench(cases) : null;
    // Historical summary-only reports contain no per-case domain annotation. Preserve their
    // overall figures, but do not turn absent domain evidence into measured zero percentages.
    return [m, { ...models[m]!.summary, ...(result?.summary ?? { domainAnnotated: 0, byDomain: null }), sweep: result?.sweep ?? models[m]!.sweep ?? [] }];
  }));
  const sampleSize = Number(meta.n ?? casesByModel[names[0]!]?.length ?? (models[names[0]!]!.summary as { n?: number }).n ?? 0);
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO selectbench_runs (id, label, split, sample_size, seed, prompt_version, models, summary, imported_by)
      VALUES (${id}, ${label}, ${(meta.split as string) ?? null}, ${sampleSize}, ${(meta.seed as number) ?? null}, ${(meta.promptVersion as string) ?? null}, ${names}, ${tx.json(summary as never)}, ${actor})`;
    for (const m of names) {
      const cases = casesByModel[m] ?? [];
      for (let i = 0; i < cases.length; i += 500) {
        const rows = cases.slice(i, i + 500).map((c) => ({
          run_id: id,
          model: m,
          case_id: c.caseId,
          title: c.title,
          stratum: c.stratum ?? null,
          gold: c.gold,
          domains: c.domains,
          decision: c.decision,
          score: c.score ?? null,
          relevance: c.relevance ?? null,
          category: c.category ?? null,
          reason: c.reason ?? null,
          receipt_id: c.receiptId ?? null,
          error: c.error ?? null,
        }));
        await tx`INSERT INTO selectbench_results ${tx(rows)}`;
      }
    }
  });
  await audit(actor, "selectbench.import", `selectbench:${id}`, null, null, { label, models: names, sampleSize });
  return { id };
}

export async function listSelectBenchRuns() {
  return sql`
    SELECT r.id, r.label, r.split, r.sample_size, r.prompt_version, r.models,
           (SELECT coalesce(jsonb_object_agg(key, value - 'sweep'), '{}'::jsonb) FROM jsonb_each(r.summary)) AS summary,
           r.created_at, r.imported_by,
           (SELECT count(*)::int FROM selectbench_results x WHERE x.run_id = r.id) AS cases
    FROM selectbench_runs r ORDER BY r.created_at DESC LIMIT 100`;
}

export async function selectBenchRun(id: string, f: { domain?: DomainKey; model?: string; outcome?: string; stratum?: string | null; disagree?: boolean }) {
  const [run] = await sql`SELECT * FROM selectbench_runs WHERE id = ${id}`;
  if (!run) return null;
  const outcome = f.outcome ?? null;
  // One row per case with every model's decision and its complete human labels.
  const rows = await sql`
    SELECT case_id, min(title) AS title, min(stratum) AS stratum, min(gold) AS gold, min(domains) AS domains,
           jsonb_object_agg(model, jsonb_build_object('decision', decision, 'score', score, 'relevance', relevance, 'category', category, 'reason', reason, 'error', error, 'receiptId', receipt_id)) AS by_model
    FROM selectbench_results WHERE run_id = ${id} AND (${f.stratum === undefined} OR stratum IS NOT DISTINCT FROM ${f.stratum ?? null}::text)
      AND (${f.domain ?? null}::text IS NULL OR domains @> ARRAY[${f.domain ?? null}]::text[])
    GROUP BY case_id
    HAVING (${outcome}::text IS NULL OR bool_or(
      model = ${f.model ?? (run.models as string[])[0]!} AND CASE ${outcome}
        WHEN 'fp' THEN error IS NULL AND decision = 'select' AND gold = 'reject'
        WHEN 'fn' THEN error IS NULL AND decision = 'reject' AND gold = 'select'
        WHEN 'tp' THEN error IS NULL AND decision = 'select' AND gold = 'select'
        WHEN 'tn' THEN error IS NULL AND decision = 'reject' AND gold = 'reject'
        WHEN 'either' THEN error IS NULL AND decision IS NOT NULL AND gold = 'either'
        WHEN 'error' THEN decision IS NULL OR error IS NOT NULL
        ELSE true END))
      AND (${!!f.disagree} IS FALSE OR count(DISTINCT decision) > 1)
    ORDER BY min(stratum), case_id LIMIT 400`;
  const strata = await sql`
    SELECT stratum, count(DISTINCT case_id)::int AS n FROM selectbench_results
    WHERE run_id = ${id} AND (${f.domain ?? null}::text IS NULL OR domains @> ARRAY[${f.domain ?? null}]::text[])
    GROUP BY 1 ORDER BY 2 DESC`;
  // decision: return the parsed filter identity with its rows; not reparse URL text in the page
  // because equivalent JSON literals must select the same stratum.
  return { run, rows, strata, domain: f.domain ?? null, stratum: f.stratum };
}
