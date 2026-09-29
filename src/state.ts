import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 200) || 'unknown';
}

export function getStateDir(): string {
  try {
    const dir = path.join(os.homedir(), '.cache', 'tmgr-notify');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    const dir = path.join(os.tmpdir(), 'tmgr-notify');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}

function statePath(sessionId: string, dir: string): string {
  return path.join(dir, `${sanitizeId(sessionId)}.json`);
}

export function recordPromptStart(sessionId: string, startedAt: number, dir: string = getStateDir()): void {
  fs.writeFileSync(statePath(sessionId, dir), JSON.stringify({ startedAt }));
}

export function readPromptStart(sessionId: string, dir: string = getStateDir()): number | undefined {
  try {
    const raw = fs.readFileSync(statePath(sessionId, dir), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.startedAt === 'number' ? parsed.startedAt : undefined;
  } catch {
    return undefined;
  }
}

export function consumePromptStart(sessionId: string, dir: string = getStateDir()): number | undefined {
  const value = readPromptStart(sessionId, dir);
  try {
    fs.unlinkSync(statePath(sessionId, dir));
  } catch {}
  return value;
}

export function cleanupOldEntries(
  dir: string = getStateDir(),
  maxAgeMs = 24 * 60 * 60 * 1000,
  now: number = Date.now()
): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs > maxAgeMs) fs.unlinkSync(full);
    } catch {}
  }
}

export function shouldNotifyOnStop(startedAtMs: number | undefined, nowMs: number, minMinutes: number): boolean {
  if (startedAtMs === undefined) return false;
  return nowMs - startedAtMs >= minMinutes * 60_000;
}
