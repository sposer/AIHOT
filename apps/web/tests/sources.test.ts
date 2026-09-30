// Source creation defaults on the built production page, with a local admin API stub.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";

let web: ChildProcess;
let origin: string;
let logs = "";
const api = createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/admin/me") return res.end(JSON.stringify({ name: "Test admin", csrf: "test-csrf", dev: false }));
  if (req.url === "/api/admin/nav-counts") return res.end("{}");
  if (req.url === "/api/site/meta") return res.end(JSON.stringify({ changelogVersion: "2026-09-28T12:00" }));
  res.statusCode = 404;
  res.end("{}");
});

before(async () => {
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  web = spawn(process.execPath, [fileURLToPath(new URL("../server.ts", import.meta.url))], {
    env: { ...process.env, WEB_PORT: "0", TRUST_PROXY: "false", API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
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
});

after(async () => {
  if (web && web.exitCode === null) {
    web.kill("SIGTERM");
    await once(web, "exit");
  }
  api.closeAllConnections();
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

test("new sources leave both full-text permissions disabled until explicitly selected", async () => {
  const response = await fetch(`${origin}/admin/sources/new`);
  assert.equal(response.status, 200);
  const { document } = parseHTML(await response.text());
  const labels = [...document.querySelectorAll("label")];
  for (const field of ["站内可展示全文", "对外接口可带全文"]) {
    const checkbox = labels.find((label) => label.textContent?.includes(field))?.querySelector('input[type="checkbox"]');
    assert.ok(checkbox, `missing full-text permission ${field}`);
    assert.equal(checkbox.hasAttribute("checked"), false, field);
  }
});
