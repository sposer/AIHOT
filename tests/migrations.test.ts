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

test("0003 removes reset monitor data and settings while preserving shared history", async () => {
  const migrations = await Promise.all(["0001_core.sql", "0002_domains.sql", "0003_remove_monitor.sql"].map((file) =>
    readFile(new URL(`../database/migrations/${file}`, import.meta.url), "utf8"),
  ));
  const schema = `test_migration_reset_${T}`;
  const activeAlert = { title: "Collection stopped", level: "now", since: "2026-10-01T00:00:00Z", sentAt: "2026-10-01T01:00:00Z" };
  await sql.begin(async (tx) => {
    await tx.unsafe(`CREATE SCHEMA "${schema}"`);
    await tx.unsafe(`SET LOCAL search_path = "${schema}", public`);
    await tx.unsafe(migrations[0]!);
    await tx.unsafe(migrations[1]!);
    await tx`INSERT INTO monitor_posts (id, author, published_at, text, url)
      VALUES ('post', 'thsottiaux', now(), 'Reset announced', 'https://example.com/post')`;
    await tx`INSERT INTO monitor_events (id, type, status, title, created_at, updated_at)
      VALUES ('event', 'direct_reset', 'announced', 'Reset', now(), now())`;
    await tx`INSERT INTO monitor_event_posts (event_id, post_id, stage, text, original_text)
      VALUES ('event', 'post', 'announce', 'Reset announced', 'Reset announced')`;
    await tx`INSERT INTO monitor_state (key, value) VALUES ('cursor', '{"sinceId":"post"}')`;
    await tx`INSERT INTO settings (key, value) VALUES ('models.monitor', '{"model":"default"}'), ('models.score', '{"model":"default"}')`;
    await tx`INSERT INTO settings (key, value) VALUES ('alerts.state', ${tx.json({
      "monitor.stuck": activeAlert, "monitor.review": activeAlert, "content.collect": activeAlert,
    })})`;
    await tx`INSERT INTO notify_targets (key, purpose, kind) VALUES ('history', 'content', 'log')`;
    await tx`INSERT INTO deliveries (target_key, subject_kind, subject_id, dedupe_key, status, payload)
      VALUES ('history', 'codex_reset', 'event', 'history', 'unknown', '{"eventId":"event"}')`;
    await tx`INSERT INTO sources (id, name, kind, domains) VALUES ('retained', 'Retained', 'rss', ARRAY['medical'])`;
    await tx.unsafe(migrations[2]!);
    const tables = await tx<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = ${schema} AND tablename LIKE 'monitor_%'`;
    assert.equal(tables.length, 0);
    const settings = await tx<{ key: string; value: unknown }[]>`SELECT key, value FROM settings ORDER BY key`;
    assert.deepEqual([...settings], [
      { key: "alerts.state", value: { "content.collect": activeAlert } },
      { key: "models.score", value: { model: "default" } },
    ]);
    const [delivery] = await tx`SELECT subject_kind, subject_id, status, payload FROM deliveries`;
    assert.deepEqual(delivery, { subject_kind: "codex_reset", subject_id: "event", status: "unknown", payload: { eventId: "event" } });
    const [source] = await tx`SELECT id, domains FROM sources`;
    assert.deepEqual(source, { id: "retained", domains: ["medical"] });
    await tx.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
  });
});
