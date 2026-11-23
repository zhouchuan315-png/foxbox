import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FingerprintPreset, OsFamily } from '../../fingerprint/preset.ts';
import { diffHealth } from '../../fingerprint/health.ts';
import { hasBlockingIssue, validatePreset, type Issue } from '../../fingerprint/validator.ts';
import { freezeFallback, freezeIdentity } from '../../fingerprint/freeze.ts';
import type { EngineManager } from '../engines/manager.ts';
import type { LaunchHandle, PageLike } from '../engines/types.ts';
import { ensureWarm } from '../engines/warmup.ts';
import type { ProbeResult } from '../engines/types.ts';
import { newId } from '../db/ids.ts';
import type { Paths } from '../paths.ts';
import { hostOsFamily } from '../paths.ts';
import type { ProfileRepo } from '../repositories/profile.repo.ts';
import type { GroupRepo } from '../repositories/group.repo.ts';
import type { ProxyRepo } from '../repositories/proxy.repo.ts';
import type { LaunchRepo } from '../repositories/launch.repo.ts';
import type { AuditRepo } from '../repositories/audit.repo.ts';
import type { ProxyService } from './proxy.service.ts';
import type { Profile, ProfileFilter, ProfileUpdateInput, ResolvedProxy } from '../../shared/types.ts';
import { AppError, badRequest, conflict } from '../errors.ts';

export interface CreateProfileInput {
  name: string;
  /** 代理出口国家，决定时区与语言。给了 proxyId 时可省略（按预检结果推断）。 */
  country?: string;
  os?: OsFamily;
  locale?: string;
  proxyId?: string | null;
  groupId?: string | null;
  startupUrl?: string | null;
  headless?: boolean;
  note?: string | null;
  /** 显式 dpr；默认取宿主实测值（保证「声称 Retina 就真按 2x 渲染」） */
  dpr?: number;
  /** true 强制覆盖 canvas 读数，false 强制不覆盖，不传交给引擎按身份/宿主判断 */
  canvasNoise?: boolean | null;
}

export interface StartResult {
  profile: Profile;
  launchId: string;
  pid: number;
  elapsedMs: number;
  /** 非致命问题：代理国家与申报不一致、预检过期等 */
  warnings: string[];
}

/** 谁打开的：用户手动 / 会话巡检临时起 */
export type StartReason = 'manual' | 'session';

export interface StartOptions {
  /** 默认 manual。session 不会刷新 last_opened_at，审计也记成 session.start */
  reason?: StartReason;
}

/** 外部脚本执行模式，见 runScript 的注释 */
export type ScriptMode = 'page' | 'playwright';

export interface RunScriptInput {
  script: string;
  mode?: ScriptMode;
  /** 默认 30s，上限由路由层限制 */
  timeoutMs?: number;
  /** 默认 true：环境没开就先起 */
  autoStart?: boolean;
  /** 执行成功后再存一张截图（screenshots/automation/） */
  screenshot?: boolean;
}

export interface RunScriptResult {
  ok: boolean;
  mode: ScriptMode;
  result?: unknown;
  error?: string;
  /** 脚本本身耗时，不含启动 */
  elapsedMs: number;
  /** 只有本次请求顺手启动了环境才有 */
  launchMs?: number;
  /** home 相对路径，取图要拼 /files/<path>?t=<token> */
  screenshot?: string;
}

export interface ProfileDeps {
  paths: Paths;
  profiles: ProfileRepo;
  groups: GroupRepo;
  proxies: ProxyRepo;
  launches: LaunchRepo;
  audit: AuditRepo;
  manager: EngineManager;
  proxyService: ProxyService;
}

/**
 * 环境业务编排。
 *
 * 顺序是刻意的：先校验再固化再启动。
 * 校验不过就花 40 秒去生成身份，是很常见的浪费。
 */
/**
 * 把 Playwright 的启动失败压成一句话。
 *
 * 原始信息里 `<launching>` / `<launched>` / 浏览器 stderr 有几百行，
 * 对用户有用的只有第一行，以及"这通常意味着什么"。
 */
function shortLaunchError(reason: string): string {
  const first = reason.split('\n').find((line) => line.trim().length > 0) ?? '未知错误';
  const brief = first.replace(/^browserType\.launchPersistentContext:\s*/, '').trim();
  const hint = /has been closed|Failed to launch the browser/i.test(reason)
    ? '。常见原因：同一环境被重复启动、上次的浏览器进程还没退干净，或 user-data-dir 被占用'
    : '';
  return `浏览器启动失败：${brief}${hint}。完整日志见审计记录。`;
}

export class ProfileService {
  private readonly running = new Map<string, string>();

  /**
   * 在途的启动请求。同一个环境同时被点两次时，第二次拿到的是第一次的 Promise。
   *
   * 不做这层会有一个很难看的失败：两个 launchPersistentContext 抢同一个
   * user-data-dir，其中一个报 "Target page, context or browser has been closed"，
   * 界面上就是"点了启动，弹个红条，再点又好了"。
   */
  private readonly inflight = new Map<string, Promise<StartResult>>();

  constructor(private readonly deps: ProfileDeps) {}

  async create(input: CreateProfileInput): Promise<Profile> {
    const { profiles, proxies, groups, audit, proxyService } = this.deps;
    const id = newId();
    const os = input.os ?? hostOsFamily();
    const warnings: string[] = [];

    if (input.groupId) groups.findOrThrow(input.groupId);
    if (input.proxyId) proxies.summaryOrThrow(input.proxyId);

    // 国家优先级：显式传入 > 代理实测/申报 > 现场预检
    let country = input.country?.toUpperCase();
    if (!country && input.proxyId) {
      const resolution = await proxyService.resolveCountry(input.proxyId);
      country = resolution.country;
      warnings.push(...resolution.warnings);
    }
    if (!country) {
      throw badRequest('缺少国家：新建环境需要显式传 country，或绑定一个已预检的代理');
    }

    // 有代理就用它的实测出口坐标：geolocation 必须落在出口那台机器附近，
    // 否则「时区在纽约、坐标在北京」比不填更容易被识别
    let geo: { latitude: number; longitude: number } | null = null;
    if (input.proxyId) {
      const proxy = proxies.resolve(input.proxyId);
      if (proxy.lastCheckLat != null && proxy.lastCheckLon != null) {
        geo = { latitude: proxy.lastCheckLat, longitude: proxy.lastCheckLon };
      } else {
        warnings.push('代理还没有实测坐标，geolocation 暂用国家兜底坐标；跑一次代理预检就会变成实测值');
      }
    }

    const { identity, degraded, warnings: freezeWarnings } = await this.freeze(os, country, input.locale, {
      geo,
      dpr: input.dpr,
      canvasNoise: input.canvasNoise,
    });
    warnings.push(...freezeWarnings);

    const issues = validatePreset(identity.preset, {
      proxyCountry: country,
      hostOs: hostOsFamily(),
    });
    if (hasBlockingIssue(issues)) {
      audit.log('profile.create.rejected', null, { country, os, issues });
      throw new ProfileValidationError(issues);
    }

    const relativeDir = path.join('profiles', id);
    fs.mkdirSync(path.join(this.deps.paths.home, relativeDir), { recursive: true });

    const profile = profiles.insert(
      {
        id,
        name: input.name,
        groupId: input.groupId ?? null,
        engine: 'camoufox',
        os,
        preset: identity.preset,
        config: identity.config,
        fingerprint: identity.fingerprint,
        seed: identity.preset.seed,
        userDataDir: relativeDir,
        proxyId: input.proxyId ?? null,
        startupUrl: input.startupUrl ?? null,
        headless: input.headless ?? false,
        canvasNoise: input.canvasNoise ?? null,
        note: input.note ?? null,
      },
      Date.now(),
    );

    audit.log('profile.create', id, {
      os,
      country,
      locale: identity.preset.locale,
      chunks: identity.chunks,
      degraded,
      warnings: [...warnings, ...issues.map((i) => i.message)],
    });

    return profile;
  }

  private async freeze(
    os: OsFamily,
    country: string,
    locale?: string,
    extra: {
      geo?: { latitude: number; longitude: number } | null;
      dpr?: number;
      canvasNoise?: boolean | null;
    } = {},
  ) {
    try {
      const identity = await freezeIdentity({
        os,
        country,
        localeOverride: locale,
        geo: extra.geo ?? undefined,
        dpr: extra.dpr ?? undefined,
        canvasNoise: extra.canvasNoise ?? undefined,
      });
      return { identity, degraded: false, warnings: [] as string[] };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.deps.audit.log('profile.freeze.fallback', null, { os, country, reason });
      const identity = freezeFallback({
        os,
        country,
        localeOverride: locale,
        seed: `${os}:${country}:${Date.now().toString(36)}`,
        geo: extra.geo ?? undefined,
        dpr: extra.dpr ?? undefined,
        canvasNoise: extra.canvasNoise ?? undefined,
      });
      return { identity, degraded: true, warnings: [`引擎生成身份失败，已降级：${reason}`] };
    }
  }

  get(id: string): Profile {
    return this.deps.profiles.findOrThrow(id);
  }

  list(filter: ProfileFilter = {}): { items: Profile[]; total: number } {
    return { items: this.deps.profiles.list(filter), total: this.deps.profiles.count(filter) };
  }

  /** 只改展示/调度字段；指纹与代理绑定不可变，改它们等于换身份，要新建环境 */
  update(id: string, patch: ProfileUpdateInput): Profile {
    const { profiles, groups, audit, manager } = this.deps;
    profiles.findOrThrow(id);

    if (patch.groupId) groups.findOrThrow(patch.groupId);
    if (patch.headless !== undefined && manager.isRunning(id)) {
      throw conflict('环境运行中，无法修改无头模式；请先关闭');
    }
    if (patch.name !== undefined && patch.name.trim().length === 0) {
      throw badRequest('环境名不能为空');
    }

    const updated = profiles.update(id, {
      ...patch,
      ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
    });
    audit.log('profile.update', id, { fields: Object.keys(patch) });
    return updated;
  }

  /**
   * 换绑代理——只给自动化用，普通编辑走不到这里。
   *
   * 为什么不放进 update()：指纹里的 timezone / locale 是建环境时按当时的出口国家
   * 固化下来的，事后换一个国家的代理，会让"IP 在德国、时区在纽约"这种矛盾
   * 出现在一个本来干净的环境上。所以这条路要求调用方已经确认了同国家前提，
   * 并且把原因写进审计——将来回查时才解释得清这个环境为什么换了出口。
   */
  rebindProxy(id: string, proxyId: string, reason: string): Profile {
    const { profiles, proxies, audit, manager } = this.deps;
    const profile = profiles.findOrThrow(id);
    proxies.summaryOrThrow(proxyId);

    if (manager.isRunning(id)) {
      throw conflict(`环境「${profile.name}」正在运行，无法切换代理；请先关闭`);
    }
    if (profile.proxyId === proxyId) return profile;

    const updated = profiles.update(id, { proxyId });
    audit.log('profile.rebind-proxy', id, { from: profile.proxyId, to: proxyId, reason });
    return updated;
  }

  /**
   * 启动是幂等的：重复点击只会得到同一次启动的结果，不会把目录抢坏。
   * 真正的启动逻辑在 `launch`。
   */
  async start(id: string, opts: StartOptions = {}): Promise<StartResult> {
    const existing = this.inflight.get(id);
    if (existing) {
      this.deps.audit.log('profile.start.dedup', id, { note: '已有启动在进行中，复用同一次结果' });
      return existing;
    }

    let task: Promise<StartResult>;
    task = this.launch(id, opts.reason ?? 'manual').finally(() => {
      // 只清自己那一份：否则并发下会把后一次启动从表里抹掉
      if (this.inflight.get(id) === task) this.inflight.delete(id);
    });
    this.inflight.set(id, task);
    return task;
  }

  private async launch(id: string, reason: StartReason): Promise<StartResult> {
    const { profiles, proxies, launches, audit, manager, proxyService } = this.deps;
    const profile = profiles.findOrThrow(id);

    if (manager.isRunning(id)) throw conflict(`环境已在运行: ${profile.name}`);

    const { preset, config, fingerprint, userDataDir } = profiles.findConfig(id);
    const warnings: string[] = [];

    let proxy: ResolvedProxy | undefined;
    if (profile.proxyId) {
      // 代理失效时先拦住：否则用户会对着一个打不开网页的窗口排查半天
      const health = await proxyService.ensureHealthy(profile.proxyId);
      warnings.push(...health.warnings);

      proxy = proxies.resolve(profile.proxyId);

      // 引擎侧已经会失败，但错误信息是 sock5 认证不支持——在这里提前讲清楚
      if (proxy.server.startsWith('socks5://') && proxy.username) {
        throw badRequest('该代理是带认证的 SOCKS5，Firefox 内核不支持；请改用 HTTP/HTTPS 代理');
      }

      // geolocation 跟出口走：代理换城市后，坐标必须跟着变，否则时区/坐标自相矛盾。
      // config 是本次启动的输入，可以直接改；preset 是给人看的那份，改完回写。
      if (proxy.lastCheckLat != null && proxy.lastCheckLon != null) {
        const latitude = proxy.lastCheckLat;
        const longitude = proxy.lastCheckLon;
        const accuracy = preset.geolocation.accuracy ?? 50;
        config['geolocation:latitude'] = latitude;
        config['geolocation:longitude'] = longitude;
        config['geolocation:accuracy'] = accuracy;
        if (preset.geolocation.latitude !== latitude || preset.geolocation.longitude !== longitude) {
          preset.geolocation = { latitude, longitude, accuracy };
          profiles.setPreset(id, preset);
        }
      } else {
        warnings.push('该代理还没有实测坐标，geolocation 沿用环境创建时的值；跑一次代理预检即可对齐');
      }

      const issues = validatePreset(preset, {
        proxyCountry: proxy.lastCheckCountry ?? proxy.expectedCountry ?? undefined,
        hostOs: hostOsFamily(),
      });
      if (hasBlockingIssue(issues)) {
        audit.log('profile.start.rejected', id, { issues });
        throw new ProfileValidationError(issues);
      }
    }

    profiles.setStatus(id, 'starting');
    const launchId = newId();
    launches.begin({ id: launchId, profileId: id, pid: null, autoPort: null });

    const startedAt = Date.now();
    try {
      // 引擎按身份 OS 缓存宿主渲染采样。没预热过就现场付，
      // 表现成"点了启动要等二十几秒"，用户只会以为软件卡住了。
      await ensureWarm(preset.os);

      const handle = await manager.launch({
        profileId: id,
        userDataDir: path.join(this.deps.paths.home, userDataDir),
        preset,
        canvasNoise: profile.canvasNoise,
        proxy,
        headless: profile.headless,
        startupUrl: profile.startupUrl ?? undefined,
        // geoip 置 false：M0 证实它会每次随机挑 locale/时区，与"固化"直接冲突
        geoip: false,
        frozenConfig: config,
        engineFingerprint: fingerprint,
      });

      launches.setPid(launchId, handle.pid || null);
      // 巡检为了看一眼而临时起的环境不算「用户打开过」：
      // last_opened_at 是给用户排序用的（最近用过的排前面），
      // 被机器人刷新一遍之后这个顺序就没意义了。
      if (reason !== 'session') profiles.markOpened(id);
      profiles.setStatus(id, 'running');
      this.running.set(id, launchId);
      audit.log(reason === 'session' ? 'session.start' : 'profile.start', id, {
        pid: handle.pid,
        elapsedMs: Date.now() - startedAt,
        os: preset.os,
        proxy: proxy ? proxy.id : null,
        warnings,
        ...(reason === 'manual' ? {} : { reason }),
      });

      // 手动打开时做一次身份自检：把「预设说什么 / 页面实际报什么」的差异存下来。
      //
      // 只在 manual 时做：任务和巡检是批量的（50 个环境就是 50 次自检），
      // 多出来的 1–2 秒纯属浪费，而它们也不看这个标记。
      // 自检失败绝不能让启动失败——那会把"环境能用"变成"环境打不开"。
      if (reason === 'manual') void this.checkHealth(id, handle, preset);

      return {
        profile: profiles.findOrThrow(id),
        launchId,
        pid: handle.pid,
        elapsedMs: Date.now() - startedAt,
        warnings,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      launches.end(launchId, { error: reason });
      profiles.setStatus(id, 'error');
      audit.log('profile.start.failed', id, { reason, warnings });
      // Playwright 的启动错误带几百行浏览器日志，直接甩到界面上没人看得下去；
      // 完整内容留在审计里，界面只给第一句 + 下一步该怎么查。
      throw new AppError(shortLaunchError(reason), 500, 'ENGINE_LAUNCH_FAILED');
    }
  }

  /**
   * 启动后的身份自检（异步、可失败）。
   *
   * 目的只有一个：让「环境的身份和预设对不上」这件事在界面上可见。
   * 不自动修复、不告警——验证过改屏幕会连带重抽别的身份字段，
   * 局部修复会让身份自相矛盾（见 scripts/m9-probe-repair.ts 的结论）。
   */
  private async checkHealth(id: string, handle: LaunchHandle, preset: FingerprintPreset): Promise<void> {
    const { profiles, audit } = this.deps;
    try {
      const probe = await this.deps.manager.probe(id, preset);
      const diff = diffHealth(probe.observed as Record<string, unknown>, preset);
      profiles.setHealth(id, { checkedAt: Date.now(), diff });
      if (diff.length > 0) audit.log('profile.health.diff', id, { count: diff.length, keys: diff.map((d) => d.key) });
      void handle;
    } catch (error) {
      // 自检本身失败不代表身份有问题：可能是页面崩了、超时了。
      // 保持上一次的结论，不要用"检测失败"覆盖掉已知的差异。
      audit.log('profile.health.failed', id, {
        reason: error instanceof Error ? error.message.split('\n')[0] : String(error),
      });
    }
  }

  async stop(id: string): Promise<void> {
    const { profiles, launches, audit, manager } = this.deps;
    // 先确认环境存在：否则对一个不存在的 id 调 setStatus 会"静默成功"，
    // 批量操作里就会把幽灵 id 也算成成功
    profiles.findOrThrow(id);

    // 启动还没落定就拆，会拆出"进程已死但状态是 running"的半截现场。
    // 最多等一次完整启动的时间，失败也不影响后面照常关闭。
    const pending = this.inflight.get(id);
    if (pending) {
      await pending.catch(() => undefined);
    }

    const launchId = this.running.get(id);

    await manager.stop(id);
    this.running.delete(id);

    if (launchId) launches.end(launchId, { exitCode: 0 });
    profiles.setStatus(id, 'idle');
    audit.log('profile.stop', id, {});
  }

  /** 自检：在已运行的实例里采样，与库里的 preset 逐字段比对 */
  async selfCheck(id: string): Promise<ProbeResult & { issues: Issue[] }> {
    const { profiles } = this.deps;
    const { preset } = profiles.findConfig(id);
    const result = await this.deps.manager.probe(id, preset);
    this.deps.audit.log('profile.selfcheck', id, {
      ok: result.ok,
      mismatches: result.mismatches,
    });
    return { ...result, issues: [] };
  }

  /**
   * 外部脚本执行入口（HTTP `POST /api/profiles/:id/run-script`）。
   *
   * 为什么是 HTTP 而不是给一个 CDP / WS 链接：Camoufox 是 Firefox，走 Juggler，
   * 没有 CDP；而 Camoufox 的 `launchServer()` 明确不支持 persistent context
   * （见 camoufox/dist/server.d.ts），我们的环境都是 persistent —— 所以
   * 「把浏览器挂到 websocket 上让外部连」这条路在本引擎上不成立。
   * 能做的是反过来：外部把脚本交给已经启动的环境去跑，结果回传 JSON。
   *
   * 两种模式：
   * - `page`：脚本是**页面上下文**里的表达式，能读 DOM/window，不能导航或点击；
   * - `playwright`：脚本是 **async 函数体**，形参 `page`（Playwright Page）与 `ctx`，
   *   能 goto / click / fill / 抓数据，是采集脚本的正常用法。
   *
   * 环境没运行且没显式关掉 autoStart 时会先启动（启动耗时单独回传）。
   * 脚本自身报错不算接口错误：返回 `ok:false` + 错误文案，HTTP 层用 422 区分。
   */
  async runScript(id: string, input: RunScriptInput): Promise<RunScriptResult> {
    const profile = this.deps.profiles.findOrThrow(id);
    let launchMs: number | undefined;

    if (!this.deps.manager.isRunning(id)) {
      if (input.autoStart === false) throw conflict(`环境未运行：${profile.name}`);
      const started = await this.start(id, { reason: 'manual' });
      launchMs = started.elapsedMs;
    }

    const page = await this.deps.manager.page(id);
    const mode: ScriptMode = input.mode ?? 'page';
    const timeoutMs = input.timeoutMs ?? 30_000;
    const scriptStartedAt = Date.now();

    try {
      const result = await execScript(page, input.script, mode, timeoutMs, {
        profileId: profile.id,
        name: profile.name,
      });
      const elapsedMs = Date.now() - scriptStartedAt;
      let screenshot: string | undefined;
      if (input.screenshot) {
        screenshot = await this.saveScriptShot(profile.id, page).catch(() => undefined);
      }
      // 脚本内容不落审计：里面可能有账号/接口参数，只记规模与结果
      this.deps.audit.log('profile.script.ok', id, {
        mode,
        elapsedMs,
        launchMs: launchMs ?? null,
        bytes: input.script.length,
      });
      return {
        ok: true,
        mode,
        result,
        elapsedMs,
        ...(launchMs !== undefined ? { launchMs } : {}),
        ...(screenshot ? { screenshot } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const elapsedMs = Date.now() - scriptStartedAt;
      this.deps.audit.log('profile.script.failed', id, {
        mode,
        elapsedMs,
        launchMs: launchMs ?? null,
        error: message.slice(0, 300),
      });
      return {
        ok: false,
        mode,
        error: message,
        elapsedMs,
        ...(launchMs !== undefined ? { launchMs } : {}),
      };
    }
  }

  /** 脚本执行后的留证截图，落在 screenshots/automation/ 下，走既有 /files 路由 */
  private async saveScriptShot(profileId: string, page: PageLike): Promise<string> {
    const dir = path.join(this.deps.paths.home, 'screenshots', 'automation');
    fs.mkdirSync(dir, { recursive: true });
    const name = `${profileId}-${Date.now()}.png`;
    const file = path.join(dir, name);
    await page.screenshot({ path: file });
    return path.posix.join('screenshots', 'automation', name);
  }

  /**
   * 崩溃恢复：上一次进程没能正常退出时，DB 里会留下 ended_at 为空的记录。
   * 这里只做确定性清理——不接管，因为新进程拿不到旧句柄。
   */
  reconcile(): Array<{ profileId: string; pid: number | null; action: 'killed' | 'closed' }> {
    const { profiles, launches, audit } = this.deps;
    const out: Array<{ profileId: string; pid: number | null; action: 'killed' | 'closed' }> = [];

    for (const open of profiles.openLaunches()) {
      const alive = open.pid ? isAlive(open.pid) : false;
      if (alive && open.pid) {
        try {
          process.kill(open.pid, 'SIGTERM');
        } catch {
          // 权限不足或已退出，忽略
        }
      }
      launches.end(open.id, { error: alive ? 'orphan-reaped' : 'orphan-dead' });
      profiles.setStatus(open.profile_id, 'idle');
      audit.log('profile.reconcile', open.profile_id, { pid: open.pid, alive });
      out.push({ profileId: open.profile_id, pid: open.pid, action: alive ? 'killed' : 'closed' });
    }
    return out;
  }

  async shutdown(): Promise<void> {
    // 等在途启动落定，免得关服务时留下"启动中就退出"的半截记录
    await Promise.allSettled([...this.inflight.values()]);
    this.inflight.clear();
    await this.deps.manager.shutdown();
    for (const [id, launchId] of this.running) {
      this.deps.launches.end(launchId, { error: 'app-shutdown' });
      this.deps.profiles.setStatus(id, 'idle');
    }
    this.running.clear();
  }

  remove(id: string): void {
    const profile = this.deps.profiles.findOrThrow(id);
    if (this.deps.manager.isRunning(id)) throw conflict(`环境正在运行，请先关闭: ${profile.name}`);
    this.deps.profiles.softDelete(id);
    this.deps.audit.log('profile.delete', id, {});
  }

  /**
   * 离线校验：不复用运行中的实例，只拿库里固化的 preset 走一遍规则。
   * 界面上"这个指纹为什么可信"就靠它——不需要先花 5 秒启动一个浏览器。
   */
  validate(id: string): { ok: boolean; issues: Issue[]; checkedAt: number } {
    const { profiles, proxies } = this.deps;
    const profile = profiles.findOrThrow(id);
    const { preset } = profiles.findConfig(id);
    const proxy = profile.proxyId ? proxies.resolve(profile.proxyId) : undefined;
    const issues = validatePreset(preset, {
      proxyCountry: proxy?.lastCheckCountry ?? proxy?.expectedCountry ?? undefined,
      hostOs: hostOsFamily(),
    });
    return { ok: !hasBlockingIssue(issues), issues, checkedAt: Date.now() };
  }

  /**
   * 批量动作。
   *
   * 逐条返回结果而不是整体成败：10 个环境里 1 个代理挂了，
   * 不该让另外 9 个也白等一轮；界面需要知道具体是哪一条出的问题。
   */
  async batch(input: BatchInput): Promise<BatchResult> {
    const ids = [...new Set(input.ids)];
    const limit = input.action === 'start' ? START_CONCURRENCY : 6;
    const succeeded: string[] = [];
    const failed: BatchFailure[] = [];

    await runWithConcurrency(ids, limit, async (id) => {
      try {
        switch (input.action) {
          case 'start':
            await this.start(id);
            break;
          case 'stop':
            await this.stop(id);
            break;
          case 'delete':
            this.remove(id);
            break;
          case 'move':
            this.update(id, { groupId: input.groupId ?? null });
            break;
        }
        succeeded.push(id);
      } catch (error) {
        const name = this.safeName(id);
        const code = error instanceof AppError ? error.code : 'INTERNAL';
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ id, name, error: message, code });
      }
    });

    this.deps.audit.log('profile.batch', null, {
      action: input.action,
      total: ids.length,
      ok: succeeded.length,
      failed: failed.length,
    });

    return { action: input.action, total: ids.length, succeeded, failed };
  }

  private safeName(id: string): string | null {
    try {
      return this.deps.profiles.findOrThrow(id).name;
    } catch {
      return null;
    }
  }
}

/** 同时拉起太多浏览器会把内存打满，顺序启动则让用户等太久 */
const START_CONCURRENCY = 3;

export type BatchAction = 'start' | 'stop' | 'delete' | 'move';

export interface BatchInput {
  action: BatchAction;
  ids: string[];
  groupId?: string | null;
}

export interface BatchFailure {
  id: string;
  name: string | null;
  error: string;
  code: string;
}

export interface BatchResult {
  action: BatchAction;
  total: number;
  succeeded: string[];
  failed: BatchFailure[];
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index]!);
    }
  });
  await Promise.all(lanes);
}

export class ProfileValidationError extends Error {
  constructor(public readonly issues: Issue[]) {
    super(
      `指纹一致性校验未通过：\n${issues
        .filter((i) => i.severity === 'error')
        .map((i) => `  [${i.rule}] ${i.message}`)
        .join('\n')}`,
    );
    this.name = 'ProfileValidationError';
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 在页面上下文的表达式 vs 完整 Playwright 脚本之间分派。
 *
 * `playwright` 模式用 `new Function` 把脚本文本包成 async 函数：
 * 外部不用装 Node 依赖、不用关心浏览器的连接方式，把「一个 async 函数体」POST 进来即可。
 * 代价是脚本在我们进程里执行——这是本地单用户工具，且接口本来就需要 Bearer token，
 * 与 `POST /api/tasks` 的 `eval` 步骤是同一级别的信任假设。
 */
async function execScript(
  page: PageLike,
  script: string,
  mode: ScriptMode,
  timeoutMs: number,
  ctxInfo: { profileId: string; name: string },
): Promise<unknown> {
  if (mode === 'page') {
    return withScriptTimeout(
      Promise.resolve(page.evaluate(script)),
      timeoutMs,
      `页面脚本超时（${timeoutMs}ms）`,
    );
  }

  let body: (page: PageLike, ctx: typeof ctxInfo) => Promise<unknown>;
  try {
    // 换行是故意的：脚本以 // 注释结尾时，不换行会把闭合花括号注释掉
    body = new Function('page', 'ctx', `return (async () => {\n${script}\n})();`) as typeof body;
  } catch (error) {
    throw badRequest(`脚本语法错误：${error instanceof Error ? error.message : String(error)}`);
  }
  const ctx = { ...ctxInfo, timeoutMs };
  return withScriptTimeout(body(page, ctx), timeoutMs, `脚本执行超时（${timeoutMs}ms）`);
}

function withScriptTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AppError(message, 504, 'SCRIPT_TIMEOUT')), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
