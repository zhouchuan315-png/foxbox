import { newId } from '../db/ids.ts';
import { badRequest, notFound } from '../errors.ts';
import type { PageLike } from '../engines/types.ts';
import type { EngineManager } from '../engines/manager.ts';
import type { Profile, ProbeRule, SessionJob, SessionProbe, SessionStatus } from '../../shared/types.ts';
import type { SessionRepo } from '../repositories/session.repo.ts';
import type { ProfileRepo } from '../repositories/profile.repo.ts';
import type { AuditRepo } from '../repositories/audit.repo.ts';
import type { ProfileService } from './profile.service.ts';
import type { NotifyService } from './notify.service.ts';

export interface SessionDeps {
  sessions: SessionRepo;
  profiles: ProfileRepo;
  profileService: ProfileService;
  manager: EngineManager;
  audit: AuditRepo;
  notify: NotifyService;
}

export interface RunInput {
  url: string;
  rule: ProbeRule;
  profileIds?: string[];
  groupId?: string | null;
  /** 保存成可复用的探针；不保存也能跑（临时检测） */
  saveProbe?: boolean;
  name?: string;
  timeoutMs?: number;
  concurrency?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_CONCURRENCY = 3;
const MAX_KEPT_JOBS = 20;

/**
 * 会话巡检。
 *
 * 只回答一个问题：这个环境现在还能不能看到「登录后才可见」的页面。
 * 判断依据必须是页面本身，不能是 Cookie 的过期时间——理由见 TECH/MVP2 §4.3.1。
 */
export class SessionService {
  private readonly jobs = new Map<string, { job: SessionJob; controller: AbortController }>();

  constructor(private readonly deps: SessionDeps) {}

  listProbes(): SessionProbe[] {
    return this.deps.sessions.listProbes();
  }

  recentChecks(limit = 50, profileId?: string) {
    return this.deps.sessions.recentChecks(limit, profileId);
  }

  history(profileId: string): ReturnType<SessionRepo['history']> {
    return this.deps.sessions.history(profileId, 10);
  }

  /**
   * 列表页顶部的汇总。
   *
   * `never` 单独统计：从没检测过 ≠ 检测不出来。混在一起会让人以为
   * 「所有环境都有问题」，而其实只是还没跑过。
   */
  overview(): { alive: number; expired: number; unknown: number; never: number; total: number } {
    const profiles = this.deps.profiles.list({ limit: 1000 });
    const out = { alive: 0, expired: 0, unknown: 0, never: 0, total: profiles.length };
    for (const profile of profiles) {
      const status = profile.lastSessionStatus;
      if (status === 'alive') out.alive += 1;
      else if (status === 'expired') out.expired += 1;
      else if (status === 'unknown') out.unknown += 1;
      else out.never += 1;
    }
    return out;
  }

  createProbe(input: {
    name?: string;
    url: string;
    rule: ProbeRule;
    profileId?: string | null;
    groupId?: string | null;
    intervalHours?: number | null;
  }): SessionProbe {
    const url = assertUrl(input.url);
    const rule = assertRule(input.rule);
    if (Boolean(input.profileId) === Boolean(input.groupId)) {
      throw badRequest('探针必须绑定到「一个环境」或「一个分组」，二者只能选一个');
    }
    const existing = this.deps.sessions.findProbeByShape(url, rule);
    if (existing) return existing;

    return this.deps.sessions.insertProbe(
      {
        id: newId(),
        name: input.name?.trim() || new URL(url).host || '会话探针',
        profileId: input.profileId ?? null,
        groupId: input.groupId ?? null,
        url,
        rule,
        intervalHours: input.intervalHours ?? null,
      },
      Date.now(),
    );
  }

  removeProbe(id: string): void {
    if (!this.deps.sessions.findProbe(id)) throw notFound(`探针不存在: ${id}`);
    this.deps.sessions.removeProbe(id);
  }

  getJob(id: string): SessionJob {
    const hit = this.jobs.get(id);
    if (!hit) throw notFound(`巡检任务不存在: ${id}`);
    return hit.job;
  }

  cancelJob(id: string): SessionJob {
    const hit = this.jobs.get(id);
    if (!hit) throw notFound(`巡检任务不存在: ${id}`);
    hit.controller.abort();
    return hit.job;
  }

  /**
   * 发起一次巡检，立即返回 job（进度靠轮询）。
   *
   * 同步等待在这里是错的：50 个环境要跑两三分钟，HTTP 请求早超时了。
   */
  run(input: RunInput): SessionJob {
    const url = assertUrl(input.url);
    const rule = assertRule(input.rule);
    const targets = this.resolveTargets(input);

    const job: SessionJob = {
      id: newId(),
      status: 'running',
      total: targets.length,
      done: 0,
      startedAt: Date.now(),
      endedAt: null,
      summary: { alive: 0, expired: 0, unknown: 0, skipped: 0 },
      results: [],
      error: null,
    };
    const controller = new AbortController();
    this.jobs.set(job.id, { job, controller });
    this.pruneJobs();

    // 探针要么挂在一个环境上，要么挂在一个分组上。多选了几个不相干的环境时
    // 保存不了（那也不该保存），退化成一次性检测。
    let probeId: string | null = null;
    if (input.saveProbe && (targets.length === 1 || input.groupId)) {
      probeId = this.createProbe({
        name: input.name,
        url,
        rule,
        profileId: targets.length === 1 ? targets[0]!.id : null,
        groupId: targets.length === 1 ? null : (input.groupId ?? null),
      }).id;
    }

    void this.execute(job, targets, { url, rule, probeId, timeoutMs: input.timeoutMs }, controller.signal).catch(
      (error: unknown) => {
        job.status = 'done';
        job.error = error instanceof Error ? error.message : String(error);
        job.endedAt = Date.now();
      },
    );

    return job;
  }

  private resolveTargets(input: RunInput): Profile[] {
    if (input.profileIds && input.profileIds.length > 0) {
      const out: Profile[] = [];
      for (const id of input.profileIds) {
        const profile = this.deps.profiles.find(id);
        if (profile) out.push(profile);
      }
      return out;
    }
    if (input.groupId) return this.deps.profiles.list({ groupId: input.groupId, limit: 500 });
    return this.deps.profiles.list({ limit: 500 });
  }

  private async execute(
    job: SessionJob,
    targets: Profile[],
    opts: { url: string; rule: ProbeRule; probeId: string | null; timeoutMs?: number },
    signal: AbortSignal,
  ): Promise<void> {
    const concurrency = DEFAULT_CONCURRENCY;

    await runWithConcurrency(targets, concurrency, async (profile) => {
      if (signal.aborted) {
        job.summary.skipped += 1;
        job.done += 1;
        job.results.push({ profileId: profile.id, profileName: profile.name, status: 'skipped', detail: '已取消', elapsedMs: 0 });
        return;
      }

      const started = Date.now();
      const outcome = await this.checkOne(profile, opts.url, opts.rule, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const elapsedMs = Date.now() - started;

      // 结果先落库再更新 job：即使进程此刻挂掉，事实也已经留下了
      this.deps.sessions.insertCheck(
        {
          id: newId(),
          probeId: opts.probeId,
          profileId: profile.id,
          status: outcome.status,
          detail: outcome.detail,
          elapsedMs,
        },
        Date.now(),
      );
      const previous = this.deps.sessions.lastStatus(profile.id);
      this.deps.sessions.setProfileSession(profile.id, outcome.status, Date.now());
      this.deps.audit.log('session.check', profile.id, {
        jobId: job.id,
        status: outcome.status,
        elapsedMs,
        detail: outcome.detail,
      });

      // 边沿触发：连续 expired 只算一次事件。电平触发会让每天一条重复消息，
      // 用户第二天就把通知关掉，然后真出事也收不到。
      if (previous !== 'expired' && outcome.status === 'expired') {
        this.deps.audit.log('session.expired', profile.id, { profile: profile.name, detail: outcome.detail });
        // 只在这一刻通知。连续 5 次 expired 只发一条，否则每天一条重复消息，
        // 用户第三天就把通知关掉，然后真出事也收不到（与代理巡检同一套边沿逻辑）。
        this.deps.notify.emit('session.expired', {
          title: profile.name,
          detail: `${profile.name}：${outcome.detail ?? '登录态已失效'}`,
          key: `session:${profile.id}`,
        });
      }

      job.summary[outcome.status] += 1;
      job.done += 1;
      job.results.push({
        profileId: profile.id,
        profileName: profile.name,
        status: outcome.status,
        detail: outcome.detail,
        elapsedMs,
      });
    });

    job.status = signal.aborted ? 'cancelled' : 'done';
    job.endedAt = Date.now();
    this.deps.audit.log('session.run', null, {
      jobId: job.id,
      total: job.total,
      ...job.summary,
    });
  }

  /**
   * 单个环境的一次检测。
   *
   * 判定顺序写死，因为顺序本身就是规则：先排除「打不开」，再判「打开之后看到了什么」。
   * 反过来做的话，代理挂掉会被判成掉登录。
   */
  private async checkOne(
    profile: Profile,
    rawUrl: string,
    rule: ProbeRule,
    timeoutMs: number,
  ): Promise<{ status: SessionStatus; detail: string | null }> {
    const profileId = profile.id;
    const wasRunning = this.deps.manager.isRunning(profileId);
    const target = new URL(rawUrl);
    let page: PageLike | null = null;
    let startedByUs = false;

    try {
      if (!wasRunning) {
        // reason=session：不刷 last_opened_at，审计也不记成「用户打开了环境」
        await this.deps.profileService.start(profileId, { reason: 'session' });
        startedByUs = true;
      }
      // 已开着：开独立标签页，不碰用户正在看的页面，也不抢焦点
      page = startedByUs ? await this.deps.manager.page(profileId) : await this.deps.manager.newPage(profileId);

      let response: unknown;
      try {
        response = await withTimeout(
          page.goto(rawUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs }),
          timeoutMs + 2_000,
          '页面打开超时',
        );
      } catch (error) {
        return { status: 'unknown', detail: `打不开：${shortError(error)}` };
      }

      const finalUrl = safeUrl(page);
      const finalHost = hostOf(finalUrl);
      const message = readFailure(response);

      if (finalHost && finalHost !== target.host) {
        // 落在登录域：这是「被规则性地踢去重新登录」，属于 expired
        if (looksLikeLogin(finalUrl)) {
          return { status: 'expired', detail: `被重定向到登录页：${finalUrl}` };
        }
        return { status: 'unknown', detail: `落地到了别的域：${finalHost}` };
      }
      if (message) return { status: 'unknown', detail: message };

      const matched = await evaluateRule(page, rule, finalUrl);
      if (matched) return { status: 'alive', detail: null };
      return { status: 'expired', detail: describeMiss(rule, finalUrl) };
    } catch (error) {
      return { status: 'unknown', detail: `检测失败：${shortError(error)}` };
    } finally {
      if (page && !startedByUs) await page.close().catch(() => undefined);
      if (startedByUs) {
        // 为了看一眼而启动的浏览器要关掉；否则 50 个环境巡检完会留下 50 个进程
        await this.deps.profileService.stop(profileId).catch(() => undefined);
      }
    }
  }

  private pruneJobs(): void {
    if (this.jobs.size <= MAX_KEPT_JOBS) return;
    const sorted = [...this.jobs.entries()].sort((a, b) => a[1].job.startedAt - b[1].job.startedAt);
    for (const [id] of sorted.slice(0, this.jobs.size - MAX_KEPT_JOBS)) {
      if (this.jobs.get(id)?.job.status !== 'running') this.jobs.delete(id);
    }
  }
}

// ───────────────────────────── 工具 ─────────────────────────────

function assertUrl(raw: string): string {
  const url = (raw ?? '').trim();
  if (!url) throw badRequest('探针缺少 url');
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('protocol');
    return parsed.toString();
  } catch {
    throw badRequest(`探针 url 不合法（需要 http/https）: ${raw}`);
  }
}

function assertRule(rule: ProbeRule): ProbeRule {
  if (!rule || typeof rule !== 'object') throw badRequest('探针缺少判定规则');
  if (rule.type === 'selector') {
    if (!rule.selector?.trim()) throw badRequest('selector 规则缺少选择器');
    return { type: 'selector', selector: rule.selector.trim(), visible: rule.visible === true };
  }
  if (rule.type === 'url') {
    if (!rule.mustNotMatch?.trim()) throw badRequest('url 规则缺少 mustNotMatch');
    // 录入时就把正则编译一次：等到巡检时才炸，用户根本不知道该改哪
    try {
      new RegExp(rule.mustNotMatch);
    } catch {
      throw badRequest(`url 规则不是合法正则: ${rule.mustNotMatch}`);
    }
    return { type: 'url', mustNotMatch: rule.mustNotMatch };
  }
  if (rule.type === 'script') {
    if (!rule.script?.trim()) throw badRequest('script 规则缺少脚本');
    return { type: 'script', script: rule.script };
  }
  throw badRequest(`不支持的规则类型: ${(rule as { type?: string }).type ?? '?'}`);
}

async function evaluateRule(page: PageLike, rule: ProbeRule, finalUrl: string): Promise<boolean> {
  if (rule.type === 'url') {
    return !new RegExp(rule.mustNotMatch).test(finalUrl);
  }
  if (rule.type === 'selector') {
    const selector = JSON.stringify(rule.selector);
    const script = rule.visible
      ? `(function(){var el=document.querySelector(${selector});return !!(el && el.getClientRects().length);})()`
      : `!!document.querySelector(${selector})`;
    return Boolean(await page.evaluate(script));
  }
  return Boolean(await page.evaluate(rule.script));
}

/** Playwright 的 goto 在 4xx/5xx 时不抛错，只把 Response 返回；这里读它的状态码 */
function readFailure(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null;
  const fn = (response as { status?: () => number }).status;
  if (typeof fn !== 'function') return null;
  try {
    const status = fn.call(response);
    if (status >= 500) return `目标站点返回 ${status}（站点自身故障，不代表登录态）`;
    if (status === 0) return '没有拿到响应';
    return null;
  } catch {
    return null;
  }
}

function describeMiss(rule: ProbeRule, finalUrl: string): string {
  if (rule.type === 'selector') return `页面上找不到 ${rule.selector}`;
  if (rule.type === 'url') return `落地地址匹配了「未登录」特征：${finalUrl}`;
  return '判定脚本返回 false';
}

function looksLikeLogin(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (/^(login|passport|accounts?|auth|sso|signin)\./i.test(parsed.host)) return true;
    return /\/(login|signin|sign-in|auth|sso|passport)(\/|$|\?)/i.test(parsed.pathname + parsed.search);
  } catch {
    return false;
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function safeUrl(page: PageLike): string {
  try {
    return page.url();
  } catch {
    return '';
  }
}

function shortError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0]?.slice(0, 160) ?? '未知错误';
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

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const lanes = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(lanes);
}
