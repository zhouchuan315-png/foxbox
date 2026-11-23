import * as http from 'node:http';
import * as path from 'node:path';
import { createApp } from '../src/core/app.ts';
import { startServer } from '../src/api/server.ts';
import { describeCron, nextRuns, parseCron } from '../src/core/automation/cron.ts';

/**
 * M5 验收：定时与事件触发。
 *
 * 判据是这些事实，而不是「接口能返回 200」：
 * 1. 写错的表达式在录入时就被拒（不是等到点才发现永远不触发）
 * 2. 到点真的会跑，且"任务还在跑"时不会叠加第二次
 * 3. 服务重启后不补跑错过的触发，但要留下一条"我当时不在"
 * 4. 代理失效能触发切换；国家不同时宁可不切——指纹一致性优先于"看起来恢复了"
 * 5. 巡检没有异常时不写历史，否则真正的事件会被心跳淹掉
 *
 * 调度器的心跳间隔是 20 秒、cron 最小粒度是一分钟，所以验收里用注入时间的方式
 * 触发，不真的等。注入点只有 service 层，HTTP 层没有后门参数。
 */

const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const home = getArg('home') ?? path.join(process.cwd(), '.foxbox-m5-eval');
const skipProxy = args.includes('--no-proxy');

interface RawResponse {
  status: number;
  body: string;
}

function request(opts: {
  port: number;
  path: string;
  method?: string;
  token?: string;
  body?: unknown;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }
    const req = http.request(
      { host: '127.0.0.1', port: opts.port, path: opts.path, method: opts.method ?? 'GET', headers },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface AutomationShape {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: string | null;
  runCount: number;
  spec: Record<string, unknown>;
}

interface RunShape {
  status: string;
  detail: string | null;
  trigger: string;
  endedAt: number | null;
}

interface TaskShape {
  id: string;
  status: string;
}

async function main(): Promise<void> {
  console.log('FoxBox M5 · 定时与事件触发');
  console.log(`  home=${home}${skipProxy ? '（跳过代理巡检）' : ''}`);
  console.log('');

  const app = createApp(home);
  const { fastify, token, port } = await startServer(app, { port: 0 });
  const svc = app.services.automations;

  const checks: Array<[string, boolean, string]> = [];
  const record = (name: string, ok: boolean, detail = ''): void => {
    checks.push([name, ok, detail]);
    console.log(`  ${ok ? '·' : '×'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const api = async <T>(p: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
    const res = await request({ port, path: p, token, ...init });
    return (res.body ? JSON.parse(res.body) : null) as T;
  };

  const expectBad = async (p: string, body: unknown): Promise<number> => {
    const res = await request({ port, path: p, method: 'POST', token, body });
    return res.status;
  };

  // ─────────────── 1. 表达式：能被理解，也要能被拒绝

  const preview = await api<{ expr: string; human: string; next: number[] }>(
    `/api/automations/preview?expr=${encodeURIComponent('*/5 * * * *')}`,
  );
  record('预览给出接下来三次', preview.next.length === 3 && preview.next[0]! > Date.now(), preview.human);
  record(
    '三次时间严格递增',
    preview.next.every((t, i) => i === 0 || t > preview.next[i - 1]!),
    preview.next.map((t) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false })).join(' / '),
  );
  record('人话描述正确', preview.human === '每 5 分钟', preview.human);

  const human = describeCron(parseCron('30 8 * * 1-5'));
  record('工作日表达式读得出', human === '工作日 08:30', human);

  const leapDay = nextRuns(parseCron('0 0 29 2 *'), Date.now(), 1);
  record(
    '闰日表达式算到 2 月 29',
    leapDay.length === 1 && new Date(leapDay[0]!).getMonth() === 1 && new Date(leapDay[0]!).getDate() === 29,
    leapDay.length ? new Date(leapDay[0]!).toLocaleDateString('zh-CN') : '无解',
  );

  const bad = await expectBad('/api/automations', {
    name: '四段表达式',
    kind: 'cron',
    spec: { expr: '* * * *' },
    actions: [{ type: 'notify_only' }],
  });
  record('段数不对被拒', bad === 400, `HTTP ${bad}`);

  const impossible = await expectBad('/api/automations', {
    name: '不存在的日期',
    kind: 'cron',
    spec: { expr: '0 0 30 2 *' },
    actions: [{ type: 'notify_only' }],
  });
  record('永不触发的表达式被拒', impossible === 400, `HTTP ${impossible}`);

  // ─────────────── 2. 到点触发

  // 分组名带后缀：同一个 home 反复跑脚本时不至于撞 UNIQUE
  const tag = Date.now().toString().slice(-5);
  const group = await api<{ id: string }>('/api/groups', { method: 'POST', body: { name: `M5 演示 ${tag}` } });
  const profile = await api<{ id: string; name: string }>('/api/profiles', {
    method: 'POST',
    body: { name: '定时目标', country: 'US', os: 'macos', groupId: group.id },
  });

  // 用 wait 代替 start：验收不该为了验调度去启动一个真浏览器
  const quickTask = await api<TaskShape>('/api/tasks', {
    method: 'POST',
    body: { name: 'M5 快任务', target: { profileIds: [profile.id] }, steps: [{ type: 'wait', ms: 400 }] },
  });
  const slowTask = await api<TaskShape>('/api/tasks', {
    method: 'POST',
    body: { name: 'M5 慢任务', target: { profileIds: [profile.id] }, steps: [{ type: 'wait', ms: 3000 }] },
  });

  const noRunTask = await expectBad('/api/automations', {
    name: '定时但没事可做',
    kind: 'cron',
    spec: { expr: '0 3 * * *' },
    actions: [{ type: 'notify_only' }],
  });
  record('定时规则必须有 run_task', noRunTask === 400, `HTTP ${noRunTask}`);

  const ghostTask = await expectBad('/api/automations', {
    name: '引用不存在的任务',
    kind: 'cron',
    spec: { expr: '0 3 * * *' },
    actions: [{ type: 'run_task', taskId: 'NOT-A-TASK' }],
  });
  record('引用不存在的任务被拒', ghostTask === 400, `HTTP ${ghostTask}`);

  const every5 = await api<AutomationShape>('/api/automations', {
    method: 'POST',
    body: {
      name: '每 5 分钟取数',
      kind: 'cron',
      spec: { expr: '*/5 * * * *' },
      actions: [{ type: 'run_task', taskId: quickTask.id }],
    },
  });
  record('规则创建后有下次时间', every5.nextRunAt !== null && every5.nextRunAt > Date.now());

  // 注入时间：到点那一刻
  const fireAt = every5.nextRunAt!;
  const firstFires = await svc.tick(fireAt);
  record('到点触发一次', firstFires.length === 1 && firstFires[0]!.status === 'ok', firstFires[0]?.detail ?? '未触发');

  const afterFirst = svc.get(every5.id);
  record(
    '下次时间往后推 5 分钟',
    afterFirst.nextRunAt === fireAt + 300_000,
    new Date(afterFirst.nextRunAt!).toLocaleTimeString('zh-CN', { hour12: false }),
  );

  const runs = await api<RunShape[]>(`/api/automations/${every5.id}/runs`);
  record('触发写入历史', runs.length >= 1, runs[0] ? `${runs[0].trigger} / ${runs[0].status}` : '空');

  // 任务被真的推起来了
  await sleep(900);
  const quickDone = await api<TaskShape>(`/api/tasks/${quickTask.id}`);
  record('任务确实被执行', quickDone.status === 'succeeded', quickDone.status);

  // 空目标的任务：summary 里失败数是 0，但任务本身是失败的。
  // 触发记录必须以任务最终状态为准，否则界面上会出现"成功，0 个目标"。
  const emptyGroup = await api<{ id: string }>('/api/groups', {
    method: 'POST',
    body: { name: `M5 空分组 ${tag}` },
  });
  const emptyTask = await api<TaskShape>('/api/tasks', {
    method: 'POST',
    body: {
      name: 'M5 空目标任务',
      target: { profileIds: [], groupId: emptyGroup.id },
      steps: [{ type: 'wait', ms: 100 }],
    },
  });
  const emptyRule = await api<AutomationShape>('/api/automations', {
    method: 'POST',
    body: {
      name: '空目标定时',
      kind: 'cron',
      spec: { expr: '0 4 * * *' },
      actions: [{ type: 'run_task', taskId: emptyTask.id }],
    },
  });
  await svc.tick(emptyRule.nextRunAt!);

  let emptyRun: RunShape | null = null;
  for (let i = 0; i < 40; i++) {
    const list = await api<RunShape[]>(`/api/automations/${emptyRule.id}/runs`);
    emptyRun = list[0] ?? null;
    if (emptyRun?.endedAt) break;
    await sleep(200);
  }
  record(
    '空目标的任务记为失败',
    emptyRun?.status === 'failed' && /目标环境为空/.test(emptyRun?.detail ?? ''),
    emptyRun?.detail ?? '无记录',
  );

  // ─────────────── 3. 同一规则不叠加

  const slowRule = await api<AutomationShape>('/api/automations', {
    method: 'POST',
    body: {
      name: '慢任务定时',
      kind: 'cron',
      spec: { expr: '* * * * *' },
      actions: [{ type: 'run_task', taskId: slowTask.id }],
    },
  });

  const [a, b] = await Promise.all([svc.tick(slowRule.nextRunAt!), svc.tick(slowRule.nextRunAt!)]);
  record('并发心跳只有一轮生效', a.length === 1 && b.length === 0, `a=${a.length} b=${b.length}`);

  const again = await svc.tick(svc.get(slowRule.id).nextRunAt!);
  record(
    '上一次没跑完就跳过',
    again.length === 1 && again[0]!.status === 'skipped',
    again[0]?.detail ?? '未触发',
  );

  // 等慢任务收尾，避免影响后面的计数
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const t = await api<TaskShape>(`/api/tasks/${slowTask.id}`);
    if (t.status !== 'running') break;
    await sleep(200);
  }

  // ─────────────── 4. 停用与重启

  const paused = await api<AutomationShape>(`/api/automations/${every5.id}`, {
    method: 'PATCH',
    body: { enabled: false },
  });
  record('停用后清空下次时间', paused.enabled === false && paused.nextRunAt === null);

  const pausedTick = await svc.tick(Date.now() + 86_400_000);
  record('停用的规则不会被触发', pausedTick.every((o) => o.automationId !== every5.id), `触发 ${pausedTick.length} 条`);

  await api(`/api/automations/${every5.id}`, { method: 'PATCH', body: { enabled: true } });

  // 模拟"服务关了两小时"：把下次时间拨到过去，再走一次启动重排
  app.repos.automations.update(every5.id, { nextRunAt: Date.now() - 2 * 3600_000 });
  const beforeMissed = (await api<RunShape[]>(`/api/automations/${every5.id}/runs`)).length;
  const resync = svc.resync();
  const missedRuns = await api<RunShape[]>(`/api/automations/${every5.id}/runs`);
  const missedRow = missedRuns.find((r) => r.status === 'skipped' && /服务未运行/.test(r.detail ?? ''));
  record(
    '重启后记为错过而不补跑',
    resync.missed >= 1 && missedRuns.length === beforeMissed + 1 && Boolean(missedRow),
    missedRow?.detail ?? `missed=${resync.missed} runs=${beforeMissed}→${missedRuns.length}`,
  );
  record(
    '重启后下次时间仍是未来',
    (svc.get(every5.id).nextRunAt ?? 0) > Date.now(),
    new Date(svc.get(every5.id).nextRunAt ?? 0).toLocaleString('zh-CN', { hour12: false }),
  );

  // ─────────────── 5. 事件钩子：代理失效

  if (skipProxy) {
    record('代理巡检（已跳过）', true, '--no-proxy');
  } else {
    const badProxy = await api<{ id: string }>('/api/proxies', {
      method: 'POST',
      body: { name: '主代理-HK', host: '127.0.0.1', port: 1, protocol: 'http', country: 'HK' },
    });
    const standby = await api<{ id: string }>('/api/proxies', {
      method: 'POST',
      body: { name: '备用-HK', host: '127.0.0.1', port: 2, protocol: 'http', country: 'HK' },
    });
    const otherCountry = await api<{ id: string }>('/api/proxies', {
      method: 'POST',
      body: { name: '备用-US', host: '127.0.0.1', port: 3, protocol: 'http', country: 'US' },
    });

    // 走自动化同一条通道绑定代理（建环境时绑会触发预检，演示里不需要）
    app.services.profiles.rebindProxy(profile.id, badProxy.id, 'M5 演示：先绑主代理');

    const watch = await api<AutomationShape>('/api/automations', {
      method: 'POST',
      body: {
        name: '代理失效自动切',
        kind: 'proxy_watch',
        spec: { intervalMinutes: 5, failThreshold: 1, proxyIds: [badProxy.id] },
        actions: [{ type: 'switch_proxy', standbyProxyId: standby.id, sameCountryOnly: true }],
      },
    });
    record('巡检规则创建后有下次时间', watch.nextRunAt !== null && watch.nextRunAt > Date.now());

    const started = Date.now();
    const trippedAll = await svc.tick(watch.nextRunAt!);
    const elapsed = Date.now() - started;
    const tripped = trippedAll.find((o) => o.automationId === watch.id);
    record(
      '代理失效触发动作',
      tripped?.status === 'ok',
      tripped?.detail ?? '未触发',
    );
    record('失效判定够快', elapsed < 15_000, `${elapsed}ms`);

    const bound = await api<{ proxyId: string | null }>(`/api/profiles/${profile.id}`);
    record('环境已切到备用代理', bound.proxyId === standby.id, bound.proxyId ?? 'null');

    const watchRuns = await api<RunShape[]>(`/api/automations/${watch.id}/runs`);
    record(
      '切换原因写进历史',
      watchRuns.length === 1 && /切到/.test(watchRuns[0]!.detail ?? ''),
      (watchRuns[0]?.detail ?? '').slice(0, 80),
    );

    // 心跳：再巡一次，代理仍然挂，但 fail_streak 已经越过阈值，不该再算事件
    const beat = await svc.tick(svc.get(watch.id).nextRunAt!);
    const beatSelf = beat.find((o) => o.automationId === watch.id);
    const watchRuns2 = await api<RunShape[]>(`/api/automations/${watch.id}/runs`);
    record(
      '心跳不写历史',
      beatSelf?.status === 'skipped' && watchRuns2.length === watchRuns.length,
      `本轮 ${beatSelf?.status ?? '未触发'} · 历史 ${watchRuns.length} → ${watchRuns2.length}`,
    );

    // 国家不同：宁可不动。
    // 这里必须用一条还没被巡检过的代理——边沿触发是按代理的 fail_streak 算的，
    // 复用刚才那条会直接"已经越过阈值"，测不到守卫本身。
    const hkProxy = await api<{ id: string }>('/api/proxies', {
      method: 'POST',
      body: { name: '主代理2-HK', host: '127.0.0.1', port: 4, protocol: 'http', country: 'HK' },
    });
    const foreignProfile = await api<{ id: string }>('/api/profiles', {
      method: 'POST',
      body: { name: '换国目标', country: 'US', os: 'macos', groupId: group.id },
    });
    app.services.profiles.rebindProxy(foreignProfile.id, hkProxy.id, 'M5 演示：换国守卫');

    const guard = await api<AutomationShape>('/api/automations', {
      method: 'POST',
      body: {
        name: '跨国家不切',
        kind: 'proxy_watch',
        spec: { intervalMinutes: 5, failThreshold: 1, proxyIds: [hkProxy.id] },
        actions: [{ type: 'switch_proxy', standbyProxyId: otherCountry.id, sameCountryOnly: true }],
      },
    });
    const guardedAll = await svc.tick(guard.nextRunAt!);
    const guarded = guardedAll.find((o) => o.automationId === guard.id);
    const stillBad = await api<{ proxyId: string | null }>(`/api/profiles/${foreignProfile.id}`);
    record(
      '国家不同不切换',
      guarded?.status === 'ok' && stillBad.proxyId === hkProxy.id,
      (guarded?.detail ?? '未触发').slice(0, 90),
    );
    record('拒绝原因说明清楚', /国家不同/.test(guarded?.detail ?? ''), '含「国家不同」');
  }

  // ─────────────── 6. 手动运行与列表

  const manualBefore = svc.get(every5.id);
  await api(`/api/automations/${every5.id}/run`, { method: 'POST' });
  const manualAfter = svc.get(every5.id);
  record(
    '立即运行不改动节奏',
    manualAfter.nextRunAt === manualBefore.nextRunAt,
    `next 未移动 · runCount ${manualBefore.runCount} → ${manualAfter.runCount}`,
  );

  const list = await api<{ items: AutomationShape[]; scheduler: { running: boolean; tickMs: number } }>(
    '/api/automations',
  );
  record('列表带调度器状态', Array.isArray(list.items) && list.scheduler.tickMs >= 1000, `tickMs=${list.scheduler.tickMs}`);

  const systemInfo = await api<{ automations: number }>('/api/system');
  record('系统信息含规则数', systemInfo.automations === list.items.length, `${systemInfo.automations} 条`);

  const delRes = await request({ port, path: `/api/automations/${every5.id}`, method: 'DELETE', token });
  const afterDelete = await api<{ items: AutomationShape[] }>('/api/automations');
  record(
    '删除后从列表消失',
    delRes.status === 204 && !afterDelete.items.some((i) => i.id === every5.id),
    `HTTP ${delRes.status}`,
  );

  await finish(app, checks, fastify);
}

async function finish(
  app: ReturnType<typeof createApp>,
  checks: Array<[string, boolean, string]>,
  fastify: { close: () => Promise<unknown> },
): Promise<void> {
  const line = '─'.repeat(64);
  console.log(`\n${line}`);
  console.log('  验收结论');
  console.log(line);
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? '通过  ' : '未达标'}  ${name.padEnd(26, ' ')} ${detail}`);
  }
  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(`\n  ${failed === 0 ? 'M5 验收通过' : `${failed} 项未达标`}`);

  app.services.automations.stop();
  await app.services.tasks.shutdown();
  await app.services.profiles.shutdown();
  await fastify.close();
  app.db.close();
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('\nM5 验证失败：');
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
