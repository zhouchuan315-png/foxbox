import type { Db, Row, SqlValue } from '../db/index.ts';
import type { Dataset, DatasetColumn, DatasetDedupe, DatasetRow } from '../../shared/types.ts';

const str = (v: SqlValue | undefined): string => (v == null ? '' : String(v));
const num = (v: SqlValue | undefined): number => (v == null ? 0 : Number(v));
const nullableNum = (v: SqlValue | undefined): number | null => (v == null ? null : Number(v));
const nullableStr = (v: SqlValue | undefined): string | null => (v == null ? null : String(v));

const COLUMNS = 'id, name, schema_json, dedupe_json, row_count, created_at, updated_at';

export interface UpsertInput {
  id: string;
  dedupeKey: string;
  dataJson: string;
  profileId: string | null;
  taskId: string | null;
  now: number;
}

export interface UpsertOutcome {
  inserted: number;
  updated: number;
}

export interface RowQuery {
  offset?: number;
  limit?: number;
  profileId?: string;
  /** 全字段模糊匹配。数据量不大时够用，也避免引入 FTS 的复杂性 */
  q?: string;
}

/**
 * 数据集仓储。
 *
 * 只做原子的读写；「推断 schema、算哈希、判上限」都在 service 层，
 * 那些是业务规则，不该混在 SQL 里。
 */
export class DatasetRepo {
  constructor(private readonly db: Db) {}

  findByName(name: string): Dataset | undefined {
    const row = this.db
      .prepare(
        `SELECT ${COLUMNS}, (SELECT MAX(last_seen_at) FROM dataset_rows r WHERE r.dataset_id = datasets.id) AS last_write
         FROM datasets WHERE name = ?`,
      )
      .get(name);
    return row ? toDataset(row) : undefined;
  }

  findById(id: string): Dataset | undefined {
    const row = this.db
      .prepare(
        `SELECT ${COLUMNS}, (SELECT MAX(last_seen_at) FROM dataset_rows r WHERE r.dataset_id = datasets.id) AS last_write
         FROM datasets WHERE id = ?`,
      )
      .get(id);
    return row ? toDataset(row) : undefined;
  }

  list(limit = 200): Dataset[] {
    return this.db
      .prepare(
        `SELECT ${COLUMNS}, (SELECT MAX(last_seen_at) FROM dataset_rows r WHERE r.dataset_id = datasets.id) AS last_write
         FROM datasets ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(limit)
      .map(toDataset);
  }

  create(input: { id: string; name: string; dedupe: DatasetDedupe; schema: DatasetColumn[] }, now: number): Dataset {
    this.db
      .prepare(
        `INSERT INTO datasets (id, name, schema_json, dedupe_json, row_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(input.id, input.name, JSON.stringify(input.schema), JSON.stringify(input.dedupe), now, now);
    return this.findById(input.id)!;
  }

  updateSchema(id: string, schema: DatasetColumn[], now: number): void {
    this.db
      .prepare('UPDATE datasets SET schema_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(schema), now, id);
  }

  /** 写入后一次性调整行数，避免每行一次 UPDATE */
  bumpCount(id: string, delta: number, now: number): void {
    this.db
      .prepare('UPDATE datasets SET row_count = row_count + ?, updated_at = ? WHERE id = ?')
      .run(delta, now, id);
  }

  /** 哪些 dedupeKey 已经存在——用来把 inserted 和 updated 分开统计 */
  existingKeys(datasetId: string, keys: string[]): Set<string> {
    const out = new Set<string>();
    for (let i = 0; i < keys.length; i += 400) {
      const chunk = keys.slice(i, i + 400);
      const holes = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT dedupe_key FROM dataset_rows WHERE dataset_id = ? AND dedupe_key IN (${holes})`)
        .all(datasetId, ...chunk);
      for (const row of rows) out.add(str(row.dedupe_key));
    }
    return out;
  }

  /**
   * 真正的写入。整批放在一个事务里：
   * 2000 次单独提交会让 SQLite 刷 2000 次 WAL，耗时从几十毫秒涨到几秒。
   */
  upsertBatch(datasetId: string, rows: UpsertInput[]): UpsertOutcome {
    if (rows.length === 0) return { inserted: 0, updated: 0 };

    const existing = this.existingKeys(
      datasetId,
      rows.map((r) => r.dedupeKey),
    );

    const stmt = this.db.prepare(
      `INSERT INTO dataset_rows (id, dataset_id, dedupe_key, data_json,
                                 first_profile_id, last_profile_id, first_task_id,
                                 first_seen_at, last_seen_at, seen_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(dataset_id, dedupe_key) DO UPDATE SET
         data_json       = excluded.data_json,
         last_profile_id = excluded.last_profile_id,
         last_seen_at    = excluded.last_seen_at,
         seen_count      = seen_count + 1`,
    );

    let inserted = 0;
    let updated = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        stmt.run(
          row.id,
          datasetId,
          row.dedupeKey,
          row.dataJson,
          row.profileId,
          row.profileId,
          row.taskId,
          row.now,
          row.now,
        );
        if (existing.has(row.dedupeKey)) updated += 1;
        else inserted += 1;
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { inserted, updated };
  }

  page(datasetId: string, query: RowQuery = {}): { rows: DatasetRow[]; total: number } {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
    const offset = Math.max(query.offset ?? 0, 0);

    const where: string[] = ['dataset_id = ?'];
    const params: SqlValue[] = [datasetId];
    if (query.profileId) {
      where.push('last_profile_id = ?');
      params.push(query.profileId);
    }
    if (query.q?.trim()) {
      where.push('data_json LIKE ?');
      params.push(`%${query.q.trim()}%`);
    }
    const clause = where.join(' AND ');

    const total = num(
      this.db.prepare(`SELECT COUNT(*) AS n FROM dataset_rows WHERE ${clause}`).get(...params)?.n,
    );
    const rows = this.db
      .prepare(
        `SELECT id, dataset_id, dedupe_key, data_json, first_profile_id, last_profile_id,
                first_task_id, first_seen_at, last_seen_at, seen_count
         FROM dataset_rows WHERE ${clause}
         ORDER BY first_seen_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset)
      .map(toRow);

    return { rows, total };
  }

  /**
   * 导出的游标遍历。
   *
   * 按 rowid 走而不是 OFFSET：10 万行时 OFFSET 越往后越慢（要扫过前面所有行），
   * 而且期间有新写入会造成跨页重复/遗漏。
   */
  *iterate(
    datasetId: string,
    opts: { since?: number; profileId?: string; chunkSize?: number } = {},
  ): Generator<DatasetRow> {
    const chunkSize = opts.chunkSize ?? 1000;
    const where: string[] = ['dataset_id = ?'];
    const baseParams: SqlValue[] = [datasetId];
    if (opts.since) {
      where.push('first_seen_at >= ?');
      baseParams.push(opts.since);
    }
    if (opts.profileId) {
      where.push('last_profile_id = ?');
      baseParams.push(opts.profileId);
    }
    const stmt = this.db.prepare(
      `SELECT rowid AS rid, id, dataset_id, dedupe_key, data_json, first_profile_id,
              last_profile_id, first_task_id, first_seen_at, last_seen_at, seen_count
       FROM dataset_rows WHERE ${where.join(' AND ')} AND rowid > ?
       ORDER BY rowid LIMIT ?`,
    );

    let cursor = 0;
    for (;;) {
      const batch = stmt.all(...baseParams, cursor, chunkSize) as Row[];
      if (batch.length === 0) break;
      for (const row of batch) yield toRow(row);
      cursor = num(batch[batch.length - 1]!.rid);
      if (batch.length < chunkSize) break;
    }
  }

  /** 占用字节：走索引扫 length()，10 万行级别可接受，不做缓存以免数字对不上 */
  bytes(datasetId: string): number {
    return num(
      this.db
        .prepare('SELECT COALESCE(SUM(LENGTH(data_json)), 0) AS n FROM dataset_rows WHERE dataset_id = ?')
        .get(datasetId)?.n,
    );
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM datasets WHERE id = ?').run(id);
  }
}

function toDataset(row: Row): Dataset {
  return {
    id: str(row.id),
    name: str(row.name),
    columns: safeParse<DatasetColumn[]>(str(row.schema_json), []),
    dedupe: safeParse<DatasetDedupe>(str(row.dedupe_json), { mode: 'hash', fields: [] }),
    rowCount: num(row.row_count),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
    lastWriteAt: nullableNum(row.last_write),
  };
}

function toRow(row: Row): DatasetRow {
  return {
    id: str(row.id),
    datasetId: str(row.dataset_id),
    data: safeParse<Record<string, unknown>>(str(row.data_json), {}),
    firstProfileId: nullableStr(row.first_profile_id),
    lastProfileId: nullableStr(row.last_profile_id),
    firstTaskId: nullableStr(row.first_task_id),
    firstSeenAt: num(row.first_seen_at),
    lastSeenAt: num(row.last_seen_at),
    seenCount: num(row.seen_count),
  };
}

function safeParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
