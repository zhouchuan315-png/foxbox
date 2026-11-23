import { newId } from '../db/ids.ts';
import { probeExitIp, normalizeCountry, type ExitIpResult } from '../net/ip-probe.ts';
import type { AuditRepo } from '../repositories/audit.repo.ts';
import type { CreateProxyInput, ProxyRepo, UpdateProxyInput } from '../repositories/proxy.repo.ts';
import type { ProxySummary } from '../../shared/types.ts';
import { badRequest, upstream } from '../errors.ts';

export interface ProxyCheckResult {
  proxyId: string;
  ok: boolean;
  exitIp: string | null;
  country: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  latencyMs: number | null;
  connectMs: number | null;
  endpoint: string | null;
  error: string | null;
  /** 实测国家与申报国家不一致——指纹会跟着错，必须显式提示 */
  countryMismatch: boolean;
  declaredCountry: string | null;
  attempts: ExitIpResult['attempts'];
  checkedAt: number;
}

export type CountrySource = 'measured' | 'declared' | 'probed';

export interface CountryResolution {
  country: string;
  source: CountrySource;
  checkedAt: number | null;
  warnings: string[];
}

export interface HealthResult {
  proxyId: string;
  /** 本次是否真的发了请求去验 */
  probed: boolean;
  check: ProxyCheckResult | null;
  warnings: string[];
}

/** 超过这个时长就认为预检结果过期，启动前会重新验一次 */
const FRESH_MS = 15 * 60 * 1000;

export class ProxyUnhealthyError extends Error {
  constructor(
    message: string,
    readonly result: ProxyCheckResult,
  ) {
    super(message);
    this.name = 'ProxyUnhealthyError';
  }
}

/**
 * 代理业务层。
 *
 * 关键设计：「申报国家」和「实测国家」永远分开存。
 * 只信申报值会让指纹里的时区和语言跟真实出口脱节，而这恰恰是最容易被
 * 识别的破绽；只信实测值又会在预检失败时失去可用信息。两者都留着，
 * 不一致时由调用方决定是拒绝还是警告。
 */
export class ProxyService {
  constructor(private readonly deps: { proxies: ProxyRepo; audit: AuditRepo }) {}

  list(): ProxySummary[] {
    return this.deps.proxies.list();
  }

  get(id: string): ProxySummary {
    return this.deps.proxies.summaryOrThrow(id);
  }

  create(input: Omit<CreateProxyInput, 'id'> & { id?: string }): ProxySummary {
    assertSupportedProtocol(input.protocol, input.username, input.password);
    const summary = this.deps.proxies.insert({
      ...input,
      id: input.id ?? newId(),
      expectedCountry: normalizeCountry(input.expectedCountry) ?? input.expectedCountry ?? null,
    });
    this.deps.audit.log('proxy.create', null, {
      proxyId: summary.id,
      protocol: summary.protocol,
      host: summary.host,
      port: summary.port,
    });
    return summary;
  }

  update(id: string, patch: UpdateProxyInput): ProxySummary {
    const current = this.deps.proxies.summaryOrThrow(id);
    assertSupportedProtocol(
      patch.protocol ?? current.protocol,
      patch.username === undefined ? current.username : patch.username,
      patch.password === undefined ? (current.hasPassword ? '***' : null) : patch.password,
    );
    const summary = this.deps.proxies.update(id, {
      ...patch,
      ...(patch.expectedCountry === undefined
        ? {}
        : { expectedCountry: normalizeCountry(patch.expectedCountry) }),
    });
    this.deps.audit.log('proxy.update', null, { proxyId: id, fields: Object.keys(patch) });
    return summary;
  }

  remove(id: string): void {
    this.deps.proxies.remove(id);
    this.deps.audit.log('proxy.delete', null, { proxyId: id });
  }

  /**
   * 真跑一次预检：握手 → 请求 IP 服务 → 落库。
   * 三个探测端点串行，最坏情况要等 3 × timeout。
   */
  async check(id: string, opts: { timeoutMs?: number } = {}): Promise<ProxyCheckResult> {
    const summary = this.deps.proxies.summaryOrThrow(id);
    const resolved = this.deps.proxies.resolve(id);

    const probe = await probeExitIp(
      {
        protocol: summary.protocol,
        host: summary.host,
        port: summary.port,
        username: resolved.username,
        password: resolved.password,
      },
      { timeoutMs: opts.timeoutMs },
    );

    this.deps.proxies.recordCheck(id, {
      ok: probe.ok,
      exitIp: probe.exitIp,
      country: probe.country,
      city: probe.city,
      latitude: probe.latitude,
      longitude: probe.longitude,
      latencyMs: probe.latencyMs,
      endpoint: probe.endpoint,
      error: probe.error,
    });

    const declared = summary.expectedCountry;
    const countryMismatch = Boolean(probe.country && declared && probe.country !== declared);

    this.deps.audit.log('proxy.check', null, {
      proxyId: id,
      ok: probe.ok,
      exitIp: probe.exitIp,
      country: probe.country,
      declared,
      countryMismatch,
      latencyMs: probe.latencyMs,
      error: probe.error,
    });

    return {
      proxyId: id,
      ok: probe.ok,
      exitIp: probe.exitIp,
      country: probe.country,
      city: probe.city,
      latitude: probe.latitude,
      longitude: probe.longitude,
      latencyMs: probe.latencyMs,
      connectMs: probe.connectMs,
      endpoint: probe.endpoint,
      error: probe.error,
      countryMismatch,
      declaredCountry: declared,
      attempts: probe.attempts,
      checkedAt: probe.checkedAt,
    };
  }

  /**
   * 决定「这个代理该按哪个国家做指纹」。
   *
   * 优先级：近期实测 > 申报 > 现场探测。
   * 近期实测排第一，是因为出口 IP 的物理位置才是站点看到的事实。
   */
  async resolveCountry(id: string): Promise<CountryResolution> {
    const summary = this.deps.proxies.summaryOrThrow(id);
    const warnings: string[] = [];
    const fresh = summary.lastCheckAt != null && Date.now() - summary.lastCheckAt < FRESH_MS;

    if (fresh && summary.lastCheckOk && summary.lastCheckCountry) {
      const declared = summary.expectedCountry;
      if (declared && declared !== summary.lastCheckCountry) {
        warnings.push(`申报国家 ${declared} 与实测 ${summary.lastCheckCountry} 不一致，按实测值生成指纹`);
      }
      return { country: summary.lastCheckCountry, source: 'measured', checkedAt: summary.lastCheckAt, warnings };
    }

    if (summary.expectedCountry) {
      warnings.push(
        summary.lastCheckAt == null
          ? '代理尚未预检，本次按申报国家生成指纹；建议先跑一次预检'
          : '代理预检结果已过期，本次按申报国家生成指纹',
      );
      return {
        country: summary.expectedCountry,
        source: 'declared',
        checkedAt: summary.lastCheckAt,
        warnings,
      };
    }

    const result = await this.check(id);
    if (!result.ok || !result.country) {
      throw upstream(`代理预检失败，无法确定出口国家，请显式指定 country 或修复代理：${result.error}`);
    }
    if (result.countryMismatch) {
      warnings.push(`申报国家与实测 ${result.country} 不一致，按实测值生成指纹`);
    }
    return { country: result.country, source: 'probed', checkedAt: result.checkedAt, warnings };
  }

  /**
   * 启动前的健康检查。
   *
   * 只在「没有近期成功记录」时才真的发请求——正常情况下启动不会被网络拖慢；
   * 一旦代理挂了，这里会拦住，而不是让用户对着一个打不开网页的窗口排查。
   */
  async ensureHealthy(id: string, opts: { timeoutMs?: number } = {}): Promise<HealthResult> {
    const summary = this.deps.proxies.summaryOrThrow(id);
    const fresh = summary.lastCheckAt != null && Date.now() - summary.lastCheckAt < FRESH_MS;

    if (fresh && summary.lastCheckOk) {
      return { proxyId: id, probed: false, check: null, warnings: [] };
    }

    const result = await this.check(id, { timeoutMs: opts.timeoutMs ?? 6000 });
    if (!result.ok) {
      throw new ProxyUnhealthyError(
        `代理 ${summary.name} 当前不可用：${result.error ?? '未知错误'}`,
        result,
      );
    }

    const warnings: string[] = [];
    if (result.countryMismatch) {
      warnings.push(`代理实测出口在 ${result.country}，与申报的 ${result.declaredCountry} 不一致`);
    }
    return { proxyId: id, probed: true, check: result, warnings };
  }
}

/**
 * 引擎能力边界的显式拦截。
 *
 * Playwright 的 Firefox 分支对"需要认证的 SOCKS5"直接报
 * `Browser does not support socks5 proxy authentication`——
 * 这行错误对用户毫无指导意义，而且往往等到启动浏览器才暴露。
 * 所以在录入代理时就拒绝，并给出可执行的替代方案。
 */
function assertSupportedProtocol(
  protocol: 'http' | 'https' | 'socks5',
  username: string | null | undefined,
  password: string | null | undefined,
): void {
  if (protocol === 'socks5' && (username || password)) {
    throw badRequest(
      'Firefox 内核不支持带用户名密码的 SOCKS5 代理。请改用 HTTP/HTTPS 代理（多数机场与本地 Clash 同时提供 HTTP 端口），或使用免认证的 SOCKS5。',
    );
  }
}
