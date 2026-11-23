/**
 * 最小可用的 cron 解析。
 *
 * 不引 node-cron 之类的依赖：它们大多还带着 setTimeout 自循环、时区库和
 * "任务注册表"这一层，而这里只需要两件事——算下一次触发时刻、把表达式说成人话。
 * 依赖越薄，行为越可预测；凌晨三点出问题时也不用去读别人的调度器源码。
 *
 * 支持标准 5 段（分 时 日 月 周）、通配符与区间、步长（形如 5 分钟一次）、
 * 逗号列表、月与星期的英文缩写，以及 @hourly 这类别名。秒级与年字段不支持——
 * 一个本地工作台没有这种精度需求，多支持一段反而让表达式更难读。
 */

export interface CronSpec {
  /** 归一化后的表达式（别名会被展开） */
  expr: string;
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  /** 日字段是否被显式限定（决定「日与周」是 OR 还是 AND） */
  domRestricted: boolean;
  dowRestricted: boolean;
}

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

/** 扫描上界：5 年。`0 0 29 2 *` 这种会在 1–8 年内命中，留足余量又不至于空转 */
const SCAN_YEARS = 5;

interface FieldOptions {
  min: number;
  max: number;
  /** 英文缩写 → 数值，例如 JAN → 1 */
  names?: string[];
  label: string;
}

function parseValue(token: string, opts: FieldOptions): number {
  const upper = token.toUpperCase();
  const named = opts.names ? opts.names.indexOf(upper) : -1;
  if (named >= 0) return named + opts.min;

  if (!/^\d+$/.test(token)) throw new Error(`${opts.label}字段无法识别: "${token}"`);
  const value = Number(token);
  if (!Number.isInteger(value) || value < opts.min || value > opts.max) {
    throw new Error(`${opts.label}超出范围（${opts.min}-${opts.max}）: ${token}`);
  }
  return value;
}

function parseField(token: string, opts: FieldOptions): { values: number[]; wildcard: boolean } {
  const out = new Set<number>();
  let wildcard = false;

  for (const part of token.split(',')) {
    if (!part) throw new Error(`${opts.label}字段有空项: "${token}"`);

    const [rangePart, stepPart, extra] = part.split('/');
    if (extra !== undefined) throw new Error(`${opts.label}字段步长写法错误: "${part}"`);

    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) <= 0) {
        throw new Error(`${opts.label}字段步长必须是正整数: "${part}"`);
      }
      step = Number(stepPart);
    }

    let lo: number;
    let hi: number;

    if (rangePart === '*') {
      lo = opts.min;
      hi = opts.max;
      // 只有裸 `*` 才算"不限定"；`*/5` 是明确的子集，仍视为限定
      if (stepPart === undefined) wildcard = true;
    } else if (rangePart!.includes('-')) {
      const [from, to] = rangePart!.split('-');
      if (!from || !to) throw new Error(`${opts.label}字段区间写法错误: "${part}"`);
      lo = parseValue(from, opts);
      hi = parseValue(to, opts);
      if (lo > hi) throw new Error(`${opts.label}字段区间起点大于终点: "${part}"`);
    } else {
      lo = parseValue(rangePart!, opts);
      // `a/n` 视作 a-max/n，与多数 cron 实现保持一致
      hi = stepPart === undefined ? lo : opts.max;
    }

    for (let value = lo; value <= hi; value += step) out.add(value);
  }

  return { values: [...out].sort((a, b) => a - b), wildcard };
}

export function parseCron(raw: string): CronSpec {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('cron 表达式不能为空');

  const expr = ALIASES[text.toLowerCase()] ?? text;
  const parts = expr.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron 需要 5 段（分 时 日 月 周），当前 ${parts.length} 段`);
  }

  const minutes = parseField(parts[0]!, { min: 0, max: 59, label: '分钟' });
  const hours = parseField(parts[1]!, { min: 0, max: 23, label: '小时' });
  const dom = parseField(parts[2]!, { min: 1, max: 31, label: '日' });
  const months = parseField(parts[3]!, { min: 1, max: 12, names: MONTH_NAMES, label: '月' });
  // 星期允许 0-7，7 与 0 都表示周日
  const dow = parseField(parts[4]!, { min: 0, max: 7, names: DAY_NAMES, label: '星期' });
  const daysOfWeek = [...new Set(dow.values.map((v) => (v === 7 ? 0 : v)))].sort((a, b) => a - b);

  return {
    expr: parts.join(' '),
    minutes: minutes.values,
    hours: hours.values,
    daysOfMonth: dom.values,
    months: months.values,
    daysOfWeek,
    domRestricted: !dom.wildcard,
    dowRestricted: !dow.wildcard,
  };
}

/**
 * 日与周的联合语义沿用 Vixie cron：
 * 两个字段都被限定时取并集（"每月 1 号 **或** 每周一"），
 * 只有一个被限定时取那一个，都不限定就是每天。
 * 这个语义反直觉但已是事实标准，改成交集会让从别处抄来的表达式静默变味。
 */
function dayMatches(spec: CronSpec, date: Date): boolean {
  const domHit = spec.daysOfMonth.includes(date.getDate());
  const dowHit = spec.daysOfWeek.includes(date.getDay());
  if (spec.domRestricted && spec.dowRestricted) return domHit || dowHit;
  if (spec.domRestricted) return domHit;
  if (spec.dowRestricted) return dowHit;
  return true;
}

/**
 * 从 `from` 之后（不含当前这一分钟）找下一个触发时刻。
 *
 * 逐字段跳：月不匹配就跳到下月 1 号、日不匹配就跳到明天零点……
 * 这样 `0 0 29 2 *` 这种稀疏表达式也只需要一千多次迭代，而不是逐分钟扫四年。
 * 返回 null 表示 5 年内不会触发（例如 `0 0 30 2 *`）。
 */
export function nextRunAt(spec: CronSpec, from: number): number | null {
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const limit = new Date(from);
  limit.setFullYear(limit.getFullYear() + SCAN_YEARS);
  const limitAt = limit.getTime();

  while (cursor.getTime() <= limitAt) {
    if (!spec.months.includes(cursor.getMonth() + 1)) {
      cursor.setMonth(cursor.getMonth() + 1, 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(spec, cursor)) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!spec.hours.includes(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!spec.minutes.includes(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0);
      continue;
    }
    return cursor.getTime();
  }

  return null;
}

/** 连续算 n 个触发时刻，用于界面上的「接下来会在这几个时间跑」 */
export function nextRuns(spec: CronSpec, from: number, count = 3): number[] {
  const out: number[] = [];
  let cursor = from;
  for (let i = 0; i < count; i++) {
    const next = nextRunAt(spec, cursor);
    if (next === null) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * 把表达式翻成中文。
 *
 * 只覆盖有意义的组合：能翻就翻，翻不出来就退回原始表达式——
 * 硬凑一句似是而非的话，比直接给表达式更误导人。
 */
export function describeCron(spec: CronSpec): string {
  const time = `${pad(spec.hours[0]!)}:${pad(spec.minutes[0]!)}`;
  const everyMinute = spec.minutes.length === 1 ? null : commonStep(spec.minutes);
  const anyHour = spec.hours.length === 24;
  const everyDay = !spec.domRestricted && !spec.dowRestricted;

  if (anyHour && everyDay && everyMinute) return `每 ${everyMinute} 分钟`;
  if (anyHour && everyDay && spec.minutes.length === 1) {
    return `每小时第 ${spec.minutes[0]} 分`;
  }

  if (everyDay) {
    if (spec.minutes.length === 1 && spec.hours.length === 1) return `每天 ${time}`;
    if (spec.minutes.length === 1 && spec.hours.length <= 6) {
      return `每天 ${spec.hours.map((h) => `${pad(h)}:${pad(spec.minutes[0]!)}`).join('、')}`;
    }
  }

  if (!spec.domRestricted && spec.dowRestricted && spec.minutes.length === 1 && spec.hours.length === 1) {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const days = spec.daysOfWeek;
    if (days.length === 7) return `每天 ${time}`;
    if (isRange(days, 1, 5)) return `工作日 ${time}`;
    if (isRange(days, 0, 0) && days.length === 1) return `每周日 ${time}`;
    if (days.length === 2 && days.join() === '0,6') return `周末 ${time}`;
    if (days.length <= 3) return `每${days.map((d) => names[d]).join('、')} ${time}`;
    return `每周 ${days.length} 天 ${time}`;
  }

  if (spec.domRestricted && !spec.dowRestricted && spec.minutes.length === 1 && spec.hours.length === 1) {
    if (spec.daysOfMonth.length === 1) {
      const prefix = spec.months.length === 12 ? '每月' : `${spec.months.join('、')} 月`;
      return `${prefix} ${spec.daysOfMonth[0]} 日 ${time}`;
    }
    return `每月 ${spec.daysOfMonth.slice(0, 4).join('、')} 日 ${time}`;
  }

  return spec.expr;
}

/** 判断 values 是不是恰好等于 min..max 的连续区间 */
function isRange(values: number[], min: number, max: number): boolean {
  if (values.length !== max - min + 1) return false;
  return values.every((v, i) => v === min + i);
}

/**
 * 判断一组数字是不是「铺满整小时的等差」，是的话返回步长。
 *
 * 必须正好铺满：`0,15,30` 虽然也是等差，但漏了 45，
 * 说成「每 15 分钟」就是撒谎——这种情况退回原表达式。
 */
function commonStep(values: number[]): number | null {
  if (values.length < 2) return null;
  const step = values[1]! - values[0]!;
  if (step <= 0 || values[0] !== 0) return null;
  for (let i = 2; i < values.length; i++) {
    if (values[i]! - values[i - 1]! !== step) return null;
  }
  return values.length * step === 60 ? step : null;
}
