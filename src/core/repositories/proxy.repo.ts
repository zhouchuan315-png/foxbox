import type { Db, Row, SqlValue } from '../db/index.ts';
import type { SecretBox } from '../crypto/secret-box.ts';
import type { ProxyRecord, ProxySummary, ResolvedProxy } from '../../shared/types.ts';
import { conflict, notFound } from '../errors.ts';

export interface CreateProxyInput {
  id: string;
  name: string;
  protocol: 'http' | 'https' | 'socks5';
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
  expectedCountry?: string | null;
}

export interface UpdateProxyInput {
  name?: string;
  protocol?: 'http' | 'https' | 'socks5';
  host?: string;
  port?: number;
  /** undefined = 保持不变；null = 清空 */
  username?: string | null;
  password?: string | null;
  expectedCountry?: string | null;
}

export interface CheckOutcome {
  ok: boolean;
  exitIp?: string | null;
  country?: string | null;
  city?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  latencyMs?: number | null;
  endpoint?: string | null;
  error?: string | null;
}

const str = (v: SqlValue | undefined): string => (v == null ? '' : String(v));
const num = (v: SqlValue | undefined): number => (v == null ? 0 : Number(v));
const nullableStr = (v: SqlValue | undefined): string | null => (v == null ? null : String(v));
const nullableNum = (v: SqlValue | undefined): number | null => (v == null ? null : Number(v));

function toRecord(row: Row): ProxyRecord {
  return {
    id: str(row.id),
    name: str(row.name),
    protocol: str(row.protocol) as ProxyRecord['protocol'],
    host: str(row.host),
    port: num(row.port),
    username: nullableStr(row.username),
    password_enc: nullableStr(row.password_enc),
    expected_country: nullableStr(row.expected_country),
    last_check_at: nullableNum(row.last_check_at),
    last_check_ok: nullableNum(row.last_check_ok),
    last_check_country: nullableStr(row.last_check_country),
    last_check_city: nullableStr(row.last_check_city),
    last_check_lat: nullableNum(row.last_check_lat),
    last_check_lon: nullableNum(row.last_check_lon),
    last_check_endpoint: nullableStr(row.last_check_endpoint),
    last_check_error: nullableStr(row.last_check_error),
    last_exit_ip: nullableStr(row.last_exit_ip),
    last_latency_ms: nullableNum(row.last_latency_ms),
    fail_streak: num(row.fail_streak),
    created_at: num(row.created_at),
  };
}

const COLUMNS = `id, name, protocol, host, port, username, password_enc, expected_country,
  last_check_at, last_check_ok, last_check_country, last_check_city, last_check_lat, last_check_lon,
  last_check_endpoint, last_check_error,
  last_exit_ip, last_latency_ms, fail_streak, created_at`;

export class ProxyRepo {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretBox,
  ) {}

  insert(input: CreateProxyInput, now = Date.now()): ProxySummary {
    const sealed = input.password ? this.secrets.encrypt(input.password) : null;
    this.db
      .prepare(
        `INSERT INTO proxies (id, name, protocol, host, port, username, password_enc, expected_country, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.name,
        input.protocol,
        input.host,
        input.port,
        input.username ?? null,
        sealed,
        input.expectedCountry?.toUpperCase() ?? null,
        now,
      );
    return this.summaryOrThrow(input.id);
  }

  update(id: string, patch: UpdateProxyInput): ProxySummary {
    const sets: string[] = [];
    const params: SqlValue[] = [];

    if (patch.name !== undefined) {
      sets.push('name = ?');
      params.push(patch.name);
    }
    if (patch.protocol !== undefined) {
      sets.push('protocol = ?');
      params.push(patch.protocol);
    }
    if (patch.host !== undefined) {
      sets.push('host = ?');
      params.push(patch.host);
    }
    if (patch.port !== undefined) {
      sets.push('port = ?');
      params.push(patch.port);
    }
    if (patch.username !== undefined) {
      sets.push('username = ?');
      params.push(patch.username);
    }
    if (patch.password !== undefined) {
      sets.push('password_enc = ?');
      params.push(patch.password ? this.secrets.encrypt(patch.password) : null);
    }
    if (patch.expectedCountry !== undefined) {
      sets.push('expected_country = ?');
      params.push(patch.expectedCountry?.toUpperCase() ?? null);
    }

    if (sets.length === 0) return this.summaryOrThrow(id);
    // 改了地址或认证信息，上一次的预检结果就不再有参考价值
    if (
      patch.host !== undefined ||
      patch.port !== undefined ||
      patch.protocol !== undefined ||
      patch.username !== undefined ||
      patch.password !== undefined
    ) {
      sets.push('last_check_ok = NULL', 'last_check_error = NULL');
    }

    params.push(id);
    this.db.prepare(`UPDATE proxies SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return this.summaryOrThrow(id);
  }

  /** 有环境在用的代理不允许删：会把环境的出口悄悄变成直连 */
  remove(id: string): void {
    const used = this.db
      .prepare('SELECT COUNT(*) AS n FROM profiles WHERE proxy_id = ? AND deleted_at IS NULL')
      .get(id);
    const count = used ? num(used.n) : 0;
    if (count > 0) throw conflict(`该代理仍被 ${count} 个环境使用，请先解除绑定`);
    this.db.prepare('DELETE FROM proxies WHERE id = ?').run(id);
  }

  findRecord(id: string): ProxyRecord | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM proxies WHERE id = ?`).get(id);
    return row ? toRecord(row) : undefined;
  }

  find(id: string): ProxySummary | undefined {
    const record = this.findRecord(id);
    return record ? this.toSummary(record) : undefined;
  }

  summaryOrThrow(id: string): ProxySummary {
    const summary = this.find(id);
    if (!summary) throw notFound(`代理不存在: ${id}`);
    return summary;
  }

  list(): ProxySummary[] {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM proxies ORDER BY created_at DESC`)
      .all()
      .map((row) => this.toSummary(toRecord(row)));
  }

  /** 启动时才解密，明文字节不进日志、不进 API 响应 */
  resolve(id: string): ResolvedProxy {
    const record = this.findRecord(id);
    if (!record) throw notFound(`代理不存在: ${id}`);
    return {
      id: record.id,
      expectedCountry: record.expected_country,
      lastCheckCountry: record.last_check_country,
      lastCheckLat: record.last_check_lat,
      lastCheckLon: record.last_check_lon,
      server: `${record.protocol}://${record.host}:${record.port}`,
      username: record.username ?? undefined,
      password: record.password_enc ? this.secrets.decrypt(record.password_enc) : undefined,
    };
  }

  recordCheck(id: string, result: CheckOutcome, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE proxies SET
           last_check_at = ?, last_check_ok = ?,
           last_check_country = COALESCE(?, last_check_country),
           last_check_city = COALESCE(?, last_check_city),
           last_check_lat = COALESCE(?, last_check_lat),
           last_check_lon = COALESCE(?, last_check_lon),
           last_check_endpoint = ?,
           last_check_error = ?,
           last_exit_ip = COALESCE(?, last_exit_ip),
           last_latency_ms = ?,
           fail_streak = CASE WHEN ? = 1 THEN 0 ELSE fail_streak + 1 END
         WHERE id = ?`,
      )
      .run(
        now,
        result.ok ? 1 : 0,
        result.country?.toUpperCase() ?? null,
        result.city ?? null,
        result.latitude ?? null,
        result.longitude ?? null,
        result.endpoint ?? null,
        result.error ?? null,
        result.exitIp ?? null,
        result.latencyMs ?? null,
        result.ok ? 1 : 0,
        id,
      );
  }

  private toSummary(record: ProxyRecord): ProxySummary {
    return {
      id: record.id,
      name: record.name,
      protocol: record.protocol,
      host: record.host,
      port: record.port,
      username: record.username,
      hasPassword: Boolean(record.password_enc),
      expectedCountry: record.expected_country,
      lastCheckAt: record.last_check_at,
      lastCheckOk: record.last_check_ok == null ? null : record.last_check_ok === 1,
      lastCheckCountry: record.last_check_country,
      lastCheckCity: record.last_check_city,
      lastCheckLat: record.last_check_lat,
      lastCheckLon: record.last_check_lon,
      lastCheckEndpoint: record.last_check_endpoint,
      lastCheckError: record.last_check_error,
      lastExitIp: record.last_exit_ip,
      lastLatencyMs: record.last_latency_ms,
      failStreak: record.fail_streak,
      createdAt: record.created_at,
    };
  }
}
