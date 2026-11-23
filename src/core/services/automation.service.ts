import { newId } from '../db/ids.ts';
import { badRequest } from '../errors.ts';
import { describeCron, nextRunAt, nextRuns, parseCron, type CronSpec } from '../automation/cron.ts';
import type { AuditRepo } from '../repositories/audit.repo.ts';
import type { AutomationRepo } from '../repositories/automation.repo.ts';
import type { ProfileRepo } from '../repositories/profile.repo.ts';
import type { ProxyRepo } from '../repositories/proxy.repo.ts';
import type { TaskRepo } from '../repositories/task.repo.ts';
import type { EngineManager } from '../engines/manager.ts';
import type { ProfileService } from './profile.service.ts';
import type { ProxyCheckResult, ProxyService } from './proxy.service.ts';
import type { TaskService } from './task.service.ts';
import type { NotifyService } from './notify.service.ts';
import type {
  Automation,
  AutomationAction,
  AutomationKind,
  AutomationRun,
  AutomationRunStatus,
  AutomationSpec,
  AutomationTrigger,
  ProxySummary,
  TaskResult,
} from '../../shared/types.ts';

export interface AutomationDeps {
  automations: AutomationRepo;
  tasks: TaskRepo;
  audit: AuditRepo;
  profiles: ProfileRepo;
  proxies: ProxyRepo;
  profileService: ProfileService;
  proxyService: ProxyService;
  taskService: TaskService;
  manager: EngineManager;
  notify: NotifyService;
}

export interface CreateAutomationInput {
  name: string;
  kind: AutomationKind;
  spec: AutomationSpec;
  actions: AutomationAction[];
  enabled?: boolean;
}

export interface UpdateAutomationInput {
  name?: string;
  spec?: AutomationSpec;
  actions?: AutomationAction[];
  enabled?: boolean;
}

/** 一次触发的即时结论；任务型的结果会稍后由任务回调补写 */
export interface FireOutcome {
  automationId: string;
  trigger: AutomationTrigger;
  status: AutomationRunStatus;
  detail: string;
  taskId: string | null;
}

export interface SchedulerState {
  running: boolean;
  tickMs: number;
  ticking: boolean;
  inflight: string[];
  lastTickAt: number | null;
  nextWakeAt: number | null;
}

const MAX_ACTIONS = 3;
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 1440;
const MAX_THRESHOLD = 10;
/** 启动后第一次巡检的延迟：让引擎预热先把 CPU 让出来 */
const FIRST_WATCH_DELAY_MS = 30_000;
/** 重启后只有错开这么久的才算"错过"，避免把几十秒的抖动也记成一条 */
const MISSED_WINDOW_MS = 60_000;

/**
 * 自动化服务：定时 + 事件钩子。
 *
 * 三条刻意的取舍：
 *
 * 1. **不补跑**。服务关了两小时，开机后不是把那 12 次一起补上——那只会让同一批
 *    环境在几分钟内被反复启停。只记一条「错过」，然后从当前时刻接着算。
 * 2. **心跳不落历史**。代理巡检没异常是常态，每次都写一行会把真正的事件埋掉；
 *    只有「跨过阈值」和「恢复」才留记录，其余只推进时间。
 * 3. **到点不 await 任务**。一条任务是几十秒到几分钟的事，调度循环必须立刻处理
 *    下一条规则；任务结果由回调回写，不阻塞 tick。
 */
export class AutomationService {
  private timer: NodeJS.Timeout | null = null;
  private tickMs = 20_000;
  private ticking = false;
  private readonly inflight = new Set<string>();
  private lastTickAt: number | null = null;

  constructor(private readonly deps: AutomationDeps) {}

  // ---------------------------------------------------------------- CRUD

  list(): Automation[] {
    return this.deps.automations.list().map((a) => this.decorate(a));
  }

  get(id: string): Automation {
    return this.decorate(this.deps.automations.findOrThrow(id));
  }

  /** 出库前补上人话描述：cron 的解析只在后端有一份 */
  private decorate(automation: Automation): Automation {
    if (automation.kind === 'cron') {
      const spec = safeParseCron(automation.spec);
      return { ...automation, describe: spec ? describeCron(spec) : '表达式无法解析' };
    }
    const spec = automation.spec as { intervalMinutes?: number; failThreshold?: number };
    return {
      ...automation,
      describe: `每 ${spec.intervalMinutes ?? 10} 分钟巡检 · 连续失败 ${spec.failThreshold ?? 2} 次触发`,
    };
  }

  create(input: CreateAutomationInput): Automation {
    const name = input.name?.trim();
    if (!name) throw badRequest('规则名不能为空');

    const kind = input.kind;
    if (kind !== 'cron' && kind !== 'proxy_watch') throw badRequest(`不支持的规则类型: ${String(kind)}`);

    const spec = normalizeSpec(kind, input.spec);
    const actions = normalizeActions(input.actions);
    if (actions.length === 0) throw badRequest('至少要有一个动作');
    if (actions.length > MAX_ACTIONS) throw badRequest(`动作过多（上限 ${MAX_ACTIONS}）`);
    this.assertRefs(actions);
    // 定时规则如果没有 run_task，到点只会写一行"没事可做"，那是配置错误而非用法
    if (kind === 'cron' && !actions.some((a) => a.type === 'run_task')) {
      throw badRequest('定时规则需要一个「跑任务」动作，否则到点没有事情可做');
    }

    const now = Date.now();
    const enabled = input.enabled !== false;
    const nextRunAt = enabled ? initialRunAt(kind, spec, now) : null;

    const automation = this.deps.automations.insert(
      { id: newId(), name, kind, spec, actions, enabled, nextRunAt },
      now,
    );
    this.deps.audit.log('automation.create', null, {
      automationId: automation.id,
      kind,
      name,
      actions: actions.map((a) => a.type),
      nextRunAt,
    });
    return this.decorate(automation);
  }

  update(id: string, patch: UpdateAutomationInput): Automation {
    const current = this.get(id);
    const name = patch.name === undefined ? undefined : patch.name.trim();
    if (name !== undefined && !name) throw badRequest('规则名不能为空');

    const spec = patch.spec === undefined ? undefined : normalizeSpec(current.kind, patch.spec);
    const actions = patch.actions === undefined ? undefined : normalizeActions(patch.actions);
    if (actions !== undefined) {
      if (actions.length === 0) throw badRequest('至少要有一个动作');
      if (actions.length > MAX_ACTIONS) throw badRequest(`动作过多（上限 ${MAX_ACTIONS}）`);
      this.assertRefs(actions);
    }

    // 改了表达式、或从停用切回启用，都要重算下一次——否则会沿用旧的到期时间
    let nextRunAt: number | null | undefined;
    if (patch.enabled === false) nextRunAt = null;
    else if (patch.enabled === true || spec !== undefined) {
      nextRunAt = initialRunAt(current.kind, spec ?? current.spec, Date.now());
    }

    const updated = this.deps.automations.update(id, { name, spec, actions, enabled: patch.enabled, nextRunAt });
    this.deps.audit.log('automation.update', null, { automationId: id, fields: Object.keys(patch) });
    return this.decorate(updated);
  }

  remove(id: string): void {
    this.get(id);
    this.deps.automations.remove(id);
    this.deps.audit.log('automation.delete', null, { automationId: id });
  }

  runs(id: string, limit = 20): AutomationRun[] {
    this.get(id);
    return this.deps.automations.runs(id, limit);
  }

  /** 界面上的「接下来三次」；纯计算，不落库 */
  preview(expr: string): { expr: string; human: string; next: number[] } {
    const spec = parseCronOrThrow(expr);
    return { expr: spec.expr, human: describeCron(spec), next: nextRuns(spec, Date.now(), 3) };
  }

  // ---------------------------------------------------------------- 调度

  start(tickMs = 20_000): void {
    if (this.timer) return;
    this.tickMs = Math.max(1000, tickMs);
    this.resync();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickMs);
    // 不为这个心跳拖着进程不让退出
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 启动时重排。
   *
   * 库里的 next_run_at 可能是几天前写的，照原样跑会立刻触发一串；
   * 这里统一按"现在"重算，并把明显错过的那次记成 skipping——
   * 让用户知道服务当时没在，而不是以为它一直在跑。
   */
  resync(now = Date.now()): { rescheduled: number; missed: number } {
    let rescheduled = 0;
    let missed = 0;

    for (const automation of this.deps.automations.list()) {
      if (!automation.enabled) {
        if (automation.nextRunAt !== null) this.deps.automations.reschedule(automation.id, null);
        continue;
      }

      const wasMissed = automation.nextRunAt !== null && automation.nextRunAt < now - MISSED_WINDOW_MS;
      const next = safeNext(automation, now);
      this.deps.automations.reschedule(automation.id, next);
      rescheduled++;

      if (wasMissed) {
        missed++;
        const runId = this.deps.automations.addRun(
          { automationId: automation.id, trigger: automation.kind === 'cron' ? 'cron' : 'watch' },
          now,
        );
        this.deps.automations.finishRun(runId, {
          status: 'skipped',
          detail: '服务未运行，这次触发已跳过（不补跑）',
        });
      }
    }

    return { rescheduled, missed };
  }

  /**
   * 一次调度心跳。
   *
   * now 可注入：验收脚本要验"到点会不会跑"，不能真的等一分钟。
   */
  async tick(now = Date.now()): Promise<FireOutcome[]> {
    if (this.ticking) return [];
    this.ticking = true;
    this.lastTickAt = now;
    const outcomes: FireOutcome[] = [];

    try {
      for (const automation of this.deps.automations.due(now)) {
        if (!automation.enabled || this.inflight.has(automation.id)) continue;
        outcomes.push(await this.fire(automation, automation.kind === 'cron' ? 'cron' : 'watch', now));
      }
    } finally {
      this.ticking = false;
    }

    return outcomes;
  }

  /** 界面点「立即运行」：触发一次，不改动原有节奏 */
  async runNow(id: string): Promise<FireOutcome> {
    const automation = this.get(id);
    return this.fire(automation, 'manual', Date.now());
  }

  state(): SchedulerState {
    return {
      running: this.timer !== null,
      tickMs: this.tickMs,
      ticking: this.ticking,
      inflight: [...this.inflight],
      lastTickAt: this.lastTickAt,
      nextWakeAt: this.deps.automations.earliestNextRun(),
    };
  }

  /** 进程重启后清掉永远停在"执行中"的历史行 */
  reconcile(now = Date.now()): number {
    return this.deps.automations.closeOrphanRuns('进程重启，本次触发已中断', now);
  }

  // ---------------------------------------------------------------- 触发

  private async fire(automation: Automation, trigger: AutomationTrigger, now: number): Promise<FireOutcome> {
    this.inflight.add(automation.id);
    try {
      return automation.kind === 'cron'
        ? this.fireCron(automation, trigger, now)
        : await this.fireWatch(automation, trigger, now);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.deps.audit.log('automation.fire', null, {
        automationId: automation.id,
        trigger,
        status: 'failed',
        detail,
      });
      return { automationId: automation.id, trigger, status: 'failed', detail, taskId: null };
    } finally {
      this.inflight.delete(automation.id);
    }
  }

  /** 定时：到点把任务推出去，不等它跑完 */
  private fireCron(automation: Automation, trigger: AutomationTrigger, now: number): FireOutcome {
    const { automations, audit } = this.deps;
    const runId = automations.addRun({ automationId: automation.id, trigger }, now);

    const action = automation.actions.find((a) => a.type === 'run_task');
    const task = action && action.type === 'run_task' ? this.deps.tasks.find(action.taskId) : undefined;

    if (!task) {
      const detail = action ? '关联的任务已被删除' : '规则里没有可执行的任务';
      automations.finishRun(runId, { status: 'failed', detail });
      this.advance(automation, trigger, now, 'failed', detail);
      audit.log('automation.fire', null, { automationId: automation.id, trigger, status: 'failed', detail });
      return { automationId: automation.id, trigger, status: 'failed', detail, taskId: null };
    }

    if (task.status === 'running') {
      const detail = `任务「${task.name}」上一次还在执行，本次跳过`;
      automations.finishRun(runId, { status: 'skipped', detail });
      this.advance(automation, trigger, now, 'skipped');
      audit.log('automation.fire', null, { automationId: automation.id, trigger, status: 'skipped', detail });
      return { automationId: automation.id, trigger, status: 'skipped', detail, taskId: task.id };
    }

    // 不 await：一条任务动辄几十秒，等它就把后面的规则全堵住了
    this.deps.taskService
      .run(task.id)
      .then(
        this.concludeTaskRun(runId, task.id),
      )
      .catch((error: unknown) => {
        automations.finishRun(runId, {
          status: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        });
      });

    const detail = `已启动任务「${task.name}」`;
    this.advance(automation, trigger, now, 'ok');
    audit.log('automation.fire', null, { automationId: automation.id, trigger, status: 'ok', detail, taskId: task.id });
    return { automationId: automation.id, trigger, status: 'ok', detail, taskId: task.id };
  }

  /**
   * 代理巡检。
   *
   * 边沿触发：只有 fail_streak 跨过阈值的那一次才算事件。否则一条挂掉的代理
   * 会在每个巡检周期都触发一次动作，把备用代理也一起拖下水。
   */
  private async fireWatch(
    automation: Automation,
    trigger: AutomationTrigger,
    now: number,
  ): Promise<FireOutcome> {
    const { automations, audit } = this.deps;
    const spec = automation.spec as { intervalMinutes?: number; failThreshold?: number; proxyIds?: string[] };
    const threshold = clampInt(spec.failThreshold ?? 2, 1, MAX_THRESHOLD);

    const all = this.deps.proxyService.list();
    const scoped =
      Array.isArray(spec.proxyIds) && spec.proxyIds.length > 0
        ? all.filter((p) => spec.proxyIds!.includes(p.id))
        : all;

    if (scoped.length === 0) {
      const runId = automations.addRun({ automationId: automation.id, trigger }, now);
      const detail = '没有需要巡检的代理（还没建代理，或指定的代理已删除）';
      automations.finishRun(runId, { status: 'skipped', detail });
      this.advance(automation, trigger, now, 'skipped');
      return { automationId: automation.id, trigger, status: 'skipped', detail, taskId: null };
    }

    const tripped: Array<{ proxy: ProxySummary; result: ProxyCheckResult; streak: number }> = [];
    const recovered: string[] = [];

    for (const proxy of scoped) {
      const before = proxy.failStreak;
      let result: ProxyCheckResult;
      try {
        result = await this.deps.proxyService.check(proxy.id);
      } catch {
        continue;
      }
      const after = this.deps.proxies.summaryOrThrow(proxy.id).failStreak;

      if (!result.ok && after >= threshold && before < threshold) {
        tripped.push({ proxy, result, streak: after });
        this.deps.notify.emit('proxy.dead', {
          title: proxy.name,
          detail: `代理 ${proxy.name}（${proxy.host}:${proxy.port}）连续失败 ${after} 次：${result.error ?? '未知原因'}`,
          key: `proxy:${proxy.id}`,
        });
      } else if (result.ok && before >= threshold) {
        recovered.push(proxy.name);
      }
    }

    // 心跳：没跨阈值、也没恢复。只推进时间，不写历史
    if (tripped.length === 0 && recovered.length === 0) {
      if (trigger !== 'manual') {
        automations.touch(automation.id, automation.enabled ? nextRunAtFor(automation, now) : null, now);
      }
      return { automationId: automation.id, trigger, status: 'skipped', detail: '', taskId: null };
    }

    const runId = automations.addRun({ automationId: automation.id, trigger }, now);

    if (tripped.length === 0) {
      const detail = `已恢复：${recovered.join('、')}`;
      automations.finishRun(runId, { status: 'ok', detail });
      this.advance(automation, trigger, now, 'ok');
      audit.log('automation.fire', null, { automationId: automation.id, trigger, status: 'ok', detail });
      return { automationId: automation.id, trigger, status: 'ok', detail, taskId: null };
    }

    const parts = [`代理失效：${tripped.map((t) => `${t.proxy.name}（连续失败 ${t.streak} 次）`).join('、')}`];
    let taskId: string | null = null;

    for (const action of automation.actions) {
      try {
        switch (action.type) {
          case 'switch_proxy':
            parts.push(this.switchProxyFor(tripped, action.standbyProxyId, action.sameCountryOnly !== false));
            break;
          case 'stop_profiles':
            parts.push(await this.stopProfilesFor(tripped));
            break;
          case 'run_task': {
            const task = this.deps.tasks.find(action.taskId);
            if (!task) {
              parts.push('关联任务已删除，未执行');
              break;
            }
            if (task.status === 'running') {
              parts.push(`任务「${task.name}」正在执行，本次未重复启动`);
              break;
            }
            taskId = task.id;
            const prefix = parts.join('；');
            this.deps.taskService
              .run(task.id)
              .then(this.concludeTaskRun(runId, task.id, prefix))
              .catch(() => undefined);
            parts.push(`已启动任务「${task.name}」`);
            break;
          }
          case 'notify_only':
            parts.push('仅记录');
            break;
        }
      } catch (error) {
        parts.push(`${action.type} 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const detail = parts.join('；');
    // 有任务在跑时把收尾交给任务回调，别把"已启动"当最终结果
    if (taskId === null) automations.finishRun(runId, { status: 'ok', detail }, now);
    this.advance(automation, trigger, now, 'ok');
    audit.log('automation.fire', null, {
      automationId: automation.id,
      trigger,
      status: 'ok',
      detail,
      proxies: tripped.map((t) => t.proxy.id),
    });
    return { automationId: automation.id, trigger, status: 'ok', detail, taskId };
  }

  /** 推进下次时间并记下结果；手动触发只更新"上次运行"，不改节奏 */
  private advance(
    automation: Automation,
    trigger: AutomationTrigger,
    now: number,
    status: AutomationRunStatus,
    error: string | null = null,
  ): void {
    if (trigger === 'manual') {
      this.deps.automations.recordManualFire(automation.id, { status, error, at: now });
      return;
    }
    this.deps.automations.recordFire(automation.id, {
      nextRunAt: automation.enabled ? nextRunAtFor(automation, now) : null,
      status,
      error,
      at: now,
    });
  }

  /**
   * 任务跑完后回写这次触发的结果。
   *
   * 不看 `summary.failed`——空目标的任务 summary 里失败数是 0，
   * 但任务本身是失败的（"目标环境为空"）。以库里任务的最终状态为准，
   * 否则界面上会出现一条"成功，0 个目标"记录，比不记录更误导人。
   */
  private concludeTaskRun(runId: string, taskId: string, detailPrefix?: string): (result: TaskResult) => void {
    return (result: TaskResult) => {
      const final = this.deps.tasks.find(taskId);
      const status: AutomationRunStatus =
        final?.status === 'succeeded' ? 'ok' : final?.status === 'cancelled' ? 'skipped' : 'failed';
      const counts =
        result.summary.total === 0
          ? (final?.error ?? '目标环境为空，没有可执行的对象')
          : `${result.summary.total} 个目标：成功 ${result.summary.succeeded}，失败 ${result.summary.failed}`;
      this.deps.automations.finishRun(runId, {
        status,
        detail: detailPrefix ? `${detailPrefix}；${counts}` : counts,
      });
    };
  }

  /**
   * 把引用了失效代理的环境切到备用代理。
   *
   * 同国家是硬约束而不是建议：指纹里的时区与语言是按出口国家固化的，
   * 换到另一个国家等于让环境和 IP 自相矛盾——那比"代理挂了"更难解释，
   * 而且通常要等到站点风控才发现。所以宁可不动，并在记录里写清楚原因。
   */
  private switchProxyFor(
    tripped: Array<{ proxy: ProxySummary }>,
    standbyProxyId: string,
    sameCountryOnly: boolean,
  ): string {
    const standby = this.deps.proxyService.get(standbyProxyId);
    const standbyCountry = standby.lastCheckCountry ?? standby.expectedCountry;
    if (!standbyCountry) {
      return `备用代理「${standby.name}」还没有可用国家信息，未切换`;
    }

    const notes: string[] = [];
    for (const { proxy } of tripped) {
      if (proxy.id === standbyProxyId) {
        notes.push(`「${proxy.name}」本身就是备用代理，跳过`);
        continue;
      }
      const country = proxy.lastCheckCountry ?? proxy.expectedCountry;
      if (sameCountryOnly && country !== standbyCountry) {
        notes.push(
          `「${proxy.name}」(${country ?? '未知'}) 与备用代理 (${standbyCountry}) 国家不同，切换会破坏指纹一致性，未切换`,
        );
        continue;
      }

      const affected = this.deps.profiles.list({ limit: 1000 }).filter((p) => p.proxyId === proxy.id);
      if (affected.length === 0) {
        notes.push(`「${proxy.name}」没有环境在用，无需切换`);
        continue;
      }

      let done = 0;
      for (const profile of affected) {
        try {
          this.deps.profileService.rebindProxy(profile.id, standbyProxyId, `自动化切换：${proxy.name} 失效`);
          done++;
        } catch (error) {
          notes.push(`「${profile.name}」切换失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (done > 0) notes.push(`${done} 个环境已从「${proxy.name}」切到「${standby.name}」`);
    }

    return notes.join('，') || '没有需要切换的环境';
  }

  private async stopProfilesFor(tripped: Array<{ proxy: ProxySummary }>): Promise<string> {
    const stopped: string[] = [];
    for (const { proxy } of tripped) {
      const affected = this.deps.profiles.list({ limit: 1000 }).filter((p) => p.proxyId === proxy.id);
      for (const profile of affected) {
        if (!this.deps.manager.isRunning(profile.id)) continue;
        try {
          await this.deps.profileService.stop(profile.id);
          stopped.push(profile.name);
        } catch {
          /* 单个关不掉不影响其余 */
        }
      }
    }
    return stopped.length > 0
      ? `已关闭 ${stopped.length} 个环境：${stopped.join('、')}`
      : '没有正在运行的环境需要关闭';
  }

  // ---------------------------------------------------------------- 校验

  /** 动作引用的任务 / 代理必须存在。建规则时就挡住，别等到凌晨三点才发现 */
  private assertRefs(actions: AutomationAction[]): void {
    for (const action of actions) {
      if (action.type === 'run_task') {
        if (!action.taskId) throw badRequest('「跑任务」动作缺少 taskId');
        if (!this.deps.tasks.find(action.taskId)) throw badRequest(`任务不存在: ${action.taskId}`);
      }
      if (action.type === 'switch_proxy') {
        if (!action.standbyProxyId) throw badRequest('「切换代理」动作缺少 standbyProxyId');
        this.deps.proxyService.get(action.standbyProxyId);
      }
    }
  }
}

// ---------------------------------------------------------------- 纯函数

function normalizeSpec(kind: AutomationKind, input: AutomationSpec): AutomationSpec {
  if (kind === 'cron') {
    const expr = (input as { expr?: unknown }).expr;
    const spec = parseCronOrThrow(typeof expr === 'string' ? expr : '');
    if (nextRunAt(spec, Date.now()) === null) {
      throw badRequest(`表达式「${spec.expr}」在 5 年内不会触发，请检查日期组合`);
    }
    return { expr: spec.expr };
  }

  const raw = input as { intervalMinutes?: unknown; failThreshold?: unknown; proxyIds?: unknown };
  const intervalMinutes = Number(raw.intervalMinutes);
  if (!Number.isFinite(intervalMinutes)) throw badRequest('巡检间隔必须是数字（分钟）');
  const failThreshold = raw.failThreshold === undefined ? 2 : Number(raw.failThreshold);
  if (!Number.isFinite(failThreshold)) throw badRequest('失败阈值必须是数字');

  const proxyIds = Array.isArray(raw.proxyIds)
    ? [...new Set(raw.proxyIds.filter((v): v is string => typeof v === 'string' && v.length > 0))]
    : [];

  return {
    intervalMinutes: clampInt(intervalMinutes, MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES),
    failThreshold: clampInt(failThreshold, 1, MAX_THRESHOLD),
    ...(proxyIds.length > 0 ? { proxyIds } : {}),
  };
}

function normalizeActions(actions: AutomationAction[] | undefined): AutomationAction[] {
  if (!Array.isArray(actions)) return [];
  return actions.map((action, i) => {
    const at = `第 ${i + 1} 个动作`;
    if (!action || typeof action !== 'object') throw badRequest(`${at}格式错误`);
    switch (action.type) {
      case 'run_task':
        return { type: 'run_task', taskId: String(action.taskId ?? '') };
      case 'switch_proxy':
        return {
          type: 'switch_proxy',
          standbyProxyId: String(action.standbyProxyId ?? ''),
          sameCountryOnly: action.sameCountryOnly !== false,
        };
      case 'stop_profiles':
        return { type: 'stop_profiles' };
      case 'notify_only':
        return { type: 'notify_only' };
      default:
        throw badRequest(`${at}类型不支持: ${String((action as { type?: string }).type)}`);
    }
  });
}

function initialRunAt(kind: AutomationKind, spec: AutomationSpec, now: number): number | null {
  if (kind === 'cron') {
    const parsed = safeParseCron(spec);
    return parsed ? nextRunAt(parsed, now) : null;
  }
  return now + FIRST_WATCH_DELAY_MS;
}

function nextRunAtFor(automation: Automation, now: number): number | null {
  if (automation.kind === 'cron') {
    const spec = safeParseCron(automation.spec);
    return spec ? nextRunAt(spec, now) : null;
  }
  const interval = clampInt(
    Number((automation.spec as { intervalMinutes?: number }).intervalMinutes ?? 10),
    MIN_INTERVAL_MINUTES,
    MAX_INTERVAL_MINUTES,
  );
  return now + interval * 60_000;
}

function safeNext(automation: Automation, now: number): number | null {
  return automation.kind === 'cron' ? nextRunAtFor(automation, now) : now + FIRST_WATCH_DELAY_MS;
}

function safeParseCron(spec: AutomationSpec): CronSpec | null {
  const expr = (spec as { expr?: string }).expr;
  if (!expr) return null;
  try {
    return parseCron(expr);
  } catch {
    return null;
  }
}

function parseCronOrThrow(expr: string): CronSpec {
  try {
    return parseCron(expr);
  } catch (error) {
    throw badRequest(`cron 表达式有误：${error instanceof Error ? error.message : String(error)}`);
  }
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
