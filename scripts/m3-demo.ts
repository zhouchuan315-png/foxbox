import * as http from 'node:http';
import * as path from 'node:path';
import { createApp } from '../src/core/app.ts';
import { startServer } from '../src/api/server.ts';

/**
 * M3 验收：管理界面 + 批量操作 + 离线校验。
 *
 * 判据不是「页面能打开」，而是这几件事实：
 * 1. 界面与 API 走同一份鉴权，但静态资源不需要 token（漏了就是白屏）
 * 2. 伪造 Host 被拒（DNS rebinding 防线真的在）
 * 3. 批量动作逐条返回结果，一条失败不连坐
 * 4. 批量移动后分组计数跟着变
 * 5. 离线校验不需要启动浏览器就能给出结论
 */

const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const home = getArg('home') ?? path.join(process.cwd(), '.foxbox-m3-eval');

interface RawResponse {
  status: number;
  body: string;
}

function request(opts: {
  port: number;
  path: string;
  method?: string;
  token?: string;
  host?: string;
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
    if (opts.host) headers.host = opts.host;

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

async function main(): Promise<void> {
  console.log('FoxBox M3 · 管理界面 / 批量操作 / 离线校验');
  console.log(`  home=${home}`);
  console.log('');

  const app = createApp(home);
  const { fastify, token, port } = await startServer(app, { port: 0 });
  const checks: Array<[string, boolean, string]> = [];
  const record = (name: string, ok: boolean, detail = ''): void => {
    checks.push([name, ok, detail]);
    console.log(`  ${ok ? '·' : '×'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  // 1. 静态界面
  const index = await request({ port, path: '/' });
  const hasToken = index.body.includes(`token: '${token}'`);
  record(
    '界面可访问且注入了运行期 token',
    index.status === 200 && hasToken,
    `HTTP ${index.status}，token 注入 ${hasToken ? '成功' : '缺失'}`,
  );

  const asset = await request({ port, path: '/ui/app.js' });
  const css = await request({ port, path: '/ui/style.css' });
  record(
    '两个静态资源均可加载',
    asset.status === 200 && css.status === 200,
    `app.js ${asset.status} / style.css ${css.status}`,
  );

  // 2. 穿越与 Host 白名单
  const traversal = await request({ port, path: '/ui/../package.json' });
  record('路径穿越被拦', traversal.status !== 200, `HTTP ${traversal.status}`);

  const badHost = await request({ port, path: '/api/profiles', token, host: 'evil.example.com' });
  record('伪造 Host 被拒（防 DNS rebinding）', badHost.status === 403, `HTTP ${badHost.status}`);

  const noToken = await request({ port, path: '/api/profiles' });
  record('API 缺 token 被拒', noToken.status === 401, `HTTP ${noToken.status}`);

  // 3. 造数据：两个分组 + 三个环境
  const groupA = await request({
    port,
    path: '/api/groups',
    method: 'POST',
    token,
    body: { name: `M3 分组 A ${Date.now().toString(36).slice(-4)}` },
  });
  const groupId = (JSON.parse(groupA.body) as { id: string }).id;

  const ids: string[] = [];
  for (const [i, country] of ['HK', 'US', 'JP'].entries()) {
    const created = await request({
      port,
      path: '/api/profiles',
      method: 'POST',
      token,
      body: { name: `M3 环境 ${i + 1}`, country, os: 'windows' },
    });
    if (created.status === 201) ids.push((JSON.parse(created.body) as { id: string }).id);
  }
  record('创建 3 个环境', ids.length === 3, `${ids.length}/3`);

  // 4. 离线校验：不需要启动浏览器
  const validate = await request({ port, path: `/api/profiles/${ids[0]}/validate`, token });
  const validateBody = JSON.parse(validate.body) as { ok: boolean; issues: unknown[] };
  record(
    '离线校验返回结论',
    validate.status === 200 && typeof validateBody.ok === 'boolean',
    `ok=${validateBody.ok} issues=${validateBody.issues.length}`,
  );

  // 5. 批量移动
  const moved = await request({
    port,
    path: '/api/profiles/batch',
    method: 'POST',
    token,
    body: { action: 'move', ids, groupId },
  });
  const movedBody = JSON.parse(moved.body) as { succeeded: string[]; failed: unknown[] };
  const groups = JSON.parse((await request({ port, path: '/api/groups', token })).body) as Array<{
    id: string;
    profileCount: number;
  }>;
  const groupCount = groups.find((g) => g.id === groupId)?.profileCount;
  record(
    '批量移动成功且分组计数同步',
    movedBody.succeeded.length === 3 && groupCount === 3,
    `成功 ${movedBody.succeeded.length}/3，分组计数 ${groupCount}`,
  );

  // 6. 部分失败不连坐：混入一个不存在的 id
  const partial = await request({
    port,
    path: '/api/profiles/batch',
    method: 'POST',
    token,
    body: { action: 'stop', ids: [ids[0], 'NOT_EXISTS'] },
  });
  const partialBody = JSON.parse(partial.body) as {
    succeeded: string[];
    failed: Array<{ id: string; code: string }>;
  };
  record(
    '批量中单条失败不影响其余',
    partial.status === 200 && partialBody.succeeded.length === 1 && partialBody.failed.length === 1,
    `HTTP ${partial.status}，成功 ${partialBody.succeeded.length} / 失败 ${partialBody.failed.length}（${partialBody.failed[0]?.code}）`,
  );

  // 7. 清空校验：move 缺 groupId 应当被参数校验挡住
  const badMove = await request({
    port,
    path: '/api/profiles/batch',
    method: 'POST',
    token,
    body: { action: 'move', ids },
  });
  record('move 缺 groupId 被拒', badMove.status === 400, `HTTP ${badMove.status}`);

  // 8. 系统信息
  const system = JSON.parse((await request({ port, path: '/api/system', token })).body) as {
    engines: { engines: string[]; maxConcurrent: number; slots: number };
    profiles: number;
  };
  record(
    '系统信息含引擎与并发名额',
    system.engines.engines.includes('camoufox') && system.engines.slots === system.engines.maxConcurrent,
    `引擎 ${system.engines.engines.join(',')} / 空闲 ${system.engines.slots}`,
  );

  // 收尾
  const removed = await request({
    port,
    path: '/api/profiles/batch',
    method: 'POST',
    token,
    body: { action: 'delete', ids },
  });
  const removedBody = JSON.parse(removed.body) as { succeeded: string[] };
  record('批量删除干净', removedBody.succeeded.length === 3, `${removedBody.succeeded.length}/3`);
  await request({ port, path: `/api/groups/${groupId}`, method: 'DELETE', token });

  await fastify.close();
  finish(app, checks);
}

function finish(app: ReturnType<typeof createApp>, checks: Array<[string, boolean, string]>): void {
  const line = '─'.repeat(64);
  console.log(`\n${line}`);
  console.log('  验收结论');
  console.log(line);
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? '通过  ' : '未达标'}  ${name.padEnd(30, ' ')} ${detail}`);
  }
  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(`\n  ${failed === 0 ? 'M3 验收通过' : `${failed} 项未达标`}`);
  void app.services.profiles.shutdown().finally(() => app.db.close());
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('\nM3 验证失败：');
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
