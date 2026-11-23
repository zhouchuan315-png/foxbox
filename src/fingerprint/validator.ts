import type { FingerprintPreset, OsFamily } from './preset.ts';
import { COUNTRY_GEO, COUNTRY_PROFILE, PLAUSIBLE_DPR } from './preset.ts';

/** 两点间大圆距离（km）。只用来判断「坐标和代理国家是否离谱」，不需要高精度 */
function distanceKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type Severity = 'error' | 'warn';

export interface Issue {
  rule: string;
  severity: Severity;
  message: string;
}

export interface ValidationContext {
  /** 代理出口国家（ISO-3166 alpha-2），未配置代理时为 undefined */
  proxyCountry?: string;
  /** 宿主机 OS，用于提示 Canvas 副作用 */
  hostOs?: OsFamily;
}

/**
 * UA 里的系统标记。
 *
 * 这里只能给"足够宽的锚点"，不能写死某一发行版：
 * 引擎在 Linux 上会同时产出 `X11; Linux x86_64` 和 `X11; Ubuntu; Linux x86_64` 两种，
 * 早先按 `X11; Linux` 精确匹配，把合法的 Ubuntu UA 全判成了错误。
 */
const UA_OS_PATTERN: Record<OsFamily, RegExp> = {
  windows: /Windows NT \d+\.\d+/,
  macos: /Macintosh/,
  linux: /Linux/,
};

const UA_OS_FORBIDDEN: Record<OsFamily, RegExp> = {
  windows: /Macintosh|X11|Linux|CrOS/,
  macos: /Windows NT|X11|Linux|CrOS/,
  linux: /Windows NT|Macintosh|CrOS/,
};

const GPU_OS_HINT: Record<OsFamily, RegExp> = {
  windows: /ANGLE|D3D11|Direct3D|NVIDIA|AMD|Intel/i,
  macos: /Apple|Intel|AMD|Radeon/i,
  // Linux 上独显同样存在，只列 Mesa 会把真实的 NVIDIA/AMD 机器误判成可疑
  linux: /Mesa|llvmpipe|X\.Org|NVIDIA|AMD|Intel|Radeon/i,
};

/**
 * 反向规则比正向枚举更可靠。
 *
 * 正向枚举会误杀真实存在的组合——实测宿主机是 Intel 核显时，
 * macOS 身份被引擎对齐成 "Intel(R) HD Graphics 400, or similar"，
 * 这是真 Mac 会报的字符串，但不在"Apple M 系列"白名单里。
 * 所以只拦"绝不可能共存"的标记：macOS 上不会出现 ANGLE/D3D11，Windows 上不会出现 Apple GPU。
 */
const GPU_FORBIDDEN: Record<OsFamily, RegExp> = {
  windows: /Apple|Mesa|llvmpipe|X\.Org/i,
  macos: /ANGLE|D3D11|Direct3D|Mesa|llvmpipe|X\.Org/i,
  linux: /ANGLE|D3D11|Direct3D|Apple/i,
};

/**
 * 一致性校验。任一条 error 都必须阻断保存/启动。
 * 设计原则：宁可拒绝启动，也不要带着矛盾的指纹去污染账号。
 */
export function validatePreset(
  preset: FingerprintPreset,
  ctx: ValidationContext = {},
): Issue[] {
  const issues: Issue[] = [];
  const country = ctx.proxyCountry?.toUpperCase();
  const countryProfile = country ? COUNTRY_PROFILE[country] : undefined;

  // R1 时区必须落在代理国家
  if (country) {
    if (!countryProfile) {
      issues.push({
        rule: 'R1',
        severity: 'warn',
        message: `国家 ${country} 未收录时区表，跳过时区校验`,
      });
    } else if (!countryProfile.timezones.includes(preset.timezone)) {
      issues.push({
        rule: 'R1',
        severity: 'error',
        message: `时区 ${preset.timezone} 不属于代理国家 ${country}（应为 ${countryProfile.timezones.join(' / ')}）`,
      });
    }
  }

  // R2 语言首项的地区应与代理国家一致
  if (country && countryProfile) {
    const region = preset.locale.split('-')[1]?.toUpperCase();
    if (!region) {
      issues.push({ rule: 'R2', severity: 'warn', message: `locale ${preset.locale} 缺少地区标识` });
    } else if (!countryProfile.locales.some((l) => l.split('-')[1] === region)) {
      issues.push({
        rule: 'R2',
        severity: 'error',
        message: `语言 ${preset.locale} 与代理国家 ${country} 不匹配`,
      });
    }
  }

  // R2b languages 首项必须是 locale，且整体降序合理
  if (preset.languages[0] !== preset.locale) {
    issues.push({
      rule: 'R2',
      severity: 'error',
      message: `languages 首项 ${preset.languages[0]} 与 locale ${preset.locale} 不一致`,
    });
  }

  // R3 UA 里的系统标记必须与 os 字段一致，且不能残留别家系统的标记
  if (!UA_OS_PATTERN[preset.os].test(preset.ua) || UA_OS_FORBIDDEN[preset.os].test(preset.ua)) {
    issues.push({
      rule: 'R3',
      severity: 'error',
      message: `UA 与 os=${preset.os} 不匹配：${preset.ua}`,
    });
  }

  // R4 屏幕需落在现实区间。
  // 这里不比对 SCREEN_POOL：那份池子只是降级时的候选，引擎自己会产出更多
  // 真实存在的分辨率（1366x800@1.5、3440x1440@2 等），按池子比对等于天天误报。
  const { width, height, dpr, colorDepth } = preset.screen;
  const screenPlausible =
    width >= 1024 &&
    width <= 5120 &&
    height >= 600 &&
    height <= 3200 &&
    PLAUSIBLE_DPR[preset.os].includes(dpr) &&
    colorDepth >= 24;
  if (!screenPlausible) {
    issues.push({
      rule: 'R4',
      severity: 'warn',
      message: `屏幕 ${width}x${height}@${dpr}x（${colorDepth}bit）不像真实设备`,
    });
  }

  // R5 硬件参数需落在合理区间
  if (preset.hardwareConcurrency < 2 || preset.hardwareConcurrency > 32) {
    issues.push({
      rule: 'R5',
      severity: 'error',
      message: `hardwareConcurrency=${preset.hardwareConcurrency} 超出合理范围 2–32`,
    });
  }
  if (preset.deviceMemory < 4 || preset.deviceMemory > 64) {
    issues.push({
      rule: 'R5',
      severity: 'error',
      message: `deviceMemory=${preset.deviceMemory} 超出合理范围 4–64`,
    });
  }
  if (preset.deviceMemory < preset.hardwareConcurrency) {
    issues.push({
      rule: 'R5',
      severity: 'warn',
      message: `内存 ${preset.deviceMemory}GB 配 ${preset.hardwareConcurrency} 核略显失衡`,
    });
  }

  // R6 WebGL 渲染器需与 OS 自洽：先拦硬矛盾，再提示可疑但可能的组合
  const renderer = preset.webgl.renderer;
  if (GPU_FORBIDDEN[preset.os].test(renderer)) {
    issues.push({
      rule: 'R6',
      severity: 'error',
      message: `WebGL 渲染器 "${renderer}" 不可能出现在 os=${preset.os} 上`,
    });
  } else if (!GPU_OS_HINT[preset.os].test(renderer)) {
    issues.push({
      rule: 'R6',
      severity: 'warn',
      message: `WebGL 渲染器 "${renderer}" 不是 ${preset.os} 的典型值，建议核对`,
    });
  }

  // R7 窗口尺寸不得大于屏幕
  if (
    preset.window.innerWidth > preset.screen.width ||
    preset.window.innerHeight > preset.screen.height
  ) {
    issues.push({
      rule: 'R7',
      severity: 'error',
      message: `窗口 ${preset.window.innerWidth}x${preset.window.innerHeight} 超出屏幕尺寸`,
    });
  }

  // R9 地理坐标必须可用且与代理国家不矛盾。
  // (0,0) 是几内亚湾——历史上「没填」的默认值，比空着更可疑。
  const { latitude, longitude } = preset.geolocation;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    issues.push({ rule: 'R9', severity: 'error', message: 'geolocation 坐标不是有效数字' });
  } else if (Math.abs(latitude) < 0.01 && Math.abs(longitude) < 0.01) {
    issues.push({ rule: 'R9', severity: 'warn', message: 'geolocation 仍是 (0,0)，说明没有回填出口坐标' });
  } else {
    const anchor = country ? COUNTRY_GEO[country] : undefined;
    if (anchor) {
      const away = Math.round(distanceKm({ latitude, longitude }, anchor));
      if (away > 6000) {
        issues.push({
          rule: 'R9',
          severity: 'warn',
          message: `坐标与 ${country} 相距约 ${away}km，确认代理是否走的是该国出口`,
        });
      }
    }
  }

  // R8 宿主 OS 副作用提示（不属于指纹自洽性，单独编号，避免和屏幕规则混在一起）
  if (ctx.hostOs && ctx.hostOs !== preset.os) {
    issues.push({
      rule: 'R8',
      severity: 'warn',
      message: `身份 OS(${preset.os}) 与宿主(${ctx.hostOs}) 不同，Canvas 读数可能被随机化，呈现隐私强化特征`,
    });
  }

  return issues;
}

export function hasBlockingIssue(issues: Issue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}
