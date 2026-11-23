import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createApp } from '../src/core/app.ts';
import { fitToHost, parseSystemProfiler, parseWindowsBounds, parseXrandr, type HostScreen } from '../src/fingerprint/host-screen.ts';

/**
 * M9 验收：身份健康。
 *
 * 这个里程碑的第一条不是代码，是**结论**：能不能"只修屏幕"。
 * 验证脚本（npm run m9:repair）已经跑出结果：
 *   改 fingerprint.screen → mediaDevices / locale / humanize 等 13 个键跟着重抽
 *   → 局部修复不成立，老环境只能整台重建。
 * 所以这里交付的是「标记」，不是「修复」。
 *
 * 判据：
 * 1. 可行性给得出明确结论，不模棱两可
 * 2. 老环境（预设 1920×1200，宿主机只有 1280×800）启动后 diff 非空 → 列表角标
 * 3. 新环境 diff 为空 → 不显示角标
 * 4. Windows 探测：拿样本注入，解析要正确（本机是 macOS，真机验不了）
 * 5. 探测不到 → fitToHost 原样返回，绝不写死尺寸
 */

const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const home = getArg('home') ?? path.join(process.cwd(), '.foxbox-m9-eval');

interface ProfileShape {
  id: string;
  name: string;
  health: { checkedAt: number; diff: Array<{ key: string; expected: unknown; actual: unknown }> } | null;
  preset: { screen: { width: number; height: number } };
}

async function main(): Promise<void> {
  console.log('FoxBox M9 · 身份健康');
  console.log(`  home=${home}`);

  fs.rmSync(home, { recursive: true, force: true });
  const app = createApp(home);

  const checks: Array<[string, boolean, string]> = [];
  const record = (name: string, ok: boolean, detail = ''): void => {
    checks.push([name, ok, detail]);
    console.log(`  ${ok ? '·' : '×'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const waitHealth = async (id: string, timeoutMs = 30_000): Promise<ProfileShape> => {
    const deadline = Date.now() + timeoutMs;
    let last = app.services.profiles.get(id) as unknown as ProfileShape;
    while (Date.now() < deadline) {
      last = app.services.profiles.get(id) as unknown as ProfileShape;
      if (last.health) return last;
      await sleep(500);
    }
    return last;
  };

  try {
    // ── 1 可行性结论
    const probeReport = readProbeReport();
    record(
      'rebuild 可行性给出明确结论（可做 / 不可做）',
      probeReport !== null,
      probeReport ? `局部修复=${probeReport.verdict}（该结论来自 npm run m9:repair）` : '没有结论文件，先跑 npm run m9:repair',
    );

    // ── 2 老环境：预设比宿主大 → 启动后 diff 非空
    const oldProfile = await app.services.profiles.create({ name: '老环境', country: 'HK', os: 'macos', headless: true });
    // 模拟"修复前创建的环境"：把库里的预设与 config 改成 1920×1200（那时还没做宿主夹取）
    const row = app.db
      .prepare('SELECT preset_json, config_json FROM profiles WHERE id = ?')
      .get(oldProfile.id) as { preset_json: string; config_json: string };
    const preset = JSON.parse(row.preset_json) as Record<string, unknown>;
    const config = JSON.parse(row.config_json) as Record<string, unknown>;
    const screen = preset.screen as Record<string, number>;
    screen.width = 1920;
    screen.height = 1200;
    const window = preset.window as Record<string, number>;
    window.innerWidth = 1920 - 16;
    window.innerHeight = 1200 - 27;
    config['screen.width'] = 1920;
    config['screen.height'] = 1200;
    config['window.innerWidth'] = 1904;
    config['window.innerHeight'] = 1173;
    app.db
      .prepare('UPDATE profiles SET preset_json = ?, config_json = ?, health_json = NULL WHERE id = ?')
      .run(JSON.stringify(preset), JSON.stringify(config), oldProfile.id);

    await app.services.profiles.start(oldProfile.id);
    const checked = await waitHealth(oldProfile.id);
    const oldDiff = checked.health?.diff ?? [];
    record(
      '老环境启动后 diff 非空 → 列表出现角标',
      oldDiff.length > 0,
      `${oldDiff.length} 项：${oldDiff
        .slice(0, 3)
        .map((d) => `${d.key} ${String(d.expected)}≠${String(d.actual)}`)
        .join('; ')}`,
    );
    await app.services.profiles.stop(oldProfile.id);

    // ── 3 新环境：创建时就夹到宿主 → diff 为空
    const fresh = await app.services.profiles.create({ name: '新环境', country: 'HK', os: 'macos', headless: true });
    await app.services.profiles.start(fresh.id);
    const freshChecked = await waitHealth(fresh.id);
    const freshDiff = freshChecked.health?.diff ?? [];
    record(
      '新环境启动后 diff 为空 → 无角标',
      freshChecked.health !== null && freshDiff.length === 0,
      freshDiff.length === 0 ? '已检查且一致' : `仍有 ${freshDiff.length} 项：${freshDiff.map((d) => d.key).join(',')}`,
    );
    await app.services.profiles.stop(fresh.id);

    // ── 4 Windows 探测：样本注入
    const winTable = parseWindowsBounds(`
Width Height X Y
----- ------ - -
 1920   1080 0 0
`);
    const winInline = parseWindowsBounds('{X=0,Y=0,Width=2560,Height=1440}');
    record(
      'Windows 探测：注入样本 → 解析正确',
      winTable?.width === 1920 && winTable?.height === 1080 && winInline?.width === 2560 && winInline?.height === 1440,
      `表格=${winTable?.width}×${winTable?.height} 行内=${winInline?.width}×${winInline?.height}`,
    );

    // 顺带把另外两个平台的解析也钉住（真机上没法换显示器，只能靠样本）
    const macSample = parseSystemProfiler(`Graphics/Displays:
    Apple M1:
      Displays:
        Color LCD:
          Main Display: Yes
          Resolution: 2560 x 1600 Retina
          UI Looks like: 1280 x 800
`);
    const xrandrSample = parseXrandr(`Screen 0: minimum 8 x 8, current 1440 x 900
HDMI-1 disconnected
eDP-1 connected primary 1440x900+0+0 (normal) 300mm x 190mm
   1920x1080     60.00 +
   1440x900      59.90*
`);
    record(
      'macOS / Linux 解析：Retina 除 2、取带 * 的模式',
      macSample?.width === 1280 && macSample?.height === 800 && macSample.dpr === 2 &&
        xrandrSample?.width === 1440 && xrandrSample?.height === 900,
      `mac=${macSample?.width}×${macSample?.height} dpr=${macSample?.dpr} linux=${xrandrSample?.width}×${xrandrSample?.height}`,
    );

    // ── 5 拿不到探测结果 → fitToHost 原样返回
    const want = { width: 1920, height: 1200, dpr: 2, colorDepth: 30 };
    const untouched = fitToHost(want, null);
    const garbage = parseSystemProfiler('完全不是 system_profiler 的输出');
    const empty = parseWindowsBounds('');
    const hostHost = { width: 1280, height: 800, dpr: 1, source: 'test' } as HostScreen;
    const clipped = fitToHost(want, hostHost);
    record(
      '拿不到探测结果 → fitToHost 原样返回，不写死尺寸',
      untouched.clipped === false &&
        untouched.screen.width === 1920 &&
        untouched.screen.height === 1200 &&
        garbage === null &&
        empty === null &&
        clipped.clipped === true &&
        clipped.screen.width <= 1280,
      `null→${untouched.screen.width}×${untouched.screen.height} 垃圾输入→null 有宿主→${clipped.screen.width}×${clipped.screen.height}`,
    );
  } finally {
    await app.services.profiles.shutdown();
    finish();
  }

  function finish(): void {
    const passed = checks.filter((c) => c[1]).length;
    console.log('');
    console.log(`  ${passed}/${checks.length} 通过`);
    const failed = checks.filter((c) => !c[1]);
    if (failed.length > 0) {
      console.log('  未通过：');
      for (const [name, , detail] of failed) console.log(`    × ${name}${detail ? ` — ${detail}` : ''}`);
    }
    process.exitCode = failed.length === 0 ? 0 : 1;
  }
}

/**
 * 读 m9:repair 的结论。
 *
 * 不在验收里重跑一遍：那要再花 40 秒去抽一份真身份，而且结论是"引擎行为"，
 * 不随代码变化。脚本会把结论写进 `.foxbox-m9-repair.json`。
 */
function readProbeReport(): { verdict: '可以' | '不可以' } | null {
  const file = path.join(process.cwd(), '.foxbox-m9-repair.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { verdict?: string };
    if (parsed.verdict === '可以' || parsed.verdict === '不可以') return { verdict: parsed.verdict };
    return null;
  } catch {
    return null;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

await main();
