import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  ChecksumError,
  DownloadError,
  cliPath,
  ensureCli,
  hashFile,
  parseSha256Sums,
  redactUrl,
  sha256Hex,
  type DownloadOptions,
  type FetchFn,
  type Release,
} from '../src/download.js';
import { makeTar } from './tar-helper.js';

const root = mkdtempSync(join(tmpdir(), 'tmgr-notify-dl-'));
const BIN = Buffer.from('#!/bin/sh\necho tmgr\n');
const DIR = 'tmgr-1.0.1-t';
const ARCHIVE = 'tmgr-1.0.1-t.tar.gz';
const TGZ = gzipSync(makeTar([{ name: `${DIR}/tmgr`, data: BIN }]));
const BASE = 'https://github.com/o/r/releases/download/cli-v1.0.1';

function release(over: Partial<{ archiveSha256: string; binarySha256: string }> = {}): Release {
  return {
    repo: 'o/r',
    tag: 'cli-v1.0.1',
    version: '1.0.1',
    minVersion: '1.0.1',
    platforms: { k: { target: 't', archiveSha256: sha256Hex(TGZ), binarySha256: sha256Hex(BIN), ...over } },
  };
}

const sums = (hash = sha256Hex(TGZ)) => Buffer.from(`${hash}  ${ARCHIVE}\n`);

function server(routes: Record<string, () => Response>): { fetch: FetchFn; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url) => {
      calls.push(url);
      const route = routes[url];
      if (!route) throw new Error(`unexpected ${url}`);
      return route();
    },
  };
}

const ok = (body: Buffer, headers: Record<string, string> = {}) => () => new Response(body, { headers });
const good = () => ({ [`${BASE}/${ARCHIVE}`]: ok(TGZ), [`${BASE}/SHA256SUMS`]: ok(sums()) });

function opts(fetchFn: FetchFn, over: Partial<DownloadOptions> = {}): DownloadOptions {
  return {
    fetch: fetchFn,
    cacheRoot: mkdtempSync(join(root, 'cache-')),
    timeoutMs: 5000,
    maxBytes: 1024 * 1024,
    log: () => {},
    hashFile,
    ...over,
  };
}

function assertClean(o: DownloadOptions, rel: Release, expectFile: boolean): void {
  const path = cliPath(o.cacheRoot, rel, rel.platforms.k);
  let names: string[] = [];
  try {
    names = readdirSync(dirname(path));
  } catch {
    // dir may not exist
  }
  assert.deepEqual(names, expectFile ? ['tmgr'] : []);
}

test('downloads, verifies and installs atomically with mode 0755', async () => {
  const rel = release();
  const s = server(good());
  const logs: string[] = [];
  const o = opts(s.fetch, { log: (m) => logs.push(m) });
  const path = await ensureCli(rel, rel.platforms.k, o);
  assert.equal(path, cliPath(o.cacheRoot, rel, rel.platforms.k));
  assert.deepEqual(readFileSync(path), BIN);
  assert.equal(statSync(path).mode & 0o777, 0o755);
  assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
  assert.deepEqual(logs, ['downloading tmgr 1.0.1 for t (first run)']);
  assertClean(o, rel, true);
});

test('archive hash mismatch fails with nothing left behind', async () => {
  const rel = release({ archiveSha256: 'b'.repeat(64) });
  const o = opts(server(good()).fetch);
  await assert.rejects(ensureCli(rel, rel.platforms.k, o), ChecksumError);
  assertClean(o, rel, false);
});

test('binary hash mismatch fails with nothing left behind', async () => {
  const rel = release({ binarySha256: 'c'.repeat(64) });
  const o = opts(server(good()).fetch);
  await assert.rejects(ensureCli(rel, rel.platforms.k, o), ChecksumError);
  assertClean(o, rel, false);
});

test('SHA256SUMS disagreement or missing entry fails', async () => {
  for (const body of [sums('d'.repeat(64)), Buffer.from(`${sha256Hex(TGZ)}  other.tar.gz\n`)]) {
    const rel = release();
    const o = opts(server({ ...good(), [`${BASE}/SHA256SUMS`]: ok(body) }).fetch);
    await assert.rejects(ensureCli(rel, rel.platforms.k, o), ChecksumError);
    assertClean(o, rel, false);
  }
});

test('http redirect hop is rejected', async () => {
  const rel = release();
  const o = opts(
    server({
      ...good(),
      [`${BASE}/${ARCHIVE}`]: () => new Response(null, { status: 302, headers: { location: 'http://evil.test/a' } }),
    }).fetch,
  );
  await assert.rejects(ensureCli(rel, rel.platforms.k, o), (e: Error) => e instanceof DownloadError && /non-https/.test(e.message));
  assertClean(o, rel, false);
});

test('https redirects are followed up to 5 hops and no further', async () => {
  const chain = (n: number): Record<string, () => Response> => {
    const routes: Record<string, () => Response> = { ...good() };
    let from = `${BASE}/${ARCHIVE}`;
    for (let i = 1; i <= n; i++) {
      const to = `https://cdn.test/${i}`;
      routes[from] = () => new Response(null, { status: 302, headers: { location: to } });
      from = to;
    }
    routes[from] = ok(TGZ);
    return routes;
  };
  const rel = release();
  const five = opts(server(chain(5)).fetch);
  assert.ok(await ensureCli(rel, rel.platforms.k, five));
  const six = opts(server(chain(6)).fetch);
  await assert.rejects(ensureCli(rel, rel.platforms.k, six), (e: Error) => e instanceof DownloadError && /redirects/.test(e.message));
  assertClean(six, rel, false);
});

test('oversize responses are rejected by content-length and by streamed size', async () => {
  const rel = release();
  const byHeader = opts(server({ ...good(), [`${BASE}/${ARCHIVE}`]: ok(TGZ, { 'content-length': '999999999' }) }).fetch);
  await assert.rejects(ensureCli(rel, rel.platforms.k, byHeader), /too large/);
  const streamed = opts(server(good()).fetch, { maxBytes: 10 });
  await assert.rejects(ensureCli(rel, rel.platforms.k, streamed), /too large/);
  assertClean(streamed, rel, false);
});

test('HTTP errors and offline fetch give a DownloadError with the install hint', async () => {
  const rel = release();
  const http = opts(server({ ...good(), [`${BASE}/${ARCHIVE}`]: () => new Response('no', { status: 404 }) }).fetch);
  await assert.rejects(ensureCli(rel, rel.platforms.k, http), /HTTP 404/);

  const offline = opts(async () => {
    throw new TypeError('fetch failed');
  });
  await assert.rejects(ensureCli(rel, rel.platforms.k, offline), (e: Error) => {
    assert.ok(e instanceof DownloadError);
    assert.match(e.message, /fetch failed/);
    assert.match(e.message, /TMGR_BIN/);
    assert.match(e.message, /releases\/tag\/cli-v1\.0\.1/);
    assert.match(e.message, /HTTPS_PROXY/);
    return true;
  });
  assertClean(offline, rel, false);
});

test('a valid cached binary is reused with no fetch and is hashed first', async () => {
  const rel = release();
  const s = server({});
  const hashed: string[] = [];
  const o = opts(s.fetch, {
    hashFile: (p) => {
      hashed.push(p);
      return hashFile(p);
    },
  });
  const path = cliPath(o.cacheRoot, rel, rel.platforms.k);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, BIN, { mode: 0o755 });
  assert.equal(await ensureCli(rel, rel.platforms.k, o), path);
  assert.deepEqual(s.calls, []);
  assert.deepEqual(hashed, [path]);
});

test('a corrupted cached binary is replaced by a verified download', async () => {
  const rel = release();
  const s = server(good());
  const o = opts(s.fetch);
  const path = cliPath(o.cacheRoot, rel, rel.platforms.k);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'tampered', { mode: 0o755 });
  await ensureCli(rel, rel.platforms.k, o);
  assert.deepEqual(readFileSync(path), BIN);
  assert.equal(s.calls.length, 2);
  assertClean(o, rel, true);
});

test('a corrupted cache stays untouched-or-replaced, never run, when the download fails', async () => {
  const rel = release();
  const o = opts(async () => {
    throw new TypeError('fetch failed');
  });
  const path = cliPath(o.cacheRoot, rel, rel.platforms.k);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'tampered');
  await assert.rejects(ensureCli(rel, rel.platforms.k, o), DownloadError);
});

test('concurrent ensures share one cache and leave exactly one file', async () => {
  const rel = release();
  const o = opts(server(good()).fetch);
  const results = await Promise.all([1, 2, 3, 4].map(() => ensureCli(rel, rel.platforms.k, o)));
  assert.equal(new Set(results).size, 1);
  assert.deepEqual(readFileSync(results[0]), BIN);
  assertClean(o, rel, true);
});

test('parseSha256Sums reads text and binary-mode lines', () => {
  const h = 'a'.repeat(64);
  assert.equal(parseSha256Sums(`${h}  x.tgz\n${'b'.repeat(64)} *y.tgz\n`, 'x.tgz'), h);
  assert.equal(parseSha256Sums(`${'b'.repeat(64)} *y.tgz\n`, 'y.tgz'), 'b'.repeat(64));
  assert.equal(parseSha256Sums(`${h}  x.tgz\n`, 'z.tgz'), undefined);
});

function cachedPath(o: DownloadOptions, rel: Release): string {
  const path = cliPath(o.cacheRoot, rel, rel.platforms.k);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return path;
}

test('a symlinked cached binary is refused even if its target is valid', async () => {
  const rel = release();
  const { fetch } = server(good());
  const o = opts(fetch);
  const target = join(o.cacheRoot, 'elsewhere');
  writeFileSync(target, BIN);
  symlinkSync(target, cachedPath(o, rel));
  await assert.rejects(ensureCli(rel, rel.platforms.k, o), (err: NodeJS.ErrnoException) => err.code === 'ELOOP' || err.code === 'EMLINK');
});

test('a FIFO at the cache path is refused without hanging', async () => {
  const rel = release();
  const { fetch } = server(good());
  const o = opts(fetch);
  execFileSync('mkfifo', [cachedPath(o, rel)]);
  await assert.rejects(ensureCli(rel, rel.platforms.k, o), ChecksumError);
});

test('a cache dir writable by others is refused', async () => {
  const rel = release();
  const { fetch } = server(good());
  const o = opts(fetch);
  const path = cachedPath(o, rel);
  writeFileSync(path, BIN, { mode: 0o755 });
  chmodSync(dirname(path), 0o777);
  await assert.rejects(ensureCli(rel, rel.platforms.k, o), ChecksumError);
});

test('redactUrl drops query strings and credentials', () => {
  assert.equal(redactUrl('https://u:p@objects.example.com/a/b?sig=secret#x'), 'https://objects.example.com/a/b');
});
