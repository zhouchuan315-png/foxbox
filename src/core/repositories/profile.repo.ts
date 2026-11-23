import type { Db, Row, SqlValue } from '../db/index.ts';
import type { Profile, ProfileFilter, ProfileHealth, ProfileRecord, ProfileStatus, ProfileUpdateInput } from '../../shared/types.ts';
import type { FingerprintPreset, OsFamily } from '../../fingerprint/preset.ts';
import type { EngineKind } from '../engines/types.ts';
import { notFound } from '../errors.ts';

export interface CreateProfileInput {
  id: string;
  name: string;
  groupId: string | null;
  engine: EngineKind;
  os: OsFamily;
  preset: FingerprintPreset;
  config: Record<string, unknown>;
  fingerprint: Record<string, unknown>;
  seed: string;
  userDataDir: string;
  proxyId: string | null;
  startupUrl: string | null;
  headless: boolean;
  note: string | null;
  /** 三态：null 交给引擎、true 强制覆盖、false 强制不覆盖 */
  canvasNoise: boolean | null;
}

const str = (v: SqlValue | undefined): string => (v == null ? '' : String(v));
const num = (v: SqlValue | undefined): number => (v == null ? 0 : Number(v));
const nullableStr = (v: SqlValue | undefined): string | null => (v == null ? null : String(v));
const nullableNum = (v: SqlValue | undefined): number | null => (v == null ? null : Number(v));

function toRecord(row: Row): ProfileRecord {
  return {
    id: str(row.id),
    name: str(row.name),
    group_id: nullableStr(row.group_id),
    engine: str(row.engine) as EngineKind,
    status: str(row.status) as ProfileStatus,
    os_family: str(row.os_family) as OsFamily,
    preset_json: str(row.preset_json),
    config_json: str(row.config_json),
    engine_fp_json: str(row.engine_fp_json),
    seed: str(row.seed),
    user_data_dir: str(row.user_data_dir),
    proxy_id: nullableStr(row.proxy_id),
    startup_url: nullableStr(row.startup_url),
    headless: num(row.headless),
    canvas_noise: nullableNum(row.canvas_noise),
    note: nullableStr(row.note),
    deleted_at: nullableNum(row.deleted_at),
    created_at: num(row.created_at),
    updated_at: num(row.updated_at),
    last_opened_at: nullableNum(row.last_opened_at),
    last_session_status: nullableStr(row.last_session_status),
    last_session_check_at: nullableNum(row.last_session_check_at),
    health_json: nullableStr(row.health_json),
  };
}

function toProfile(record: ProfileRecord): Profile {
  return {
    id: record.id,
    name: record.name,
    groupId: record.group_id,
    engine: record.engine,
    status: record.status,
    os: record.os_family,
    preset: JSON.parse(record.preset_json) as FingerprintPreset,
    seed: record.seed,
    proxyId: record.proxy_id,
    startupUrl: record.startup_url,
    headless: record.headless === 1,
    canvasNoise: record.canvas_noise == null ? null : record.canvas_noise === 1,
    note: record.note,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    lastOpenedAt: record.last_opened_at,
    lastSessionStatus: record.last_session_status as Profile['lastSessionStatus'],
    lastSessionCheckAt: record.last_session_check_at,
    health: parseHealth(record.health_json),
  };
}

const COLUMNS = `id, name, group_id, engine, status, os_family, preset_json, config_json, engine_fp_json, seed,
  user_data_dir, proxy_id, startup_url, headless, canvas_noise, note, deleted_at, created_at, updated_at, last_opened_at,
  last_session_status, last_session_check_at, health_json`;

function buildFilter(filter: ProfileFilter): { where: string; params: SqlValue[] } {
  const clauses = ['deleted_at IS NULL'];
  const params: SqlValue[] = [];

  if (filter.groupId) {
    clauses.push('group_id = ?');
    params.push(filter.groupId);
  }
  if (filter.ungrouped) clauses.push('group_id IS NULL');
  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.q) {
    // LIKE 里的 % 和 _ 是通配符，用户输入的这些字符要转义，否则搜 "a_b" 会误命中
    const escaped = filter.q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    clauses.push(`name LIKE ? ESCAPE '\\'`);
    params.push(`%${escaped}%`);
  }

  return { where: clauses.join(' AND '), params };
}

export class ProfileRepo {
  constructor(private readonly db: Db) {}

  insert(input: CreateProfileInput, now: number): Profile {
    this.db
      .prepare(
        `INSERT INTO profiles (id, name, group_id, engine, status, os_family, preset_json, config_json,
           engine_fp_json, seed, user_data_dir, proxy_id, startup_url, headless, canvas_noise, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.name,
        input.groupId,
        input.engine,
        input.os,
        JSON.stringify(input.preset),
        JSON.stringify(input.config),
        JSON.stringify(input.fingerprint),
        input.seed,
        input.userDataDir,
        input.proxyId,
        input.startupUrl,
        input.headless ? 1 : 0,
        input.canvasNoise == null ? null : input.canvasNoise ? 1 : 0,
        input.note,
        now,
        now,
      );
    return this.findOrThrow(input.id);
  }

  /**
   * 只允许改「展示与调度」字段。
   * 指纹相关的 os / preset / config / proxy 一律不可变——改任何一项都会让
   * 已固化身份与代理出口失去一致性，正确做法是新建环境。
   */
  update(id: string, patch: ProfileUpdateInput, now = Date.now()): Profile {
    const sets: string[] = [];
    const params: SqlValue[] = [];

    if (patch.name !== undefined) {
      sets.push('name = ?');
      params.push(patch.name);
    }
    if (patch.note !== undefined) {
      sets.push('note = ?');
      params.push(patch.note);
    }
    if (patch.groupId !== undefined) {
      sets.push('group_id = ?');
      params.push(patch.groupId);
    }
    if (patch.startupUrl !== undefined) {
      sets.push('startup_url = ?');
      params.push(patch.startupUrl);
    }
    if (patch.headless !== undefined) {
      sets.push('headless = ?');
      params.push(patch.headless ? 1 : 0);
    }
    // proxy_id 只由 ProfileService.rebindProxy 走，普通 update 不会传
    if (patch.proxyId !== undefined) {
      sets.push('proxy_id = ?');
      params.push(patch.proxyId);
    }

    if (sets.length > 0) {
      params.push(now, id);
      this.db.prepare(`UPDATE profiles SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...params);
    }
    return this.findOrThrow(id);
  }

  find(id: string): Profile | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM profiles WHERE id = ? AND deleted_at IS NULL`).get(id);
    return row ? toProfile(toRecord(row)) : undefined;
  }

  findOrThrow(id: string): Profile {
    const profile = this.find(id);
    if (!profile) throw notFound(`环境不存在或已删除: ${id}`);
    return profile;
  }

  /** 启动需要引擎配置原文，单独取，避免把 config 带进对外 DTO */
  findConfig(id: string): {
    preset: FingerprintPreset;
    config: Record<string, unknown>;
    fingerprint: Record<string, unknown>;
    userDataDir: string;
  } {
    const row = this.db
      .prepare(
        `SELECT preset_json, config_json, engine_fp_json, user_data_dir FROM profiles WHERE id = ? AND deleted_at IS NULL`,
      )
      .get(id);
    if (!row) throw notFound(`环境不存在或已删除: ${id}`);
    return {
      preset: JSON.parse(str(row.preset_json)) as FingerprintPreset,
      config: JSON.parse(str(row.config_json)) as Record<string, unknown>,
      fingerprint: JSON.parse(str(row.engine_fp_json)) as Record<string, unknown>,
      userDataDir: str(row.user_data_dir),
    };
  }

  list(filter: ProfileFilter = {}): Profile[] {
    const { where, params } = buildFilter(filter);
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
    const offset = Math.max(filter.offset ?? 0, 0);
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM profiles WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset)
      .map((row) => toProfile(toRecord(row)));
  }

  count(filter: ProfileFilter = {}): number {
    const { where, params } = buildFilter(filter);
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM profiles WHERE ${where}`).get(...params);
    return row ? num(row.n) : 0;
  }

  setStatus(id: string, status: ProfileStatus, now = Date.now()): void {
    this.db.prepare('UPDATE profiles SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
  }

  /**
   * 存自检结果。
   *
   * 不动 updated_at：自检是后台行为，不是用户改了这个环境。
   * 否则列表按 updated_at 排序时，所有环境会被自检"顶"到最前面。
   */
  setHealth(id: string, health: ProfileHealth | null): void {
    this.db
      .prepare('UPDATE profiles SET health_json = ? WHERE id = ?')
      .run(health ? JSON.stringify(health) : null, id);
  }

  /**
   * 只回写可读 preset。
   *
   * 目前唯一的使用场景是 geolocation 跟着代理出口漂移：config_json 是启动时的输入，
   * 每次启动都会按当前出口重新注入坐标，所以这里只更新「给人看的」那份。
   */
  setPreset(id: string, preset: FingerprintPreset, now = Date.now()): void {
    this.db
      .prepare('UPDATE profiles SET preset_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(preset), now, id);
  }

  markOpened(id: string, now = Date.now()): void {
    this.db
      .prepare('UPDATE profiles SET last_opened_at = ?, updated_at = ? WHERE id = ?')
      .run(now, now, id);
  }

  rename(id: string, name: string, now = Date.now()): void {
    this.db.prepare('UPDATE profiles SET name = ?, updated_at = ? WHERE id = ?').run(name, now, id);
  }

  softDelete(id: string, now = Date.now()): void {
    this.db
      .prepare('UPDATE profiles SET deleted_at = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(now, 'idle', now, id);
  }

  countAll(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE deleted_at IS NULL').get();
    return row ? num(row.n) : 0;
  }

  /**
   * 库里实际存在的身份 OS。
   *
   * 引擎的预热是按 OS 分桶的，启动时照这个清单逐个预热，
   * 才不会出现「Windows 身份第一次点开要等半分钟」。
   */
  osFamilies(): string[] {
    return this.db
      .prepare('SELECT DISTINCT os_family FROM profiles WHERE deleted_at IS NULL')
      .all()
      .map((row) => str(row.os_family))
      .filter((os) => os === 'windows' || os === 'macos' || os === 'linux');
  }

  /** 非正常退出的启动记录：用于孤儿回收 */
  openLaunches(): Array<{ id: string; profile_id: string; pid: number | null; started_at: number }> {
    return this.db
      .prepare('SELECT id, profile_id, pid, started_at FROM launches WHERE ended_at IS NULL')
      .all()
      .map((row) => ({
        id: str(row.id),
        profile_id: str(row.profile_id),
        pid: nullableNum(row.pid),
        started_at: num(row.started_at),
      }));
  }
}

/** health_json 解析失败一律当作"没检查过"：坏数据不该让整个列表打不开 */
function parseHealth(raw: string | null): ProfileHealth | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ProfileHealth;
    if (!Array.isArray(parsed?.diff)) return null;
    return parsed;
  } catch {
    return null;
  }
}
