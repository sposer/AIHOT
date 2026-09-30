// The source administration save boundary: defaults, explicit full-text permission and MP config.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSource, updateSource } from "@aihot/backend/admin/sources";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { UnsupportedConfig } from "@aihot/backend/sources/config-keys";

const T = tag();
after(async () => {
  await stopBoss();
  await closeDb();
});

test("a new MP source saves ghid and nickname with full text off, and an explicit permission remains enabled", async (t) => {
  const id = `test-admin-mp-${T}`;
  const config = { ghid: `gh_${T}`, nickname: "Local test account" };
  const result = await createSource({ id, name: "Local MP", kind: "mp_account", config, participation_mode: "isolated" }, "test");
  assert.equal(result.created, true);
  const [created] = await sql<{ config: Record<string, unknown>; site_fulltext: boolean; syndicate_fulltext: boolean; updated_at: Date }[]>`
    SELECT config, site_fulltext, syndicate_fulltext, updated_at FROM sources WHERE id = ${id}`;
  assert.deepEqual(created!.config, config);
  assert.deepEqual([created!.site_fulltext, created!.syndicate_fulltext], [false, false]);
  await updateSource(id, { patch: { site_fulltext: true }, version: created!.updated_at.toISOString() }, "test");
  const [saved] = await sql<{ site_fulltext: boolean; syndicate_fulltext: boolean }[]>`
    SELECT site_fulltext, syndicate_fulltext FROM sources WHERE id = ${id}`;
  assert.deepEqual([saved!.site_fulltext, saved!.syndicate_fulltext], [true, false]);
  t.diagnostic(`MP saved config keys=${Object.keys(created!.config).sort().join(",")}; full text default=${created!.site_fulltext}, explicit save=${saved!.site_fulltext}`);
});

test("MP creation rejects unknown configuration at the save boundary without inserting a source", async () => {
  const id = `test-admin-invalid-${T}`;
  await assert.rejects(
    createSource({ id, name: "Invalid MP", kind: "mp_account", config: { ghid: `gh_${T}`, nickname: "Test", unexpected: true } }, "test"),
    UnsupportedConfig,
  );
  const rows = await sql`SELECT id FROM sources WHERE id = ${id}`;
  assert.equal(rows.length, 0);
});
