import type { FingerprintPreset } from './preset.ts';

/**
 * 身份健康：启动后自检，把「预设说是什么」和「页面实际报什么」逐项摆出来。
 *
 * 为什么需要它：环境的身份在创建时就固化了，但宿主的屏幕、缩放、显卡会变。
 * 换过显示器之后，老环境会变成「screen 说 1920×1200，窗口只有 1280×800」——
 * 一条 `innerWidth < screen.width - 200` 就露馅。这类环境不会自己报错，
 * 只会莫名其妙被风控，所以必须让它**可见**。
 *
 * 只标记，不自动修：验证脚本已证明改 fingerprint.screen 会连带重抽
 * mediaDevices / locale 等字段（见 scripts/m9-probe-repair.ts），
 * 局部修复会让身份内部自相矛盾，比不修更糟。
 */

export interface HealthDiffItem {
  key: string;
  expected: unknown;
  actual: unknown;
}

export interface ProfileHealth {
  checkedAt: number;
  /** 空数组 = 一致。存空数组而不是 null，是为了区分「检查过且一致」与「没检查过」 */
  diff: HealthDiffItem[];
}

const PLATFORM: Record<FingerprintPreset['os'], string> = {
  windows: 'Win32',
  macos: 'MacIntel',
  linux: 'Linux x86_64',
};

const COMPARE_KEYS: Array<{ key: string; expected: (p: FingerprintPreset) => unknown }> = [
  { key: 'screen.width', expected: (p) => p.screen.width },
  { key: 'screen.height', expected: (p) => p.screen.height },
  { key: 'screen.colorDepth', expected: (p) => p.screen.colorDepth },
  { key: 'window.innerWidth', expected: (p) => p.window.innerWidth },
  { key: 'window.innerHeight', expected: (p) => p.window.innerHeight },
  // dpr 现在由 config 的 window.devicePixelRatio 接管（引擎会转成 layout.css.devPixelsPerPx），
  // 所以必须比对：改之前它由宿主决定，比对只会假报警；接管后不一致就是真漂移
  { key: 'window.devicePixelRatio', expected: (p) => p.screen.dpr },
  { key: 'userAgent', expected: (p) => p.ua },
  { key: 'platform', expected: (p) => PLATFORM[p.os] },
  { key: 'timezone', expected: (p) => p.timezone },
];

/**
 * @param observed 引擎自检采到的实际值（EngineAdapter.probe 的 observed）
 * @param preset   建环境时固化的预设
 *
 * devicePixelRatio 曾经不比对（引擎不接管，值由宿主决定）；现在 config 里显式写了
 * `window.devicePixelRatio`，引擎据此设置 layout.css.devPixelsPerPx，就变成可校验项了。
 */
export function diffHealth(observed: Record<string, unknown>, preset: FingerprintPreset): HealthDiffItem[] {
  const flat = flatten(observed);
  const out: HealthDiffItem[] = [];
  for (const { key, expected } of COMPARE_KEYS) {
    const want = expected(preset);
    const got = flat[key];
    if (got === undefined) continue;
    // 数值型按数值比，避免 1920 与 "1920" 被当成不一致
    if (typeof want === 'number' && typeof got === 'number') {
      if (Math.round(want) !== Math.round(got)) out.push({ key, expected: want, actual: got });
      continue;
    }
    if (String(want) !== String(got)) out.push({ key, expected: want, actual: got });
  }
  return out;
}

/** observed 是嵌套结构（screen.width / window.innerWidth），摊平成点号键便于逐项比对 */
function flatten(observed: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (prefix: string, value: unknown): void => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(prefix ? `${prefix}.${k}` : k, v);
      }
      return;
    }
    if (prefix) out[prefix] = value;
  };
  walk('', observed);
  // 自检返回的顶层标量（userAgent / platform / timezone）也要进摊平表
  for (const [k, v] of Object.entries(observed)) {
    if (typeof v !== 'object' && !(k in out)) out[k] = v;
  }
  return out;
}
