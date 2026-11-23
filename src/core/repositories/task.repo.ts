import type { Db, Row, SqlValue } from '../db/index.ts';
import type { ErrorClass, Task, TaskRecord, TaskResult, TaskStatus, TaskStep, TaskTarget } from '../../shared/types.ts';

const str = (v: SqlValue | undefined): string => (v == null ? '' : String(v));
const num = (v: SqlValue | undefined): number => (v == null ? 0 : Number(v));
const nullableNum = (v: SqlValue | undefined): number | null => (v == null ? null : Number(v));
const nullableStr = (v: SqlValue | undefined): string | null => (v == null ? null : String(v));

const COLUMNS =
  'id, name, status, target_json, steps_json, result_json, concurrency, timeout_ms, retries, error_class, error, created_at, started_at, ended_at';

export class TaskRepo {
  constructor(private readonly db: Db) {}

  insert(
    input: {
      id: string;
      name: string;
      target: TaskTarget;
      steps: TaskStep[];
      concurrency: number;
      timeoutMs: number;
      retries: number;
    },
    now = Date.now(),
  ): Task {
    this.db
      .prepare(
        `INSERT INTO tasks (id, name, status, target_json, steps_json, concurrency, timeout_ms, retries, created_at)
         VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.name,
        JSON.stringify(input.target),
        JSON.stringify(input.steps),
        input.concurrency,
        input.timeoutMs,
        input.retries,
        now,
      );
    return this.findOrThrow(input.id);
  }

  find(id: string): Task | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM tasks WHERE id = ?`).get(id);
    return row ? toTask(row) : undefined;
  }

  findOrThrow(id: string): Task {
    const task = this.find(id);
    if (!task) throw new Error(`任务不存在: ${id}`);
    return task;
  }

  list(limit = 50): Task[] {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM tasks ORDER BY created_at DESC LIMIT ?`)
      .all(limit)
      .map(toTask);
  }

  markRunning(id: string, now = Date.now()): void {
    this.db.prepare(`UPDATE tasks SET status = 'running', started_at = ? WHERE id = ?`).run(now, id);
  }

  finish(
    id: string,
    result: {
      status: TaskStatus;
      result?: TaskResult | null;
      error?: string | null;
      errorClass?: ErrorClass | null;
    },
    now = Date.now(),
  ): void {
    this.db
      .prepare(
        `UPDATE tasks SET status = ?, result_json = ?, error = ?, error_class = ?, ended_at = ? WHERE id = ?`,
      )
      .run(
        result.status,
        result.result === undefined || result.result === null ? null : JSON.stringify(result.result),
        result.error ?? null,
        result.errorClass ?? null,
        now,
        id,
      );
  }

  /** 保留策略用：删掉早于某时刻的终态任务，返回条数 */
  purgeBefore(cutoff: number, now = Date.now()): Array<{ id: string; ended_at: number | null }> {
    const rows = this.db
      .prepare(
        `SELECT id, ended_at FROM tasks
         WHERE status IN ('succeeded','failed','cancelled') AND COALESCE(ended_at, created_at) < ?`,
      )
      .all(cutoff);
    if (rows.length === 0) return [];
    const ids = rows.map((row) => str(row.id));
    const holes = ids.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM tasks WHERE id IN (${holes})`).run(...ids);
    void now;
    return rows.map((row) => ({ id: str(row.id), ended_at: nullableNum(row.ended_at) }));
  }

  /**
   * 进程重启后，标着 running 的任务已经不可能继续了。
   * 只处理 running：queued 表示"建好但没跑过"，重启不该把它变成失败记录。
   */
  failOrphans(reason: string, now = Date.now()): number {
    const r = this.db
      .prepare(
        `UPDATE tasks SET status = 'failed', error = COALESCE(error, ?), ended_at = ? WHERE status = 'running'`,
      )
      .run(reason, now);
    return r.changes;
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }
}

function toTask(row: Row): Task {
  const record: TaskRecord = {
    id: str(row.id),
    name: str(row.name),
    status: str(row.status) as TaskStatus,
    target_json: str(row.target_json),
    steps_json: str(row.steps_json),
    result_json: nullableStr(row.result_json),
    concurrency: num(row.concurrency),
    timeout_ms: nullableNum(row.timeout_ms),
    retries: num(row.retries),
    error_class: nullableStr(row.error_class),
    error: nullableStr(row.error),
    created_at: num(row.created_at),
    started_at: nullableNum(row.started_at),
    ended_at: nullableNum(row.ended_at),
  };
  return {
    id: record.id,
    name: record.name,
    status: record.status,
    target: safeParse<TaskTarget>(record.target_json, { profileIds: [] }),
    steps: safeParse<TaskStep[]>(record.steps_json, []),
    result: record.result_json ? safeParse<TaskResult | null>(record.result_json, null) : null,
    concurrency: record.concurrency,
    timeoutMs: record.timeout_ms ?? 600_000,
    retries: record.retries,
    errorClass: (record.error_class as ErrorClass | null) ?? null,
    error: record.error,
    createdAt: record.created_at,
    startedAt: record.started_at,
    endedAt: record.ended_at,
  };
}

function safeParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
