import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { extractFiles } from './tar.js';

export interface PlatformRelease {
  target: string;
  archiveSha256: string;
  binarySha256: string;
}

export interface Release {
  repo: string;
  tag: string;
  version: string;
  minVersion: string;
  platforms: Record<string, PlatformRelease>;
}

export class ChecksumError extends Error {}
export class DownloadError extends Error {}

export type FetchFn = (url: string, init: { redirect: 'manual'; signal: AbortSignal }) => Promise<Response>;

export interface DownloadOptions {
  fetch: FetchFn;
  cacheRoot: string;
  timeoutMs: number;
  maxBytes: number;
  log(message: string): void;
  hashFile(path: string): Promise<string>;
}

const MAX_REDIRECTS = 5;
const MAX_SUMS_BYTES = 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => hash.update(c))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

export function parseSha256Sums(text: string, filename: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *]?(.+)$/.exec(line.trim());
    if (m && m[2] === filename) return m[1].toLowerCase();
  }
  return undefined;
}

export function cliPath(cacheRoot: string, release: Release, pinned: PlatformRelease): string {
  return join(cacheRoot, 'tmgr-notify', 'cli', release.version, pinned.target, 'tmgr');
}

const releaseTagUrl = (r: Release) => `https://github.com/${r.repo}/releases/tag/${r.tag}`;

function downloadHint(r: Release): string {
  return (
    `Install the tmgr CLI from ${releaseTagUrl(r)} and put it on PATH, or set TMGR_BIN. ` +
    'Node does not use HTTPS_PROXY, so behind a proxy install tmgr yourself or set TMGR_BIN.'
  );
}

async function readCapped(res: Response, url: string, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > max) {
    await res.body?.cancel();
    throw new Error(`response from ${url} is too large`);
  }
  if (!res.body) throw new Error(`empty response from ${url}`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > max) {
      throw new Error(`response from ${url} is too large`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function get(url: string, opts: DownloadOptions, signal: AbortSignal, max: number): Promise<Buffer> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (new URL(current).protocol !== 'https:') throw new Error(`refusing non-https URL ${current}`);
    const res = await opts.fetch(current, { redirect: 'manual', signal });
    if (REDIRECTS.has(res.status)) {
      const location = res.headers.get('location');
      await res.body?.cancel();
      if (!location) throw new Error(`redirect without location from ${current}`);
      current = new URL(location, current).href;
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`HTTP ${res.status} from ${current}`);
    }
    return readCapped(res, current, max);
  }
  throw new Error(`too many redirects fetching ${url}`);
}

async function fetchVerified(release: Release, pinned: PlatformRelease, opts: DownloadOptions): Promise<Buffer> {
  const signal = AbortSignal.timeout(opts.timeoutMs);
  const archive = `tmgr-${release.version}-${pinned.target}.tar.gz`;
  const base = `https://github.com/${release.repo}/releases/download/${release.tag}`;
  const want = pinned.archiveSha256.toLowerCase();

  let data: Buffer;
  let sums: string;
  try {
    data = await get(`${base}/${archive}`, opts, signal, opts.maxBytes);
    sums = (await get(`${base}/SHA256SUMS`, opts, signal, MAX_SUMS_BYTES)).toString('utf8');
  } catch (err) {
    throw new DownloadError(
      `Could not download tmgr ${release.version}: ${err instanceof Error ? err.message : String(err)}. ${downloadHint(release)}`,
    );
  }

  const actual = sha256Hex(data);
  if (actual !== want) throw new ChecksumError(`${archive} failed the SHA-256 check (expected ${want}, got ${actual})`);
  const listed = parseSha256Sums(sums, archive);
  if (listed !== want) throw new ChecksumError(`SHA256SUMS ${listed ? 'disagrees with the pinned hash' : 'has no entry'} for ${archive}`);

  const name = `tmgr-${release.version}-${pinned.target}/tmgr`;
  let binary: Buffer;
  try {
    binary = extractFiles(gunzipSync(data, { maxOutputLength: opts.maxBytes * 4 }), [name]).get(name) as Buffer;
  } catch (err) {
    throw new DownloadError(`Bad tmgr archive: ${err instanceof Error ? err.message : String(err)}. ${downloadHint(release)}`);
  }
  const binActual = sha256Hex(binary);
  if (binActual !== pinned.binarySha256.toLowerCase()) {
    throw new ChecksumError(`${name} failed the SHA-256 check (expected ${pinned.binarySha256}, got ${binActual})`);
  }
  return binary;
}

async function install(binary: Buffer, finalPath: string): Promise<void> {
  const dir = dirname(finalPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.tmgr.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const fh = await open(tmp, 'wx', 0o600);
    try {
      await fh.writeFile(binary);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await chmod(tmp, 0o755);
    await rename(tmp, finalPath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

async function hashIfPresent(path: string, opts: DownloadOptions): Promise<string | undefined> {
  try {
    return await opts.hashFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export async function ensureCli(release: Release, pinned: PlatformRelease, opts: DownloadOptions): Promise<string> {
  const path = cliPath(opts.cacheRoot, release, pinned);
  const want = pinned.binarySha256.toLowerCase();
  if ((await hashIfPresent(path, opts)) === want) return path;

  opts.log(`downloading tmgr ${release.version} for ${pinned.target} (first run)`);
  await install(await fetchVerified(release, pinned, opts), path);
  const actual = await hashIfPresent(path, opts);
  if (actual !== want) {
    throw new ChecksumError(`${path} failed the SHA-256 check after install, refusing to run it (expected ${want}, got ${actual ?? 'nothing'})`);
  }
  return path;
}
