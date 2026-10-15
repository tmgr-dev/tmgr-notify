import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { extractFiles } from "./tar.js";

export interface PlatformEntry {
  target: string;
  os: string;
  cpu: string;
  archiveSha256: string;
  binarySha256: string;
}

export interface CliRelease {
  repo: string;
  tag: string;
  version: string;
  platforms: Record<string, PlatformEntry>;
}

export type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface BuildOptions {
  key: string;
  release: CliRelease;
  packageVersion: string;
  outDir: string;
  fetchFn?: FetchFn;
  maxBytes?: number;
  timeoutMs?: number;
}

const MAX_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function assertSha256(label: string, data: Buffer, expected: string): void {
  const actual = sha256Hex(data);
  if (actual !== expected.toLowerCase()) {
    throw new Error(`${label}: sha256 mismatch (expected ${expected}, got ${actual})`);
  }
}

export function parseSha256Sums(text: string, filename: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64}) [ *]?(.+)$/.exec(line.trim());
    if (match && match[2] === filename) return match[1].toLowerCase();
  }
  return undefined;
}

export function archiveName(release: CliRelease, entry: PlatformEntry): string {
  return `tmgr-${release.version}-${entry.target}.tar.gz`;
}

export function releaseUrl(release: CliRelease, file: string): string {
  return `https://github.com/${release.repo}/releases/download/${release.tag}/${file}`;
}

export function platformPackageJson(
  key: string,
  entry: PlatformEntry,
  release: CliRelease,
  packageVersion: string,
): Record<string, unknown> {
  return {
    name: `@tmgr/notify-${key}`,
    version: packageVersion,
    description: `Prebuilt tmgr ${release.version} binary for ${entry.target}, used by @tmgr/notify`,
    license: "AGPL-3.0-only",
    repository: {
      type: "git",
      url: "git+https://github.com/tmgr-dev/frontend.git",
      directory: "crates/tmgr-cli",
    },
    homepage: `https://github.com/${release.repo}/releases/tag/${release.tag}`,
    os: [entry.os],
    cpu: [entry.cpu],
    files: ["bin/tmgr", "LICENSE", "README.md"],
    publishConfig: { access: "public" },
  };
}

export function platformReadme(key: string, entry: PlatformEntry, release: CliRelease): string {
  return `# @tmgr/notify-${key}

This package carries the prebuilt \`tmgr\` ${release.version} binary for ${entry.target}, used by @tmgr/notify.

Licensed AGPL-3.0-only.

- Source: https://github.com/${release.repo}/tree/${release.tag}/crates/tmgr-cli
- Release: https://github.com/${release.repo}/releases/tag/${release.tag}
`;
}

export async function fetchBuffer(
  url: string,
  fetchFn: FetchFn,
  maxBytes: number,
  timeoutMs: number,
): Promise<Buffer> {
  if (new URL(url).protocol !== "https:") throw new Error(`refusing non-https url ${url}`);
  const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (res.url && new URL(res.url).protocol !== "https:") {
    throw new Error(`redirected to non-https url ${res.url}`);
  }
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new Error(`GET ${url}: response too large`);
  if (!res.body) throw new Error(`GET ${url}: empty body`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`GET ${url}: response too large`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function buildPlatform(options: BuildOptions): Promise<string> {
  const { key, release, packageVersion, outDir } = options;
  const entry = release.platforms[key];
  if (!entry) throw new Error(`unknown platform ${key}`);
  const fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const file = archiveName(release, entry);

  const sums = (
    await fetchBuffer(releaseUrl(release, "SHA256SUMS"), fetchFn, maxBytes, timeoutMs)
  ).toString("utf8");
  const listed = parseSha256Sums(sums, file);
  if (listed !== entry.archiveSha256.toLowerCase()) {
    throw new Error(`SHA256SUMS entry for ${file} does not match pinned hash`);
  }

  const archive = await fetchBuffer(releaseUrl(release, file), fetchFn, maxBytes, timeoutMs);
  assertSha256(file, archive, entry.archiveSha256);

  const dir = `tmgr-${release.version}-${entry.target}`;
  const files = extractFiles(gunzipSync(archive, { maxOutputLength: maxBytes * 4 }), [
    `${dir}/tmgr`,
    `${dir}/LICENSE`,
  ]);
  const binary = files.get(`${dir}/tmgr`) as Buffer;
  assertSha256(`${dir}/tmgr`, binary, entry.binarySha256);

  const pkgDir = resolve(outDir, key);
  await mkdir(join(pkgDir, "bin"), { recursive: true });
  const binPath = join(pkgDir, "bin", "tmgr");
  await writeFile(binPath, binary, { mode: 0o755 });
  await chmod(binPath, 0o755);
  await writeFile(join(pkgDir, "LICENSE"), files.get(`${dir}/LICENSE`) as Buffer);
  await writeFile(join(pkgDir, "README.md"), platformReadme(key, entry, release));
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify(platformPackageJson(key, entry, release, packageVersion), null, 2) + "\n",
  );
  return pkgDir;
}

export async function loadInputs(): Promise<{ release: CliRelease; packageVersion: string }> {
  const root = new URL("../../", import.meta.url);
  const release = JSON.parse(
    await readFile(fileURLToPath(new URL("cli-release.json", root)), "utf8"),
  ) as CliRelease;
  const pkg = JSON.parse(await readFile(fileURLToPath(new URL("package.json", root)), "utf8")) as {
    version: string;
  };
  return { release, packageVersion: pkg.version };
}

function parseArgs(argv: string[]): { out: string; only?: string } {
  let out = "dist-npm";
  let only: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = argv[++i];
    else if (argv[i] === "--only") only = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!out) throw new Error("--out needs a value");
  return { out, only };
}

async function main(): Promise<void> {
  const { out, only } = parseArgs(process.argv.slice(2));
  const { release, packageVersion } = await loadInputs();
  const keys = only ? [only] : Object.keys(release.platforms);
  for (const key of keys) {
    const dir = await buildPlatform({ key, release, packageVersion, outDir: out });
    console.log(`built ${key} -> ${dir}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
