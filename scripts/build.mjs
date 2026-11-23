import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 构建：tsc 出 dist，再把不能被打包器处理的东西挪过去。
 *
 * 目前只有 schema.sql：它在运行时按 __dirname 读，必须和 db/index.js 同目录。
 * ui/ 不用拷——dist/api/static.js 的 `../../ui` 恰好还指向项目根的 ui/，
 * 因为 dist/api 与 src/api 同层。这一点在改目录结构时最容易悄悄失效，
 * 所以桌面壳那边用的是"先跑 dist 再验一次 /health"的顺序，起不来会立刻暴露。
 */
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
execFileSync(join(root, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.build.json'], {
  cwd: root,
  stdio: 'inherit',
});

const dbDir = join(dist, 'core', 'db');
mkdirSync(dbDir, { recursive: true });
copyFileSync(join(root, 'src', 'core', 'db', 'schema.sql'), join(dbDir, 'schema.sql'));

if (!existsSync(join(dist, 'main.js'))) {
  console.error('构建后找不到 dist/main.js');
  process.exit(1);
}
console.log('构建完成 → dist/');
