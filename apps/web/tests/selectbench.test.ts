// The production page and router talk only to this local API. Build the Web workspace first;
// Chromium and WebKit use the same browser installation as menu.test.ts.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, webkit, type Browser } from "playwright";

const cases = [
  { case_id: "absent", title: "Unstratified case", stratum: null },
  { case_id: "named", title: "Clinical case", stratum: "clinical" },
  { case_id: "literal", title: "Literal null label", stratum: "null" },
  { case_id: "empty", title: "Empty string label", stratum: "" },
];
const decision = { decision: "select", score: 80, relevance: "pass", category: null, reason: null, error: null, receiptId: null };
const summary = { n: 4, decisive: 4, either: 0, errors: 0, tp: 4, fp: 0, fn: 0, tn: 0, accuracy: 1, precision: 1, recall: 1, f1: 1, status: "ok", domainAnnotated: 4, sweep: [] };
const run = {
  id: "strata-run", label: "Stratum filters", split: null, sample_size: 4, prompt_version: null,
  models: ["primary", "other"], created_at: "2026-10-09T00:00:00Z",
  summary: { primary: { ...summary, byDomain: { medical: summary } }, other: { ...summary, byDomain: { medical: summary } } },
};
let web: ChildProcess;
let origin: string;
const browsers: Array<{ name: string; browser: Browser }> = [];
const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://api.local");
  res.setHeader("Content-Type", "application/json");
  if (url.pathname === "/api/site/meta") return res.end(JSON.stringify({ changelogVersion: null }));
  if (url.pathname === "/api/admin/me") return res.end(JSON.stringify({ name: "Local test admin", csrf: "local-test-csrf", dev: false }));
  if (url.pathname === "/api/admin/nav-counts") return res.end("{}");
  if (url.pathname === "/api/admin/selectbench/strata-run") {
    const stratum = url.searchParams.has("stratum") ? JSON.parse(url.searchParams.get("stratum")!) : undefined;
    const rows = cases.filter((c) => (stratum === undefined || c.stratum === stratum) && (url.searchParams.get("domain") !== "legal" || c.stratum === "clinical"))
      .map((c) => ({ ...c, gold: "select", domains: ["medical"], by_model: { primary: decision, other: decision } }));
    const strata = cases.filter((c) => url.searchParams.get("domain") !== "legal" || c.stratum === "clinical").map((c) => ({ stratum: c.stratum, n: 1 }));
    return res.end(JSON.stringify({ run, rows, strata, domain: url.searchParams.get("domain"), stratum }));
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ code: "not_found" }));
});

before(async () => {
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  web = spawn(process.execPath, [fileURLToPath(new URL("../server.ts", import.meta.url))], {
    env: {
      ...process.env, WEB_PORT: "0", TRUST_PROXY: "false", API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
      COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false", FEISHU_CONTENT_PUSH_ENABLED: "false", FEISHU_INTERNAL_ENABLED: "false", INDEXNOW_SUBMIT_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`web did not start: ${logs}`)), 15_000);
    web.on("exit", () => { clearTimeout(timeout); reject(new Error(`web exited: ${logs}`)); });
    web.stderr!.on("data", (chunk) => { logs += String(chunk); });
    web.stdout!.on("data", (chunk) => {
      logs += String(chunk);
      const match = logs.match(/"msg":"web started","port":(\d+)/);
      if (match) {
        origin = `http://127.0.0.1:${match[1]}`;
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  for (const [name, type] of [["Chromium", chromium], ["WebKit", webkit]] as const) browsers.push({ name, browser: await type.launch() });
});

after(async () => {
  await Promise.all(browsers.map(({ browser }) => browser.close()));
  if (web?.exitCode === null) {
    web.kill("SIGTERM");
    await once(web, "exit");
  }
  api.closeAllConnections();
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

for (const engine of ["Chromium", "WebKit"]) {
  test(`${engine}: all, unstratified and every named stratum stay distinct across navigation`, async () => {
    const context = await browsers.find(({ name }) => name === engine)!.browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/admin/selectbench/strata-run?domain=medical&model=other&outcome=tp&disagree=1`);
      const select = page.getByRole("combobox", { name: "样本分层", exact: true });
      assert.equal(await select.inputValue(), "");
      assert.equal(await select.locator("option:checked").count(), 1);
      for (const c of cases) assert.equal(await page.getByText(c.title, { exact: true }).count(), 1);
      for (const c of cases) {
        const value = JSON.stringify(c.stratum);
        await select.selectOption(value);
        await page.waitForURL((url) => url.searchParams.get("stratum") === value);
        await page.waitForFunction((expected) => document.querySelector<HTMLSelectElement>('select[aria-label="样本分层"]')?.value === expected, value);
        await page.getByText(c.title, { exact: true }).waitFor();
        assert.deepEqual(Object.fromEntries(new URL(page.url()).searchParams), { domain: "medical", model: "other", outcome: "tp", disagree: "1", stratum: value });
        assert.equal(await select.inputValue(), value);
        for (const other of cases.filter((x) => x !== c)) {
          await page.getByText(other.title, { exact: true }).waitFor({ state: "hidden" });
          assert.equal(await page.getByText(other.title, { exact: true }).count(), 0);
        }
        await page.reload();
        assert.equal(await select.inputValue(), value);
        assert.equal(await page.getByText(c.title, { exact: true }).count(), 1);
      }
      // Equivalent valid JSON literals use the parsed identity, not their wire spelling.
      for (const [wire, parsed, title] of [[" null ", null, cases[0]!.title], ['"cl\\u0069nical"', "clinical", cases[1]!.title]] as const) {
        const url = new URL(page.url());
        url.searchParams.set("stratum", wire);
        await page.goto(url.href);
        assert.equal(await select.inputValue(), JSON.stringify(parsed));
        assert.equal(await page.getByText(title, { exact: true }).count(), 1);
        await page.reload();
        assert.equal(await select.inputValue(), JSON.stringify(parsed));
      }
      await select.selectOption("null");
      await page.waitForFunction(() => document.querySelector<HTMLSelectElement>('select[aria-label="样本分层"]')?.value === "null");
      // A domain with no samples in this stratum must not display the all-strata option.
      await page.getByRole("combobox", { name: /人工领域/ }).selectOption("legal");
      await page.waitForURL((url) => url.searchParams.get("domain") === "legal");
      await page.getByText("没有符合条件的样本", { exact: true }).waitFor();
      assert.equal(await select.inputValue(), "null");
      assert.equal(await select.locator("option:checked").getAttribute("value"), "null");
      assert.deepEqual(Object.fromEntries(new URL(page.url()).searchParams), { domain: "legal", model: "other", outcome: "tp", disagree: "1", stratum: "null" });
      await page.reload();
      assert.equal(await select.inputValue(), "null");
      await page.getByRole("combobox", { name: /人工领域/ }).selectOption("medical");
      await page.waitForURL((url) => url.searchParams.get("domain") === "medical");
      await page.getByText(cases[0]!.title, { exact: true }).waitFor();
      await select.selectOption("");
      await page.waitForURL((url) => !url.searchParams.has("stratum"));
      await page.getByText(cases[3]!.title, { exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelector<HTMLSelectElement>('select[aria-label="样本分层"]')?.value === "");
      assert.equal(await select.locator("option:checked").count(), 1);
      for (const c of cases) assert.equal(await page.getByText(c.title, { exact: true }).count(), 1);
      // Native keyboard selection follows the same URL owner and retains the other filters.
      await select.focus();
      await page.keyboard.press("ArrowDown");
      await page.waitForURL((url) => url.searchParams.get("stratum") === "null");
      await page.getByText(cases[0]!.title, { exact: true }).waitFor();
      assert.equal(await select.evaluate((element) => element === document.activeElement), true);
    } finally {
      await context.close();
    }
  });
}
