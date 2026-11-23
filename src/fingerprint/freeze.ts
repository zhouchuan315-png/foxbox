import { getRandomPreset, launchOptions } from 'camoufox';
import {
  generatePreset,
  COUNTRY_PROFILE,
  COUNTRY_GEO,
  PLAUSIBLE_DPR,
  WINDOW_MARGIN,
  type FingerprintPreset,
  type OsFamily,
} from './preset.ts';
import { fitToHost, hostScreen, type HostScreen } from './host-screen.ts';

/**
 * 指纹固化（Freeze）。
 *
 * M0 实测结论：`Camoufox({ preset })` 只对 NewContext 生效，持久化启动完全忽略；
 * 身份真正的载体是 launchOptions() 产出的 CAMOU_CONFIG_* 环境变量。
 * 所以固化 = 生成一次 config → 落库 → 每次启动原样传回。
 *
 * 另一条实测结论：当身份 OS 与宿主相同时，launcher 会真的拉一个 Firefox
 * 采样宿主渲染（GPU/canvas），在受限环境里必须关掉内容沙箱，否则挂死。
 * 这也是为什么 macos 身份的生成要 40 秒以上——不是 bug，是在探测真机。
 */
process.env.MOZ_DISABLE_CONTENT_SANDBOX ??= '1';

export interface FreezeInput {
  os: OsFamily;
  /** 目标国家（ISO-3166 alpha-2）。决定时区与语言，必须与代理出口一致。 */
  country: string;
  localeOverride?: string;
  /** 人类化输入节奏，属于行为特征，不影响身份字段 */
  humanize?: boolean;
  /** 实测出口坐标。有代理时应当传，没有才退回国家兜底坐标。 */
  geo?: { latitude: number; longitude: number } | null;
  /** 显式 dpr；默认取宿主实测值，保证渲染倍率和真机一致 */
  dpr?: number | null;
  /**
   * canvas 读数覆盖：
   * true 强制覆盖成占位随机值，false 强制不覆盖（会泄露宿主渲染，仅排障用），
   * null/undefined 交给引擎按「身份与宿主渲染是否矛盾」自动决定。
   */
  canvasNoise?: boolean | null;
}

export interface FrozenIdentity {
  /** 引擎配置（CAMOU_CONFIG 合并后的对象），落库为 config_json */
  config: Record<string, unknown>;
  /** 引擎原生 fingerprint（navigator/screen/webgl/speechVoices），启动时传它可跳过生成 */
  fingerprint: Record<string, unknown>;
  /** 可读身份描述，落库为 preset_json，用于校验与展示 */
  preset: FingerprintPreset;
  /** 配置被拆成几个 chunk（macOS 身份约 2 个，单条 32KB 上限） */
  chunks: number;
}

/** CAMOU_CONFIG_1..N 按序号拼回完整 JSON */
function reassembleConfig(env: Record<string, string>): Record<string, unknown> {
  const chunks = Object.keys(env)
    .filter((k) => /^CAMOU_CONFIG_\d+$/.test(k))
    .sort((a, b) => Number(a.split('_')[2]) - Number(b.split('_')[2]));
  if (chunks.length === 0) throw new Error('launchOptions 未生成 CAMOU_CONFIG');

  const raw = chunks.map((k) => env[k]!).join('');
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`CAMOU_CONFIG 拼接后不是合法 JSON（${raw.length} 字符），可能被截断`);
  }
}

/**
 * 从引擎产出的 config 反推可读 preset。
 *
 * 关键设计：preset 由引擎实际身份推导，而不是我们自己随机生成。
 * 这样"库里记的"和"浏览器跑的"永远一致，validator 校验的才是真东西。
 */
function presetFromConfig(
  config: Record<string, unknown>,
  fingerprint: Record<string, unknown>,
  seed: string,
  os: OsFamily,
  locale: string,
  timezone: string,
): FingerprintPreset {
  const s = (k: string): string => (typeof config[k] === 'string' ? (config[k] as string) : '');
  const n = (k: string, dflt: number): number => (typeof config[k] === 'number' ? (config[k] as number) : dflt);

  const width = n('screen.width', 1920);
  const height = n('screen.height', 1080);
  // 接管后 config 里一定有 window.devicePixelRatio；读不到才退回按宽度推断
  const fpScreen = (fingerprint.screen ?? {}) as Record<string, unknown>;
  const dpr =
    typeof config['window.devicePixelRatio'] === 'number'
      ? (config['window.devicePixelRatio'] as number)
      : typeof fpScreen.devicePixelRatio === 'number'
        ? fpScreen.devicePixelRatio
        : inferDpr(width);

  const lat = typeof config['geolocation:latitude'] === 'number' ? (config['geolocation:latitude'] as number) : 0;
  const lon = typeof config['geolocation:longitude'] === 'number' ? (config['geolocation:longitude'] as number) : 0;
  const accuracy = typeof config['geolocation:accuracy'] === 'number' ? (config['geolocation:accuracy'] as number) : undefined;

  return {
    seed,
    os,
    ua: s('navigator.userAgent'),
    browserVersion: extractVersion(s('navigator.userAgent')),
    screen: { width, height, colorDepth: n('screen.colorDepth', 24), dpr },
    // 窗口尺寸要和 screen 同源：读不到 config 里的窗口值时按屏幕减边框推算，
    // 而不是直接等于屏幕（那等于宣称窗口占满整块屏，连菜单栏都没有）
    window: {
      innerWidth: n('window.innerWidth', width - WINDOW_MARGIN.width),
      innerHeight: n('window.innerHeight', height - WINDOW_MARGIN.height),
    },
    locale,
    languages: [locale, locale.split('-')[0]!],
    timezone,
    geolocation: { latitude: lat, longitude: lon, ...(accuracy ? { accuracy } : {}) },
    hardwareConcurrency: n('navigator.hardwareConcurrency', 8),
    deviceMemory: 8,
    webgl: { vendor: s('webGl:vendor'), renderer: s('webGl:renderer') },
    fonts: Array.isArray(config.fonts) ? (config.fonts as string[]).slice(0, 20) : [],
    canvasNoise: config.canvasNoise === true,
    audioNoise: false,
  };
}

/**
 * dpr 取宿主的实测值。
 *
 * 不接管的后果很具体：库里记 macOS@2x，浏览器却报 devicePixelRatio=1，
 * 一条 readback 就能看出「声称 Retina 的机器在按 1x 渲染」。
 * 引擎支持 `window.devicePixelRatio`（会转成 layout.css.devPixelsPerPx 真的按该倍率渲染），
 * 所以这里只需要把值定下来并写进 config。
 */
export function chooseDpr(os: OsFamily, candidate: number | null | undefined): number {
  const allowed = PLAUSIBLE_DPR[os];
  if (candidate && allowed.includes(candidate)) return candidate;
  return allowed[0]!;
}

function inferDpr(width: number): number {
  // 引擎不接管 dpr，这里只在拿不到 fingerprint 时给一个与屏幕宽度自洽的兜底值
  if (width >= 2560) return 2;
  if (width >= 1728) return 2;
  if (width >= 1512) return 2;
  return 1;
}

function extractVersion(ua: string): string {
  const m = /Firefox\/(\d+\.\d+)/.exec(ua);
  return m?.[1] ?? 'unknown';
}

/**
 * 把引擎抽到的屏幕缩到宿主装得下的尺寸。
 *
 * 引擎只按 OS 抽一个"常见分辨率"，不看这台机器有多大：在 1280×800 的屏幕上抽到
 * 1920×1200，浏览器根本开不出这么大的窗口，视口会被压到 1280×720，
 * 而 screen.width 仍报 1920 —— 一条 `innerWidth < screen.width - 200` 就露馅。
 *
 * 直接改 fingerprint 而不是改 config：config 是由 fingerprint 派生的，
 * 改源头两边才一致。
 *
 * @returns 是否发生了收缩（调用方一般不需要，排障时有用）
 */
export function shrinkScreenToHost(fingerprint: Record<string, unknown>, host: HostScreen | null): boolean {
  const screen = fingerprint.screen as Record<string, number> | undefined;
  if (!host || !screen) return false;
  const width = Number(screen.width);
  const height = Number(screen.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;

  const { screen: fitted, clipped } = fitToHost(
    { width, height, dpr: Number(screen.devicePixelRatio) || 1, colorDepth: Number(screen.colorDepth) || 24 },
    host,
  );
  if (!clipped) return false;

  screen.width = fitted.width;
  screen.height = fitted.height;
  // availHeight 要扣掉菜单栏，否则 availHeight === height 本身就是破绽。
  // 25 是逻辑像素（Retina 上就是 25pt），与 dpr 无关。
  screen.availWidth = fitted.width;
  screen.availHeight = Math.max(fitted.height - 25, 1);
  return true;
}

/**
 * 收缩后仍要像真机。
 *
 * 引擎会抽到 3440×1440（21:9）这类面板，夹到 1280 宽就变成 1280×536 —— 现实中
 * 没有这种屏幕，R4 会告警，站点也能一眼看出是伪造。这种情况没法靠等比缩放救，
 * 直接退回宿主本身的尺寸（同一台机器上最合理的选择）。
 */
export function ensurePlausibleScreen(
  fingerprint: Record<string, unknown>,
  host: HostScreen | null,
  os: OsFamily,
): boolean {
  const screen = fingerprint.screen as Record<string, number> | undefined;
  if (!host || !screen) return false;
  const width = Number(screen.width);
  const height = Number(screen.height);
  if (Number.isFinite(width) && Number.isFinite(height) && width >= 1024 && height >= 600) return false;

  screen.width = host.width;
  screen.height = host.height;
  screen.availWidth = host.width;
  screen.availHeight = Math.max(host.height - 25, 1);
  screen.colorDepth = os === 'macos' || os === 'windows' ? 30 : 24;
  return true;
}

/**
 * 显式声明屏幕与窗口尺寸。
 *
 * 只要 config 里出现 screen.* / window.* 键，引擎的 `userSetScreenWindow` 就为真，
 * 会跳过它自己那段"一致性修正"——那段修正把宽度低于 1366 的屏幕抬到 1366
 * （现代设备下限），在 1280 宽的机器上直接被抬出屏幕范围，于是又回到
 * screen 报 1366、窗口只有 1280 的矛盾。
 */
function screenWindowConfig(fingerprint: Record<string, unknown>): Record<string, unknown> {
  const s = fingerprint.screen as Record<string, number>;
  const innerWidth = Math.max(640, Number(s.width) - WINDOW_MARGIN.width);
  const innerHeight = Math.max(480, Number(s.height) - WINDOW_MARGIN.height);
  return {
    'screen.width': s.width,
    'screen.height': s.height,
    'screen.availWidth': s.availWidth ?? s.width,
    // availHeight 缺省时也要比 height 小：相等本身就是「没有菜单栏」的破绽
    'screen.availHeight': s.availHeight ?? Math.max(Number(s.height) - 25, 1),
    'screen.colorDepth': s.colorDepth ?? 24,
    'window.innerWidth': innerWidth,
    'window.innerHeight': innerHeight,
    'window.outerWidth': innerWidth,
    // outerHeight 必须比 innerHeight 高出一个真实窗口的 chrome，
    // 否则引擎的 checkWindowChrome 会报"视口底部 85px 收不到输入"
    'window.outerHeight': innerHeight + 85,
    'window.screenX': 0,
    'window.screenY': 25,
    'window.devicePixelRatio': s.devicePixelRatio ?? 1,
  };
}

/**
 * 生成一份可持久化的身份。
 * 同参数下结果随机（引擎侧随机），所以必须只调用一次并落库。
 */
export async function freezeIdentity(input: FreezeInput): Promise<FrozenIdentity> {
  const profile = COUNTRY_PROFILE[input.country.toUpperCase()];
  if (!profile) throw new Error(`未收录的国家代码: ${input.country}`);

  const locale = input.localeOverride ?? profile.locales[0]!;
  // 时区取该国第一个时区：宁可固定，也不要每次随机（geoip 每次挑不同的，M0 已证实）
  const timezone = profile.timezones[0]!;
  const country = input.country.toUpperCase();
  // 坐标优先级：代理实测 > 国家兜底。(0,0) 是几内亚湾，落在那儿比没有更可疑
  const geo = input.geo ?? COUNTRY_GEO[country] ?? null;
  const dpr = chooseDpr(input.os, input.dpr ?? hostScreen()?.dpr);

  // 先取一份引擎原生 fingerprint，再让 config 由它推导。
  // 这样"存下来的 fingerprint"和"存下来的 config"描述的是同一个身份，
  // 启动时两条路径结果一致。
  const fingerprint = getRandomPreset(input.os) as Record<string, unknown>;
  if (!fingerprint) throw new Error(`引擎未内置 ${input.os} 的指纹包`);

  // 宿主屏幕装不下的身份等于自相矛盾，落库前先收敛到本机尺寸
  const host = hostScreen();
  shrinkScreenToHost(fingerprint, host);
  // 等比缩完之后再看一眼是否还像真机（超宽屏夹完会变成 1280×536）
  ensurePlausibleScreen(fingerprint, host, input.os);

  // 屏幕/窗口/dpr 一律显式写死：只要 config 里出现这些键，引擎就跳过它自己
  // 那段「把窄屏抬到 1366」的修正；dpr 也才会真的落成 layout.css.devPixelsPerPx。
  const fixed = { ...screenWindowConfig(fingerprint), 'window.devicePixelRatio': dpr };
  const accuracy = 20 + Math.floor(Math.random() * 60);
  const geoConfig = geo
    ? {
        'geolocation:latitude': geo.latitude,
        'geolocation:longitude': geo.longitude,
        'geolocation:accuracy': accuracy,
      }
    : {};

  const opts = await launchOptions({
    headless: true,
    os: input.os,
    fingerprint,
    locale,
    humanize: input.humanize ?? true,
    config: { ...fixed, ...geoConfig },
    // true 强制覆盖 canvas 读数为占位随机值；false 强制不覆盖；null 交给引擎判断
    ...(input.canvasNoise === null || input.canvasNoise === undefined
      ? {}
      : { canvas_noise: input.canvasNoise }),
    // 身份是我们自己固化的，覆盖 launcher 的自动生成属于预期行为
    i_know_what_im_doing: true,
  });

  const env = (opts.env ?? {}) as Record<string, string>;
  const config = reassembleConfig(env);

  // 时区必须写进 config：否则浏览器会用宿主时区，与代理出口打架
  config.timezone = timezone;
  // 引擎可能把 dpr 规整到最近的合法档位；以最终值为准，别让库里和实际不一致
  if (typeof config['window.devicePixelRatio'] !== 'number') {
    config['window.devicePixelRatio'] = dpr;
  }
  // 屏幕/窗口/坐标是「我们声明、引擎照做」的键；万一被 launcher 丢掉，按声明值补回，
  // 保证库里那份与真正传给浏览器的配置一致
  if (geo) {
    config['geolocation:latitude'] = geo.latitude;
    config['geolocation:longitude'] = geo.longitude;
    config['geolocation:accuracy'] = accuracy;
  }

  const seed = `${input.os}:${country}:${locale}:${Date.now().toString(36)}`;
  const preset = presetFromConfig(config, fingerprint, seed, input.os, locale, timezone);
  if (input.canvasNoise != null) preset.canvasNoise = input.canvasNoise;

  return {
    config,
    fingerprint,
    preset,
    chunks: Object.keys(env).filter((k) => /^CAMOU_CONFIG_\d+$/.test(k)).length,
  };
}

/**
 * 兜底路径：引擎生成失败时（例如宿主采样超时），用本地确定性生成器造一份。
 * 明确标记 degraded，让 UI 有据可查——不要静默降级。
 */
export function freezeFallback(input: FreezeInput & { seed: string }): FrozenIdentity {
  const preset = generatePreset({
    seed: input.seed,
    os: input.os,
    country: input.country.toUpperCase(),
    localeOverride: input.localeOverride,
    ...(input.geo ? { geo: input.geo } : {}),
    ...(input.dpr ? { dpr: input.dpr } : {}),
  });
  if (input.canvasNoise != null) preset.canvasNoise = input.canvasNoise;
  const config: Record<string, unknown> = {
    'navigator.userAgent': preset.ua,
    'navigator.platform': preset.os === 'windows' ? 'Win32' : preset.os === 'macos' ? 'MacIntel' : 'Linux x86_64',
    'navigator.hardwareConcurrency': preset.hardwareConcurrency,
    'screen.width': preset.screen.width,
    'screen.height': preset.screen.height,
    'screen.colorDepth': preset.screen.colorDepth,
    'webGl:vendor': preset.webgl.vendor,
    'webGl:renderer': preset.webgl.renderer,
    fonts: preset.fonts,
    timezone: preset.timezone,
    'locale:language': preset.locale.split('-')[0],
    'navigator.language': preset.locale,
    'window.devicePixelRatio': preset.screen.dpr,
    'geolocation:latitude': preset.geolocation.latitude,
    'geolocation:longitude': preset.geolocation.longitude,
    'geolocation:accuracy': preset.geolocation.accuracy ?? 50,
    canvasNoise: preset.canvasNoise,
  };
  return {
    config,
    fingerprint: {
      navigator: {
        userAgent: preset.ua,
        platform: config['navigator.platform'],
        hardwareConcurrency: preset.hardwareConcurrency,
        maxTouchPoints: 0,
      },
      screen: { ...preset.screen, availWidth: preset.screen.width, availHeight: preset.screen.height, devicePixelRatio: preset.screen.dpr },
      webgl: { unmaskedVendor: preset.webgl.vendor, unmaskedRenderer: preset.webgl.renderer },
      speechVoices: [],
    },
    preset,
    chunks: 1,
  };
}
