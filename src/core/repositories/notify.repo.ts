import type { Db, Row, SqlValue } from '../db/index.ts';
import type { Notifier, NotifierRecord } from '../../shared/types.ts';

const str = (v: SqlValue | undefined): string => (v == null ? '' : String(v));
const num = (v: SqlValue | undefined): number => (v == null ? 0 : Number(v));
const nullableStr = (v: SqlValue | undefined): string | null => (v == null ? null : String(v));
const nullableNum = (v: SqlValue | undefined): number | null => (v == null ? null : Number(v));

const COLUMNS = 'id, name, kind, url, secret, events_json, enabled, created_at';

export interface NotificationLogInput {
  id: string;
  notifierId: string | null;
  event: string;
  dedupeKey: string | null;
  status: 'sent' | 'failed' | 'suppressed';
  httpStatus: number | null;
  error: string | null;
  payloadJson: string | null;
}

export class NotifyRepo {
  constructor(private readonly db: Db) {}

  list(): Notifier[] {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM notifiers ORDER BY created_at DESC`)
      .all()
      .map(toNotifier);
  }

  find(id: string): Notifier | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM notifiers WHERE id = ?`).get(id);
    return row ? toNotifier(row) : undefined;
  }

  insert(
    input: {
      id: string;
      name: string;
      url: string;
      secret: string | null;
      events: string[];
    },
    now: number,
  ): Notifier {
    this.db
      .prepare(
        `INSERT INTO notifiers (id, name, kind, url, secret, events_json, enabled, created_at)
         VALUES (?, ?, 'webhook', ?, ?, ?, 1, ?)`,
      )
      .run(input.id, input.name, input.url, input.secret, JSON.stringify(input.events), now);
    return this.find(input.id)!;
  }

  /** 签名用的密钥单独取，不进 Notifier 的对外结构 */
  secretOf(id: string): string | null {
    const row = this.db.prepare('SELECT secret FROM notifiers WHERE id = ?').get(id);
    return row ? nullableStr(row.secret) : null;
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db.prepare('UPDATE notifiers SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM notifiers WHERE id = ?').run(id);
  }

  log(input: NotificationLogInput, now: number): void {
    this.db
      .prepare(
        `INSERT INTO notification_logs (id, notifier_id, event, dedupe_key, status, http_status, error, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.notifierId,
        input.event,
        input.dedupeKey,
        input.status,
        input.httpStatus,
        input.error,
        input.payloadJson,
        now,
      );
  }

  recentLogs(limit = 50): NotificationLog[] {
    return this.db
      .prepare(
        `SELECT id, notifier_id, event, dedupe_key, status, http_status, error, created_at
         FROM notification_logs ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit)
      .map((row) => ({
        id: str(row.id),
        notifierId: nullableStr(row.notifier_id),
        event: str(row.event),
        dedupeKey: nullableStr(row.dedupe_key),
        status: str(row.status) as NotificationLog['status'],
        httpStatus: nullableNum(row.http_status),
        error: nullableStr(row.error),
        createdAt: num(row.created_at),
      }));
  }
}

export interface NotificationLog {
  id: string;
  notifierId: string | null;
  event: string;
  dedupeKey: string | null;
  status: 'sent' | 'failed' | 'suppressed';
  httpStatus: number | null;
  error: string | null;
  createdAt: number;
}

function toNotifier(row: Row): Notifier {
  const record: NotifierRecord = {
    id: str(row.id),
    name: str(row.name),
    kind: str(row.kind) as Notifier['kind'],
    url: str(row.url),
    secret: nullableStr(row.secret),
    events_json: str(row.events_json),
    enabled: num(row.enabled),
    created_at: num(row.created_at),
  };
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    url: record.url,
    hasSecret: Boolean(record.secret),
    events: safeParse<string[]>(record.events_json, []),
    enabled: record.enabled === 1,
    createdAt: record.created_at,
  };
}

function safeParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
