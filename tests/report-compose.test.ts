// Retained vertical slice: live RSS material uses the existing analysis/publication/grouping path,
// then two scopes compose the same edition and expose their own reports through the public ports.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { XMLParser } from "fast-xml-parser";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { addDays, beijingDate, beijingMidnight } from "@aihot/contracts/time";
import { MCP_TOOL_NAMES } from "@aihot/contracts/mcp";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { collectSource } from "@aihot/backend/sources/collect";
import { processArticle } from "@aihot/backend/jobs/content";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { groupArticle } from "@aihot/backend/events/group";
import { BATCH_SYSTEM } from "@aihot/backend/events/relate";
import { composeDaily } from "@aihot/backend/reports/compose";
import { updatedReportUrls } from "@aihot/backend/publication/reports";
import { setVisibility } from "@aihot/backend/admin/content";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const SOURCE = `test-report-${T}`;
const requests: Array<{ system: string; user: string }> = [];
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: string }> };
  const system = body.messages.find((m) => m.role === "system")?.content ?? "";
  const user = body.messages.at(-1)!.content;
  requests.push({ system, user });
  let answer: unknown;
  if (system.includes("相关性预筛")) answer = { label: "PASS", reason: "临床研究" };
  else if (system.includes("事件注意力评分器")) answer = { attentionScore: 80 };
  else if (system.includes("资料结构化助手")) answer = { domains: ["medical"], category: "paper", tags: ["论文/研究", "临床研究"], subjects: [], fact: { title: `临床试验 ${T}`, subject: `研究 ${T}`, action: "公布", object: "对照研究结果", occurredAt: null } };
  else if (system.includes("内容理解编辑")) answer = { itemType: "research_paper", authorRole: "principal", tags: ["论文/研究", "临床研究"], editorialJudgment: "对照研究提供临床证据", titleZh: `临床试验 ${T}`, summaryZh: "研究团队公布一项随机对照临床试验结果，纳入 120 名参与者，报告主要终点及研究局限。" };
  else if (system === BATCH_SYSTEM) answer = { query: `临床试验 ${T}`, decisions: [...user.matchAll(/【候选 (C\d+)】/g)].map((m) => ({ id: m[1], relation: "UNRELATED", confidence: 1, note: "独立试验" })) };
  else if (user.startsWith("报告：daily/")) answer = { title: `临床试验 ${T}`, leadParagraph: "本期收录临床研究结果。", highlights: [1] };
  else throw new Error(`unexpected model purpose: ${system.slice(0, 60)}`);
  return { id: `report-stub-${requests.length}`, choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
});
for (const key of ["DASHSCOPE_BASE_URL", "ZHIPU_BASE_URL", "DEEPSEEK_BASE_URL"]) process.env[key] = `${provider.url}/v1`;
for (const key of ["DASHSCOPE_API_KEY", "ZHIPU_API_KEY", "DEEPSEEK_API_KEY"]) process.env[key] = "test-key";
process.env.EMBEDDINGS_ENABLED = "false";
config.allowPrivateNetworkFetch = true;
const app = await buildApp();
after(async () => {
  await app.close();
  await provider.close();
  await stopBoss();
  await closeDb();
});

async function json(url: string) {
  const res = await app.inject({ method: "GET", url });
  assert.equal(res.statusCode, 200, url);
  return res.json();
}

test("medical material reaches all and medical editions without another classification call or scoped identity", async (t) => {
  // Keep a controlled live window separate from earlier tests. Source and edition clocks advance
  // normally; the first-import/archive and selected-release rules are not bypassed.
  const realNow = Date.now();
  const [latest] = await sql<{ at: Date | null }[]>`SELECT max(timeline_at) AS at FROM publications WHERE selected`;
  const liveAt = new Date(beijingMidnight(addDays(beijingDate(Math.max(realNow, latest?.at?.getTime() ?? 0)), 2)).getTime() + 12 * 3600_000);
  const date = addDays(beijingDate(liveAt), 1);
  t.mock.timers.enable({ apis: ["Date"], now: liveAt });
  let id: string | undefined;
  const body = `<p>Clinical trial ${T}: a randomised controlled study enrolled 120 participants and reported its primary endpoint, adverse events, and limitations.</p>`.repeat(8);
  const feed = createServer((_req, res) => {
    res.setHeader("content-type", "application/rss+xml");
    res.end(`<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Clinical research</title><item><title>Clinical trial ${T}</title><link>https://example.com/clinical-${T}</link><pubDate>${liveAt.toUTCString()}</pubDate><content:encoded><![CDATA[${body}]]></content:encoded></item></channel></rss>`);
  });
  feed.listen(0, "127.0.0.1");
  await once(feed, "listening");
  const client = new Client({ name: "report-scope-test", version: "1" }, { versionNegotiation: { mode: "auto" } });
  try {
    // Coverage is deliberately wrong: only the structure result owns this article's domain.
    await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, domains, cursor, next_fetch_at)
      VALUES (${SOURCE}, 'Clinical test source', 'rss', ${sql.json({ feedUrl: `http://127.0.0.1:${(feed.address() as AddressInfo).port}/feed.xml` })}, 'T1', 'editorial', ARRAY['ai'],
        ${sql.json({ initializedAt: new Date(liveAt.getTime() - 60_000).toISOString() })}, '2100-01-01')`;
    const collected = await collectSource(SOURCE);
    assert.deepEqual([collected.status, collected.created], ["ok", 1]);
    const [article] = await sql<{ id: string }[]>`SELECT id FROM articles WHERE source_id = ${SOURCE}`;
    id = article!.id;
    assert.equal((await processArticle(id)).state, "pass");
    assert.equal(requests.filter((r) => r.system.includes("事件注意力评分器")).length, 2);
    assert.equal(requests.length, 5, "the existing structure call supplies domains");
    await groupArticle(id);
    const [analysis] = await sql<{ domains: string[]; input_revision: number; receipt_ids: number[] }[]>`SELECT domains, input_revision, receipt_ids FROM analyses WHERE article_id = ${id}`;
    assert.deepEqual([analysis!.domains, analysis!.input_revision, analysis!.receipt_ids.length], [["medical"], 1, 5]);
    const [publication] = await sql<{ domains: string[]; backfill: boolean }[]>`SELECT domains, backfill FROM publications WHERE article_id = ${id}`;
    assert.deepEqual([publication!.domains, publication!.backfill], [["medical"], false]);
    t.mock.timers.setTime(beijingMidnight(date).getTime() + 8 * 3600_000 + 1000);
    const all = await composeDaily("all", date, "test");
    const medical = await composeDaily("medical", date, "test");
    assert.deepEqual([all.entries, medical.entries], [1, 1]);
    const editions = await sql<{ id: number; scope: string; content: { sections: Array<{ items: Array<{ itemId: string }> }> } }[]>`SELECT id, scope, content FROM reports WHERE kind = 'daily' AND key = ${date} AND scope IN ('all', 'medical') ORDER BY scope`;
    assert.equal(new Set(editions.map((r) => r.id)).size, 2);
    assert.deepEqual(editions.map((r) => r.content.sections.flatMap((s) => s.items.map((i) => i.itemId))), [[id], [id]]);
    const reportRequests = requests.filter((r) => r.user.startsWith("报告：daily/"));
    assert.equal(reportRequests.length, 2);
    const receipts = await sql<{ id: number; subject: string; status: string }[]>`SELECT id, subject, status FROM receipts WHERE subject IN (${`report:daily:all:${date}`}, ${`report:daily:medical:${date}`}) ORDER BY id DESC LIMIT 2`;
    assert.equal(receipts.length, 2);
    assert.ok(receipts.every((r) => r.status === "completed"));
    const paid = requests.length;
    await composeDaily("medical", date, "test-revision");
    await composeDaily("legal", date, "test-empty");
    assert.equal(requests.length, paid, "same input reuses its receipt; an empty edition pays nothing");
    assert.equal((await json(`/api/site/reports/daily/${date}?domain=medical`)).scope, "medical");
    const medicalV1 = await json(`/api/v1/dailies/${date}?domain=medical`);
    const allV1 = await json(`/api/v1/dailies/${date}`);
    assert.equal(new URL(medicalV1.report.links.aihot).pathname, `/daily/medical/${date}`);
    assert.equal(new URL(allV1.report.links.aihot).pathname, `/daily/all/${date}`);
    assert.equal((await json("/api/v1/dailies?domain=medical")).scope, "medical");
    const medicalItems = (await json("/api/v1/items?domain=medical&window=7d")).items;
    assert.ok(medicalItems.some((i: any) => i.id === id));
    assert.ok(medicalItems.every((i: any) => i.domains.includes("medical")));
    assert.ok(!(await json("/api/v1/items?domain=ai&window=7d")).items.some((i: any) => i.id === id));
    const pool = await json("/api/site/pool?domain=medical");
    assert.deepEqual([pool.filters.domain, pool.items.find((i: any) => i.id === id).domains], ["medical", ["medical"]]);
    const rss = new XMLParser().parse((await app.inject({ method: "GET", url: "/feed/daily.xml?domain=medical" })).body).rss.channel;
    const edition = [rss.item].flat().find((i) => i.guid === `daily-medical-${date}`);
    assert.ok(edition);
    assert.equal(new URL(edition.link).pathname, `/daily/medical/${date}`);
    const itemRss = new XMLParser().parse((await app.inject({ method: "GET", url: "/feed.xml?domain=medical" })).body).rss.channel;
    const entry = [itemRss.item].flat().find((i) => i.guid === id);
    assert.ok(entry?.category.includes("medical"));
    const reportUrls = await updatedReportUrls(new Date(realNow - 60_000), new Date(Date.now()));
    assert.ok(reportUrls.some((u) => new URL(u).pathname === `/daily/all/${date}`));
    assert.ok(reportUrls.some((u) => new URL(u).pathname === `/daily/medical/${date}`));
    const sitemap = (await app.inject({ method: "GET", url: "/sitemap.xml" })).body;
    assert.ok(sitemap.includes(`/daily/medical/${date}`) && sitemap.includes(`/all/medical`));
    const llms = (await app.inject({ method: "GET", url: "/llms.txt" })).body;
    assert.ok(llms.includes("/daily/medical") && llms.includes("domain=medical"));
    await app.listen({ port: 0, host: "127.0.0.1" });
    const apiPort = (app.server.address() as AddressInfo).port;
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${apiPort}/api/mcp`)));
    const result = await client.callTool({ name: MCP_TOOL_NAMES.daily, arguments: { domain: "medical", date } });
    assert.equal(result.isError, undefined);
    assert.equal((result.structuredContent as any).report.scope, "medical");
    const latest = await client.callTool({ name: MCP_TOOL_NAMES.latest, arguments: { domain: "medical", window: "7d" } });
    const latestItems = (latest.structuredContent as any).items;
    assert.ok(latestItems.some((i: any) => i.id === id));
    assert.ok(latestItems.every((i: any) => i.domains.includes("medical")));
    assert.equal(requests.length, paid, "public reads never call a model");
  } finally {
    await client.close();
    if (id) {
      await setVisibility(id, { visibility: "withdrawn", reason: "test cleanup", version: 0 }, "test");
      // The controlled clock must not leave this fixture holding later tests' global watermark.
      await sql`UPDATE selected_ledger SET visible_at = now() WHERE article_id = ${id}`;
    }
    t.mock.timers.reset();
    feed.closeAllConnections();
    await new Promise<void>((resolve) => feed.close(() => resolve()));
  }
});
