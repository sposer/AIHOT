// The source administration save boundary: defaults, explicit full-text permission and MP config.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSource, listSources, updateSource } from "@aihot/backend/admin/sources";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { UnsupportedConfig } from "@aihot/backend/sources/config-keys";
import type { PgBoss } from "pg-boss";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { queueProcessing, settleNonEditorial } from "@aihot/backend/jobs/content";
import { registerEventJobs } from "@aihot/backend/jobs/events";
import { publishArticle } from "@aihot/backend/publication/publish";

const T = tag();
after(async () => {
  await stopBoss();
  await closeDb();
});

test("a new MP source saves ghid and nickname with full text off, and an explicit permission remains enabled", async (t) => {
  const id = `test-admin-mp-${T}`;
  const config = { ghid: `gh_${T}`, nickname: "Local test account" };
  const result = await createSource({ id, name: "Local MP", kind: "mp_account", config, participation_mode: "isolated" }, "test");
  assert.equal(result.created, true);
  const [created] = await sql<{ config: Record<string, unknown>; site_fulltext: boolean; syndicate_fulltext: boolean; updated_at: Date }[]>`
    SELECT config, site_fulltext, syndicate_fulltext, updated_at FROM sources WHERE id = ${id}`;
  assert.deepEqual(created!.config, config);
  assert.deepEqual([created!.site_fulltext, created!.syndicate_fulltext], [false, false]);
  await updateSource(id, { patch: { site_fulltext: true }, version: created!.updated_at.toISOString() }, "test");
  const [saved] = await sql<{ site_fulltext: boolean; syndicate_fulltext: boolean }[]>`
    SELECT site_fulltext, syndicate_fulltext FROM sources WHERE id = ${id}`;
  assert.deepEqual([saved!.site_fulltext, saved!.syndicate_fulltext], [true, false]);
  t.diagnostic(`MP saved config keys=${Object.keys(created!.config).sort().join(",")}; full text default=${created!.site_fulltext}, explicit save=${saved!.site_fulltext}`);
});

test("MP creation rejects unknown configuration at the save boundary without inserting a source", async () => {
  const id = `test-admin-invalid-${T}`;
  await assert.rejects(
    createSource({ id, name: "Invalid MP", kind: "mp_account", config: { ghid: `gh_${T}`, nickname: "Test", unexpected: true } }, "test"),
    UnsupportedConfig,
  );
  const rows = await sql`SELECT id FROM sources WHERE id = ${id}`;
  assert.equal(rows.length, 0);
});


test("promoting a skipped source queues normal analysis and routes an already queued group by current mode", async (t) => {
  const provider = await stub((_hit, req) => {
    const { messages } = JSON.parse(req.body) as { messages: Array<{ content: string }> };
    const answer = { query: `Clinical ${T}`, decisions: [...messages.at(-1)!.content.matchAll(/【候选 (C\d+)】/g)].map((m) => ({ id: m[1], relation: "UNRELATED", confidence: 1, note: "独立试验" })) };
    return { id: "promotion-stub", choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
  });
  process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
  process.env.DEEPSEEK_API_KEY = "test-key";
  t.after(() => provider.close());
  const id = `test-admin-promotion-${T}`;
  const result = await createSource({ id, name: "Promotion", kind: "rss", config: {}, tier: "T1", participation_mode: "hot_signal", domains: ["ai"] }, "test");
  assert.equal(result.created, true);
  const { articleId } = await upsertMaterial({ sourceId: id, url: `https://example.com/promotion-${T}`, title: `Clinical ${T}`, bodyText: "A controlled clinical study reported outcomes and limitations. ".repeat(10), bodyStatus: "ok", publishedAt: new Date(), via: "fetch" });
  await queueProcessing(articleId);
  const [queued] = await sql<{ data: { articleId: string; signalOnly?: boolean } }[]>`SELECT data FROM pgboss.job WHERE name = 'events.group' AND data->>'articleId' = ${articleId}`;
  await settleNonEditorial(articleId);
  const [source] = await sql<{ updated_at: Date }[]>`SELECT updated_at FROM sources WHERE id = ${id}`;
  await updateSource(id, { patch: { participation_mode: "editorial", domains: ["policy", "medical", "policy"] }, version: source!.updated_at.toISOString() }, "test");
  const [state] = await sql<{ processing_state: string }[]>`SELECT processing_state FROM articles WHERE id = ${articleId}`;
  assert.equal(state!.processing_state, "new");
  assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE name = 'content.analyze' AND data->>'articleId' = ${articleId}`).length, 1);
  const [coverage] = await sql<{ domains: string[] }[]>`SELECT domains FROM sources WHERE id = ${id}`;
  assert.deepEqual(coverage!.domains, ["medical", "policy"]);
  for (const domain of ["medical", "policy"] as const) {
    const list = await listSources({ q: id, domain });
    assert.deepEqual(list.rows.map((s) => s.id), [id]);
    assert.deepEqual(list.rows[0]!.domains, coverage!.domains);
  }
  assert.equal((await listSources({ q: id, domain: "ai" })).rows.length, 0);
  // The analysis job commits a judgement before the old grouping job is consumed.
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, domains, category, title_zh, summary_zh, score, selected, output)
    VALUES (${articleId}, 1, 'rule', 'pass', ARRAY['medical'], 'paper', ${`Clinical ${T}`}, 'Clinical study', 80, true, ${sql.json({ fact: { title: `Clinical ${T}`, subject: `study-${T}` } })})`;
  await publishArticle(articleId);
  let runGroup!: (jobs: Array<{ data: { articleId: string; signalOnly?: boolean } }>) => Promise<unknown>;
  const boss = { work: async (name: string, _options: unknown, run: typeof runGroup) => { if (name === "events.group") runGroup = run; } } as unknown as PgBoss;
  await registerEventJobs(boss);
  // Persisted jobs from the deployed producer may still carry this obsolete routing hint.
  await runGroup([{ data: { ...queued!.data, signalOnly: true } }]);
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id = ${articleId}`).length, 1, "the old queued hint cannot keep an editorial report on the discussion path");
});
