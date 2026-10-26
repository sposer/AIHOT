// The baseline initializes the supported schema directly. All rows belong to a transaction-scoped
// schema inside the disposable test database; production/public rows are never altered.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile } from "node:fs/promises";
import { closeDb, sql } from "@aihot/backend/db";

const T = tag();
after(closeDb);

test("baseline initializes the current information-flow schema without retired modules", async () => {
  const baseline = await readFile(new URL("../database/migrations/0001_core.sql", import.meta.url), "utf8");
  const schema = `test_baseline_${T}`;
  await sql.begin(async (tx) => {
    await tx.unsafe(`CREATE SCHEMA "${schema}"`);
    await tx.unsafe(`SET LOCAL search_path = "${schema}", public`);
    await tx.unsafe(baseline);
    const tables = (await tx<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = ${schema}`).map((r) => r.tablename);
    assert.deepEqual(tables.filter((name) => /^(lb_|monitor_)/.test(name) || name === "fx_rates"), []);
    for (const name of ["sources", "articles", "analyses", "publications", "reports", "selectbench_results", "budgets", "service_prices",
      "receipts", "receipt_attempts", "job_runs", "notify_targets", "deliveries", "audit_log"]) assert.ok(tables.includes(name), name);

    await tx`INSERT INTO sources (id, name, kind) VALUES ('source', 'Source', 'rss')`;
    await tx`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
      VALUES ('article', 'source', 'article-key', 'https://example.com/article', 'Article', now(), now())`;
    await tx`INSERT INTO analyses (article_id, input_revision, origin) VALUES ('article', 1, 'rule')`;
    await tx`INSERT INTO publications (article_id, title, source_id, channel, url, discovered_at, timeline_at, sort_at)
      VALUES ('article', 'Article', 'source', 'news', 'https://example.com/article', now(), now(), now())`;
    for (const table of ["sources", "analyses", "publications"]) {
      assert.deepEqual((await tx.unsafe<{ domains: string[] }[]>(`SELECT domains FROM "${table}"`))[0]!.domains, []);
      await tx.unsafe(`UPDATE "${table}" SET domains = ARRAY['finance', 'medical']`);
      assert.deepEqual((await tx.unsafe<{ domains: string[] }[]>(`SELECT domains FROM "${table}"`))[0]!.domains, ["finance", "medical"]);
    }

    await tx`INSERT INTO selectbench_runs (id, label, sample_size, models, summary) VALUES ('run', 'Run', 1, ARRAY['model'], '{}')`;
    await tx`INSERT INTO selectbench_results (run_id, model, case_id, title, gold) VALUES ('run', 'model', 'case', 'Article', 'selected')`;
    assert.deepEqual((await tx`SELECT domains FROM selectbench_results`)[0]!.domains, []);
    await tx`UPDATE selectbench_results SET domains = ARRAY['finance']`;
    assert.deepEqual((await tx`SELECT domains FROM selectbench_results`)[0]!.domains, ["finance"]);

    const reports = await tx<{ id: number; scope: string }[]>`INSERT INTO reports (kind, scope, key, window_start, window_end, content, generated_at)
      VALUES ('daily', 'all', '2026-10-26', now() - interval '1 day', now(), '{}', now()),
             ('daily', 'finance', '2026-10-26', now() - interval '1 day', now(), '{}', now()) RETURNING id, scope`;
    assert.deepEqual(reports.map((r) => r.scope).sort(), ["all", "finance"]);
    await tx`INSERT INTO report_revisions (report_id, revision, content, generated_at) VALUES (${reports[1]!.id}, 1, '{}', now())`;
    assert.equal((await tx`SELECT report_id FROM report_revisions`)[0]!.report_id, reports[1]!.id);
    await assert.rejects(tx.savepoint(async (sp) => {
      await sp`INSERT INTO reports (kind, scope, key, window_start, window_end, content, generated_at)
        VALUES ('daily', 'finance', '2026-10-26', now() - interval '1 day', now(), '{}', now())`;
    }), { code: "23505" });
    await assert.rejects(tx.savepoint(async (sp) => {
      await sp`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at)
        VALUES ('daily', '2026-10-27', now() - interval '1 day', now(), '{}', now())`;
    }), { code: "23502" });
    await tx.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
  });
});
