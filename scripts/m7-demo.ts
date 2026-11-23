import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createApp } from '../src/core/app.ts';
import { startServer } from '../src/api/server.ts';
import { startFixtureSite } from './fixtures/login-site.ts';

/**
 * M7 验收：会话巡检。
 *
 * 判据是「判定对不对」和「该不该报警」，不是「接口返回 200」：
 * 1. 未登录要判 expired，登录后要判 alive
 * 2. 打不开（代理挂、目标 500）必须判 unknown —— 把「打不开」说成「掉登录」
 *    会让用户去重新登录一个根本没掉的环境，是这类功能最常见的错
 * 3. 已经开着的环境要在新标签页里看一眼，不能把用户正在看的页面导航走
 * 4. 巡检不是「用户打开了环境」：不能刷 last_opened_at，审计也要区分
 * 5. 连续 expired 只告警一次（边沿触发），否则用户三天就把通知关了
 * 6. 并发上限 3、取消后剩余标 skipped
 *
 * 全程打本地假站点，不依赖公网。
 */

const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const home = getArg('home') ?? path.join(process.cwd(), '.foxbox-m7-eval');
/** 并发那一组要用 30 个环境，快速模式只跑 9 个（结构相同，只是少绕几圈） */
const bulkCount = args.includes('--quick') ? 9 : 30;

interface RawResponse {
  status: number;
  body: string;
  buffer: Buffer;
  headers: http.IncomingHttpHeaders;
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
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({ status: res.statusCode ?? 0, body: buffer.toString('utf8'), buffer, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

interface JobShape {
  id: string;
  status: 'running' | 'done' | 'cancelled';
  total: number;
  done: number;
  summary: { alive: number; expired: number; unknown: number; skipped: number };
  results: Array<{ profileId: string; profileName: string; status: string; detail: string | null; elapsedMs: number }>;
  error: string | null;
}

interface ProfileShape {
  id: string;
  name: string;
  lastSessionStatus: string | null;
  lastSessionCheckAt: number | null;
  lastOpenedAt: number | null;
}

interface AuditRow {
  id: number;
  action: string;
  profileId: string | null;
  detail: string | null;
}

const LOGIN_RULE = { type: 'url' as const, mustNotMatch: '/login' };

async function main(): Promise<void> {
  console.log('FoxBox M7 · 会话巡检');
  console.log(`  home=${home}`);

  fs.rmSync(home, { recursive: true, force: true });
  const site = await startFixtureSite();
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
    // 4xx/5xx 一律显式抛出：静默返回 undefined 会让断言在几步之后莫名崩掉
    if (res.status >= 400) throw new Error(`${init.method ?? 'GET'} ${p} → HTTP ${res.status} ${res.body.slice(0, 200)}`);
    return (res.body ? JSON.parse(res.body) : null) as T;
  };

  const mkProfile = (name: string, extra: Record<string, unknown> = {}): Promise<ProfileShape> =>
    api<ProfileShape>('/api/profiles', {
      method: 'POST',
      body: { name, country: 'HK', os: 'macos', headless: true, ...extra },
    });

  const runCheck = async (body: Record<string, unknown>): Promise<JobShape> => {
    const job = await api<JobShape>('/api/session/check', { method: 'POST', body });
    return waitJob(job.id);
  };

  const waitJob = async (id: string, timeoutMs = 300_000): Promise<JobShape> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = await api<JobShape>(`/api/session/jobs/${id}`);
      if (job.status !== 'running') return job;
      await sleep(500);
    }
    return api<JobShape>(`/api/session/jobs/${id}`);
  };

  /** 直接在环境里点一下登录/登出，用来制造 alive / expired 的前置状态 */
  const visit = async (profileId: string, url: string): Promise<void> => {
    await app.services.profiles.start(profileId);
    const page = await app.manager.page(profileId);
    await page.goto(url);
    await app.services.profiles.stop(profileId);
  };

  const auditRows = (): Promise<AuditRow[]> => api<AuditRow[]>('/api/audit');

  try {
    const group = await api<{ id: string }>('/api/groups', { method: 'POST', body: { name: 'M7 演示' } });
    const anon = await mkProfile('未登录环境');
    const auth = await mkProfile('已登录环境');
    record('准备两个环境', Boolean(anon.id && auth.id), `${anon.name} / ${auth.name}`);

    // ── 1 未登录 → expired
    const r1 = await runCheck({ url: `${site.url}/`, rule: LOGIN_RULE, profileIds: [anon.id] });
    record('未登录 → expired', r1.results[0]?.status === 'expired', `${r1.results[0]?.status} · ${r1.results[0]?.detail ?? ''}`);

    // ── 2 登录后 → alive
    await visit(auth.id, `${site.url}/login?go=1`);
    const r2 = await runCheck({ url: `${site.url}/`, rule: LOGIN_RULE, profileIds: [auth.id] });
    record('登录后 → alive', r2.results[0]?.status === 'alive', `${r2.results[0]?.status}`);

    // ── 3 代理指向关闭端口 → unknown（★ 不能判成 expired）
    const closedPort = await reserveClosedPort();
    const proxy = await api<{ id: string }>('/api/proxies', {
      method: 'POST',
      body: { name: '死代理', protocol: 'http', host: '127.0.0.1', port: closedPort },
    });
    const viaProxy = await mkProfile('死代理环境', { proxyId: proxy.id });
    const r3 = await runCheck({ url: `${site.url}/`, rule: LOGIN_RULE, profileIds: [viaProxy.id] });
    record(
      '代理指向关闭端口 → unknown，不是 expired',
      r3.results[0]?.status === 'unknown',
      `${r3.results[0]?.status} · ${(r3.results[0]?.detail ?? '').slice(0, 40)}`,
    );

    // ── 4 目标恒 500 → unknown（★ 站点自己故障不代表登录态）
    const r4 = await runCheck({ url: `${site.url}/500`, rule: LOGIN_RULE, profileIds: [auth.id] });
    record(
      '目标恒 500 → unknown',
      r4.results[0]?.status === 'unknown',
      `${r4.results[0]?.status} · ${(r4.results[0]?.detail ?? '').slice(0, 40)}`,
    );

    // ── 5 selector 命中 → alive；页面改版后 → expired
    const r5a = await runCheck({
      url: `${site.url}/orders`,
      rule: { type: 'selector', selector: '#orders' },
      profileIds: [auth.id],
    });
    const r5b = await runCheck({
      url: `${site.url}/orders`,
      rule: { type: 'selector', selector: '#orders-table-v2' },
      profileIds: [auth.id],
    });
    record(
      'selector 规则命中 → alive；改版后 → expired',
      r5a.results[0]?.status === 'alive' && r5b.results[0]?.status === 'expired',
      `${r5a.results[0]?.status} / ${r5b.results[0]?.status}`,
    );

    // ── 6 script 规则返回 false → expired
    const r6 = await runCheck({
      url: `${site.url}/orders`,
      rule: { type: 'script', script: 'document.querySelectorAll("#orders tbody tr").length === 999' },
      profileIds: [auth.id],
    });
    record('script 规则返回 false → expired', r6.results[0]?.status === 'expired', `${r6.results[0]?.status}`);

    // ── 7 环境已在运行 → 新开标签页，原页面 URL 不变（★）
    await app.services.profiles.start(auth.id);
    const userPage = await app.manager.page(auth.id);
    await userPage.goto(`${site.url}/orders?page=2`);
    const urlBefore = userPage.url();
    const r7 = await runCheck({ url: `${site.url}/`, rule: LOGIN_RULE, profileIds: [auth.id] });
    const urlAfter = userPage.url();
    record(
      '环境已在运行 → 新开标签页检查后关闭，原页面 URL 不变',
      r7.results[0]?.status === 'alive' && urlBefore === urlAfter && urlAfter.includes('page=2'),
      `${short(urlBefore)} → ${short(urlAfter)}`,
    );
    await app.services.profiles.stop(auth.id);

    // ── 8 巡检不改变 last_opened_at
    const openedBefore = (await api<ProfileShape>(`/api/profiles/${auth.id}`)).lastOpenedAt;
    await runCheck({ url: `${site.url}/`, rule: LOGIN_RULE, profileIds: [auth.id] });
    const openedAfter = (await api<ProfileShape>(`/api/profiles/${auth.id}`)).lastOpenedAt;
    record('巡检不改变 last_opened_at', openedBefore === openedAfter, `${openedBefore} vs ${openedAfter}`);

    // ── 9 audit 记为 session.check / session.start，不混入 profile.start
    const audits = await auditRows();
    const sessionChecks = audits.filter((a) => a.action === 'session.check');
    const sessionStarts = audits.filter((a) => a.action === 'session.start');
    const manualStarts = audits.filter((a) => a.action === 'profile.start');
    record(
      'audit 里记为 session.check，不混入 profile.start',
      sessionChecks.length > 0 && sessionStarts.length > 0 && manualStarts.every((a) => a.profileId !== viaProxy.id),
      `check=${sessionChecks.length} start=${sessionStarts.length} manual=${manualStarts.length}`,
    );

    // ── 10 并发上限 3：一次撒 30 个环境，看服务端同时收到几个请求
    site.reset();
    const bulk: ProfileShape[] = [];
    for (let i = 0; i < bulkCount; i += 1) bulk.push(await mkProfile(`并发环境 ${i + 1}`, { groupId: group.id }));
    // 让每次检测都慢一点，否则本地站点太快、并发根本叠不起来。
    // 3000ms 是有意的：浏览器启动本身要 2 秒左右，窗口太短的话
    // 三个 lane 的请求永远错开，测出来恒为 1，反而看不出上限是否生效。
    site.reset();
    const bulkJob = await runCheck({
      url: `${site.url}/slow?ms=3000`,
      rule: LOGIN_RULE,
      profileIds: bulk.map((p) => p.id),
    });
    const stats = site.stats();
    record(
      `${bulkCount} 个环境、并发 3 → 实际最大并发 ≤ 3`,
      stats.maxConcurrent <= 3 && stats.maxConcurrent >= 2,
      `maxConcurrent=${stats.maxConcurrent} total=${stats.total} 结果=${bulkJob.summary.alive}alive`,
    );

    // ── 11 取消 → 剩余标 skipped，已完成的保留
    site.reset();
    const running = await api<JobShape>('/api/session/check', {
      method: 'POST',
      body: { url: `${site.url}/slow?ms=600`, rule: LOGIN_RULE, profileIds: bulk.map((p) => p.id) },
    });
    await sleep(1500);
    await api(`/api/session/jobs/${running.id}/cancel`, { method: 'POST' });
    const cancelled = await waitJob(running.id);
    record(
      '取消 → 剩余标 skipped，已完成的检查结果保留',
      cancelled.status === 'cancelled' &&
        cancelled.summary.skipped > 0 &&
        cancelled.results.filter((r) => r.status !== 'skipped').length > 0 &&
        cancelled.done === cancelled.total,
      `${cancelled.status} done=${cancelled.done}/${cancelled.total} skipped=${cancelled.summary.skipped}`,
    );

    // ── 12 连续两次 expired → 只产生 1 次事件（★）
    const fresh = await mkProfile('边沿环境 A');
    await runCheck({ url: `${site.url}/`, rule: LOGIN_RULE, profileIds: [fresh.id] });
    await runCheck({ url: `${site.url}/`, rule: LOGIN_RULE, profileIds: [fresh.id] });
    const expiredEvents = (await auditRows()).filter(
      (a) => a.action === 'session.expired' && a.profileId === fresh.id,
    );
    record('连续两次 expired → 只产生 1 次事件', expiredEvents.length === 1, `events=${expiredEvents.length}`);

    // ── 13 alive → expired → alive → expired → 2 次事件（边沿）
    const edge = await mkProfile('边沿环境 B');
    for (const action of ['login', 'logout', 'login', 'logout'] as const) {
      await visit(edge.id, action === 'login' ? `${site.url}/login?go=1` : `${site.url}/logout`);
      await runCheck({ url: `${site.url}/`, rule: LOGIN_RULE, profileIds: [edge.id] });
    }
    const edgeEvents = (await auditRows()).filter(
      (a) => a.action === 'session.expired' && a.profileId === edge.id,
    );
    record('alive→expired→alive→expired → 2 次事件', edgeEvents.length === 2, `events=${edgeEvents.length}`);

    // ── 14 列表页灯色：绿 / 灰问号 / 红，never 显示「未检测」
    const overview = await api<{ alive: number; expired: number; unknown: number; never: number; total: number }>(
      '/api/session/overview',
    );
    const neverProfile = await mkProfile('从未检测');
    const overview2 = await api<{ alive: number; expired: number; unknown: number; never: number; total: number }>(
      '/api/session/overview',
    );
    record(
      '列表页灯色：绿/灰问号/红，never 显示「未检测」',
      overview2.alive >= 1 &&
        overview2.expired >= 1 &&
        overview2.unknown >= 1 &&
        overview2.never >= 1 &&
        overview2.never === overview.never + 1 &&
        (await api<ProfileShape>(`/api/profiles/${neverProfile.id}`)).lastSessionStatus === null,
      `alive=${overview2.alive} expired=${overview2.expired} unknown=${overview2.unknown} never=${overview2.never}`,
    );
  } finally {
    await app.services.profiles.shutdown();
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

/** 找一个当前没人监听的端口：起一个 server 拿到端口后立刻关掉 */
async function reserveClosedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function short(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url.slice(0, 40);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

await main();
