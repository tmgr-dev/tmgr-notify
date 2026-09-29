interface TranscriptContentBlock {
  type?: string;
}

interface TranscriptEntry {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | TranscriptContentBlock[];
  };
}

function isRealUserPrompt(entry: TranscriptEntry): boolean {
  if (entry.type !== 'user' || entry.message?.role !== 'user') return false;
  const content = entry.message.content;
  if (typeof content === 'string') return true;
  if (Array.isArray(content)) return content.every((block) => block?.type !== 'tool_result');
  return false;
}

export function lastUserPromptTimestamp(jsonlContent: string): number | undefined {
  let last: number | undefined;
  for (const line of jsonlContent.split('\n')) {
    if (!line.trim()) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRealUserPrompt(entry)) continue;
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isNaN(ts)) last = ts;
  }
  return last;
}
