import { Camoufox, launchOptions } from 'camoufox';
import * as fs from 'node:fs';

/**
 * 受限环境（沙箱 / 某些 CI）里 Firefox 的内容沙箱无法初始化：
 *   sandbox initialization failed: Operation not permitted
 * 会导致浏览器启动即崩。必须在 spawn 之前关掉。
 */
process.env.MOZ_DISABLE_CONTENT_SANDBOX = '1';

interface ProbeResult {
  userAgent: string;
  platform: string;
  languages: string[];
  hardwareConcurrency: number | null;
  deviceMemory: number | null;
  webdriver: boolean | null;
  timezone: string;
  utcOffsetMinutes: number;
  screen: {
    width: number;
    height: number;
    availWidth: number;
    availHeight: number;
    colorDepth: number;
  };
  dpr: number;
  webgl: { vendor: string; renderer: string } | null;
  canvasHash: string | null;
}

interface RunRecord {
  run: number;
  preset: ProbeResult;
  exitIp: string | null;
  elapsedMs: number;
}

const args = process.argv.slice(2);
const has = (name: string) => args.includes(`--${name}`);
const getArg = (name: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const config = {
  headed: has('headed'),
  runs: Number(getArg('runs') ?? '1'),
  proxy: getArg('proxy'),
  os: getArg('os') as 'windows' | 'macos' | 'linux' | undefined,
  locale: getArg('locale'),
  geoip: has('geoip'),
  presetFile: getArg('freeze'),
};

/**
 * 指纹固化：首次生成并存盘，之后每次启动复用同一份 CAMOU_CONFIG。
 * 这是 F-13（跨会话稳定）的唯一实现方式。
 * 注意：身份藏在 launchOptions().env.CAMOU_CONFIG_1 里，不是 Camoufox({preset})。
 */
async function loadOrCreateConfig(file: string): Promise<Record<string, unknown>> {
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
  }
  const opts = (await launchOptions({
    headless: !config.headed,
    os: config.os ?? 'windows',
    humanize: true,
  })) as { env?: Record<string, string> };
  const raw = opts.env?.CAMOU_CONFIG_1;
  if (!raw) throw new Error('launchOptions 未生成 CAMOU_CONFIG_1');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
  console.log(`  已生成并固化指纹 → ${file}`);
  return parsed;
}

function parseProxy(raw?: string) {
  if (!raw) return undefined;
  const url = new URL(raw);
  return {
    server: `${url.protocol}//${url.host}`,
    username: url.username || undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
  };
}

async function probeOnce(run: number): Promise<RunRecord> {
  const started = Date.now();

  const frozen = config.presetFile ? await loadOrCreateConfig(config.presetFile) : undefined;

  const browser = await Camoufox({
    headless: !config.headed,
    proxy: parseProxy(config.proxy),
    geoip: config.geoip,
    ...(frozen ? { config: frozen } : {}),
    ...(config.os ? { os: config.os } : {}),
    ...(config.locale ? { locale: config.locale } : {}),
    humanize: true,
    i_know_what_im_doing: true,
  });

  try {
    const page = await browser.newPage();
    await page.goto('about:blank');

    const preset = (await page.evaluate(() => {
      const gl = (() => {
        try {
          const canvas = document.createElement('canvas');
          const ctx = (canvas.getContext('webgl2') ||
            canvas.getContext('webgl')) as WebGLRenderingContext | null;
          if (!ctx) return null;
          const dbg = ctx.getExtension('WEBGL_debug_renderer_info');
          return {
            vendor: String(
              dbg ? ctx.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : ctx.getParameter(ctx.VENDOR),
            ),
            renderer: String(
              dbg ? ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER),
            ),
          };
        } catch {
          return null;
        }
      })();

      const canvasHash = (() => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 200;
          canvas.height = 40;
          const ctx = canvas.getContext('2d');
          if (!ctx) return null;
          ctx.textBaseline = 'top';
          ctx.font = '14px Arial';
          ctx.fillStyle = '#f60';
          ctx.fillRect(0, 0, 100, 20);
          ctx.fillStyle = '#069';
          ctx.fillText('FoxBox probe', 2, 2);
          const data = canvas.toDataURL();
          let h = 0x811c9dc5;
          for (let i = 0; i < data.length; i++) {
            h ^= data.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
          }
          return h.toString(16).padStart(8, '0');
        } catch {
          return null;
        }
      })();

      const nav = navigator as Navigator & { deviceMemory?: number };

      return {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        languages: [...navigator.languages],
        hardwareConcurrency: navigator.hardwareConcurrency ?? null,
        deviceMemory: nav.deviceMemory ?? null,
        webdriver: navigator.webdriver ?? null,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        utcOffsetMinutes: -new Date().getTimezoneOffset(),
        screen: {
          width: screen.width,
          height: screen.height,
          availWidth: screen.availWidth,
          availHeight: screen.availHeight,
          colorDepth: screen.colorDepth,
        },
        dpr: devicePixelRatio,
        webgl: gl,
        canvasHash,
      };
    })) as ProbeResult;

    let exitIp: string | null = null;
    try {
      await page.goto('https://api.ipify.org?format=json', { timeout: 12_000 });
      const body = await page.evaluate(() => document.body.innerText);
      exitIp = (JSON.parse(body) as { ip: string }).ip;
    } catch {
      exitIp = null;
    }

    return { run, preset, exitIp, elapsedMs: Date.now() - started };
  } finally {
    await browser.close();
  }
}

function normalize(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function diffRuns(records: RunRecord[]): string[] {
  if (records.length < 2) return [];
  const baseline = records[0]!;
  const keys = Object.keys(baseline.preset) as (keyof ProbeResult)[];
  const diffs: string[] = [];

  for (const record of records.slice(1)) {
    for (const key of keys) {
      const a = normalize(baseline.preset[key]);
      const b = normalize(record.preset[key]);
      if (a !== b) {
        diffs.push(`  run#${baseline.run} vs run#${record.run}  ${key}\n    基线: ${a}\n    本次: ${b}`);
      }
    }
    if (baseline.exitIp !== record.exitIp) {
      diffs.push(`  出口 IP 变化: ${baseline.exitIp} → ${record.exitIp}`);
    }
  }
  return diffs;
}

async function main() {
  console.log('FoxBox M0 · 指纹引擎可行性验证');
  console.log(`  headed=${config.headed}  runs=${config.runs}  geoip=${config.geoip}` +
    `${config.proxy ? `  proxy=${config.proxy.replace(/\/\/[^@]*@/, '//***@')}` : '  proxy=直连'}`);
  console.log('');

  const records: RunRecord[] = [];
  for (let i = 1; i <= config.runs; i++) {
    process.stdout.write(`  第 ${i}/${config.runs} 次启动...`);
    try {
      const record = await probeOnce(i);
      records.push(record);
      console.log(` 完成 (${record.elapsedMs}ms)`);
    } catch (error) {
      console.log(' 失败');
      throw error;
    }
  }

  const first = records[0]!;
  console.log('\n── 页面实际读到的指纹 ──');
  console.log(JSON.stringify({ ...first.preset, exitIp: first.exitIp }, null, 2));

  console.log('\n── 关键检查 ──');
  const checks: [string, boolean, string][] = [
    ['引擎启动成功', records.length === config.runs, `${records.length}/${config.runs}`],
    ['webdriver 为假', first.preset.webdriver !== true, String(first.preset.webdriver)],
    ['UA 可读', first.preset.userAgent.length > 0, first.preset.userAgent.slice(0, 48)],
    ['WebGL 可读', first.preset.webgl !== null, first.preset.webgl?.renderer ?? 'null'],
    ['Canvas 可读', first.preset.canvasHash !== null, first.preset.canvasHash ?? 'null'],
    ['出口 IP 可读', first.exitIp !== null, first.exitIp ?? '未获取（可能网络受限）'],
  ];
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? '通过' : '关注'}  ${name}  —  ${detail}`);
  }

  if (config.runs > 1) {
    const diffs = diffRuns(records);
    console.log('\n── 跨会话稳定性（F-13）──');
    if (diffs.length === 0) {
      console.log(`  通过：${config.runs} 次启动指纹完全一致`);
    } else {
      console.log(`  发现 ${diffs.length} 处漂移：`);
      console.log(diffs.join('\n'));
    }
  }

  console.log('\n── 启动耗时 ──');
  for (const r of records) console.log(`  run#${r.run}: ${r.elapsedMs}ms`);
}

main().catch((error) => {
  console.error('\nM0 验证失败：');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
