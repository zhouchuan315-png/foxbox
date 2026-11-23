import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createApp } from '../src/core/app.ts';
import { startServer } from '../src/api/server.ts';
import { startFixtureSite } from './fixtures/login-site.ts';
import { hostScreen } from '../src/fingerprint/host-screen.ts';
import { ensurePlausibleScreen } from '../src/fingerprint/freeze.ts';
import { validatePreset } from '../src/fingerprint/validator.ts';
import type { FingerprintPreset } from '../src/fingerprint/preset.ts';

/**
 * M11 验收：身份三件事 —— 地理坐标、dpr、canvas 覆盖。
 *
 * 这三项以前都是「缺的」：
 *   - geolocation 恒为 (0,0)，因为 geoip 被关掉后没人回填；
 *   - dpr 由宿主决定，库里写 2、浏览器报 1，一条 readback 就露；
 *   - canvas 噪声只有一个永远为 false 的字段，引擎其实支持 canvas_noise。
 *
 * 判据（都要在**真浏览器**里验证，不看配置猜）：
 * 1. 创建时 dpr 取宿主实测值，且写进 config 的 window.devicePixelRatio
 * 2. 启动后 devicePixelRatio 真的等于预设值（接管生效，不是只写在库里）
 * 3. 自检 health.diff 为空 —— dpr 现在参与比对，不一致就该报
 * 4. 没有代理时用国家兜底坐标，且落在该国附近；config 里有 geolocation:*
 * 5. 真实 origin 上 getCurrentPosition 返回声明坐标（含精度）
 * 6. canvas 强制覆盖：同一段绘制两次读数不同
 * 7. canvas 强制关闭：同一段绘制两次读数相同
 * 8. 不传 canvasNoise 时保持 null（三态没被压成布尔）
 */

const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
// 默认用一次性临时目录：重复跑不会踩到上一次遗留的浏览器数据，
// 也避免在仓库里堆一堆 profiles/。--home= 显式指定时按指定路径用。
const explicitHome = getArg('home');
const home = explicitHome ?? fs.mkdtempSync(path.join(os.tmpdir(), 'foxbox-m11-'));

interface Profile {
  id: string;
  name: string;
  canvasNoise: boolean | null;
  preset: FingerprintPreset;
}

interface RunScriptResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

async function main(): Promise<void> {
  console.log('FoxBox M11 · 身份：坐标 / dpr / canvas');
  console.log(`  home=${home}`);

  if (explicitHome) fs.rmSync(home, { recursive: true, force: true });
  const site = await startFixtureSite();
  const app = createApp(home);
  const { fastify, token, port } = await startServer(app, { port: 0 });
  const base = `http://127.0.0.1:${port}`;

  const checks: Array<[string, boolean, string]> = [];
  const record = (name: string, ok: boolean, detail = ''): void => {
    checks.push([name, ok, detail]);
    console.log(`  ${ok ? '·' : '×'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const api = async <T>(route: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${base}${route}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${route}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as T;
  };

  const create = (body: Record<string, unknown>): Promise<Profile> =>
    api<Profile>('/api/profiles', { method: 'POST', body: JSON.stringify(body) });

  const run = async (id: string, script: string): Promise<unknown> => {
    const response = await fetch(`${base}/api/profiles/${id}/run-script`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'playwright', timeoutMs: 120_000, script }),
    });
    const body = (await response.json()) as RunScriptResponse;
    if (!body.ok) throw new Error(body.error ?? '脚本失败');
    return body.result;
  };

  const host = hostScreen();
  const canvasScript = `
await page.goto('about:blank');
return await page.evaluate(() => {
  const paint = () => {
    const c = document.createElement('canvas');
    c.width = 200; c.height = 40;
    const x = c.getContext('2d');
    x.fillStyle = '#f60'; x.fillRect(10, 20, 100, 5);
    x.textBaseline = 'top'; x.font = '14px Arial'; x.fillText('foxbox probe', 2, 2);
    return c;
  };
  const sum = (c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7;
    return s;
  };
  const a = sum(paint()); const b = sum(paint());
  return { stable: a === b };
});
`;

  try {
    // ── 1. 创建：dpr 取宿主、坐标走国家兜底
    const geoProfile = await create({ name: 'M11 坐标与 dpr', country: 'HK', os: 'macos', headless: true });
    const expectedDpr = host?.dpr ?? 1;
    record(
      'dpr 取宿主实测值',
      geoProfile.preset.screen.dpr === expectedDpr,
      `preset=${geoProfile.preset.screen.dpr} host=${expectedDpr}`,
    );

    // ── 2. 启动后 dpr 真的被接管
    await api(`/api/profiles/${geoProfile.id}/start`, { method: 'POST' });
    const observed = (await run(
      geoProfile.id,
      `await page.goto('about:blank');\nreturn await page.evaluate(() => ({ dpr: devicePixelRatio }));`,
    )) as { dpr: number };
    record(
      'devicePixelRatio 被接管',
      observed.dpr === geoProfile.preset.screen.dpr,
      `页面=${observed.dpr} 预设=${geoProfile.preset.screen.dpr}`,
    );

    // ── 3. 自检不再把 dpr 当"能力边界"放过
    const detail = await api<{ health: { diff: Array<{ key: string }> } | null }>(`/api/profiles/${geoProfile.id}`);
    const diffKeys = detail.health?.diff.map((d) => d.key) ?? [];
    record('自检 diff 为空', detail.health !== null && diffKeys.length === 0, diffKeys.join(',') || '一致');

    // ── 4. 坐标落在国家附近，而不是 (0,0)
    const geo = geoProfile.preset.geolocation;
    const inHk =
      Math.abs(geo.latitude - 22.3193) < 1 && Math.abs(geo.longitude - 114.1694) < 1;
    record(
      '坐标取国家兜底值',
      inHk,
      `${geo.latitude.toFixed(4)}, ${geo.longitude.toFixed(4)} ±${Math.round(geo.accuracy ?? 0)}m`,
    );

    // ── 5. 真实 origin 上能读到声明坐标
    const position = (await run(
      geoProfile.id,
      `await page.goto('${site.url}/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
return await page.evaluate(async () => {
  const pos = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ timeout: true }), 6000);
    navigator.geolocation.getCurrentPosition(
      (p) => { clearTimeout(t); resolve({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }); },
      (e) => { clearTimeout(t); resolve({ error: e.code + ':' + e.message }); },
      { timeout: 5000 },
    );
  });
  return pos;
});`,
    )) as { lat?: number; lon?: number; acc?: number; error?: string };
    record(
      'getCurrentPosition 返回声明坐标',
      typeof position.lat === 'number' &&
        Math.abs(position.lat - geo.latitude) < 0.001 &&
        Math.abs((position.lon ?? 0) - geo.longitude) < 0.001,
      position.error ?? `${position.lat?.toFixed(4)}, ${position.lon?.toFixed(4)}`,
    );

    // ── 6/7. canvas 三态：on 随机、off 稳定
    const noisy = await create({ name: 'M11 canvas 开', country: 'HK', os: 'macos', headless: true, canvasNoise: true });
    const clean = await create({ name: 'M11 canvas 关', country: 'HK', os: 'macos', headless: true, canvasNoise: false });
    const noisyReading = (await run(noisy.id, canvasScript)) as { stable: boolean };
    const cleanReading = (await run(clean.id, canvasScript)) as { stable: boolean };
    record('canvasNoise=true 读数随机', noisyReading.stable === false, `stable=${noisyReading.stable}`);
    record('canvasNoise=false 读数稳定', cleanReading.stable === true, `stable=${cleanReading.stable}`);

    // ── 8. 不传时保持三态里的 null
    record('未指定时 canvasNoise 保持 null', geoProfile.canvasNoise === null, String(geoProfile.canvasNoise));

    // 纯函数：3440×1440 夹到宿主宽度后是 1280×536（现实中不存在），必须退回宿主尺寸。
    // 注意要喂"夹取后的形状"，喂原始的 3440×1440 等于没测到这段逻辑。
    const clippedShape: Record<string, unknown> = {
      screen: { width: 1280, height: 536, colorDepth: 24, availWidth: 1280, availHeight: 511 },
    };
    const fakeHost = { width: 1280, height: 800, dpr: 2, source: 'test' };
    ensurePlausibleScreen(clippedShape, fakeHost, 'macos');
    const fixed = clippedShape.screen as Record<string, number>;
    record(
      '超宽屏夹取后仍像真机',
      Number(fixed.height) === fakeHost.height && Number(fixed.colorDepth) === 30,
      `${fixed.width}×${fixed.height}@${fixed.colorDepth}`,
    );

    // 纯函数：坐标 (0,0) 必须被 R9 点名
    const zeroIssues = validatePreset(
      { ...geoProfile.preset, geolocation: { latitude: 0, longitude: 0 } },
      { proxyCountry: 'HK', hostOs: 'macos' },
    );
    record(
      'R9 拦得住 (0,0) 坐标',
      zeroIssues.some((i) => i.rule === 'R9'),
      zeroIssues.filter((i) => i.rule === 'R9').map((i) => i.message).join(' / '),
    );
  } finally {
    await fastify.close();
    await site.close();
    // 临时目录失败也不影响结论（沙箱/杀软可能锁着文件）
    if (!explicitHome) {
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch {
        /* 留给系统清理 */
      }
    }
  }

  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n  ${passed}/${checks.length} 通过`);
  if (passed !== checks.length) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
