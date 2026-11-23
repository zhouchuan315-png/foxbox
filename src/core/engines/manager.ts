import type { EngineAdapter, EngineKind, LaunchHandle, LaunchSpec, PageLike } from './types.ts';

export interface ManagerOptions {
  /** 同时运行的浏览器上限。每个实例 300–600MB，8 个是 8GB 机器的安全线。 */
  maxConcurrent?: number;
  /** 单个环境启动/停止的超时，超时视为失败，避免 UI 永久转圈 */
  launchTimeoutMs?: number;
  /**
   * 启动失败后的重试次数（不含首次）。
   *
   * 只对"偶发"失败重试（超时 / 进程崩了 / 管道断了）。重试前会先按目录杀干净
   * 残留进程——启动失败时浏览器往往还活着并占着 profile 锁，不收尸重试必失败。
   * 版本缺失、路径错误、指纹非法这类确定性错误不重试。
   */
  launchRetries?: number;
  /** 每次重试前回调，用于落审计/日志 */
  onRetry?: (profileId: string, attempt: number, error: unknown) => void;
}

interface Entry {
  handle: LaunchHandle;
  release: () => void;
}

/**
 * 引擎生命周期管理。
 *
 * 三件事：并发令牌、句柄表、退出级联。
 * 不在这里管数据库——状态落库由 service 层负责，管理层只管进程。
 */
export class EngineManager {
  private readonly adapters = new Map<EngineKind, EngineAdapter>();
  private readonly entries = new Map<string, Entry>();
  private readonly maxConcurrent: number;
  private readonly launchTimeoutMs: number;
  private readonly launchRetries: number;
  private readonly onRetry?: (profileId: string, attempt: number, error: unknown) => void;
  private running = 0;
  private readonly waiters: Array<() => void> = [];
  /** 超时后仍在后台跑的启动请求，按 profile 登记，供下一次启动/停止收尾 */
  private readonly pendingLaunches = new Map<string, Promise<LaunchHandle>>();
  private shuttingDown = false;

  constructor(opts: ManagerOptions = {}) {
    this.maxConcurrent = opts.maxConcurrent ?? 8;
    this.launchTimeoutMs = opts.launchTimeoutMs ?? 90_000;
    this.launchRetries = opts.launchRetries ?? 1;
    this.onRetry = opts.onRetry;

    const onExit = () => {
      void this.shutdown('app-exit');
    };
    process.once('SIGINT', onExit);
    process.once('SIGTERM', onExit);
    process.once('beforeExit', onExit);
  }

  register(adapter: EngineAdapter): void {
    this.adapters.set(adapter.kind, adapter);
  }

  private adapter(kind: EngineKind): EngineAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`引擎未注册: ${kind}`);
    return adapter;
  }

  isRunning(profileId: string): boolean {
    return this.entries.has(profileId);
  }

  handle(profileId: string): LaunchHandle | undefined {
    return this.entries.get(profileId)?.handle;
  }

  /** 自检走这里：拿现成句柄在页面里采样，不重开浏览器 */
  async probe(
    profileId: string,
    preset: Parameters<EngineAdapter['probe']>[1],
  ): ReturnType<EngineAdapter['probe']> {
    const entry = this.entries.get(profileId);
    if (!entry) throw new Error(`环境未在运行: ${profileId}`);
    return this.adapter(entry.handle.engine).probe(entry.handle, preset);
  }

  /** 任务层用：拿运行中实例的自动化页面 */
  async page(profileId: string): Promise<PageLike> {
    const entry = this.entries.get(profileId);
    if (!entry) throw new Error(`环境未在运行: ${profileId}`);
    return this.adapter(entry.handle.engine).page(entry.handle);
  }

  /** 会话巡检用：一次性的独立标签页，调用方负责 close */
  async newPage(profileId: string): Promise<PageLike> {
    const entry = this.entries.get(profileId);
    if (!entry) throw new Error(`环境未在运行: ${profileId}`);
    return this.adapter(entry.handle.engine).newPage(entry.handle);
  }

  listRunning(): Array<{ profileId: string; pid: number; startedAt: number }> {
    return [...this.entries.values()].map((e) => ({
      profileId: e.handle.profileId,
      pid: e.handle.pid,
      startedAt: e.handle.startedAt,
    }));
  }

  /** 给界面看的运行时快照：注册了哪些引擎、还剩几个并发名额 */
  describe(): { engines: EngineKind[]; maxConcurrent: number; running: number; slots: number } {
    return {
      engines: [...this.adapters.keys()],
      maxConcurrent: this.maxConcurrent,
      running: this.running,
      slots: Math.max(0, this.maxConcurrent - this.running),
    };
  }

  private async acquire(): Promise<() => void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return () => this.release();
    }
    // 队列等待：先等令牌，再占位
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.running++;
    return () => this.release();
  }

  private release(): void {
    this.running = Math.max(0, this.running - 1);
    const next = this.waiters.shift();
    if (next) next();
  }

  async launch(spec: LaunchSpec, kind: EngineKind = 'camoufox'): Promise<LaunchHandle> {
    if (this.shuttingDown) throw new Error('应用正在退出，拒绝新的启动请求');
    if (this.entries.has(spec.profileId)) {
      throw new Error(`环境已在运行: ${spec.profileId}`);
    }

    const release = await this.acquire();
    const adapter = this.adapter(kind);
    const maxAttempts = 1 + Math.max(0, this.launchRetries);

    try {
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        // 上一次尝试（可能是"被超时放弃"的那次）还没落地的话，必须先收干净。
        // 否则同一个 profile 上会同时存在两个浏览器，Firefox 会走到
        // "配置文件已被使用"，表现为秒失败或再次挂死。
        await this.clearPending(spec.profileId, adapter, spec.userDataDir);
        if (attempt > 1) await sleep(LAUNCH_RETRY_DELAY_MS);
        try {
          const handle = await this.raceLaunch(adapter, spec);
          this.entries.set(spec.profileId, { handle, release });
          return handle;
        } catch (error) {
          lastError = error;
          if (attempt === maxAttempts || !isRetryableLaunch(error)) throw error;
          this.onRetry?.(spec.profileId, attempt, error);
        }
      }
      throw lastError;
    } catch (error) {
      release();
      throw error;
    }
  }

  /**
   * 超时竞速 + 孤儿句柄兜底。
   *
   * 超时之后 adapter.launch 的 promise 依然在跑（浏览器可能过一会儿才起来）。
   * 放任不管的话，它会在后台悄悄起一个没人管的环境：占内存、占 profile 锁，
   * 下一次启动直接卡住。所以这里登记成"在飞的启动"，由下一次 launch
   * （或 stop/shutdown）负责收尾。
   */
  private async raceLaunch(adapter: EngineAdapter, spec: LaunchSpec): Promise<LaunchHandle> {
    const pending = adapter.launch(spec);
    this.pendingLaunches.set(spec.profileId, pending);
    pending.then(
      (handle) => {
        // 迟到的句柄：已经没人要了，把浏览器关掉（不按目录收尸，
        // 那时目录可能已经属于新一次启动）
        if (this.pendingLaunches.get(spec.profileId) === pending) return;
        void closeQuietly(handle);
      },
      () => undefined,
    );
    try {
      return await withTimeout(
        pending,
        this.launchTimeoutMs,
        // 有头启动在没有图形会话的环境里（SSH / CI / 自动化 shell）会卡死：
        // 窗口创不出来，GPU 与内容子进程反复崩，juggler 永远握手不上。
        // 这类环境下把环境设成 headless 就能秒起，所以报错里直接点出来。
        spec.headless
          ? `启动超时（${Math.round(this.launchTimeoutMs / 1000)}s）`
          : `启动超时（${Math.round(this.launchTimeoutMs / 1000)}s）。当前为有头模式，若运行环境没有图形会话，请把该环境改为 headless`,
      );
    } finally {
      if (this.pendingLaunches.get(spec.profileId) === pending) {
        this.pendingLaunches.delete(spec.profileId);
      }
    }
  }

  /**
   * 收掉"在飞的启动"：先按目录杀，再等它的 promise 落地。
   *
   * 顺序不能反：不先杀，promise 永远不会 settle（它就是在等一个僵死的浏览器），
   * 等满超时也没意义。
   */
  private async clearPending(
    profileId: string,
    adapter: EngineAdapter,
    userDataDir: string,
  ): Promise<void> {
    const pending = this.pendingLaunches.get(profileId);
    adapter.reapStale?.(userDataDir);
    if (!pending) return;
    await Promise.race([pending.catch(() => undefined), sleep(ORPHAN_SETTLE_MS)]);
    this.pendingLaunches.delete(profileId);
    adapter.reapStale?.(userDataDir);
  }

  async stop(profileId: string): Promise<void> {
    const entry = this.entries.get(profileId);
    if (!entry) {
      // 没有句柄，但可能有"超时后还在飞"的启动：用户点了停止就得停干净，
      // 不能出现"界面显示已停止、进程还在后台跑"。
      const pending = this.pendingLaunches.get(profileId);
      if (pending) {
        this.pendingLaunches.delete(profileId); // 迟到的句柄会走 closeQuietly
        await Promise.race([pending.catch(() => undefined), sleep(ORPHAN_SETTLE_MS)]);
      }
      return;
    }
    this.entries.delete(profileId);
    try {
      await withTimeout(
        this.adapter(entry.handle.engine).stop(entry.handle),
        15_000,
        '关闭超时，已强制放弃句柄',
      );
    } finally {
      entry.release();
    }
  }

  /** 应用退出：并行关闭所有实例，避免串行等待拖到 10 秒以上 */
  async shutdown(reason = 'manual'): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    const ids = new Set([...this.entries.keys(), ...this.pendingLaunches.keys()]);
    if (ids.size === 0) return;

    await Promise.allSettled([...ids].map((id) => this.stop(id)));
    this.entries.clear();

    // 给残留子进程一点时间自己退干净，再兜底
    void reason;
  }

  /** 允许重新启用（测试与"取消退出"场景） */
  reopen(): void {
    this.shuttingDown = false;
  }
}

/** 重试前留一点时间让被杀掉的进程真正退场、释放 profile 锁 */
const LAUNCH_RETRY_DELAY_MS = 1500;

/** 等一个被放弃的启动 promise 落地的最长时间 */
const ORPHAN_SETTLE_MS = 4000;

/** 只关浏览器对象，不按目录收尸（目录可能已经归新一次启动所有） */
async function closeQuietly(handle: LaunchHandle): Promise<void> {
  const browser = handle.browser as { close?: () => Promise<void> } | undefined;
  await browser?.close?.().catch(() => undefined);
}

/**
 * 哪些启动失败值得再试一次。
 *
 * 判据是"重试有没有可能成功"，不是"错误严不严重"：
 * - 超时 / 进程崩了 / 管道断了 → 偶发，收尸重来大概率能起（true）
 * - 浏览器没下载、路径不对、配置非法 → 再试一万次也是同一个错（false）
 */
const RETRYABLE_LAUNCH_PATTERNS = [
  '启动超时',
  'timeout',
  'timed out',
  'target closed',
  'browser has been closed',
  'browser closed',
  'crash',
  'channel error',
  'econnreset',
  'econnrefused',
  'socket hang up',
  'eagain',
  'resource temporarily unavailable',
];

const FATAL_LAUNCH_PATTERNS = [
  'executable doesn',
  'executable does not exist',
  'browser not found',
  '未找到',
  'not installed',
  'please run',
  '版本',
  'version mismatch',
  'invalid fingerprint',
  '指纹',
  '配置',
  'permission denied',
  'eacces',
];

function isRetryableLaunch(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (FATAL_LAUNCH_PATTERNS.some((p) => msg.includes(p))) return false;
  return RETRYABLE_LAUNCH_PATTERNS.some((p) => msg.includes(p));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
