/**
 * 运行期路径约定。
 *
 * FOXBOX_HOME 之下的一切都可丢弃重建（DB 除外），因此把它整体 gitignore。
 * profiles 目录用相对路径存库，用户把 FOXBOX_HOME 整个搬走后环境依然可用。
 */
import * as os from 'node:os';
import * as path from 'node:path';

export interface Paths {
  home: string;
  dbFile: string;
  keyFile: string;
  profilesDir: string;
}

export function resolvePaths(homeOverride?: string): Paths {
  const home = path.resolve(homeOverride ?? process.env.FOXBOX_HOME ?? path.join(process.cwd(), '.foxbox'));
  return {
    home,
    dbFile: path.join(home, 'foxbox.db'),
    keyFile: path.join(home, '.key'),
    profilesDir: path.join(home, 'profiles'),
  };
}

/** 身份 OS 默认跟随宿主：异 OS 会触发 Canvas 随机化，反而更像"隐私浏览器" */
export function hostOsFamily(): 'windows' | 'macos' | 'linux' {
  const p = os.platform();
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'macos';
  return 'linux';
}
