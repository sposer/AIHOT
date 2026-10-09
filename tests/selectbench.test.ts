// SelectBench owns the human-labelled subsets, metrics and persisted report browsing.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import Fastify from "fastify";
import { DOMAIN_KEYS } from "@aihot/contracts/taxonomy";
import { importSelectBenchRun, selectBenchDomains, selectBenchRun, summarizeSelectBench, type SelectBenchCase } from "@aihot/backend/admin/selectbench";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { registerAdmin } from "../apps/api/src/routes/admin.ts";

const T = tag();
after(() => closeDb());

const CASES: SelectBenchCase[] = [
  { caseId: "multi", title: "AI clinical tool", stratum: "clinical", gold: "select", domains: ["medical", "ai", "medical"], decision: "select", score: 80, relevance: "pass" },
  { caseId: "fp", title: "Medical promotion", stratum: "clinical", gold: "reject", domains: ["medical"], decision: "select", score: 70, relevance: "pass" },
  { caseId: "fn", title: "Clinical regulation", stratum: "regulation", gold: "select", domains: ["medical", "legal"], decision: "reject", score: 50, relevance: "pass" },
  { caseId: "unlabelled", title: "No human domain annotation", gold: "reject", decision: "reject", score: 88, relevance: "block" },
  { caseId: "either", title: "Borderline clinical law", stratum: "regulation", gold: "either", domains: ["medical", "legal"], decision: "select", score: 90, relevance: "pass" },
  { caseId: "error", title: "Failed legal case", gold: "select", domains: ["legal"], decision: null, score: 99, relevance: "pass", error: "local test failure" },
  { caseId: "either-error", title: "Failed borderline case", gold: "either", domains: ["legal"], decision: null, error: "local test failure" },
  { caseId: "policy-tn", title: "Routine policy notice", gold: "reject", domains: ["policy"], decision: "reject", score: 20, relevance: "block" },
];

test("SelectBench metrics count each multi-domain case once overall and once per human-labelled subset", () => {
  const { summary: s, sweep } = summarizeSelectBench(CASES);
  assert.deepEqual([s.n, s.decisive, s.either, s.errors, s.domainAnnotated], [8, 5, 1, 2, 7]);
  assert.deepEqual([s.tp, s.fp, s.fn, s.tn, s.status], [1, 1, 1, 2, "ok"]);
  assert.deepEqual([s.accuracy, s.precision, s.recall, s.f1, s.selectedRate, s.goldSelectRate], [0.6, 0.5, 0.5, 0.5, 0.4, 0.4]);
  assert.deepEqual(Object.keys(s.byDomain), [...DOMAIN_KEYS]);
  const m = s.byDomain.medical;
  assert.deepEqual([m.n, m.decisive, m.either, m.errors, m.tp, m.fp, m.fn, m.tn], [4, 3, 1, 0, 1, 1, 1, 0]);
  assert.deepEqual([m.accuracy, m.precision, m.recall, m.f1, m.selectedRate, m.goldSelectRate], [0.333, 0.5, 0.5, 0.5, 0.667, 0.667]);
  assert.deepEqual([s.byDomain.ai.n, s.byDomain.legal.n, s.byDomain.legal.decisive, s.byDomain.legal.either, s.byDomain.legal.errors, s.byDomain.policy.n], [1, 4, 1, 1, 2, 1]);
  assert.equal(s.byDomain.military.n, 0);
  assert.deepEqual(sweep.map((x) => x.t), Array.from({ length: 26 }, (_, i) => 40 + 2 * i));
  assert.deepEqual(sweep[0], { t: 40, n: 8, decisive: 5, either: 1, errors: 2, status: "ok", acc: 0.8, P: 0.667, R: 1, F1: 0.8, sel: 0.6 });
  assert.deepEqual(m.sweep[0], { t: 40, n: 4, decisive: 3, either: 1, errors: 0, status: "ok", acc: 0.667, P: 0.667, R: 1, F1: 0.8, sel: 1 });
  assert.deepEqual(m.sweep.find((x) => x.t === 80), { t: 80, n: 4, decisive: 3, either: 1, errors: 0, status: "ok", acc: 0.667, P: 1, R: 0.5, F1: 0.667, sel: 0.333 });
});

test("SelectBench metrics distinguish zero decisive samples from an empty subset without claiming zero-percent validation", () => {
  const { summary: s, sweep } = summarizeSelectBench(CASES.filter((c) => c.caseId === "either" || c.caseId === "error"));
  assert.deepEqual([s.n, s.decisive, s.either, s.errors, s.status], [2, 0, 1, 1, "no_decisive_samples"]);
  assert.deepEqual([s.accuracy, s.precision, s.recall, s.f1, s.selectedRate, s.goldSelectRate], [null, null, null, null, null, null]);
  assert.ok(sweep.every((x) => x.n === 2 && x.decisive === 0 && x.either === 1 && x.errors === 1 && x.status === "no_decisive_samples" && x.acc === null && x.P === null && x.R === null && x.F1 === null && x.sel === null));
  const empty = s.byDomain.military;
  assert.deepEqual([empty.n, empty.decisive, empty.status, empty.accuracy, empty.f1], [0, 0, "no_samples", null, null]);
  assert.equal(summarizeSelectBench([]).summary.status, "no_samples");
});

test("SelectBench gold domain validation accepts every registered identity and treats omitted labels as unannotated", () => {
  assert.deepEqual(selectBenchDomains(undefined), []);
  assert.deepEqual(selectBenchDomains([]), []);
  assert.deepEqual(selectBenchDomains(["policy", "medical", "policy"]), ["medical", "policy"]);
  for (const domain of DOMAIN_KEYS) assert.deepEqual(selectBenchDomains([domain]), [domain]);
  for (const value of [["all"], ["unknown-domain"], "medical", null]) {
    assert.throws(() => selectBenchDomains(value), { statusCode: 400 });
  }
});

test("SelectBench admin import persists human domains and uses them with outcome, model, stratum and disagreement filters", async (t) => {
  const [user] = await sql<{ id: number }[]>`INSERT INTO admin_users (email, display_name) VALUES (${`selectbench-${T}@example.invalid`}, 'SelectBench test') RETURNING id`;
  const token = `selectbench-session-${T}`, csrf = `selectbench-csrf-${T}`;
  await sql`INSERT INTO admin_sessions (id_hash, user_id, csrf_token, expires_at) VALUES (${createHash("sha256").update(token).digest("hex")}, ${user!.id}, ${csrf}, now() + interval '1 hour')`;
  const app = Fastify();
  registerAdmin(app);
  let runId: string | null = null;
  t.after(async () => {
    await app.close();
    await sql`DELETE FROM selectbench_runs WHERE imported_by = ${`admin:${user!.id}`}`;
    await sql`DELETE FROM audit_log WHERE actor = ${`admin:${user!.id}`}`;
    await sql`DELETE FROM admin_sessions WHERE user_id = ${user!.id}`;
    await sql`DELETE FROM admin_users WHERE id = ${user!.id}`;
  });
  const headers = { cookie: `aihot_admin=${token}`, "x-csrf-token": csrf };
  const label = `SelectBench import ${T}`;
  const invalid = await app.inject({ method: "POST", url: "/api/admin/selectbench/import", headers, payload: { label, report: { meta: {}, models: { primary: { summary: {}, cases: [{ ...CASES[0]!, domains: ["all"] }] } } } } });
  assert.equal(invalid.statusCode, 400);
  for (const models of [
    { primary: { summary: {}, cases: [CASES[0]!, CASES[0]!] } },
    { primary: { summary: {}, cases: [CASES[0]!] }, other: { summary: {}, cases: [{ ...CASES[0]!, domains: ["medical"] }] } },
    { primary: { summary: {}, cases: [CASES[0]!, CASES[1]!] }, other: { summary: {}, cases: [CASES[0]!] } },
    { primary: { summary: {}, cases: [CASES[0]!, CASES[1]!] }, other: { summary: {}, cases: [CASES[0]!, CASES[2]!] } },
  ]) {
    const inconsistent = await app.inject({ method: "POST", url: "/api/admin/selectbench/import", headers, payload: { label, report: { meta: {}, models } } });
    assert.equal(inconsistent.statusCode, 400);
  }
  assert.equal((await sql`SELECT id FROM selectbench_runs WHERE label = ${label}`).length, 0);
  const other: SelectBenchCase[] = CASES.map((c) => ({ ...c, decision: c.caseId === "multi" || c.caseId === "fp" ? "reject" : c.decision })).reverse();
  const imported = await app.inject({
    method: "POST", url: "/api/admin/selectbench/import", headers,
    payload: { label, report: { meta: { n: 8, split: "development", seed: 7 }, models: {
      primary: { summary: { n: 999, f1: 1, tokensIn: 17, byDomain: { medical: { n: 999 } } }, sweep: [], cases: CASES },
      other: { summary: {}, cases: other },
    } } },
  });
  assert.equal(imported.statusCode, 200);
  runId = imported.json<{ id: string }>().id;
  const get = async (query: Record<string, string> = {}) => {
    const response = await app.inject({ method: "GET", url: `/api/admin/selectbench/${encodeURIComponent(runId!)}?${new URLSearchParams(query)}`, headers });
    assert.equal(response.statusCode, 200);
    return response.json<NonNullable<Awaited<ReturnType<typeof selectBenchRun>>>>();
  };
  const all = await get();
  assert.equal(all.domain, null);
  assert.equal(all.rows.length, 8);
  assert.deepEqual(all.rows.find((c) => c.case_id === "unlabelled")!.domains, []);
  const expected = summarizeSelectBench(CASES);
  assert.deepEqual(all.run.summary.primary.byDomain, expected.summary.byDomain);
  assert.deepEqual(all.run.summary.primary.sweep, expected.sweep);
  assert.deepEqual([all.run.summary.primary.n, all.run.summary.primary.tokensIn], [8, 17]);
  const stored = await sql<{ model: string; domains: string[] }[]>`SELECT model, domains FROM selectbench_results WHERE run_id = ${runId} AND case_id = 'multi' ORDER BY model`;
  assert.deepEqual(stored.map((r) => r.domains), [["ai", "medical"], ["ai", "medical"]]);
  const medical = await get({ domain: "medical" });
  assert.equal(medical.domain, "medical");
  assert.deepEqual(medical.rows.map((r) => r.case_id).sort(), ["either", "fn", "fp", "multi"]);
  assert.deepEqual(medical.rows.find((r) => r.case_id === "multi")!.domains, ["ai", "medical"]);
  assert.deepEqual(Object.keys(medical.rows[0]!.by_model).sort(), ["other", "primary"]);
  assert.deepEqual(medical.strata.map((s) => [s.stratum, s.n]).sort(), [["clinical", 2], ["regulation", 2]]);
  assert.deepEqual((await get({ domain: "medical", model: "primary", outcome: "fp" })).rows.map((r) => r.case_id), ["fp"]);
  assert.equal((await get({ domain: "medical", model: "other", outcome: "fp" })).rows.length, 0);
  assert.deepEqual((await get({ domain: "medical", model: "other", outcome: "fn" })).rows.map((r) => r.case_id).sort(), ["fn", "multi"]);
  assert.deepEqual((await get({ domain: "medical", stratum: "clinical", disagree: "1" })).rows.map((r) => r.case_id), ["fp", "multi"]);
  assert.deepEqual((await get({ domain: "legal", outcome: "either" })).rows.map((r) => r.case_id), ["either"]);
  assert.deepEqual((await get({ domain: "legal", outcome: "error" })).rows.map((r) => r.case_id).sort(), ["either-error", "error"]);
  assert.equal((await get({ domain: "military" })).rows.length, 0);
  const badFilter = await app.inject({ method: "GET", url: `/api/admin/selectbench/${runId}?domain=all`, headers });
  assert.equal(badFilter.statusCode, 400);
  t.diagnostic(`saved 8 unique cases across 2 models; medical subset n=${medical.run.summary.primary.byDomain.medical.n}, decisive=${medical.run.summary.primary.byDomain.medical.decisive}; all filters kept complete labels`);
});

test("SelectBench historical cases stay unannotated and summary-only reports do not acquire domain validation", async (t) => {
  const id = `sb-history-${T}`, actor = `test-selectbench-${T}`;
  const historical = { n: 1, decisive: 1, accuracy: 1, f1: 1 };
  let summaryOnly: string | null = null;
  t.after(async () => {
    await sql`DELETE FROM selectbench_runs WHERE id = ${id} OR id = ${summaryOnly}`;
    await sql`DELETE FROM audit_log WHERE actor = ${actor}`;
  });
  await sql`INSERT INTO selectbench_runs (id, label, sample_size, models, summary) VALUES (${id}, 'Historical SelectBench', 1, ARRAY['historic'], ${sql.json({ historic: historical })})`;
  await sql`INSERT INTO selectbench_results (run_id, model, case_id, title, gold, decision) VALUES (${id}, 'historic', 'old-case', 'Old case without domain labels', 'select', 'select')`;
  const old = await selectBenchRun(id, {});
  assert.deepEqual(old!.rows[0]!.domains, []);
  assert.deepEqual(old!.run.summary.historic, historical);
  assert.equal((await selectBenchRun(id, { domain: "medical" }))!.rows.length, 0);
  const imported = await importSelectBenchRun({ meta: { n: 9 }, models: { historic: { summary: { n: 9, decisive: 9, f1: 0.9 } } } }, 'Summary only', actor);
  summaryOnly = imported.id;
  const only = await selectBenchRun(summaryOnly, { domain: "medical" });
  assert.equal(only!.rows.length, 0);
  assert.deepEqual([only!.run.summary.historic.n, only!.run.summary.historic.f1, only!.run.summary.historic.domainAnnotated, only!.run.summary.historic.byDomain], [9, 0.9, 0, null]);
});

test("SelectBench CLI carries human domains through its selection-only report and automatic import", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "selectbench-cli-"));
  const goldFile = path.join(directory, "gold.jsonl");
  const split = `selectbench-cli-${T}`, label = `SelectBench CLI ${T}`;
  const reportDir = path.join(REPO_ROOT, ".data/eval"), reportPrefix = `selection-${split}-3-`;
  const inputs = [
    { caseId: `cli-multi-${T}`, gold: { decision: "select", domains: ["legal", "medical"] } },
    { caseId: `cli-single-${T}`, gold: { decision: "select", domains: ["medical"] } },
    { caseId: `cli-unlabelled-${T}`, gold: { decision: "reject" } },
  ];
  const subjects = inputs.map((r) => `article:gold-${r.caseId}@1`);
  let provider: Awaited<ReturnType<typeof stub>> | undefined;
  const ownReports = async () => {
    try { return (await readdir(reportDir)).filter((name) => name.startsWith(reportPrefix) && name.endsWith(".json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  t.after(async () => {
    await provider?.close();
    const runs = await sql<{ id: string }[]>`SELECT id FROM selectbench_runs WHERE label = ${label}`;
    if (runs.length) {
      await sql`DELETE FROM audit_log WHERE subject IN ${sql(runs.map((r) => `selectbench:${r.id}`))}`;
      await sql`DELETE FROM selectbench_runs WHERE id IN ${sql(runs.map((r) => r.id))}`;
    }
    // Receipt attempts cascade from these exact synthetic subjects; no shared budgets or settings change.
    await sql`DELETE FROM receipts WHERE subject IN ${sql(subjects)}`;
    for (const file of await ownReports()) await rm(path.join(reportDir, file));
    await rm(directory, { recursive: true, force: true });
  });
  provider = await stub((hit) => ({
    id: `selectbench-cli-${T}-${hit}`,
    // One valid response for prefilter and score; misleading model domains must never become gold.
    choices: [{ message: { content: JSON.stringify({ label: "PASS", reason: "Local selection fixture", attentionScore: 80, domains: ["military"], category: "industry" }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }));
  const rows = inputs.map((r) => ({
    ...r,
    material: { title: `Synthetic ${r.caseId}`, originalTitle: null, publishedAt: "2026-10-01T01:00:00Z", sourceName: "Local CLI source", bodyZh: null, bodyOriginal: `Synthetic material for a controlled selection test, with evidence and limitations. ${T}` },
    // Coverage differs from the human labels, and also covers the deliberately unlabelled case.
    sourceFacts: { sourceKind: "rss", sourceTier: "T1", firstParty: true, language: "en", domains: ["policy", "medical"] },
    samplingContext: { benchmarkSplit: split },
  }));
  await writeFile(goldFile, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AIHOT_CREDENTIALS_DIR: path.join(directory, "absent-credentials"),
    COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "true", FEISHU_CONTENT_PUSH_ENABLED: "false", FEISHU_INTERNAL_ENABLED: "false", INDEXNOW_SUBMIT_ENABLED: "false",
    PREFILTER_MODEL: "default", SCORE_MODEL: "default", UNDERSTAND_MODEL: "default", SUMMARIZE_MODEL: "default", STRUCTURE_MODEL: "default",
    LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "selectbench-local-test-key", LLM_MODEL: `selectbench-cli-model-${T}`, LLM_EXTRA_JSON: "{}", LLM_JSON_MODE: "true", LLM_VISION: "false",
  };
  // Stored admin model choices may name a preset; every provider still points only at this local stub.
  for (const prefix of ["DASHSCOPE", "ZHIPU", "DEEPSEEK", "XIAOMI_MIMO"]) {
    env[`${prefix}_BASE_URL`] = `${provider.url}/v1`;
    env[`${prefix}_API_KEY`] = "selectbench-local-test-key";
  }
  await promisify(execFile)(process.execPath, [path.join(REPO_ROOT, "scripts/eval-selection.ts"), "--gold", goldFile, "--split", split, "--n", "3", "--models", "default", "--concurrency", "1", "--label", label], { cwd: REPO_ROOT, env, timeout: 60_000, maxBuffer: 3_000_000, encoding: "utf8" });
  const files = await ownReports();
  assert.equal(files.length, 1);
  const report = JSON.parse(await readFile(path.join(reportDir, files[0]!), "utf8")) as {
    meta: { n: number; split: string };
    models: Record<string, ReturnType<typeof summarizeSelectBench> & { cases: SelectBenchCase[] }>;
  };
  assert.deepEqual([report.meta.n, report.meta.split], [3, split]);
  const cases = report.models.default!.cases;
  for (const [caseId, domains] of [[inputs[0]!.caseId, ["medical", "legal"]], [inputs[1]!.caseId, ["medical"]], [inputs[2]!.caseId, []]] as const) {
    const c = cases.find((r) => r.caseId === caseId)!;
    assert.deepEqual(c.domains, domains);
    assert.deepEqual([c.decision, c.category, c.reason, c.error], ["select", null, null, null]);
  }
  const s = report.models.default!.summary;
  assert.deepEqual([s.n, s.decisive, s.errors, s.domainAnnotated, s.byDomain.medical.n, s.byDomain.legal.n, s.byDomain.policy.n, s.byDomain.military.n], [3, 3, 0, 2, 2, 1, 0, 0]);
  const [run] = await sql<{ id: string }[]>`SELECT id FROM selectbench_runs WHERE label = ${label}`;
  assert.ok(run);
  const saved = await selectBenchRun(run.id, { domain: "medical" });
  assert.deepEqual(saved!.rows.map((r) => r.case_id).sort(), [inputs[0]!.caseId, inputs[1]!.caseId]);
  assert.deepEqual(saved!.run.summary.default.byDomain, s.byDomain);
  const receipts = await sql<{ purpose: string; n: number }[]>`SELECT purpose, count(*)::int AS n FROM receipts WHERE subject IN ${sql(subjects)} GROUP BY purpose ORDER BY purpose`;
  assert.deepEqual(receipts.map((r) => [r.purpose, r.n]), [["prefilter_article", 3], ["score_article", 6]]);
  assert.equal(provider.hits(), 9);
  t.diagnostic("CLI produced and imported 3 synthetic cases (2 human-labelled); exactly 3 prefilters + 6 scores, no structure or writing; own gold/report/run/receipts are removed by teardown");
});
