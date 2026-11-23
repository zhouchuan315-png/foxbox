import * as fs from 'node:fs';
import * as path from 'node:path';
import { newId } from '../db/ids.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import type { Paths } from '../paths.ts';
import type { EngineManager } from '../engines/manager.ts';
import type { PageLike } from '../engines/types.ts';
import type { TaskRepo } from '../repositories/task.repo.ts';
import type { AuditRepo } from '../repositories/audit.repo.ts';
import type { ProfileRepo } from '../repositories/profile.repo.ts';
import type { ProfileService } from './profile.service.ts';
import type { DatasetService } from './dataset.service.ts';
import type { NotifyService } from './notify.service.ts';
import type {
  ErrorClass,
  Profile,
  StepStatus,
  Task,
  TaskResult,
  TaskRunResult,
  TaskStep,
  TaskStepResult,
  TaskTarget,
} from '../../shared/types.ts';

export interface TaskDeps {
  paths: Paths;
  tasks: TaskRepo;
  audit: AuditRepo;
  profiles: ProfileRepo;
  profileService: ProfileService;
  manager: EngineManager;
  datasets: DatasetService;
  notify: NotifyService;
}

export interface CreateTaskInput {
  name: string;
  target: TaskTarget;
  steps: TaskStep[];
  concurrency?: number;
  /** 整条任务的总时限，默认 10 分钟 */
  timeoutMs?: number;
  /** 只对瞬时错误重试，最多 3 次 */
  retries?: number;
}

/** 单条任务最多 20 步：再多就应该拆成两条，而不是让一条任务跑十分钟没人知道卡在哪 */
const MAX_STEPS = 20;
const MAX_CONCURRENCY = 3;
/** 单步有上限，整条任务也要有：20 步 × 180s 能挂一小时，期间界面一直"执行中" */
const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_TIMEOUT_MS = 3_600_000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5_000;
/** wait 步的上限，避免一个手滑的 0 写成 3600000 把任务挂死 */
const MAX_WAIT_MS = 120_000;

export class TaskService {
  private readonly controllers = new Map<string, AbortController>();
  private readonly active = new Map<string, Promise<TaskResult>>();

  constructor(private readonly deps: TaskDeps) {}

  create(input: CreateTaskInput): Task {
    const name = input.name?.trim();
    if (!name) throw badRequest('任务名不能为空');

    const steps = input.steps ?? [];
    if (steps.length === 0) throw badRequest('任务至少要有一个步骤');
    if (steps.length > MAX_STEPS) throw badRequest(`步骤过多（上限 ${MAX_STEPS}）`);
    steps.forEach((step, i) => assertStep(step, i));

    const target = normalizeTarget(input.target);
    if (!target.groupId && target.profileIds.length === 0) {
      throw badRequest('任务没有目标环境：请指定环境或分组');
    }

    const task = this.deps.tasks.insert(
      {
        id: newId(),
        name,
        target,
        steps,
        concurrency: clamp(input.concurrency ?? 1, 1, MAX_CONCURRENCY),
        timeoutMs: clamp(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, 5_000, MAX_TIMEOUT_MS),
        retries: clamp(input.retries ?? 0, 0, MAX_RETRIES),
      },
      Date.now(),
    );
    this.deps.audit.log('task.create', null, {
      taskId: task.id,
      name,
      steps: steps.map((s) => s.type),
      targets: target.profileIds.length || target.groupId,
    });
    return task;
  }

  get(id: string): Task {
    const task = this.deps.tasks.find(id);
    if (!task) throw notFound(`任务不存在: ${id}`);
    return task;
  }

  list(limit = 50): Task[] {
    return this.deps.tasks.list(limit);
  }

  /**
   * 启动任务并等待完成。
   *
   * API 层是 fire-and-forget（立即返回 202），但脚本与验收需要拿到最终结果，
   * 所以两者共用同一份 promise，重复调用不会重复执行。
   */
  async run(id: string): Promise<TaskResult> {
    const existing = this.active.get(id);
    if (existing) return existing;

    const task = this.get(id);
    if (task.status === 'running') throw conflict('任务正在执行中');

    const controller = new AbortController();
    this.controllers.set(id, controller);

    const promise = this.execute(task, controller.signal).finally(() => {
      this.active.delete(id);
      this.controllers.delete(id);
    });
    this.active.set(id, promise);
    return promise;
  }

  /** 界面点「运行」用：不阻塞 HTTP 请求 */
  launch(id: string): Task {
    if (this.active.has(id)) throw conflict('任务正在执行中');
    const task = this.get(id);
    if (task.status === 'running') throw conflict('任务正在执行中');
    void this.run(id).catch(() => undefined);
    return this.get(id);
  }

  cancel(id: string): Task {
    const controller = this.controllers.get(id);
    if (!controller) throw conflict('任务没有在执行');
    controller.abort();
    this.deps.audit.log('task.cancel', null, { taskId: id });
    return this.get(id);
  }

  remove(id: string): void {
    const task = this.get(id);
    if (task.status === 'running') throw conflict('任务正在执行，无法删除');
    this.deps.tasks.remove(id);

    // 截图是「某次执行」的证据，跟着任务走；数据集里的行不删——
    // 那是用户采到的业务数据，任务只是产生它的过程（见 MVP2 §4.4.4）。
    const dir = path.join(this.deps.paths.home, 'screenshots', id);
    let freed = 0;
    try {
      freed = dirBytes(dir);
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 目录不存在或已被清理 */
    }
    this.deps.audit.log('task.delete', null, { taskId: id, freedBytes: freed });
  }

  async shutdown(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.active.values()]);
  }

  private async execute(task: Task, cancelSignal: AbortSignal): Promise<TaskResult> {
    const { tasks, audit, profiles } = this.deps;
    tasks.markRunning(task.id, Date.now());
    audit.log('task.start', null, { taskId: task.id, name: task.name });

    // 总时限与用户取消走同一条中断路径，但收尾时要用不同的措辞：
    // 一个是「你取消了」，一个是「它超时了」，对使用者是两件事。
    const deadline = AbortSignal.timeout(task.timeoutMs);
    const signal = AbortSignal.any([cancelSignal, deadline]);

    const targets = this.resolveTargets(task.target);
    const runs: TaskRunResult[] = [];

    if (targets.length === 0) {
      const result: TaskResult = {
        runs: [],
        summary: { total: 0, succeeded: 0, failed: 0, skipped: 0 },
      };
      tasks.finish(task.id, { status: 'failed', result, error: '目标环境为空（分组下没有环境）' });
      audit.log('task.failed', null, { taskId: task.id, reason: 'empty-target' });
      return result;
    }

    await runWithConcurrency(targets, task.concurrency, async (profile) => {
      let attempt = 0;
      let run = await this.runOne(task, profile, signal);

      // 只重跑失败的那个目标，不重跑整条任务：并发 3 跑 50 个环境时，
      // 1 个失败就全部重来是双倍浪费，还会把 seen_count 刷虚。
      while (run.status === 'failed' && attempt < task.retries && !signal.aborted && isTransient(run)) {
        attempt += 1;
        await abortableSleep(RETRY_DELAY_MS, signal);
        if (signal.aborted) break;
        const retried = await this.runOne(task, profile, signal);
        retried.attempts = attempt + 1;
        run = retried;
      }

      run.attempts = attempt + 1;
      run.errorClass = run.status === 'failed' ? classifyRun(run) : undefined;
      runs.push(run);
    });
    // 并发完成顺序不稳定，按目标顺序排回来，结果才可复现
    runs.sort(
      (a, b) =>
        targets.findIndex((p) => p.id === a.profileId) - targets.findIndex((p) => p.id === b.profileId),
    );

    const summary = {
      total: runs.length,
      succeeded: runs.filter((r) => r.status === 'succeeded').length,
      failed: runs.filter((r) => r.status === 'failed').length,
      skipped: runs.filter((r) => r.status !== 'succeeded' && r.status !== 'failed').length,
    };
    const result: TaskResult = { runs, summary };

    const timedOut = deadline.aborted && !cancelSignal.aborted;
    const status = cancelSignal.aborted
      ? 'cancelled'
      : summary.failed > 0 || (timedOut && summary.succeeded < summary.total)
        ? 'failed'
        : 'succeeded';

    const errorClass: ErrorClass | undefined = timedOut ? 'timeout' : undefined;
    const error = timedOut ? `任务超时（${Math.round(task.timeoutMs / 1000)}s）` : undefined;

    tasks.finish(task.id, { status, result, error, errorClass });
    audit.log(`task.${status}`, null, { taskId: task.id, ...summary, ...(timedOut ? { reason: 'timeout' } : {}) });

    // 失败才通知，成功不打扰：这类工具一天跑几十次，成功也发一条就成了噪音
    if (status === 'failed') {
      const failedRuns = runs.filter((run) => run.status === 'failed');
      this.deps.notify.emit('task.failed', {
        title: task.name,
        detail:
          `${task.name}：${failedRuns.length} 个目标失败` +
          (failedRuns[0]?.error ? `，首个原因：${failedRuns[0].error}` : '') +
          (timedOut ? `（超时 ${Math.round(task.timeoutMs / 1000)}s）` : ''),
        key: `task:${task.id}`,
      });
    }

    return result;
  }

  private resolveTargets(target: TaskTarget): Profile[] {
    const { profiles } = this.deps;
    if (target.groupId) {
      return profiles.list({ groupId: target.groupId, limit: 500 });
    }
    const out: Profile[] = [];
    for (const id of target.profileIds) {
      const profile = profiles.find(id);
      if (profile) out.push(profile);
    }
    return out;
  }

  private async runOne(task: Task, profile: Profile, signal: AbortSignal): Promise<TaskRunResult> {
    const startedAt = Date.now();
    const run: TaskRunResult = {
      profileId: profile.id,
      profileName: profile.name,
      status: 'succeeded',
      startedAt,
      elapsedMs: 0,
      steps: [],
      vars: {},
      screenshots: [],
    };

    let page: PageLike | null = null;

    for (const [index, step] of task.steps.entries()) {
      if (signal.aborted) {
        run.status = 'cancelled';
        // 剩下的步骤一次性补齐，前端才能画出"从第几步开始没跑"
        for (let rest = index; rest < task.steps.length; rest++) {
          run.steps.push({
            index: rest,
            type: task.steps[rest]!.type,
            status: 'skipped',
            elapsedMs: 0,
            note: '任务已取消',
          });
        }
        break;
      }

      const stepStarted = Date.now();
      const result: TaskStepResult = {
        index,
        type: step.type,
        status: 'ok',
        elapsedMs: 0,
      };

      try {
        switch (step.type) {
          case 'start': {
            if (this.deps.manager.isRunning(profile.id)) {
              result.note = '环境已在运行，复用现有实例';
            } else {
              await this.deps.profileService.start(profile.id);
            }
            break;
          }
          case 'goto': {
            page = await this.ensurePage(profile.id, page);
            const url = renderTemplate(step.url, profile, run.vars, index);
            await page.goto(url, {
              waitUntil: step.waitUntil ?? 'domcontentloaded',
              timeout: step.timeoutMs ?? 30_000,
            });
            result.output = safeUrl(page);
            break;
          }
          case 'wait': {
            await abortableSleep(clamp(step.ms, 0, MAX_WAIT_MS), signal);
            result.note = `等待 ${clamp(step.ms, 0, MAX_WAIT_MS)}ms`;
            break;
          }
          case 'eval': {
            page = await this.ensurePage(profile.id, page);
            const script = renderTemplate(step.script, profile, run.vars, index);
            const value = await withTimeout(
              page.evaluate(script),
              step.timeoutMs ?? 30_000,
              `脚本执行超时（${step.timeoutMs ?? 30_000}ms）`,
            );
            result.output = value;
            if (step.saveAs) run.vars[step.saveAs] = value;
            break;
          }
          /**
           * 采集落表。
           *
           * 与 eval 的差别只在「结果去哪」：脚本语法完全一样，只是这里要求返回数组，
           * 并且结果不是留在任务 JSON 里，而是进数据集。所以没有另发明一套选择器 DSL。
           */
          case 'collect': {
            page = await this.ensurePage(profile.id, page);
            const script = renderTemplate(step.script, profile, run.vars, index);
            const value = await withTimeout(
              page.evaluate(script),
              step.timeoutMs ?? 60_000,
              `采集脚本超时（${step.timeoutMs ?? 60_000}ms）`,
            );

            // 先判「够不够」，再写库：失败时库里必须什么都没变
            const minRows = step.expectMinRows ?? 0;
            if (minRows > 0) {
              const count = Array.isArray(value) ? value.length : 0;
              if (count < minRows) {
                throw new Error(`采到 ${count} 行，少于期望的 ${minRows} 行（expectMinRows）`);
              }
            }

            const receipt = this.deps.datasets.write({
              datasetName: step.dataset,
              dedupeBy: step.dedupeBy,
              mode: step.mode,
              rows: value as unknown[],
              profileId: profile.id,
              taskId: task.id,
            });
            result.collect = receipt;
            result.output = receipt;
            // 0 行是正常业务状态，不是失败：周末没订单、今天没新数据都很常见。
            // 判失败会让定时任务天天报红，一周之内告警就被关掉了。
            if (receipt.written === 0) {
              result.note = `采到 0 行（数据集「${receipt.dataset}」未变化）`;
            } else if (receipt.skipped > 0) {
              result.note = `写入 ${receipt.written} 行，跳过 ${receipt.skipped} 行（判重字段全为空）`;
            }
            break;
          }
          case 'screenshot': {
            page = await this.ensurePage(profile.id, page);
            const relative = this.screenshotPath(task.id, profile.id, index);
            fs.mkdirSync(path.dirname(path.join(this.deps.paths.home, relative)), { recursive: true });
            await page.screenshot({
              path: path.join(this.deps.paths.home, relative),
              fullPage: step.fullPage ?? false,
            });
            run.screenshots.push(relative);
            result.output = relative;
            break;
          }
          case 'stop': {
            if (!this.deps.manager.isRunning(profile.id)) {
              result.note = '环境未在运行，跳过';
            } else {
              await this.deps.profileService.stop(profile.id);
            }
            page = null;
            break;
          }
        }
      } catch (error) {
        result.status = 'failed';
        result.error = error instanceof Error ? error.message : String(error);
        run.status = signal.aborted ? 'cancelled' : 'failed';
        run.error = result.error;
      }

      // 取消发生在步骤执行中间时（例如正在 wait），这一步本身算被打断，
      // 而不是"顺利完成"——否则结果里会出现一条诡异的成功记录
      if (signal.aborted && result.status === 'ok') {
        result.status = 'skipped';
        result.note = '任务已取消';
      }

      result.elapsedMs = Date.now() - stepStarted;
      run.steps.push(result);

      if (result.status === 'failed') {
        // 该目标后续步骤全部标为 skipped：不继续在已知失败的链路上盲跑
        for (let rest = index + 1; rest < task.steps.length; rest++) {
          run.steps.push({
            index: rest,
            type: task.steps[rest]!.type,
            status: 'skipped' as StepStatus,
            elapsedMs: 0,
            note: '前一步失败',
          });
        }
        break;
      }

      if (signal.aborted) {
        run.status = 'cancelled';
        for (let rest = index + 1; rest < task.steps.length; rest++) {
          run.steps.push({
            index: rest,
            type: task.steps[rest]!.type,
            status: 'skipped',
            elapsedMs: 0,
            note: '任务已取消',
          });
        }
        break;
      }
    }

    run.elapsedMs = Date.now() - startedAt;
    return run;
  }

  private async ensurePage(profileId: string, current: PageLike | null): Promise<PageLike> {
    if (current) return current;
    if (!this.deps.manager.isRunning(profileId)) {
      throw new Error('环境未在运行：请在步骤里先加一个 start');
    }
    return this.deps.manager.page(profileId);
  }

  private screenshotPath(taskId: string, profileId: string, index: number): string {
    return path.join('screenshots', taskId, `${profileId}-${String(index).padStart(2, '0')}.png`);
  }
}

function normalizeTarget(input: TaskTarget | undefined): TaskTarget {
  const groupId = input?.groupId?.trim() || null;
  const profileIds = [...new Set((input?.profileIds ?? []).filter((id) => typeof id === 'string' && id))];
  return groupId ? { profileIds: [], groupId } : { profileIds };
}

function assertStep(step: TaskStep, index: number): void {
  const at = `第 ${index + 1} 步`;
  if (!step || typeof step !== 'object') throw badRequest(`${at}格式错误`);
  switch (step.type) {
    case 'start':
    case 'stop':
      return;
    case 'goto':
      if (!step.url?.trim()) throw badRequest(`${at}（goto）缺少 url`);
      return;
    case 'wait':
      if (!Number.isFinite(step.ms) || step.ms < 0) throw badRequest(`${at}（wait）的 ms 必须是非负数字`);
      return;
    case 'eval':
      if (!step.script?.trim()) throw badRequest(`${at}（eval）缺少 script`);
      return;
    case 'collect':
      if (!step.script?.trim()) throw badRequest(`${at}（collect）缺少 script`);
      if (!step.dataset?.trim()) throw badRequest(`${at}（collect）缺少 dataset（数据集名）`);
      if (step.dedupeBy && (!Array.isArray(step.dedupeBy) || step.dedupeBy.some((f) => !String(f).trim()))) {
        throw badRequest(`${at}（collect）的 dedupeBy 必须是非空字符串数组`);
      }
      if (step.mode && step.mode !== 'upsert' && step.mode !== 'append') {
        throw badRequest(`${at}（collect）的 mode 只能是 upsert 或 append`);
      }
      if (step.expectMinRows != null && (!Number.isInteger(step.expectMinRows) || step.expectMinRows < 0)) {
        throw badRequest(`${at}（collect）的 expectMinRows 必须是非负整数`);
      }
      return;
    case 'screenshot':
      return;
    default:
      throw badRequest(`${at}类型不支持: ${(step as { type?: string }).type ?? '?'}`);
  }
}

/**
 * 模板替换。
 *
 * 只支持点号路径，不做表达式求值——上一步 eval 的结果通过 vars 传进来，
 * 需要更多计算就在 eval 里算完。表达式的自由度和排错成本不成正比。
 */
function renderTemplate(
  template: string,
  profile: Profile,
  vars: Record<string, unknown>,
  index: number,
): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (raw, expr: string) => {
    const value = lookup(expr, profile, vars, index);
    if (value === undefined) return raw;
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

function lookup(expr: string, profile: Profile, vars: Record<string, unknown>, index: number): unknown {
  const parts = expr.split('.');
  if (parts[0] === 'profile') {
    const key = parts[1];
    if (key === 'id') return profile.id;
    if (key === 'name') return profile.name;
    if (key === 'os') return profile.os;
    if (key === 'proxyId') return profile.proxyId ?? '';
    return undefined;
  }
  if (parts[0] === 'vars' && parts[1]) return vars[parts[1]];
  if (parts[0] === 'index') return index;
  return undefined;
}

function safeUrl(page: PageLike): string {
  try {
    return page.url();
  } catch {
    return '';
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
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
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(lanes);
}

/**
 * 错误分类。
 *
 * 只有一个入口，不许在各步骤里各写各的 try/catch——否则同一个错误在不同步骤
 * 会被分成两类，重试策略就变得不可预期：用户看到"有时重试有时不重试"，
 * 却找不到规律。
 *
 * 判据是「重试一次有没有可能成功」：
 *   - 导航超时、代理断连、目标 5xx —— 有可能是网络抖了一下 → transient
 *   - 脚本抛错、返回类型不对、超出行数上限 —— 重试只会重复同一份失败 → permanent
 */
const PERMANENT_PATTERNS: RegExp[] = [
  /expectMinRows/i,
  /超过上限/,
  /必须返回数组/,
  /单行上限/,
  /判重字段/,
  /不是合法正则/,
  /脚本执行超时/,
  /采集脚本超时/,
  /环境未在运行/,
  /步骤/,
  /参数/,
  /最多/,
];

/**
 * 超时单独成类，不合并进 transient。
 *
 * 两者都值得重试，但对用户的意义完全不同：timeout 说明「目标太慢或网络差」，
 * 调大超时或换个时段可能就好了；transient 说明「连上了但中间断了」。
 * 界面上一句「超时」比一个笼统的「临时错误」有用得多。
 */
const TIMEOUT_PATTERNS: RegExp[] = [/超时/, /timeout/i, /timed out/i];

const TRANSIENT_PATTERNS: RegExp[] = [
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EHOSTUNREACH/i,
  /NS_ERROR_/i,
  /ERR_PROXY|proxy connection/i,
  /net::err/i,
  /socket hang up/i,
  /target closed|browser has been closed/i,
  /启动失败/,
  /连接/,
  /network/i,
];

export function classifyMessage(message: string): ErrorClass {
  const text = message ?? '';
  if (!text) return 'permanent';
  // 永久错误优先：「脚本执行超时」这类也要先被永久规则吃掉，
  // 否则会被下面的 timeout 规则捞走，然后被无意义地重试三次
  for (const pattern of PERMANENT_PATTERNS) if (pattern.test(text)) return 'permanent';
  for (const pattern of TIMEOUT_PATTERNS) if (pattern.test(text)) return 'timeout';
  for (const pattern of TRANSIENT_PATTERNS) if (pattern.test(text)) return 'transient';
  return 'permanent';
}

function classifyRun(run: TaskRunResult): ErrorClass {
  const failed = run.steps.find((step) => step.status === 'failed');
  return classifyMessage(failed?.error ?? run.error ?? '');
}

/** 值得重试的两类：超时与瞬时错误 */
function isTransient(run: TaskRunResult): boolean {
  const kind = classifyRun(run);
  return kind === 'transient' || kind === 'timeout';
}

/** 目录占用：删截图前先记下释放了多少，审计里要能看见 */
function dirBytes(dir: string): number {
  let total = 0;
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* 文件可能在遍历期间被删 */
        }
      }
    }
  };
  walk(dir);
  return total;
}
