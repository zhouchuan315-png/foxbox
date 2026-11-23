import { createHmac } from 'node:crypto';
import { newId } from '../db/ids.ts';
import { badRequest, notFound } from '../errors.ts';
import type { Notifier, NotifyEvent } from '../../shared/types.ts';
import type { NotifyRepo } from '../repositories/notify.repo.ts';
import type { AuditRepo } from '../repositories/audit.repo.ts';

export interface NotifyDeps {
  notifiers: NotifyRepo;
  audit: AuditRepo;
}

interface Item {
  title: string;
  detail?: string;
  /** 同一件事的稳定标识，用来在窗口内去重 */
  key?: string;
}

interface Pending {
  event: NotifyEvent;
  items: Map<string, Item>;
  timer: NodeJS.Timeout;
}

const EVENTS: NotifyEvent[] = ['task.failed', 'session.expired', 'proxy.dead', 'automation.skipped'];

/**
 * 通知。
 *
 * 核心不是"发出去"，而是"别发太多"：巡检 50 个环境时，如果每条结果发一次，
 * 一次巡检就是 50 条消息，用户第一天就会把这个功能关掉，然后真出事也收不到。
 * 所以：窗口内聚合 + 同类去重 + 边沿触发（调用方负责只在状态变化时 emit）。
 */
export class NotifyService {
  private readonly pending = new Map<string, Pending>();
  private readonly windowMs: number;
  private readonly backoffMs: number[];

  constructor(private readonly deps: NotifyDeps) {
    this.windowMs = numberFromEnv('FOXBOX_NOTIFY_WINDOW_MS', 60_000);
    // 测试里把退避压到毫秒级，否则一个用例要等 36 秒
    this.backoffMs = String(process.env.FOXBOX_NOTIFY_BACKOFF ?? '1000,5000,30000')
      .split(',')
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n) && n >= 0);
  }

  list(): Notifier[] {
    return this.deps.notifiers.list();
  }

  recentLogs(limit = 50) {
    return this.deps.notifiers.recentLogs(limit);
  }

  create(input: { name: string; url: string; secret?: string | null; events?: string[] }): Notifier {
    const name = input.name?.trim();
    if (!name) throw badRequest('通知通道名称不能为空');
    let url: string;
    try {
      const parsed = new URL(input.url ?? '');
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('protocol');
      url = parsed.toString();
    } catch {
      throw badRequest(`通知地址不合法（需要 http/https）: ${input.url ?? ''}`);
    }
    const events = (input.events?.length ? input.events : EVENTS).filter((e): e is NotifyEvent =>
      (EVENTS as string[]).includes(e),
    );
    if (events.length === 0) throw badRequest(`事件类型无效，可选：${EVENTS.join(', ')}`);

    return this.deps.notifiers.insert(
      { id: newId(), name, url, secret: input.secret?.trim() || null, events },
      Date.now(),
    );
  }

  remove(id: string): void {
    if (!this.deps.notifiers.find(id)) throw notFound(`通知通道不存在: ${id}`);
    this.deps.notifiers.remove(id);
  }

  /** 发一条测试消息：配好之后立刻验证，比等真出事才发现地址写错强 */
  async test(id: string): Promise<{ ok: boolean; status: number | null; error: string | null }> {
    const notifier = this.deps.notifiers.find(id);
    if (!notifier) throw notFound(`通知通道不存在: ${id}`);
    const payload = {
      event: 'test' as const,
      title: 'FoxBox 测试通知',
      text: '如果你看到这条消息，说明通道配置正确。',
      count: 1,
      items: [{ title: '测试' }],
      at: Date.now(),
    };
    const result = await this.deliver(notifier, 'test', JSON.stringify(payload));
    this.deps.notifiers.log(
      {
        id: newId(),
        notifierId: id,
        event: 'test',
        dedupeKey: null,
        status: result.ok ? 'sent' : 'failed',
        httpStatus: result.status,
        error: result.error,
        payloadJson: null,
      },
      Date.now(),
    );
    return result;
  }

  /**
   * 投递一个事件。不 await 结果（不发就丢了的责任在调用方日志里，不在主流程）。
   *
   * 调用方应该只在「状态发生跨阈值变化」时调用它，不要每次检查都调。
   */
  emit(event: NotifyEvent, item: Item): void {
    const subscribers = this.deps.notifiers.list().filter((n) => n.enabled && n.events.includes(event));
    if (subscribers.length === 0) return;

    const key = `${event}`;
    const dedupeKey = item.key ?? item.title;
    let bucket = this.pending.get(key);
    if (!bucket) {
      bucket = {
        event,
        items: new Map(),
        timer: setTimeout(() => void this.flush(key), this.windowMs),
      };
      // 聚合窗口不该拖住进程退出（测试脚本尤其明显）
      bucket.timer.unref?.();
      this.pending.set(key, bucket);
    }
    if (bucket.items.has(dedupeKey)) {
      // 窗口内同一件事重复触发：不重复发，但要留痕。
      // 不留痕的话，「为什么我只收到一条」永远说不清，排查时只能猜。
      for (const notifier of subscribers) {
        this.deps.notifiers.log(
          {
            id: newId(),
            notifierId: notifier.id,
            event,
            dedupeKey,
            status: 'suppressed',
            httpStatus: null,
            error: null,
            payloadJson: null,
          },
          Date.now(),
        );
      }
      return;
    }
    bucket.items.set(dedupeKey, item);
  }

  /** 供测试与"进程要退出"时立刻冲一次 */
  async flushAll(): Promise<void> {
    await Promise.all([...this.pending.keys()].map((key) => this.flush(key)));
  }

  private async flush(key: string): Promise<void> {
    const bucket = this.pending.get(key);
    if (!bucket) return;
    this.pending.delete(key);
    clearTimeout(bucket.timer);

    const items = [...bucket.items.values()];
    if (items.length === 0) return;

    const subscribers = this.deps.notifiers.list().filter((n) => n.enabled && n.events.includes(bucket.event));
    if (subscribers.length === 0) return;

    const title = aggregateTitle(bucket.event, items.length);
    const payload = {
      event: bucket.event,
      title,
      text: items.length === 1 ? items[0]!.detail ?? items[0]!.title : items.map((i) => i.title).join('、'),
      count: items.length,
      items,
      at: Date.now(),
    };
    const body = JSON.stringify(payload);

    await Promise.all(
      subscribers.map(async (notifier) => {
        const result = await this.deliver(notifier, bucket.event, body);
        this.deps.notifiers.log(
          {
            id: newId(),
            notifierId: notifier.id,
            event: bucket.event,
            dedupeKey: null,
            status: result.ok ? 'sent' : 'failed',
            httpStatus: result.status,
            error: result.error,
            payloadJson: body.slice(0, 2000),
          },
          Date.now(),
        );
        if (!result.ok) {
          this.deps.audit.log('notify.failed', null, {
            notifierId: notifier.id,
            event: bucket.event,
            status: result.status,
            error: result.error,
          });
        }
      }),
    );
  }

  /**
   * 实际投递：3 次指数退避。
   *
   * 失败只落日志，不抛错、不阻塞主流程——通知发不出去是次要故障，
   * 它不该让巡检或任务跟着挂。
   */
  private async deliver(
    notifier: Notifier,
    event: string,
    body: string,
  ): Promise<{ ok: boolean; status: number | null; error: string | null }> {
    const secret = this.deps.notifiers.secretOf(notifier.id);
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      'user-agent': 'FoxBox/0.1',
      'x-foxbox-event': event,
    };
    if (secret) {
      headers['x-foxbox-signature'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    }

    let lastError: string | null = null;
    let lastStatus: number | null = null;

    for (let attempt = 0; attempt <= this.backoffMs.length; attempt += 1) {
      if (attempt > 0) await sleep(this.backoffMs[attempt - 1] ?? 0);
      try {
        const response = await fetch(notifier.url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(10_000),
        });
        lastStatus = response.status;
        if (response.ok) return { ok: true, status: response.status, error: null };
        lastError = `HTTP ${response.status}`;
        // 4xx 是配置问题（地址错、密钥错），重试没有意义
        if (response.status >= 400 && response.status < 500) break;
      } catch (error) {
        lastError = error instanceof Error ? error.message.split('\n')[0]! : String(error);
      }
    }

    return { ok: false, status: lastStatus, error: lastError };
  }
}

function aggregateTitle(event: NotifyEvent, count: number): string {
  // 单条的措辞不带数量，多条才说"3 个环境会话失效"——标题短一点更像人写的
  const table: Record<NotifyEvent, { noun: string; label: string }> = {
    'task.failed': { noun: '任务', label: '失败' },
    'session.expired': { noun: '环境', label: '会话失效' },
    'proxy.dead': { noun: '环境', label: '代理失效' },
    'automation.skipped': { noun: '规则', label: '被跳过' },
  };
  const hit = table[event];
  return count === 1 ? `${hit.noun}${hit.label}` : `${count} 个${hit.noun}${hit.label}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}
