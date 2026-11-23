import type { Db, Row, SqlValue } from '../db/index.ts';
import type {
  ProbeRule,
  SessionCheck,
  SessionProbe,
  SessionProbeRecord,
  SessionStatus,
} from '../../shared/types.ts';

const str = (v: SqlValue | undefined): string => (v == null ? '' : String(v));
const num = (v: SqlValue | undefined): number => (v == null ? 0 : Number(v));
const nullableNum = (v: SqlValue | undefined): number | null => (v == null ? null : Number(v));
const nullableStr = (v: SqlValue | undefined): string | null => (v == null ? null : String(v));

const PROBE_COLUMNS = 'id, name, profile_id, group_id, url, rule_json, interval_hours, enabled, created_at';
const CHECK_COLUMNS = 'id, probe_id, profile_id, status, detail, elapsed_ms, checked_at';

export class SessionRepo {
  constructor(private readonly db: Db) {}

  listProbes(): SessionProbe[] {
    return this.db
      .prepare(`SELECT ${PROBE_COLUMNS} FROM session_probes ORDER BY created_at DESC`)
      .all()
      .map(toProbe);
  }

  findProbe(id: string): SessionProbe | undefined {
    const row = this.db.prepare(`SELECT ${PROBE_COLUMNS} FROM session_probes WHERE id = ?`).get(id);
    return row ? toProbe(row) : undefined;
  }

  findProbeByShape(url: string, rule: ProbeRule): SessionProbe | undefined {
    const ruleJson = JSON.stringify(rule);
    const row = this.db
      .prepare(`SELECT ${PROBE_COLUMNS} FROM session_probes WHERE url = ? AND rule_json = ? LIMIT 1`)
      .get(url, ruleJson);
    return row ? toProbe(row) : undefined;
  }

  insertProbe(
    input: {
      id: string;
      name: string;
      profileId: string | null;
      groupId: string | null;
      url: string;
      rule: ProbeRule;
      intervalHours: number | null;
    },
    now: number,
  ): SessionProbe {
    this.db
      .prepare(
        `INSERT INTO session_probes (id, name, profile_id, group_id, url, rule_json, interval_hours, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        input.id,
        input.name,
        input.profileId,
        input.groupId,
        input.url,
        JSON.stringify(input.rule),
        input.intervalHours,
        now,
      );
    return this.findProbe(input.id)!;
  }

  setProbeEnabled(id: string, enabled: boolean): void {
    this.db.prepare('UPDATE session_probes SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  }

  removeProbe(id: string): void {
    this.db.prepare('DELETE FROM session_probes WHERE id = ?').run(id);
  }

  insertCheck(
    input: {
      id: string;
      probeId: string | null;
      profileId: string;
      status: SessionStatus;
      detail: string | null;
      elapsedMs: number;
    },
    now: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO session_checks (id, probe_id, profile_id, status, detail, elapsed_ms, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.probeId, input.profileId, input.status, input.detail, input.elapsedMs, now);
  }

  /** 冗余到 profiles，列表页直接读，避免每个环境查一次历史表 */
  setProfileSession(profileId: string, status: SessionStatus, now: number): void {
    this.db
      .prepare('UPDATE profiles SET last_session_status = ?, last_session_check_at = ? WHERE id = ?')
      .run(status, now, profileId);
  }

  recentChecks(limit = 50, profileId?: string): SessionCheck[] {
    const rows = profileId
      ? this.db
          .prepare(`SELECT ${CHECK_COLUMNS} FROM session_checks WHERE profile_id = ? ORDER BY checked_at DESC LIMIT ?`)
          .all(profileId, limit)
      : this.db
          .prepare(`SELECT ${CHECK_COLUMNS} FROM session_checks ORDER BY checked_at DESC LIMIT ?`)
          .all(limit);
    return rows.map(toCheck);
  }

  /** 上次检查的状态，用来做边沿判定（连续 expired 只算一次事件） */
  lastStatus(profileId: string): SessionStatus | null {
    const row = this.db
      .prepare('SELECT last_session_status FROM profiles WHERE id = ?')
      .get(profileId);
    const value = row ? nullableStr(row.last_session_status) : null;
    return value === 'alive' || value === 'expired' || value === 'unknown' ? value : null;
  }

  /** 历史统计：某环境最近 N 次的成功率，抽屉里用来判断"是偶发还是真掉了" */
  history(profileId: string, limit = 10): SessionCheck[] {
    return this.db
      .prepare(`SELECT ${CHECK_COLUMNS} FROM session_checks WHERE profile_id = ? ORDER BY checked_at DESC LIMIT ?`)
      .all(profileId, limit)
      .map(toCheck);
  }
}

function toProbe(row: Row): SessionProbe {
  const record: SessionProbeRecord = {
    id: str(row.id),
    name: str(row.name),
    profile_id: nullableStr(row.profile_id),
    group_id: nullableStr(row.group_id),
    url: str(row.url),
    rule_json: str(row.rule_json),
    interval_hours: nullableNum(row.interval_hours),
    enabled: num(row.enabled),
    created_at: num(row.created_at),
  };
  return {
    id: record.id,
    name: record.name,
    profileId: record.profile_id,
    groupId: record.group_id,
    url: record.url,
    rule: safeParse<ProbeRule>(record.rule_json, { type: 'url', mustNotMatch: '/login' }),
    intervalHours: record.interval_hours,
    enabled: record.enabled === 1,
    createdAt: record.created_at,
  };
}

function toCheck(row: Row): SessionCheck {
  return {
    id: str(row.id),
    probeId: nullableStr(row.probe_id),
    profileId: str(row.profile_id),
    status: str(row.status) as SessionStatus,
    detail: nullableStr(row.detail),
    elapsedMs: nullableNum(row.elapsed_ms),
    checkedAt: num(row.checked_at),
  };
}

function safeParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
