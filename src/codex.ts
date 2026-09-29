export interface CodexNotification {
  type?: string;
  'thread-id'?: string;
  'turn-id'?: string;
  cwd?: string;
  'last-assistant-message'?: string | null;
}

export function extractCodexJson(args: string[]): string | undefined {
  return args.length > 0 ? args[args.length - 1] : undefined;
}

export function parseCodexNotification(jsonArg: string | undefined): CodexNotification | undefined {
  if (!jsonArg) return undefined;
  try {
    const parsed = JSON.parse(jsonArg);
    return typeof parsed === 'object' && parsed !== null ? (parsed as CodexNotification) : undefined;
  } catch {
    return undefined;
  }
}
