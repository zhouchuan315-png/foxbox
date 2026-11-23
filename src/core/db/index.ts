import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, SqlValue>;

export interface Statement {
  run(...params: SqlValue[]): { changes: number; lastInsertRowid: number };
  get(...params: SqlValue[]): Row | undefined;
  all(...params: SqlValue[]): Row[];
}

/**
 * 极薄的数据库封装。
 *
 * 只用 node:sqlite（Node 22 内置），不引原生依赖——`better-sqlite3` 在
 * Intel Mac / 受限环境下要跑 node-gyp，失败率高且会拖慢安装。
 * 封装成接口是为了将来真要换驱动时只改这一个文件。
 */
export interface Db {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 迁移清单。
 *
 * schema.sql 只负责「建出全量最新结构」（IF NOT EXISTS），老库靠这里补齐。
 * 每一版都必须写成幂等的：先查列是否存在，再 ALTER——
 * 这样刚建的空库（结构已是最新）和执行过多次迁移的库都能走到同一个终点。
 */
const MIGRATIONS: Array<{ version: number; up: (db: DatabaseSync) => void }> = [
  {
    version: 2,
    up: (db) => {
      const existing = new Set(
        db
          .prepare(`SELECT name FROM pragma_table_info('proxies')`)
          .all()
          .map((row) => String((row as { name: string }).name)),
      );
      for (const column of ['last_check_country', 'last_check_city', 'last_check_endpoint', 'last_check_error']) {
        if (!existing.has(column)) db.exec(`ALTER TABLE proxies ADD COLUMN ${column} TEXT`);
      }
    },
  },
  {
    // v3 是两张新表。schema.sql 里已经是 IF NOT EXISTS，正常路径上这一步是空转；
    // 保留它，是为了让 user_version 真实反映"这个库被谁改成过什么样"，
    // 以及给将来需要回填数据的版本留一个明确的挂载点。
    version: 3,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS automations (
          id TEXT PRIMARY KEY, name TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('cron','proxy_watch')),
          spec_json TEXT NOT NULL, actions_json TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1, next_run_at INTEGER,
          last_run_at INTEGER, last_status TEXT, last_error TEXT,
          run_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_automations_due ON automations(enabled, next_run_at);
        CREATE TABLE IF NOT EXISTS automation_runs (
          id TEXT PRIMARY KEY,
          automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
          trigger TEXT NOT NULL, status TEXT NOT NULL, detail TEXT, task_id TEXT,
          started_at INTEGER NOT NULL, ended_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_automation_runs ON automation_runs(automation_id, started_at DESC);
      `);
    },
  },
  {
    // v4 是数据集两张表。与 v3 同理：schema.sql 已经是 IF NOT EXISTS，
    // 这一步在正常路径上空转，留着是为了让 user_version 能真实反映「库被改到哪一版」。
    version: 4,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS datasets (
          id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
          schema_json TEXT NOT NULL, dedupe_json TEXT NOT NULL,
          row_count INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS dataset_rows (
          id TEXT PRIMARY KEY,
          dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
          dedupe_key TEXT NOT NULL, data_json TEXT NOT NULL,
          first_profile_id TEXT, last_profile_id TEXT, first_task_id TEXT,
          first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
          seen_count INTEGER NOT NULL DEFAULT 1
        );
        CREATE UNIQUE INDEX IF NOT EXISTS uq_dataset_rows ON dataset_rows(dataset_id, dedupe_key);
        CREATE INDEX IF NOT EXISTS idx_dataset_rows_recent ON dataset_rows(dataset_id, last_seen_at DESC);
        CREATE INDEX IF NOT EXISTS idx_dataset_rows_profile ON dataset_rows(dataset_id, last_profile_id);
      `);
    },
  },
  {
    // v5 是会话巡检。profiles 的两列必须走 ALTER：老库的 profiles 表已经建好了，
    // schema.sql 的 CREATE TABLE IF NOT EXISTS 对它是空转。
    version: 5,
    up: (db) => {
      const existing = new Set(
        db
          .prepare(`SELECT name FROM pragma_table_info('profiles')`)
          .all()
          .map((row) => String((row as { name: string }).name)),
      );
      for (const column of ['last_session_status', 'last_session_check_at']) {
        if (!existing.has(column)) {
          const type = column === 'last_session_check_at' ? 'INTEGER' : 'TEXT';
          db.exec(`ALTER TABLE profiles ADD COLUMN ${column} ${type}`);
        }
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_probes (
          id TEXT PRIMARY KEY, name TEXT NOT NULL,
          profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
          group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
          url TEXT NOT NULL, rule_json TEXT NOT NULL,
          interval_hours INTEGER, enabled INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          CHECK ((profile_id IS NULL) <> (group_id IS NULL))
        );
        CREATE TABLE IF NOT EXISTS session_checks (
          id TEXT PRIMARY KEY,
          probe_id TEXT REFERENCES session_probes(id) ON DELETE CASCADE,
          profile_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('alive','expired','unknown')),
          detail TEXT, elapsed_ms INTEGER, checked_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_session_checks ON session_checks(probe_id, checked_at DESC);
        CREATE INDEX IF NOT EXISTS idx_session_checks_profile ON session_checks(profile_id, checked_at DESC);
      `);
    },
  },
  {
    // v6 是可靠性与通知：任务加时限/重试/错误分类，加通知通道两张表。
    version: 6,
    up: (db) => {
      const existing = new Set(
        db
          .prepare(`SELECT name FROM pragma_table_info('tasks')`)
          .all()
          .map((row) => String((row as { name: string }).name)),
      );
      const columns: Array<[string, string]> = [
        ['timeout_ms', 'INTEGER'],
        ['retries', 'INTEGER NOT NULL DEFAULT 0'],
        ['error_class', 'TEXT'],
      ];
      for (const [name, definition] of columns) {
        if (!existing.has(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS notifiers (
          id TEXT PRIMARY KEY, name TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('webhook')),
          url TEXT NOT NULL, secret TEXT, events_json TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS notification_logs (
          id TEXT PRIMARY KEY, notifier_id TEXT, event TEXT NOT NULL,
          dedupe_key TEXT, status TEXT NOT NULL, http_status INTEGER,
          error TEXT, payload_json TEXT, created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_notification_logs ON notification_logs(created_at DESC);
      `);
    },
  },
  {
    // v7 是身份健康：profiles 加一列存启动自检结果。
    //
    // 只标记不修复：验证脚本（npm run m9:repair）已经证明，改 fingerprint.screen
    // 会让 mediaDevices / locale 等 13 个身份键跟着重抽，所以「局部修复」不成立。
    // 老环境唯一正确的处置是整台重建，数据库里只需要留下"它不一致"这个事实。
    version: 7,
    up: (db) => {
      const existing = new Set(
        db
          .prepare(`SELECT name FROM pragma_table_info('profiles')`)
          .all()
          .map((row) => String((row as { name: string }).name)),
      );
      if (!existing.has('health_json')) db.exec('ALTER TABLE profiles ADD COLUMN health_json TEXT');
    },
  },
  {
    // 出口经纬度：geolocation 不能凭空造，得跟着代理的实际出口走
    version: 8,
    up: (db) => {
      const existing = new Set(
        db
          .prepare(`SELECT name FROM pragma_table_info('proxies')`)
          .all()
          .map((row) => String((row as { name: string }).name)),
      );
      for (const column of ['last_check_lat', 'last_check_lon']) {
        if (!existing.has(column)) db.exec(`ALTER TABLE proxies ADD COLUMN ${column} REAL`);
      }
    },
  },
  {
    // canvas 覆盖开关是三态：NULL 交给引擎、1 强制覆盖、0 强制不覆盖
    version: 9,
    up: (db) => {
      const existing = new Set(
        db
          .prepare(`SELECT name FROM pragma_table_info('profiles')`)
          .all()
          .map((row) => String((row as { name: string }).name)),
      );
      if (!existing.has('canvas_noise')) db.exec('ALTER TABLE profiles ADD COLUMN canvas_noise INTEGER');
    },
  },
];

function currentVersion(db: DatabaseSync): number {
  const row = db.prepare('SELECT user_version FROM pragma_user_version').get() as
    | { user_version: number }
    | undefined;
  return Number(row?.user_version ?? 0);
}

function migrate(db: DatabaseSync): void {
  const from = currentVersion(db);
  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;
    migration.up(db);
    db.exec(`PRAGMA user_version = ${migration.version}`);
  }
}

export function openDatabase(file: string): Db {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('PRAGMA busy_timeout = 5000');
  raw.exec('PRAGMA synchronous = NORMAL');

  const schemaPath = path.join(HERE, 'schema.sql');
  raw.exec(fs.readFileSync(schemaPath, 'utf-8'));
  migrate(raw);

  return {
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => {
      const stmt = raw.prepare(sql);
      return {
        run: (...params) => {
          const r = stmt.run(...params);
          return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
        },
        get: (...params) => stmt.get(...params) as Row | undefined,
        all: (...params) => stmt.all(...params) as Row[],
      };
    },
    close: () => raw.close(),
  };
}
