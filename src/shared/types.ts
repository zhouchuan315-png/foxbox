import type { FingerprintPreset, OsFamily } from '../fingerprint/preset.ts';
import type { EngineKind, ProxyConfig } from '../core/engines/types.ts';

export type ProfileStatus = 'idle' | 'starting' | 'running' | 'error';

/** 落库形态：preset / config 都是 JSON 字符串 */
export interface ProfileRecord {
  id: string;
  name: string;
  group_id: string | null;
  engine: EngineKind;
  status: ProfileStatus;
  os_family: OsFamily;
  preset_json: string;
  config_json: string;
  engine_fp_json: string;
  seed: string;
  user_data_dir: string;
  proxy_id: string | null;
  startup_url: string | null;
  headless: number;
  canvas_noise: number | null;
  note: string | null;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
  last_opened_at: number | null;
  last_session_status: string | null;
  last_session_check_at: number | null;
  health_json: string | null;
}

/** 对外形态：JSON 已解析，敏感字段不出库 */
export interface Profile {
  id: string;
  name: string;
  groupId: string | null;
  engine: EngineKind;
  status: ProfileStatus;
  os: OsFamily;
  preset: FingerprintPreset;
  seed: string;
  proxyId: string | null;
  startupUrl: string | null;
  headless: boolean;
  note: string | null;
  /**
   * canvas 读数覆盖：null = 交给引擎（身份与宿主渲染矛盾时才覆盖），
   * true = 强制覆盖成占位随机值，false = 强制不覆盖（会暴露宿主渲染，仅排障用）
   */
  canvasNoise: boolean | null;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number | null;
  /** 最近一次会话检测的结论；null = 从没检测过（与 "unknown" 是两件事） */
  lastSessionStatus: SessionStatus | null;
  lastSessionCheckAt: number | null;
  /**
   * 启动自检结果：null = 没检查过；diff 为空数组 = 检查过且一致。
   * 非空 diff 说明这台环境的身份和预设对不上了（换过显示器 / 老环境）。
   */
  health: ProfileHealth | null;
}

/** 身份自检的差异项：预设说什么、页面实际报什么 */
export interface HealthDiffItem {
  key: string;
  expected: unknown;
  actual: unknown;
}

export interface ProfileHealth {
  checkedAt: number;
  diff: HealthDiffItem[];
}

export interface ProxyRecord {
  id: string;
  name: string;
  protocol: 'http' | 'https' | 'socks5';
  host: string;
  port: number;
  username: string | null;
  password_enc: string | null;
  expected_country: string | null;
  last_check_at: number | null;
  last_check_ok: number | null;
  last_check_country: string | null;
  last_check_city: string | null;
  last_check_lat: number | null;
  last_check_lon: number | null;
  last_check_endpoint: string | null;
  last_check_error: string | null;
  last_exit_ip: string | null;
  last_latency_ms: number | null;
  fail_streak: number;
  created_at: number;
}

export interface ProxySummary {
  id: string;
  name: string;
  protocol: 'http' | 'https' | 'socks5';
  host: string;
  port: number;
  username: string | null;
  hasPassword: boolean;
  /** 用户申报的国家 */
  expectedCountry: string | null;
  lastCheckAt: number | null;
  lastCheckOk: boolean | null;
  /** 实测出口国家，与申报值不一致时说明代理或配置有问题 */
  lastCheckCountry: string | null;
  lastCheckCity: string | null;
  lastCheckLat: number | null;
  lastCheckLon: number | null;
  lastCheckEndpoint: string | null;
  lastCheckError: string | null;
  lastExitIp: string | null;
  lastLatencyMs: number | null;
  failStreak: number;
  createdAt: number;
}

export interface Group {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: number;
  profileCount: number;
}

export interface ProfileFilter {
  groupId?: string;
  /** 只看未分组 */
  ungrouped?: boolean;
  status?: ProfileStatus;
  /** 按名称模糊匹配 */
  q?: string;
  limit?: number;
  offset?: number;
}

export interface ProfileUpdateInput {
  name?: string;
  note?: string | null;
  groupId?: string | null;
  startupUrl?: string | null;
  headless?: boolean;
  /**
   * 只允许自动化（同国家切换）使用。
   * 普通编辑接口不会透传这个字段——改了它就等于换了身份。
   */
  proxyId?: string | null;
}

export interface LaunchRecord {
  id: string;
  profile_id: string;
  pid: number | null;
  auto_port: number | null;
  started_at: number;
  ended_at: number | null;
  exit_code: number | null;
  error: string | null;
}

export interface ResolvedProxy extends ProxyConfig {
  id: string;
  expectedCountry: string | null;
  lastCheckCountry: string | null;
  /** 实测出口坐标；没测到就是 null，不要用 (0,0) 冒充 */
  lastCheckLat: number | null;
  lastCheckLon: number | null;
}

// ───────────────────────────── M4 任务编排 ─────────────────────────────

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type StepStatus = 'ok' | 'failed' | 'skipped';

/**
 * 步骤种类刻意只留很少几种。
 *
 * 每多一种就多一份要维护的语义，而真实需求里「打开、等、取数、留证、关闭」
 * 已经能拼出绝大多数批量动作；更复杂的逻辑塞进 eval 的脚本里，
 * 比在 JSON 里发明 DSL 更省事，也更容易排错。
 */
export type TaskStep =
  | { type: 'start' }
  | { type: 'goto'; url: string; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeoutMs?: number }
  | { type: 'wait'; ms: number }
  | { type: 'eval'; script: string; saveAs?: string; timeoutMs?: number }
  | { type: 'screenshot'; fullPage?: boolean }
  /**
   * 采集落表：脚本返回数组，每项一个扁平/半扁平对象。
   *
   * 与 eval 的区别只在「结果去哪」：eval 的返回值留在结果 JSON 里等人复制，
   * collect 的结果进数据集，能去重、能增量、能导出。两者的脚本语法完全一样。
   */
  | {
      type: 'collect';
      script: string;
      /** 数据集名（不是 id）：任务 JSON 会被复制到别的机器，写 id 就断了 */
      dataset: string;
      /** 用哪几个字段判重；缺省 = 全字段哈希 */
      dedupeBy?: string[];
      /** 默认 upsert：同键更新。append：每次都是新行（流水类数据） */
      mode?: 'upsert' | 'append';
      /** 少于这么多行算失败（默认 0 = 空也算成功） */
      expectMinRows?: number;
      timeoutMs?: number;
    }
  | { type: 'stop' };

export interface TaskTarget {
  profileIds: string[];
  /** 给了就按分组现算目标，profileIds 只在显式指定时使用 */
  groupId?: string | null;
}

export interface TaskStepResult {
  index: number;
  type: TaskStep['type'];
  status: StepStatus;
  elapsedMs: number;
  /** eval 的返回值 / goto 的最终 URL / screenshot 的文件名 */
  output?: unknown;
  error?: string;
  /** 非失败但值得一提的情况，例如「启动时环境已在运行，直接复用」 */
  note?: string;
  /** collect 的落库回执：这是「采集真的发生了」的唯一证据 */
  collect?: CollectReceipt;
}

export interface TaskRunResult {
  profileId: string;
  profileName: string;
  status: 'succeeded' | 'failed' | 'skipped' | 'cancelled';
  startedAt: number;
  elapsedMs: number;
  steps: TaskStepResult[];
  vars: Record<string, unknown>;
  screenshots: string[];
  error?: string;
  /** 实际执行次数（1 = 没重试）。重试只针对瞬时错误，脚本写错不重试 */
  attempts?: number;
  /** transient / permanent / timeout —— 决定要不要重试，也决定告警措辞 */
  errorClass?: ErrorClass;
}

/** 错误分类是本模块唯一需要"判断"的地方，所以集中在一个函数里产出 */
export type ErrorClass = 'transient' | 'permanent' | 'timeout';

export interface TaskResult {
  runs: TaskRunResult[];
  summary: { total: number; succeeded: number; failed: number; skipped: number };
}

export interface TaskRecord {
  id: string;
  name: string;
  status: TaskStatus;
  target_json: string;
  steps_json: string;
  result_json: string | null;
  concurrency: number;
  timeout_ms: number | null;
  retries: number;
  error_class: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

export interface Task {
  id: string;
  name: string;
  status: TaskStatus;
  target: TaskTarget;
  steps: TaskStep[];
  result: TaskResult | null;
  concurrency: number;
  timeoutMs: number;
  retries: number;
  errorClass: ErrorClass | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

// ───────────────────────────── M5 自动化 ─────────────────────────────

export type AutomationKind = 'cron' | 'proxy_watch';
export type AutomationRunStatus = 'ok' | 'skipped' | 'failed';
export type AutomationTrigger = 'cron' | 'watch' | 'manual';

/**
 * 动作保持"小积木"形态，一条规则可以串 1–3 个。
 *
 * 不做条件分支、不做变量传递：一旦允许写 if，用户就会写出只有自己看得懂的
 * 自动化，出问题时连"它本来想干什么"都说不清。要复杂逻辑就写进任务里的 eval。
 */
export type AutomationAction =
  /** 跑一条已存在的任务 */
  | { type: 'run_task'; taskId: string }
  /**
   * 把引用了失效代理的环境切到备用代理。
   *
   * sameCountryOnly 默认 true：指纹里的时区与语言是绑在出口国家上的，
   * 换到另一个国家等于让环境和 IP 自相矛盾——那比代理挂掉更难解释。
   */
  | { type: 'switch_proxy'; standbyProxyId: string; sameCountryOnly?: boolean }
  /** 关掉引用了失效代理且正在运行的环境，避免它继续用坏代理往外发请求 */
  | { type: 'stop_profiles' }
  /** 只记一条事件，不动任何东西——用来观察"到底多久挂一次" */
  | { type: 'notify_only' };

export type AutomationSpec =
  /** 到点触发 */
  | { expr: string }
  /** 定期巡检代理；failThreshold 是连续失败次数门槛（边沿触发，不会每次都报） */
  | { intervalMinutes: number; failThreshold: number; proxyIds?: string[] };

export interface Automation {
  id: string;
  name: string;
  kind: AutomationKind;
  spec: AutomationSpec;
  actions: AutomationAction[];
  enabled: boolean;
  /**
   * 人话版触发条件，例如「工作日 08:30」「每 10 分钟巡检一次」。
   * 由服务端算：cron 的解析只存在于后端，界面上再实现一遍必然走样。
   */
  describe?: string;
  /** 下次醒来的时刻；null 表示表达式 5 年内都不会触发 */
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: AutomationRunStatus | null;
  lastError: string | null;
  runCount: number;
  createdAt: number;
}

export interface AutomationRecord {
  id: string;
  name: string;
  kind: AutomationKind;
  spec_json: string;
  actions_json: string;
  enabled: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_status: string | null;
  last_error: string | null;
  run_count: number;
  created_at: number;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  trigger: AutomationTrigger;
  status: AutomationRunStatus;
  /** 人话版的"发生了什么"，例如「2 个环境已切到 备用-HK」 */
  detail: string | null;
  taskId: string | null;
  startedAt: number;
  endedAt: number | null;
}

// ───────────────────────────── M6 数据落地 ─────────────────────────────

export type DatasetColumnType = 'string' | 'number' | 'boolean' | 'json' | 'null' | 'mixed';

export interface DatasetColumn {
  key: string;
  type: DatasetColumnType;
  /** 第一次出现的时间：字段是随脚本改版长出来的，留个来源便于判断哪次改动引入的 */
  addedAt: number;
}

export interface DatasetDedupe {
  /** fields：按指定字段判重；hash：整行哈希 */
  mode: 'fields' | 'hash';
  fields: string[];
}

export interface DatasetRecord {
  id: string;
  name: string;
  schema_json: string;
  dedupe_json: string;
  row_count: number;
  created_at: number;
  updated_at: number;
}

export interface Dataset {
  id: string;
  name: string;
  columns: DatasetColumn[];
  dedupe: DatasetDedupe;
  rowCount: number;
  createdAt: number;
  updatedAt: number;
  /** 最近一次写入时间，用来发现「写错名字建了个空表」 */
  lastWriteAt: number | null;
}

export interface DatasetRowRecord {
  id: string;
  dataset_id: string;
  dedupe_key: string;
  data_json: string;
  first_profile_id: string | null;
  last_profile_id: string | null;
  first_task_id: string | null;
  first_seen_at: number;
  last_seen_at: number;
  seen_count: number;
}

export interface DatasetRow {
  id: string;
  datasetId: string;
  data: Record<string, unknown>;
  firstProfileId: string | null;
  lastProfileId: string | null;
  firstTaskId: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  seenCount: number;
}

/**
 * 一次 collect 的落库回执。
 *
 * skipped 专门统计「指定了 dedupeBy 但该行关键字段全为空」的行：
 * 这类行如果硬写，会全部塌成同一个哈希互相覆盖，只留下最后一条——
 * 那比不写更危险，所以跳过并让人看见。
 */
export interface CollectReceipt {
  dataset: string;
  written: number;
  inserted: number;
  updated: number;
  skipped: number;
}

// ───────────────────────────── M7 会话巡检 ─────────────────────────────

/**
 * 三态，`unknown` 是设计核心。
 *
 * 把「探针自己打不开」当成「账号掉登录了」，是这类功能最常见的死法：
 * 代理一挂，几十个环境同时报红，用户挨个重新登录发现都是好的，
 * 从此再也不看这个红点——而它本该是最值得信任的信号。
 */
export type SessionStatus = 'alive' | 'expired' | 'unknown';

export type ProbeRule =
  /** 页面上存在某个元素即视为已登录 */
  | { type: 'selector'; selector: string; visible?: boolean }
  /** 未登录会被重定向，落地 URL 不应匹配此正则 */
  | { type: 'url'; mustNotMatch: string }
  /** 自定义脚本，返回 boolean */
  | { type: 'script'; script: string };

export interface SessionProbeRecord {
  id: string;
  name: string;
  profile_id: string | null;
  group_id: string | null;
  url: string;
  rule_json: string;
  interval_hours: number | null;
  enabled: number;
  created_at: number;
}

export interface SessionProbe {
  id: string;
  name: string;
  profileId: string | null;
  groupId: string | null;
  url: string;
  rule: ProbeRule;
  intervalHours: number | null;
  enabled: boolean;
  createdAt: number;
}

export interface SessionCheckRecord {
  id: string;
  probe_id: string | null;
  profile_id: string;
  status: SessionStatus;
  detail: string | null;
  elapsed_ms: number | null;
  checked_at: number;
}

export interface SessionCheck {
  id: string;
  probeId: string | null;
  profileId: string;
  status: SessionStatus;
  detail: string | null;
  elapsedMs: number | null;
  checkedAt: number;
}

/** 巡检任务只存内存：进度丢了可以接受，每条检查结果都已落库，事实不会丢 */
export interface SessionJob {
  id: string;
  status: 'running' | 'done' | 'cancelled';
  total: number;
  done: number;
  startedAt: number;
  endedAt: number | null;
  summary: { alive: number; expired: number; unknown: number; skipped: number };
  results: Array<{
    profileId: string;
    profileName: string;
    status: SessionStatus | 'skipped';
    detail: string | null;
    elapsedMs: number;
  }>;
  error: string | null;
}

// ───────────────────────────── M8 通知 ─────────────────────────────

export type NotifyEvent = 'task.failed' | 'session.expired' | 'proxy.dead' | 'automation.skipped';

export interface NotifierRecord {
  id: string;
  name: string;
  kind: 'webhook';
  url: string;
  secret: string | null;
  events_json: string;
  enabled: number;
  created_at: number;
}

/** 对外形态：secret 只报"有没有"，不回显 */
export interface Notifier {
  id: string;
  name: string;
  kind: 'webhook';
  url: string;
  hasSecret: boolean;
  events: string[];
  enabled: boolean;
  createdAt: number;
}
