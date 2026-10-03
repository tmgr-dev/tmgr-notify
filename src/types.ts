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

export type AlarmStatus =
  | 'pending'
  | 'delivered'
  | 'calling'
  | 'acknowledged'
  | 'no_answer'
  | 'busy'
  | 'failed'
  | 'call_unavailable'
  | 'expired';

export interface AlarmInfo {
  id: string;
  status: AlarmStatus | string;
  deliveredAt?: string | null;
  acknowledgedAt?: string | null;
  ackChannel?: 'app' | 'call' | string | null;
  callStatus?: string | null;
  createdAt?: string | null;
}

export interface AlarmRequest {
  title: string;
  message: string;
  ackTimeoutSeconds?: number;
  deliveryTimeoutSeconds?: number;
}

export interface AlarmSuccess {
  ok: true;
  alarm: AlarmInfo;
}

export type AlarmResult = AlarmSuccess | PushFailure;

export interface AlarmWaitSuccess {
  ok: true;
  alarm: AlarmInfo;
  timedOut: boolean;
}

export type AlarmWaitResult = AlarmWaitSuccess | (PushFailure & { alarmId?: string });
