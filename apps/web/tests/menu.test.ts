// Production components and router, with a local HTTP API only. Install browsers with
// `npx playwright install chromium webkit`, then build the Web workspace before running this suite.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, devices, webkit, type Browser, type Page } from "playwright";

let web: ChildProcess;
let origin: string;
const browsers: Array<{ name: string; browser: Browser }> = [];
const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://api.local");
  res.setHeader("Content-Type", "application/json");
  if (url.pathname === "/api/site/meta") return res.end(JSON.stringify({ changelogVersion: null }));
  if (url.pathname === "/api/site/timeline") return res.end(JSON.stringify({
    cards: [], nextCursor: null, refreshAt: new Date(Date.now() + 60_000).toISOString(),
    dayCounts: [], hot: null, generatedAt: new Date().toISOString(),
  }));
  if (url.pathname === "/api/site/items/menu-item") return res.end(JSON.stringify({
    id: "menu-item", revision: 1, title: "Menu article", originalTitle: null, summary: "Summary", reason: null,
    source: { id: "source", name: "Source", kind: "rss", firstParty: true, iconUrl: null },
    links: { aihot: "/items/menu-item", original: "https://example.org/article" },
    publishedAt: "2026-10-08T00:00:00Z", discoveredAt: "2026-10-08T00:00:00Z", timelineAt: "2026-10-08T00:00:00Z",
    category: "paper", domains: ["medical"], tags: [], score: 90, selected: true, channel: "news", x: null,
    readingMode: "summary-only", author: null, language: "zh", body: null, outline: [], relatedStories: [],
    indexable: true, markdownAvailable: true, group: null, story: null, hasTranslation: false, bodyLanguage: "zh",
  }));
  if (url.pathname === "/items/menu-item/markdown") {
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="menu-item.md"');
    return res.end("# Menu article\n");
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ code: "not_found" }));
});

before(async () => {
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  web = spawn(process.execPath, [fileURLToPath(new URL("../server.ts", import.meta.url))], {
    env: { ...process.env, WEB_PORT: "0", TRUST_PROXY: "false", API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}` },
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

// Reproduce WebKit's null-relatedTarget blur independently of the engine's focus defaults.
// Only the next internal press loses focus; the real Menu and router handle everything after it.
async function loseFocusOnPress(page: Page) {
  await page.evaluate(() => {
    document.addEventListener("mousedown", (event) => {
      if (!(event.target instanceof Element) || !event.target.closest('[role^="menuitem"]')) return;
      event.preventDefault();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    }, { capture: true, once: true });
  });
}

for (const engine of ["Chromium", "WebKit"]) {
  test(`${engine}: touch changes domain and preserves same-domain URLs`, async () => {
    const context = await browsers.find(({ name }) => name === engine)!.browser.newContext({ ...devices["iPhone 13"] });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/`);
      const trigger = page.locator("main").getByRole("button", { name: /^切换领域/ });
      await trigger.tap();
      await page.getByRole("menuitemradio", { name: "医疗", exact: true }).tap();
      await page.waitForURL(`${origin}/?domain=medical`);
      assert.equal(await page.evaluate(() => localStorage.getItem("aihot-domain")), "medical");
      const path = "/?domain=medical&tag=%E8%8D%AF%E5%93%81&channel=firstParty#main";
      await page.goto(origin + path);
      await trigger.tap();
      await page.getByRole("menuitemradio", { name: "医疗", exact: true }).tap();
      assert.equal(page.url(), origin + path);
      assert.equal(await trigger.getAttribute("aria-expanded"), "false");
    } finally {
      await context.close();
    }
  });

  test(`${engine}: an internal null-focus blur cannot cancel link activation`, async () => {
    const context = await browsers.find(({ name }) => name === engine)!.browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/`);
      const trigger = page.locator("main").getByRole("button", { name: /^切换领域/ });
      await trigger.click();
      await page.getByRole("menuitemradio", { name: "全部领域", exact: true }).waitFor({ state: "visible" });
      await loseFocusOnPress(page);
      await page.getByRole("menuitemradio", { name: "医疗", exact: true }).click();
      await page.waitForURL(`${origin}/?domain=medical`);
      assert.equal(await page.evaluate(() => localStorage.getItem("aihot-domain")), "medical");
      assert.equal(await trigger.getAttribute("aria-expanded"), "false");
    } finally {
      await context.close();
    }
  });

  test(`${engine}: keyboard focus, Escape and outside presses dismiss without stealing focus`, async () => {
    const context = await browsers.find(({ name }) => name === engine)!.browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/`);
      const trigger = page.locator("main").getByRole("button", { name: /^切换领域/ });
      await trigger.focus();
      await page.keyboard.press("ArrowDown");
      await page.getByRole("menuitemradio", { name: "全部领域", exact: true }).waitFor({ state: "visible" });
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press(" ");
      await page.waitForURL(`${origin}/?domain=ai`);
      await trigger.click();
      await page.keyboard.press("Escape");
      assert.equal(await trigger.getAttribute("aria-expanded"), "false");
      assert.equal(await trigger.evaluate((button) => button === document.activeElement), true);
      await trigger.click();
      const outside = page.locator('a[href="#main"]');
      await outside.focus();
      assert.equal(await trigger.getAttribute("aria-expanded"), "false");
      assert.equal(await outside.evaluate((link) => link === document.activeElement), true);
      await trigger.click();
      await page.locator("main").getByRole("heading").first().click();
      assert.equal(await trigger.getAttribute("aria-expanded"), "false");
      await trigger.click();
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      assert.equal(await trigger.getAttribute("aria-expanded"), "false");
    } finally {
      await context.close();
    }
  });

  test(`${engine}: the shared article menu still activates a download after null-focus blur`, async () => {
    const context = await browsers.find(({ name }) => name === engine)!.browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/items/menu-item`);
      const trigger = page.getByRole("button", { name: "更多操作", exact: true }).filter({ visible: true });
      await trigger.click();
      await loseFocusOnPress(page);
      const downloaded = page.waitForEvent("download");
      await page.getByRole("menuitem", { name: "导出 Markdown", exact: true }).click();
      assert.equal((await downloaded).url(), `${origin}/items/menu-item/markdown`);
      assert.equal(await trigger.getAttribute("aria-expanded"), "false");
      assert.equal(page.url(), `${origin}/items/menu-item`);
    } finally {
      await context.close();
    }
  });
}
