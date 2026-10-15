import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import {
  buildPlatform,
  type CliRelease,
  type FetchFn,
  parseSha256Sums,
  platformPackageJson,
  sha256Hex,
} from "../tools/build-platform-packages.js";
import { makeTar } from "./tools-tar-helper.js";

const binary = Buffer.from("fake-binary");
const dir = "tmgr-1.0.1-aarch64-apple-darwin";
const archive = gzipSync(
  makeTar([
    { name: `${dir}/tmgr`, data: binary },
    { name: `${dir}/LICENSE`, data: Buffer.from("AGPL") },
  ]),
);
const archiveFile = `${dir}.tar.gz`;

function release(overrides: { archive?: string; binary?: string } = {}): CliRelease {
  return {
    repo: "tmgr-dev/frontend",
    tag: "cli-v1.0.1",
    version: "1.0.1",
    platforms: {
      "darwin-arm64": {
        target: "aarch64-apple-darwin",
        os: "darwin",
        cpu: "arm64",
        archiveSha256: overrides.archive ?? sha256Hex(archive),
        binarySha256: overrides.binary ?? sha256Hex(binary),
      },
    },
  };
}

function fakeFetch(sumsHash: string): FetchFn {
  return async (url) => {
    const body = url.endsWith("SHA256SUMS")
      ? Buffer.from(`${sumsHash}  ${archiveFile}\n`)
      : archive;
    return new Response(body);
  };
}

async function build(rel: CliRelease, fetchFn: FetchFn): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), "tools-build-"));
  return buildPlatform({ key: "darwin-arm64", release: rel, packageVersion: "1.0.0", outDir, fetchFn });
}

test("builds a verified package", async () => {
  const pkgDir = await build(release(), fakeFetch(sha256Hex(archive)));
  assert.deepEqual(await readFile(join(pkgDir, "bin", "tmgr")), binary);
  assert.equal((await stat(join(pkgDir, "bin", "tmgr"))).mode & 0o777, 0o755);
  assert.equal(await readFile(join(pkgDir, "LICENSE"), "utf8"), "AGPL");
  const pkg = JSON.parse(await readFile(join(pkgDir, "package.json"), "utf8"));
  assert.equal(pkg.name, "@tmgr/notify-darwin-arm64");
  assert.equal(pkg.version, "1.0.0");
  assert.deepEqual(pkg.os, ["darwin"]);
  assert.deepEqual(pkg.cpu, ["arm64"]);
  assert.equal(pkg.license, "AGPL-3.0-only");
  assert.deepEqual(pkg.files, ["bin/tmgr", "LICENSE", "README.md"]);
  assert.match(await readFile(join(pkgDir, "README.md"), "utf8"), /crates\/tmgr-cli/);
});

test("archive hash mismatch throws and writes nothing", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "tools-build-"));
  const rel = release({ archive: "a".repeat(64) });
  await assert.rejects(
    buildPlatform({ key: "darwin-arm64", release: rel, packageVersion: "1.0.0", outDir, fetchFn: fakeFetch("a".repeat(64)) }),
    /sha256 mismatch/,
  );
  await assert.rejects(stat(join(outDir, "darwin-arm64")));
});

test("SHA256SUMS mismatch throws", async () => {
  await assert.rejects(build(release(), fakeFetch("b".repeat(64))), /SHA256SUMS/);
});

test("binary hash mismatch throws", async () => {
  const rel = release({ binary: "c".repeat(64) });
  await assert.rejects(build(rel, fakeFetch(sha256Hex(archive))), /sha256 mismatch/);
});

test("non-https redirect is rejected", async () => {
  const fetchFn: FetchFn = async () => {
    const res = new Response("x");
    Object.defineProperty(res, "url", { value: "http://example.com/x" });
    return res;
  };
  await assert.rejects(build(release(), fetchFn), /non-https/);
});

test("oversized response is rejected", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "tools-build-"));
  await assert.rejects(
    buildPlatform({ key: "darwin-arm64", release: release(), packageVersion: "1.0.0", outDir, fetchFn: fakeFetch(sha256Hex(archive)), maxBytes: 10 }),
    /too large/,
  );
});

test("parseSha256Sums finds the named file", () => {
  const h = "d".repeat(64);
  assert.equal(parseSha256Sums(`${h}  a.tar.gz\n${"e".repeat(64)} *b.tar.gz\n`, "a.tar.gz"), h);
  assert.equal(parseSha256Sums(`${h}  a.tar.gz\n`, "b.tar.gz"), undefined);
});

test("platformPackageJson fields", () => {
  const rel = release();
  const pkg = platformPackageJson("darwin-arm64", rel.platforms["darwin-arm64"], rel, "1.0.0");
  assert.equal(pkg.name, "@tmgr/notify-darwin-arm64");
  assert.equal(pkg.homepage, "https://github.com/tmgr-dev/frontend/releases/tag/cli-v1.0.1");
});
