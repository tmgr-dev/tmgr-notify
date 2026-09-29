export function firstLine(text: string | undefined | null, fallback = ''): string {
  if (!text) return fallback;
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0);
  return line ? line.trim() : fallback;
}
