-- FoxBox 数据库结构（v1）
-- 约定：所有时间戳为 Unix 毫秒；所有主键为 26 位 ULID 风格字符串。
-- config_json 是「固化后的引擎配置」，与 preset_json（可读的身份描述）分离：
--   preset_json 给人看、给校验用；config_json 给引擎用、决定真实身份。

CREATE TABLE IF NOT EXISTS groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS proxies (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  protocol          TEXT NOT NULL CHECK (protocol IN ('http','https','socks5')),
  host              TEXT NOT NULL,
  port              INTEGER NOT NULL,
  username          TEXT,
  password_enc      TEXT,               -- AES-256-GCM 密文，密钥在本地 keyfile
  expected_country  TEXT,               -- 用户申报的国家（ISO-3166 alpha-2）
  last_check_at     INTEGER,
  last_check_ok     INTEGER,
  last_check_country TEXT,              -- 实测国家，与申报值分开存：对不上时要让人看见
  last_check_city   TEXT,
  last_check_lat    REAL,               -- 实测出口纬度，用于回填 geolocation
  last_check_lon    REAL,
  last_check_endpoint TEXT,             -- 哪个探测端点给出的结果，便于排查
  last_check_error  TEXT,
  last_exit_ip      TEXT,
  last_latency_ms   INTEGER,
  fail_streak       INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  group_id        TEXT REFERENCES groups(id) ON DELETE SET NULL,
  engine          TEXT NOT NULL DEFAULT 'camoufox'
                    CHECK (engine IN ('camoufox','patchright')),
  status          TEXT NOT NULL DEFAULT 'idle'
                    CHECK (status IN ('idle','starting','running','error')),
  os_family       TEXT NOT NULL CHECK (os_family IN ('windows','macos','linux')),
  preset_json     TEXT NOT NULL,        -- 可读身份，创建时固化
  config_json     TEXT NOT NULL,        -- 引擎配置（CAMOU_CONFIG），创建时固化
  engine_fp_json  TEXT NOT NULL,        -- 引擎原生 fingerprint，启动时传它可跳过身份生成
  seed            TEXT NOT NULL,
  user_data_dir   TEXT NOT NULL,        -- 相对 FOXBOX_HOME，迁移后仍有效
  proxy_id        TEXT REFERENCES proxies(id) ON DELETE SET NULL,
  startup_url     TEXT,
  headless        INTEGER NOT NULL DEFAULT 0,
  -- NULL = 交给引擎（身份与宿主渲染矛盾时才覆盖）；1 = 强制覆盖；0 = 强制不覆盖
  canvas_noise    INTEGER,
  note            TEXT,
  deleted_at      INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_opened_at  INTEGER,
  -- 会话状态的冗余列：列表页直接读，避免每个环境查一次 session_checks
  last_session_status   TEXT,
  last_session_check_at INTEGER,
  -- 启动自检结果（identity 与预设的差异）。非空 = 这台环境「身份待检查」，
  -- 典型来源是修复前创建的环境：预设报 1920×1200，机器只有 1280×800。
  health_json     TEXT
);

CREATE INDEX IF NOT EXISTS idx_profiles_group ON profiles(group_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_profiles_status ON profiles(status);
CREATE INDEX IF NOT EXISTS idx_profiles_updated ON profiles(updated_at DESC);

CREATE TABLE IF NOT EXISTS launches (
  id          TEXT PRIMARY KEY,
  profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  pid         INTEGER,
  auto_port   INTEGER,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  exit_code   INTEGER,
  error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_launches_open ON launches(profile_id) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action     TEXT NOT NULL,
  profile_id TEXT,
  detail     TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_profile ON audit_logs(profile_id, created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 任务：把「对一批环境做同一串动作」固化成一条可重放、可查证的记录。
-- steps_json 是动作序列（start/goto/wait/eval/screenshot/stop），
-- result_json 是逐目标、逐步的执行结果——失败要能定位到第几步。
CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  target_json  TEXT NOT NULL,           -- { profileIds: [], groupId?: string }
  steps_json   TEXT NOT NULL,
  result_json  TEXT,
  concurrency  INTEGER NOT NULL DEFAULT 1,
  -- 整条任务的总时限与重试次数。单步有 timeoutMs，但 20 步 × 180s 能挂一小时，
  -- 期间界面上一直是"执行中"，没人知道它卡在哪。
  timeout_ms   INTEGER,
  retries      INTEGER NOT NULL DEFAULT 0,
  error_class  TEXT,                    -- transient / permanent / timeout
  error        TEXT,
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  ended_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);

-- 自动化：把「什么时候跑」从人手里拿走。
-- 两类规则共用一张表，靠 kind 区分：
--   cron        —— 到点跑一条任务（spec 是表达式，action 是 run_task）
--   proxy_watch —— 定期巡检代理，失败达阈值时执行动作（切备用代理 / 停环境 / 跑任务）
-- next_run_at 是"下次该醒来的时刻"，调度器只按它排序，不重新解析表达式。
CREATE TABLE IF NOT EXISTS automations (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('cron','proxy_watch')),
  spec_json     TEXT NOT NULL,
  actions_json  TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  next_run_at   INTEGER,
  last_run_at   INTEGER,
  last_status   TEXT,
  last_error    TEXT,
  run_count     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_automations_due ON automations(enabled, next_run_at);

-- 每次触发留一条：为什么跑、跑了什么、结果如何。
-- 定时任务最怕"悄悄没跑"，所以跳过也要落一行，而不是只在日志里飘一句。
CREATE TABLE IF NOT EXISTS automation_runs (
  id            TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  trigger       TEXT NOT NULL,
  status        TEXT NOT NULL,
  detail        TEXT,
  task_id       TEXT,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_automation_runs ON automation_runs(automation_id, started_at DESC);

-- 数据集：collect 步骤的落地表。
-- 与任务的关系是「结果 vs 过程」：任务可以被删，数据不能跟着走。
-- 所以 dataset_rows.first_task_id 故意不加外键——删任务不该删掉用户采到的业务数据。
CREATE TABLE IF NOT EXISTS datasets (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,   -- 用名字不用 id：任务 JSON 要能跨机器复制
  schema_json  TEXT NOT NULL,          -- [{key,type,addedAt}]，按首次出现顺序
  dedupe_json  TEXT NOT NULL,          -- {mode:'fields'|'hash', fields:[]}
  row_count    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dataset_rows (
  id               TEXT PRIMARY KEY,
  dataset_id       TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  dedupe_key       TEXT NOT NULL,
  data_json        TEXT NOT NULL,
  first_profile_id TEXT,               -- 谁最先看到它
  last_profile_id  TEXT,               -- 谁最后看到它（多账号价格差异时有用）
  first_task_id    TEXT,               -- 故意无外键，见上
  first_seen_at    INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL,
  seen_count       INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dataset_rows ON dataset_rows(dataset_id, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_dataset_rows_recent ON dataset_rows(dataset_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_dataset_rows_profile ON dataset_rows(dataset_id, last_profile_id);

-- 登录态探针：打开一个「只有登录后可见」的页面，看结果。
-- 不读 Cookie 的 expires：大量站点是 session cookie（没有过期时间），
-- 有些是短 access token + refresh token，Cookie 一直在但已失效。
-- 唯一可信的判据是「页面给不给看」。
CREATE TABLE IF NOT EXISTS session_probes (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  profile_id     TEXT REFERENCES profiles(id) ON DELETE CASCADE,
  group_id       TEXT REFERENCES groups(id) ON DELETE CASCADE,
  url            TEXT NOT NULL,
  rule_json      TEXT NOT NULL,
  interval_hours INTEGER,                 -- NULL = 只手动触发
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  CHECK ((profile_id IS NULL) <> (group_id IS NULL))
);

-- 每次检查留一行。probe_id 可为空：临时检测（不保存探针）也要留证据。
CREATE TABLE IF NOT EXISTS session_checks (
  id          TEXT PRIMARY KEY,
  probe_id    TEXT REFERENCES session_probes(id) ON DELETE CASCADE,
  profile_id  TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('alive','expired','unknown')),
  detail      TEXT,
  elapsed_ms  INTEGER,
  checked_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_checks ON session_checks(probe_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_checks_profile ON session_checks(profile_id, checked_at DESC);

-- 通知通道。只做 Webhook：企业内部常用的企微/飞书/钉钉都收 JSON，
-- 在自己的群机器人前面加一层转换比内置十几个渠道更省事。
CREATE TABLE IF NOT EXISTS notifiers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('webhook')),
  url         TEXT NOT NULL,
  secret      TEXT,
  events_json TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

-- 每条投递留一行。suppressed 是聚合窗口内的重复事件——它们没发出去，
-- 但也要能查到"当时其实触发了 12 次"。
CREATE TABLE IF NOT EXISTS notification_logs (
  id           TEXT PRIMARY KEY,
  notifier_id  TEXT,
  event        TEXT NOT NULL,
  dedupe_key   TEXT,
  status       TEXT NOT NULL,
  http_status  INTEGER,
  error        TEXT,
  payload_json TEXT,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notification_logs ON notification_logs(created_at DESC);
