import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createApp } from '../src/core/app.ts';

/**
 * 启动稳定性自检：同一个环境连续启停 N 次，每次都要能在阈值内起来。
 *
 * 存在的理由：有头启动在没有图形会话的环境（SSH / CI / 自动化 shell）里会挂死
 * ——窗口创不出来，GPU 与内容子进程反复崩溃，juggler 永远握手不上。
 * 本地开发时很容易被这个现象误导成"引擎坏了"，所以留一个能一键复现的探针。
 *
 *   npm run restart-check              # headless，5 轮
 *   npm run restart-check -- --headed  # 有头，需要真实图形会话
 *   npm run restart-check -- --rounds=3
 */
const args = process.argv.slice(2);
const headed = args.includes('--headed');
const roundsArg = args.find((a) => a.startsWith('--rounds='));
const rounds = roundsArg ? Number(roundsArg.split('=')[1]) : 5;
const thresholdMs = 20_000;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'foxbox-restart-'));
const app = createApp(home);
const profile = await app.services.profiles.create({
  name: '自检',
  country: 'HK',
  os: 'macos',
  headless: !headed,
});

console.log(`home=${home}`);
console.log(`模式=${headed ? '有头' : 'headless'}  轮次=${rounds}  单次阈值=${thresholdMs}ms`);

let failed = 0;
let slow = 0;

try {
  for (let i = 1; i <= rounds; i += 1) {
    const startedAt = Date.now();
    try {
      const handle = await app.services.profiles.start(profile.id);
      const ms = Date.now() - startedAt;
      if (ms > thresholdMs) slow += 1;
      console.log(`  启动 #${i}: ${ms}ms pid=${handle.pid}${ms > thresholdMs ? '  ⚠️ 偏慢' : ''}`);
    } catch (error) {
      failed += 1;
      console.log(`  启动 #${i}: 失败 ${Date.now() - startedAt}ms ${(error as Error).message}`);
    }
    const stopStartedAt = Date.now();
    await app.services.profiles.stop(profile.id).catch(() => undefined);
    console.log(`    关闭: ${Date.now() - stopStartedAt}ms`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
} finally {
  await app.services.profiles.shutdown();
}

console.log('');
if (failed === 0 && slow === 0) {
  console.log(`✅ ${rounds}/${rounds} 全部在阈值内启动`);
  process.exit(0);
}
console.log(`❌ 失败 ${failed} 次，偏慢 ${slow} 次（共 ${rounds} 轮）`);
if (!headed) {
  console.log('   headless 下仍不稳定，需要排查引擎（见 docs/RUNBOOK.md）。');
} else {
  console.log('   有头模式不稳定：确认当前 shell 有图形会话；无会话请去掉 --headed。');
}
process.exit(1);
