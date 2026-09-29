export type Priority = 'low' | 'normal' | 'high';

export interface PushPayload {
  title: string;
  body?: string;
  priority?: Priority;
  link?: string;
  task_id?: number;
  source?: string;
}

export interface PushSuccess {
  ok: true;
  status: 'sent' | 'deduplicated';
  channels: string[];
}

export interface PushFailure {
  ok: false;
  kind: 'unauthorized' | 'rate_limited' | 'validation' | 'error';
  message: string;
  retryAfter?: number;
}

export type PushResult = PushSuccess | PushFailure;
