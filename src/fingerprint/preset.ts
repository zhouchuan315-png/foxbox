/**
 * 指纹 preset：环境创建时生成一次，之后永久复用。
 * 任何"每次启动重新随机"的实现都会让平台看到设备在变化，属于设计错误。
 */
import { fitToHost, hostScreen } from './host-screen.ts';

export type OsFamily = 'windows' | 'macos' | 'linux';

export interface ScreenSpec {
  width: number;
  height: number;
  colorDepth: number;
  dpr: number;
}

export interface WebglSpec {
  vendor: string;
  renderer: string;
}

export interface FingerprintPreset {
  seed: string;
  os: OsFamily;
  ua: string;
  browserVersion: string;
  screen: ScreenSpec;
  window: { innerWidth: number; innerHeight: number };
  locale: string;
  languages: string[];
  timezone: string;
  /** accuracy 单位米；引擎会写进 geolocation:accuracy */
  geolocation: { latitude: number; longitude: number; accuracy?: number };
  hardwareConcurrency: number;
  deviceMemory: number;
  webgl: WebglSpec;
  fonts: string[];
  webrtcIp?: string;
  canvasNoise: boolean;
  audioNoise: boolean;
}

/**
 * 各 OS 真实存在的缩放档位。
 *
 * 与 Camoufox 的 PLAUSIBLE_DPR 一致（mac 只有 1/2，Windows 有 1.75/2.5）。
 * 声明 1.1 这种档位等于自报伪造，校验和引擎都会拦。
 */
export const PLAUSIBLE_DPR: Record<OsFamily, number[]> = {
  windows: [1, 1.25, 1.5, 1.75, 2, 2.5, 3],
  macos: [1, 2],
  linux: [1, 1.25, 1.5, 1.75, 2],
};

/**
 * 国家 → 兜底坐标（首都/代表城市）。
 *
 * 仅在「没有代理、或代理还没测出坐标」时使用；有实测出口坐标时必须用实测值。
 * 坐标与 COUNTRY_PROFILE 的时区首项对齐（US → America/New_York → 纽约），
 * 否则会出现「时区在纽约、坐标在北京」这种一眼假的组合。
 */
export const COUNTRY_GEO: Record<string, { latitude: number; longitude: number }> = {
  US: { latitude: 40.7128, longitude: -74.006 },
  GB: { latitude: 51.5074, longitude: -0.1278 },
  DE: { latitude: 52.52, longitude: 13.405 },
  FR: { latitude: 48.8566, longitude: 2.3522 },
  JP: { latitude: 35.6762, longitude: 139.6503 },
  SG: { latitude: 1.3521, longitude: 103.8198 },
  HK: { latitude: 22.3193, longitude: 114.1694 },
  TW: { latitude: 25.033, longitude: 121.5654 },
  CN: { latitude: 39.9042, longitude: 116.4074 },
  AU: { latitude: -33.8688, longitude: 151.2093 },
  CA: { latitude: 43.6532, longitude: -79.3832 },
};

/** 各系统的常见桌面分辨率，避免出现"4K 屏配移动 UA"这类矛盾 */
export const SCREEN_POOL: Record<OsFamily, ScreenSpec[]> = {
  windows: [
    { width: 1920, height: 1080, colorDepth: 24, dpr: 1 },
    { width: 2560, height: 1440, colorDepth: 24, dpr: 1 },
    { width: 1536, height: 864, colorDepth: 24, dpr: 1.25 },
    { width: 1366, height: 768, colorDepth: 24, dpr: 1 },
  ],
  macos: [
    { width: 1512, height: 982, colorDepth: 30, dpr: 2 },
    { width: 1728, height: 1117, colorDepth: 30, dpr: 2 },
    { width: 1440, height: 900, colorDepth: 30, dpr: 2 },
    { width: 2560, height: 1440, colorDepth: 30, dpr: 2 },
  ],
  linux: [
    { width: 1920, height: 1080, colorDepth: 24, dpr: 1 },
    { width: 1600, height: 900, colorDepth: 24, dpr: 1 },
    { width: 1366, height: 768, colorDepth: 24, dpr: 1 },
  ],
};

/** GPU 必须与 OS 自洽：Windows 上不该出现 Apple GPU */
export const GPU_POOL: Record<OsFamily, WebglSpec[]> = {
  windows: [
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  ],
  macos: [
    { vendor: 'Apple Inc.', renderer: 'Apple M2' },
    { vendor: 'Apple Inc.', renderer: 'Apple M3 Pro' },
    { vendor: 'Intel Inc.', renderer: 'Intel Iris Plus Graphics' },
  ],
  linux: [
    { vendor: 'Mesa', renderer: 'Mesa Intel(R) UHD Graphics 620 (KBL GT2)' },
    { vendor: 'Mesa', renderer: 'llvmpipe (LLVM 15.0.7, 256 bits)' },
  ],
};

export const FONT_POOL: Record<OsFamily, string[]> = {
  windows: ['Arial', 'Calibri', 'Cambria', 'Consolas', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Verdana'],
  macos: ['Helvetica', 'Helvetica Neue', 'San Francisco', 'Menlo', 'Monaco', 'Avenir', 'PingFang SC'],
  linux: ['DejaVu Sans', 'Liberation Sans', 'Noto Sans', 'Ubuntu', 'Cantarell'],
};

const UA_TEMPLATE: Record<OsFamily, (v: string) => string> = {
  windows: (v) =>
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`,
  macos: (v) =>
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`,
  linux: (v) => `Mozilla/5.0 (X11; Linux x86_64; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`,
};

/** 国家 → 时区与语言。子集实现，按需扩充。 */
export const COUNTRY_PROFILE: Record<string, { timezones: string[]; locales: string[] }> = {
  US: { timezones: ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'], locales: ['en-US'] },
  GB: { timezones: ['Europe/London'], locales: ['en-GB'] },
  DE: { timezones: ['Europe/Berlin'], locales: ['de-DE'] },
  FR: { timezones: ['Europe/Paris'], locales: ['fr-FR'] },
  JP: { timezones: ['Asia/Tokyo'], locales: ['ja-JP'] },
  SG: { timezones: ['Asia/Singapore'], locales: ['en-SG'] },
  HK: { timezones: ['Asia/Hong_Kong'], locales: ['zh-HK'] },
  TW: { timezones: ['Asia/Taipei'], locales: ['zh-TW'] },
  CN: { timezones: ['Asia/Shanghai'], locales: ['zh-CN'] },
  AU: { timezones: ['Australia/Sydney'], locales: ['en-AU'] },
  CA: { timezones: ['America/Toronto'], locales: ['en-CA'] },
};

export interface GenerateInput {
  seed: string;
  os: OsFamily;
  country: string;
  browserVersion?: string;
  localeOverride?: string;
  /** 有实测出口坐标时传进来，覆盖国家兜底值 */
  geo?: { latitude: number; longitude: number };
  /** 显式指定 dpr（通常是宿主实测值）；不传就按屏幕池里的值 */
  dpr?: number;
}

/** 确定性伪随机：同 seed 必然产出同一套指纹 */
function mulberry32(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 窗口相对屏幕留出的边框：宽度 16（左右边框+滚动条），高度 110（菜单栏 25 + 标题栏与工具栏 85） */
export const WINDOW_MARGIN = { width: 16, height: 110 };

export function generatePreset(input: GenerateInput): FingerprintPreset {
  const rand = mulberry32(input.seed);
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
  const profile = COUNTRY_PROFILE[input.country];
  if (!profile) {
    throw new Error(`未收录的国家代码: ${input.country}，请先补充 COUNTRY_PROFILE`);
  }

  const version = input.browserVersion ?? '152.0';
  const locale = input.localeOverride ?? profile.locales[0]!;
  // 屏幕不能大于宿主：否则浏览器开不出这么大的窗口，视口会被压小，
  // 而 screen.* 仍报原值，一条 innerWidth < screen.width 的检测就露了
  const { screen } = fitToHost(pick(SCREEN_POOL[input.os]), hostScreen());
  // dpr 由调用方（宿主实测）决定；没给就沿用池子里的值，但必须落在该 OS 的真实档位上
  if (input.dpr && PLAUSIBLE_DPR[input.os].includes(input.dpr)) screen.dpr = input.dpr;
  const geo = input.geo ?? COUNTRY_GEO[input.country.toUpperCase()] ?? { latitude: 0, longitude: 0 };
  const accuracy = 20 + Math.floor(rand() * 60);
  // 这两个边距是逻辑像素，与 dpr 无关——乘 dpr 会让 Retina 上的窗口矮掉一大截
  const innerWidth = screen.width - WINDOW_MARGIN.width;
  const innerHeight = screen.height - WINDOW_MARGIN.height;

  return {
    seed: input.seed,
    os: input.os,
    ua: UA_TEMPLATE[input.os](version),
    browserVersion: version,
    screen,
    window: { innerWidth, innerHeight },
    locale,
    languages: [locale, locale.split('-')[0]!],
    timezone: pick(profile.timezones),
    geolocation: { latitude: geo.latitude, longitude: geo.longitude, accuracy },
    hardwareConcurrency: pick([4, 8, 8, 12, 16]),
    deviceMemory: pick([8, 8, 16, 16, 32]),
    webgl: pick(GPU_POOL[input.os]),
    fonts: FONT_POOL[input.os],
    canvasNoise: false,
    audioNoise: false,
  };
}
