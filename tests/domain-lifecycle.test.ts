// Exercise a changed industry configuration in this test process, never edit the real industry file.
// decision: use Node's module hook for the configuration fixture; not add production dependency
// injection because every producer and public consumer must keep reading the same taxonomy owner.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { promisify } from "node:util";
import type { DomainKey } from "@aihot/contracts/taxonomy";

const fixture = process.env.DOMAIN_CONFIG_TEST;
const empty = fixture === "empty";
const seeding = fixture?.startsWith("seed-");
const taxonomyUrl = new URL("../industry/taxonomy.ts", import.meta.url).href;
const seedUrl = new URL("../scripts/seed.ts", import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== taxonomyUrl && !(url === seedUrl && seeding)) return loaded;
    const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source as Uint8Array).toString("utf8");
    if (url === seedUrl) {
      const pack = { sources: [{ id: process.env.SEED_SOURCE_TEST_ID, name: "Seed domain fixture", kind: "rss",
        config: { feedUrl: "https://example.test/fixture.xml" }, domains: fixture === "seed-valid" ? ["finance", "medical"] : ["all"] }] };
      return { ...loaded, source: source.replace('JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/sources.json"), "utf8"))',
        `JSON.parse(${JSON.stringify(JSON.stringify(pack))})`) };
    }
    return { ...loaded, source: `${source.replace("export const DOMAINS =", "const DEFAULT_DOMAINS =")}
export const DOMAINS = [
  ...DEFAULT_DOMAINS.map(domain => ({ ...domain, enabled: ${empty ? "false" : 'domain.enabled && domain.key !== "medical"'} })),
  { key: "finance", label: "金融", enabled: ${!empty}, guide: "银行与金融市场、资本与金融监管", columns: DEFAULT_COLUMNS },
] as const;` };
  },
});

const { stub, tag } = await import("./setup.ts");
const { addDays, beijingDate, beijingMidnight, isoWeekLabel } = await import("@aihot/contracts/time");
const { DOMAIN_KEYS, ENABLED_DOMAIN_KEYS, isDomainKey } = await import("@aihot/contracts/taxonomy");
const { DOMAINS } = await import("@aihot/industry/taxonomy");
const { REPORT_SCOPES, ENABLED_REPORT_SCOPES } = await import("@aihot/contracts/site");
const { config } = await import("@aihot/backend/config");
const { sql, closeDb } = await import("@aihot/backend/db");
const { createSource } = await import("@aihot/backend/admin/sources");
const { overrideFields } = await import("@aihot/backend/admin/content");
const { collectSource, collectXShard, scheduleDueSources } = await import("@aihot/backend/sources/collect");
const { checkMpAccount, scheduleMpReconcile } = await import("@aihot/backend/sources/mp");
const { processArticle } = await import("@aihot/backend/jobs/content");
const { stopBoss } = await import("@aihot/backend/jobs/queue");
const { composeDaily, composeWeekly, composeMonthly, catchUpReports } = await import("@aihot/backend/reports/compose");
const { SCHEDULES } = await import("../apps/worker/src/schedules.ts");
const { buildApp } = await import("../apps/api/src/app.ts");
const T = tag();
after(async () => { await stopBoss(); await closeDb(); });

if (seeding) {
  test("the actual seed CLI reads the configured source pack", async () => { await import("../scripts/seed.ts"); });
} else if (empty) {
  test("no enabled domains enqueue no automatic collection, while historical identities stay valid", async () => {
    assert.deepEqual(ENABLED_DOMAIN_KEYS, []);
    assert.deepEqual(ENABLED_REPORT_SCOPES, ["all"]);
    assert.ok(isDomainKey("finance") && isDomainKey("medical"));
    const ids = ["rss", "mp_account", "x_search"].map((kind) => `test-empty-${kind.replaceAll("_", "-")}-${T}`);
    try {
      for (const [i, kind] of ["rss", "mp_account", "x_search"].entries()) {
        await sql`INSERT INTO sources (id, name, kind, domains, config, cursor)
          VALUES (${ids[i]!}, 'Empty coverage fixture', ${kind}, '{}',
            ${sql.json(kind === "x_search" ? { query: "from:EmptyDomain", searchType: "Latest" } : {})},
            ${sql.json(kind === "x_search" ? { lastTweetId: "1" } : {})})`;
      }
      assert.deepEqual(await scheduleDueSources(), { enqueued: 0, shards: 0 });
      assert.equal((await scheduleMpReconcile()).enqueued, 0);
      assert.equal((await collectSource(ids[0]!)).status, "skipped");
      assert.equal((await checkMpAccount(ids[1]!, "schedule")).status, "paused");
      assert.equal((await collectXShard(`empty-${T}`, [ids[2]!])).status, "skipped");
      assert.ok(!SCHEDULES.some((s) => /reports\.(daily|weekly|monthly|catch-up)\.(medical|finance)$/.test(s.name)));
    } finally {
      await sql`DELETE FROM sources WHERE id IN ${sql(ids)}`;
    }
  });
} else {
  test("a configured new domain reaches production and public contracts; disabling preserves history without new work", async (t) => {
    const finance = "finance" as DomainKey;
    assert.ok(DOMAIN_KEYS.includes(finance));
    assert.ok(REPORT_SCOPES.includes("medical") && REPORT_SCOPES.includes(finance));
    assert.ok(!ENABLED_DOMAIN_KEYS.includes("medical") && ENABLED_DOMAIN_KEYS.includes(finance));
    assert.ok(SCHEDULES.some((s) => s.name === "reports.daily.finance"));
    assert.ok(!SCHEDULES.some((s) => s.name.endsWith(".medical")));
    let modelCalls = 0;
    const systems = new Map<string, string>();
    const provider = await stub((_hit, req) => {
      modelCalls += 1;
      const { model, reasoning_effort, messages } = JSON.parse(req.body) as { model: string; reasoning_effort?: string; messages: Array<{ role: string; content: string }> };
      const purpose = model === "glm-5.3-flash" && reasoning_effort === "high" ? "score" : model;
      systems.set(purpose, messages.find((m) => m.role === "system")?.content ?? "");
      const answers: Record<string, unknown> = {
        "qwen3.7-flash": { label: "PASS", reason: "金融监管" },
        score: { attentionScore: 80 },
        "qwen3.8-flash": { domains: ["medical", "finance"], category: "industry", tags: ["行业动态"], subjects: [], fact: null },
        "glm-5.3-flash": { itemType: "industry_event", authorRole: "principal", tags: ["行业动态"], editorialJudgment: "银行公开资本要求", titleZh: `银行公布资本要求 ${T}`, summaryZh: "银行公开新的资本要求和适用范围，并说明实施日期。" },
        "deepseek-flash": { title: "银行资本要求", leadParagraph: "本期汇总金融监管变化。", highlights: [1] },
      };
      assert.ok(answers[purpose], `unexpected test model ${model}`);
      return { choices: [{ message: { content: JSON.stringify(answers[purpose]) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    });
    for (const key of ["DASHSCOPE_BASE_URL", "ZHIPU_BASE_URL", "DEEPSEEK_BASE_URL"]) process.env[key] = `${provider.url}/v1`;
    for (const key of ["DASHSCOPE_API_KEY", "ZHIPU_API_KEY", "DEEPSEEK_API_KEY"]) process.env[key] = "test-key";
    process.env.EMBEDDINGS_ENABLED = "false";
    config.modelCallsEnabled = true;
    config.allowPrivateNetworkFetch = true;
    const [latest] = await sql<{ at: Date | null }[]>`SELECT max(timeline_at) AS at FROM publications WHERE selected`;
    const liveAt = new Date(beijingMidnight(addDays(beijingDate(Math.max(Date.now(), latest?.at?.getTime() ?? 0)), 2)).getTime() + 12 * 3600_000);
    const date = addDays(beijingDate(liveAt), 1);
    t.mock.timers.enable({ apis: ["Date"], now: liveAt });
    let feedReads = 0;
    const feed = createServer((_req, res) => {
      feedReads += 1;
      res.setHeader("content-type", "application/rss+xml");
      res.end(`<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Finance fixture</title><item><title>Bank capital ${T}</title><link>${origin}/capital-${T}</link><pubDate>${liveAt.toUTCString()}</pubDate><content:encoded><![CDATA[<p>${"The bank published capital requirements and their implementation date. ".repeat(20)}</p>]]></content:encoded></item></channel></rss>`);
    });
    feed.listen(0, "127.0.0.1");
    await once(feed, "listening");
    const origin = `http://127.0.0.1:${(feed.address() as AddressInfo).port}`;
    const sourceId = `test-finance-${T}`;
    const retired = [`test-retired-rss-${T}`, `test-retired-mp-${T}`, `test-retired-x-${T}`];
    const reportIds: number[] = [];
    let articleId: string | undefined;
    const app = await buildApp();
    const json = async (url: string) => {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 200, url);
      return res.json();
    };
    try {
      assert.equal((await createSource({ id: sourceId, name: "Finance fixture", kind: "rss", tier: "T1", domains: [finance],
        config: { feedUrl: `${origin}/feed.xml`, contentIsBody: true } }, "test")).created, true);
      await sql`UPDATE sources SET cursor = ${sql.json({ initializedAt: new Date(liveAt.getTime() - 60_000).toISOString() })} WHERE id = ${sourceId}`;
      assert.equal((await collectSource(sourceId)).created, 1);
      const [article] = await sql<{ id: string }[]>`SELECT id FROM articles WHERE source_id = ${sourceId}`;
      articleId = article!.id;
      assert.equal((await processArticle(articleId)).state, "pass");
      assert.equal(modelCalls, 5, "domain membership uses the existing structure request");
      const added = DOMAINS.find((d) => d.key === finance)!;
      const retiredGuide = DOMAINS.find((d) => d.key === "medical")!.guide;
      for (const purpose of ["qwen3.7-flash", "score", "qwen3.8-flash"]) {
        assert.ok(systems.get(purpose)!.includes(added.guide), "configured domain guides reach each judging request");
        assert.ok(!systems.get(purpose)!.includes(retiredGuide), "disabled guides are not current judging scope");
      }
      assert.ok(systems.get("glm-5.3-flash")!.includes(added.label), "the writer's reader scope comes from the same configuration");
      const [analysis] = await sql<{ domains: string[]; input_revision: number }[]>`SELECT domains, input_revision FROM analyses WHERE article_id = ${articleId}`;
      assert.deepEqual(analysis!.domains, ["finance"], "retired domain output does not become a new model annotation");
      t.mock.timers.setTime(beijingMidnight(date).getTime() + 8 * 3600_000 + 1000);
      const item = (await json(`/api/v1/items?domain=finance&window=7d`)).items.find((i: any) => i.id === articleId);
      assert.deepEqual(item.domains, ["finance"]);
      assert.equal((await composeDaily(finance, date, "test")).entries, 1);
      const [edition] = await sql<{ id: number; content: Record<string, any> }[]>`SELECT id, content FROM reports WHERE kind = 'daily' AND scope = ${finance} AND key = ${date}`;
      reportIds.push(edition!.id);
      assert.equal((await json(`/api/v1/dailies/${date}?domain=finance`)).report.scope, finance);
      const specification = await json("/openapi-v1.json");
      assert.deepEqual(specification.components.schemas.Domain.enum, [...DOMAIN_KEYS]);
      assert.deepEqual(specification.components.schemas.ReportScope.enum, [...REPORT_SCOPES]);
      assert.equal(specification.components.schemas.Domains.maxItems, DOMAIN_KEYS.length);

      await overrideFields(articleId, { fields: { domains: ["medical"] }, reason: "Historical annotation fixture", version: 0 }, "test");
      const [history] = await sql<{ id: number }[]>`INSERT INTO reports (kind, scope, key, window_start, window_end, content, generated_at)
        VALUES ('daily', 'medical', '2001-01-02', '2001-01-01', '2001-01-02', ${sql.json({ ...edition!.content, date: "2001-01-02" })}, now()) RETURNING id`;
      reportIds.push(history!.id);
      await sql`INSERT INTO report_revisions (report_id, revision, content, generated_at) VALUES (${history!.id}, 1, ${sql.json(edition!.content)}, now())`;
      const before = await sql`SELECT id, content FROM reports WHERE id = ${history!.id}`;
      const ledger = await sql`SELECT seq, payload FROM selected_ledger WHERE article_id = ${articleId} ORDER BY seq`;
      const paid = modelCalls;
      assert.equal((await composeDaily("medical", date, "test-disabled")).entries, 0);
      await composeDaily("medical", "2001-01-02", "test-disabled");
      await composeWeekly("medical", isoWeekLabel(date), "test-disabled");
      await composeMonthly("medical", date.slice(0, 7), "test-disabled");
      assert.deepEqual((await catchUpReports("medical")).generated, []);
      assert.deepEqual([...await sql`SELECT id, content FROM reports WHERE id = ${history!.id}`], [...before]);
      assert.deepEqual([...await sql`SELECT seq, payload FROM selected_ledger WHERE article_id = ${articleId} ORDER BY seq`], [...ledger]);
      assert.deepEqual((await json(`/api/v1/items?domain=medical&window=7d`)).items.find((i: any) => i.id === articleId).domains, ["medical"]);
      assert.equal((await json("/api/v1/dailies/2001-01-02?domain=medical")).report.scope, "medical");
      assert.equal((await json(`/api/site/items/${articleId}`)).id, articleId);
      assert.equal((await sql`SELECT 1 FROM reports WHERE scope = 'medical' AND key = ${date}`).length, 0);
      assert.equal((await sql`SELECT input_revision FROM analyses WHERE article_id = ${articleId}`)[0]!.input_revision, analysis!.input_revision);
      const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
      const { MCP_TOOL_NAMES } = await import("@aihot/contracts/mcp");
      await app.listen({ port: 0, host: "127.0.0.1" });
      const client = new Client({ name: "domain-configuration-test", version: "1" }, { versionNegotiation: { mode: "auto" } });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/mcp`)));
        const result = await client.callTool({ name: MCP_TOOL_NAMES.daily, arguments: { domain: finance, date } });
        assert.equal(result.isError, undefined);
        assert.equal((result.structuredContent as any).report.scope, finance);
        const old = await client.callTool({ name: MCP_TOOL_NAMES.daily, arguments: { domain: "medical", date: "2001-01-02" } });
        assert.equal(old.isError, undefined);
        assert.equal((old.structuredContent as any).report.scope, "medical");
      } finally { await client.close(); }
      assert.equal(modelCalls, paid, "historical reads and disabled producers call no models");

      await sql`INSERT INTO sources (id, name, kind, domains, config, cursor) VALUES
        (${retired[0]!}, 'Retired RSS', 'rss', ARRAY['medical'], ${sql.json({ feedUrl: `${origin}/feed.xml`, contentIsBody: true })}, '{}'),
        (${retired[1]!}, 'Retired MP', 'mp_account', ARRAY['medical'], '{"ghid":"fixture"}', '{}'),
        (${retired[2]!}, 'Retired X', 'x_search', ARRAY['medical'], '{"query":"from:RetiredDomain","searchType":"Latest"}', '{"lastTweetId":"1"}')`;
      await scheduleDueSources(2000);
      await scheduleMpReconcile();
      assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE data->>'sourceId' IN ${sql(retired)} OR data->'sourceIds' ? ${retired[2]!}`).length, 0);
      assert.equal((await collectSource(retired[0]!)).status, "skipped");
      assert.equal((await checkMpAccount(retired[1]!, "schedule")).status, "paused");
      assert.equal((await collectXShard(`retired-${T}`, [retired[2]!])).status, "skipped");
      assert.equal(feedReads, 1);
      assert.equal((await collectSource(retired[0]!, { force: true })).status, "ok");
      assert.equal(feedReads, 2, "an explicit administrator fetch remains available");
    } finally {
      await app.close();
      await provider.close();
      config.modelCallsEnabled = false;
      t.mock.timers.reset();
      feed.closeAllConnections();
      await new Promise<void>((resolve) => feed.close(() => resolve()));
      if (reportIds.length) await sql`DELETE FROM reports WHERE id IN ${sql(reportIds)}`;
      if (articleId) {
        await sql`DELETE FROM pgboss.job WHERE data->>'articleId' = ${articleId}`;
        await sql`DELETE FROM selected_ledger WHERE article_id = ${articleId}`;
        await sql`DELETE FROM articles WHERE id = ${articleId}`;
      }
      await sql`DELETE FROM pgboss.job WHERE data->>'sourceId' IN ${sql([sourceId, ...retired])}`;
      await sql`DELETE FROM sources WHERE id IN ${sql([sourceId, ...retired])}`;
    }
  });

  test("source seeding accepts registered new and retired domains, and rejects invalid identities before persistence", async () => {
    const schema = `test_seed_domain_${T}`;
    const database = new URL(config.databaseUrl);
    database.searchParams.set("search_path", `${schema},public`);
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: database.href, MODEL_CALLS_ENABLED: "false" };
    // decision: start sub-runners without NODE_TEST_CONTEXT; not inherit the parent worker
    // context because Node skips recursive --test launches instead of exercising the child tests.
    delete env.NODE_TEST_CONTEXT;
    const run = promisify(execFile);
    const sourceId = `test-seed-${T}`;
    const invalidId = `test-seed-invalid-${T}`;
    await sql`CREATE SCHEMA ${sql(schema)}`;
    try {
      await run(process.execPath, ["scripts/migrate.ts"], { cwd: process.cwd(), env });
      const seeded = await run(process.execPath, ["--test", "--test-timeout=60000", import.meta.filename], {
        cwd: process.cwd(), env: { ...env, DOMAIN_CONFIG_TEST: "seed-valid", SEED_SOURCE_TEST_ID: sourceId },
      });
      assert.deepEqual((await sql`SELECT domains FROM ${sql(schema)}.sources WHERE id = ${sourceId}`)[0]?.domains,
        ["finance", "medical"], seeded.stdout + seeded.stderr);
      const code = await run(process.execPath, ["--test", "--test-timeout=60000", import.meta.filename], {
        cwd: process.cwd(), env: { ...env, DOMAIN_CONFIG_TEST: "seed-invalid", SEED_SOURCE_TEST_ID: invalidId },
      }).then(() => 0, (error) => error.code);
      assert.equal(code, 1);
      assert.equal((await sql`SELECT 1 FROM ${sql(schema)}.sources WHERE id = ${invalidId}`).length, 0);
    } finally {
      await sql`DROP SCHEMA ${sql(schema)} CASCADE`;
    }
  });

  test("an entirely disabled configuration is verified in an isolated module graph", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, DOMAIN_CONFIG_TEST: "empty", MODEL_CALLS_ENABLED: "false" };
    delete env.NODE_TEST_CONTEXT;
    await promisify(execFile)(process.execPath, ["--test", "--test-timeout=60000", import.meta.filename], { cwd: process.cwd(), env });
  });
}
