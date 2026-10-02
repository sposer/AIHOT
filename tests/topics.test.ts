// Topic counts, pages and caches apply the same domain and release scope before pagination.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { DomainKey } from "@aihot/contracts/taxonomy";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const SOURCE = `test-topics-${T}`;
const TOPIC = `test-topic-${T}`;
const app = await buildApp();
after(async () => {
  await sql`DELETE FROM articles WHERE source_id = ${SOURCE}`;
  await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
  await sql`DELETE FROM topics WHERE slug = ${TOPIC}`;
  await app.close();
  await stopBoss();
  await closeDb();
});

test("topic counts and page boundaries are domain-scoped, deduplicated and release-gated", async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, domains, participation_mode, next_fetch_at)
    VALUES (${SOURCE}, 'Topic test', 'rss', 'T1', ARRAY['ai'], 'editorial', '2100-01-01')`;
  await sql`INSERT INTO topics (slug, name, grp, tags, definition, position)
    VALUES (${TOPIC}, 'Cross-domain topic', 'field', ${[T]}, 'Test topic', 10000)`;
  const medical: string[] = [];
  const ai: string[] = [];
  for (let i = 0; i < 24; i++) {
    const domains: DomainKey[] = i === 0 ? ["medical", "policy"] : i < 21 || i === 23 ? ["medical"] : ["ai"];
    const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.org/${TOPIC}/${i}`,
      title: `Topic report ${i}`, bodyText: "A report with evidence and limitations. ".repeat(20), bodyStatus: "ok", via: "fetch",
      publishedAt: new Date(Date.now() - i * 1000) });
    await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, domains, category, tags, title_zh, summary_zh, score, selected)
      VALUES (${articleId}, 1, 'rule', 'pass', ${domains}, 'paper', ${[T]}, ${`Topic report ${i}`}, 'Summary', 80, true)`;
    await publishArticle(articleId, { releasedAt: new Date(Date.now() + (i === 23 ? 86400_000 : -60_000)) });
    if (i < 21) medical.push(articleId);
    else if (i < 23) ai.push(articleId);
  }
  const read = async (path: string) => {
    const res = await app.inject({ method: "GET", url: path });
    assert.equal(res.statusCode, 200, res.body);
    return res.json();
  };
  // Warm the overview first: a domain cannot reuse its counts or page count.
  const totals = [];
  for (const query of ["", "?domain=medical", "?domain=ai", "?domain=policy"]) {
    const body = await read(`/api/site/topics${query}`);
    totals.push(body.topics.find((t: { slug: string }) => t.slug === TOPIC).total);
  }
  assert.deepEqual(totals, [23, 21, 2, 1]);
  const first = await read(`/api/site/topics/${TOPIC}?domain=medical`);
  const second = await read(`/api/site/topics/${TOPIC}?domain=medical&page=2`);
  assert.equal(first.pageCount, 2);
  assert.equal(first.items.length, 20);
  assert.equal(second.items.length, 1);
  assert.deepEqual(new Set([...first.items, ...second.items].map((i: { id: string }) => i.id)), new Set(medical));
  const aiPage = await read(`/api/site/topics/${TOPIC}?domain=ai`);
  assert.equal(aiPage.pageCount, 1);
  assert.deepEqual(new Set(aiPage.items.map((i: { id: string }) => i.id)), new Set(ai));
  const policy = await read(`/api/site/topics/${TOPIC}?domain=policy`);
  assert.deepEqual(policy.items.map((i: { id: string }) => i.id), [medical[0]]);
  assert.equal((await app.inject({ method: "GET", url: `/api/site/topics/${TOPIC}?domain=ai&page=2` })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/api/site/topics?domain=unknown" })).statusCode, 400);
});
