# FoxBox 运行手册（M0 – M5）

> 已知问题、优先级与已修项留档见 [问题台账（ISSUES）](./ISSUES.md)；
> 本手册只讲「怎么跑、怎么排障」。

## 结论（2026-11-19 实测）

M0 已通过。引擎可启动、指纹可读、geoip 对齐生效。
**关键发现：指纹固化必须通过 `launchOptions().env.CAMOU_CONFIG_1` 持久化后经 `config` 传回，
`Camoufox({ preset })` 对持久化启动无效**（`preset` 只属于 `NewContext`）。

## 前置

- Node ≥ 22.15（当前 v22.22.2 ✅）
- 能访问 npm registry 与 GitHub Releases（下载浏览器内核用）

## 一次性准备

```bash
cd foxbox                # 换成你自己的克隆目录
npm install
npx camoufox fetch      # 下载配对的浏览器构建（约 1.2GB）
```

### 已知问题：官方仓库不可用（2026-11）

Camoufox 维护者的 GitHub 账号被暂停，`daijro/camoufox` 与 `camoufox/camoufox` 均返回 404，
`npx camoufox fetch` 会报 `the browser this camoufox release pairs with, is not in official's releases`。

当前可用的绕过方式（本地补丁，**重装依赖后需重做**）：

1. 把下载源指向归档仓库 `jo-inc/camofox-browser`：

   ```bash
   # node_modules/camoufox/dist/data-files/repos.yml 第 9 行附近
   - repo: jo-inc/camofox-browser
     name: Official
   ```

2. `camoufox fetch` 用 Node 原生 fetch，默认**不走** `https_proxy`，需开启 Node 的代理开关：

   ```bash
   export https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890
   export NODE_USE_ENV_PROXY=1
   npx camoufox sync && npx camoufox fetch
   ```

3. 归档版本为 `v158.0.1-beta.41`（与 `camoufox@0.5.9` 配对），共 6 个版本可选。

> 如果哪天官方账号恢复，把 `repos.yml` 改回 `daijro/camoufox, camoufox/camoufox` 即可。


## 跑验证

```bash
# 直连、单次
npm run m0

# 有头模式（能看到窗口，便于目视确认）
npm run m0:headed

# 连续三次，检查指纹是否漂移（对应 PRD F-13）
npm run m0 -- --runs=3

# 带代理，并让时区/语言/WebRTC 自动对齐出口 IP
npm run m0 -- --proxy=http://user:pass@host:8080 --geoip --runs=3

# 指定身份系统（注意：与宿主不同会导致 Canvas 随机化）
npm run m0 -- --os=windows --locale=en-US
```

## 输出怎么看

脚本会打印三段：

1. **页面实际读到的指纹** —— 这是唯一可信的数据源
2. **关键检查** —— 六项硬指标，全「通过」才算 M0 过关
3. **跨会话稳定性** —— `--runs` > 1 时比对多次启动的逐字段差异

## 实测记录

| 场景 | 结果 |
|---|---|
| `--runs=1` 直连 | 通过。UA/WebGL/Canvas 可读，`webdriver=false` |
| `--proxy=... --geoip --runs=2` | 通过。出口 IP `103.151.172.151`（HK），时区 `Asia/Hong_Kong`、语言 `yue-HK` 自动对齐 |
| `--os=windows --freeze=... --runs=3` | **UA/平台/屏幕/GPU/语言全部稳定**，仅 canvasHash 漂移 |
| `--os=macos`（同源身份） | 通过。`MacIntel`、`Apple/Intel GPU`、`colorDepth 30` |
| `--freeze` 且 `--os=macos` | **崩溃**：`launchOptions({os:'macos'})` 卡在系统字体枚举 |
| 不加 `MOZ_DISABLE_CONTENT_SANDBOX=1` | 启动即崩：`sandbox initialization failed: Operation not permitted` |

### 已知约束（写进设计的部分）

1. **配置会被自动分块**：单条环境变量上限 32767 字符，引擎会自动拆成 `CAMOU_CONFIG_1..N`（macOS 身份约 39KB / 2 块）。拼接时必须按序号排序，否则 JSON 解析失败。
2. **Canvas 在跨 OS 身份下每次启动都变**：这是 Camoufox 的隐私噪声机制，不是 bug。同一身份序列（Windows 伪装跑在 macOS 上）每次 launch 的 canvas 哈希不同。
   - 要 canvas 稳定，必须让**身份 OS = 宿主 OS**（实测 macOS 同源身份可跑）
   - 或显式关闭 `canvas_noise`，但 canvas 会暴露宿主渲染特征
3. **`geoip` 会覆盖 locale**：即使传了 `--locale`，geoip 每次仍会从出口地区随机选语言（实测出现 `en-HK` / `yue-HK` / `zh-HK` 三种）。
   - 产品里应**自己按出口国家映射时区+语言**，不依赖 geoip 的随机选择，才能保证稳定。
4. **启动耗时取决于是否预热**：冷进程调 `launchOptions` 要 28–40 秒（同 OS 身份要拉一个真实 Firefox 采样宿主渲染），结果在**进程内**缓存，之后每次只要 80ms。
   - 结论：应用启动时预热一次，`open` 就落到 3–5 秒
   - M1 已实现 `warmUpEngine()`，`npm run serve` 会在监听端口后后台预热
5. **有头模式的屏幕必须装得下**：固化配置里 1920×1080 在这台 1680 宽的机器上会直接报
   `window.outerWidth 1920 at display scale 1 needs 1920 pixels, but this monitor has 1680`。
   产品里必须在有头模式把 screen 钳制到物理屏幕尺寸以内（`clampScreenToDisplay`）。
6. **有头模式偶发 `webgl: null`**：窗口刚起时 GPU 上下文可能未就绪，自检需重试而不是一次判定失败。

### M0 通过标准

- [x] 引擎能启动，六项检查通过
- [x] `webdriver` 不为 `true`
- [x] `--runs=3` 时非 canvas 字段零漂移
- [ ] 有代理时出口 IP 与 geoip 推导时区一致（已验证一次，需在固定地区代理下复测）


### 常见失败

| 现象 | 原因 | 处理 |
|---|---|---|
| `fetch` 报 404 | 官方仓库已被封号 | 按上文指向 `jo-inc/camofox-browser` |
| `fetch` 卡在 0% / 不动 | Node fetch 不走代理 | `export NODE_USE_ENV_PROXY=1` |
| 启动即崩、无任何输出 | Firefox 内容沙箱初始化失败 | `export MOZ_DISABLE_CONTENT_SANDBOX=1` |
| 启动即崩，提示找不到浏览器 | 未执行 `fetch` | 先跑 `npx camoufox fetch` |
| `webdriver: true` | 引擎未生效，回退到了普通 Firefox | 检查 camoufox 版本与安装是否完整 |
| 出口 IP 为 null | 网络受限或代理不通 | 先直连确认基线，再测代理 |
| Canvas 哈希每次都变 | 身份 OS 与宿主不同，触发隐私噪声 | 让 os 与宿主一致，或关掉 `canvas_noise` |
| `Unterminated string in JSON at 32767` | `CAMOU_CONFIG_1` 超过 32KB 被截断 | 裁剪字体列表后再持久化 |

## M1 运行（环境生命周期闭环）

### 验收脚本

```bash
npm run m1                 # 无头，用宿主 OS 身份，国家默认 HK
npm run m1:headed          # 能看到窗口
npm run m1 -- --country=US --os=windows --home=/tmp/foxbox-a
```

脚本会依次执行：预热 → 创建（固化指纹）→ 启动 → 自检 → 关闭 → 再启动 → 自检 → 可比对。

### 起服务

```bash
FOXBOX_TOKEN=devtoken npm run serve      # 默认 127.0.0.1:7331
FOXBOX_HOME=/tmp/foxbox-b npm run serve  # 换数据目录
```

```bash
curl -s http://127.0.0.1:7331/health
curl -s -H "Authorization: Bearer devtoken" http://127.0.0.1:7331/api/profiles
```

除 `/health` 外所有路由都要 Bearer token。不设 `FOXBOX_TOKEN` 时每次随机生成并打印。

### 实测记录（2026-11-19，macOS 13 / Intel x64）

| 步骤 | 结果 |
|---|---|
| 预热 | 27–40 秒（每个进程一次） |
| 创建环境（macOS 身份，39KB 配置 / 2 块） | 通过，`degraded=false` |
| 首次启动 | 5476ms |
| 二次启动（复用同一环境） | 3411ms |
| 两次 pid | 13818 → 13888（确为新进程） |
| 自检 | `ok=true`，两次均无 mismatch |
| 跨启动漂移 | **0 处** |
| user-data-dir | 44 个条目，二次启动复用 |
| `navigator.webdriver` | `false` |
| HTTP 全链路（建代理→建环境→启动→自检→关闭） | 通过，审计留痕完整 |

### M1 验收结论

- [x] 创建 → 启动 → 自检 → 关闭 → 再启动 全链路可用
- [x] 跨启动零漂移（F-13 达标）
- [x] 启动 ≤ 5 秒（预热后）
- [x] 存储目录复用、进程确实独立
- [x] 代理出口 IP 与预期国家比对（M2 补齐）

## M2 运行（代理预检 / 分组 / 环境管理）

M2 的核心不是加接口，而是回答一个问题：**这个代理的出口到底在哪**。
所有指纹里的时区、语言都依赖它，之前靠手工填国家，等于把最容易出错的一环交给了人。

### 验收脚本

```bash
npm run m2 -- --proxy=http://127.0.0.1:7890
npm run m2 -- --proxy=socks5://127.0.0.1:7890   # socks5 走另一条握手分支
npm run m2 -- --home=/tmp/foxbox-m2 --no-warmup # 跳过 30 秒预热（demo 环境已预热过时）
```

脚本做的 7 件事：建代理并预检 → 只给 `proxyId` 建环境 → 分组与过滤 →
改名 → 申报国家与实际不符的场景 → 失效代理拦截 → 删除被引用代理。

### 实测记录（2026-11-19，macOS 13 / Intel x64，经本地 7890 代理）

| 步骤 | 结果 |
|---|---|
| 代理预检（`www.cloudflare.com/cdn-cgi/trace`） | `103.151.172.151` / **HK** / 握手 461ms / 合计 997ms |
| 只给 proxyId 建环境 | 时区 `Asia/Hong_Kong`、语言 `zh-HK` —— 全部由实测国家推导 |
| 分组过滤 / 名称搜索 / 未分组 | 各 `total=1 / 1 / 0`，分组计数正确 |
| PATCH 改名 + 备注 | 生效，UA 与创建时一致（指纹未被改动） |
| 申报 US、实测 HK | 识别为不一致，指纹按 **HK** 生成 |
| 失效代理（127.0.0.1:7899）→ 启动 | HTTP 502 `PROXY_UNHEALTHY`，带 `check` 明细 |
| 删除仍被引用的代理 | HTTP 409，提示"仍被 1 个环境使用" |
| 老库迁移（M1 的 v1 库） | 自动升到 v2，补 4 个预检字段，原数据完整 |

SOCKS5 通道同样验证过（`--proxy=socks5://127.0.0.1:7890`）：握手 548ms、合计 1537ms、15 项全过、全程 29 秒。
这一路顺带暴露了一个"响应被拆包就空转死循环"的 bug，修法见 TECH 14.6。

### M2 验收结论

- [x] 出口 IP / 国家 / 延迟可测，三个探测端点冗余
- [x] 国家自动进入指纹推导，R1/R2 不再是手工填写
- [x] 申报与实测不一致时被识别，且按实测生成
- [x] 代理失效在启动前拦住（502），不是"窗口能开、网页打不开"
- [x] 分组的增删改查 + 计数 + 环境落回未分组
- [x] 环境列表可按分组/状态/名称过滤并分页
- [x] 环境可改名/备注/分组，指纹字段不可变
- [x] 业务错误有正确状态码（409/502/404/400），不再一律 500

### 常见失败

| 现象 | 原因 | 处理 |
|---|---|---|
| 预检全部端点失败，`[proxy-connect] ECONNREFUSED` | 代理没开或端口写错 | `nc -z 127.0.0.1 7890` 先确认端口 |
| `[proxy-auth] 407` | 账号密码错，或代理不允许 CONNECT | 核对凭据；确认代理支持 CONNECT 到 443 |
| `[target-connect] 目标主机不可达` | 代理只放行 80/443 白名单 | 换端点或换代理 |
| 预检成功但国家为空 | 出口是 `XX`/`T1`（未知/Tor） | 换可用代理，这类出口本身不适合做账号环境 |
| 启动返回 502 | 15 分钟内无成功记录且本次预检失败 | 修代理后 `POST /proxies/:id/check` 再启动 |
| 删除代理 409 | 仍有环境绑定 | 先删/改绑环境（改绑不支持，需新建环境） |

## M3 运行（管理界面 / 批量操作 / 离线校验）

M3 没有引入 React、也没有加打包步骤：界面就是 `ui/` 下三个静态文件，
由本地服务直接托管。这样改样式只要刷新页面，后面要包进 Tauri WebView 也能原样搬运。

### 打开界面

```bash
npm run serve
# 然后浏览器打开 http://127.0.0.1:7331
```

页面里注入了本次运行期生成的 token，只在 `Host` 为 `127.0.0.1` / `localhost` 时有效。
换端口用 `FOXBOX_PORT=7400 npm run serve`。

### 验收脚本

```bash
npm run m3
npm run m3 -- --home=/tmp/foxbox-m3-eval   # 用干净的库跑
```

脚本检查 12 项，覆盖三件容易出问题的事：

1. **静态资源与鉴权**：`/` 与 `/ui/*` 免 token，API 必须带 token —— 漏一个就是白屏或 401
2. **Host 白名单**：伪造 `Host: evil.example.com` 返回 403（DNS rebinding 防线）
3. **批量语义**：逐条返回结果，混入不存在的 id 时其余照常成功

### 界面三块

| 视图 | 内容 |
|---|---|
| 环境 | 状态灯、身份摘要（系统/浏览器/语言/时区/屏幕/代理）、一键启动或关闭、批量条（启动/关闭/移动/删除）、右侧指纹抽屉 |
| 代理 | 预检按钮、延迟、出口 IP、实测国家（与申报不一致时变黄）、被引用数量、全部预检 |
| 审计 | 最近 50 条动作，默认一行摘要，点开看完整 detail |

抽屉分三页：**指纹**（preset 全字段 + 代理 + "为什么这个指纹可信"）、
**一致性**（离线规则校验 + 运行中可触发的实测自检）、**启动记录**（pid、耗时、失败原因）。

### 实测记录（2026-11-20，macOS 13 / Intel x64）

| 项目 | 结果 |
|---|---|
| `npm run m3` | 12/12 通过 |
| 界面首屏（6 个环境 + 2 个代理） | 渲染无报错，控制台 0 错误 |
| 批量移动 3 个环境 | 3/3 成功，分组计数同步为 3 |
| 批量中混入不存在的 id | 成功 1 / 失败 1，失败项 `NOT_FOUND` |
| 离线校验 | 不启动浏览器，耗时 < 50ms |
| 自检（运行中实例） | 检出 webgl 实际为 `null`（该实例 GPU 进程未起来），已按"能力边界"解释而非报错 |
| 停止环境 | 321ms 返回，进程与 `.parentlock` 一并清理 |

### 已知问题：启动耗时

跨系统身份（例如在 macOS 宿主上跑 Windows 身份）首次启动实测 **17–55 秒**，
同系统身份（M1 演示）是 3.4 秒。差异来自引擎要为"非宿主系统"做宿主渲染采样，
本机当时负载均值 ~8，波动很大。当前只要 profile 里带了 `config` + `fingerprint`
就已经跳过了引擎的身份生成，剩下这部分属于引擎内部行为。

下一步优化方向（M4 之前做）：预热时按库里实际存在的 `os_family` 逐个跑一遍
`launchOptions`，把这笔开销从"用户点启动"挪到"应用启动后台"。

### 常见失败

| 现象 | 原因 | 处理 |
|---|---|---|
| 页面打开是空白 / 401 | 直接访问了 `/api` 而不是 `/` | 访问根路径 `http://127.0.0.1:7331` |
| 403 `FORBIDDEN_HOST` | 用域名或非本机 IP 访问 | 只用 `127.0.0.1` / `localhost` |
| 启动卡住 70 秒以上，或报"配置文件已被使用" | 上次进程没退干净，profile 残留 `.parentlock` | 已由停止逻辑自动回收；手工兜底：`pgrep -f Camoufox.app \| xargs kill -9`，再删 `profiles/<id>/.parentlock` |
| 启动报 `Browser does not support socks5 proxy authentication` | 代理是带账号密码的 SOCKS5，Firefox 内核不支持 | 录入阶段已拒绝；改用 HTTP/HTTPS 代理 |
| 启动返回 400 `Body cannot be empty` | 调用方带了 `content-type: application/json` 但没发 body | 无 body 的 POST 不要带这个头（界面侧已修正） |

## M4 运行（任务编排）

M4 把「对一批环境做同一串动作」变成一条可重放、可查证的记录。
任务不是宏录制，也不支持分支与循环——这是刻意的：需要分支就写进 eval 的脚本里，
在 JSON 里发明一套 DSL 的排错成本远高于收益。

### 六种步骤

| 类型 | 作用 | 关键字段 |
|---|---|---|
| `start` | 启动环境（已在运行则复用） | — |
| `goto` | 打开网址 | `url`、`waitUntil`（默认 `domcontentloaded`）、`timeoutMs` |
| `wait` | 等待 | `ms`（上限 120000） |
| `eval` | 在页面里执行表达式，返回值可存变量 | `script`、`saveAs`、`timeoutMs` |
| `screenshot` | 截图到 `$FOXBOX_HOME/screenshots/<任务>/` | `fullPage` |
| `stop` | 关闭环境（未运行则跳过） | — |

`url` 与 `script` 里可用占位符：`{{profile.name}}`、`{{profile.id}}`、`{{profile.os}}`、
`{{vars.变量名}}`、`{{index}}`。占位符只做点号路径取值，不求值表达式。

### 一条能跑的例子

```bash
npm run serve
T=<启动时打印的 token>

curl -s -X POST http://127.0.0.1:7331/api/tasks \
  -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{
    "name": "首页留证",
    "target": { "groupId": "<分组 id>" },
    "concurrency": 1,
    "runNow": true,
    "steps": [
      { "type": "start" },
      { "type": "goto", "url": "https://example.com", "waitUntil": "load" },
      { "type": "eval", "script": "document.title", "saveAs": "title" },
      { "type": "screenshot" },
      { "type": "stop" }
    ]
  }'
```

界面上是「任务 → 新建任务」：选范围（已选/分组/全部）、拖不动的步骤列表、
三个预设（打开并截图 / 取标题 / 只启动）。执行中每 4 秒刷新一次。

### 语义约定

- **逐目标独立**：一个目标失败，不中断其他目标；同一目标内失败即停，剩余步骤标 `skipped`
- **取消不打折**：正在执行的 `wait` 会被立刻打断，该步标 `skipped`，任务状态为 `cancelled`
- **不能并发重入**：同一任务执行中再点运行返回 409
- **进程重启**：上次遗留的 `running` 任务在启动时统一标为失败，界面上不会挂一条永久的"执行中"
- **截图访问**：`/files/screenshots/...` 需要 `?t=<token>`（`<img>` 带不了 Authorization 头），
  并且只允许读 `screenshots` 目录，`..` 走不出去

### 验收脚本

```bash
npm run m4                                    # 含一次真实浏览器启动
npm run m4 -- --no-browser                    # 只验调度语义，秒级完成，适合改代码后快速回归
npm run m4 -- --home=/tmp/foxbox-m4-eval      # 用干净库跑
```

`--no-browser` 覆盖 9 项：参数校验、空目标判失败、取消语义、重复运行 409、列表与删除。
完整模式再加 7 项：五步全 ok、eval 返回值进入变量、截图落盘且是有效 PNG、
无 token 401、路径穿越 403。

### 关于启动耗时（修正 M3 的结论）

M3 里记录「跨系统身份首次启动 17–55 秒，疑似引擎为非宿主系统做渲染采样」——**这个判断是错的**。
M4 用对照矩阵重测（fresh/existing 目录 × 有无代理 × 两种身份 OS），四组都是 40–60 秒，
差异不随这些变量变化。真正的构成是：

| 环节 | 实测 |
|---|---|
| `launchOptions()`（身份参数） | 1.1 秒（传入 config + fingerprint 时本就不会重新生成） |
| `launchPersistentContext()`（Firefox 进程启动） | 34–44 秒 |

同期宿主 `load average ≈ 32`。也就是说这段时间是浏览器进程在满载机器上挤 CPU，
不是身份生成，也与身份 OS 无关。M1 记录的 3.4 秒是在机器空闲时测的，两者并不矛盾。

M4 仍做了一处结构调整：启动参数改为自己调 `launchOptions` 再以 `from_options` 传给引擎。
这样同一环境的参数在进程内只算一次、之后逐字节复用，
也避免"引擎内部再算一遍"这条不确定路径。

### 真实实例冒烟（对着正在运行的服务跑）

m4-demo 自己拉一个无头服务验语义；要验证"界面上那个实例"能不能真的截出图、采到数，
用 `scripts/live-task.ts`——它不发新进程、不碰数据库，只通过 HTTP 打当前服务：

```bash
npx tsx scripts/live-task.ts                       # 端口与 token 从 /tmp/fox.env 读
npx tsx scripts/live-task.ts --keep                # 保留任务记录，界面上可回看
npx tsx scripts/live-task.ts --profile <环境 id>   # 指定环境
```

它跑三条任务：采集 + 全页截图、翻页 + 视口截图、故意写错的脚本（预期失败，用来确认错误可见）。
采集结果另存一份到 `$FOXBOX_HOME/live-task-last.json`，最后一屏打印验收项。

实测（1280×800 本机，环境已在运行）：采集 1.5s、翻页 1.9s、失败用例 1.4s，全页截图 539KB。

### 截图尺寸是怎么定的

截图 = 视口尺寸 × dpr。曾经不管 identity 声称多大的屏幕，截图永远是 1280×720——因为没给
Camoufox 传窗口尺寸，Playwright 套了自己的默认视口 1280×720。

现在建环境时屏幕按本机收敛（`src/fingerprint/host-screen.ts`），启动时把窗口固定成
identity 声明的大小（`CamoufoxAdapter.viewportFor`）。1280×800 机器上的实测值：

| 项 | 值 |
|---|---|
| `screen.width/height` | 1280 × 800 |
| `screen.availHeight` | 775（扣掉 25pt 菜单栏） |
| `window.innerWidth/Height` | 1264 × 689 |
| 视口截图 | 2528 × 1378 像素（= 1264×689 × dpr 2） |
| 全页截图 | 宽 2528，高随内容 |

若某个环境的 `innerWidth` 仍远小于 `screen.width`，说明它的 preset 是修复前冻结的（库里存着
旧值），重建一个环境即可；已冻结的身份不会被悄悄改写。

### 已知限制

| 限制 | 说明 |
|---|---|
| 无重试 | 失败即止；要重试就再点一次运行（任务记录本身可重放）。定时规则也一样：这一轮失败不会自动重试 |
| eval 执行任意 JS | 本地单用户工具，token + Host 白名单是边界；不要把服务暴露到公网 |
| 单目标串行 | 同一目标内严格按步骤顺序，不支持并行分支 |

## M5 定时与事件触发（2026-11-20）

任务从"手动点运行"变成"守着跑"。两个能力共用一套调度：

| 类型 | 触发 | 动作 |
|---|---|---|
| `cron` | 标准 5 段表达式（分 时 日 月 周），支持 `@daily` 等别名 | 跑一条任务 |
| `proxy_watch` | 每 N 分钟巡检代理 | 切备用代理 / 关闭相关环境 / 跑任务 / 仅记录 |

### 运行

```bash
npm run serve                      # 调度器随服务启动，心跳 20 秒
FOXBOX_TICK_MS=5000 npm run serve  # 临时把心跳压到 5 秒，便于观察
```

界面「自动化 → 新建规则」：选类型 → 填表达式（下方实时显示"接下来三次"）或巡检参数 → 选动作。

### 语义约定（这几条决定了它会不会坑人）

- **不补跑**：服务关了两小时，开机后不会把那 12 次一起补上，只记一条「服务未运行，这次触发已跳过（不补跑）」，然后从当前时刻接着算
- **不叠加**：同一规则上一次的任务还在跑，本次触发记 `skipped`，不排队
- **心跳不落历史**：代理巡检没异常是常态，只有跨过失败阈值或恢复时才写记录，其余只推进时间
- **边沿触发**：按 `fail_streak` 跨过阈值的那一次算事件，而不是"当前是否失败"——否则一条挂掉的代理会每个周期都触发一次
- **同国家才切换**：自动换代理前比对出口国家，不同就不动，并把原因写进记录。
  指纹里的时区与语言是按国家固化的，换国等于让 IP 与时区自相矛盾
- **手动运行不改节奏**：界面上的「立即运行」触发一次，但不移动原有 `next_run_at`

### 验收

```bash
npm run m5 -- --home=/tmp/foxbox-m5-eval     # 30 项，秒级完成
npm run m5 -- --no-proxy                     # 跳过代理巡检那 8 项
```

判据不止"接口返回 200"：

- 写错的表达式在**录入时**被拒（4 段、`60 * * * *`、5 年内不会触发的 `0 0 30 2 *`）
- 到点真的把任务推起来（用 `wait` 步骤任务，不启动浏览器）
- 并发心跳只有一轮生效；任务没跑完时下一次触发标 `skipped`
- 把 `next_run_at` 拨到 2 小时前再 `resync()`：只多一条「跳过」，下次时间仍在未来
- 失效代理（`127.0.0.1:1` 连接拒绝）→ 环境切到同国家备用代理，原因写进历史
- 备用代理国家不同 → 不动，记录里写明「切换会破坏指纹一致性」
- 删除规则后从列表消失

实测（2026-11-20）：**30/30 通过**，代理失效判定 12ms（本地拒绝，不发外部请求）。

### 桌面模式

不用 Rust，一条命令开一个没有地址栏的独立窗口：

```bash
npm run app            # 起服务 + Chrome --app 窗口，关窗即退出
npm run app -- --probe # 只验证启动链路（找内核、分端口、起服务），不开窗口
```

用的是一次性 `--user-data-dir`（`/tmp/foxbox-shell-*`，退出即删）。复用固定目录的话，
第二次启动会把 URL 转发给已在运行的浏览器然后自己退出，服务跟着关掉、窗口却还在——
这种"看起来开了其实连不上"最难排查。

### Tauri 原生壳

```bash
npm run build          # 先产出 dist/（tsc + 拷 schema.sql）
npm run desktop:dev    # tauri dev
npm run desktop:build  # 打包 .app / .dmg
```

前置条件：**Rust ≥ 1.77**（Tauri 2 的下限）、**Node ≥ 22.15**（后端要 `node:sqlite`）。

**已验证（2026-11-20，Rust 1.100.0 / tauri 2.12.7）**：

```bash
cargo build                                  # 首次 8m39s（400+ crate），增量 27s
npx tauri build --debug --bundles app        # 1m15s，产出 35.3MB 的 FoxBox.app
open desktop/src-tauri/target/debug/bundle/macos/FoxBox.app
```

**release（2026-11-21 实测）**：

```bash
npm run desktop:build        # 7m32s（406 crate 全新编译），产出 3.5MB 的 .app
open desktop/src-tauri/target/release/bundle/macos/FoxBox.app
```

**DMG 这步会挂**（`npm run desktop:build` 自带的 dmg target）：

```
bundle_dmg.sh: Searching for mounted interstitial disk image using /dev/disk6s...
grep: bad regex '/dev/disk6s': brackets ([]) not balanced
ERROR: unable to proceed with final disk image creation
```

`.app` 已经生成成功，只是压 dmg 的脚本挂了；不想折腾就手工压一个：

```bash
cd desktop/src-tauri/target/release/bundle
STAGE=$(mktemp -d) && cp -R macos/FoxBox.app "$STAGE/" && ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "FoxBox 0.2.0" -srcfolder "$STAGE" -ov -format UDZO dmg/FoxBox_0.2.0_x64.dmg
```

本机实测 1.8MB。产物未签名、未公证，只在本机用；分发给别人要先过 Gatekeeper（右键打开或自行公证）。

打开后：后端 Node 起在随机端口，窗口自动从启动页导航到工作台，
`~/.foxbox/desktop-shell.log` 里会留下「[壳] 后端就绪（node …），导航到 http://…」。
`lsof -i :<端口>` 能看到 WebKit 内容进程的 4 条长连接（界面的轮询），
这是"窗口真的进了工作台"而不是卡在启动页的判据。

**壳死了后端会不会跟着死**（F-09）：壳启动后端时传 `FOXBOX_PARENT_PID`，后端每 5 秒
`kill(pid, 0)` 探活。实测 `killall foxbox-desktop` 后 6 秒内后端自行退出，日志留
`[parent-gone] 正在关闭所有环境...`，端口随之释放。`npm run serve` 不传这个变量，行为不变。

#### 首次升级 Rust 的坑（本机踩过）

本机原来是 Rust **1.50.0**，两个坑连在一起：

1. `static.rust-lang.org` 直连极慢、走本地代理反而超时。换镜像：

   ```bash
   export RUSTUP_DIST_SERVER=https://mirrors.ustc.edu.cn/rust-static
   export RUSTUP_UPDATE_ROOT=https://mirrors.ustc.edu.cn/rust-static/rustup
   rustup self update        # 1.23.1 解析不了新清单，必须先升 rustup 本体
   rustup update stable
   ```

2. 旧工具链（1.50）里残留的 `share/doc/rust/html` 会让新版本安装时报
   `Directory not empty (os error 66)` 然后整体回滚。直接清掉重装最省事：

   ```bash
   rustup toolchain uninstall stable
   rustup toolchain install stable --profile default --component rustfmt
   ```

crates 源已在 `.cargo/config.toml` 里指向中科大 sparse 索引（实测 ~500KB/s，
官方源 ~100KB/s）。这个文件只对本仓库生效，不影响全局 `~/.cargo`。

壳里不做业务，只做三件事，见 `desktop/src-tauri/src/main.rs`：

1. 分一个空闲端口（不写死 7331，避免和 `npm run serve` 抢）
2. 用本机 node 起 `dist/main.js`，注入 `FOXBOX_PORT` / `FOXBOX_TOKEN` / `MOZ_DISABLE_CONTENT_SANDBOX`
3. 等端口可连通后把窗口从启动页导航到 `http://127.0.0.1:<port>/`

两个容易踩的点已经处理：

- **从 Finder 启动时 PATH 只有系统目录**，Homebrew / nvm 的 node 都找不到。
  `find_node()` 依次试 `FOXBOX_NODE`、`PATH`、`/opt/homebrew/bin`、`/usr/local/bin`、
  `~/.nvm/versions/node/*`（倒序取新）、`~/.workbuddy/binaries/node/versions/*`、`~/.volta/bin`。
  **每个候选都真跑一次 `node -v`**：光"文件存在"不够——本机 nvm 里只有一个 v20.12.2，
  它没有 `node:sqlite`，起来了也会立刻退出。找不到合格版本时，错误里会列出
  "我找到了这些，但都太老"，而不是干巴巴一句"找不到 node"
- **退出必须走 SIGTERM**：直接 kill 会留下 Firefox 残留和下一次启动 70 秒的卡顿。
  `stop_child()` 先发 SIGTERM，给 Node 5 秒走完优雅关闭，再强杀
- **父进程的 `NODE_OPTIONS` 必须摘掉**（`env_remove("NODE_OPTIONS")`）。
  IDE 和各种运行时会在里面挂 `--require` 注入钩子，后端读文件时会整体抛异常：
  表现为"服务在监听、`/health` 是 200，但 `/` 和 `/ui/*` 全是 500"。
  这类故障看不出和启动器有任何关系，隔离掉最干净
- **失败要看得见**：后端 stdout/stderr 落 `~/.foxbox/desktop-shell.log`，
  起不来时启动页直接显示退出码 + 日志末尾 + 完整路径

启动失败不会白屏：窗口先显示 `desktop/shell/index.html`，失败原因通过 `window.foxboxFail()` 直接写在启动页上。

## 启动排障（2026-11-20 实测）

### 症状 → 原因 → 处理

| 症状 | 多半是 | 怎么确认 / 怎么办 |
|---|---|---|
| 点了启动，屏幕上没有窗口 | 环境是**无头模式**（`headless: true`） | 列表里系统那一列会带橙色「无头」标签。抽屉里把「显示窗口」打开，重新启动即可 |
| 点了启动，弹出红色报错 | 以前是"同一环境被重复点启动"，两次启动抢同一个 `user-data-dir` | 已修：启动改成幂等，重复点击复用同一次结果（审计里留 `profile.start.dedup`） |
| 启动很慢（几十秒） | 宿主负载高，或首次启动在等预热 | `uptime` 看 load average；日志里 `[预热] macos 就绪，耗时 …` 就是它在等。预热完成后二次启动通常 3–5 秒 |
| 报错里一屏浏览器日志 | Playwright 的原始错误 | 已修：界面只显示第一句 + 常见原因，完整日志留在审计 `profile.start.failed` |
| 所有站点都打不开，报 `NS_ERROR_PROXY_CONNECTION_REFUSED` 或代理超时 | 环境没配代理时，Firefox 默认 `network.proxy.type=5`（跟随系统代理），本机 Clash/ClashX 节点失效就全站连不上 | 已修：没配代理的环境启动时显式写 `network.proxy.type=0` 直连。若仍失败，说明环境自己配了坏代理，去代理页做健康检查 |
| 截图分辨率明显小于环境声称的屏幕 | preset 是旧版冻结的（随机抽到 1920×1200，本机只有 1280×800） | 见下文「截图尺寸是怎么定的」，重建环境 |

### 为什么"重复点击"曾经会失败

`start()` 只判断了 `manager.isRunning(id)`，而启动过程需要几秒——这段时间里没有登记成
running，第二次点击就当成新启动处理。两个 `launchPersistentContext` 抢同一份 profile 目录，
先到的那个被后到的挤掉，报 `Target page, context or browser has been closed`。

修复方式是在 `ProfileService` 里加了一张在途表：同一个 id 的第二次调用直接拿到第一次的
Promise。`stop()` 也会先等在途启动落定再拆，避免拆出"进程已死但状态是 running"的半截现场。

实测（负载 40 的机器上）：

```
同时发两次 start → A:200 4.49s / B:200 4.08s，pid 与 launchId 完全相同
```

### 启动要多久

| 场景 | 实测 |
|---|---|
| 预热已完成、机器空闲 | 3.4 – 4.6 秒 |
| 预热完成后首次（无头） | 7 – 9 秒 |
| 服务刚启动、预热还在跑 | 40 – 48 秒（这段时间界面只有"启动中"） |
| 宿主 load average 40+（4 核） | 单次可到 40 秒以上 |

最后一行不是软件问题：`launchPersistentContext` 是 CPU 密集的进程启动，宿主超载时只能等。

---

## M6 – M9 运行（数据落地 / 会话巡检 / 可靠性 / 身份健康）

```bash
npm run m6                    # 32 项：collect 去重、增量、上限、CSV/JSONL 导出
npm run m7                    # 15 项：三态判定、边沿告警、并发 3、取消（-- --quick 只跑 9 个环境）
npm run m8                    # 13 项：超时分类、重试、通知聚合/签名/退避、TTL 清理
npm run m9                    # 6 项：自检标记、跨平台屏幕解析
npm run m9:repair             # repair 可行性验证（结论落 .foxbox-m9-repair.json）
npm run restart-check         # 启停稳定性自检（-- --headed 用有头模式）
npm run ui-smoke              # 界面冒烟：截图到 .foxbox-ui-smoke/shots/，人眼过一遍
```

前三个都需要真实浏览器，全程打本地假站点（`scripts/fixtures/login-site.ts`），不依赖公网。
整套跑完约 10 分钟。

### 坑一：有头启动在没有图形会话的环境里会挂死（2026-11-20 实测）

**症状**：同一环境连续启停时，第 2 次起 90–180 秒超时；`pgrep -fl camoufox` 为 0；
`~/Library/Logs/DiagnosticReports/` 里 `Camoufox GPU Helper` 每 10 秒一份崩溃报告
（`EXC_BAD_ACCESS / SIGSEGV at 0x0`）；playwright 侧只看到 `-wait-for-browser -foreground`，
永远等不到 juggler 握手。

**根因**：`profiles.headless` 默认 `false`（有头是对的——真实桌面用户要看见窗口）。
但在 SSH / CI / 自动化 shell 这类**没有图形会话**的环境里，有头浏览器创不出窗口，
GPU 与内容子进程反复崩溃重启，juggler 永远起不来。

**判定方法**：看 playwright 的启动命令行（`DEBUG=pw:browser`）：

| 模式 | 命令行特征 |
|---|---|
| headless | `-no-remote -headless -profile …` |
| headed | `-no-remote -wait-for-browser -foreground -profile … -juggler-pipe about:blank` |

**处置**：

```bash
npm run restart-check                 # 无头：3 秒左右、4/4 稳定
npm run restart-check -- --headed     # 有头：需要真实桌面会话，否则必挂
```

- 验收脚本、CI、SSH 里一律 `headless: true`；
- 桌面 App 里保持有头（默认）；
- 启动超时文案现在会直接提示「当前为有头模式，若运行环境没有图形会话请改用 headless」。

**排除过但都不成立的方向**（避免重走）：
profile 启动缓存损坏（删 `startupCache`/`cache2`/`places` 的结果互不相干）、
残留进程与 `.parentlock`、`MOZ_DISABLE_CONTENT_SANDBOX` 未生效、
`humanize` / `viewport` / `firefox_user_prefs` 参数。

### 坑二：`viewport` 参数传给 Camoufox 是无效的（2026-11-21 清理）

`Camoufox(options)` 的形参是 `({ headless, from_options, persistent_context, debug, ...kwargs })`，
而 `kwargs` 只在**没有** `from_options` 时才被用来调 `launchOptions`。我们始终走 `from_options`，
所以以前那个 `viewport` 从未生效过——实测 `page.viewportSize()` 返回 `null`。

窗口尺寸的真正来源是 config 里的 `window.innerWidth/innerHeight`：这些键存在时，
引擎会主动 `applyNoViewport`（`spoofsWindowDimensions`），让 Playwright 不要套 1280×720 的默认视口。
尺寸的宿主夹取在**创建环境时**就做完了（`freeze.ts` 的 `shrinkScreenToHost`），启动时不必重复。

想确认某个环境的窗口到底多大，别看启动参数，直接问页面：

```js
page.evaluate('({ w: innerWidth, h: innerHeight, sw: screen.width, sh: screen.height })')
```

### 坑三：会话 cookie 不跨重启

Firefox 退出时丢弃会话 cookie（无 `Max-Age`/`Expires`）。所以「重启环境后仍然是登录态」
只对发了持久 cookie 的站点成立；假站点因此改成 `Max-Age=604800`。
真实站点如果只发会话 cookie，用户重开环境后需要重新登录——这是浏览器行为，不是环境坏了。

### 坑四：`npm run app` 窗口闪退，只报「窗口已关闭」（2026-11-21 修）

**现象**：跑 `npm run app`，打印「窗口已打开」后十几秒变成「[窗口已关闭] 正在关闭…」，
进程以 0 退出，没有任何错误信息。

**根因**：`scripts/app.ts` 把 Chrome 子进程的 stdio 设成了 `ignore`，stderr 被直接丢弃。
真实原因藏在里面：

```
sandbox initialization failed: Operation not permitted
GPU process exited unexpectedly: exit_code=6
FATAL:gpu_data_manager_impl_private.cc:416 GPU process isn't usable. Goodbye.
```

受限会话（远程桌面、CI、某些沙箱/容器）里 Chrome 起不了自己的沙箱，GPU 进程连崩三轮后自杀。
注意它不是立刻死——实测能撑 4–15 秒，所以「等 2 秒看死没死」这类判据抓不到。

**修法**（F-08）：stderr 改为 `pipe` 并留 80 行尾巴；退出时若「活不到 30 秒」且日志里有
`FATAL:` / `GPU process isn't usable` / `sandbox initialization failed`，就打印最后几行去重后的
输出；确认是沙箱被拒时自动带 `--no-sandbox` 重试一次（只放宽这一次启动，不动全局配置）。
正常关窗（活够 30 秒、日志无崩溃标记）仍走原来的收尾路径，不会误报。

**什么时候还会看到它**：`--no-sandbox` 只保证进程活着，不保证窗口画得出来。
如果重试后仍看不到窗口，问题在图形会话本身（没有可用的 WindowServer / 远程会话不转发窗口），
这时候别继续调 FoxBox，换到本机终端跑：

```bash
cd foxbox && FOXBOX_TOKEN=dev npm run app
```

### 启动重试与超时

| 环境变量 | 默认 | 用途 |
|---|---|---|
| `FOXBOX_LAUNCH_TIMEOUT_MS` | 90000 | 单次启动上限。低配机上正常启动要 30s+，挂起时没必要等满 |
| `FOXBOX_LAUNCH_RETRIES` | 1 | 只对偶发错误（超时/崩溃/管道断）重试；版本缺失、指纹非法不重试 |
| `FOXBOX_NOTIFY_WINDOW_MS` | 60000 | 通知聚合窗口（验收里压到 1500ms 跑得快） |
| `FOXBOX_NOTIFY_BACKOFF` | `1000,5000,30000` | 投递退避 |
| `FOXBOX_RETENTION_SCREENSHOT_DAYS` | 30 | 截图保留天数（`dataset_rows` 永不自动删） |
| `FOXBOX_PARENT_PID` | 无 | 由桌面壳注入。设了就每 5s 探活父进程，父进程消失即优雅退出（F-09） |

---

## M10 运行（外部自动化）

```bash
npm run m10                    # 10 项验收，自带假站点，约 40 秒
npm run serve                  # 然后从外部调用
```

### 先拿调用方式

```bash
curl -s http://127.0.0.1:7331/api/profiles/<id>/automation \
  -H "authorization: Bearer $FOXBOX_TOKEN" | jq
```

响应里有 `transport: "http-script"`、`cdp: null`（**Firefox 没有 CDP，别找**）、
`cdpReason`，以及带 token 的 `examples.curl / .python / .node`，直接复制就能跑。
界面里也有一份：环境详情 →「自动化」标签页，带复制按钮和「试跑」。

### 跑一段采集脚本

`playwright` 模式，脚本是 async 函数体，形参 `page` 与 `ctx`：

```bash
curl -s http://127.0.0.1:7331/api/profiles/<id>/run-script \
  -H "authorization: Bearer $FOXBOX_TOKEN" -H 'content-type: application/json' \
  -d '{
    "mode": "playwright",
    "timeoutMs": 30000,
    "screenshot": true,
    "script": "await page.goto(\"https://example.com\");\nreturn { title: await page.title() };"
  }'
```

返回：

```json
{ "ok": true, "mode": "playwright", "result": { "title": "Example Domain" },
  "elapsedMs": 912, "launchMs": 5942, "screenshot": "screenshots/automation/<id>-<ts>.png" }
```

- 环境没开 → 自动启动，启动耗时单独放在 `launchMs`（首次 5–7 秒是正常的）
- `autoStart: false` 且环境没开 → 409，不会在错的环境上静默执行
- 脚本自己报错 / 超时 → HTTP 422 + `ok: false` + `error`；这不是接口坏了
- 截图要拼 `/files/<screenshot>?t=<token>` 才能取

### 只读页面（page 模式）

不需要导航时就别用 playwright 模式：`{"mode":"page","script":"({ t: document.title })"}`，
它在页面上下文里求值，拿不到 `page` 对象，但快得多。

### 审计与留证

`profile.script.ok` / `profile.script.failed` 会进审计（模式、耗时、字节数、错误前 300 字），
**脚本正文不入库**。截图进 `screenshots/automation/`，受 `FOXBOX_RETENTION_SCREENSHOT_DAYS` 管。

---

## 采集示例：B 站视频

这是 `run-script` 的完整用法示范：采集逻辑在环境里跑，外部只负责投递和落盘。

```bash
# 桌面版：端口和 token 都在日志里
export FOXBOX_URL=$(grep -o "127.0.0.1:[0-9]*" ~/.foxbox/desktop-shell.log | tail -1 | sed 's|^|http://|')
export FOXBOX_TOKEN=$(grep -o "Token  .*" ~/.foxbox/desktop-shell.log | tail -1 | awk '{print $2}')

npm run bili -- --mode popular --limit 50          # 热门榜，含硬币/分享
npm run bili -- --mode popular --limit 50 --detail # 热门榜 + 逐条详情（标签/分P/分辨率）
npm run bili -- --mode search --keyword "AI 编程" --pages 2
npm run bili -- --mode video --bvid BV1atse6EEfx   # 详情：分P、分辨率、标签
```

产物落在 `out/bilibili-<mode>-<时间>.json` 与 `.csv`（CSV 带 BOM，Excel 双击即开）。
表里默认只打前 20 行；`--raw` 直接看原始 JSON，`--no-shot` 不截图。

`--detail` 的代价要算清：每条视频多打 1~2 次接口，**50 条约 70 秒**。所以默认不开——
只要榜单排名和播放/点赞/收藏时不用开；要硬币、分享、标签、分P、分辨率才加。
字段完整度参考：50 条实测 `coins/shares/pages/resolution/tags` 都是 50/50，
`description` 41/50（少数视频没写简介）。

### 两个文件的分工

| 文件 | 在哪跑 | 职责 |
|---|---|---|
| `scripts/payloads/bilibili.js` | 环境里的浏览器 | 真去 bilibili.com 抓数据，返回结构化数组 |
| `scripts/bilibili-collect.ts` | 任意进程 | 选环境、拼参数、POST `run-script`、落盘、打表 |

payload 前面那行 `const P = {...}` 由客户端注入；不注入直接粘进 curl 也能跑，默认采热门第一页。
`--detail` 对应 payload 里的 `detail: true`，它是在列表采完之后对同一批 bvid 再打 `view` 接口，
再把结果**替换**掉列表记录（`source` 会变成 `popular+view`）——不是合并成两条。

### 为什么这么写

- **走页面里的 `fetch`，不是 Node 直连**：这样自动带上环境自己的 Cookie（`buvid3` 等）
  和 `bilibili.com` 的 Referer，风控命中率低；换环境就是换出口 IP。
- **搜索用 `search/all/v2` 而不是 `wbi/search/type`**：后者在未登录环境会返回
  `{"code":0,"data":{"v_voucher":"..."}}`（要验证码），all/v2 目前不需要签名。
  它把结果按类型分组，`video` 组里还混着直播（`type=live_room`），要过滤。
- **限速 450ms + 0~300ms 抖动**，遇到 `-352/-412/-799` 回首页刷新 Cookie 重试两次，
  还不行就报错退出——不做无脑重试，那只会把环境打进黑名单。
- **未登录只能拿列表与统计**：评论正文、1080P 以上、部分分区要登录。要登录就在界面里
  启动该环境、手动扫一次码，Cookie 留在环境里，之后所有脚本共用。

### 换站点

复制 payload，把接口和 `normalize()` 改掉即可——客户端不用动。站点如果在前端渲染，
就在 payload 里 `page.goto()` 后读 DOM；接口直出 JSON 的，用 `page.evaluate(fetch)` 最省事。

---

## M11 运行（身份：坐标 / dpr / canvas）

```bash
npm run m11                 # 10 项验收，会真起 1~3 个浏览器，约 3 分钟
npm run m11 -- --home=/tmp/foxbox-m11   # 指定目录（默认用一次性临时目录）
```

验收要真开浏览器，因为它验的正是「配置有没有落到渲染层」：
dpr 是否真的变了、坐标是否真的取得出来、canvas 读回是否真的被覆盖。只读配置是验不出来的。

### 手工验一遍

```bash
export FOXBOX_URL=http://127.0.0.1:<port>
export FOXBOX_TOKEN=<token>

# 1) 建一个环境（不绑代理 → 用国家兜底坐标）
curl -s -X POST $FOXBOX_URL/api/profiles -H "authorization: Bearer $FOXBOX_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"坐标验证","country":"HK","os":"macos","headless":true}' | jq '.preset.geolocation, .preset.screen'

# 2) 启起来，读页面里的真实值
curl -s -X POST $FOXBOX_URL/api/profiles/<id>/run-script -H "authorization: Bearer $FOXBOX_TOKEN" \
  -H 'content-type: application/json' -d '{
    "mode":"playwright","timeoutMs":30000,
    "script":"await page.goto(\"https://example.com\");\nreturn await page.evaluate(() => ({dpr: devicePixelRatio}));"
  }' | jq '.result'
```

### 三个容易踩的点

1. **地理坐标必须在真实 origin 上测**。`about:blank` 没有 origin，`getCurrentPosition`
   一定返回 `PERMISSION_DENIED`，跟配置无关。
2. **坐标来自代理预检**。绑定代理后要先跑一次「检测」，`last_check_lat/lon` 才有值；
   没测过就用国家兜底坐标（US→纽约、HK→香港），启动时还会按最新实测再对齐一次。
3. **canvas 的 `false` 是排障用**，它会让站点看到宿主真实渲染，与身份声明的 GPU 矛盾。
   要「降暴露」应该用 `true`（占位随机）或默认的 auto。

### 数据落在哪

- `profiles.canvas_noise`：NULL / 1 / 0（三态，v9 迁移）
- `proxies.last_check_lat / last_check_lon`：出口实测坐标（v8 迁移）
- `profiles.preset_json`：可读身份，启动时会按最新出口坐标回写 geolocation
