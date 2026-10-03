import assert from "node:assert/strict";
import { test } from "node:test";
import { domainHref, domainScope, switchDomainHref } from "@aihot/contracts/http-policy";

const params = (query = "") => new URLSearchParams(query);

test("content scope comes from its URL, including explicit overview editions", () => {
  for (const [path, query, expected] of [
    ["/", "", "all"], ["/", "domain=medical", "medical"],
    ["/all/legal", "domain=medical", "legal"],
    ["/daily/medical/archive", "", "medical"],
    ["/weekly/all/2026-W39", "domain=medical", "all"],
    ["/hot", "domain=military", "military"],
    ["/topics/topic/page/3", "domain=policy", "policy"],
    ["/story/story-id", "domain=medical", "medical"],
    ["/items/item-id", "domain=legal", "legal"],
    ["/more", "domain=all", "all"], ["/about", "", null],
  ] as const) assert.equal(domainScope(path, params(query)), expected);
});

test("scoped links use the existing path families and global object identities", () => {
  assert.equal(domainHref("/", "medical"), "/?domain=medical");
  assert.equal(domainHref("/all", "medical", params("tag=药品")), "/all/medical?tag=%E8%8D%AF%E5%93%81");
  assert.equal(domainHref("/hot", "medical"), "/hot?domain=medical");
  assert.equal(domainHref("/topics/topic", "medical"), "/topics/topic?domain=medical");
  assert.equal(domainHref("/daily", "medical"), "/daily/medical");
  assert.equal(domainHref("/daily/archive", "medical"), "/daily/medical/archive");
  assert.equal(domainHref("/monthly/all/2026-09", "medical"), "/monthly/medical/2026-09");
  assert.equal(domainHref("/items/item-id", "medical"), "/items/item-id?domain=medical");
  assert.equal(domainHref("/more", "all"), "/more?domain=all");
});

test("domain changes retain search and valid filters; same-scope selection keeps the current view", () => {
  const original = params("q=trial&tab=relevance&category=paper&tag=临床研究&channel=firstParty&page=3&cursor=old");
  assert.equal(switchDomainHref("/all/medical", original, "medical"), `/all/medical?${original}`);
  const target = new URL(switchDomainHref("/all/medical", original, "legal"), "http://local");
  assert.equal(target.pathname, "/all/legal");
  assert.deepEqual(Object.fromEntries(target.searchParams), { q: "trial", tab: "relevance", category: "paper", channel: "firstParty" });
  assert.equal(original.get("page"), "3");
  assert.equal(original.get("tag"), "临床研究");
  const shared = new URL(switchDomainHref("/all/medical", params("tag=政策/监管&channel=firstParty"), "policy"), "http://local");
  assert.deepEqual(Object.fromEntries(shared.searchParams), { tag: "政策/监管", channel: "firstParty" });
  const overview = new URL(switchDomainHref("/all/medical", params("category=paper&tag=custom&channel=news"), "all"), "http://local");
  assert.deepEqual(Object.fromEntries(overview.searchParams), { category: "paper", tag: "custom", channel: "news" });
});

test("topic paging resets, reports open the target latest issue, and archives keep their role", () => {
  assert.equal(switchDomainHref("/topics/topic/page/3", params("domain=medical"), "medical"), "/topics/topic/page/3?domain=medical");
  assert.equal(switchDomainHref("/weekly/medical/2026-W39", params(), "medical"), "/weekly/medical/2026-W39");
  assert.equal(switchDomainHref("/topics/topic/page/3", params("domain=medical"), "legal"), "/topics/topic?domain=legal");
  assert.equal(switchDomainHref("/weekly/all/2026-W39", params(), "medical"), "/weekly/medical");
  assert.equal(switchDomainHref("/daily/medical/archive", params(), "all"), "/daily/archive");
  assert.equal(switchDomainHref("/story/story-id", params("domain=medical&tag=临床研究&page=2"), "legal"), "/story/story-id?domain=legal");
  assert.equal(switchDomainHref("/more", params(), "medical"), "/more?domain=medical");
});
