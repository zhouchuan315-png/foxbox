import type { FingerprintPreset } from '../../fingerprint/preset.ts';

export type EngineKind = 'camoufox' | 'patchright';

export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

export interface LaunchSpec {
  profileId: string;
  userDataDir: string;
  preset: FingerprintPreset;
  proxy?: ProxyConfig;
  headless: boolean;
  startupUrl?: string;
  /** 让引擎按代理出口自动对齐时区/语言/WebRTC IP（仅作兜底，主路径由 frozenConfig 决定） */
  geoip: boolean;
  /**
   * 创建环境时固化下来的 CAMOU_CONFIG（来自 launchOptions().env.CAMOU_CONFIG_1）。
   * 每次启动原样传入，保证身份不漂移。
   */
  frozenConfig?: Record<string, unknown>;
  /** canvas 读数覆盖三态：null/undefined 交给引擎，true 强制覆盖，false 强制不覆盖 */
  canvasNoise?: boolean | null;
  /**
   * 引擎原生 fingerprint。传它可以让引擎跳过身份生成——
   * 在 macOS 身份下这一步要 28 秒（要拉浏览器采样宿主渲染），
   * 跳过之后单次启动从 28s 降到百毫秒级。
   */
  engineFingerprint?: Record<string, unknown>;
  /** 仅 Chromium 引擎有意义 */
  humanize?: boolean;
}

export interface LaunchHandle {
  profileId: string;
  pid: number;
  engine: EngineKind;
  /** Playwright Browser / BrowserContext，仅进程内使用，不可序列化 */
  browser: unknown;
  /** 该实例独占的 profile 目录：停止时按它精确回收子进程、清残留锁 */
  userDataDir: string;
  /** 仅 Chromium 引擎提供；Camoufox 无 CDP */
  cdpEndpoint?: string;
  startedAt: number;
}

/**
 * 自动化用的最小页面契约。
 *
 * 只描述任务层真正会调到的几个方法，不把 Playwright 的类型泄漏到上层：
 * 换引擎（或将来换协议）时，需要改的只有一个适配器。
 */
export interface PageLike {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  /** 支持表达式字符串，也支持函数体——字符串形式让 eval 步骤可以直接存 JSON */
  evaluate<T = unknown>(script: string | ((...args: never[]) => T)): Promise<T>;
  screenshot(opts?: { path?: string; fullPage?: boolean }): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
  close(): Promise<void>;
}

export interface ProbeResult {
  ok: boolean;
  /** 页面实际读到的值 */
  observed: Record<string, unknown>;
  mismatches: Array<{ key: string; expected: unknown; actual: unknown }>;
}

export interface EngineAdapter {
  readonly kind: EngineKind;
  launch(spec: LaunchSpec): Promise<LaunchHandle>;
  stop(handle: LaunchHandle): Promise<void>;
  probe(handle: LaunchHandle, preset: FingerprintPreset): Promise<ProbeResult>;
  /**
   * 取该实例的自动化页面。每个句柄复用一个标签页：
   * 任务里连续几步 goto 若每次新开页，会留下一堆后台标签页，
   * 内存和"用户看到的窗口"都会变得莫名其妙。
   */
  page(handle: LaunchHandle): Promise<PageLike>;

  /**
   * 开一个一次性的独立标签页。
   *
   * 给会话巡检用：它要在一个已经开着的环境里打开后台看一眼，但
   * 不能占用任务复用的那个 page（会把用户正在看的页面导航走），
   * 也不该抢焦点。用完关闭，窗口里什么都不变。
   */
  newPage(handle: LaunchHandle): Promise<PageLike>;

  /**
   * 清理该 profile 目录上的残留进程与锁，不启动浏览器。
   *
   * 给启动重试用：Camoufox 在 macOS 上偶发启动挂死（js 侧一直等 juggler 握手，
   * 而浏览器早已僵死），此时 launch() 的 promise 永远不会 settle。
   * 重试之前必须先把这个僵死进程按目录杀掉，否则它会占着 profile 锁，
   * 第二次启动同样进不去。
   */
  reapStale?(userDataDir: string): void;
}
