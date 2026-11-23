import type { Db, Row, SqlValue } from '../db/index.ts';
import type { LaunchRecord } from '../../shared/types.ts';

const str = (v: SqlValue | undefined): string => (v == null ? '' : String(v));
const num = (v: SqlValue | undefined): number => (v == null ? 0 : Number(v));
const nullableNum = (v: SqlValue | undefined): number | null => (v == null ? null : Number(v));
const nullableStr = (v: SqlValue | undefined): string | null => (v == null ? null : String(v));

function toRecord(row: Row): LaunchRecord {
  return {
    id: str(row.id),
    profile_id: str(row.profile_id),
    pid: nullableNum(row.pid),
    auto_port: nullableNum(row.auto_port),
    started_at: num(row.started_at),
    ended_at: nullableNum(row.ended_at),
    exit_code: nullableNum(row.exit_code),
    error: nullableStr(row.error),
  };
}

const COLUMNS = 'id, profile_id, pid, auto_port, started_at, ended_at, exit_code, error';

export class LaunchRepo {
  constructor(private readonly db: Db) {}

  begin(input: { id: string; profileId: string; pid: number | null; autoPort: number | null }, now = Date.now()): void {
    this.db
      .prepare('INSERT INTO launches (id, profile_id, pid, auto_port, started_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.id, input.profileId, input.pid, input.autoPort, now);
  }

  setPid(id: string, pid: number | null): void {
    this.db.prepare('UPDATE launches SET pid = ? WHERE id = ?').run(pid, id);
  }

  end(id: string, result: { exitCode?: number | null; error?: string | null }, now = Date.now()): void {
    this.db
      .prepare('UPDATE launches SET ended_at = ?, exit_code = ?, error = ? WHERE id = ?')
      .run(now, result.exitCode ?? null, result.error ?? null, id);
  }

  /** 关闭所有残留的开启记录（崩溃恢复时调用） */
  closeDangling(reason: string, now = Date.now()): number {
    const r = this.db
      .prepare('UPDATE launches SET ended_at = ?, error = COALESCE(error, ?) WHERE ended_at IS NULL')
      .run(now, reason);
    return r.changes;
  }

  forProfile(profileId: string, limit = 20): LaunchRecord[] {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM launches WHERE profile_id = ? ORDER BY started_at DESC LIMIT ?`)
      .all(profileId, limit)
      .map(toRecord);
  }

  lastForProfile(profileId: string): LaunchRecord | undefined {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM launches WHERE profile_id = ? ORDER BY started_at DESC LIMIT 1`)
      .get(profileId);
    return row ? toRecord(row) : undefined;
  }
}
