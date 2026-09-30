import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, test } from 'node:test';
import { config } from '@aihot/backend/config';
import { sql, closeDb } from '@aihot/backend/db';
import { stopBoss } from '@aihot/backend/jobs/queue';
import { collectSource } from '@aihot/backend/sources/collect';
import { previewSource } from '@aihot/backend/admin/sources';

const T = tag();
let version = 1;
let broken = false;
let redirectNew = false;
const modified = 'Mon, 28 Sep 2026 10:00:00 GMT';
const requests: Array<{ path: string; method?: string; etag?: string; modified?: string }> = [];

const server = http.createServer((req, res) => {
  const path = req.url ?? '/';
  requests.push({ path, method: req.method, etag: req.headers['if-none-match'], modified: req.headers['if-modified-since'] });
  if (path === '/forbidden') {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  if (path === '/retry') {
    res.writeHead(429, { 'retry-after': '2' });
    res.end('slow down');
    return;
  }
  if (path === '/web.html') {
    const etag = '"web-v1"';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'last-modified': modified });
      res.end();
      return;
    }
    const entries = Array.from({ length: 40 }, (_, i) =>
      `<li><a href="/web-${T}-${i}">Web ${i} ${T}</a><time datetime="2026-09-28T10:${String(i).padStart(2, '0')}:00Z"></time></li>`).join('');
    res.writeHead(200, { 'content-type': 'text/html', etag, 'last-modified': modified });
    res.end(`<ul>${entries}</ul>`);
    return;
  }
  if (path === '/items.json' || path === '/items-post') {
    const etag = '"json-v1"';
    if (path === '/items.json' && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'last-modified': modified });
      res.end();
      return;
    }
    const count = path === '/items.json' ? 40 : 1;
    const items = Array.from({ length: count }, (_, i) => ({ id: i, name: `JSON ${i} ${T}`, published_at: `2026-09-28T10:${String(i).padStart(2, '0')}:00Z` }));
    res.writeHead(200, { 'content-type': 'application/json', ...(path === '/items.json' ? { etag, 'last-modified': modified } : {}) });
    res.end(JSON.stringify({ items }));
    return;
  }
  if (path === '/redirect') {
    res.writeHead(302, { location: redirectNew ? '/new.xml' : '/old.xml' });
    res.end();
    return;
  }
  const etag = path === '/modified.xml' ? undefined : path === '/feed.xml' ? `"v${version}"` : '"shared"';
  if ((etag && req.headers['if-none-match'] === etag) || (!etag && req.headers['if-modified-since'] === modified)) {
    res.writeHead(304, { ...(etag ? { etag } : {}), 'last-modified': modified });
    res.end();
    return;
  }
  const entries = Array.from({ length: path === '/feed.xml' ? 40 : 1 }, (_, i) =>
    `<item><title>Entry ${i} ${path === '/feed.xml' && i === 0 ? version : path} ${T}</title><link>https://example.org/source-conditional-${T}/${path.replaceAll('/', '')}/${i}</link><pubDate>${new Date(Date.now() - 1000 * i).toUTCString()}</pubDate></item>`).join('');
  res.writeHead(200, { 'content-type': 'application/rss+xml', ...(etag ? { etag } : {}), 'last-modified': modified });
  res.end(broken ? '<not-feed/>' : `<rss version="2.0"><channel><title>Feed</title>${entries}</channel></rss>`);
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await stopBoss(); await closeDb(); });

async function source(id: string, kind: 'rss' | 'web_list' | 'json_list', sourceConfig: Record<string, unknown>, initialized = true) {
  await sql`INSERT INTO sources (id,name,kind,config,tier,participation_mode,cursor,next_fetch_at)
    VALUES (${id},'Conditional source test',${kind},${sql.json(sourceConfig as never)},'T1','editorial',${initialized ? sql.json({ initializedAt: new Date().toISOString() }) : null},'2100-01-01')`;
}
const cursor = async (id: string) => (await sql`SELECT cursor FROM sources WHERE id=${id}`)[0]!.cursor;

function assertObserved(detail: Record<string, unknown>, status: string) {
  const http = detail.http as {
    requests: number;
    bytes: number;
    maxMs: number;
    statuses: Record<string, number>;
    origins: Array<{ host: string; origin: string; route: string; proxied: boolean; requests: number; bytes: number; maxMs: number }>;
  };
  assert.ok(http.requests >= 1);
  assert.ok(http.bytes >= 0);
  assert.ok(http.maxMs >= 0);
  assert.ok(http.statuses[status] >= 1);
  const target = http.origins.find((entry) => entry.origin === base);
  assert.ok(target, 'the persisted run identifies its target');
  assert.deepEqual({ host: target.host, route: target.route, proxied: target.proxied }, { host: '127.0.0.1', route: 'egress', proxied: false });
  assert.ok(target.requests >= 1);
  assert.ok(target.bytes >= 0);
  assert.ok(target.maxMs >= 0);
}

test('RSS first backfill, ordinary window, 304, revision and config edits preserve collection behavior', async () => {
  const id = `rss-conditional-${T}`;
  await source(id, 'rss', { feedUrl: base + '/feed.xml' }, false);
  assert.equal((await collectSource(id)).created, 30);
  assert.equal((await cursor(id)).rss, undefined, 'the first backfill cap must not freeze the ordinary window');
  assert.equal((await collectSource(id)).created, 10);
  assert.equal((await cursor(id)).rss.etag, '"v1"');
  const third = await collectSource(id);
  assert.deepEqual([third.status, third.found, third.created, third.revised], ['ok', 0, 0, 0]);
  assert.equal(requests.at(-1)!.etag, '"v1"');
  const [run] = await sql`SELECT detail FROM fetch_runs WHERE source_id=${id} ORDER BY id DESC LIMIT 1`;
  assert.equal(run!.detail.notModified, true);
  assert.equal(run!.detail.httpStatus, 304);
  assertObserved(run!.detail, '304');
  const [healthy] = await sql`SELECT health,fail_count FROM sources WHERE id=${id}`;
  assert.deepEqual({ ...healthy }, { health: 'ok', fail_count: 0 });
  version = 2;
  assert.equal((await collectSource(id)).revised, 1, 'a changed feed is parsed and stored normally');
  await sql`UPDATE sources SET config=config || '{"summaryIsBody":true}'::jsonb WHERE id=${id}`;
  assert.equal((await collectSource(id)).status, 'ok');
  assert.equal(requests.at(-1)!.etag, undefined, 'config edits must reprocess unchanged bytes');
  await collectSource(id, { force: true });
  assert.equal(requests.at(-1)!.etag, undefined, 'manual recollection bypasses validation');
  const [saved] = await sql`SELECT id,kind,config,cursor FROM sources WHERE id=${id}`;
  assert.equal((await previewSource(saved as never)).count, 40, 'preview still returns items for an unchanged feed');
  assert.equal(requests.at(-1)!.etag, undefined);
  await sql`UPDATE sources SET participation_mode='hot_signal' WHERE id=${id}`;
  assert.equal((await collectSource(id)).status, 'ok');
  assert.equal(requests.at(-1)!.etag, undefined, 'a parsing-relevant source mode change must reprocess unchanged bytes');
  const beforeFailure = await cursor(id);
  version = 3;
  broken = true;
  assert.equal((await collectSource(id)).status, 'failed');
  assert.deepEqual(await cursor(id), beforeFailure, 'failed parsing never advances the success validator');
  broken = false;
  assert.equal((await collectSource(id)).revised, 1);
  assert.equal(requests.at(-1)!.etag, '"v2"');
});

test('direct Web and GET JSON sources preserve the first-import window and then accept 304', async () => {
  const web = `web-conditional-${T}`;
  await source(web, 'web_list', {
    url: `${base}/web.html`, itemSelector: 'li', linkSelector: 'a', titleSelector: 'a', publishedAtSelector: 'time',
  }, false);
  assert.equal((await collectSource(web)).created, 30);
  assert.equal((await cursor(web)).web, undefined);
  assert.equal((await collectSource(web)).created, 10);
  assert.equal((await cursor(web)).web.etag, '"web-v1"');
  assert.equal((await collectSource(web)).found, 0);
  assert.equal(requests.at(-1)!.etag, '"web-v1"');

  const json = `json-conditional-${T}`;
  await source(json, 'json_list', {
    url: `${base}/items.json`, headers: { 'If-None-Match': '"configured"' }, itemsPath: 'items', titlePaths: ['name'], publishedAtPath: 'published_at', urlTemplate: `${base}/json-{id}`,
  }, false);
  assert.equal((await collectSource(json)).created, 30);
  assert.equal(requests.at(-1)!.etag, undefined, 'configured conditional headers cannot own collection validators');
  assert.equal((await cursor(json)).json, undefined);
  assert.equal((await collectSource(json)).created, 10);
  assert.equal(requests.at(-1)!.etag, undefined);
  assert.equal((await cursor(json)).json.etag, '"json-v1"');
  assert.equal((await collectSource(json)).found, 0);
  assert.equal(requests.at(-1)!.etag, '"json-v1"');
});

test('non-GET JSON sources never send or store HTTP validators', async () => {
  const id = `json-post-${T}`;
  await source(id, 'json_list', {
    url: `${base}/items-post`, method: 'POST', bodyJson: { page: 1 }, itemsPath: 'items', titlePaths: ['name'], urlTemplate: `${base}/json-post-{id}`,
  });
  assert.equal((await collectSource(id)).created, 1);
  assert.equal((await collectSource(id)).status, 'ok');
  const sent = requests.filter(r => r.path === '/items-post');
  assert.equal(sent.length, 2);
  assert.ok(sent.every(r => r.method === 'POST' && !r.etag && !r.modified));
  assert.equal((await cursor(id)).json, undefined);
});

test('Last-Modified works without ETag and changing redirect targets cannot accept an unrelated 304', async () => {
  const lm = `rss-modified-${T}`;
  await source(lm, 'rss', { feedUrl: base + '/modified.xml' });
  assert.equal((await collectSource(lm)).created, 1);
  assert.equal((await collectSource(lm)).found, 0);
  assert.equal(requests.at(-1)!.modified, modified);
  const redirect = `rss-redirect-${T}`;
  await source(redirect, 'rss', { feedUrl: base + '/redirect' });
  assert.equal((await collectSource(redirect)).created, 1);
  redirectNew = true;
  assert.equal((await collectSource(redirect)).created, 1, 'new destination is fetched without old destination validators');
  assert.equal(requests.at(-1)!.path, '/new.xml');
  assert.equal(requests.at(-1)!.etag, undefined);
});

test('a failed 403 run persists the target, route, timing and status for diagnosis', async () => {
  const id = `rss-forbidden-${T}`;
  await source(id, 'rss', { feedUrl: base + '/forbidden' });
  assert.equal((await collectSource(id)).status, 'failed');
  const [run] = await sql`SELECT detail FROM fetch_runs WHERE source_id=${id} ORDER BY id DESC LIMIT 1`;
  assertObserved(run!.detail, '403');
});

test('Retry-After is capped for host cooldown and run detail without shortening consecutive-failure backoff', async () => {
  const savedLimit = config.outboundRetryAfterMaxSeconds;
  config.outboundRetryAfterMaxSeconds = 1;
  try {
    const id = `rss-retry-${T}`;
    await source(id, 'rss', { feedUrl: base + '/retry' });
    await sql`UPDATE sources SET interval_minutes=2, fail_count=2 WHERE id=${id}`;
    const before = Date.now();
    assert.equal((await collectSource(id)).status, 'failed');
    const [saved] = await sql`SELECT next_fetch_at,fail_count FROM sources WHERE id=${id}`;
    const delay = new Date(saved!.next_fetch_at).getTime() - before;
    assert.ok(delay >= 479_000 && delay <= 483_000, `unexpected retry delay ${delay}ms`);
    assert.equal(saved!.fail_count, 3);
    const [run] = await sql`SELECT detail FROM fetch_runs WHERE source_id=${id} ORDER BY id DESC LIMIT 1`;
    assert.equal(run!.detail.retryAfterSeconds, 1);
    assert.equal(run!.detail.http.retryAfterSeconds, 1);
    assertObserved(run!.detail, '429');
  } finally {
    config.outboundRetryAfterMaxSeconds = savedLimit;
  }
});
