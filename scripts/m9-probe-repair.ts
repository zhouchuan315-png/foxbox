import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { launchOptions } from 'camoufox';
import { createApp } from '../src/core/app.ts';

/**
 * M9 交付物之一：rebuild 可行性的**验证脚本**（先验证，再决定做不做）。
 *
 * 要回答一件事：
 *   在 Camoufox 里只改屏幕尺寸，会不会连带改变 canvas / WebGL / 字体 / 音频？
 *
 * 为什么要问：给老环境「只修屏幕」是个很诱人的功能（用户换了显示器，
 * 环境报 1920×1200 但机器只有 1280×800，窗口被压扁，一眼假）。
 * 但如果引擎的 webgl renderer、fonts、audio 都是从同一份设备样本里抽的，
 * 那么「只改屏幕」根本做不到，硬做出来的 repair 会让身份内部自相矛盾——
 * 那比不修更糟。
 *
 * 做法：取一台真实冻结过的环境，跑两种改法各自重算一次，逐键 diff。
 *   A. 改 fingerprint.screen（"重抽屏幕"路径）
 *   B. 只改 config 里的 screen.* / window.*（"覆写容器"路径，建环境时用的就是它）
 *
 *   npm run m9:repair
 */
const KEEP_KEY = (key: string): boolean => key.startsWith('screen.') || key.startsWith('window.');

/** 与身份相关、必须重点盯住的键 */
const SENSITIVE = [
  'navigator.userAgent',
  'navigator.hardwareConcurrency',
  'navigator.platform',
  'fonts',
  'webgl.vendor',
  'webgl.renderer',
  'webgl.parameters',
  'canvasNoise',
  'audio',
  'addons',
  'voices',
  'mediaDevices',
];

interface Diff {
  key: string;
  before: unknown;
  after: unknown;
}

function diffConfigs(a: Record<string, unknown>, b: Record<string, unknown>): Diff[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: Diff[] = [];
  for (const key of keys) {
    const before = a[key];
    const after = b[key];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    out.push({ key, before, after });
  }
  return out.sort((x, y) => x.key.localeCompare(y.key));
}

function summarize(diffs: Diff[]): { screenOnly: boolean; touched: string[] } {
  const touched = diffs.map((d) => d.key);
  const screenOnly = touched.every(KEEP_KEY);
  return { screenOnly, touched };
}

function short(value: unknown, max = 60): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

interface LaunchResult {
  env: Record<string, string>;
}

/**
 * 从 launchOptions 的结果里读出完整 CAMOU_CONFIG。
 *
 * 不能只读 CAMOU_CONFIG_1：环境变量有单条长度上限，引擎会把大 JSON
 * 切成 CAMOU_CONFIG_1、CAMOU_CONFIG_2… 分片存放，必须按序号拼回去。
 * （踩过一次：只读 _1 得到 32KB 处的 "Unterminated string"，
 * 看起来像引擎产出了坏 JSON，其实是我们读错了。）
 */
function readCamouConfig(result: LaunchResult): Record<string, unknown> {
  const chunks: string[] = [];
  for (let i = 1; ; i += 1) {
    const chunk = result.env[`CAMOU_CONFIG_${i}`];
    if (chunk === undefined) break;
    chunks.push(chunk);
  }
  if (chunks.length === 0) throw new Error('launchOptions 没有产出 CAMOU_CONFIG');
  return JSON.parse(chunks.join('')) as Record<string, unknown>;
}

async function compute(spec: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = (await launchOptions({
    headless: true,
    os: 'macos',
    i_know_what_im_doing: true,
    ...spec,
  } as never)) as unknown as LaunchResult;
  return readCamouConfig(result);
}

async function main(): Promise<void> {
  console.log('FoxBox M9 · rebuild 可行性验证');
  console.log('  问题：只改屏幕尺寸，会不会牵动 canvas / WebGL / 字体 / 音频？');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'foxbox-m9-probe-'));
  const app = createApp(home);

  try {
    console.log('\n[1/4] 造一台真实环境并冻结身份（冷启动要 20–40 秒）');
    const profile = await app.services.profiles.create({ name: '可行性样本', country: 'HK', os: 'macos', headless: true });
    const row = app.db
      .prepare('SELECT config_json, engine_fp_json, preset_json FROM profiles WHERE id = ?')
      .get(profile.id) as { config_json: string; engine_fp_json: string; preset_json: string };
    const config = JSON.parse(row.config_json) as Record<string, unknown>;
    const fingerprint = JSON.parse(row.engine_fp_json) as Record<string, unknown>;
    const preset = JSON.parse(row.preset_json) as { screen: { width: number; height: number }; window: unknown };
    console.log(`      环境 ${profile.id}  screen=${preset.screen.width}×${preset.screen.height}  config 键=${Object.keys(config).length}`);

    console.log('\n[2/4] 基线：同一份 fingerprint 原样重算，必须逐键一致（确认重算本身是确定性的）');
    const baseConfig = await compute({ fingerprint, config });
    const baselineDrift = diffConfigs(config, baseConfig).filter((d) => !KEEP_KEY(d.key));
    console.log(
      `      重算后差异 ${baselineDrift.length} 项${baselineDrift.length ? `：${baselineDrift.slice(0, 6).map((d) => d.key).join(', ')}` : '（完全一致）'}`,
    );

    // ── A：改 fingerprint.screen 后重算
    console.log('\n[3/4] A 方案：改 fingerprint.screen / window 后重算');
    const fpA = structuredClone(fingerprint) as Record<string, unknown>;
    const screen = (fpA.screen ?? {}) as Record<string, number>;
    const beforeScreen = { width: screen.width, height: screen.height };
    screen.width = 1280;
    screen.height = 800;
    screen.availWidth = 1280;
    screen.availHeight = 775;
    const cfgA = await compute({ fingerprint: fpA });
    const diffA = diffConfigs(baseConfig, cfgA);
    const sumA = summarize(diffA);
    console.log(`      screen ${beforeScreen.width}×${beforeScreen.height} → 1280×800`);
    console.log(`      变化键 ${diffA.length} 个${sumA.screenOnly ? '（全部属于 screen/window）' : ''}`);
    if (!sumA.screenOnly) {
      for (const d of diffA.filter((x) => !KEEP_KEY(x.key)).slice(0, 12)) {
        console.log(`        · ${d.key}: ${short(d.before)} → ${short(d.after)}`);
      }
    }

    // ── B：只改 config 里的 screen.* / window.*
    console.log('\n[4/4] B 方案：只覆写 config 的 screen.* / window.*');
    const cfgB = structuredClone(baseConfig) as Record<string, unknown>;
    cfgB['screen.width'] = 1280;
    cfgB['screen.height'] = 800;
    cfgB['screen.availWidth'] = 1280;
    cfgB['screen.availHeight'] = 775;
    cfgB['window.innerWidth'] = 1264;
    cfgB['window.innerHeight'] = 689;
    cfgB['window.outerWidth'] = 1264;
    cfgB['window.outerHeight'] = 774;
    const cfgBOut = await compute({ fingerprint, config: cfgB });
    const diffB = diffConfigs(baseConfig, cfgBOut);
    const sumB = summarize(diffB);
    console.log(`      变化键 ${diffB.length} 个${sumB.screenOnly ? '（全部属于 screen/window）' : ''}`);
    if (!sumB.screenOnly) {
      for (const d of diffB.filter((x) => !KEEP_KEY(x.key)).slice(0, 12)) {
        console.log(`        · ${d.key}: ${short(d.before)} → ${short(d.after)}`);
      }
    }

    // ── 结论
    const sensitiveA = diffA.filter((d) => SENSITIVE.includes(d.key)).map((d) => d.key);
    const sensitiveB = diffB.filter((d) => SENSITIVE.includes(d.key)).map((d) => d.key);
    const verdict = sumA.screenOnly && sumB.screenOnly ? '可以' : '不可以';

    console.log('\n结论');
    console.log(`  A（改 fingerprint.screen）：${sumA.screenOnly ? '只牵动 screen/window' : `牵动了 ${diffA.filter((d) => !KEEP_KEY(d.key)).length} 个其它键`}`);
    console.log(`  B（只覆写 config）：       ${sumB.screenOnly ? '只牵动 screen/window' : `牵动了 ${diffB.filter((d) => !KEEP_KEY(d.key)).length} 个其它键`}`);
    if (sensitiveA.length || sensitiveB.length) {
      console.log(`  身份敏感键受影响：${[...new Set([...sensitiveA, ...sensitiveB])].join(', ')}`);
    }
    console.log(`  → rebuild/replace 结论：屏幕级「局部修复」${verdict}`);
    console.log(
      verdict === '可以'
        ? '    可以只改屏幕，其余身份字段保持不变（B 路径已验证无损）。'
        : '    不能只改屏幕：其它身份字段会跟着变。老环境只能整台重建，不做局部 repair。',
    );

    // 结论落到文件，供 m9 验收直接读：这是"引擎行为"，不该在每次验收里重跑 40 秒
    const reportFile = path.join(process.cwd(), '.foxbox-m9-repair.json');
    fs.writeFileSync(
      reportFile,
      JSON.stringify(
        {
          verdict,
          checkedAt: Date.now(),
          screenOnly_fingerprint: sumA.screenOnly,
          screenOnly_config: sumB.screenOnly,
          changedByFingerprint: diffA.filter((d) => !KEEP_KEY(d.key)).map((d) => d.key),
          changedByConfig: diffB.filter((d) => !KEEP_KEY(d.key)).map((d) => d.key),
        },
        null,
        1,
      ),
    );
    console.log(`    结论已写入 ${reportFile}`);
    // 结论本身总是"跑成功了"，所以退出码给 0；判定结果看 verdict 字段
    process.exitCode = 0;
  } finally {
    await app.services.profiles.shutdown();
  }
}

await main();
