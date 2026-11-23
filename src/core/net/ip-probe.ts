import type * as net from 'node:net';
import { openTunnel, upgradeTls, TunnelError, type ProxyEndpoint } from './tunnel.ts';
import { readHttpResponse, writeHttpGet } from './http1.ts';
import { SocketReader } from './socket-reader.ts';

export interface ExitIpResult {
  ok: boolean;
  exitIp: string | null;
  country: string | null;
  city: string | null;
  /** 出口 IP 的经纬度，用于回填浏览器 geolocation；Cloudflare trace 不提供 */
  latitude: number | null;
  longitude: number | null;
  /** 从建立连接到响应完成的总耗时 */
  latencyMs: number | null;
  /** 其中握手阶段（TCP + TLS）的耗时，更能反映代理快慢 */
  connectMs: number | null;
  endpoint: string | null;
  error: string | null;
  attempts: Array<{ endpoint: string; ok: boolean; error: string | null }>;
  checkedAt: number;
}

interface ProbeEndpoint {
  name: string;
  host: string;
  port: number;
  path: string;
  tls: boolean;
  parse: (body: string) => {
    ip: string | null;
    country: string | null;
    city: string | null;
    latitude?: number | null;
    longitude?: number | null;
  };
}

function parseJson(body: string): Record<string, unknown> {
  try {
    const value = JSON.parse(body) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const pick = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/** 经纬度：只接受参考系内的有限数，超出范围的脏值当作没拿到 */
function pickCoord(value: unknown, limit: number): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

/** Cloudflare trace 是纯文本 key=value，无限流、响应极小，作为首选 */
function parseCloudflareTrace(body: string): { ip: string | null; country: string | null; city: string | null } {
  const map = new Map<string, string>();
  for (const line of body.split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) map.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  return { ip: pick(map.get('ip')), country: pick(map.get('loc')), city: null };
}

const ENDPOINTS: ProbeEndpoint[] = [
  {
    name: 'cloudflare-trace',
    host: 'www.cloudflare.com',
    port: 443,
    path: '/cdn-cgi/trace',
    tls: true,
    parse: parseCloudflareTrace,
  },
  {
    name: 'ip.sb',
    host: 'api.ip.sb',
    port: 443,
    path: '/geoip',
    tls: true,
    parse: (body) => {
      const json = parseJson(body);
      return {
        ip: pick(json.ip),
        country: pick(json.country_code) ?? pick(json.country),
        city: pick(json.city),
        latitude: pickCoord(json.latitude, 90),
        longitude: pickCoord(json.longitude, 180),
      };
    },
  },
  {
    name: 'ip-api',
    host: 'ip-api.com',
    port: 80,
    path: '/json/?fields=status,countryCode,city,query',
    tls: false,
    parse: (body) => {
      const json = parseJson(body);
      return {
        ip: pick(json.query),
        country: pick(json.countryCode),
        city: pick(json.city),
        latitude: pickCoord(json.lat, 90),
        longitude: pickCoord(json.lon, 180),
      };
    },
  },
];

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;

function isValidIp(value: string | null): value is string {
  if (!value) return false;
  if (IPV4.test(value)) return value.split('.').every((part) => Number(part) <= 255);
  // IPv6 只做粗校验：含冒号且长度合理，避免把 HTML 片段当成 IP
  return value.includes(':') && value.length <= 45;
}

/** 国家码必须是 ISO-3166 alpha-2；XX（未知）与 T1（Tor）不算有效国家 */
export function normalizeCountry(value: string | null | undefined): string | null {
  if (!value) return null;
  const upper = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return null;
  if (upper === 'XX' || upper === 'T1') return null;
  return upper;
}

async function probeOnce(
  proxy: ProxyEndpoint,
  endpoint: ProbeEndpoint,
  timeoutMs: number,
): Promise<{
  ip: string;
  country: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  latencyMs: number;
  connectMs: number;
}> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let socket: net.Socket | undefined;
  let reader: SocketReader | undefined;

  try {
    const tunnel = await openTunnel(proxy, { host: endpoint.host, port: endpoint.port }, deadline);
    socket = tunnel.socket;

    if (endpoint.tls) {
      socket = await upgradeTls(socket, endpoint.host, deadline, 'target-connect');
    }
    const connectMs = Date.now() - started;

    reader = new SocketReader(socket);
    writeHttpGet(socket, { host: endpoint.host, path: endpoint.path });
    const response = await readHttpResponse(reader, deadline);

    if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
    const parsed = endpoint.parse(response.body);
    if (!isValidIp(parsed.ip)) throw new Error(`响应里没有可用 IP（${response.body.slice(0, 60).replace(/\s+/g, ' ')}）`);

    return {
      ip: parsed.ip,
      country: normalizeCountry(parsed.country),
      city: parsed.city,
      latitude: parsed.latitude ?? null,
      longitude: parsed.longitude ?? null,
      latencyMs: Date.now() - started,
      connectMs,
    };
  } finally {
    reader?.detach();
    socket?.destroy();
  }
}

export interface ProbeOptions {
  /** 单个探测端点的超时；三个端点串行，最坏情况约为 3 倍 */
  timeoutMs?: number;
}

/**
 * 不经浏览器，直接穿过代理测出口 IP。
 *
 * 这是本系统唯一能独立验证「代理说的是不是真话」的手段：
 * 用户填的国家是申报值，只有实测值才能跟指纹里的时区/语言对齐。
 */
export async function probeExitIp(proxy: ProxyEndpoint, opts: ProbeOptions = {}): Promise<ExitIpResult> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const attempts: ExitIpResult['attempts'] = [];

  for (const endpoint of ENDPOINTS) {
    try {
      const result = await probeOnce(proxy, endpoint, timeoutMs);
      attempts.push({ endpoint: endpoint.name, ok: true, error: null });
      return {
        ok: true,
        exitIp: result.ip,
        country: result.country,
        city: result.city,
        latitude: result.latitude,
        longitude: result.longitude,
        latencyMs: result.latencyMs,
        connectMs: result.connectMs,
        endpoint: endpoint.name,
        error: null,
        attempts,
        checkedAt: Date.now(),
      };
    } catch (error) {
      const message = error instanceof TunnelError ? `[${error.stage}] ${error.message}` : (error as Error).message;
      attempts.push({ endpoint: endpoint.name, ok: false, error: message });
    }
  }

  return {
    ok: false,
    exitIp: null,
    country: null,
    city: null,
    latitude: null,
    longitude: null,
    latencyMs: null,
    connectMs: null,
    endpoint: null,
    error: attempts.map((a) => `${a.endpoint}: ${a.error}`).join(' | ') || '全部探测端点失败',
    attempts,
    checkedAt: Date.now(),
  };
}
