import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createApp } from '../src/core/app.ts';
import { startServer } from '../src/api/server.ts';
import { startFixtureSite } from './fixtures/login-site.ts';

/**
 * 界面冒烟。
 *
 * 每轮改动界面后跑一次，把几张关键页面截下来人眼过一遍——CSS 塌版、按钮被裁、
 * 空态误报这类问题，类型检查和接口测试都发现不了，只有看见才知道。
 *
 * 不装第二套浏览器：直接用自家引擎（headless）打开其中一个环境去访问工作台，
 * 渲染出来的就是用户看到的同一份页面。
 *
 * 用法：
 *   npm run ui-smoke                 # 截图到 .foxbox-ui-smoke/
 *   npm run ui-smoke -- --home=/tmp/x   # 指定数据目录
 */

const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

// 数据每次都用全新临时目录：否则跑第二遍会出现两份同名环境，截图看着像重影
const home = getArg('home') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'foxbox-ui-'));

// 截图固定放项目里，方便连着看几轮；每轮先清空，只留最新的
const out = path.join(process.cwd(), '.foxbox-ui-smoke', 'shots');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

/**
 * 引擎层只暴露业务需要的少数几个方法（PageLike），这里冒烟要用的是
 * Playwright 的那一面，所以按需声明一份最小接口，而不是把 PageLike 撑宽。
 */
interface SmokePage {
  goto(url: string): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  click(selector: string): Promise<void>;
  selectOption(selector: string, value: string): Promise<unknown>;
  screenshot(opts: { path: string; fullPage?: boolean }): Promise<unknown>;
  evaluate(script: string): Promise<unknown>;
  keyboard: { press(key: string): Promise<void> };
}

const app = createApp(home);
const server = await startServer(app, { port: 0 });

// 造点数据：两个环境（一个已失效、一个正常），一个数据集 12 行
const a = await app.services.profiles.create({
  name: '香港-店铺A',
  country: 'HK',
  os: 'macos',
  headless: true,
  note: '主账号',
});
const b = await app.services.profiles.create({ name: '美国-店铺B', country: 'US', os: 'macos', headless: true });

app.repos.sessions.setProfileSession(a.id, 'expired', Date.now());
app.repos.sessions.setProfileSession(b.id, 'alive', Date.now());

// 身份健康：造一台"换过显示器"的老环境，让列表角标和详情区块都有东西可看
app.repos.profiles.setHealth(b.id, {
  checkedAt: Date.now(),
  diff: [
    { key: 'screen.width', expected: 1920, actual: 1280 },
    { key: 'window.innerWidth', expected: 1904, actual: 1264 },
  ],
});

const rows = Array.from({ length: 12 }, (_, i) => ({
  订单号: `SO2026112${String(i + 1).padStart(3, '0')}`,
  商品: ['机械键盘', '无线鼠标', '显示器支架'][i % 3],
  金额: (99.5 + i * 12.3).toFixed(2),
  状态: i % 4 === 0 ? '待发货' : '已完成',
}));
const receipt = app.services.datasets.write({
  datasetName: '店铺订单',
  dedupeBy: ['订单号'],
  rows,
  profileId: a.id,
  taskId: null,
});
console.log(`数据集「${receipt.dataset}」写入 ${receipt.written} 行`);

await app.services.profiles.start(a.id);
const page = (await app.manager.page(a.id)) as unknown as SmokePage;

// 工作台首页由服务端直出，token 已注入页面（window.__FOXBOX__），
// 所以这里不能带 ?t=——isUiAsset 只认精确的 '/'，带查询串会被当成 API 走 Bearer 鉴权
await page.goto(`http://127.0.0.1:${server.port}/`);
await page.waitForTimeout(1200);

const shoot = async (name: string): Promise<void> => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
  console.log(`  ✓ ${name}`);
};

await shoot('1-profiles');

await page.click('[data-act="view"][data-id="datasets"]');
await shoot('2-datasets');

await page.click('.data-item');
await shoot('3-dataset-table');

// 详情抽屉：先回环境页，再点第一行的名字
await page.click('[data-act="view"][data-id="profiles"]');
await page.click('.cell-name');
await shoot('4-profile-detail');

// 身份健康区块在「一致性」标签页底部
await page.click('[data-act="drawer-tab"][data-id="check"]');
await page.waitForTimeout(400);
await page.evaluate("document.querySelector('.drawer-body').scrollTop = 99999");
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(out, '4b-profile-health.png'), fullPage: false });
console.log('  ✓ 4b-profile-health');

// 自动化页：没有 CDP 这件事要能在界面上直接读到，代码块不能撑破抽屉
await page.click('[data-act="drawer-tab"][data-id="automation"]');
await page.waitForTimeout(600);
await shoot('4c-automation');
await page.keyboard.press('Escape');

// 任务编辑器：新建任务会带着默认步骤打开，看步骤行有没有被裁
await page.click('[data-act="view"][data-id="tasks"]');
await page.click('[data-act="new-task"]');
await shoot('5-task-editor');

// 把第 3 步改成「采集落表」，确认那套字段（脚本/数据集/判重/最少行数）能正常铺开
await page.selectOption('.step-edit[data-i="2"] [data-role="type"]', 'collect');
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(out, '5b-collect-step.png'), fullPage: true });
console.log('  ✓ 5b-collect-step');
await page.keyboard.press('Escape');

// 会话检测弹窗（M7 的入口，只在环境页顶栏）
await page.click('[data-act="view"][data-id="profiles"]');
await page.click('[data-act="session-check"]');
await shoot('6-session-modal');
await page.keyboard.press('Escape');

// 真跑一条带截图的任务：验证任务详情里的缩略图不会按物理像素铺满容器（I-07）
const site = await startFixtureSite();
const task = app.services.tasks.create({
  name: '截图自检',
  // 必须打另一个环境：任务复用的就是 a 的页面句柄，跑在 a 上会把界面本身导航走
  target: { profileIds: [b.id] },
  steps: [
    // 任务不会替你启动环境，start 必须显式写
    { type: 'start' },
    { type: 'goto', url: `${site.url}/orders` },
    { type: 'screenshot', fullPage: false },
    { type: 'stop' },
  ],
});
const result = await app.services.tasks.run(task.id);
console.log(
  `任务「${task.name}」: ${result.summary.succeeded}/${result.summary.total} 成功，截图 ${result.runs[0]?.screenshots.length ?? 0} 张`,
);
if (result.summary.failed > 0) {
  const run = result.runs[0];
  console.log('  失败原因:', run?.error ?? run?.steps.find((st) => st.status === 'failed')?.error);
}

await page.click('[data-act="view"][data-id="tasks"]');
await page.waitForTimeout(600);
await page.click('.task-head');
await shoot('7-task-shots');

const shotMetrics = (await page.evaluate(`(() => {
  const img = document.querySelector('.shot-thumb');
  if (!img) return { found: false };
  const box = img.parentElement;
  return {
    found: true,
    naturalW: img.naturalWidth,
    naturalH: img.naturalHeight,
    clientW: img.clientWidth,
    clientH: img.clientHeight,
    boxW: box.clientWidth,
  };
})()`)) as Record<string, number | boolean>;
console.log('缩略图尺寸:', JSON.stringify(shotMetrics));
if (shotMetrics.found && Number(shotMetrics.clientW) > Number(shotMetrics.boxW) + 1) {
  console.log('  ✗ 缩略图溢出了容器');
  process.exitCode = 1;
} else if (shotMetrics.found) {
  console.log('  ✓ 缩略图收在容器内（宽度按 CSS 约束，不按物理像素铺开）');
}
await site.close();

console.log(`\n截图目录：${out}`);
console.log('看这几点：会话灯与身份标签是否正常、数据表有没有列塌陷、');
console.log('任务步骤行右侧删除按钮是否完整、弹窗底部按钮是否可见。');

await app.services.profiles.stop(a.id);
await app.services.profiles.shutdown();
await server.fastify.close();
process.exit(0);
