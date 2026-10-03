import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ResolvedConfig {
  baseUrl: string;
  token: string;
  stopMinMinutes: number;
}

export class ConfigError extends Error {}

const DEFAULT_STOP_MIN_MINUTES = 5;

export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

export function getConfigFilePath(): string {
  return path.join(os.homedir(), '.config', 'tmgr-notify', 'env');
}

export function readFallbackFile(filePath: string): Record<string, string> {
  try {
    return parseEnvFile(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

export function normalizeBaseUrl(url: string): string {
  let base = url.trim().replace(/\/+$/, '');
  if (/\/api$/i.test(base)) {
    base = base.slice(0, -'/api'.length);
  }
  return base;
}

export function buildEndpoint(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/api/notifications/push`;
}

export function buildAlarmsUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/api/alarms`;
}

export function resolveConfig(
  env: Record<string, string | undefined>,
  fallback: Record<string, string>
): ResolvedConfig {
  const baseUrl = env.TMGR_URL || fallback.TMGR_URL;
  const token = env.TMGR_NOTIFY_TOKEN || fallback.TMGR_NOTIFY_TOKEN;
  if (!baseUrl) {
    throw new ConfigError('TMGR_URL is not set (env var or ~/.config/tmgr-notify/env)');
  }
  if (!token) {
    throw new ConfigError('TMGR_NOTIFY_TOKEN is not set (env var or ~/.config/tmgr-notify/env)');
  }

  const rawMinutes = env.TMGR_NOTIFY_STOP_MIN_MINUTES || fallback.TMGR_NOTIFY_STOP_MIN_MINUTES;
  const parsedMinutes = rawMinutes !== undefined ? Number(rawMinutes) : NaN;
  const stopMinMinutes =
    Number.isFinite(parsedMinutes) && parsedMinutes >= 0 ? parsedMinutes : DEFAULT_STOP_MIN_MINUTES;

  return { baseUrl, token, stopMinMinutes };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ResolvedConfig {
  const fallback = readFallbackFile(getConfigFilePath());
  return resolveConfig(env, fallback);
}
