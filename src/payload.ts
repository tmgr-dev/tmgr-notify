import type { Priority, PushPayload } from './types.js';

export interface BuildPayloadInput {
  title: string;
  body?: string;
  priority?: Priority;
  link?: string;
  source?: string;
}

const TITLE_MAX = 120;
const BODY_MAX = 1000;
const SOURCE_MAX = 120;

export function buildPushPayload(input: BuildPayloadInput): PushPayload {
  const payload: PushPayload = { title: input.title.slice(0, TITLE_MAX) };
  if (input.body) payload.body = input.body.slice(0, BODY_MAX);
  if (input.priority) payload.priority = input.priority;
  if (input.link && /^https?:\/\//i.test(input.link)) payload.link = input.link;
  if (input.source) payload.source = input.source.slice(0, SOURCE_MAX);
  return payload;
}
