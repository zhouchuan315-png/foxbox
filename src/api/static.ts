import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 界面资源托管。
 *
 * 不引 @fastify/static：只有 4 个文件，加一个依赖不值得，
 * 而且这里需要"读一次、改一行、再吐出去"的 token 注入能力。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
export const UI_DIR = path.resolve(here, '../../ui');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/** 只允许 ui/ 下的一层平铺文件；`..`、子目录、绝对路径一律拒绝 */
export function resolveUiAsset(name: string): { file: string; mime: string } | null {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  const file = path.join(UI_DIR, name);
  if (!file.startsWith(UI_DIR + path.sep)) return null;
  try {
    if (!fs.statSync(file).isFile()) return null;
  } catch {
    return null;
  }
  return { file, mime: MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' };
}

/** 把服务端运行期信息塞进页面，前端就不用再为取 token 多打一次接口 */
export function renderIndex(token: string, port: number): string {
  const template = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8');
  return template
    .replace('__FOXBOX_TOKEN__', token)
    .replace('__FOXBOX_PORT__', String(port));
}
