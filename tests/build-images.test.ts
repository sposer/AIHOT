import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildImages } from "../scripts/build-images.ts";

function fixture(options: { failBuild?: boolean; cached?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "image-build-test-"));
  mkdirSync(path.join(root, "deploy"));
  for (const name of ["docker-compose.yml", ".env.example", "deploy/Caddyfile"]) writeFileSync(path.join(root, name), `public ${name}`);
  writeFileSync(path.join(root, ".env"), "private runtime config");
  writeFileSync(path.join(root, "Dockerfile"), "uncommitted work");
  const revision = "1234567890abcdef1234567890abcdef12345678ab";
  const calls: Array<{ command: string; args: string[] }> = [];
  let scratch = "";
  const run = (command: string, args: string[]) => {
    calls.push({ command, args });
    if (command === "git" && args[0] === "rev-parse") return revision;
    if (command === "git" && args[0] === "archive") {
      const archive = args.find((arg) => arg.startsWith("--output="))!.slice("--output=".length);
      scratch = path.dirname(archive);
      writeFileSync(archive, "commit archive");
    }
    if (command === "tar") writeFileSync(path.join(args[args.indexOf("-C") + 1]!, "Dockerfile"), "committed source");
    if (command === "docker" && args[0] === "compose") return JSON.stringify({ services: {
      db: { image: "postgres:17-alpine" }, caddy: { image: "caddy:2-alpine" },
    } });
    if (command === "docker" && args[0] === "build") {
      const source = args.at(-1)!;
      assert.equal(readFileSync(path.join(source, "Dockerfile"), "utf8"), "committed source");
      assert.equal(existsSync(path.join(source, ".env")), false);
      if (options.failBuild) throw new Error("build failed");
    }
    if (command === "docker" && args[0] === "image" && args[1] === "ls") return options.cached ? "cached image" : "";
    if (command === "docker" && args[0] === "image" && args[1] === "inspect") return "linux/amd64";
    return "";
  };
  return { root, revision, calls, run, scratch: () => scratch, clean: () => rmSync(root, { recursive: true, force: true }) };
}

test("build prepares committed application and original runtime images without publishing, transferring images or including local configuration", () => {
  const f = fixture();
  try {
    const result = buildImages({ repository: "registry.example/news", ref: "release", output: "release" }, f.root, f.run);
    assert.equal(result.revision, f.revision);
    assert.ok(f.calls.some(({ command, args }) => command === "git" && args[0] === "archive" && args.at(-1) === f.revision));
    assert.equal(f.calls.filter(({ command, args }) => command === "docker" && args[0] === "build").length, 1);
    assert.deepEqual(f.calls.filter(({ args }) => args[0] === "image" && args[1] === "pull").map(({ args }) => args.at(-1)), ["postgres:17-alpine", "caddy:2-alpine"]);
    assert.deepEqual(f.calls.filter(({ args }) => args[0] === "image" && args[1] === "tag").map(({ args }) => args.slice(-2)), [
      ["postgres:17-alpine", result.images.DB_IMAGE], ["caddy:2-alpine", result.images.CADDY_IMAGE],
    ]);
    assert.equal(f.calls.some(({ args }) => args.includes("push") || args.includes("--push") || args.includes("save") || args.includes("load")), false);
    assert.deepEqual(readdirSync(result.directory).sort(), [".env.example", "deploy", "docker-compose.yml", "images.env"]);
    const refs = Object.fromEntries(readFileSync(path.join(result.directory, "images.env"), "utf8").trim().split("\n").map((line) => line.split("=")));
    assert.deepEqual(refs, result.images);
    assert.equal(readFileSync(path.join(f.root, ".env"), "utf8"), "private runtime config");
    assert.equal(readFileSync(path.join(f.root, "Dockerfile"), "utf8"), "uncommitted work");
    assert.equal(existsSync(f.scratch()), false);
  } finally { f.clean(); }
});

test("cached runtime dependencies are retagged without pulling or rebuilding them", () => {
  const f = fixture({ cached: true });
  try {
    buildImages({ repository: "registry.example/news", output: "release" }, f.root, f.run);
    assert.equal(f.calls.some(({ args }) => args[0] === "image" && args[1] === "pull"), false);
    assert.equal(f.calls.filter(({ command, args }) => command === "docker" && args[0] === "build").length, 1);
  } finally { f.clean(); }
});

test("failed build removes source staging without producing deployment files", () => {
  const f = fixture({ failBuild: true });
  try {
    assert.throws(() => buildImages({ repository: "registry.example/news", output: "release" }, f.root, f.run));
    assert.equal(existsSync(path.join(f.root, "release")), false);
    assert.equal(existsSync(f.scratch()), false);
    assert.equal(readFileSync(path.join(f.root, ".env"), "utf8"), "private runtime config");
  } finally { f.clean(); }
});
