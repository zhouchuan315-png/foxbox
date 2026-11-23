import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createApp } from '../src/core/app.ts';
import { startServer } from '../src/api/server.ts';

/**
 * 桌面模式（轻量版）。
 *
 * 起服务和 `npm run serve` 完全一样，区别只在"怎么把界面呈现出来"：
 * 用 Chrome / Edge / Brave 的 `--app` 模式开一个没有地址栏、没有标签页的窗口，
 * 在任务栏里就是一个独立应用。不需要 Rust、不需要打包，改完代码直接重启。
 *
 * 为什么不用系统默认浏览器直接开 URL：那样会混进用户的日常窗口里，
 * 一关就找不到了，而且地址栏会露出 token（界面是服务端注入 token 的，
 * 但 URL 会留在历史记录里）。
 *
 * 每次启动用一次性的 user-data-dir：
 * 复用固定目录的话，第二次启动会把 URL 转发给已在运行的浏览器然后自己退出，
 * 服务跟着关掉，窗口却还在——这种"看起来开了其实连不上"最难排查。
 */

const args = process.argv.slice(2);
const probeOnly = args.includes('--probe');

const BROWSER_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

const LINUX_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];

function findChromium(): string | null {
  for (const file of BROWSER_CANDIDATES) {
    if (fs.existsSync(file)) return file;
  }
  for (const name of LINUX_NAMES) {
    try {
      const found = execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (found) return found;
    } catch {
      /* 没装就试下一个 */
    }
  }
  return null;
}

async function main(): Promise<void> {
  const app = createApp(process.env.FOXBOX_HOME);
  app.repos.tasks.failOrphans('进程重启，任务已中断');
  app.services.automations.reconcile();

  const { fastify, token, port } = await startServer(app, {
    port: Number(process.env.FOXBOX_PORT ?? 7331),
    token: process.env.FOXBOX_TOKEN,
  });
  app.services.automations.start(Number(process.env.FOXBOX_TICK_MS ?? 20_000));

  const url = `http://127.0.0.1:${port}/`;
  const browser = findChromium();

  if (!browser) {
    console.log(`没找到 Chrome / Edge / Brave，改用系统默认浏览器打开 ${url}`);
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
      execFileSync(opener, [url], { stdio: 'ignore' });
    } catch {
      console.log(`请手动在浏览器里打开：${url}`);
    }
    await waitForSignal();
    await shutdown(app, fastify);
    return;
  }

  // 一次性目录，退出即删：避开"第二次启动只是把 URL 转发给已有实例"的坑
  let shell = spawnShell(browser, url, []);

  console.log(`FoxBox 桌面窗口已启动（${path.basename(browser)}）`);
  console.log(`  地址   ${url}`);
  console.log(`  数据   ${app.paths.home}`);
  console.log('  关闭窗口即退出（或在终端按 Ctrl-C）');

  if (probeOnly) {
    console.log('[probe] 只验证启动链路，不打开窗口');
    shell.child.kill();
    cleanup(shell.profileDir);
    await shutdown(app, fastify);
    return;
  }

  // 受限会话（远程桌面、CI、某些沙箱）里 Chrome 的沙箱初始化会被拒，
  // 症状是"窗口闪一下就没"，而 stderr 被丢弃时完全看不出原因。
  //
  // 判据用「30 秒内带崩溃标记退出」而不是固定等几秒：实测这台机器上
  // Chrome 会先撑十几秒再 FATAL，等 2.5 秒只会看到"还活着"。
  // 确认是沙箱被拒就带 --no-sandbox 重试一次——只放宽这一次启动，
  // 不改全局策略，也不影响用户本机的正常启动。
  const startedAt = Date.now();
  let retriedSandbox = false;
  let closing = false;

  const finish = async (reason: string): Promise<void> => {
    if (closing) return;
    closing = true;
    console.log(`\n[${reason}] 正在关闭…`);
    if (!shell.child.killed) shell.child.kill();
    cleanup(shell.profileDir);
    await shutdown(app, fastify);
  };

  const watch = (current: Shell): void => {
    current.child.on('exit', (code) => {
      const uptimeMs = Date.now() - startedAt;
      // 正常关窗（活了一阵、日志里没有崩溃标记）走普通收尾
      if (closing || uptimeMs >= 30_000 || !looksLikeCrash(current.log)) {
        void finish('窗口已关闭');
        return;
      }
      reportEarlyExit(current, code ?? 0, uptimeMs);
      cleanup(current.profileDir);
      if (!retriedSandbox && looksLikeSandboxDenial(current.log)) {
        retriedSandbox = true;
        console.log('[窗口] 这个会话不允许 Chrome 建沙箱，改用 --no-sandbox 重试一次');
        shell = spawnShell(browser, url, ['--no-sandbox']);
        watch(shell);
        return;
      }
      void finish('窗口启动失败');
    });
    current.child.on('error', (error) => {
      console.log(`启动浏览器失败：${error.message}`);
      void finish('浏览器启动失败');
    });
  };

  watch(shell);

  process.once('SIGINT', () => void finish('SIGINT'));
  process.once('SIGTERM', () => void finish('SIGTERM'));
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 目录被占用就留给系统清理 */
  }
}

interface Shell {
  child: ChildProcess;
  profileDir: string;
  /** stderr 尾巴。窗口起不来时，唯一能说明原因的就是这几行 */
  log: string[];
}

function spawnShell(browser: string, url: string, extra: string[]): Shell {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxbox-shell-'));
  const child = spawn(
    browser,
    [
      `--app=${url}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1320,880',
      '--disable-features=Translate,MediaRouter',
      ...extra,
    ],
    // stderr 必须接着：之前设成 ignore，Chrome 起不来时脚本只会报"窗口已关闭"，
    // 归因全靠人肉去猜（实际是沙箱初始化被拒，见 RUNBOOK「坑四」）
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  const log: string[] = [];
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      const text = line.trim();
      if (text) log.push(text);
    }
    if (log.length > 80) log.splice(0, log.length - 80);
  });
  // spawn 本身失败（路径没权限之类）不会触发 exit，只能靠 error
  child.on('error', (error) => log.push(`spawn 失败：${error.message}`));

  return { child, profileDir, log };
}

/** Chrome 在受限会话里的典型死法：沙箱初始化被拒 → GPU 进程连续崩溃 → FATAL */
function looksLikeCrash(log: string[]): boolean {
  return log.some((line) => /FATAL:|GPU process isn't usable|sandbox initialization failed/i.test(line));
}

function looksLikeSandboxDenial(log: string[]): boolean {
  return log.some((line) =>
    /sandbox initialization failed|Failed to initialize sandbox/i.test(line),
  );
}

function reportEarlyExit(shell: Shell, code: number, uptimeMs: number): void {
  console.log(`[窗口] 浏览器起来 ${Math.round(uptimeMs / 1000)} 秒后退出了（code ${code}）`);
  const tail = dedupeTail(shell.log, 8);
  if (tail.length === 0) {
    console.log('  stderr 是空的，没有可判断的线索');
    return;
  }
  console.log('  最后几行输出：');
  for (const line of tail) console.log(`    ${line}`);
}

/** Chrome 会滚动刷同一句，去重后再取尾巴，否则 8 行全是同一句 sandbox 失败 */
function dedupeTail(lines: string[], n: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i -= 1) {
    const line = lines[i];
    if (line === undefined) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.unshift(line);
  }
  return out;
}

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
}

async function shutdown(
  app: ReturnType<typeof createApp>,
  fastify: { close: () => Promise<unknown> },
): Promise<void> {
  app.services.automations.stop();
  await app.services.tasks.shutdown();
  await app.services.profiles.shutdown();
  await fastify.close();
  app.db.close();
  process.exit(0);
}

main().catch((error) => {
  console.error('启动失败：', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
