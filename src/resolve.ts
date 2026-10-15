import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, chmodSync, constants, createReadStream, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

export interface PlatformRelease {
  binarySha256: string;
}

export interface Release {
  repo: string;
  tag: string;
  version: string;
  minVersion: string;
  platforms: Record<string, PlatformRelease>;
}

export type BinarySource = 'TMGR_BIN' | 'PATH' | 'package';

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
  mode(path: string): number;
  chmod(path: string, mode: number): void;
  versionOutput(path: string): string | undefined;
  packageDir(pkg: string): string | undefined;
  sha256(path: string): Promise<string>;
  debug(message: string): void;
}

export class UnsupportedPlatformError extends Error {}
export class MissingBinaryError extends Error {}
export class ChecksumError extends Error {}
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

  const dir = deps.packageDir(`@tmgr/notify-${key}`);
  if (!dir) {
    throw new MissingBinaryError(
      `The platform package @tmgr/notify-${key} is not installed (probably installed with --omit=optional or --no-optional). ` +
        `Reinstall @tmgr/notify with optional dependencies, install the tmgr CLI from ${releaseUrl}, or set TMGR_BIN.`,
    );
  }
  const path = join(dir, 'bin', 'tmgr');
  if (!deps.isFile(path)) {
    throw new MissingBinaryError(`The platform package @tmgr/notify-${key} has no bin/tmgr. Reinstall @tmgr/notify or set TMGR_BIN.`);
  }

  const actual = await deps.sha256(path);
  if (actual !== pinned.binarySha256) {
    throw new ChecksumError(`${path} failed the SHA-256 check, refusing to run it (expected ${pinned.binarySha256}, got ${actual})`);
  }
  if ((deps.mode(path) & 0o111) === 0) deps.chmod(path, 0o755);
  return { path, source: 'package' };
}

export function loadRelease(): Release {
  return JSON.parse(readFileSync(new URL('../../cli-release.json', import.meta.url), 'utf8')) as Release;
}

export function defaultDeps(env: NodeJS.ProcessEnv = process.env): ResolveDeps {
  const require = createRequire(import.meta.url);
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
    mode: (p) => statSync(p).mode,
    chmod: (p, m) => chmodSync(p, m),
    versionOutput: (p) => {
      const r = spawnSync(p, ['--version'], { timeout: 3000, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
      return r.error || r.status !== 0 ? undefined : r.stdout;
    },
    packageDir: (pkg) => {
      try {
        return dirname(require.resolve(`${pkg}/package.json`));
      } catch {
        return undefined;
      }
    },
    sha256: (p) =>
      new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        createReadStream(p)
          .on('data', (c) => hash.update(c))
          .on('error', reject)
          .on('end', () => resolve(hash.digest('hex')));
      }),
    debug: (m) => {
      if (env.TMGR_NOTIFY_DEBUG) process.stderr.write(`tmgr-notify: ${m}\n`);
    },
  };
}
