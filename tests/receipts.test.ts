// Paid requests: an answer already received is reused, every request actually sent counts against the
// budget (retries of one logical request included), a lost answer is bought again at most once, and the
// valve stops calls before they are sent.
import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { z } from "zod";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { chatJson, ModelOutputError } from "@aihot/backend/providers/llm";
import { embeddingsAvailable } from "@aihot/backend/providers/embeddings";
import { BudgetExceededError, paidRequest, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { autoReleaseUnknownReceipts } from "@aihot/backend/admin/runs";
import { listBudgets } from "@aihot/backend/admin/settings";
import { guardedFetch, RequestNotSentError } from "@aihot/backend/lib/http-fetch";

const usage = { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 };
let answer: (hit: number) => string = () => '{"ok":true}';
const provider = await stub((hit) => ({ id: `stub-${hit}`, choices: [{ message: { content: answer(hit) } }], usage }));
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";

const ask = (subject: string) =>
  chatJson({ model: "deepseek-flash", purpose: "invariant_test", subject, promptVersion: "t1", system: "s", user: `input ${subject}`, schema: z.object({ ok: z.boolean() }) });

let savedBudget: { per_minute: number; per_hour: number; per_day: number } | undefined;
before(async () => {
  [savedBudget] = await sql<{ per_minute: number; per_hour: number; per_day: number }[]>`SELECT per_minute, per_hour, per_day FROM budgets WHERE service = 'deepseek'`;
});
after(async () => {
  if (savedBudget) await sql`UPDATE budgets SET per_minute = ${savedBudget.per_minute}, per_hour = ${savedBudget.per_hour}, per_day = ${savedBudget.per_day} WHERE service = 'deepseek'`;
  await provider.close();
  await closeDb();
});

test("the migrations seed a budget for every paid service", async () => {
  const rows = await sql<{ service: string }[]>`SELECT service FROM budgets`;
  const services = new Set(rows.map((r) => r.service));
  for (const s of ["jina", "socialdata", "dajiala", "zhipu", "deepseek", "mimo", "dashscope"]) assert.ok(services.has(s), `no budget for ${s}`);
});

test("an answer already received is reused instead of bought again", async () => {
  answer = () => '{"ok":true}';
  const subject = `reuse-${tag()}`;
  const before = provider.hits();
  const first = await ask(subject);
  const second = await ask(subject);
  assert.equal(provider.hits() - before, 1);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.receiptId, first.receiptId);
});

test("retries of unusable answers stop at the budget, and every request sent is counted", async () => {
  answer = () => "sorry, not json";
  const subject = `budget-${tag()}`;
  // Leave room for exactly two more requests in every window.
  const [c] = await sql<{ minute: number; hour: number; day: number }[]>`
    SELECT count(*) FILTER (WHERE started_at > now() - interval '1 minute')::int AS minute,
           count(*) FILTER (WHERE started_at > now() - interval '1 hour')::int AS hour,
           count(*)::int AS day
    FROM receipt_attempts WHERE service = 'deepseek' AND origin = 'live' AND started_at > now() - interval '1 day'`;
  await sql`UPDATE budgets SET per_minute = ${c!.minute + 2}, per_hour = ${c!.hour + 2}, per_day = ${c!.day + 2} WHERE service = 'deepseek'`;

  const before = provider.hits();
  const outcomes: string[] = [];
  for (let i = 0; i < 5; i++) {
    // What a job retry does: the same logical request again.
    await ask(subject).then(
      () => outcomes.push("ok"),
      (error: unknown) => outcomes.push(error instanceof ModelOutputError ? "unusable" : error instanceof BudgetExceededError ? "budget" : String(error)),
    );
  }
  assert.equal(provider.hits() - before, 2, "requests sent");
  assert.deepEqual(outcomes, ["unusable", "unusable", "budget", "budget", "budget"]);
  const attempts = await sql<{ status: string; tokens: number }[]>`
    SELECT a.status, (a.usage->>'total_tokens')::int AS tokens
    FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id WHERE r.subject = ${subject} ORDER BY a.attempt`;
  assert.deepEqual(attempts.map((a) => a.tokens), [100, 100], "each attempt keeps its own usage");
});

test("with the valve off nothing is sent", async () => {
  config.modelCallsEnabled = false;
  try {
    const before = provider.hits();
    await assert.rejects(ask(`valve-${tag()}`), /disabled/);
    assert.equal(provider.hits(), before);
    process.env.DASHSCOPE_API_KEY = "test-key";
    assert.equal(embeddingsAvailable(), false);
  } finally {
    config.modelCallsEnabled = true;
    delete process.env.DASHSCOPE_API_KEY;
  }
});

test("an unknown outcome is released automatically once, so a lost answer costs at most one repeat", async () => {
  // A service without a budget row: the budget tests above may have used up deepseek's.
  const req = { service: "invariant-unbudgeted", purpose: "invariant_test", subject: `lost-${tag()}`, identity: { lost: tag() } };
  let sent = 0;
  const lost = () => {
    sent += 1;
    return Promise.reject(new Error("socket hang up after sending"));
  };
  const status = async () => (await sql<{ status: string }[]>`SELECT status FROM receipts WHERE subject = ${req.subject}`)[0]!.status;
  const age = () => sql`UPDATE receipts SET updated_at = now() - interval '31 minutes' WHERE subject = ${req.subject}`;

  await assert.rejects(paidRequest(req, lost));
  assert.equal(await status(), "unknown");
  await autoReleaseUnknownReceipts();
  assert.equal(await status(), "unknown", "not within half an hour");

  await age();
  await autoReleaseUnknownReceipts();
  assert.equal(await status(), "failed");
  await assert.rejects(paidRequest(req, lost));
  assert.equal(sent, 2, "one repeat after the release");

  await age();
  await autoReleaseUnknownReceipts();
  assert.equal(await status(), "unknown", "a second loss waits for the admin");
  await assert.rejects(paidRequest(req, lost), ReceiptUnknownError);
  assert.equal(sent, 2);
});

test("a paid request withheld by host cooldown stays retryable and releases its budget reservation", async (t) => {
  const service = `queue-${tag()}`;
  const request = { service, purpose: "invariant_test", subject: service, identity: { service } };
  const local = await stub((_hit, req) => req.url === "/cooldown" ? new Reply(429, {}, { "retry-after": "1" }) : { ok: true });
  const saved = { allowPrivate: config.allowPrivateNetworkFetch, retry: config.outboundRetryAfterMaxSeconds };
  config.allowPrivateNetworkFetch = true;
  config.outboundRetryAfterMaxSeconds = 1;
  try {
    await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES (${service}, 1, 1, 1)`;
    await guardedFetch(`${local.url}/cooldown`, { route: "direct" });
    const call = async () => ({ response: JSON.parse((await guardedFetch(`${local.url}/paid`, { timeoutMs: 80, route: "direct" })).text()) });
    await assert.rejects(paidRequest(request, call), RequestNotSentError);
    assert.equal(local.hits(), 1, "only the request establishing cooldown was sent");
    const [receipt] = await sql<{ id: number; status: string }[]>`SELECT id, status FROM receipts WHERE subject = ${service}`;
    assert.equal(receipt!.status, "failed");
    const [attempt] = await sql<{ status: string }[]>`SELECT status FROM receipt_attempts WHERE receipt_id = ${receipt!.id}`;
    assert.equal(attempt!.status, "not_sent");
    const budget = (await listBudgets()).find((row) => row.service === service)!;
    assert.deepEqual([budget.used_hour, budget.used_day], [0, 0]);
    t.diagnostic(`before retry: paid sends=${local.hits() - 1}, receipt=${receipt!.status}, attempt=${attempt!.status}, budget=${budget.used_hour}/${budget.used_day}`);

    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const completed = await paidRequest(request, call);
    assert.equal(completed.receiptId, receipt!.id, "the logical request retries without an unknown-receipt release");
    assert.equal(local.hits(), 2);
    const attempts = await sql<{ status: string }[]>`SELECT status FROM receipt_attempts WHERE receipt_id = ${receipt!.id} ORDER BY attempt`;
    assert.deepEqual(attempts.map((row) => row.status), ["not_sent", "received"]);
    t.diagnostic(`after cooldown: paid sends=${local.hits() - 1}, attempts=${attempts.map((row) => row.status).join(",")}, same receipt=${completed.receiptId === receipt!.id}`);
    await assert.rejects(paidRequest({ ...request, identity: { service, another: true } }, call), BudgetExceededError);
    assert.equal(local.hits(), 2, "the sent retry consumes the single available budget slot");
  } finally {
    config.allowPrivateNetworkFetch = saved.allowPrivate;
    config.outboundRetryAfterMaxSeconds = saved.retry;
    await local.close();
    await sql`DELETE FROM budgets WHERE service = ${service}`;
  }
});
