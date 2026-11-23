/**
 * 真实实例冒烟：对着已经跑起来的 FoxBox 服务创建任务，验证「截图 + 页面采集」。
 *
 * 和 m4-demo 的区别：m4 自己拉一个无头服务验证语义；这个脚本不碰数据库、
 * 不发新进程，只通过 HTTP 打你正在用的那个实例（桌面壳里那个窗口也会同步变化）。
 *
 * 用法：
 *   npx tsx scripts/live-task.ts              # 自动读 /tmp/fox.env 的端口与 token
 *   npx tsx scripts/live-task.ts --port 63793 --token xxx
 *   npx tsx scripts/live-task.ts --profile 01M7...   # 指定环境
 *   npx tsx scripts/live-task.ts --keep              # 跑完不清理任务记录（方便在界面里回看）
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

interface ProfileShape {
  id: string;
  name: string;
  status: string;
  engine: string;
}

interface StepResult {
  index: number;
  type: string;
  status: string;
  elapsedMs: number;
  output?: unknown;
  error?: string;
  note?: string;
}

interface RunResult {
  profileId: string;
  profileName: string;
  status: string;
  elapsedMs: number;
  steps: StepResult[];
  vars: Record<string, unknown>;
  screenshots: string[];
  error?: string;
}

interface TaskShape {
  id: string;
  name: string;
  status: string;
  result: { runs: RunResult[]; summary: Record<string, number> } | null;
  error: string | null;
}

function argOf(name: string, fallback = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
}

function loadEnvFile(): { port: string; token: string } {
  const file = path.join('/tmp', 'fox.env');
  try {
    const [port = '', token = ''] = fs.readFileSync(file, 'utf8').trim().split(/\s+/);
    return { port, token };
  } catch {
    return { port: '', token: '' };
  }
}

const fromFile = loadEnvFile();
const port = argOf('port') || process.env.FOXBOX_PORT || fromFile.port;
const token = argOf('token') || process.env.FOXBOX_TOKEN || fromFile.token;
const wantProfile = argOf('profile');
const keep = process.argv.includes('--keep');

if (!port || !token) {
  console.error('缺少端口或 token：用 --port/--token 指定，或把 "port token" 写进 /tmp/fox.env');
  process.exit(1);
}

const base = `http://127.0.0.1:${port}`;

async function api<T = any>(p: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(base + p, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = body?.message ?? body?.error ?? text;
    throw new Error(`${init.method ?? 'GET'} ${p} -> ${res.status} ${msg}`);
  }
  return body as T;
}

/**
 * 任务 duration 可能是几十秒，2 秒一轮足够，也不会把接口打爆。
 * queued 也要继续等：launch 是 fire-and-forget，POST 返回时 markRunning 可能还没落库。
 */
async function waitTask(id: string, timeoutMs = 180_000): Promise<TaskShape> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const task = await api<TaskShape>(`/api/tasks/${id}`);
    if (task.status !== 'running' && task.status !== 'queued') return task;
    if (last !== task.status) {
      last = task.status;
      process.stdout.write('  执行中');
    } else {
      process.stdout.write('.');
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`任务 ${id} 超过 ${timeoutMs}ms 仍未结束`);
}

function short(v: unknown, max = 160): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s === undefined) return '—';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function printRun(run: RunResult, screenshotRoot: string): void {
  console.log(`  环境 ${run.profileName} · ${run.status} · ${run.elapsedMs}ms`);
  if (run.error) console.log(`  错误：${run.error}`);
  for (const step of run.steps) {
    const mark = step.status === 'ok' ? '✓' : step.status === 'skipped' ? '·' : '✗';
    const detail = step.error ?? step.note ?? short(step.output);
    console.log(
      `  ${mark} [${String(step.index).padStart(2, '0')}] ${step.type.padEnd(10)} ${String(
        step.elapsedMs,
      ).padStart(6)}ms  ${detail}`,
    );
  }
  for (const rel of run.screenshots) {
    const abs = path.join(screenshotRoot, rel);
    let size = '缺失';
    try {
      size = `${(fs.statSync(abs).size / 1024).toFixed(0)}KB`;
    } catch {
      /* 文件没落盘时保持原文案，方便定位问题 */
    }
    console.log(`  截图 ${abs} (${size})`);
  }
}

async function createAndRun(name: string, body: Record<string, unknown>): Promise<TaskShape> {
  const created = await api<TaskShape>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ name, runNow: true, ...body }),
  });
  console.log(`\n▸ ${name}`);
  console.log(`  taskId ${created.id}`);
  const done = await waitTask(created.id);
  return done;
}

async function main(): Promise<void> {
  console.log(`FoxBox 真实实例冒烟 · ${base}`);

  const sys = await api('/api/system');
  console.log(`  home=${sys.home}  环境 ${sys.profiles} 个  运行中 ${sys.running} 个`);

  const list = await api<{ items: ProfileShape[] }>('/api/profiles');
  const profiles = list.items;
  const running = profiles.filter((p) => p.status === 'running');
  const target =
    (wantProfile && profiles.find((p) => p.id === wantProfile)) || running[0] || profiles[0];
  if (!target) throw new Error('这个实例里还没有环境，先在界面里建一个再跑');
  console.log(
    `  目标环境 ${target.name}（${target.status === 'running' ? '运行中，任务将复用现有窗口' : '未运行，任务会拉起'}）`,
  );

  const screenshotRoot = sys.home as string;
  const taskIds: string[] = [];

  // ---- 1. 采集 + 截图 + 变量回填 ----
  // 选 quotes.toscrape.com：结构稳定、无需登录、DOM 够多能看出全页截图效果
  const collect = await createAndRun('冒烟 · 采集名言 + 全页截图', {
    target: { profileIds: [target.id] },
    steps: [
      { type: 'start' },
      { type: 'goto', url: 'https://quotes.toscrape.com/', waitUntil: 'domcontentloaded' },
      {
        type: 'eval',
        saveAs: 'quotes',
        script: `Array.from(document.querySelectorAll('.quote')).map(function (el) {
          var text = el.querySelector('.text');
          var author = el.querySelector('.author');
          var tags = el.querySelectorAll('.tag');
          return {
            text: text ? text.textContent.trim().replace(/^[\u201c"]|[\u201d"]$/g, '') : null,
            author: author ? author.innerText.trim() : null,
            tags: Array.from(tags).map(function (t) { return t.innerText.trim(); })
          };
        })`,
      },
      // 上一步的值以字面量注入，验证 {{vars.x}} 回填链路（不是再抓一次 DOM）
      {
        type: 'eval',
        saveAs: 'summary',
        script: `(function () {
          var q = {{vars.quotes}};
          var authors = [];
          var tags = [];
          q.forEach(function (item) {
            if (item.author && authors.indexOf(item.author) === -1) authors.push(item.author);
            item.tags.forEach(function (t) { if (tags.indexOf(t) === -1) tags.push(t); });
          });
          return { total: q.length, uniqueAuthors: authors.length, topTags: tags.slice(0, 6) };
        })()`,
      },
      { type: 'screenshot', fullPage: true },
    ],
  });
  taskIds.push(collect.id);
  const collectRun = collect.result?.runs[0];
  if (!collectRun) throw new Error('任务没有产生运行结果');
  printRun(collectRun, screenshotRoot);
  const quotes = (collectRun.vars.quotes as any[]) ?? [];
  const summary = collectRun.vars.summary as any;
  console.log(`  采集：${quotes.length} 条，作者 ${summary?.uniqueAuthors ?? '?'} 位，标签 ${short(summary?.topTags, 80)}`);
  if (quotes[0]) console.log(`  首条：${short(quotes[0].text, 60)} — ${quotes[0].author}`);

  // ---- 2. 分页 + 视口截图 ----
  const page2 = await createAndRun('冒烟 · 翻页采集 + 视口截图', {
    target: { profileIds: [target.id] },
    steps: [
      { type: 'start' },
      { type: 'goto', url: 'https://quotes.toscrape.com/page/2/', waitUntil: 'load' },
      {
        type: 'eval',
        saveAs: 'authors2',
        script: `Array.from(document.querySelectorAll('.quote .author')).map(function (el) {
          return el.textContent.trim();
        })`,
      },
      { type: 'screenshot' },
    ],
  });
  taskIds.push(page2.id);
  const page2Run = page2.result?.runs[0];
  if (page2Run) printRun(page2Run, screenshotRoot);

  // ---- 3. 采集脚本报错时错误要能看见 ----
  const broken = await createAndRun('冒烟 · 采集脚本报错（预期失败）', {
    target: { profileIds: [target.id] },
    steps: [
      { type: 'start' },
      { type: 'goto', url: 'https://example.com', waitUntil: 'domcontentloaded' },
      { type: 'eval', script: `document.querySelector('#no-such-node').click()` },
    ],
  });
  taskIds.push(broken.id);
  const brokenRun = broken.result?.runs[0];
  if (brokenRun) printRun(brokenRun, screenshotRoot);

  // ---- 汇总 ----
  const ok = (t: TaskShape) => t.status === 'succeeded';
  const checks: Array<[string, boolean]> = [
    ['采集任务成功', ok(collect)],
    ['采到 10 条名言', quotes.length === 10],
    ['变量回填可跨步使用', summary?.total === quotes.length],
    ['全页截图落盘', (collectRun.screenshots.length ?? 0) === 1],
    ['翻页任务成功', ok(page2)],
    ['坏脚本按失败处理', broken.status === 'failed'],
  ];
  console.log('\n验收：');
  let pass = 0;
  for (const [name, good] of checks) {
    console.log(`  ${good ? '✓' : '✗'} ${name}`);
    if (good) pass++;
  }
  console.log(`  ${pass}/${checks.length}`);

  if (!keep) {
    for (const id of taskIds) await api(`/api/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined);
    console.log('  已清理任务记录（加 --keep 可保留）');
  }

  // 采集结果另存一份，方便直接看
  const dump = path.join(screenshotRoot, 'live-task-last.json');
  fs.writeFileSync(
    dump,
    JSON.stringify(
      { at: new Date().toISOString(), task: collect.id, quotes, summary, runs: collect.result?.runs },
      null,
      2,
    ),
  );
  console.log(`  采集结果 ${dump}`);
  if (collectRun.screenshots[0]) {
    console.log(`  截图 ${path.join(screenshotRoot, collectRun.screenshots[0])}`);
  }
  if (pass !== checks.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\n失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
