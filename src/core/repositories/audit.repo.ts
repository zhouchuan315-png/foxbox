import type { Db, SqlValue } from '../db/index.ts';

const str = (v: SqlValue | undefined): string => (v == null ? '' : String(v));
const num = (v: SqlValue | undefined): number => (v == null ? 0 : Number(v));

export interface AuditEntry {
  id: number;
  action: string;
  profileId: string | null;
  detail: unknown;
  createdAt: number;
}

/**
 * 审计日志：只记录动作与结果摘要，不记录凭据。
 * 排障时它是第一手证据——"为什么这个环境启动失败"要看这里。
 */
export class AuditRepo {
  constructor(private readonly db: Db) {}

  log(action: string, profileId: string | null, detail?: unknown, now = Date.now()): void {
    this.db
      .prepare('INSERT INTO audit_logs (action, profile_id, detail, created_at) VALUES (?, ?, ?, ?)')
      .run(action, profileId, detail === undefined ? null : JSON.stringify(detail), now);
  }

  recent(limit = 50): AuditEntry[] {
    return this.db
      .prepare('SELECT id, action, profile_id, detail, created_at FROM audit_logs ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map((row) => ({
        id: num(row.id),
        action: str(row.action),
        profileId: row.profile_id == null ? null : str(row.profile_id),
        detail: row.detail == null ? null : safeParse(str(row.detail)),
        createdAt: num(row.created_at),
      }));
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
