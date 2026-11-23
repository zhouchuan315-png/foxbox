import * as fs from 'node:fs';
import * as path from 'node:path';
import { createApp } from '../src/core/app.ts';
import { hostOsFamily } from '../src/core/paths.ts';
import { warmUpEngine } from '../src/core/engines/warmup.ts';
import type { OsFamily } from '../src/fingerprint/preset.ts';

/**
 * M1 闭环验证：创建 → 启动 → 自检 → 关闭 → 再启动 → 比对漂移。
 *
 * 这不是单元测试，是"人眼看结果"的验收脚本。
 * 判据三条：引擎能起、指纹两次一致、存储目录被复用。
 */

const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const has = (name: string): boolean => args.includes(`--${name}`);

const country = getArg('country') ?? 'HK';
const os = (getArg('os') as OsFamily | undefined) ?? hostOsFamily();
const headless = !has('headed');
const home = getArg('home') ?? path.join(process.cwd(), '.foxbox');

function line(char = '─', n = 62): string {
  return char.repeat(n);
}

async function main(): Promise<void> {
  console.log('FoxBox M1 · 环境生命周期闭环');
  console.log(`  home=${home}  os=${os}  country=${country}  headless=${headless}`);
  console.log('');

  const app = createApp(home);

  // 0. 预热
  process.stdout.write('  [0/6] 预热引擎（首次约 30 秒，采样宿主渲染）...');
  const warm = await warmUpEngine(os);
  console.log(warm.ok ? ` 完成 (${warm.elapsedMs}ms)` : ` 失败：${warm.error}`);
  if (!warm.ok) throw new Error('引擎预热失败，后续启动会各慢 30 秒但通常仍可用');

  // 1. 创建
  process.stdout.write('  [1/6] 创建环境（固化指纹）...');
  const created = await app.services.profiles.create({
    name: `M1 演示环境 ${new Date().toISOString().slice(11, 19)}`,
    country,
    os,
    headless,
  });
  console.log(` 完成 id=${created.id}`);
  console.log(
    `       身份 UA=${created.preset.ua.slice(0, 58)}…\n` +
      `       屏幕=${created.preset.screen.width}x${created.preset.screen.height}@${created.preset.screen.dpr}x  ` +
      `时区=${created.preset.timezone}  语言=${created.preset.locale}\n` +
      `       GPU=${created.preset.webgl.renderer.slice(0, 52)}`,
  );

  // 2. 启动
  process.stdout.write('  [2/6] 启动...');
  const first = await app.services.profiles.start(created.id);
  console.log(` 完成 pid=${first.pid} 耗时=${first.elapsedMs}ms`);

  // 3. 自检
  process.stdout.write('  [3/6] 指纹自检...');
  const check1 = await app.services.profiles.selfCheck(created.id);
  console.log(check1.ok ? ' 一致' : ` ${check1.mismatches.length} 处不一致`);
  if (!check1.ok) {
    for (const m of check1.mismatches) {
      console.log(`       ${m.key}: 期望 ${JSON.stringify(m.expected)} 实际 ${JSON.stringify(m.actual)}`);
    }
  }

  // 4. 关闭
  process.stdout.write('  [4/6] 关闭...');
  await app.services.profiles.stop(created.id);
  const dir = path.join(home, 'profiles', created.id);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  console.log(` 完成，user-data-dir 已落盘 ${files} 个条目`);

  // 5. 再启动
  process.stdout.write('  [5/6] 再次启动（复用同一环境）...');
  const second = await app.services.profiles.start(created.id);
  const check2 = await app.services.profiles.selfCheck(created.id);
  console.log(` 完成 pid=${second.pid} 耗时=${second.elapsedMs}ms`);
  console.log(`       自检：${check2.ok ? '一致' : `${check2.mismatches.length} 处不一致`}`);

  // 6. 跨启动比对
  console.log(`\n${line()}`);
  console.log('  页面实际读到的指纹（第二次启动）');
  console.log(line());
  const observed = check2.observed as Record<string, unknown>;
  for (const key of ['userAgent', 'platform', 'languages', 'timezone', 'screen', 'dpr', 'webgl', 'webdriver']) {
    const value = JSON.stringify(observed[key]);
    console.log(`  ${key.padEnd(21)} ${value.length > 92 ? value.slice(0, 92) + '…' : value}`);
  }

  console.log(`\n${line()}`);
  console.log('  跨启动稳定性（F-13）');
  console.log(line());
  const drift = diff(check1.observed, check2.observed);
  if (drift.length === 0) {
    console.log('  通过：两次启动页面读数完全一致');
  } else {
    console.log(`  发现 ${drift.length} 处漂移：`);
    for (const d of drift) console.log(`    ${d}`);
  }

  console.log(`\n${line()}`);
  console.log('  验收结论');
  console.log(line());
  const checks: Array<[string, boolean, string]> = [
    ['环境创建成功', Boolean(created.id), created.id],
    ['首次启动成功', first.pid > 0, `pid=${first.pid} ${first.elapsedMs}ms`],
    ['二次启动成功', second.pid > 0, `pid=${second.pid} ${second.elapsedMs}ms`],
    ['两次 pid 不同（确实是新进程）', first.pid !== second.pid, `${first.pid} → ${second.pid}`],
    ['自检通过', check1.ok && check2.ok, `run1=${check1.ok} run2=${check2.ok}`],
    ['零指纹漂移', drift.length === 0, `${drift.length} 处`],
    ['存储目录被复用', files > 0, `${dir} (${files} 项)`],
    ['webdriver 为假', observed.webdriver !== true, String(observed.webdriver)],
    ['启动耗时达标（≤5s）', second.elapsedMs <= 5000, `${second.elapsedMs}ms`],
  ];
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? '通过' : '未达标'}  ${name.padEnd(28, ' ')} ${detail}`);
  }

  await app.services.profiles.stop(created.id);
  await app.services.profiles.shutdown();
  app.db.close();

  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(`\n  ${failed === 0 ? 'M1 验收通过' : `${failed} 项未达标`}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

function diff(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = JSON.stringify(a[key] ?? null);
    const y = JSON.stringify(b[key] ?? null);
    if (x !== y) out.push(`${key}: ${x} → ${y}`);
  }
  return out;
}

main().catch((error) => {
  console.error('\nM1 验证失败：');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
