// The deployed baseline is upgraded, not rewritten. All rows in this test belong to a transaction-
// scoped schema inside the disposable test database; production/public rows are never altered.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile } from "node:fs/promises";
import { closeDb, sql } from "@aihot/backend/db";

const T = tag();
after(closeDb);

test("0002 assigns legacy AI data once while preserving report and revision identity", async () => {
  const baseline = await readFile(new URL("../database/migrations/0001_core.sql", import.meta.url), "utf8");
  const migration = await readFile(new URL("../database/migrations/0002_domains.sql", import.meta.url), "utf8");
  const schema = `test_migration_${T}`;
  await sql.begin(async (tx) => {
    await tx.unsafe(`CREATE SCHEMA "${schema}"`);
    await tx.unsafe(`SET LOCAL search_path = "${schema}", public`);
    await tx.unsafe(baseline);
    await tx`INSERT INTO sources (id, name, kind) VALUES ('legacy', 'Legacy AI', 'rss')`;
    await tx`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
      VALUES ('legacy-article', 'legacy', 'legacy-key', 'https://example.com/legacy', 'Legacy', now(), now())`;
    await tx`INSERT INTO analyses (article_id, input_revision, origin) VALUES ('legacy-article', 1, 'model')`;
    await tx`INSERT INTO publications (article_id, title, source_id, channel, url, discovered_at, timeline_at, sort_at)
      VALUES ('legacy-article', 'Legacy', 'legacy', 'news', 'https://example.com/legacy', now(), now(), now())`;
    await tx`INSERT INTO selected_ledger (seq, article_id, op, payload) VALUES (1, 'legacy-article', 'upsert', '{"id":"legacy-article"}')`;
    const [before] = await tx<{ id: number }[]>`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at)
      VALUES ('daily', '2026-09-30', now() - interval '1 day', now(), '{}', now()) RETURNING id`;
    await tx`INSERT INTO report_revisions (report_id, revision, content, generated_at) VALUES (${before!.id}, 1, '{}', now())`;
    await tx.unsafe(migration);
    for (const table of ["sources", "analyses", "publications"]) {
      const [row] = await tx.unsafe<{ domains: string[] }[]>(`SELECT domains FROM "${table}"`);
      assert.deepEqual(row!.domains, ["ai"]);
    }
    const [ledger] = await tx<{ payload: { domains: string[] } }[]>`SELECT payload FROM selected_ledger`;
    assert.deepEqual(ledger!.payload.domains, ["ai"]);
    const [report] = await tx<{ id: number; scope: string }[]>`SELECT id, scope FROM reports`;
    assert.deepEqual([report!.id, report!.scope], [before!.id, "ai"]);
    const [revision] = await tx<{ report_id: number }[]>`SELECT report_id FROM report_revisions`;
    assert.equal(revision!.report_id, before!.id);
    await tx`INSERT INTO reports (kind, scope, key, window_start, window_end, content, generated_at)
      VALUES ('daily', 'all', '2026-09-30', now() - interval '1 day', now(), '{}', now())`;
    assert.equal((await tx`SELECT 1 FROM reports`).length, 2);
    await tx.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
  });
});
