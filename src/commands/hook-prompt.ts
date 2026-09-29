import { cleanupOldEntries, recordPromptStart } from '../state.js';
import { readStdin } from '../stdin.js';

interface PromptInput {
  session_id?: string;
}

export async function runHookPrompt(): Promise<void> {
  const raw = await readStdin();
  let input: PromptInput;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  const sessionId = input.session_id;
  if (!sessionId) return;

  cleanupOldEntries();
  recordPromptStart(sessionId, Date.now());
}
