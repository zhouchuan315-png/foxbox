import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Camoufox, launchOptions } from 'camoufox';
import type { FingerprintPreset } from '../../fingerprint/preset.ts';
import type {
  EngineAdapter,
  EngineKind,
  LaunchHandle,
  LaunchSpec,
  PageLike,
  ProbeResult,
} from './types.ts';

// 受限环境（容器 / CI / 沙箱）里 Firefox 内容沙箱无法初始化，会导致启动即崩
process.env.MOZ_DISABLE_CONTENT_SANDBOX ??= '1';

/**
 * 通过 user-data-dir 反查浏览器进程 PID。
 * Playwright 不暴露子进程 PID，孤儿回收只能靠命令行匹配。
 */
function findPidByDataDir(userDataDir: string): number {
  const pids = pidsForDir(userDataDir);
  return pids[0] ?? 0;
}

/**
 * 按 profile 目录找浏览器进程。
 *
 * 必须再按可执行文件路径过滤一次：`pgrep -f <目录>` 会把任何命令行里
 * 碰巧出现这个目录串的进程都算进来（包括我们自己起的脚本、外层 shell）。
 * 早先就因为这一点，回收逻辑把调用方自己 SIGTERM 掉了。
 */
function pidsForDir(userDataDir: string): number[] {
  try {
    const out = execFileSync('pgrep', ['-fl', userDataDir], { encoding: 'utf-8' });
    return out
      .trim()
      .split('\n')
      .filter((line) => line.includes('Camoufox.app/Contents/MacOS/') || line.includes('camoufox'))
      .filter((line) => !line.includes('pgrep'))
      .map((line) => Number(line.split(' ', 1)[0]))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 兜底收尸。
 *
 * 实测：persistent context 调 close() 后，Firefox 进程经常自己留着
 * （`-wait-for-browser` 模式下尤其明显），profile 目录里的 .parentlock 也不清。
 * 下一次启动就会卡在"配置文件已被使用"，表现成启动耗时从 6 秒变成 80 秒甚至直接失败。
 * 所以停环境时按 profile 目录精确回收进程，并清掉残留锁。
 */
function reapProfileProcesses(userDataDir: string, graceMs = 2000): number[] {
  const self = new Set([process.pid, process.ppid]);
  const pids = pidsForDir(userDataDir).filter((pid) => !self.has(pid));

  // 用 /bin/kill 而不是 process.kill：后者对 0/负数 pid 有"发给整个进程组"的语义
  for (const pid of pids) {
    try {
      // stdio 全忽略：进程可能已经自己退了，kill 的 "No such process"
      // 会混进启动日志里，看起来像出了错
      execFileSync('kill', ['-TERM', String(pid)], { stdio: 'ignore' });
    } catch {
      /* 已退出 */
    }
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && pidsForDir(userDataDir).length > 0) sleepSync(100);
  for (const pid of pidsForDir(userDataDir)) {
    if (self.has(pid)) continue;
    try {
      execFileSync('kill', ['-KILL', String(pid)], { stdio: 'ignore' });
    } catch {
      /* 已退出 */
    }
  }
  return pids;
}

function clearStaleLocks(userDataDir: string): void {
  for (const name of ['.parentlock', 'lock']) {
    try {
      fs.rmSync(path.join(userDataDir, name), { force: true });
    } catch {
      /* 权限或已删除 */
    }
  }
}

/**
 * Camoufox（Firefox 内核）适配器。
 *
 * 硬限制：Firefox 走 Juggler 协议，没有 CDP 端点，
 * 因此不提供 cdpEndpoint，外部自动化只能通过进程内调用。
 */
const trace = (spec: string, msg: string, startedAt: number) => {
  if (process.env.FOXBOX_ENGINE_LOG !== '1') return;
  console.log(`[engine ${spec}] +${Date.now() - startedAt}ms ${msg}`);
};

export class CamoufoxAdapter implements EngineAdapter {
  readonly kind: EngineKind = 'camoufox';

  /** 每个句柄一个长期复用的自动化页面 */
  private readonly pages = new WeakMap<LaunchHandle, PageLike>();

  /** profileId → 已算好的启动参数。键里带代理与无头状态，避免换代理后仍用旧参数 */
  private readonly optionCache = new Map<string, Record<string, unknown>>();

  private optionKey(spec: LaunchSpec): string {
    // 缓存键必须带上会改变启动参数的东西：换代理、换出口坐标、改 dpr、开 canvas 覆盖，
    // 任何一项变了都不能复用上一份 launchOptions。
    const cfg = spec.frozenConfig ?? {};
    const geo = `${cfg['geolocation:latitude']},${cfg['geolocation:longitude']},${cfg['geolocation:accuracy']}`;
    const dpr = cfg['window.devicePixelRatio'];
    const noise = spec.canvasNoise == null ? 'auto' : spec.canvasNoise ? 'on' : 'off';
    return `${spec.profileId}|${spec.proxy?.server ?? '-'}|${spec.headless ? 'h' : 'v'}|${geo}|${dpr}|${noise}`;
  }

  private async buildOptions(spec: LaunchSpec): Promise<Record<string, unknown>> {
    const key = this.optionKey(spec);
    const cached = this.optionCache.get(key);
    if (cached) return { ...cached, user_data_dir: spec.userDataDir };

    const options = (await launchOptions({
      headless: spec.headless,
      os: spec.preset.os,
      user_data_dir: spec.userDataDir,
      ...(spec.frozenConfig ? { config: spec.frozenConfig } : {}),
      ...(spec.engineFingerprint ? { fingerprint: spec.engineFingerprint } : {}),
      ...(spec.proxy ? { proxy: spec.proxy } : {}),
      firefox_user_prefs: {
        // 没配代理 = 直连。
        // Firefox 默认 network.proxy.type=5（跟随系统代理）：本机开着 Clash/ClashX
        // 但节点失效时，本该「直连本机网络」的环境会变成所有站点
        // NS_ERROR_PROXY_CONNECTION_REFUSED，且现象和指纹、目标站点都无关，极难判断。
        // AdsPower 类产品的语义是「环境没代理就用本机 IP」，这里显式钉住。
        ...(spec.proxy ? {} : { 'network.proxy.type': 0 }),
        // geolocation 由 config 里的 geolocation:* 决定，但 Firefox 默认先弹权限询问；
        // 无头环境没人点「允许」，站点拿到的是「用户拒绝」——这本身就是一个信号，
        // 而且和环境声称的「本地住宅 IP」矛盾。默认放行，让站点看到声明坐标。
        'permissions.default.geo': 1,
      },
      geoip: spec.geoip,
      // 三态：不传 = 引擎按「身份与宿主渲染是否矛盾」判断；true/false 是用户的明确选择
      ...(spec.canvasNoise == null ? {} : { canvas_noise: spec.canvasNoise }),
      humanize: spec.humanize ?? true,
      // preset 已由本系统固化，覆盖 launcher 的自动生成属于预期行为
      i_know_what_im_doing: true,
    })) as unknown as Record<string, unknown>;

    this.optionCache.set(key, options);
    return options;
  }

  /**
   * 只做清理，不启动。
   *
   * 供启动重试使用：启动失败后浏览器进程往往还活着（僵在等 juggler 握手），
   * 必须按目录精确杀掉、清锁，重试才有可能成功。
   * 正常路径下这里找不到任何进程，是空操作。
   */
  reapStale(userDataDir: string): void {
    reapProfileProcesses(userDataDir);
    clearStaleLocks(userDataDir);
  }

  async launch(spec: LaunchSpec): Promise<LaunchHandle> {
    const startedAt = Date.now();
    fs.mkdirSync(spec.userDataDir, { recursive: true });

    // 上一次异常退出留下的进程/锁会让这次启动卡住几十秒，先在入口清掉
    const stale = pidsForDir(spec.userDataDir);
    if (stale.length > 0) {
      trace(spec.profileId, `发现残留进程 ${stale.join(',')}，回收`, startedAt);
      reapProfileProcesses(spec.userDataDir);
    }
    clearStaleLocks(spec.userDataDir);
    trace(spec.profileId, '开始启动浏览器', startedAt);

    // 先把启动参数算好，再交给引擎。
    //
    // 直接传 config/fingerprint 的话，Camoufox 内部仍会自己调一遍 launchOptions
    // （冷进程要 28–40 秒做宿主渲染采样）——传进去的固化身份只是"再算一遍"的输入。
    // 这里自己算一次并缓存，引擎拿 from_options 直接启动，既省这笔开销，
    // 也保证同一个环境每次拿到的参数逐字节一致。
    const options = await this.buildOptions(spec);
    trace(spec.profileId, `启动参数就绪（缓存=${this.optionCache.has(this.optionKey(spec)) ? 'hit' : 'miss'}）`, startedAt);

    // 窗口尺寸不要在这里传。
    //
    // Camoufox 的签名是 `({ headless, from_options, ...kwargs })`，而 kwargs 只在
    // 没给 from_options 时才有用（用于内部调 launchOptions）。我们始终走 from_options，
    // 所以以前传的 viewport 是被静默丢弃的：`page.viewportSize()` 实测为 null。
    // 实际尺寸由 config 的 `window.innerWidth/innerHeight` 决定——它们非空时引擎会
    // 主动 applyNoViewport（spoofsWindowDimensions），让 Playwright 不要套 1280×720。
    // 宿主夹取在创建环境时就做过了（freeze.ts 的 shrinkScreenToHost），此处无需重复。
    const browser = await Camoufox({
      headless: spec.headless,
      from_options: options,
    } as unknown as Parameters<typeof Camoufox>[0]);

    trace(spec.profileId, `浏览器已就绪 pid=${findPidByDataDir(spec.userDataDir)}`, startedAt);

    if (spec.startupUrl) {
      const page = await (browser as { newPage(): Promise<{ goto(u: string): Promise<unknown> }> })
        .newPage();
      trace(spec.profileId, '打开启动页', startedAt);
      await page.goto(spec.startupUrl).catch(() => undefined);
      trace(spec.profileId, '启动页完成', startedAt);
    }

    return {
      profileId: spec.profileId,
      pid: findPidByDataDir(spec.userDataDir),
      engine: this.kind,
      browser,
      userDataDir: spec.userDataDir,
      startedAt: Date.now(),
    };
  }

  async stop(handle: LaunchHandle): Promise<void> {
    // 先优雅关（close()），再收尸。
    //
    // close() 走的是 juggler 正常关闭流程，Firefox 会自己 flush places/sessionstore、
    // 删掉 .parentlock 再退出；先 SIGTERM 的话这些落盘动作会被打断，
    // profile 停在"不干净退出"状态，下次启动要走恢复路径（更慢、更容易出岔子）。
    // 3s 兜底之后再补一次收尸，覆盖 close() 挂住的情况。
    const browser = handle.browser as { close?: () => Promise<void> } | undefined;
    if (browser?.close) {
      await Promise.race([
        browser.close().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
    // close() 之后再收一次尸：正常路径上这里应该已经没有进程了，
    // 只有 close() 超时（上面 3s 兜底）才会真的杀到东西。
    if (handle.userDataDir) {
      reapProfileProcesses(handle.userDataDir);
      clearStaleLocks(handle.userDataDir);
    }
  }

  /**
   * 任务层用的自动化页面。
   *
   * persistent context 下 browser 实际上是 BrowserContext，newPage 得到的是
   * 新标签页；用户手动开着的那个窗口不受影响。页面被关掉（用户自己关了标签，
   * 或导航崩溃）时下次调用会重建，任务不会因为一个死句柄整条失败。
   */
  async page(handle: LaunchHandle): Promise<PageLike> {
    const cached = this.pages.get(handle);
    if (cached && !isClosed(cached)) return cached;

    const context = handle.browser as {
      newPage(): Promise<PageLike & { isClosed?: () => boolean }>;
    };
    const page = await context.newPage();
    this.pages.set(handle, page);
    return page;
  }

  /** 一次性标签页：巡检结束立刻关掉，不在用户窗口里留痕 */
  async newPage(handle: LaunchHandle): Promise<PageLike> {
    const context = handle.browser as { newPage(): Promise<PageLike> };
    return context.newPage();
  }

  async probe(handle: LaunchHandle, preset: FingerprintPreset): Promise<ProbeResult> {
    const browser = handle.browser as {
      newPage(): Promise<{
        goto(u: string): Promise<unknown>;
        evaluate<T>(fn: () => T): Promise<T>;
        close(): Promise<void>;
      }>;
    };

    const page = await browser.newPage();
    try {
      await page.goto('about:blank');
      const observed = await page.evaluate(() => {
        const gl = (() => {
          try {
            const canvas = document.createElement('canvas');
            const ctx = (canvas.getContext('webgl2') ||
              canvas.getContext('webgl')) as WebGLRenderingContext | null;
            if (!ctx) return null;
            const dbg = ctx.getExtension('WEBGL_debug_renderer_info');
            return {
              vendor: String(
                dbg ? ctx.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : ctx.getParameter(ctx.VENDOR),
              ),
              renderer: String(
                dbg ? ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER),
              ),
            };
          } catch {
            return null;
          }
        })();

        return {
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          languages: [...navigator.languages],
          hardwareConcurrency: navigator.hardwareConcurrency ?? null,
          webdriver: navigator.webdriver ?? null,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          screen: {
            width: screen.width,
            height: screen.height,
            colorDepth: screen.colorDepth,
          },
          // 窗口尺寸单独采一份：屏幕上「报 1920 但窗口只有 1280」是最典型的
          // 身份不一致（换过显示器 / 老环境），只比 screen 看不出来
          window: {
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            outerWidth: window.outerWidth,
            outerHeight: window.outerHeight,
            devicePixelRatio: window.devicePixelRatio,
          },
          dpr: devicePixelRatio,
          webgl: gl,
        };
      });

      // dpr 现在由 config 的 window.devicePixelRatio 接管，可以参与一致性判定；
      // 采集时放两处：window.devicePixelRatio（给健康比对用）与顶层 dpr（历史字段）
      const expected = {
        userAgent: preset.ua,
        languages: preset.languages,
        timezone: preset.timezone,
        screen: {
          width: preset.screen.width,
          height: preset.screen.height,
          colorDepth: preset.screen.colorDepth,
        },
        webgl: preset.webgl,
      };

      const mismatches: ProbeResult['mismatches'] = [];
      for (const [key, want] of Object.entries(expected)) {
        const got = (observed as Record<string, unknown>)[key];
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          mismatches.push({ key, expected: want, actual: got });
        }
      }

      return { ok: mismatches.length === 0, observed, mismatches };
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

function isClosed(page: PageLike & { isClosed?: () => boolean }): boolean {
  try {
    return page.isClosed?.() === true;
  } catch {
    return true;
  }
}
