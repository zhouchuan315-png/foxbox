import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createApp } from '../src/core/app.ts';
import { startServer } from '../src/api/server.ts';
import { startFixtureSite } from './fixtures/login-site.ts';

/**
 * M8 验收：可靠性与通知。
 *
 * 判据是「出事的时候用户会不会知道，以及会不会被通知烦死」：
 * 1. 超时要单独归类（timeout），不能混进「临时错误」
 * 2. 只重试偶发错误；脚本自己报错不重试（重试只会把同一个 bug 跑三遍）
 * 3. 只重跑失败的目标，不重跑整条任务
 * 4. 50 条事件在一个窗口里只发 1 条消息，且带得出数量
 * 5. 投递失败要重试，但通知发不出去不能拖垮主流程
 * 6. 证据（截图/任务历史）可以过期，资产（dataset_rows）永不清
 * 7. 清理必须留痕（删了什么、释放多少字节）
 *
 * 通知窗口在真实运行时是 60s；这里压到 1.5s 只是为了跑得快，
 * 聚合/去重的语义完全一样。
 */

process.env.FOXBOX_NOTIFY_WINDOW_MS ??= '1500';
process.env.FOXBOX_NOTIFY_BACKOFF ??= '60,120,240';

const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const home = getArg('home') ?? path.join(process.cwd(), '.foxbox-m8-eval');

interface RawResponse {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function request(opts: { port: number; path: string; method?: string; token?: string; body?: unknown }): Promise<RawResponse> {
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
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

interface TaskShape {
  id: string;
  status: string;
  error: string | null;
  errorClass: string | null;
  result: null | {
    runs: Array<{
      profileId: string;
      profileName: string;
      status: string;
      attempts: number;
      errorClass?: string;
      steps: Array<{ type: string; status: string; error?: string; note?: string }>;
      screenshots: string[];
    }>;
    summary: { total: number; succeeded: number; failed: number; skipped: number };
  };
}

interface HookHit {
  body: string;
  headers: http.IncomingHttpHeaders;
}
interface Hook {
  url: string;
  hits: HookHit[];
  setStatus(status: number): void;
  reset(): void;
  close(): Promise<void>;
}

async function startHook(): Promise<Hook> {
  let status = 200;
  const hits: HookHit[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      hits.push({ body: Buffer.concat(chunks).toString('utf8'), headers: req.headers });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    hits,
    setStatus(next) {
      status = next;
    },
    reset() {
      hits.length = 0;
      status = 200;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const SCRAPE_ORDERS = `Array.from(document.querySelectorAll('#orders tbody tr')).map(function (tr) {
  var cell = function (sel) { var el = tr.querySelector(sel); return el ? el.textContent.trim() : null; };
  return { orderNo: tr.getAttribute('data-order-no'), price: cell('.price') };
})`;

async function main(): Promise<void> {
  console.log('FoxBox M8 · 可靠性与通知');
  console.log(`  home=${home}  通知窗口=${process.env.FOXBOX_NOTIFY_WINDOW_MS}ms 退避=${process.env.FOXBOX_NOTIFY_BACKOFF}`);

  fs.rmSync(home, { recursive: true, force: true });
  const site = await startFixtureSite();
  const hook = await startHook();
  const app = createApp(home);
  const { fastify, token, port } = await startServer(app, { port: 0 });

  const checks: Array<[string, boolean, string]> = [];
  let finished = false;
  const record = (name: string, ok: boolean, detail = ''): void => {
    checks.push([name, ok, detail]);
    console.log(`  ${ok ? '·' : '×'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const api = async <T>(p: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
    const res = await request({ port, path: p, token, ...init });
    if (res.status >= 400) throw new Error(`${init.method ?? 'GET'} ${p} → HTTP ${res.status} ${res.body.slice(0, 200)}`);
    return (res.body ? JSON.parse(res.body) : null) as T;
  };

  const waitTask = async (id: string, timeoutMs = 180_000): Promise<TaskShape> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const task = await api<TaskShape>(`/api/tasks/${id}`);
      if (task.status !== 'running' && task.status !== 'queued') return task;
      await sleep(500);
    }
    return api<TaskShape>(`/api/tasks/${id}`);
  };

  const runTask = async (body: Record<string, unknown>): Promise<TaskShape> => {
    const created = await api<TaskShape>('/api/tasks', { method: 'POST', body: { runNow: true, ...body } });
    return waitTask(created.id);
  };

  const mkProfile = (name: string, extra: Record<string, unknown> = {}): Promise<{ id: string }> =>
    api('/api/profiles', { method: 'POST', body: { name, country: 'HK', os: 'macos', headless: true, ...extra } });

  try {
    // ── 1 任务级超时 → failed + error_class=timeout
    const p1 = await mkProfile('超时环境');
    const timeoutTask = await runTask({
      name: '超时用例',
      target: { profileIds: [p1.id] },
      timeoutMs: 5000,
      retries: 0,
      steps: [
        { type: 'start' },
        { type: 'goto', url: `${site.url}/slow?ms=20000` },
        { type: 'stop' },
      ],
    });
    record(
      'timeoutMs 跑 20s 页面 → failed，error_class=timeout',
      timeoutTask.status === 'failed' && timeoutTask.errorClass === 'timeout',
      `${timeoutTask.status} class=${timeoutTask.errorClass} err=${(timeoutTask.error ?? '').slice(0, 24)}`,
    );

    // ── 2 偶发超时重试到第 3 次成功
    const retryTask = await runTask({
      name: '重试用例',
      target: { profileIds: [p1.id] },
      retries: 2,
      steps: [
        { type: 'start' },
        { type: 'goto', url: `${site.url}/flaky-slow`, timeoutMs: 2000 },
        { type: 'stop' },
      ],
    });
    const retryRun = retryTask.result?.runs[0];
    record(
      '/flaky-slow → 第 3 次成功，attempts=3',
      retryTask.status === 'succeeded' && retryRun?.attempts === 3,
      `${retryTask.status} attempts=${retryRun?.attempts}`,
    );

    // ── 3 脚本自己抛错 → 不重试（★）
    const boomTask = await runTask({
      name: '脚本报错用例',
      target: { profileIds: [p1.id] },
      retries: 2,
      steps: [
        { type: 'start' },
        { type: 'eval', script: '(function(){ throw new Error("boom: 元素找不到"); })()' },
        { type: 'stop' },
      ],
    });
    const boomRun = boomTask.result?.runs[0];
    record(
      'eval 抛错 → 不重试，attempts=1',
      boomTask.status === 'failed' && boomRun?.attempts === 1 && boomRun?.errorClass === 'permanent',
      `${boomTask.status} attempts=${boomRun?.attempts} class=${boomRun?.errorClass}`,
    );

    // ── 4 只重跑失败的目标
    const ok1 = await mkProfile('批量 A');
    const ok2 = await mkProfile('批量 B');
    const ok3 = await mkProfile('批量 C');
    const closedPort = await reserveClosedPort();
    const deadProxy = await api<{ id: string }>('/api/proxies', {
      method: 'POST',
      body: { name: '死代理', protocol: 'http', host: '127.0.0.1', port: closedPort },
    });
    const broken = await mkProfile('批量 D（坏代理）', { proxyId: deadProxy.id });
    const batchTask = await runTask({
      name: '多目标重试用例',
      target: { profileIds: [ok1.id, ok2.id, ok3.id, broken.id] },
      retries: 2,
      steps: [
        { type: 'start' },
        { type: 'goto', url: `${site.url}/login?go=1` },
        { type: 'stop' },
      ],
    });
    const runs = batchTask.result?.runs ?? [];
    const healthy = runs.filter((r) => r.profileId !== broken.id);
    const bad = runs.find((r) => r.profileId === broken.id);
    record(
      '只重跑失败的目标（4 个环境挂 1 个 → 只重启 1 个）',
      healthy.length === 3 && healthy.every((r) => r.attempts === 1) && (bad?.attempts ?? 0) > 1,
      `正常=${healthy.map((r) => r.attempts).join('/')} 失败=${bad?.attempts}`,
    );

    // ── 通知通道
    const secret = 'm8-secret';
    const notifier = await api<{ id: string }>('/api/notifiers', {
      method: 'POST',
      body: { name: '本地 webhook', url: hook.url, secret, events: ['session.expired', 'proxy.dead'] },
    });

    // ── 5 50 条事件 → 窗口内只发 1 条（★）
    hook.reset();
    for (let i = 1; i <= 50; i += 1) {
      app.services.notify.emit('session.expired', { title: `环境 ${i}`, detail: '登录态失效', key: `session:p${i}` });
    }
    await app.services.notify.flushAll();
    const bulkHits = hook.hits.slice();
    const bulkBody = bulkHits[0] ? (JSON.parse(bulkHits[0].body) as { count: number; title: string }) : null;
    record(
      '50 个环境同时 expired → 只发 1 条聚合消息',
      bulkHits.length === 1 && bulkBody?.count === 50,
      `hits=${bulkHits.length} count=${bulkBody?.count} title=${bulkBody?.title ?? ''}`,
    );

    // ── 6 签名可验
    const expected = `sha256=${createHmac('sha256', secret).update(bulkHits[0]?.body ?? '').digest('hex')}`;
    record(
      'webhook 签名可验（HMAC-SHA256 与 header 一致）',
      bulkHits[0]?.headers['x-foxbox-signature'] === expected,
      `header=${String(bulkHits[0]?.headers['x-foxbox-signature'] ?? '').slice(0, 22)}…`,
    );

    // ── 7 webhook 500 → 重试 3 次后落库，且不拖垮主流程
    hook.reset();
    hook.setStatus(500);
    app.services.notify.emit('proxy.dead', { title: '环境 A', detail: '代理不可用', key: 'proxy:a' });
    await app.services.notify.flushAll(); // 不应抛错
    const failedLogs = await api<{ logs: Array<{ event: string; status: string; httpStatus: number | null }> }>('/api/notifiers');
    const failedRow = failedLogs.logs.find((l) => l.event === 'proxy.dead' && l.status === 'failed');
    record(
      'webhook 返 500 → 重试 3 次后落 notification_logs，巡检继续',
      hook.hits.length === 4 && Boolean(failedRow) && failedRow?.httpStatus === 500,
      `尝试=${hook.hits.length} 日志=${failedRow?.status ?? '无'}/${failedRow?.httpStatus ?? '-'}`,
    );

    // ── 8 窗口内重复触发 → suppressed 落库
    hook.reset();
    app.services.notify.emit('proxy.dead', { title: '环境 B', detail: '代理不可用', key: 'proxy:b' });
    app.services.notify.emit('proxy.dead', { title: '环境 B', detail: '代理不可用', key: 'proxy:b' });
    await app.services.notify.flushAll();
    const logs2 = (await api<{ logs: Array<{ event: string; status: string; dedupeKey: string | null }> }>('/api/notifiers')).logs;
    const sentB = logs2.filter((l) => l.event === 'proxy.dead' && l.status === 'sent').length;
    const suppressedB = logs2.filter((l) => l.event === 'proxy.dead' && l.status === 'suppressed').length;
    record(
      '同一事件窗口内重复触发 → suppressed 落库',
      suppressedB >= 1 && sentB >= 1 && hook.hits.length === 1,
      `sent=${sentB} suppressed=${suppressedB} hits=${hook.hits.length}`,
    );

    // ── 9 / 10 / 11 TTL：任务与截图被清，数据集不受影响
    const p2 = await mkProfile('数据环境');
    const ttlTask = await runTask({
      name: '待清理任务',
      target: { profileIds: [p2.id] },
      steps: [
        { type: 'start' },
        { type: 'goto', url: `${site.url}/login?go=1` },
        { type: 'goto', url: `${site.url}/orders` },
        { type: 'collect', dataset: 'M8订单', dedupeBy: ['orderNo'], script: SCRAPE_ORDERS },
        { type: 'screenshot' },
        { type: 'stop' },
      ],
    });
    const shotsDir = path.join(home, 'screenshots', ttlTask.id);
    const shotsExisted = fs.existsSync(shotsDir) && fs.readdirSync(shotsDir).length > 0;
    const rowsBefore = countRows(app.db, 'dataset_rows');

    // 把任务和截图都做旧 100 天
    const old = Date.now() - 100 * 86_400_000;
    app.db.prepare('UPDATE tasks SET created_at = ?, ended_at = ? WHERE id = ?').run(old, old, ttlTask.id);
    if (shotsExisted) fs.utimesSync(shotsDir, new Date(old), new Date(old));

    const report = await api<{ screenshots: number; tasks: number; screenshotBytes: number }>('/api/retention/run', { method: 'POST' });
    const taskGone = app.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE id = ?').get(ttlTask.id) as { n: number };
    record(
      'TTL：任务改到 100 天前 → 清理后任务与截图都不在',
      report.tasks >= 1 && report.screenshots >= 1 && !fs.existsSync(shotsDir) && Number(taskGone.n) === 0,
      `tasks=${report.tasks} screenshots=${report.screenshots}`,
    );

    const auditRows = await api<Array<{ action: string; detail: unknown }>>('/api/audit');
    const cleanupRow = auditRows.find((a) => a.action === 'retention.cleanup');
    // detail 在仓储层已经解析过，这里两种形态都接住（字符串 / 对象）
    const cleanupDetail =
      typeof cleanupRow?.detail === 'string'
        ? (JSON.parse(cleanupRow.detail) as { freedBytes?: number })
        : (cleanupRow?.detail as { freedBytes?: number } | undefined);
    record(
      '清理留 audit 汇总（含释放字节数）',
      Boolean(cleanupRow) && (cleanupDetail?.freedBytes ?? 0) > 0,
      `freedBytes=${cleanupDetail?.freedBytes ?? 0}`,
    );

    const rowsAfter = countRows(app.db, 'dataset_rows');
    record(
      'dataset_rows 不参与清理（★）',
      rowsBefore > 0 && rowsAfter === rowsBefore,
      `${rowsBefore} → ${rowsAfter}`,
    );

    // ── 12 占用面板与实际磁盘误差
    await sleep(300);
    const storage = await api<{ screenshots: number; profiles: number; database: number; datasets: number; total: number }>(
      '/api/system/storage',
    );
    const duKb = Number(
      execFileSync('du', ['-sk', home], { encoding: 'utf-8' }).trim().split('\t')[0] ?? '0',
    );
    const duBytes = duKb * 1024;
    const drift = duBytes > 0 ? Math.abs(storage.total - duBytes) / duBytes : 1;
    record(
      '/api/system/storage 数字与 du 误差 < 5%',
      drift < 0.05,
      `面板=${(storage.total / 1048576).toFixed(1)}MB du=${(duBytes / 1048576).toFixed(1)}MB 偏差=${(drift * 100).toFixed(1)}%`,
    );

    // ── 13 截图预览不得撑破容器（I-07）
    const css = fs.readFileSync(path.join(process.cwd(), 'ui', 'style.css'), 'utf-8');
    const js = fs.readFileSync(path.join(process.cwd(), 'ui', 'app.js'), 'utf-8');
    const thumbRule = /\.shot-thumb\s*\{[^}]*max-width:\s*100%[^}]*\}/s.test(css);
    const hasHeightAuto = /\.shot-thumb\s*\{[^}]*height:\s*auto/s.test(css);
    record(
      '截图预览 img 宽度不超过容器（I-07）',
      thumbRule && hasHeightAuto && js.includes('shot-thumb'),
      `max-width=${thumbRule} height:auto=${hasHeightAuto}`,
    );

    void notifier;
    void shotsExisted;
  } finally {
    await app.services.profiles.shutdown();
    await hook.close();
    await site.close();
    finish();
  }

  function finish(): void {
    if (finished) return;
    finished = true;
    const passed = checks.filter((c) => c[1]).length;
    console.log('');
    console.log(`  ${passed}/${checks.length} 通过`);
    const failed = checks.filter((c) => !c[1]);
    if (failed.length > 0) {
      console.log('  未通过：');
      for (const [name, , detail] of failed) console.log(`    × ${name}${detail ? ` — ${detail}` : ''}`);
    }
    void fastify.close();
    process.exitCode = failed.length === 0 ? 0 : 1;
  }
}

function countRows(db: { prepare(sql: string): { get(): unknown } }, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

async function reserveClosedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

await main();
