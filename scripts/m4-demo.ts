import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createApp } from '../src/core/app.ts';
import { startServer } from '../src/api/server.ts';

/**
 * M4 验收：任务编排。
 *
 * 判据是这些事实，而不是「接口能返回 200」：
 * 1. 参数错误在创建时就被拒（不是跑到一半才炸）
 * 2. 空目标不会假装成功
 * 3. 真跑一条链：start → goto → eval → screenshot → stop，返回值与文件都落地
 * 4. 取消能把剩余步骤标成 skipped，而不是让任务永远挂着
 * 5. 同一个任务不能并发跑两遍
 * 6. 截图只对持有 token 的人可见，且走不出 screenshots 目录
 */

const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const home = getArg('home') ?? path.join(process.cwd(), '.foxbox-m4-eval');
const skipBrowser = args.includes('--no-browser');

interface RawResponse {
  status: number;
  body: string;
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
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }),
        );
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface TaskShape {
  id: string;
  status: string;
  result: null | {
    runs: Array<{
      profileName: string;
      status: string;
      steps: Array<{ type: string; status: string; output?: unknown; note?: string }>;
      vars: Record<string, unknown>;
      screenshots: string[];
    }>;
    summary: { total: number; succeeded: number; failed: number; skipped: number };
  };
  error: string | null;
}

async function main(): Promise<void> {
  console.log('FoxBox M4 · 任务编排');
  console.log(`  home=${home}${skipBrowser ? '（跳过真实浏览器）' : ''}`);
  console.log('');

  const app = createApp(home);
  const { fastify, token, port } = await startServer(app, { port: 0 });
  const checks: Array<[string, boolean, string]> = [];
  const record = (name: string, ok: boolean, detail = ''): void => {
    checks.push([name, ok, detail]);
    console.log(`  ${ok ? '·' : '×'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const api = async <T>(p: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
    const res = await request({ port, path: p, token, ...init });
    return (res.body ? JSON.parse(res.body) : null) as T;
  };

  // 1. 准备两个环境（不启动）
  const group = await api<{ id: string }>('/api/groups', { method: 'POST', body: { name: 'M4 演示' } });
  const mkProfile = (name: string) =>
    api<{ id: string; name: string }>('/api/profiles', {
      method: 'POST',
      body: { name, country: 'US', os: 'macos', groupId: group.id },
    });
  const p1 = await mkProfile('任务目标 A');
  const p2 = await mkProfile('任务目标 B');

  // 2. 参数校验：这些错误必须在创建时拦下
  const noSteps = await request({
    port,
    path: '/api/tasks',
    method: 'POST',
    token,
    body: { name: '空任务', target: { profileIds: [p1.id] }, steps: [] },
  });
  record('空步骤被拒', noSteps.status === 400, `HTTP ${noSteps.status}`);

  const noTarget = await request({
    port,
    path: '/api/tasks',
    method: 'POST',
    token,
    body: { name: '无目标', target: { profileIds: [] }, steps: [{ type: 'start' }] },
  });
  record('空目标被拒', noTarget.status === 400, `HTTP ${noTarget.status}`);

  const badStep = await request({
    port,
    path: '/api/tasks',
    method: 'POST',
    token,
    body: { name: '坏步骤', target: { profileIds: [p1.id] }, steps: [{ type: 'goto' }] },
  });
  record('goto 缺 url 被拒', badStep.status === 400, `HTTP ${badStep.status}`);

  // 3. 空目标在执行期同样不算成功
  const ghost = await api<TaskShape>('/api/tasks', {
    method: 'POST',
    body: { name: '幽灵目标', target: { profileIds: ['NOT-A-REAL-ID'] }, steps: [{ type: 'start' }] },
  });
  await api(`/api/tasks/${ghost.id}/run`, { method: 'POST' });
  const ghostDone = await waitDone(api, ghost.id);
  record(
    '目标不存在时任务判失败',
    ghostDone.status === 'failed',
    `${ghostDone.status} / ${ghostDone.error ?? ''}`,
  );

  // 4. 取消：wait 步骤不该把任务挂死
  const longTask = await api<TaskShape>('/api/tasks', {
    method: 'POST',
    body: {
      name: '长任务 · 待取消',
      target: { profileIds: [p2.id] },
      steps: [{ type: 'wait', ms: 60_000 }],
    },
  });
  await api(`/api/tasks/${longTask.id}/run`, { method: 'POST' });
  await sleep(400);
  const cancelRes = await request({ port, path: `/api/tasks/${longTask.id}/cancel`, method: 'POST', token });
  const cancelled = await waitDone(api, longTask.id);
  record(
    '取消后状态为 cancelled',
    cancelRes.status === 200 && cancelled.status === 'cancelled',
    `${cancelled.status}`,
  );
  record(
    '取消后剩余步骤标为 skipped',
    cancelled.result?.runs[0]?.steps.some((s) => s.status === 'skipped') ?? false,
  );

  // 5. 同一任务不能并发跑
  const runA = await request({ port, path: `/api/tasks/${longTask.id}/run`, method: 'POST', token });
  const runB = await request({ port, path: `/api/tasks/${longTask.id}/run`, method: 'POST', token });
  record(
    '重复运行被拒（409）',
    runA.status === 202 && runB.status === 409,
    `第一次 ${runA.status} / 第二次 ${runB.status}`,
  );
  await request({ port, path: `/api/tasks/${longTask.id}/cancel`, method: 'POST', token });
  await waitDone(api, longTask.id);

  // 6. 真跑一条完整链
  if (!skipBrowser) {
    const chain = await api<TaskShape>('/api/tasks', {
      method: 'POST',
      body: {
        name: '完整链路 · 打开并留证',
        target: { profileIds: [p1.id] },
        steps: [
          { type: 'start' },
          { type: 'goto', url: 'about:blank' },
          { type: 'eval', script: 'navigator.userAgent', saveAs: 'ua' },
          { type: 'screenshot' },
          { type: 'stop' },
        ],
      },
    });
    console.log('    （真实启动一次浏览器，机器繁忙时约 40–60 秒）');
    await api(`/api/tasks/${chain.id}/run`, { method: 'POST' });
    const done = await waitDone(api, chain.id, 180_000);
    const run = done.result?.runs[0];
    const ua = String(run?.vars.ua ?? '');

    record('完整链路执行成功', done.status === 'succeeded', `${done.status}`);
    record(
      '五步全部 ok',
      run?.steps.filter((s) => s.status === 'ok').length === 5,
      run?.steps.map((s) => `${s.type}:${s.status}`).join(' ') ?? '',
    );
    record('eval 结果进入变量且是真实 UA', ua.includes('Firefox'), ua.slice(0, 60));
    // 真去查一次状态：stop 步骤"执行成功"和"环境真的关了"是两件事
    const afterStop = await api<{ status: string }>(`/api/profiles/${p1.id}`);
    record('stop 步骤后环境确实已关闭', afterStop.status === 'idle', afterStop.status);

    const shot = run?.screenshots[0];
    const shotPath = shot ? path.join(home, shot) : '';
    record('截图落盘', Boolean(shotPath && fs.existsSync(shotPath)), shot ?? '无');
    record('截图是有效 PNG', Boolean(shotPath && isPng(shotPath)));

    // 7. 截图访问控制
    const noToken = await request({ port, path: `/files/${shot}`, method: 'GET' });
    record('截图无 token 返回 401', noToken.status === 401, `HTTP ${noToken.status}`);

    const withToken = await request({ port, path: `/files/${shot}?t=${token}` });
    // 响应体是二进制，上面按 utf8 读会毁掉 PNG 头，所以这里只看状态与类型
    record(
      '持有 token 可读取截图',
      withToken.status === 200 && String(withToken.headers['content-type']).startsWith('image/png'),
      `HTTP ${withToken.status} ${withToken.headers['content-type']}`,
    );

    const traversal = await request({
      port,
      path: `/files/..%2Ffoxbox.db?t=${token}`,
    });
    record('路径穿越被拒', traversal.status === 403 || traversal.status === 404, `HTTP ${traversal.status}`);
  }

  // 8. 任务列表与删除
  const list = await api<TaskShape[]>('/api/tasks');
  const expected = skipBrowser ? 2 : 3;
  record(
    '任务列表可读',
    Array.isArray(list) && list.length === expected,
    `${list.length} 条（预期 ${expected}）`,
  );

  const delGhost = await request({ port, path: `/api/tasks/${ghost.id}`, method: 'DELETE', token });
  record('删除已完成任务', delGhost.status === 204, `HTTP ${delGhost.status}`);

  // 收尾
  await api('/api/profiles/batch', {
    method: 'POST',
    body: { action: 'delete', ids: [p1.id, p2.id] },
  });

  await fastify.close();
  await finish(app, checks);
}

function isPng(file: string): boolean {
  try {
    return isPngBody(fs.readFileSync(file).toString('binary'));
  } catch {
    return false;
  }
}

function isPngBody(body: string): boolean {
  // PNG 头：89 50 4E 47
  return body.startsWith('\x89PNG');
}

async function waitDone(
  api: <T>(p: string, init?: { method?: string; body?: unknown }) => Promise<T>,
  id: string,
  timeoutMs = 60_000,
): Promise<TaskShape> {
  const deadline = Date.now() + timeoutMs;
  let last: TaskShape | null = null;
  while (Date.now() < deadline) {
    last = await api<TaskShape>(`/api/tasks/${id}`);
    if (last.status !== 'running' && last.status !== 'queued') return last;
    await sleep(500);
  }
  return last ?? ({ id, status: 'timeout', result: null, error: '等待超时' } as TaskShape);
}

async function finish(app: ReturnType<typeof createApp>, checks: Array<[string, boolean, string]>): Promise<void> {
  const line = '─'.repeat(64);
  console.log(`\n${line}`);
  console.log('  验收结论');
  console.log(line);
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? '通过  ' : '未达标'}  ${name.padEnd(30, ' ')} ${detail}`);
  }
  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(`\n  ${failed === 0 ? 'M4 验收通过' : `${failed} 项未达标`}`);
  await app.services.tasks.shutdown();
  await app.services.profiles.shutdown();
  app.db.close();
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('\nM4 验证失败：');
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
