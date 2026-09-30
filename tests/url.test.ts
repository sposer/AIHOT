// The fetch guard: internal addresses stay unreachable in every spelling, and a name that resolves
// to one is refused at connect time too (DNS rebinding after the URL check).
import assert from "node:assert/strict";
import http from "node:http";
import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import { after, test } from "node:test";
import { Agent, fetch as undiciFetch } from "undici";
import { config } from "@aihot/backend/config";
import { createFetchTrace, guardedFetch, RequestNotSentError, summarizeFetchTrace, withFetchTrace } from "@aihot/backend/lib/http-fetch";
import { assertPublicUrl, guardedLookup, isBlockedAddress, isInternalAddress } from "@aihot/backend/lib/url";

const server = http.createServer((_req, res) => res.end("internal"));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const { port } = server.address() as { port: number };
const agent = new Agent({ connect: { lookup: guardedLookup as never } });
after(async () => {
  server.close();
  await agent.close();
});

test("internal and reserved addresses are blocked in every spelling", () => {
  const blocked = [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "255.255.255.255",
    "::1", "::", "fd00::1", "fe80::1", "ff02::1", "2001:db8::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a00:1", "::ffff:a9fe:a9fe", "::7f00:1", // IPv4-mapped and -compatible
    "64:ff9b::7f00:1", "64:ff9b:1::1", "2002:7f00:1::1", "2001:0:4136:e378::1", // NAT64, 6to4, Teredo
    "not-an-ip",
  ];
  const allowed = ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"];
  assert.deepEqual(blocked.filter((a) => !isBlockedAddress(a)), [], "not blocked");
  assert.deepEqual(allowed.filter((a) => isBlockedAddress(a)), [], "wrongly blocked");
});

test("URL literals that embed a loopback address are refused before any request", async () => {
  for (const url of ["http://[::ffff:127.0.0.1]/", "http://[::127.0.0.1]/", "http://[64:ff9b::127.0.0.1]/", "http://localhost/"]) {
    await assert.rejects(assertPublicUrl(url), Error, url);
  }
  await assert.rejects(guardedFetch(`http://[::ffff:127.0.0.1]:${port}/`));
});

test("a name resolving to an internal address is refused at connect time", async () => {
  await assert.rejects(undiciFetch(`http://localhost:${port}/`, { dispatcher: agent }));
});

test("through the egress proxy only internal answers refuse a name; literals keep the full check", async () => {
  // The proxy resolves and connects abroad: a poisoned local answer (Teredo, documentation, reserved)
  // must not refuse a blocked site, while anything that reaches this host or its network still does.
  const internal = ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:a00:1", "64:ff9b::7f00:1", "64:ff9b:1::1", "2002:a9fe:a9fe::1"];
  const unroutable = ["2001::58bf:f9b6", "2001:db8::1", "255.255.255.255", "224.0.0.1", "192.0.2.1", "8.8.8.8", "2606:4700:4700::1111"];
  assert.deepEqual(internal.filter((a) => !isInternalAddress(a)), [], "internal not recognised");
  assert.deepEqual(unroutable.filter((a) => isInternalAddress(a)), [], "wrongly internal");
  for (const url of ["http://localhost/", "http://[::ffff:127.0.0.1]/", "http://[2001:db8::1]/", "http://10.0.0.1/"]) {
    await assert.rejects(assertPublicUrl(url, false, true), Error, url);
  }
});

test("DNS failures and timeouts keep their target, route and duration before any dispatch", async (t) => {
  const saved = { allowPrivate: config.allowPrivateNetworkFetch, proxy: config.egressProxyUrl };
  let scenario = "failure";
  config.allowPrivateNetworkFetch = false;
  config.egressProxyUrl = null;
  t.mock.method(dns, "lookup", async () => {
    if (scenario === "failure") throw Object.assign(new Error("DNS unavailable"), { code: "EAI_AGAIN" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    return [{ address: "8.8.8.8", family: 4 }];
  });
  syncBuiltinESMExports();
  try {
    for (const mode of ["failure", "timeout"]) {
      scenario = mode;
      const trace = createFetchTrace();
      await assert.rejects(
        withFetchTrace(trace, () => guardedFetch("https://review.example/feed", { timeoutMs: 30, route: "direct" })),
        RequestNotSentError,
      );
      const summary = summarizeFetchTrace(trace)!;
      assert.equal(summary.requests, 1);
      assert.deepEqual(summary.origins.map(({ host, origin, route, proxied }) => ({ host, origin, route, proxied })), [
        { host: "review.example", origin: "https://review.example", route: "direct", proxied: false },
      ]);
      assert.deepEqual([trace[0]!.status, summary.bytes], [null, 0]);
      assert.equal(summary.errors[mode === "failure" ? "EAI_AGAIN" : "TimeoutError"], 1);
      if (mode === "timeout") assert.ok(summary.elapsedMs >= 20);
    }
  } finally {
    config.allowPrivateNetworkFetch = saved.allowPrivate;
    config.egressProxyUrl = saved.proxy;
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
