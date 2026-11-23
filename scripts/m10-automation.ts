import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { createApp } from '../src/core/app.ts';
import { startServer } from '../src/api/server.ts';
import { startFixtureSite } from './fixtures/login-site.ts';

/**
 * M10 验收：外部自动化（HTTP 脚本执行）。
 *
 * 需求原话是「外部可以获取 CDP 链接并执行采集脚本」。第一半做不到，且不该假装能做：
 *
 *   - Camoufox 是 Firefox，走 Juggler 协议，**没有 CDP**；
 *   - Camoufox 的 `launchServer()` 明确不支持 persistent context
 *     （camoufox/dist/server.d.ts），而我们的环境全是 persistent。
 *
 * 所以交付的是另一半的完整版：`GET /api/profiles/:id/automation` 如实说明为什么没有
 * CDP，并给出可直接粘贴的调用方式；`POST /api/profiles/:id/run-script` 让外部把
 * 采集脚本交给已启动的环境执行。
 *
 * 判据：
 * 1. automation 明确 transport=http-script、cdp=null，且示例里带真 token
 * 2. playwright 模式能登录 → 翻页 → 抓表格（这才是"采集脚本"）
 * 3. page 模式在同一页面里读 DOM（不能导航）
 * 4. screenshot:true 会落一张图，路径能对上磁盘
 * 5. 语法错误 / 超时 → 422 且 ok=false，不是 500
 * 6. autoStart:false 且没运行 → 409；默认会自动把环境起起来并回传 launchMs
 * 7. 审计留痕（不存脚本正文）
 */

const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const home = getArg('home') ?? path.join(process.cwd(), '.foxbox-m10-eval');

interface RunScriptResponse {
  ok: boolean;
  mode: string;
  result?: unknown;
  error?: string;
  elapsedMs: number;
  launchMs?: number;
  screenshot?: string;
}

async function main(): Promise<void> {
  console.log('FoxBox M10 · 外部自动化');
  console.log(`  home=${home}`);

  fs.rmSync(home, { recursive: true, force: true });
  const site = await startFixtureSite();
  const app = createApp(home);
  const { fastify, token, port } = await startServer(app, { port: 0 });

  const checks: Array<[string, boolean, string]> = [];
  const record = (name: string, ok: boolean, detail = ''): void => {
    checks.push([name, ok, detail]);
    console.log(`  ${ok ? '·' : '×'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const request = (p: string, init: { method?: string; body?: unknown } = {}): Promise<RawResponse> =>
    send({ port, path: p, token, ...init });

  const api = async <T>(p: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
    const res = await request(p, init);
    if (res.status >= 400) {
      throw new Error(`${init.method ?? 'GET'} ${p} → HTTP ${res.status} ${res.body.slice(0, 200)}`);
    }
    return (res.body ? JSON.parse(res.body) : null) as T;
  };

  try {
    const profile = await api<{ id: string }>('/api/profiles', {
      method: 'POST',
      body: { name: '外部脚本验收', country: 'HK', os: 'macos', headless: true },
    });

    // ── 1 连接信息：如实说明没有 CDP，并给可粘贴的调用方式
    const info = await api<{
      transport: string;
      cdp: string | null;
      cdpReason: string;
      exec: { url: string; headers: Record<string, string>; body: unknown };
      examples: { curl: string; python: string; node: string };
    }>(`/api/profiles/${profile.id}/automation`);
    record(
      'automation 说明 transport=http-script 且 cdp 为空',
      info.transport === 'http-script' && info.cdp === null && info.cdpReason.includes('Juggler'),
    );
    record(
      '示例里带可直接用的地址与 token',
      info.exec.url.includes(`/api/profiles/${profile.id}/run-script`) &&
        info.examples.curl.includes(token) &&
        info.examples.python.includes(token),
    );

    // ── 2 playwright 模式：登录 → 抓订单表（真采集脚本的形状）
    const collectScript = [
      `await page.goto('${site.url}/login?go=1', { waitUntil: 'domcontentloaded' });`,
      `await page.goto('${site.url}/orders', { waitUntil: 'domcontentloaded' });`,
      "const rows = await page.$$eval('#orders tbody tr', (trs) =>",
      '  trs.map((tr) => ({',
      "    orderNo: tr.getAttribute('data-order-no'),",
      "    title: tr.querySelector('.title')?.textContent?.trim(),",
      "    price: tr.querySelector('.price')?.textContent?.trim(),",
      '  })),',
      ');',
      'return { count: rows.length, first: rows[0] ?? null, url: page.url() };',
    ].join('\n');

    const collected = await api<RunScriptResponse>(`/api/profiles/${profile.id}/run-script`, {
      method: 'POST',
      body: { mode: 'playwright', script: collectScript, screenshot: true },
    });
    const payload = collected.result as { count: number; first: { orderNo: string } | null };
    record(
      'playwright 脚本采集到订单行（自动启动）',
      collected.ok && payload.count === 6 && Boolean(payload.first?.orderNo),
      `count=${payload.count} 首个=${payload.first?.orderNo} 启动=${collected.launchMs ?? 0}ms 脚本=${collected.elapsedMs}ms`,
    );

    // ── 3 截图落地
    const shotFile = collected.screenshot ? path.join(home, collected.screenshot) : '';
    record(
      'screenshot:true 落盘可读',
      Boolean(shotFile) && fs.existsSync(shotFile) && fs.statSync(shotFile).size > 1024,
      collected.screenshot ?? '没有返回路径',
    );

    // ── 4 page 模式：同一页面上下文里读 DOM
    const domRead = await api<RunScriptResponse>(`/api/profiles/${profile.id}/run-script`, {
      method: 'POST',
      body: {
        mode: 'page',
        script:
          "({ title: document.title, rows: document.querySelectorAll('#orders tbody tr').length })",
      },
    });
    const dom = domRead.result as { title: string; rows: number };
    record('page 模式读到 DOM', domRead.ok && dom.rows === 6 && dom.title.includes('订单'), `title=${dom.title}`);

    // ── 5 语法错误 → 422 而不是 500
    const syntax = await request(`/api/profiles/${profile.id}/run-script`, {
      method: 'POST',
      body: { mode: 'playwright', script: 'await page.goto(' },
    });
    const syntaxBody = JSON.parse(syntax.body) as RunScriptResponse;
    record(
      '脚本语法错误 → 422 + ok:false',
      syntax.status === 422 && syntaxBody.ok === false && /语法/.test(syntaxBody.error ?? ''),
      `HTTP ${syntax.status}`,
    );

    // ── 6 超时：脚本自己不收手，接口必须能掐断
    const timeout = await request(`/api/profiles/${profile.id}/run-script`, {
      method: 'POST',
      body: { mode: 'playwright', script: 'await new Promise((r) => setTimeout(r, 60000)); return 1;', timeoutMs: 800 },
    });
    const timeoutBody = JSON.parse(timeout.body) as RunScriptResponse;
    record(
      '超时 → 422 + 超时文案',
      timeout.status === 422 && timeoutBody.ok === false && /超时/.test(timeoutBody.error ?? ''),
      `HTTP ${timeout.status} ${timeoutBody.elapsedMs}ms`,
    );

    // ── 7 没运行 + autoStart:false → 409
    await api(`/api/profiles/${profile.id}/stop`, { method: 'POST' });
    const refused = await request(`/api/profiles/${profile.id}/run-script`, {
      method: 'POST',
      body: { mode: 'page', script: '1', autoStart: false },
    });
    record('未运行且 autoStart:false → 409', refused.status === 409, `HTTP ${refused.status}`);

    // ── 8 默认 autoStart：会顺手把环境起起来
    const auto = await api<RunScriptResponse>(`/api/profiles/${profile.id}/run-script`, {
      method: 'POST',
      body: { mode: 'page', script: '1 + 1' },
    });
    record(
      '默认 autoStart 会起环境并回传 launchMs',
      auto.ok && auto.result === 2 && typeof auto.launchMs === 'number',
      `launchMs=${auto.launchMs ?? 0}`,
    );

    // ── 9 审计：留痕但不存正文
    const audit = await api<Array<{ action: string; detail: unknown }>>('/api/audit');
    const scriptLogs = audit.filter((row) => row.action.startsWith('profile.script.'));
    // detail 在接口层已经是对象，序列化后再做"不含脚本正文"的判断
    const sample = JSON.stringify(scriptLogs[0]?.detail ?? '');
    record(
      '审计有 profile.script.* 且不含脚本正文',
      scriptLogs.length >= 3 && sample.includes('bytes') && !sample.includes('page.goto'),
      `${scriptLogs.length} 条`,
    );
  } finally {
    await app.services.profiles.shutdown().catch(() => undefined);
    const passed = checks.filter((c) => c[1]).length;
    console.log('');
    console.log(`  ${passed}/${checks.length} 通过`);
    const failed = checks.filter((c) => !c[1]);
    if (failed.length > 0) {
      console.log('  未通过：');
      for (const [name, , detail] of failed) console.log(`    × ${name}${detail ? ` — ${detail}` : ''}`);
    }
    void fastify.close();
    site.close();
    process.exitCode = failed.length === 0 ? 0 : 1;
  }
}

interface RawResponse {
  status: number;
  body: string;
}

function send(opts: { port: number; path: string; method?: string; token?: string; body?: unknown }): Promise<RawResponse> {
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
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

await main();
