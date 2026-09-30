// Builds committed application code and prepares local runtime images for a separate publisher.
//   node scripts/build-images.ts --repository docker.heue.top/aihot [--ref HEAD] [--output directory]
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

interface BuildOptions {
  repository: string;
  ref?: string;
  platform?: string;
  output?: string;
}

type Execute = (command: string, args: string[], cwd: string, capture?: boolean) => string;

const execute: Execute = (command, args, cwd, capture = false) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? result.signal}${capture ? `: ${result.stderr}` : ""}`);
  return result.stdout ?? "";
};

export function buildImages(options: BuildOptions, root = path.resolve(import.meta.dirname, ".."), run: Execute = execute) {
  const revision = run("git", ["rev-parse", "--verify", `${options.ref ?? "HEAD"}^{commit}`], root, true).trim();
  const version = `${new Date().toISOString().slice(0, 19).replace(/[-:]/g, "")}Z-${revision.slice(0, 12)}`;
  const platform = options.platform ?? "linux/amd64";
  const directory = path.resolve(root, options.output ?? path.join(".data", "releases", version));
  const compose = JSON.parse(run("docker", ["compose", "-f", "docker-compose.yml", "--profile", "https", "config", "--format", "json"], root, true));
  const upstream = { DB_IMAGE: compose.services.db.image as string, CADDY_IMAGE: compose.services.caddy.image as string };
  const images = {
    APP_IMAGE: `${options.repository}/app:${version}`,
    DB_IMAGE: `${options.repository}/postgres:${version}`,
    CADDY_IMAGE: `${options.repository}/caddy:${version}`,
  };
  const scratch = mkdtempSync(path.join(tmpdir(), "myhot-images-"));
  let created = false;
  try {
    const source = path.join(scratch, "source");
    mkdirSync(source);
    // decision: archive the selected commit; not build the live checkout because image provenance
    // must identify the exact application source; revisit when uncommitted preview releases are needed.
    run("git", ["archive", "--format=tar", `--output=${path.join(scratch, "source.tar")}`, revision], root);
    run("tar", ["-xf", path.join(scratch, "source.tar"), "-C", source], root);
    run("docker", ["build", "--platform", platform, "--tag", images.APP_IMAGE,
      "--label", `org.opencontainers.image.revision=${revision}`, "--label", `org.opencontainers.image.version=${version}`, source], root);
    for (const key of ["DB_IMAGE", "CADDY_IMAGE"] as const) {
      const cached = run("docker", ["image", "ls", "--quiet", "--filter", `reference=${upstream[key]}`], root, true).trim();
      const cachedPlatform = cached ? run("docker", ["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", upstream[key]], root, true).trim() : "";
      if (cachedPlatform !== platform) run("docker", ["image", "pull", "--platform", platform, upstream[key]], root);
      run("docker", ["image", "tag", upstream[key], images[key]], root);
    }
    mkdirSync(path.dirname(directory), { recursive: true });
    mkdirSync(directory);
    created = true;
    writeFileSync(path.join(directory, "images.env"), Object.entries(images).map(([key, image]) => `${key}=${image}\n`).join(""));
    copyFileSync(path.join(root, "docker-compose.yml"), path.join(directory, "docker-compose.yml"));
    copyFileSync(path.join(root, ".env.example"), path.join(directory, ".env.example"));
    mkdirSync(path.join(directory, "deploy"));
    copyFileSync(path.join(root, "deploy", "Caddyfile"), path.join(directory, "deploy", "Caddyfile"));
    console.log(`application revision: ${revision}`);
    console.log(`deployment files: ${directory}`);
    return { revision, version, directory, images, upstream };
  } catch (error) {
    if (created) rmSync(directory, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      repository: { type: "string" }, ref: { type: "string" }, platform: { type: "string" }, output: { type: "string" },
    } });
    if (!values.repository) throw new Error("--repository <registry/namespace> is required");
    buildImages({ repository: values.repository, ref: values.ref, platform: values.platform, output: values.output });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
