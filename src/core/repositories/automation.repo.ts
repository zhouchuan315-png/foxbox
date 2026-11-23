import { newId } from '../db/ids.ts';
import type { Db, Row, SqlValue } from '../db/index.ts';
import type {
  Automation,
  AutomationAction,
  AutomationKind,
  AutomationRecord,
  AutomationRun,
  AutomationRunStatus,
  AutomationSpec,
  AutomationTrigger,
} from '../../shared/types.ts';
import { notFound } from '../errors.ts';

const str = (v: SqlValue | undefined): string => (v == null ? '' : String(v));
const num = (v: SqlValue | undefined): number => (v == null ? 0 : Number(v));
const nullableNum = (v: SqlValue | undefined): number | null => (v == null ? null : Number(v));
const nullableStr = (v: SqlValue | undefined): string | null => (v == null ? null : String(v));

const COLUMNS =
  'id, name, kind, spec_json, actions_json, enabled, next_run_at, last_run_at, last_status, last_error, run_count, created_at';

export interface AutomationInsert {
  id: string;
  name: string;
  kind: AutomationKind;
  spec: AutomationSpec;
  actions: AutomationAction[];
  enabled: boolean;
  nextRunAt: number | null;
}

export interface AutomationPatch {
  name?: string;
  spec?: AutomationSpec;
  actions?: AutomationAction[];
  enabled?: boolean;
  nextRunAt?: number | null;
}

export class AutomationRepo {
  constructor(private readonly db: Db) {}

  insert(input: AutomationInsert, now = Date.now()): Automation {
    this.db
      .prepare(
        `INSERT INTO automations (id, name, kind, spec_json, actions_json, enabled, next_run_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.name,
        input.kind,
        JSON.stringify(input.spec),
        JSON.stringify(input.actions),
        input.enabled ? 1 : 0,
        input.nextRunAt,
        now,
      );
    return this.findOrThrow(input.id);
  }

  find(id: string): Automation | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM automations WHERE id = ?`).get(id);
    return row ? toAutomation(row) : undefined;
  }

  findOrThrow(id: string): Automation {
    const automation = this.find(id);
    if (!automation) throw notFound(`自动化规则不存在: ${id}`);
    return automation;
  }

  list(): Automation[] {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM automations ORDER BY enabled DESC, COALESCE(next_run_at, 9e15) ASC`)
      .all()
      .map(toAutomation);
  }

  /**
   * 到点的规则。
   *
   * 只取 enabled 且 next_run_at <= now：调度器主循环是"看看谁该醒了"，
   * 而不是把全部规则拉出来挨个比时间——规则多了以后这个差别会很明显。
   */
  due(now: number, limit = 20): Automation[] {
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM automations
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at ASC LIMIT ?`,
      )
      .all(now, limit)
      .map(toAutomation);
  }

  earliestNextRun(): number | null {
    const row = this.db
      .prepare('SELECT MIN(next_run_at) AS next FROM automations WHERE enabled = 1 AND next_run_at IS NOT NULL')
      .get();
    return nullableNum(row?.next);
  }

  countEnabled(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM automations WHERE enabled = 1').get();
    return num(row?.n);
  }

  update(id: string, patch: AutomationPatch): Automation {
    const sets: string[] = [];
    const params: SqlValue[] = [];

    if (patch.name !== undefined) {
      sets.push('name = ?');
      params.push(patch.name);
    }
    if (patch.spec !== undefined) {
      sets.push('spec_json = ?');
      params.push(JSON.stringify(patch.spec));
    }
    if (patch.actions !== undefined) {
      sets.push('actions_json = ?');
      params.push(JSON.stringify(patch.actions));
    }
    if (patch.enabled !== undefined) {
      sets.push('enabled = ?');
      params.push(patch.enabled ? 1 : 0);
    }
    if (patch.nextRunAt !== undefined) {
      sets.push('next_run_at = ?');
      params.push(patch.nextRunAt);
    }

    if (sets.length > 0) {
      params.push(id);
      this.db.prepare(`UPDATE automations SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    }
    return this.findOrThrow(id);
  }

  /** 一次触发结束后回写：下次时间、本次结果、累计次数 */
  recordFire(
    id: string,
    input: {
      nextRunAt: number | null;
      status: AutomationRunStatus;
      error?: string | null;
      at?: number;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE automations
         SET next_run_at = ?, last_run_at = ?, last_status = ?, last_error = ?, run_count = run_count + 1
         WHERE id = ?`,
      )
      .run(input.nextRunAt, input.at ?? Date.now(), input.status, input.error ?? null, id);
  }

  /**
   * 手动触发的回写：更新结果与"上次运行"，但不动 next_run_at。
   *
   * 界面上点「立即运行」不应该把定时节奏推后——用户想看的是"现在就跑一次"，
   * 而不是"把这条规则改到 X 分钟后再跑"。
   */
  recordManualFire(
    id: string,
    input: { status: AutomationRunStatus; error?: string | null; at?: number },
  ): void {
    this.db
      .prepare(
        `UPDATE automations
         SET last_run_at = ?, last_status = ?, last_error = ?, run_count = run_count + 1
         WHERE id = ?`,
      )
      .run(input.at ?? Date.now(), input.status, input.error ?? null, id);
  }

  /** 服务启动时重排下一次时间，不计入 run_count（那不算一次触发） */
  reschedule(id: string, nextRunAt: number | null): void {
    this.db.prepare('UPDATE automations SET next_run_at = ? WHERE id = ?').run(nextRunAt, id);
  }

  /**
   * 只推进时间，不改结果。
   *
   * 代理巡检"没有异常"是常态，不该被记成一次运行——否则历史里全是
   * "巡检正常"，真正那次切换被埋在第 200 行。这里只让界面看到"刚巡过"。
   */
  touch(id: string, nextRunAt: number | null, now = Date.now()): void {
    this.db
      .prepare('UPDATE automations SET next_run_at = ?, last_run_at = ? WHERE id = ?')
      .run(nextRunAt, now, id);
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM automations WHERE id = ?').run(id);
  }

  // ---------- 触发历史 ----------

  addRun(
    input: {
      automationId: string;
      trigger: AutomationTrigger;
      taskId?: string | null;
    },
    now = Date.now(),
  ): string {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO automation_runs (id, automation_id, trigger, status, detail, task_id, started_at)
         VALUES (?, ?, ?, 'ok', NULL, ?, ?)`,
      )
      .run(id, input.automationId, input.trigger, input.taskId ?? null, now);
    return id;
  }

  finishRun(
    id: string,
    input: { status: AutomationRunStatus; detail?: string | null },
    now = Date.now(),
  ): void {
    this.db
      .prepare('UPDATE automation_runs SET status = ?, detail = ?, ended_at = ? WHERE id = ?')
      .run(input.status, input.detail ?? null, now, id);
  }

  runs(automationId: string, limit = 20): AutomationRun[] {
    return this.db
      .prepare(`SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT ?`)
      .all(automationId, limit)
      .map(toRun);
  }

  /**
   * 进程重启后清理"永远停在执行中"的记录。
   * 与 tasks 的 failOrphans 同源：句柄随进程消失，记录不能假装还在跑。
   */
  closeOrphanRuns(reason: string, now = Date.now()): number {
    const r = this.db
      .prepare(
        `UPDATE automation_runs SET status = 'failed', detail = COALESCE(detail, ?), ended_at = ?
         WHERE ended_at IS NULL`,
      )
      .run(reason, now);
    return r.changes;
  }
}

function toAutomation(row: Row): Automation {
  const record: AutomationRecord = {
    id: str(row.id),
    name: str(row.name),
    kind: str(row.kind) as AutomationKind,
    spec_json: str(row.spec_json),
    actions_json: str(row.actions_json),
    enabled: num(row.enabled),
    next_run_at: nullableNum(row.next_run_at),
    last_run_at: nullableNum(row.last_run_at),
    last_status: nullableStr(row.last_status),
    last_error: nullableStr(row.last_error),
    run_count: num(row.run_count),
    created_at: num(row.created_at),
  };
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    spec: safeParse<AutomationSpec>(record.spec_json, { expr: '0 0 * * *' }),
    actions: safeParse<AutomationAction[]>(record.actions_json, []),
    enabled: record.enabled === 1,
    nextRunAt: record.next_run_at,
    lastRunAt: record.last_run_at,
    lastStatus: (record.last_status as AutomationRunStatus | null) ?? null,
    lastError: record.last_error,
    runCount: record.run_count,
    createdAt: record.created_at,
  };
}

function toRun(row: Row): AutomationRun {
  return {
    id: str(row.id),
    automationId: str(row.automation_id),
    trigger: str(row.trigger) as AutomationTrigger,
    status: str(row.status) as AutomationRunStatus,
    detail: nullableStr(row.detail),
    taskId: nullableStr(row.task_id),
    startedAt: num(row.started_at),
    endedAt: nullableNum(row.ended_at),
  };
}

function safeParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
