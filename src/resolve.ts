import { spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { ensureCli, hashFile, type DownloadOptions, type PlatformRelease, type Release } from './download.js';

export { ChecksumError, DownloadError, type PlatformRelease, type Release } from './download.js';

export type BinarySource = 'TMGR_BIN' | 'PATH' | 'cache';

export interface ResolvedBinary {
  path: string;
  source: BinarySource;
}

export interface ResolveDeps {
  env: NodeJS.ProcessEnv;
  platform: string;
  arch: string;
  release: Release;
  isFile(path: string): boolean;
  isExecutable(path: string): boolean;
  versionOutput(path: string): string | undefined;
  ensureCli(release: Release, pinned: PlatformRelease): Promise<string>;
  debug(message: string): void;
}

export class UnsupportedPlatformError extends Error {}
export class BinaryOverrideError extends Error {}

const VERSION_RE = /^tmgr (\d+)\.(\d+)\.(\d+)(?:[-+]\S*)?\s*$/;

export function parseVersion(output: string | undefined): [number, number, number] | undefined {
  const m = VERSION_RE.exec((output ?? '').split('\n')[0]);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

function parseSemver(v: string): [number, number, number] {
  const [a = 0, b = 0, c = 0] = v.split('.').map(Number);
  return [a, b, c];
}

export function isCompatible(version: [number, number, number], min: string): boolean {
  if (version[0] >= 2) return false;
  const m = parseSemver(min);
  for (let i = 0; i < 3; i++) {
    if (version[i] !== m[i]) return version[i] > m[i];
  }
  return true;
}

function findOnPath(deps: ResolveDeps): string | undefined {
  for (const dir of (deps.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, 'tmgr');
    if (deps.isFile(candidate) && deps.isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export async function resolveBinary(deps: ResolveDeps): Promise<ResolvedBinary> {
  const override = deps.env.TMGR_BIN;
  if (override) {
    if (!deps.isFile(override)) {
      throw new BinaryOverrideError(`TMGR_BIN points to "${override}", which is not an existing file`);
    }
    return { path: override, source: 'TMGR_BIN' };
  }

  const onPath = findOnPath(deps);
  if (onPath) {
    const version = parseVersion(deps.versionOutput(onPath));
    if (version && isCompatible(version, deps.release.minVersion)) return { path: onPath, source: 'PATH' };
    deps.debug(`ignoring ${onPath}: unusable or incompatible version`);
  }

  const key = `${deps.platform}-${deps.arch}`;
  const pinned = deps.release.platforms[key];
  const releaseUrl = `https://github.com/${deps.release.repo}/releases/tag/${deps.release.tag}`;
  if (!pinned) {
    const hint = deps.platform === 'win32' ? 'Windows is not supported natively; use WSL2. ' : '';
    throw new UnsupportedPlatformError(
      `${hint}No tmgr binary for ${key}. Install the tmgr CLI (${releaseUrl}) and put it on PATH, or set TMGR_BIN.`,
    );
  }

  return { path: await deps.ensureCli(deps.release, pinned), source: 'cache' };
}

export function loadRelease(): Release {
  return JSON.parse(readFileSync(new URL('../../cli-release.json', import.meta.url), 'utf8')) as Release;
}

export function cacheRoot(env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_CACHE_HOME;
  return xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.cache');
}

export function defaultDeps(env: NodeJS.ProcessEnv = process.env): ResolveDeps {
  const download: DownloadOptions = {
    fetch: (url, init) => fetch(url, init),
    cacheRoot: cacheRoot(env),
    timeoutMs: 120_000,
    maxBytes: 64 * 1024 * 1024,
    log: (m) => process.stderr.write(`tmgr-notify: ${m}\n`),
    hashFile,
  };
  return {
    env,
    platform: process.platform,
    arch: process.arch,
    release: loadRelease(),
    isFile: (p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    },
    isExecutable: (p) => {
      try {
        accessSync(p, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    versionOutput: (p) => {
      const r = spawnSync(p, ['--version'], { timeout: 3000, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
      return r.error || r.status !== 0 ? undefined : r.stdout;
    },
    ensureCli: (release, pinned) => ensureCli(release, pinned, download),
    debug: (m) => {
      if (env.TMGR_NOTIFY_DEBUG) process.stderr.write(`tmgr-notify: ${m}\n`);
    },
  };
}
