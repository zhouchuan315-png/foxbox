# FoxBox 技术设计文档

| 项目 | 内容 |
|---|---|
| 版本 | v0.1 |
| 日期 | 2026-11-19 |
| 对应 PRD | `docs/PRD.md` v0.1 |
| 技术栈 | TypeScript / Node 22.15+ / Electron / React / SQLite / Camoufox |

---

## 1. 设计原则

1. **引擎可替换**：业务层只依赖 `EngineAdapter` 接口，不直接 import 具体引擎。换引擎不改业务代码。
2. **指纹一次生成、永久固化**：环境创建时生成完整 identity preset 并落库，之后每次启动原样复用。任何"每次启动重新随机"的实现都是错的——那会让平台看到设备在变。
3. **以页面读数为准**：所有"设置成功"的判断，来自环境内 `page.evaluate` 的实际返回值，不是来自配置写入成功的日志。
4. **失败要响**：启动链路任一环节（代理不通、指纹矛盾、端口占用）都必须显式失败并给出人话原因，禁止降级到"能开就行"。
5. **本地优先**：无服务端、无遥测、无自动上报。

---

## 2. 技术选型与版本锁定

| 层 | 选型 | 理由 |
|---|---|---|
| 运行时 | Node.js ≥ 22.15 | Camoufox TS 包硬性要求；当前开发机 v22.22.2 ✅ |
| 引擎 | `camoufox` + `playwright-core` | C++ 层改指纹，非 JS 注入；官方 TS 包 |
| 引擎备选 | `patchright` | Chromium，提供 CDP，指纹弱于 Camoufox |
| 桌面壳 | Electron + Vite + React + TS | 纯 TS 技术栈，与用户偏好一致；Tauri 需 Rust，暂不引入 |
| 数据库 | `better-sqlite3` | 同步 API、单文件、事务简单；单机场景性能最好 |
| 本地 API | `fastify` | 轻量、schema 校验内建、启动快 |
| 加密 | Electron `safeStorage` | 走系统钥匙串（macOS Keychain），不自己造轮子 |
| 校验 | `zod` | 配置与 API 入参统一校验，并作为 preset 的类型来源 |

### 2.1 版本锁定（关键）

```jsonc
{
  "engines": { "node": ">=22.15.0" },
  "dependencies": {
    "camoufox": "0.5.x",              // 与浏览器 build 配对，跟随升级
    "playwright-core": "<1.63.0",     // Camoufox 明确要求 < 1.63
    "better-sqlite3": "^11",
    "fastify": "^5",
    "zod": "^3"
  }
}
```

> `camoufox` 包与浏览器 build 是一对一配对的，升级包必须重跑 `npx camoufox fetch`。`playwright-core` 越过 1.63 会破坏兼容，用 `overrides` 强制钉住。

### 2.2 引擎能力矩阵（决定架构的硬约束）

| 能力 | Camoufox (Firefox) | Patchright (Chromium) |
|---|---|---|
| 指纹伪装层级 | C++ 引擎层 | 无（仅去自动化痕迹） |
| CDP 端点 | ❌ 不提供（走 Juggler 协议） | ✅ 提供 |
| Chrome 扩展 | ❌（可用 Firefox add-on） | ✅ |
| `geoip` 自动对齐 | ✅ | ❌ 需手工对齐 |
| 进程内自动化句柄 | ✅ 返回 Playwright `Browser` | ✅ |
| 单实例内存 | ~250–350 MB | ~500 MB+ |

**这条矩阵直接决定了两件事**：
1. 面向外部脚本的"CDP attach"能力只能给 Chromium 引擎，Firefox 引擎改为**进程内脚本执行**。
2. 默认引擎选 Camoufox（指纹质量优先），需要 Chrome 扩展或 DSP 对接时切 Patchright。

---

## 3. 系统架构

```
┌──────────────────────────── Electron Main (Node) ────────────────────────────┐
│                                                                              │
│  ┌────────────┐   ┌──────────────┐   ┌─────────────┐   ┌─────────────────┐  │
│  │ ProfileSvc │   │ ProxySvc     │   │ EngineMgr   │   │ LocalApiServer  │  │
│  │ 环境 CRUD  │   │ 代理/预检    │   │ 启动/回收    │   │ 127.0.0.1:50401 │  │
│  └─────┬──────┘   └──────┬───────┘   └──────┬──────┘   └─────────────────┘  │
│        │                 │                  │                                │
│  ┌─────▼─────────────────▼──────────────────▼───────┐   ┌────────────────┐  │
│  │              Repository (better-sqlite3)         │   │ SelfCheckSvc   │  │
│  │              profiles / proxies / launches       │   │ 指纹一致性比对  │  │
│  └──────────────────────────────────────────────────┘   └────────────────┘  │
│                                                                              │
│  ┌──────────────────────── EngineAdapter ────────────────────────────────┐   │
│  │  interface: launch(spec) / stop(id) / probe(id) / status(id)          │   │
│  └───────┬──────────────────────────────────────────────┬────────────────┘   │
│          │                                              │                    │
│  ┌───────▼────────────┐                        ┌────────▼─────────────┐      │
│  │ CamoufoxAdapter    │                        │ PatchrightAdapter    │      │
│  │ (默认)              │                        │ (CDP / 扩展场景)      │      │
│  └───────┬────────────┘                        └────────┬─────────────┘      │
└──────────┼──────────────────────────────────────────────┼────────────────────┘
           │ 子进程 + 独立 user-data-dir                   │
    ┌──────▼──────┐  ┌──────────────┐              ┌──────▼──────┐
    │ Profile A   │  │ Profile B    │      ...     │ Profile N   │
    │ 指纹/存储/IP │  │ 指纹/存储/IP  │              │ 指纹/存储/IP │
    └─────────────┘  └──────────────┘              └─────────────┘
```

### 3.1 进程模型

- **主进程**：持有 DB、服务、引擎管理器，是唯一写入者
- **渲染进程**：只通过 preload 暴露的 IPC 通道读写，不直接碰文件系统
- **浏览器进程**：每个环境独立子进程 + 独立 `user_data_dir`，由 `EngineMgr` 统一登记 PID，退出时级联 kill

> 关键：**不要在一个浏览器进程里用多 context 模拟多个环境**。虽然 Camoufox 的 `NewContext()` 能做到指纹隔离，但存储隔离、崩溃隔离、代理隔离都不如独立进程干净。多环境 = 多进程。

---

## 4. 目录结构

```
foxbox/
├── docs/
│   ├── PRD.md
│   └── TECH.md
├── electron/
│   ├── main.ts                 # 应用入口、窗口、生命周期
│   ├── preload.ts              # contextBridge 白名单 IPC
│   └── ipc/
│       ├── profiles.ts
│       ├── proxies.ts
│       └── browser.ts
├── src/
│   ├── core/
│   │   ├── db/
│   │   │   ├── index.ts        # 连接、迁移
│   │   │   ├── schema.sql
│   │   │   └── migrations/
│   │   ├── repositories/
│   │   │   ├── profile.repo.ts
│   │   │   ├── proxy.repo.ts
│   │   │   └── launch.repo.ts
│   │   ├── services/
│   │   │   ├── profile.service.ts
│   │   │   ├── proxy.service.ts
│   │   │   ├── selfcheck.service.ts
│   │   │   └── script.service.ts
│   │   └── engines/
│   │       ├── types.ts        # EngineAdapter / LaunchSpec / LaunchHandle
│   │       ├── manager.ts      # 生命周期、并发队列、孤儿回收
│   │       ├── camoufox.adapter.ts
│   │       └── patchright.adapter.ts
│   ├── fingerprint/
│   │   ├── preset.ts           # preset 类型 + zod schema
│   │   ├── generator.ts        # 按 geo + os 生成自洽 preset
│   │   ├── validator.ts        # 一致性规则（矛盾检测）
│   │   └── probe.ts            # 页面侧采集脚本
│   ├── api/
│   │   ├── server.ts           # fastify 实例 + 鉴权
│   │   └── routes/
│   └── shared/
│       └── types.ts
├── ui/
│   ├── App.tsx
│   ├── pages/
│   └── components/
├── profiles/                   # 运行期数据（gitignore）
└── package.json
```

---

## 5. 数据模型

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE proxies (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  protocol          TEXT NOT NULL CHECK (protocol IN ('http','https','socks5')),
  host              TEXT NOT NULL,
  port              INTEGER NOT NULL,
  username          TEXT,
  password_cipher   BLOB,              -- safeStorage 加密后的密文
  expected_country  TEXT,              -- ISO-3166 alpha-2，来自预检
  last_check_at     INTEGER,
  last_check_ok     INTEGER,
  last_exit_ip      TEXT,
  last_latency_ms   INTEGER,
  fail_streak       INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);

CREATE TABLE profiles (
  id              TEXT PRIMARY KEY,     -- ULID
  name            TEXT NOT NULL,
  group_id        TEXT REFERENCES groups(id) ON DELETE SET NULL,
  engine          TEXT NOT NULL DEFAULT 'camoufox'
                    CHECK (engine IN ('camoufox','patchright')),
  status          TEXT NOT NULL DEFAULT 'idle'
                    CHECK (status IN ('idle','starting','running','error')),
  os_family       TEXT NOT NULL CHECK (os_family IN ('windows','macos','linux')),
  preset_json     TEXT NOT NULL,        -- 完整 identity preset，创建时固化
  seed            TEXT NOT NULL,        -- 生成 preset 的种子，便于复现
  user_data_dir   TEXT NOT NULL,        -- 相对路径，避免迁移后失效
  proxy_id        TEXT REFERENCES proxies(id) ON DELETE SET NULL,
  startup_url     TEXT,
  note            TEXT,
  deleted_at      INTEGER,              -- 软删除（回收站）
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_opened_at  INTEGER
);

CREATE INDEX idx_profiles_group ON profiles(group_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_profiles_status ON profiles(status);

CREATE TABLE launches (
  id          TEXT PRIMARY KEY,
  profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  pid         INTEGER,
  auto_port   INTEGER,                  -- Chromium 引擎的 CDP 端口
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  exit_code   INTEGER,
  error       TEXT
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action     TEXT NOT NULL,
  profile_id TEXT,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
```

### 5.1 preset_json 结构

```ts
interface FingerprintPreset {
  seed: string;
  os: 'windows' | 'macos' | 'linux';
  ua: string;
  firefoxVersion: string;
  screen: { width: number; height: number; colorDepth: number; dpr: number };
  window: { innerWidth: number; innerHeight: number };
  locale: string;              // 如 'en-US'
  languages: string[];         // ['en-US','en']
  timezone: string;            // 'America/Los_Angeles'
  geolocation: { latitude: number; longitude: number };
  hardwareConcurrency: number;
  deviceMemory: number;
  webgl: { vendor: string; renderer: string };
  fonts: string[];
  webrtcIp?: string;           // 由 geoip 从代理出口推导
  canvasNoise: boolean;
  audioNoise: boolean;
}
```

> `preset_json` 一旦写入，除显式"重置指纹"操作外不可变。UI 层对指纹字段默认只读。

---

## 6. 核心模块设计

### 6.1 引擎抽象

```ts
export interface LaunchSpec {
  profileId: string;
  userDataDir: string;
  preset: FingerprintPreset;
  proxy?: { server: string; username?: string; password?: string };
  headless: boolean;
  startupUrl?: string;
  geoip: boolean;
}

export interface LaunchHandle {
  profileId: string;
  pid: number;
  engine: 'camoufox' | 'patchright';
  browser: unknown;        // Playwright Browser/BrowserContext，进程内使用
  cdpEndpoint?: string;    // 仅 Chromium 引擎有
  startedAt: number;
}

export interface EngineAdapter {
  readonly kind: 'camoufox' | 'patchright';
  launch(spec: LaunchSpec): Promise<LaunchHandle>;
  stop(handle: LaunchHandle): Promise<void>;
  probe(handle: LaunchHandle): Promise<ProbeResult>;
}
```

`EngineManager` 负责：并发令牌（默认 8）、端口分配（Chromium 用 52000–52999 随机且 bind 探测）、句柄表、进程退出监听、应用退出时级联 kill。

### 6.2 Camoufox 适配器要点

```ts
import { Camoufox, NewContext } from 'camoufox';

const browser = await Camoufox({
  headless: false,
  persistent_context: true,
  user_data_dir: spec.userDataDir,
  proxy: spec.proxy,
  geoip: spec.geoip,
  humanize: true,
  canvas_noise: spec.preset.canvasNoise,
  os: spec.preset.os,          // 与宿主机一致时 Canvas 最自洽
  locale: spec.preset.languages,
  i_know_what_i_am_doing: true // 仅在我们已固化 preset 时使用
});
```

注意事项：

- `persistent_context: true` 时返回的是 `BrowserContext` 而非 `Browser`，类型要按联合处理。
- 显式传 `os` / `locale` / `screen` 会触发 launcher 的"你覆盖了自动生成值"警告。因为我们的 preset 是**自己固化的**，这是预期行为，需要设置 `i_know_what_i_am_doing` 并**保留一条日志**记录被覆盖的字段，便于排障。
- **Canvas 与 OS 的耦合**：若 `os` 与宿主机不同，读数会走随机化，表现为"隐私强化浏览器"特征。策略：默认 `os` 跟宿主机一致；用户强行选异 OS 时，在 UI 上标注该副作用。

### 6.3 关于 CDP 的诚实说明

Camoufox 是 Firefox 分支，走 Juggler 协议，**不存在 CDP 端点**。因此：

| 需求 | Camoufox 方案 | Chromium 方案 |
|---|---|---|
| 外部脚本接管 | Local API 提交脚本 → 主进程内用已持有的 `browser` 执行 | 暴露 `ws://127.0.0.1:<port>`，外部 Playwright `connectOverCDP` |
| 多语言客户端 | 通过 HTTP 提交 JS 脚本 | 任意支持 CDP 的客户端 |

不要试图给 Camoufox 套一层假 CDP——协议不兼容，做出来只会浪费两周。

### 6.4 指纹一致性规则

`validator.ts` 在**创建时**和**启动前**各跑一次，任一条不满足则拒绝保存/拒绝启动：

| 规则 | 说明 |
|---|---|
| R1 时区 ∈ 代理国家 | 代理出口为 US，时区必须是美国时区 |
| R2 语言首项 ∈ 代理国家常用语言 | `en-US` 配 US，`de-DE` 配 DE |
| R3 UA 中的 OS == `os` 字段 | 不允许 UA 写 Windows、preset 写 macOS |
| R4 屏幕尺寸 ∈ 该 OS 常见分辨率集合 | 避免 4K 屏配 1366×768 的移动 UA |
| R5 `hardwareConcurrency` / `deviceMemory` ∈ 合理区间 | 桌面 4–16 核、8–32 GB，避免 1 核 64 GB |
| R6 WebGL renderer 与 OS 匹配 | Windows 不出现 Apple M 系列 GPU |
| R7 地理坐标落在代理国家范围内 | 由 geoip 自动填，不手改 |

### 6.5 自检（SelfCheck）

```
启动环境
  → 打开 about:blank（不请求外网，避免污染 & 提速）
  → page.evaluate(probeScript) 采集 12 个字段
  → 与 preset 逐字段 diff
  → 输出 { ok: boolean, mismatches: [{key, expected, actual}] }
  → 写入 audit_logs，UI 顶部展示徽标（绿/黄/红）
```

`probeScript` 覆盖：`userAgent`、`platform`、`languages`、`timezone`、`utcOffset`、`screen`、`dpr`、`hardwareConcurrency`、`deviceMemory`、`webgl.vendor`、`webgl.renderer`、`webdriver`。

### 6.6 代理预检（M2 已实现）

设计文档最初写的是「undici ProxyAgent + 本地 MaxMind 库」，实现时两处都改了，原因如下。

**不用 undici：** `ProxyAgent` 只支持 HTTP/HTTPS 代理，不支持 SOCKS5，而 socks5 恰恰是这类业务最常见的协议。改为自己实现握手，顺带把失败原因归到具体阶段：

```
openTunnel(proxy, target, deadline)
  ├─ http/https → TCP(+TLS) → CONNECT host:port → 看状态行
  └─ socks5     → 问候 → 认证(0x02) → CONNECT → 读 BND.ADDR
       ↓
  tls.connect({ socket })  （目标为 https 时）
       ↓
  手写 HTTP/1.1 GET + 逐字节解析响应（含 chunked）
```

**不引本地 GeoIP 库：** MaxMind 要下载维护 mmdb 且需授权，收益不大——IP 归属地查询服务本身就返回国家码。改为三级探测端点，任一成功即可：

| 端点 | 协议 | 说明 |
|---|---|---|
| `www.cloudflare.com/cdn-cgi/trace` | https | 纯文本 `ip=` / `loc=`，无限流、响应 < 1KB，首选 |
| `api.ip.sb/geoip` | https | JSON，带 city，作为国家码缺失时的补充 |
| `ip-api.com/json` | **http** | 前两个都不通时的兜底（部分代理只放行 80） |

失败分类：`proxy-connect`（地址/端口不通）、`proxy-tls`（证书）、`proxy-auth`（407 / SOCKS5 认证拒绝）、`target-connect`（代理通了但目标不可达）、`timeout`。

**实测开销**：握手 170–470ms，整次预检（含 TLS + HTTP）230–1000ms。

> 取舍：依赖第三方 IP 服务意味着预检本身有外部依赖。缓解方式是三端点冗余 + 失败不阻塞已有数据（保留上一次成功结果，只把 `last_check_ok` 置 false）。

另外，**申报国家与实测国家分开存**（`expected_country` / `last_check_country`）。只信申报值会让指纹时区跟真实出口脱节，只信实测值会在预检失败时丢失可用信息。

---

## 7. 关键流程时序

### 7.1 启动环境

```
UI          ProfileSvc      ProxySvc     Validator    EngineMgr    Camoufox
 │  start(id)   │              │             │            │            │
 │────────────>│              │             │            │            │
 │             │ 读 profile+preset           │            │            │
 │             │─────────────>│ 预检代理     │            │            │
 │             │<─────────────│ ok/country   │            │            │
 │             │ 一致性校验 ────────────────>│            │            │
 │             │<─────────────────────────── │ pass/fail  │            │
 │             │ [fail] 返回具体原因，终止     │            │            │
 │             │ 申请并发令牌 ───────────────────────────>│            │
 │             │ 启动 ─────────────────────────────────>│ launch()   │
 │             │<────────────────────────────────────── │ handle     │
 │             │ 自检 ─────────────────────────────────>│ evaluate   │
 │             │ 更新 status=running + launch 记录      │            │
 │<────────────│                                          │            │
```

### 7.2 孤儿进程回收

- 启动时写入 `launches(pid, started_at)`
- 应用启动时扫描：DB 中 `ended_at IS NULL` 且 `pid` 仍存活的记录 → 询问用户"上次有环境未正常关闭，是否重新接管或终止"
- 应用退出（`before-quit`）→ 遍历所有 handle → `browser.close()` → 5s 未退则 `kill -TERM` → 再 3s 则 `kill -KILL`

---

## 8. 本地 API 设计

Base：`http://127.0.0.1:7331`
鉴权：`Authorization: Bearer <token>`（`FOXBOX_TOKEN` 未设置时每次启动随机生成，启动日志打印一次）
除 `/health` 外所有路径都要求 token。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 存活检查，免鉴权 |
| GET | `/profiles` | 列表，支持 `?groupId=&ungrouped=&status=&q=&limit=&offset=`，返回 `{ items, total }` |
| POST | `/profiles` | 创建；`country` 可省略——绑定代理时按预检结果推断 |
| GET | `/profiles/:id` | 详情（含固化 preset） |
| PATCH | `/profiles/:id` | 改名称/备注/分组/启动页/无头；**指纹不可改** |
| DELETE | `/profiles/:id` | 软删；运行中拒绝（409） |
| POST | `/profiles/:id/start` | 启动，返回 `{ launchId, pid, elapsedMs, warnings }` |
| POST | `/profiles/:id/stop` | 关闭 |
| POST | `/profiles/:id/selfcheck` | 在运行实例里采样并与库里 preset 比对 |
| GET | `/profiles/:id/launches` | 启动历史 |
| GET/POST | `/proxies` | 列表 / 新建（`check: true` 建完立即预检） |
| GET/PATCH/DELETE | `/proxies/:id` | 详情 / 修改 / 删除（被引用时 409） |
| POST | `/proxies/:id/check` | 单条预检 |
| POST | `/proxies/check` | 全量预检（串行） |
| GET/POST | `/groups` | 分组列表（带 `profileCount`）/ 新建 |
| PATCH/DELETE | `/groups/:id` | 改名排序 / 删除（组内环境落回未分组） |
| GET | `/audit` | 最近 50 条审计 |

错误语义（M2 起统一）：

| 状态码 | 场景 |
|---|---|
| 400 | 参数不合法（zod）、缺少必要信息 |
| 404 | 环境/代理/分组不存在 |
| 409 | 业务冲突：被引用的代理不可删、运行中不可改/删、分组重名 |
| 422 | 指纹一致性校验未通过，body 带 `issues[]` |
| 502 | 代理预检失败 / 启动前发现代理不可用，body 带 `check` |

```jsonc
// POST /profiles 请求体
{
  "name": "店铺-US-01",
  "proxyId": "01J...",        // country 可省略，按代理实测国家推断
  "groupId": "01J...",
  "os": "windows",
  "startupUrl": "https://example.com",
  "headless": false
}
// 响应中返回生成好的 preset，供用户确认
```

> 设计上刻意**不允许通过 API 传入自定义 fingerprint 字段**。指纹由系统按 `os + 代理国家` 推导，避免脚本传入互相矛盾的组合。
> `proxyId` 同样不可通过 PATCH 修改：换代理等于换出口，指纹必须重建，正确做法是新建环境。

---

## 9. 安全设计

| 面 | 措施 |
|---|---|
| 本地 API | 仅 bind `127.0.0.1`；Bearer Token；拒绝非本机来源；无 CORS 通配 |
| 代理密码 | `safeStorage.encryptString`，密文入库；日志掩码为 `****` |
| IPC | `contextIsolation: true`、`nodeIntegration: false`，preload 白名单通道 |
| 目录穿越 | `user_data_dir` 只接受系统生成的 ULID，不接受用户输入路径 |
| 脚本执行 | 仅在已启动环境内执行；超时 30s；禁止 `require`/`import` 系统模块 |
| 数据清理 | 彻底删除环境时递归删除其 user-data 目录，但校验路径必须位于 `profiles/` 下 |

---

## 10. 测试策略

| 层 | 方式 | 重点用例 |
|---|---|---|
| 单元 | vitest | validator 的 7 条规则、preset 生成分布、代理 URL 拼装 |
| 集成 | vitest + 真实引擎 | 启动→自检→关闭→重启，3 次自检结果完全一致 |
| 隔离验证 | 手工/脚本 | A 环境登录后 B 环境仍为未登录；A/B 的 WebGL 不同 |
| 代理 | 模拟代理服务 | auth fail、超时、国家不匹配 三类错误分支 |
| 稳定性 | 循环 20 次启动/关闭 | 无孤儿进程、无端口泄漏、DB 无脏数据 |

---

## 11. 已知风险与技术债

1. **Camoufox 曾停更约一年**（2026 年恢复活跃），单维护者项目。缓解：锁版本、把 `EngineAdapter` 做成薄适配层、保留 Patchright 兜底。
2. **`playwright-core < 1.63` 是硬约束**，未来升级需等 Camoufox 跟进，用 `overrides` 钉住避免被动破坏。
3. **Intel Mac 上的构建可用性**需在 M0 实测确认（下载对应 darwin-x64 build）。
4. **并发内存**：8 个 Camoufox 约 2–2.8 GB，需在真实机器上标定默认并发数。
5. 不做"绝对防关联"承诺——检测是持续对抗，自检报告只能证明"配置自洽"，不能证明"平台一定不识别"。

---

## 11. M0 实测结论（2026-11-19）

在 macOS 13 / Intel x64、Camoufox 0.5.9 + v158.0.1-beta.41 上实测，以下结论**修正或补充**了前文设计：

### 11.1 指纹固化的正确做法

`Camoufox({ preset })` **对持久化启动无效**——`preset` 只属于 `NewContextOptions`。
持久化场景的身份藏在启动环境变量里：

```
launchOptions({ os, ... }) → env.CAMOU_CONFIG_1 (JSON)
```

正确流程：

1. 首次创建环境时调用 `launchOptions()`，取 `env.CAMOU_CONFIG_1` 解析后落库
2. 之后每次启动把它作为 `config` 传给 `Camoufox({ config })`
3. `LaunchSpec` 需增加 `frozenConfig: Record<string, unknown>` 字段

实测：固化后 3 次启动的 UA、platform、屏幕、GPU、语言**完全一致**。

### 11.2 Canvas 的硬约束

身份 OS ≠ 宿主 OS 时，Camoufox 自动开启 canvas 噪声，**每次启动 canvas 哈希都变**。
这不是 bug，是隐私强化特性，但它本身会成为跨会话的异常信号。

结论：**身份 OS 必须等于宿主 OS**。Linux 服务器就出 Linux 身份，macOS 就出 macOS 身份。
这也解释了为什么 PRD 里"操作系统身份"应默认为宿主系统且不建议用户改。

### 11.3 geoip 不能用于固化

`geoip: true` 会在每次启动随机挑选出口地区的语言（实测同一 HK 出口出现 `en-HK`/`yue-HK`/`zh-HK`）。
因此时区与语言**必须由 FoxBox 自己按代理国家映射后写进 config**，geoip 只作为兜底。

### 11.4 环境与平台问题

| 问题 | 结论 |
|---|---|
| Firefox 内容沙箱 | 受限环境需 `MOZ_DISABLE_CONTENT_SANDBOX=1`，否则 `sandbox initialization failed` |
| 官方 GitHub 仓库 | 维护者账号被暂停，改为归档仓库 `jo-inc/camofox-browser` |
| `launchOptions({os:'macos'})` 卡住 | **不是字体枚举**：同 OS 身份要拉一个真实 Firefox 采样宿主渲染（GPU/canvas），沙箱里没关内容沙箱就会挂死。M1 已修正此结论 |
| `CAMOU_CONFIG` 大小 | 单条环境变量 32767 字符上限，但引擎会**自动分块**为 `CAMOU_CONFIG_1..N`（macOS 身份约 39KB / 2 块），拼接后才是完整 JSON |
| 冷进程启动耗时 | `launchOptions` 冷进程 28 秒（宿主渲染采样），同进程内缓存后降到 80ms。M1 用**启动预热**解决 |

### 11.5 身份生成的两条路径（M1 新增）

| 传入参数 | 引擎行为 | 耗时 |
|---|---|---|
| 什么都不传 | fpgen 贝叶斯网络生成全新身份 | 慢，且每次不同 |
| `fingerprint` | 跳过 fpgen 生成，直接用给定身份 | **跳过生成** |
| `config` | 仍会先跑一遍生成，再用 config 覆盖同名键 | 仍慢 |

所以启动时必须**同时**传 `config`（保证逐字段精确）和 `fingerprint`（跳过生成）。
只传 `config` 会白付 28 秒，这是 M1 的实现要点。

---

## 12. 后续演进

- 环境模板：按目标站点预置推荐参数组合
- 窗口同步、批量脚本编排
- Windows 打包与签名

> **引擎决策（2026-11-19）**：只做 Camoufox（Firefox）单一引擎，不引入 Chromium。
>
> 理由：开源世界里 C++ 层改指纹的现成方案只有 Camoufox；Chrome 侧要么是 JS 注入
> （可被 `Function.prototype.toString` / UA-CH 交叉验出），要么是自编译 Chromium
> （跟版维护成本极高），要么是 GPL-3.0 内核（闭源商业化受限）。
> 引擎抽象层保留 `EngineKind` 与 `cdpEndpoint?` 字段，将来要加不需要改业务代码。

---

## 13. M1 实现说明（2026-11-19）

### 13.1 实际落地的模块结构

第 4 节画的是含 Electron 的完整形态，M1 只实现内核层，实际如下：

```
src/
├── core/
│   ├── app.ts                    # 组装根（依赖注入，便于测试换 FOXBOX_HOME）
│   ├── paths.ts                  # FOXBOX_HOME 布局 + 宿主 OS 探测
│   ├── db/{index,ids}.ts         # node:sqlite 薄封装 + ULID
│   ├── db/schema.sql             # DDL
│   ├── crypto/secret-box.ts      # 代理密码 AES-256-GCM
│   ├── repositories/             # profile / proxy / launch / audit
│   ├── services/profile.service.ts
│   └── engines/{types,manager,camoufox.adapter,warmup}.ts
├── fingerprint/{preset,validator,freeze}.ts
├── api/server.ts                 # fastify + Bearer token
├── main.ts                       # 服务入口
└── shared/types.ts
```

### 13.2 三个与设计不同的决定

**1. 用 `node:sqlite` 而不是 `better-sqlite3`。**
Node 22 内置，零原生依赖。`better-sqlite3` 在 Intel Mac / 受限环境要跑 node-gyp，
装不上就整条链断掉。代价是要接受 experimental 警告，因此把它封在 `core/db/index.ts`
的 `Db` 接口后面，将来要换驱动只改一个文件。

**2. 指纹固化存三份，不是一份。**

| 列 | 内容 | 用途 |
|---|---|---|
| `config_json` | CAMOU_CONFIG 合并后的对象（约 39KB） | 传给引擎，保证逐字段精确 |
| `engine_fp_json` | 引擎原生 fingerprint（4 个键） | 传给引擎，**跳过身份生成** |
| `preset_json` | 可读身份描述 | 校验、展示、自检比对基准 |

只传 `config` 时引擎仍会跑一遍生成（28 秒），再拿 config 覆盖；同时传 `fingerprint`
才会走"用户自定义身份"分支，完全跳过生成。

**3. 预热是启动性能的关键，不是优化项。**
冷进程第一次 `launchOptions` 要 28–40 秒，因为同 OS 身份需要拉一个真实 Firefox
采样宿主渲染。结果缓存在进程内，之后 80ms。所以 `main.ts` 先 `listen` 再
`warmUpEngine()`，用户感知的"打开环境"耗时从 30 秒降到 3–5 秒。

### 13.3 校验规则的修正

`R6`（GPU 与 OS 自洽）从"正向白名单"改成"反向黑名单"。
原因：宿主机是 Intel 核显时，macOS 身份会被引擎对齐成
`Intel(R) HD Graphics 400, or similar`——这是真 Mac 会报的字符串，但不在
`Apple|Intel Inc.` 白名单里，误判为 error 直接阻断了创建。
现在只拦绝不可能共存的组合（macOS 上出现 `ANGLE/D3D11`、Windows 上出现 `Apple GPU`），
可疑但可能的降级为 warn。

### 13.4 自检不比对 `dpr`

`CAMOU_CONFIG` 没有 `devicePixelRatio` 键，dpr 由宿主显示器决定：
headless 恒为 1，有头且接 Retina 才是 2。硬比对只会制造假报警，
所以 `probe()` 的严格比对项是 UA、语言、时区、屏幕宽高与色深、WebGL，
dpr 仅作为 `observed` 展示。这是引擎的能力边界，写在这里避免以后有人"修"它。

### 13.5 M1 遗留

- ~~代理只做了存储与解密，预检没做~~ → M2 已补
- ~~无分组、无环境列表分页~~ → M2 已补
- `launch.repo.closeDangling()` 已实现但只有 `reconcile()` 在用，UI 侧"是否接管"的交互待做
- 孤儿回收是"直接 SIGTERM"，没有等宽限期再 SIGKILL 的两段式

---

## 14. M2 实现说明（2026-11-19）

### 14.1 新增模块

```
src/core/
├── net/
│   ├── socket-reader.ts        # 带缓冲的 socket 读取（读满 N 字节 / 读到分隔符）
│   ├── tunnel.ts               # CONNECT / SOCKS5 握手 + TLS 升级
│   ├── http1.ts                # 手写 HTTP/1.1 GET + 响应解析（含 chunked）
│   └── ip-probe.ts             # 三级探测端点 + 国家码归一化
├── services/proxy.service.ts   # 预检编排、国家推断、启动前健康检查
├── services/group.service.ts   # 分组
├── repositories/group.repo.ts
├── errors.ts                   # 带 HTTP 语义的业务错误
└── db/index.ts                 # 增加迁移机制（user_version）
```

### 14.2 国家推断的优先级

`ProxyService.resolveCountry()` 的顺序是刻意的：

1. **近期实测**（15 分钟内成功过）→ 用 `last_check_country`
2. **申报值** → 用 `expected_country`，同时 warn「预检过期/未做」
3. **现场探测** → 两者都没有时真跑一次预检

近期实测排第一，因为站点看到的是出口 IP 的物理位置，不是用户以为的位置。
实测与申报不一致时**不阻断**，只 warn 并按实测生成指纹——阻断会让用户卡在
"我明明填对了"的扯皮里，而指纹跟真实出口对齐才是有效的。

### 14.3 启动前健康检查

`start()` 里的策略：只在「没有 15 分钟内的成功记录」时才真的发请求。

- 有近期成功记录 → 直接启动，不增加任何网络耗时（热路径 0ms）
- 否则 → 预检一次（超时 6s）；失败抛 `ProxyUnhealthyError`，HTTP 层返回 502 且带 `check` 明细

取舍：代理刚挂的瞬间（成功记录还新鲜）仍会放行，此时表现为"窗口能开、网页打不开"。
这是为了保住热路径速度，已经写进已知风险。

### 14.4 数据库迁移

`schema.sql` 只负责「建出全量最新结构」（全是 `IF NOT EXISTS`），
老库靠 `db/index.ts` 里的 `MIGRATIONS` 补：

- 版本号用 `PRAGMA user_version`，每条迁移写完即 `user_version = N`
- 迁移**必须幂等**：先查 `pragma_table_info` 再 `ALTER TABLE ADD COLUMN`
- `schema.sql` 末尾**不能**再写 `PRAGMA user_version = 1`，否则每次启动都会把版本号打回 1

实测：M1 时期建的库（v1，无 `last_check_country` 等 4 列）→ 打开后自动升到 v2，原数据完整。

### 14.5 不可变字段的边界

`PATCH /profiles/:id` 只接受 `name / note / groupId / startupUrl / headless`。
`os / preset / config / proxyId` 一律不可改——它们共同决定"这个环境在站点眼里是谁"。
改代理 = 换出口 = 指纹必须重建，所以正确动作是新建环境而不是改绑。
这条限制写在 repo 的注释里，避免以后有人顺手加个 `proxyId` 字段。

### 14.6 一个差点漏掉的死循环（值得记住）

`SocketReader` 的第一版这么写：

```ts
// 错误写法
private async awaitMore(deadline, what) {
  if (this.buffer.length > 0) return;   // ← 有数据就直接返回
  await this.waitSignal(deadline, what);
}
async readExactly(n, deadline, what) {
  while (this.buffer.length < n) await this.awaitMore(deadline, what);
}
```

当响应被 TCP 拆成两段、第一段已到但不足 n 字节时，`awaitMore` 立刻返回，
`while` 条件仍成立，于是变成**微任务空转**：不推进、不让出事件循环，
`setTimeout` 永远不触发，进程 100% CPU 卡死且没有任何报错。

它的恶劣之处在于**只在大包被拆开时触发**：走 HTTP 代理时响应常常一次到齐，
测试全过；换成 SOCKS5 后 MTU 不同、包被拆开，立刻挂死——两次都是跑到一半凭空不动。

正确做法是用**序号**判断"有没有新数据"，而不是"缓冲区是否非空"：

```ts
const seq = this.sequence;            // 每次 data/end/error 自增
await waitForEvent(deadline);
if (this.sequence === seq) throw new Error(`${what} 超时`);
```

修改后同样场景 1.5 秒返回，M2 全部 15 项在 29 秒内跑完。

### 14.7 M2 遗留

- 预检依赖第三方 IP 服务（三个端点冗余），无本地 GeoIP 库
- 代理没有「按地区分组/轮换」概念，也没有延迟历史曲线
- 分组只支持单层，没有嵌套
- 批量预检是串行的，代理数量上百时会慢（可改并发 3–5，需要先加限流）

---

## 15. M5 实现说明（2026-11-20）

### 15.1 为什么自己写 cron，而不是引 node-cron

需要的能力只有两件：**算下一次触发时刻**、**把表达式说成人话**。现成的调度库通常还带
`setInterval` 自循环、任务注册表、时区库，以及"注册即运行"的隐式行为——这些在这里全是负债：
我们的规则存在 SQLite 里、由统一的 tick 驱动、必须能在进程重启后重算。

于是 `src/core/automation/cron.ts` 只做纯函数，不碰数据库、不起定时器：

```ts
parseCron(expr): CronSpec
nextRunAt(spec, from): number | null
nextRuns(spec, from, n): number[]
describeCron(spec): string
```

支持 `*` / `a-b` / 步长 / 逗号列表 / 月与星期的英文缩写 / `@daily` 这类别名；
日与周的联合语义按 Vixie cron 取**并集**（两个字段都被限定时是"或"，不是"且"）——
这个语义反直觉，但改成交集会让从别处抄来的表达式静默变味。

**next-run 算法不逐分钟扫**，而是逐字段跳：月不匹配跳到下月 1 号、日不匹配跳到明天零点、
时不匹配跳到下一个整点。这样 `0 0 29 2 *`（闰日）也只要一千多次迭代，5 年上界内必然收敛。
算不出来时返回 `null`，录入阶段直接拒绝（`0 0 30 2 *` 是笔误，不是需求）。

### 15.2 调度器：一次 tick，而不是每条规则一个定时器

```
setInterval(20s) → due(now) → 逐条 fire() → 回写 next_run_at
```

三个理由：

1. **可注入时间**。`tick(now)` 的 `now` 是参数，验收脚本不用真等一分钟。
   如果每条规则各有一个 `setTimeout`，这个测试点就没了。
2. **规则多了不炸**。N 条规则只有一次 `SELECT ... WHERE enabled=1 AND next_run_at <= ?`。
3. **重启后语义统一**。`next_run_at` 落库，重启只做一次 `resync()`，不需要重建任何定时器。

`tick` 里用 `ticking` 标志挡住重入：浏览器启动要几十秒，一次 tick 可能比心跳间隔还长，
不挡的话下个心跳会叠上来。`timer.unref()` 保证这个心跳不会拖着进程不让退出。

### 15.3 三个语义决定

| 决定 | 反面是什么 | 为什么这么选 |
|---|---|---|
| **不补跑** | 开机后把错过的 12 次一次补上 | 同一批环境会在几分钟内被反复启停，比"少跑一次"糟得多 |
| **心跳不落历史** | 每 10 分钟写一行"巡检正常" | 历史里全是正常记录，真正那次切换被埋在第 200 行 |
| **到点不 await 任务** | tick 等任务跑完再处理下一条 | 一条任务几十秒到几分钟，后面的规则全被堵住 |

第三条的代价是"触发成功"和"任务成功"是两件事：`automation_runs` 先落一条
「已启动任务」，任务结束后由回调把同一行改成最终结果（`N 个目标：成功 x，失败 y`）。
所以这一行的 `status` 在读的时候才代表真实结局。

### 15.4 事件钩子：边沿触发，不是电平触发

判断"代理失效"有两种写法：

- 电平式：`当前 check 失败` → 每个巡检周期都成立 → 每个周期都触发一次动作
- 边沿式：`fail_streak 刚跨过阈值` → 一次故障只触发一次

用的是后者：

```ts
const before = proxy.failStreak;                       // 巡检前
const after  = proxies.summaryOrThrow(id).failStreak;  // 巡检后
if (!result.ok && after >= threshold && before < threshold) → 触发
```

副作用是"两条规则盯同一个代理时，一次故障只会有一条触发"——这是可接受的：
真要两条都动，说明动作设计有问题。恢复同理（`result.ok && before >= threshold`），
恢复也记一条，否则用户只看到"某天切走了"，看不到"什么时候切回来"。

### 15.5 切换代理的指纹一致性守卫

`switch_proxy` 不是无条件的 `UPDATE profiles SET proxy_id`。

指纹里的 `timezone` / `locale` 是建环境时按当时的出口国家固化的。换到另一个国家，
环境就变成"IP 在美国、时区在 Asia/Hong_Kong"，这比代理挂掉更难解释，而且通常要等到
站点风控才暴露。所以：

- 默认 `sameCountryOnly: true`，比对两侧的 `lastCheckCountry ?? expectedCountry`
- 任一侧没有国家信息 → 不动
- 拒绝时**把原因写进记录**（「(HK) 与备用代理 (US) 国家不同，切换会破坏指纹一致性，未切换」）

为此在 `ProfileService` 上开了一条专用通道 `rebindProxy(id, proxyId, reason)`：
普通 `update()` 仍然不接受 `proxyId`（改了就是换身份），这条通道要求调用方已确认同国家前提，
并把 `reason` 写进审计。环境正在运行时直接拒绝。

### 15.6 数据模型

```sql
automations(id, name, kind, spec_json, actions_json, enabled,
            next_run_at, last_run_at, last_status, last_error, run_count, created_at)
automation_runs(id, automation_id→automations ON DELETE CASCADE,
                trigger, status, detail, task_id, started_at, ended_at)
```

`next_run_at` 是"下次该醒来的时刻"，调度器只按它排序，不重新解析表达式——
解析只在录入、改表达式、重启重排这三处发生。

### 15.7 桌面壳：两条路，共用一份代码

| 方式 | 命令 | 依赖 | 用途 |
|---|---|---|---|
| `--app` 窗口 | `npm run app` | 本机 Chrome/Edge/Brave | 日常用，改完即生效 |
| Tauri 原生壳 | `npm run desktop:build` | Rust ≥ 1.77 + 本机 node | 分发成 .app / .dmg |

`desktop/src-tauri/src/main.rs` 约三百五十行，做四件事：分空闲端口 → 起 `dist/main.js` →
等端口可连通 → 把窗口从启动页导航到本地地址。

关键取舍：

- **不内嵌 Node**。塞 node 二进制要多几十兆且每次升级都要重打包；改用本机 node，
  找不到就在启动页上直说，而不是给一个白屏
- **窗口先显示启动页**。反过来的话，后端起不来就是一个无响应窗口，用户只会以为程序卡死；
  现在失败原因通过 `window.foxboxFail()` 直接写在启动页上
- **退出走 SIGTERM**。直接 kill 会留下 Firefox 残留和下次启动 70 秒的卡顿（M3 踩过）

### 15.7.1 找 node：存在 ≠ 可用

第一版 `find_node()` 只判 `is_file()`，第一个命中就返回。真实机器上这个假设立刻破产：

- 从 Finder 启动时 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，Homebrew / nvm 都不在里面
- 找到的 node 可能太老（本机 nvm 里只有 v20.12.2，没有 `node:sqlite`），
  它会"成功启动然后立刻退出"，看起来像端口问题
- 也可能是别的运行时留下的 shim，根本不是 node

所以改成：收集全部候选（`FOXBOX_NODE` → PATH → 常见安装路径 → nvm/volta 的版本目录倒序），
**逐个真跑 `node -v`**，取第一个 ≥ 22.15 的；跑不起来的直接跳过，太老的记进清单，
最后一起写进错误信息：

```
找不到可用的 node。找到的都不够新（需要 22.15 或更高）：
/Users/xx/.nvm/versions/node/v20.12.2/bin/node → v20.12
```

诊断一次版本失败的成本，比让用户对着"60 秒没有就绪"猜半天低得多。

### 15.7.2 三个让故障可见的改动

踩到过一次"服务在监听、`/health` 返回 200、但首页和静态资源全 500"的故障，根因是启动器
继承了父进程的 `NODE_OPTIONS=--require <某注入钩子>`。这类问题的可怕之处在于它和启动器
看起来毫无关系，排查会一路跑到 fastify 的 handler 里。三条对策：

| 问题 | 处理 |
|---|---|
| 父进程 `NODE_OPTIONS` 注入钩子污染后端 | 起子进程时 `env_remove("NODE_OPTIONS")` |
| `stdout`/`stderr` 是 `null`，起不来什么都看不见 | 落 `~/.foxbox/desktop-shell.log` |
| 进程秒退，却还老老实实等满 60 秒 | 轮询里 `try_wait()`，退出即报退出码 + 日志末尾 |

启动页的错误框改成 `white-space: pre-line`（日志片段要保留换行），
`fail()` 让页面里的 JS 自己重试最多 5 秒再放弃——窗口刚建好时页面脚本可能还没执行，
直接在 Rust 侧 eval 会打在空气里，用户看到一个永远转圈的启动页。

壳自己的就绪/失败也写进同一个日志：

```
[壳] 后端就绪（node /…/node/v22.22.2/bin/node），导航到 http://127.0.0.1:53978/
```

于是"窗口停在启动页"这件事有了唯一答案来源：翻一个文件就知道是 node 没找到、
后端崩了、还是导航失败。

`npm run build` 用 `tsc -p tsconfig.build.json` 出 `dist/`：源码里所有相对导入都写成
`./x.ts`（`tsx` 直接跑需要），编译时靠 `rewriteRelativeImportExtensions` 改写成 `./x.js`，
不引打包器。`schema.sql` 按 `__dirname` 读取，所以构建脚本单独拷一份到 `dist/core/db/`；
`ui/` 不用拷——`dist/api` 与 `src/api` 同层，`../../ui` 恰好还指向项目根的 `ui/`。

### 15.8 M5 限制

- 规则不支持失败重试；失败就是失败，等下一个周期
- 不支持"工作日/节假日"这类日历语义，只有 cron 本身
- 巡检是串行 check，代理上百条时会超过间隔（当前按本地小规模设计）
- Tauri 壳未内嵌 node，用户机器需要 Node ≥ 22.15

### 15.9 启动为什么必须是幂等的

`start()` 原本只挡一种情况：`manager.isRunning(id)` 为真。但"正在启动"这段时间里，
环境还没登记成 running——于是第二次点击被当成一次全新启动，两个
`launchPersistentContext` 抢同一个 `user-data-dir`，先到的那个被挤掉，报
`Target page, context or browser has been closed`。

这类错误最坑的地方是它**偶发**：慢慢点一次就成功，手快就失败，用户会归因成"软件不稳定"。

处理方式是给 `ProfileService` 加一张在途表：

```ts
private readonly inflight = new Map<string, Promise<StartResult>>();

async start(id) {
  const existing = this.inflight.get(id);
  if (existing) { audit.log('profile.start.dedup', id, {...}); return existing; }
  let task: Promise<StartResult>;
  task = this.launch(id).finally(() => {
    if (this.inflight.get(id) === task) this.inflight.delete(id);  // 只清自己那份
  });
  this.inflight.set(id, task);
  return task;
}
```

三处细节：

1. **返回同一个 Promise**，而不是抛 409。重复点击是人的正常行为（网速慢、界面没反馈），
   抛错等于把用户的操作判成错误
2. **`finally` 里比对身份再删**，否则并发下会把后一次的条目抹掉，互斥就漏了
3. **`stop()` 先 `await` 在途启动再拆**，否则会拆出"进程已死但状态是 running"的半截现场；
   `shutdown()` 同理（`Promise.allSettled`）

顺带把这类的报错也收敛了：Playwright 的失败信息带几百行浏览器 stderr，界面上的红条
只保留第一句 + 常见原因，完整内容留在审计 `profile.start.failed` 里。判据很朴素——
用户在红条里能读到的应该是"下一步做什么"，而不是一份崩溃日志。

---

## 16. 两个"看起来能用、实际自相矛盾"的问题（2026-11-20）

这两个都是靠任务系统本身的 `eval` + `screenshot` 测出来的：先跑一条采集任务，把
`screen / innerWidth / devicePixelRatio` 打出来，矛盾就在数字里。

### 16.1 屏幕 1920×1200，窗口 1280×720

第一次实测（1280×800 Retina 的本机）：

| 项 | 库里的 preset | 页面实际读到 |
|---|---|---|
| `screen.width/height` | 1920 × 1200 | 1920 × 1200 |
| `window.innerWidth/Height` | 1920 × 1200 | **1280 × 720** |
| `devicePixelRatio` | 2 | **1** |
| 截图 | — | 1280 × 720 |

一条 `innerWidth < screen.width - 200` 就能判定这不是真机：没有哪个真实用户的窗口
永远比屏幕窄 640px，何况每个环境都是这个数。

**根因有两层。**

第一层，窗口尺寸根本没被设定过。Camoufox 的 `spoofsWindowDimensions()` 只在 config 里
出现 `window.innerWidth` 之类的键时才返回真；我们的冻结 config 没有这些键，于是
Playwright 套上了自己的默认视口 1280×720。不是 macOS 压的，是默认值。

第二层，屏幕尺寸是引擎按 OS 随机抽的，不看这台机器。`getRandomPreset('macos')` 抽到
1920×1200，而屏幕只有 1280×800。就算我们把窗口设成 1920，系统也开不出来。

**修法分三步，每步都要按住引擎的"好心修正"。**

1. `src/fingerprint/host-screen.ts`：探测宿主逻辑分辨率。macOS 走
   `system_profiler SPDisplaysDataType`，优先读 `UI Looks like`，没有就把 `Resolution`
   的物理像素除以 dpr。**必须用绝对路径 `/usr/sbin/system_profiler`**——桌面壳拉起的
   node 是精简 PATH（`/usr/bin:/bin`），靠 PATH 查会 ENOENT，然后静默返回 null，
   整条夹取逻辑失效，而表面看一切正常（第一版就是这么翻车的）。
2. 冻结身份时把 `fingerprint.screen` 按宿主收缩（只缩不放：屏幕比宿主大时保留多样性）。
   改 fingerprint 而不是改 config，因为 config 是由 fingerprint 派生的。
3. 引擎还有两道"修正"会把它改回去：`raiseScreenToModernFloor` 把宽度低于 1366 的屏幕
   抬到 1366（现代设备下限），`clampScreenToDisplay` 再把 headful 的屏幕夹到显示器。
   两者都在 `if (!userSetScreenWindow)` 里——只要 config 里出现 `screen.*` / `window.*`
   键，整段就跳过。所以收缩过的身份会额外传一份 `screenWindowConfig(fingerprint)`，
   把屏幕、视口、`outerHeight = innerHeight + 85`（窗口 chrome）一次写死。

启动侧再补一刀：`CamoufoxAdapter.viewportFor()` 把 Playwright 的 viewport 显式设成
preset 的窗口尺寸，并再次夹到宿主能装下的范围（老环境库里的 1920×1200 不会把窗口撑爆）。

修复后同一台机器：

```
screen 1280×800  avail 1280×724  inner 1264×689  outer 1264×775  dpr 2  screenX/Y 0/25
视口截图 2528×1378（= 1264×689 × 2）
```

全部自洽，且 `dpr` 自动变成 2——屏幕报的是真实尺寸时，引擎自己算出的像素比也就是对的。

顺带修掉一个错：`innerHeight` 原本写成 `height - 120 * dpr`，Retina 上等于扣掉 240pt，
窗口凭空矮掉四分之一屏。窗口 chrome 是逻辑像素，与 dpr 无关。

### 16.2 没配代理，却走了系统代理

现象：三个任务全部在 `goto` 就失败，报 `NS_ERROR_PROXY_CONNECTION_REFUSED`；
同一台机器上 `curl https://example.com` 却是 200。

原因：Firefox 默认 `network.proxy.type = 5`（跟随系统代理），而 Camoufox 只在传了
`proxy` 时才接管代理设置。环境没配代理时它什么都不设，浏览器就去连 macOS 系统代理
（这台机器上是 ClashX 的 7890）。ClashX 在监听、CONNECT 也建立了，但它到目标的
TLS 握手失败——于是"浏览器打不开网、终端能上网"。

这类问题最难查的地方是它看起来像指纹问题或目标站点问题，实际与两者都无关。

修法：在 `buildOptions()` 里，无代理时显式写 `firefox_user_prefs: { 'network.proxy.type': 0 }`。
语义上也更对——AdsPower 一类产品的约定是"环境没代理 = 用本机 IP 直连"，
跟随系统代理会让同一份配置在不同机器上表现不同，那是不可复现的。

### 16.3 怎么复现这两条验证

```bash
npx tsx scripts/live-task.ts --keep   # 采集 + 全页截图 + 视口截图 + 故意失败
```

脚本的验收项里有「采到 10 条」「变量回填可跨步使用」「全页截图落盘」「坏脚本按失败处理」，
6/6 通过才算这条链路是通的。

## 17. M6 – M9 实现说明（2026-11-20）

### 17.1 数据落地（M6）

**`collect` 只是一个"结果去哪不同"的 `eval`**。脚本语法完全一样，都不引入选择器 DSL：
`eval` 把返回值留在任务 JSON 里，`collect` 要求返回数组并写进 `dataset_rows`。

去重键 `dedupe_key = sha256(canonicalJson(payload)).slice(0, 32)`，`canonicalJson` 递归排序 key ——
否则同一个对象换个 key 顺序就是两个哈希，去重形同虚设。

`ON CONFLICT DO UPDATE` 里**故意不更新 `first_seen_at`**：它是"这条数据第一次出现"的事实，
被覆盖掉之后「本周新增多少」就永远算不出来了。`seen_count` 每次 +1，用来区分"一直在"和"刚出现"。

上限（2000 行 / 单行 8KB / 整批 4MB）**先校验后写库**，超限直接失败、库里零变化。
不截断是有意的：静默截断会让人拿着半份数据做决定，比报错危险得多。
0 行不算失败（周末的定时任务不该因为"今天没单"变红），要严格就写 `expectMinRows`。

`dataset_rows.first_task_id` 没有外键、删任务不删数据：
任务历史是**证据**（30/90 天可过期），数据是**资产**（只随数据集删除）。

### 17.2 会话巡检（M7）

三态 `alive / expired / unknown`，判定顺序写死在 `checkOne` 里：

```
goto 失败           → unknown     （打不开 ≠ 掉登录）
落地异域且非登录域   → unknown
响应 5xx            → unknown     （站点自己故障）
规则命中             → alive
其余                 → expired
```

顺序反过来（先判页面内容）的后果是：代理一挂，50 个环境全红，用户挨个重登发现都是好的，
然后这个功能就再也没人看了。`unknown` 是这个功能能不能被信任的核心。

已运行的环境开 **一次性标签页**（`EngineAdapter.newPage`），用完关掉：
不动用户正在看的页面，不抢焦点，也不占用任务复用的那个 page。

巡检起的浏览器不算「用户打开过」：`start(id, { reason: 'session' })` 不写 `last_opened_at`，
审计记 `session.start` / `session.check`，不混进 `profile.start`。

告警走**边沿触发**：只有 `previous !== 'expired' && current === 'expired'` 才发事件。
连续 5 次 expired 只发 1 条；alive→expired→alive→expired 才发 2 条。

### 17.3 可靠性（M8）

错误分类是三档而不是两档：`timeout` 单独成类。两者都值得重试，但意义上完全不同——
"目标太慢"能靠调大超时或换时段解决，"连上了又断"不能。

**永久错误优先匹配**：`脚本执行超时` 必须被 permanent 规则先吃掉，
否则会被 `超时` 规则捞走，然后被无意义地重试三次。

只重跑失败的那个目标（`while (run.status === 'failed' && attempt < task.retries && isTransient(run))`）：
并发跑 50 个环境时，1 个失败就全部重来是双倍浪费，还会把 `seen_count` 刷虚。

通知聚合按 `event` 分桶、窗口内按 `dedupeKey` 去重，重复触发**落一条 `suppressed`**。
不留痕的话，「为什么我只收到一条」永远说不清。
投递失败只落 `notification_logs` + 审计，绝不抛错——通知发不出去是次要故障，
不该让巡检跟着挂。4xx 不重试（地址/密钥写错，重试一万次也一样）。

### 17.4 身份健康（M9）

**先验证再承诺**：`npm run m9:repair` 对比两条路径的逐键 diff，结论是
「改 `fingerprint.screen` 会让 `mediaDevices` / `locale` / `timezone` 等 11 个键跟着重抽」，
所以**不提供 repair**，只做标记。

自检只在 `reason === 'manual'` 时跑：任务与巡检是批量的，多出来的 1–2 秒纯属浪费，
它们也不看这个标记。自检失败不覆盖上一次的结论——"检测失败"和"身份不一致"是两件事。

`health` 的空数组与 `null` 是两种状态：前者是"检查过且一致"，后者是"没检查过"。
混成一个字段的话，列表上永远分不清"没问题"和"没看过"。

窗口尺寸必须一起采（`window.innerWidth` 等）：只比 `screen` 看不出来"报 1920 但窗口只有 1280"
这类最典型的不一致——而这正是换过显示器的老环境的症状。

跨平台解析全部拆成纯函数（`parseSystemProfiler` / `parseXrandr` / `parseWindowsBounds`）：
真机上没法来回换显示器，只能靠样本注入验证"主屏识别""Retina 除 2""取带 * 的模式"这些易错点。

### 17.5 界面验收（`npm run ui-smoke`）

接口测与类型检查都盖不住三类问题，只有截图能看见：CSS 塌版、按钮被裁到视口外、空态误报。

做法是用**自家引擎**开一个 headless 环境去访问 `127.0.0.1` 上的工作台——渲染的就是用户
看到的那一份页面，不需要再装一套 Chromium，也就不会出现"测试浏览器和生产浏览器不一样"。
注意首页不能带 `?t=`：`isUiAsset` 只认精确的 `/`，带查询串会被当成 API 走 Bearer 鉴权（401）。

这轮截图抓出来的三个真问题：

- **任务弹窗 520px 装不下步骤行**，右侧删除按钮只露一条边。加了 `.modal.wide`（840px），
  任务编辑器显式要宽版；`.step-fields .control` 补 `min-width: 0`，否则 flex 子项的固有宽度
  会把整行顶出容器（`min-width: auto` 是 flex 的经典陷阱）。
- **弹窗底部按钮被顶到折叠线以下**。`.modal` 只有 `max-height: 90vh; overflow: auto`，
  内容一长主按钮就看不见了。给 `.modal-foot` 加 `position: sticky; bottom: 0` +
  不透明背景，内容再长也能直接点保存。
- **切到「数据」页会先闪一帧「还没有数据」**。原因有两个：`view` 分支漏了 `datasets`
  （只等 4 秒轮询），以及空态用 `state.loading` 判定——silent 加载时它始终是 false。
  补 `state.datasetsLoaded` 标记，并把 `datasets` 加进切换时的主动加载列表。

冒烟脚本还会**真跑一条带截图的任务**（start → goto → screenshot → stop，打本地假站点），
然后用 `page.evaluate` 量缩略图的实际渲染尺寸：

```
naturalW 1264  naturalH 609   clientW 328  clientH 158   容器宽 894
```

这一步有两个坑值得记：

- **任务会复用界面的页面句柄**。冒烟脚本用环境 A 打开工作台，就不能让任务跑在 A 上——
  任务的 `goto` 会把工作台本身导航走，之后所有选择器都找不到（现象是 30 秒超时）。
  任务要打另一个环境。
- **缩略图必须同时限宽和限高**。只写 `max-width:100%` 时，dpr=1 的截图正好等于容器宽，
  一张 894px 宽的预览就把任务卡片撑得很长；dpr=2 时更糟。现在 `max-height:160px` +
  `object-fit:contain`，点开外层链接看原图。

另外记一条引擎层的死代码（已删）：`viewport` 传给 `Camoufox({ from_options })` 是无效的，
详见 RUNBOOK「坑二」。

---

## 18. M10 外部自动化（2026-11-21）

### 18.1 需求与硬限制

需求是「外部能拿到 CDP 链接并执行采集脚本」。检查下来第一半在本引擎上不成立，
而且有两个独立的原因，缺一都不行：

1. **协议**：Camoufox 是 Firefox，走 Juggler，没有 CDP。Chromium 才有那一套。
2. **上下文**：`camoufox/dist/server.d.ts` 明写 —— `launchServer()` 走
   `BrowserType.launch()`，`PlaywrightServer` 只接受一个刚启动的 Browser，
   **无法把 persistent BrowserContext 挂成 ws 端点**。我们的环境全是 persistent
   （身份要靠 `user_data_dir` 跨会话保持）。

所以不存在「换个参数就能给出 ws 链接」的做法。三条看起来可行的替代：

| 方案 | 为什么不行 |
|---|---|
| `Camoufox.launchServer()` | 拒绝 persistent context；改成非持久化等于把环境身份丢了 |
| 自己起一个 ws 代理转 Juggler | 等于重写 Playwright 协议层，成本远超收益 |
| geckodriver + WebDriver BiDi | 要额外二进制，且 Camoufox 的 juggler 补丁与 Firefox 原生 remote agent 不保证共存 |

结论：**不提供伪 CDP**。给 `cdp: null` 的同时把原因写进响应，比让人对着空字段猜要好。

### 18.2 实际交付

| 接口 | 作用 |
|---|---|
| `GET /api/profiles/:id/automation` | 引擎、运行态、`transport: 'http-script'`、`cdp: null` + `cdpReason`、带 token 的 curl/Python/Node 片段 |
| `POST /api/profiles/:id/run-script` | 在那个环境里执行脚本，回传 JSON |

`run-script` 的两种模式差别是「脚本在哪一层执行」：

- `page`：`page.evaluate(script)`。脚本是页面上下文里的表达式，能读 DOM/window，
  **不能导航或点击**（它不在 Node 侧）。
- `playwright`：`new Function('page', 'ctx', 'return (async () => {' + script + '})()')`。
  形参拿到真正的 Playwright Page，能 `goto` / `click` / `fill` / `$$eval`。
  采集脚本用这个模式。

细节上几个刻意的选择：

- **脚本报错不让接口 500**。业务上「脚本写错了」是可预期的，返回 422 + `ok:false` +
  错误文案；鉴权/参数错误仍走统一错误处理器。语法错误在 `new Function` 阶段就拦下，
  文案是「脚本语法错误：…」。
- **超时用 `Promise.race` 而不是依赖 Playwright 自己的 timeout**。脚本里可能是一段
  纯 Node 的 `await`（不经过浏览器），Playwright 的 timeout 管不到；接口层自己掐，
  默认 30s、上限 300s。
- **默认自动启动环境**（`autoStart` 默认 true）。外部调用方不该先查状态再决定要不要
  先启动；启动耗时通过 `launchMs` 单独回传，让调用方知道这 6 秒花在哪。显式
  `autoStart:false` 时未运行直接 409，避免脚本在错的环境上静默执行。
- **脚本正文不进审计**。里面可能有账号、接口参数；审计只记 `mode` / `elapsedMs` /
  `bytes` / 结果。截图落在 `screenshots/automation/`，走既有 `/files` 路由（token 从
  查询参数取），与任务截图同一条通道。
- **换行**：`new Function` 拼接时在脚本前后各加一个换行。脚本以 `//` 注释结尾时，
  不加换行会把闭合花括号注释掉，报错信息还指向用户根本看不到的那一行。

### 18.3 界面

环境详情多了「自动化」标签页：一句「没有 CDP 链接」+ 原因、端点、curl、Python、
两种模式的说明、一个「试跑（读当前页标题）」按钮。试跑存在的意义是自证链路——
它走的是同一个 `run-script`，成功就说明地址、token、环境都对。

### 18.4 验收

`npm run m10`，10 项：连接信息如实、示例带 token、playwright 采集 6 行订单、
截图落盘、page 模式读 DOM、语法错误 422、超时 422、未运行 + autoStart:false 409、
默认自动启动回传 launchMs、审计不含正文。

### 18.5 参考：B 站采集

`scripts/payloads/bilibili.js`（环境内执行）+ `scripts/bilibili-collect.ts`（外部客户端）
是一份可直接照抄的模板。要点：

- payload 只依赖 `page`，参数从注入的 `P` 取，所以同一份脚本既能被客户端调用，
  也能原样粘进 curl / 界面的试跑框。
- 三种数据源统一归一化成一个记录形状（`bvid/title/author/views/likes/coins/...`），
  缺的字段给 `null` 而不是省略——下游拼表时不用判断字段存不存在。
- 风控（`-352/-412`）只做「回首页刷 Cookie + 重试两次」，仍失败就抛错。无限重试会
  把环境 IP 打黑，反而更慢。
- 列表接口（popular/search）只给播放/点赞/收藏/时长，硬币、分享、分P、分辨率、标签
  在 `view` 接口里。所以「要不要详情」做成显式开关（`detail: true`，CLI 是 `--detail`）：
  50 条要多花约 70 秒，不该替所有调用方默认付这笔钱。详情失败只降级成列表字段并记
  `detailError`，不整批失败。

---

## 19. 身份的三个空洞：地理坐标、dpr、canvas 噪声（2026-11-22）

这三项在 MVP2 收尾时都被标记为「已知不足」。补齐过程中最有价值的一条发现是：
**引擎其实一直都支持 dpr 和 canvas 覆盖，只是我们从没传过这两个参数**，
而「dpr 需要改引擎打补丁」是个错误结论。真正没有的只有音频噪声。

### 19.1 地理坐标：从 (0,0) 到出口实测值

原来的 `preset.geolocation` 恒为 `{0,0}`——那是几内亚湾，历史上「没填」的默认值。
`geoip: false`（为了避免 locale/时区每次随机）关掉之后，没有任何环节再回填坐标。

链路上的三处改动：

| 层 | 改动 |
|---|---|
| `core/net/ip-probe.ts` | `ip.sb` 与 `ip-api` 的响应多解析 `latitude/longitude`，Cloudflare trace 不提供坐标 |
| `proxies` 表（v8） | 新增 `last_check_lat / last_check_lon`，`recordCheck` 用 `COALESCE` 写入 |
| `fingerprint/freeze.ts` | 配置里写 `geolocation:latitude / :longitude / :accuracy` |

坐标来源分两级，且**创建时定的只是兜底**：

1. 绑了代理且代理有实测坐标 → 用实测值（`last_check_lat/lon`）；
2. 否则用 `COUNTRY_GEO` 里的国家代表城市（与时区表首项对齐：US→纽约、CA→多伦多）。

启动时还会再对齐一次：`profile.service.start()` 把当前代理的实测坐标注入本次 config，
并回写 `preset_json`。这样「代理换到另一个城市」之后，坐标不会停在创建那天。

**必须同时放行权限**，否则坐标写了也拿不到。Firefox 的 geolocation 默认是「询问」，
无头环境没人点允许，站点收到的是 `PERMISSION_DENIED`——而这个拒绝本身也是个信号
（声称本地住宅 IP，却不给定位）。所以启动参数里加了 `permissions.default.geo = 1`。

两个踩坑：

- **测试必须用真实 origin**。在 `about:blank` 上调 `getCurrentPosition` 必然被拒，
  因为它没有 origin，与配置无关。第一次就栽在这，误以为配置没生效。
- 精度 `accuracy` 随机 20–80m。给 0 或给 1m 都不像真实设备（GPS 不会那么准）。

### 19.2 dpr：引擎支持，只是没传

`camoufox/dist/utils.js` 里，`window.devicePixelRatio` 会转成
`layout.css.devPixelsPerPx`，让浏览器**真的按这个倍率渲染**，并参与一致性检查
（`checkDevicePixelRatio`，mac 只允许 1/2，Windows 允许 1.75/2.5）。
所以「dpr 要改引擎打补丁」不成立。

改动：

- `freeze.ts` 里 `chooseDpr(os, host.dpr)`：取**宿主实测 dpr**，并校验落在该 OS 的
  真实档位（`PLAUSIBLE_DPR`）内，然后写进 config。
- 屏幕/窗口键现在**总是**显式写入（以前只在屏幕被宿主夹取时才写）。只要这些键存在，
  引擎就跳过它自己「把窄屏抬到 1366」的修正，避免 screen 与窗口再次打架。
- 自检里 dpr 从「不比对」变成「可比对」：值现在由 config 决定，不一致就是真漂移。
- 校验规则 R4 改用每系统档位，不再用一个跨系统的大集合（mac 上 1.25 是伪造痕迹）。

实测（同一台机器、同一个环境）：接管前 `devicePixelRatio=1`（预设写 2，自检放过），
接管后 `devicePixelRatio=2`，自检 diff 为空。

### 19.3 canvas：三态开关，不是布尔

引擎的语义分三档，我们照搬：

| 值 | 行为 |
|---|---|
| `null`（默认） | 身份与宿主渲染矛盾时覆盖，能对齐时保留真实像素 |
| `true` | **总是**覆盖：`getImageData` 返回占位随机值（RFP 同款） |
| `false` | 强制不覆盖：会暴露宿主真实渲染，仅排障用 |

注意它不是「给像素加噪声」，而是「把读回的数据整体换掉」，所以同一段绘制两次读数不同。
实测：`true` 两次读数不同（stable=false），`false` 两次完全相同（stable=true）。

存储上必须是三态，不能压成 boolean：字段是 `profiles.canvas_noise INTEGER`
（v9，NULL/1/0），否则「没指定」和「强制关闭」会被混成同一件事。
第一版就是这么写的，结果显式 `false` 被当成 auto，canvas 依旧被覆盖——验收脚本才把它抓出来。

### 19.4 音频噪声：这一版做不了，也不该假装能做

`camoufox/dist/fingerprints.js` 明确写着 `audio:seed is gone`，配置里出现会被删除并告警，
「the browser renders audio as stock Firefox does」。也就是说引擎层没有音频噪声可开。

剩下的路只有 JS 垫片（覆写 `AudioBuffer.getChannelData` 之类），代价是可检测面：
覆写函数在 `Function.prototype.toString` 下不是 native，`instanceof`、属性描述符都可能露。
这类东西应该做在 C++ 补丁里，不该在 JS 层糊。所以界面上如实写「不支持」，而不是放一个
永远为 false 的开关假装有。

### 19.5 验收

`npm run m11`，10 项：dpr 取宿主、接管生效、自检一致、坐标兜底、真实 origin 上取到坐标、
canvas 开=随机、canvas 关=稳定、未指定时保持 null、超宽屏夹取后仍像真机、R9 拦得住 (0,0)。

### 19.6 顺手修掉的：超宽屏夹取

引擎会抽到 3440×1440 这类 21:9 面板，等比缩到 1280 宽就成了 **1280×536** —— 现实中
没有这种屏幕，R4 会告警。收缩之后补一道 `ensurePlausibleScreen()`：宽小于 1024 或
高小于 600 时直接退回宿主尺寸，因为「同一台机器」才是最合理的选择。
