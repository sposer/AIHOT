// Presentation presets use the existing vocabulary; this suite needs no database or environment file.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CATEGORY_TAGS, ENTITY_TAGS, TOPIC_TAGS } from "@aihot/industry/taxonomy";
import { CATEGORY_KEYS, DOMAIN_KEYS, feedColumns, isCategoryKey, isChannelKey } from "@aihot/contracts/taxonomy";

test("overview and AI columns retain the existing category identities", () => {
  assert.deepEqual(CATEGORY_KEYS, ["ai-models", "ai-products", "industry", "paper", "tip", "opinion"]);
  assert.deepEqual(feedColumns(null).slice(2).map((column) => column.filters), CATEGORY_KEYS.map((category) => ({ category })));
  assert.deepEqual(feedColumns("ai"), feedColumns(null));
});

test("all scopes offer unfiltered and first-party columns", () => {
  for (const scope of [null, ...DOMAIN_KEYS]) {
    assert.deepEqual(feedColumns(scope).slice(0, 2).map(({ key, filters }) => ({ key, filters })), [
      { key: "all", filters: {} },
      { key: "firstParty", filters: { channel: "firstParty" } },
    ]);
  }
});

test("medical columns select professional tags without narrowing the content category", () => {
  assert.deepEqual(feedColumns("medical").slice(2).map((column) => column.filters), [
    { tag: "临床研究" },
    { tag: "药品" },
    { tag: "医疗器械" },
    { tag: "公共卫生" },
    { tag: "诊疗" },
    { tag: "政策/监管" },
  ]);
});

test("legal, military and policy columns combine their professional tags with research and opinion", () => {
  const tags = {
    legal: ["立法", "司法/案件", "执法", "权利保障", "政策/监管"],
    military: ["国防/战略", "军事行动", "军事装备"],
    policy: ["政策/监管", "政策实施", "公共治理"],
  };
  for (const scope of ["legal", "military", "policy"] as const) {
    assert.deepEqual(feedColumns(scope).slice(2).map((column) => column.filters), [
      ...tags[scope].map((tag) => ({ tag })),
      { category: "paper" },
      { category: "opinion" },
    ]);
  }
});

test("column identities are unique in their scope and filters use only the shared vocabulary", () => {
  const tags = new Set<string>([...CATEGORY_TAGS, ...TOPIC_TAGS, ...ENTITY_TAGS]);
  for (const scope of [null, ...DOMAIN_KEYS]) {
    const columns = feedColumns(scope);
    assert.equal(new Set(columns.map((column) => column.key)).size, columns.length);
    for (const { filters } of columns) {
      assert.ok(Object.keys(filters).every((key) => ["category", "tag", "channel"].includes(key)));
      if (filters.category !== undefined) assert.ok(isCategoryKey(filters.category));
      if (filters.channel !== undefined) assert.ok(isChannelKey(filters.channel));
      if (filters.tag !== undefined) assert.ok(tags.has(filters.tag));
    }
  }
});
