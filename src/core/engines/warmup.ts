import { getRandomPreset, launchOptions } from 'camoufox';
import type { OsFamily } from '../../fingerprint/preset.ts';

process.env.MOZ_DISABLE_CONTENT_SANDBOX ??= '1';

export interface WarmupResult {
  ok: boolean;
  elapsedMs: number;
  error?: string;
  /** 命中已有预热结果，没有真的跑引擎 */
  cached?: boolean;
}

/**
 * 引擎预热。
 *
 * 两个要点：
 *
 * 1. 缓存按 os 分桶。引擎的宿主渲染采样结果与身份 OS 绑定，
 *    只预热宿主 OS 时，库里那些「Windows 身份」的环境仍然要现场付一次钱。
 * 2. 同一 os 的并发请求共享同一个 promise。批量启动 3 个环境时，
 *    如果各自触发一次预热，等于把最贵的操作放大三份。
 *
 * 预热失败不影响后续流程——只是那次启动会重新付这笔开销。
 */
const warmed = new Set<OsFamily>();
const inflight = new Map<OsFamily, Promise<WarmupResult>>();
const lastError = new Map<OsFamily, string>();

export async function warmUpEngine(os: OsFamily): Promise<WarmupResult> {
  if (warmed.has(os)) return { ok: true, elapsedMs: 0, cached: true };

  const pending = inflight.get(os);
  if (pending) return pending;

  const promise = (async (): Promise<WarmupResult> => {
    const startedAt = Date.now();
    try {
      const fingerprint = getRandomPreset(os);
      if (!fingerprint) throw new Error(`引擎未内置 ${os} 的指纹包`);
      await launchOptions({ headless: true, os, fingerprint, i_know_what_im_doing: true });
      warmed.add(os);
      lastError.delete(os);
      return { ok: true, elapsedMs: Date.now() - startedAt };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError.set(os, message);
      return { ok: false, elapsedMs: Date.now() - startedAt, error: message };
    } finally {
      inflight.delete(os);
    }
  })();

  inflight.set(os, promise);
  return promise;
}

/** 启动前调用：确保这个身份的 OS 已预热（命中缓存时是零成本） */
export async function ensureWarm(os: OsFamily): Promise<void> {
  if (warmed.has(os)) return;
  await warmUpEngine(os);
}

/**
 * 应用启动时按库里实际存在的身份 OS 逐个预热。
 *
 * 顺序执行而不是并发：每次预热本身就会拉起进程做渲染采样，
 * 并发只会让机器更卡，而前台此时并不着急。
 */
export async function warmUpForProfiles(list: OsFamily[]): Promise<Array<{ os: OsFamily } & WarmupResult>> {
  const out: Array<{ os: OsFamily } & WarmupResult> = [];
  for (const os of [...new Set(list)]) {
    out.push({ os, ...(await warmUpEngine(os)) });
  }
  return out;
}

export function warmupState(): {
  ready: OsFamily[];
  running: OsFamily[];
  failed: Array<{ os: OsFamily; error: string }>;
} {
  return {
    ready: [...warmed],
    running: [...inflight.keys()],
    failed: [...lastError.entries()].map(([os, error]) => ({ os, error })),
  };
}

export function isWarm(os: OsFamily): boolean {
  return warmed.has(os);
}
