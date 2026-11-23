import { createHash } from 'node:crypto';
import { newId } from '../db/ids.ts';
import { badRequest, notFound } from '../errors.ts';
import type { DatasetRepo } from '../repositories/dataset.repo.ts';
import type { AuditRepo } from '../repositories/audit.repo.ts';
import type {
  CollectReceipt,
  Dataset,
  DatasetColumn,
  DatasetColumnType,
  DatasetDedupe,
  DatasetRow,
} from '../../shared/types.ts';

/**
 * 三处硬限制。
 *
 * 数值不是随手定的：一张 5000 行的订单页很常见，一次写 5000 行会让 SQLite 的
 * 写事务从 10ms 涨到 400ms+，期间所有别的写操作（包括环境状态）都在排队。
 *
 * 超限一律失败，绝不静默截断——截断会让用户以为「就这么多」，然后拿着半张表
 * 去做决定。失败至少还能让他知道要分页。
 */
export const MAX_COLLECT_ROWS = 2000;
export const MAX_ROW_BYTES = 8 * 1024;
export const MAX_BATCH_BYTES = 4 * 1024 * 1024;
const MAX_DATASET_NAME = 48;

export interface CollectInput {
  datasetName: string;
  dedupeBy?: string[] | null;
  mode?: 'upsert' | 'append';
  rows: unknown[];
  profileId: string | null;
  taskId: string | null;
}

export interface DatasetDeps {
  datasets: DatasetRepo;
  audit: AuditRepo;
}

export class DatasetService {
  constructor(private readonly deps: DatasetDeps) {}

  list(limit = 200): Dataset[] {
    return this.deps.datasets.list(limit);
  }

  get(id: string): Dataset {
    const dataset = this.deps.datasets.findById(id);
    if (!dataset) throw notFound(`数据集不存在: ${id}`);
    return dataset;
  }

  getByName(name: string): Dataset | undefined {
    return this.deps.datasets.findByName(name);
  }

  rows(id: string, query: { offset?: number; limit?: number; profileId?: string; q?: string }): {
    rows: DatasetRow[];
    total: number;
    columns: DatasetColumn[];
  } {
    const dataset = this.get(id);
    const page = this.deps.datasets.page(id, query);
    return { ...page, columns: dataset.columns };
  }

  bytes(id: string): number {
    return this.deps.datasets.bytes(id);
  }

  remove(id: string): void {
    const dataset = this.get(id);
    this.deps.datasets.remove(id);
    this.deps.audit.log('dataset.delete', null, { datasetId: id, name: dataset.name, rows: dataset.rowCount });
  }

  /**
   * 采集落库。
   *
   * 顺序很重要：先校验（行数/体积/类型）再解析数据集，最后才是写。
   * 任何一步失败都不会留下半批数据——用户看到「失败」，库里就真的什么都没变。
   */
  write(input: CollectInput, now = Date.now()): CollectReceipt {
    const name = normalizeName(input.datasetName);
    const rows = assertRows(input.rows);
    const mode = input.mode ?? 'upsert';

    const existing = this.deps.datasets.findByName(name);
    const dedupe = resolveDedupe(existing, input.dedupeBy);

    let skipped = 0;
    const prepared: Array<{ key: string; data: Record<string, unknown>; dataJson: string; size: number }> = [];

    for (const [index, row] of rows.entries()) {
      const dataJson = canonicalJson(row);
      const size = Buffer.byteLength(dataJson, 'utf8');
      if (size > MAX_ROW_BYTES) {
        throw badRequest(
          `第 ${index + 1} 行序列化后 ${formatBytes(size)}，超过单行上限 ${formatBytes(MAX_ROW_BYTES)}。` +
            `建议只保留需要的字段，不要把整段 HTML 或 base64 图片写进数据集。`,
        );
      }

      let key: string;
      if (mode === 'append') {
        // 流水类数据：每次执行都是新记录，用随机键保证永不冲突
        key = newId();
      } else if (dedupe.mode === 'fields') {
        const picked = pick(dedupe.fields, row);
        if (Object.values(picked).every(isBlank)) {
          skipped += 1;
          continue;
        }
        key = shortHash(canonicalJson(picked));
      } else {
        key = shortHash(dataJson);
      }
      prepared.push({ key, data: row, dataJson, size });
    }

    const totalBytes = prepared.reduce((sum, r) => sum + r.size, 0);
    if (totalBytes > MAX_BATCH_BYTES) {
      throw badRequest(
        `本次采集 ${prepared.length} 行、共 ${formatBytes(totalBytes)}，超过单批上限 ${formatBytes(MAX_BATCH_BYTES)}。` +
          `建议按日期或分类拆成多个 collect 步骤。`,
      );
    }

    const schema = mergeSchema(
      existing?.columns ?? [],
      prepared.map((r) => r.data),
      now,
    );
    const dataset =
      existing ??
      this.deps.datasets.create({ id: newId(), name, dedupe, schema }, now);

    const outcome = this.deps.datasets.upsertBatch(
      dataset.id,
      prepared.map((r) => ({
        id: newId(),
        dedupeKey: r.key,
        dataJson: r.dataJson,
        profileId: input.profileId,
        taskId: input.taskId,
        now,
      })),
    );

    if (outcome.inserted > 0) this.deps.datasets.bumpCount(dataset.id, outcome.inserted, now);
    if (schemaChanged(existing?.columns ?? [], schema)) this.deps.datasets.updateSchema(dataset.id, schema, now);

    const receipt: CollectReceipt = {
      dataset: name,
      written: outcome.inserted + outcome.updated,
      inserted: outcome.inserted,
      updated: outcome.updated,
      skipped,
    };

    this.deps.audit.log('dataset.write', input.profileId, {
      datasetId: dataset.id,
      name,
      ...receipt,
      taskId: input.taskId,
    });

    return receipt;
  }
}

/** 数据集名是跨机器的稳定标识，所以要限制字符集，但不能禁中文 */
function normalizeName(raw: string): string {
  const name = (raw ?? '').trim();
  if (!name) throw badRequest('collect 步骤缺少 dataset（数据集名）');
  if (name.length > MAX_DATASET_NAME) throw badRequest(`数据集名过长（上限 ${MAX_DATASET_NAME} 字符）`);
  // 排除路径分隔符与控制字符：数据集名会进导出文件名
  if (/[/\\\u0000-\u001f]/.test(name)) throw badRequest(`数据集名不能包含斜杠或控制字符: ${name}`);
  return name;
}

function assertRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw badRequest(
      `collect 的脚本必须返回数组，实际返回 ${value === null ? 'null' : typeof value}。` +
        `例如：Array.from(document.querySelectorAll('tr')).map(...)`,
    );
  }
  if (value.length > MAX_COLLECT_ROWS) {
    throw badRequest(
      `单次采集 ${value.length.toLocaleString('en-US')} 行，超过上限 ${MAX_COLLECT_ROWS}。` +
        `建议在脚本里翻页或分片，例如 Array.from(...).slice(0, ${MAX_COLLECT_ROWS})，` +
        `或按日期/分类拆成多个 collect 步骤。`,
    );
  }
  return value.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw badRequest(`第 ${index + 1} 行不是对象（实际 ${describe(item)}），collect 只接受对象数组`);
    }
    return item as Record<string, unknown>;
  });
}

/**
 * 判重规则以第一次写入为准。
 *
 * 如果第二次换了一套 dedupeBy，老行的 key 是按旧规则算的，新行按新规则算，
 * 同一个业务对象就会变成两行——而且看起来「去重没生效」。与其这样，不如直接拒。
 */
function resolveDedupe(existing: Dataset | undefined, dedupeBy: string[] | null | undefined): DatasetDedupe {
  const requested: DatasetDedupe | null =
    dedupeBy && dedupeBy.length > 0
      ? { mode: 'fields', fields: dedupeBy.map((f) => String(f).trim()).filter(Boolean) }
      : null;

  if (!existing) return requested ?? { mode: 'hash', fields: [] };

  const current = existing.dedupe;
  if (!requested) return current;
  const same =
    current.mode === requested.mode &&
    current.fields.length === requested.fields.length &&
    current.fields.every((f, i) => f === requested.fields[i]);
  if (!same) {
    throw badRequest(
      `数据集「${existing.name}」已按 ${describeDedupe(current)} 判重，本次却要求 ${describeDedupe(requested)}。` +
        `同一个数据集混用两套判重规则会产生重复行；要换规则请新建一个数据集。`,
    );
  }
  return current;
}

function describeDedupe(dedupe: DatasetDedupe): string {
  return dedupe.mode === 'fields' ? `字段 [${dedupe.fields.join(', ')}]` : '全字段哈希';
}

function pick(fields: string[], row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field] = row[field] ?? null;
  return out;
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

/**
 * 规范序列化：递归按 key 排序。
 *
 * 不做这一步，去重会随机失效——对象 key 顺序在 JS 里是插入序，
 * 页面脚本换个写法（比如先 price 后 title）哈希就变了，同一条数据变成两行。
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      out[key] = item === undefined ? null : sortDeep(item);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (typeof value === 'function' || typeof value === 'symbol') return null;
  return value ?? null;
}

/** 32 位十六进制足够：即使有 100 万行，碰撞概率也在 10^-20 量级 */
function shortHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}

function typeOf(value: unknown): DatasetColumnType {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return Number.isFinite(value) ? 'number' : 'json';
  if (typeof value === 'boolean') return 'boolean';
  return 'json';
}

function mergeType(a: DatasetColumnType, b: DatasetColumnType): DatasetColumnType {
  if (a === b) return a;
  if (a === 'null') return b;
  if (b === 'null') return a;
  return 'mixed';
}

/** schema 是并集：后来的行缺字段不算错（补空），多出来的字段追加到末尾 */
function mergeSchema(
  existing: DatasetColumn[],
  rows: Array<Record<string, unknown>>,
  now: number,
): DatasetColumn[] {
  const columns = existing.map((c) => ({ ...c }));
  const index = new Map(columns.map((c) => [c.key, c]));
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      const type = typeOf(row[key]);
      const hit = index.get(key);
      if (!hit) {
        const column: DatasetColumn = { key, type, addedAt: now };
        columns.push(column);
        index.set(key, column);
      } else {
        hit.type = mergeType(hit.type, type);
      }
    }
  }
  return columns;
}

function schemaChanged(before: DatasetColumn[], after: DatasetColumn[]): boolean {
  if (before.length !== after.length) return true;
  return after.some((column, i) => {
    const old = before[i];
    return !old || old.key !== column.key || old.type !== column.type;
  });
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// ───────────────────────────── 导出 ─────────────────────────────

/** CSV 单元格：只有必要时才加引号，避免整张表全是引号 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function csvHeader(columns: DatasetColumn[]): string {
  return `${columns.map((c) => csvCell(c.key)).join(',')}\r\n`;
}

/** CSV 行按 schema 的列顺序取值：缺的补空，多出来的字段不进这一行 */
export function csvLine(columns: DatasetColumn[], data: Record<string, unknown>): string {
  return `${columns.map((c) => csvCell(data[c.key])).join(',')}\r\n`;
}

export function datasetToJsonlLine(data: Record<string, unknown>): string {
  return `${JSON.stringify(data)}\n`;
}
