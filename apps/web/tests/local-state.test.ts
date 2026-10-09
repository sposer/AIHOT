import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { getDomainPreference, KEYS, setDomainPreference } from "../app/lib/local-state.ts";
import { ENABLED_DOMAIN_KEYS, type DomainKey } from "@aihot/contracts/taxonomy";

const values = new Map<string, string>();
const original = Object.getOwnPropertyDescriptor(globalThis, "window");
before(() => Object.defineProperty(globalThis, "window", { configurable: true, value: {
  localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  },
} }));
after(() => {
  if (original) Object.defineProperty(globalThis, "window", original);
  else Reflect.deleteProperty(globalThis, "window");
});

test("navigation preference persists a configured domain or explicit overview without changing other reader data", () => {
  values.set(KEYS.theme, "dark");
  assert.equal(getDomainPreference(), null);
  setDomainPreference("medical");
  assert.equal(values.get(KEYS.domain), "medical");
  assert.equal(getDomainPreference(), "medical");
  setDomainPreference("all");
  assert.equal(getDomainPreference(), "all");
  assert.equal(values.get(KEYS.theme), "dark");
  values.set(KEYS.domain, "removed-domain");
  assert.equal(getDomainPreference(), null);
});

test("disabled preferences stay dormant and return when their configured identity is re-enabled", () => {
  const enabled = ENABLED_DOMAIN_KEYS as DomainKey[];
  const index = enabled.indexOf("medical");
  values.set(KEYS.domain, "medical");
  enabled.splice(index, 1);
  try {
    assert.equal(getDomainPreference(), null);
    assert.equal(values.get(KEYS.domain), "medical");
  } finally {
    enabled.splice(index, 0, "medical");
  }
  assert.equal(getDomainPreference(), "medical");
});

test("unavailable browser storage leaves navigation usable without a stored preference", () => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    get localStorage() { throw new Error("unavailable"); },
  } });
  assert.doesNotThrow(() => setDomainPreference("legal"));
  assert.equal(getDomainPreference(), null);
});
