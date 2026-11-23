/**
 * 宿主屏幕探测。
 *
 * 为什么需要：Camoufox 的 window.innerWidth/innerHeight 最终要落成一个真实窗口，
 * macOS 不允许窗口大于屏幕工作区，于是「1920×1200 的窗口」会被系统压到 1280×720。
 * 结果就是 screen.width=1920 而 innerWidth=1280、outerWidth=1280 —— 一条
 * `innerWidth < screen.width - 200` 就能看出来这不是一台真机。
 *
 * 所以预设的屏幕尺寸必须以宿主能装下的尺寸为上界；这台机器是 1280×800，
 * 就不该假装自己是 1920×1200。
 */
import { execFileSync } from 'node:child_process';

export interface HostScreen {
  /** 逻辑像素（浏览器 window.screen 意义上的宽高） */
  width: number;
  height: number;
  /** 物理像素 / 逻辑像素，Retina 为 2 */
  dpr: number;
  /** 探测来源，排障时能看出这个数字是怎么来的 */
  source: string;
}

let cached: HostScreen | null | undefined;

/** 探测不到就返回 null：宁可保持旧行为，也不猜一个尺寸把窗口压得更小 */
export function hostScreen(): HostScreen | null {
  if (cached !== undefined) return cached;
  try {
    cached =
      process.platform === 'darwin'
        ? parseSystemProfiler(execFrom(['/usr/sbin/system_profiler', '/usr/bin/system_profiler'], ['SPDisplaysDataType']))
        : process.platform === 'linux'
          ? parseXrandr(execFrom(['/usr/bin/xrandr', '/bin/xrandr', 'xrandr'], []))
          : process.platform === 'win32'
            ? parseWindowsBounds(execPowerShell())
            : null;
  } catch {
    cached = null;
  }
  return cached;
}

/** 测试用：清掉进程内缓存 */
export function resetHostScreenCache(): void {
  cached = undefined;
}

/**
 * 解析 `system_profiler SPDisplaysDataType`。
 *
 * 抽成纯函数是为了能拿样本注入测试：真机上没法来回换显示器，
 * 而"主屏识别"和"Retina 除以 2"正是最容易写错的两处。
 */
export function parseSystemProfiler(out: string): HostScreen | null {
  if (!out?.trim()) return null;
  // 只认主显示器那一段，外接屏的分辨率不该改写本机窗口能有多大
  const main = out.split(/^\s{8}\S/m).find((chunk) => /Main Display:\s*Yes/.test(chunk)) ?? out;

  // 缩放档位优先：有 "UI Looks like" 时那个才等于 window.screen 的数值
  const looksLike = main.match(/UI Looks like:\s*(\d+)\s*x\s*(\d+)/);
  if (looksLike) {
    const width = Number(looksLike[1]);
    const height = Number(looksLike[2]);
    const retina = /Retina/i.test(main);
    return { width, height, dpr: retina ? 2 : 1, source: 'system_profiler:UI Looks like' };
  }

  const res = main.match(/Resolution:\s*(\d+)\s*x\s*(\d+)(\s*Retina)?/i);
  if (!res) return null;
  const pxW = Number(res[1]);
  const pxH = Number(res[2]);
  const retina = Boolean(res[3]) || /Retina/i.test(main);
  // Retina 的 Resolution 报的是物理像素，除以 2 才是逻辑分辨率
  const dpr = retina ? 2 : 1;
  return {
    width: Math.round(pxW / dpr),
    height: Math.round(pxH / dpr),
    dpr,
    source: 'system_profiler:Resolution',
  };
}

/**
 * 解析 `powershell -NoProfile -Command "[System.Windows.Forms.Screen]::PrimaryScreen.Bounds"`。
 *
 * 输出形如：
 *   Width Height X Y
 *   ----- ------ - -
 *    1920   1080 0 0
 * 或单行 `{X=0,Y=0,Width=1920,Height=1080}`。两种都收。
 *
 * dpr 固定 1：Windows 的缩放比例要走注册表 LogPixels 或 GetDpiForWindow，
 * 这里不猜。猜错会让 4K 屏用户的环境写成 2 倍逻辑尺寸。
 */
export function parseWindowsBounds(out: string): HostScreen | null {
  if (!out?.trim()) return null;
  const braces = out.match(/Width=(\d+)[,;]?\s*Height=(\d+)/i);
  if (braces) {
    return { width: Number(braces[1]), height: Number(braces[2]), dpr: 1, source: 'powershell:Screen.Bounds' };
  }
  // 表格形态：找到表头后取第一行数字
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const headerIndex = lines.findIndex((l) => /^Width\s+Height/i.test(l));
  const row = headerIndex >= 0 ? lines[headerIndex + 2] ?? '' : lines.find((l) => /^\d+\s+\d+/.test(l)) ?? '';
  const nums = row.match(/(\d+)\s+(\d+)/);
  if (!nums) return null;
  const width = Number(nums[1]);
  const height = Number(nums[2]);
  if (!width || !height) return null;
  return { width, height, dpr: 1, source: 'powershell:Screen.Bounds' };
}

function execPowerShell(): string {
  return execFrom(['powershell.exe', 'powershell', 'pwsh'], [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '[System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
  ]);
}

/** 解析 xrandr 输出里带 * 的那一行（当前模式） */
export function parseXrandr(out: string): HostScreen | null {
  if (!out?.trim()) return null;
  // xrandr 会列出所有模式，第一行带 * 的是当前
  const line = out.split('\n').find((l) => /\*/.test(l) && /\d+x\d+/.test(l));
  const dims = line?.match(/(\d+)x(\d+)/);
  if (!dims) return null;
  return { width: Number(dims[1]), height: Number(dims[2]), dpr: 1, source: 'xrandr' };
}

/**
 * 按候选路径依次尝试，第一个能跑通的就用；全失败时抛错，由上层转成 null。
 *
 * macOS 那条必须走绝对路径：桌面壳拉起的 node 用的是精简 PATH（/usr/bin:/bin），
 * 里面没有 /usr/sbin，靠 PATH 查会直接 ENOENT —— 然后静默退化成"探测不到"，
 * 表面看没问题，实际夹取逻辑整条不生效。
 */
function execFrom(candidates: string[], args: string[]): string {
  let lastError: unknown;
  for (const bin of candidates) {
    try {
      return execFileSync(bin, args, {
        encoding: 'utf8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('探测命令执行失败');
}

/**
 * 把预设屏幕夹到宿主装得下的尺寸。
 *
 * 只收缩不放大：宿主屏幕比预设大时保留预设的多样性（4K 屏用户当然可以有
 * 1920×1080 的窗口），宿主更小时按比例缩到边界内——这时所有环境都落在
 * 同一块屏幕上，尺寸一致本来就更真实。
 */
export function fitToHost(screen: { width: number; height: number; dpr: number; colorDepth: number }, host: HostScreen | null) {
  if (!host) return { screen, clipped: false };
  if (screen.width <= host.width && screen.height <= host.height) {
    return { screen, clipped: false };
  }
  const ratio = Math.min(host.width / screen.width, host.height / screen.height);
  const even = (n: number) => Math.max(2, Math.round((n * ratio) / 2) * 2);
  return {
    screen: { ...screen, width: even(screen.width), height: even(screen.height) },
    clipped: true,
  };
}
