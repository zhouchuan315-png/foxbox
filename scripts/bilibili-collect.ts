/**
 * B 站视频采集 —— 外部客户端
 *
 * 它本身不打开浏览器：把采集脚本投给运行中的 FoxBox 环境执行，拿回结构化结果，
 * 落成 JSON + CSV。换句话说，你在任何能访问这个本地服务的进程里跑它都行
 * （定时任务、其它项目、脚本里 import），不用管浏览器怎么起、Cookie 怎么维持。
 *
 *   npm run bili -- --mode popular --limit 50
 *   npm run bili -- --mode search --keyword "AI 编程" --pages 2
 *   npm run bili -- --mode video --bvid BV1GJ411x7h7
 *
 * 参数：
 *   --mode      popular | search | video（默认 popular）
 *   --keyword   搜索关键词（search 必填）
 *   --bvid      视频号，可逗号分隔（video 必填）
 *   --limit     最多保留条数（默认 20）
 *   --pages     翻几页（默认 1，每页约 20 条）
 *   --detail    逐条再打详情接口：补硬币/分享/分P/分辨率/标签（50 条约 70 秒）
 *   --delay     请求间隔基准毫秒（默认 450）
 *   --profile   指定环境 id（默认自动挑一个 headless 的）
 *   --url       服务地址（默认 $FOXBOX_URL 或 http://127.0.0.1:7331）
 *   --token     Bearer token（默认 $FOXBOX_TOKEN）
 *   --out       落盘目录（默认 ./out）
 *   --no-shot   不要截图
 *   --raw       直接打印原始 JSON
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

interface Options {
  mode: string;
  keyword?: string;
  bvid?: string;
  limit: number;
  pages: number;
  delay: number;
  profile?: string;
  url: string;
  token: string;
  outDir: string;
  screenshot: boolean;
  detail: boolean;
  raw: boolean;
  timeoutMs: number;
}

interface BiliItem {
  bvid: string | null;
  title: string;
  author: string | null;
  url: string | null;
  durationSec: number | null;
  publishedAt: string | null;
  views: number | null;
  likes: number | null;
  coins: number | null;
  favorites: number | null;
  comments: number | null;
  danmaku: number | null;
  shares: number | null;
  category: string | null;
  tags: string[];
  description: string | null;
  rank?: number | null;
  pages?: number | null;
  resolution?: string | null;
}

interface CollectResult {
  mode: string;
  params: Record<string, unknown>;
  collectedAt: string;
  total: number;
  skipped: number;
  detailFailed?: number;
  warnings: string[];
  items: BiliItem[];
}

interface RunScriptResponse {
  ok: boolean;
  result?: CollectResult;
  error?: string;
  elapsedMs?: number;
  launchMs?: number;
  screenshot?: string;
}

function parseArgs(argv: string[]): Options {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const num = (name: string, fallback: number): number => {
    const value = Number(get(name));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    mode: get('mode') ?? 'popular',
    keyword: get('keyword'),
    bvid: get('bvid'),
    limit: num('limit', 20),
    pages: num('pages', 1),
    delay: num('delay', 450),
    profile: get('profile'),
    url: (get('url') ?? process.env.FOXBOX_URL ?? 'http://127.0.0.1:7331').replace(/\/$/, ''),
    token: get('token') ?? process.env.FOXBOX_TOKEN ?? '',
    outDir: path.resolve(get('out') ?? 'out'),
    screenshot: !argv.includes('--no-shot'),
    // 逐条补详情：每条视频要多打 1~2 次接口，热门 50 条约 70 秒
    detail: argv.includes('--detail'),
    raw: argv.includes('--raw'),
    timeoutMs: num('timeout', 120_000),
  };
}

async function call<T>(options: Options, route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${options.url}${route}`, {
    ...init,
    headers: {
      authorization: `Bearer ${options.token}`,
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!response.ok) {
    const detail =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : text.slice(0, 300);
    throw new Error(`HTTP ${response.status} ${route}：${detail}`);
  }
  return body as T;
}

/** 没指定环境时，优先「正在运行的 headless」，其次任意 headless */
async function resolveProfile(options: Options): Promise<{ id: string; name: string }> {
  if (options.profile) return { id: options.profile, name: options.profile };

  const listing = await call<{ items: Array<{ id: string; name: string; headless: boolean; status: string }> }>(
    options,
    '/api/profiles',
  );
  const headless = listing.items.filter((item) => item.headless);
  const picked = headless.find((item) => item.status === 'running') ?? headless[0];
  if (!picked) {
    throw new Error('没有 headless 环境可用：请在界面里新建一个（有头环境在无图形会话下起不来）');
  }
  if (picked.status !== 'running') {
    console.log(`  · 环境「${picked.name}」未运行，接口会自动启动它`);
  }
  return { id: picked.id, name: picked.name };
}

function buildScript(options: Options): string {
  const payload = fs.readFileSync(path.join(here, 'payloads', 'bilibili.js'), 'utf8');
  const params = {
    mode: options.mode,
    keyword: options.keyword,
    bvid: options.bvid,
    limit: options.limit,
    pages: options.pages,
    detail: options.detail,
    delayMs: options.delay,
  };
  return `const P = ${JSON.stringify(params)};\n${payload}`;
}

/** 中文按两格算，否则表格会错位 */
function width(text: string): number {
  let total = 0;
  for (const char of text) total += /[\u2E80-\uA4CF\uAC00-\uD7A3\uFF00-\uFFEF]/.test(char) ? 2 : 1;
  return total;
}

function pad(text: string, target: number): string {
  const padding = target - width(text);
  return padding > 0 ? text + ' '.repeat(padding) : text;
}

function trim(text: string, max: number): string {
  return width(text) <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

function compact(value: number | null): string {
  if (value === null || value === undefined) return '-';
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  return String(value);
}

function clock(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return '-';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`;
}

function toCsv(items: BiliItem[]): string {
  const columns: Array<[string, (item: BiliItem) => unknown]> = [
    ['rank', (i) => i.rank ?? null],
    ['bvid', (i) => i.bvid],
    ['title', (i) => i.title],
    ['author', (i) => i.author],
    ['views', (i) => i.views],
    ['likes', (i) => i.likes],
    ['coins', (i) => i.coins],
    ['favorites', (i) => i.favorites],
    ['comments', (i) => i.comments],
    ['danmaku', (i) => i.danmaku],
    ['shares', (i) => i.shares],
    ['durationSec', (i) => i.durationSec],
    ['pages', (i) => i.pages ?? null],
    ['resolution', (i) => i.resolution ?? null],
    ['publishedAt', (i) => i.publishedAt],
    ['category', (i) => i.category],
    ['tags', (i) => i.tags.join(' / ')],
    ['url', (i) => i.url],
  ];
  const cell = (value: unknown): string => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.map(([name]) => name).join(',')];
  for (const item of items) lines.push(columns.map(([, pick]) => cell(pick(item))).join(','));
  // BOM：Excel 直接双击打开不乱码
  return `\uFEFF${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options.token) {
    throw new Error('缺少 token：加 --token，或设 FOXBOX_TOKEN 环境变量（桌面版在 ~/.foxbox/desktop-shell.log 里）');
  }
  if (!['popular', 'search', 'video'].includes(options.mode)) {
    throw new Error(`--mode 只能是 popular / search / video，收到 ${options.mode}`);
  }

  const profile = await resolveProfile(options);
  console.log(`B 站采集 · mode=${options.mode}${options.detail ? ' + 详情' : ''} · 环境「${profile.name}」· ${options.limit} 条上限`);

  // 补详情是每条 1~2 次请求，按条数把脚本超时放宽（接口上限 300s）
  const timeoutMs = options.detail
    ? Math.min(295_000, Math.max(options.timeoutMs, 40_000 + options.limit * 2_400))
    : options.timeoutMs;
  if (options.detail) {
    console.log(`  · 逐条补详情，预计 ${Math.ceil((options.limit * 2 * (options.delay + 150)) / 1000)} 秒，请等…`);
  }

  const response = await call<RunScriptResponse>(options, `/api/profiles/${profile.id}/run-script`, {
    method: 'POST',
    body: JSON.stringify({
      mode: 'playwright',
      timeoutMs,
      screenshot: options.screenshot,
      script: buildScript(options),
    }),
  });

  if (!response.ok || !response.result) {
    throw new Error(`采集失败：${response.error ?? '没有返回结果'}`);
  }

  const data = response.result;
  if (options.raw) {
    console.log(JSON.stringify(data, null, 2));
  }

  const created = new Date();
  const stamp = `${created.getFullYear()}${String(created.getMonth() + 1).padStart(2, '0')}${String(created.getDate()).padStart(2, '0')}-${String(created.getHours()).padStart(2, '0')}${String(created.getMinutes()).padStart(2, '0')}${String(created.getSeconds()).padStart(2, '0')}`;
  fs.mkdirSync(options.outDir, { recursive: true });
  const base = path.join(options.outDir, `bilibili-${options.mode}-${stamp}`);
  fs.writeFileSync(`${base}.json`, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.writeFileSync(`${base}.csv`, toCsv(data.items), 'utf8');

  if (!options.raw) {
    const head = ['#', '播放', '点赞', ...(options.detail ? ['硬币', '分享'] : []), '时长', '标题', 'UP']
      .map((label, index) => pad(label, [4, 9, 8, 8, 8, 8, 44, 0][index] ?? 0))
      .join(' ');
    console.log(`\n  ${head}`);
    console.log(`  ${'-'.repeat(width(head))}`);
    data.items.slice(0, 20).forEach((item, index) => {
      const cells = [
        pad(String(item.rank ?? index + 1), 4),
        pad(compact(item.views), 9),
        pad(compact(item.likes), 8),
        ...(options.detail ? [pad(compact(item.coins), 8), pad(compact(item.shares), 8)] : []),
        pad(clock(item.durationSec), 8),
        pad(trim(item.title, 44), 44),
        trim(item.author ?? '-', 14),
      ];
      console.log(`  ${cells.join(' ')}`);
    });
    if (data.items.length > 20) console.log(`  … 其余 ${data.items.length - 20} 条见文件`);
  }

  const elapsed = response.elapsedMs ? `${(response.elapsedMs / 1000).toFixed(1)}s` : '-';
  const launch = response.launchMs ? `启动环境 ${(response.launchMs / 1000).toFixed(1)}s · ` : '';
  const failed = data.detailFailed ? `详情失败 ${data.detailFailed} 条 · ` : '';
  console.log(`\n  共 ${data.total} 条（去重丢弃 ${data.skipped}）· ${failed}${launch}脚本耗时 ${elapsed}`);
  for (const warning of data.warnings) console.log(`  ! ${warning}`);
  console.log(`  JSON  ${path.relative(process.cwd(), `${base}.json`)}  ${(fs.statSync(`${base}.json`).size / 1024).toFixed(1)} KB`);
  console.log(`  CSV   ${path.relative(process.cwd(), `${base}.csv`)}`);
  if (response.screenshot) console.log(`  截图  ${response.screenshot}（拼 /files/<path>?t=<token> 取）`);
}

void main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
