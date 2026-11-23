# 问题台账（ISSUES）

记录测试中发现、但一次没有修完的问题。**已修的也留档**——不是为了记账，是为了下次遇到
同样的现象时能先搜到当时怎么定位的。

编号稳定，代码注释、提交信息、文档里引用时用编号（`I-05`、`E-01`）。

- **I**：未关闭
- **F**：已修复（留档）
- **E**：环境侧 / 非代码问题
- **O**：待确认（怀疑有问题，还没定量）

优先级：**高** = 影响身份真实性或数据正确；**中** = 影响可用性；**低** = 展示与体验。

## 摘要

| 编号 | 问题 | 优先级 | 状态 |
|---|---|---|---|
| I-01 | 修复前创建的环境仍带矛盾指纹，且无重建入口 | 高 | 部分修复（已可见化，无重建入口） |
| I-02 | Windows 上没有宿主屏幕探测，夹取不生效 | 中 | 已实现，待真机验证 |
| I-03 | HiDPI Linux 的 dpr 固定为 1 | 低 | 未关闭 |
| I-04 | `preset.dpr` 是推断值，可能与实际读数不一致 | 低 | 已修复（dpr 接管，2026-11-22） |
| I-05 | 删除任务不删截图，磁盘只增不减 | 中 | 已修复 |
| I-06 | 任务级没有总超时与重试 | 中 | 已修复 |
| I-07 | 界面里的截图预览没有实测（截图是物理像素） | 低 | 已修复（实测） |
| I-08 | 没有「跟随系统代理」这个选项 | 低 | 未关闭 |
| O-01 | 关窗口是否会退出 app 并回收后端 | — | 部分确认（强杀已由 F-09 兜住，红灯仍待点一次） |
| O-02 | 无头模式下 viewport 是否同样生效 | — | 已确认（viewport 从未生效） |
| O-03 | 能不能给外部一个 CDP 链接 | — | 已确认：不能（M10 改为 HTTP 脚本执行） |
| O-04 | 音频噪声能不能开 | — | 已确认：不能（引擎 158 已移除 audio:seed） |

---

## 一、未关闭

### I-01 修复前创建的环境仍带矛盾指纹，且没有重建入口

**发现于** 2026-11-20 冒烟测试 · **优先级** 高 · **进展** 2026-11-21：已做成「可见」，
**不做**局部修复（见下）

> **2026-11-21 进展**：建议 1 已实现——启动时（仅手动打开）比对 preset 与页面实测，
> 差异落 `profiles.health_json`，列表打琥珀角标、详情「一致性」页列明细。
> 建议 2 经实测**否决**：`npm run m9:repair` 显示改 `fingerprint.screen` 会连带重抽
> `mediaDevices` / `locale` / `timezone` 等 11 个键，等于把环境变成另一台设备；
> 只覆写 config 的 `screen/window` 是安全的，但那只在建环境时有用。
> 所以「重建入口」仍未提供——老环境唯一正确处置就是删了重建。

**现象**：修复后新建的环境是自洽的（screen 1280×800 / inner 1264×689 / dpr 2），
但修复前建的「M1 演示环境」实测仍是 `screen 1920×1200` + `innerWidth 1280` + `dpr 1`。
界面上没有任何标记能区分这两类环境。

**根因**：preset 在创建时冻结落库，修复只作用于新生成的身份。这是刻意的（已投入使用的
环境不该被悄悄改写身份），但副作用是旧环境永远带着矛盾。

**影响**：如果某个环境已经用于注册或养号，它现在这套「屏幕 1920 但窗口永远 1280」的
组合本身就是可被检测的破绽；而用户看不到这个风险。

**建议**（按成本从低到高）：

1. 环境详情加「屏幕一致性」一行：启动后实测 `innerWidth/innerHeight/dpr` 与 preset 比对，
   不一致就打标记。改动小，能先把问题**可见化**。
2. 提供 `refreshPreset(profileId, { keep: ['seed', 'country', 'os', 'proxy'] })`：
   只重算 `screen/window`，其余身份字段（UA、WebGL、字体、时区）保持不变。
   需要先验证重算会不会连带改变 canvas/WebGL 采样结果（`launchOptions` 里 webgl 采样与
   screen 是绑定的，见 TECH §16.1），否则「只改屏幕」这个承诺不成立。
3. 明确不做批量自动迁移：批量改身份的风险大于收益，宁可让用户自己决定每个环境。

### I-02 Windows 上没有宿主屏幕探测，夹取不生效

**发现于** 2026-11-20 · **优先级** 中 · **进展** 2026-11-21：已按下面的建议实现，
**尚未在 Windows 真机验证**（解析逻辑抽成纯函数，用样本注入测过）

**现象**：`src/fingerprint/host-screen.ts` 只实现了 macOS（`system_profiler`）与
Linux（`xrandr`），Windows 直接返回 `null`。

**根因**：探测失败时 `fitToHost` 原样返回，夹取静默跳过——这是有意的降级（宁可保持旧行为
也不猜尺寸），但在 Windows 上等于整条修复不存在。

**影响**：Windows 用户建出来的环境仍然是「引擎随机抽的屏幕 + Playwright 默认 1280×720 视口」，
即 TECH §16.1 描述的矛盾原样存在。

**建议**：补一个探测路径，优先顺序：

```powershell
# 逻辑分辨率（含缩放），最接近 window.screen 语义
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
```

PowerShell 启动开销约 300–600ms，只在建环境时调一次，可接受（macOS 的 `system_profiler`
也是 0.5s）。拿不到就继续返回 `null`，不要 fallback 到写死的分辨率。

### I-03 HiDPI Linux 的 dpr 固定为 1

**发现于** 2026-11-20 · **优先级** 低

`xrandr` 只给像素尺寸，不给缩放因子；GNOME 的缩放存在
`gsettings get org.gnome.desktop.interface text-scaling-factor` 与
`scaling-factor` 里（两者含义不同）。当前实现写死 `dpr: 1`，在 2x 屏上会让
`screen.width` 报成物理宽度，与真实 `devicePixelRatio` 打架。

**建议**：先读 `GDK_SCALE` / `GDK_DPI_SCALE` 环境变量，再退到 gsettings；
都拿不到时返回 `null` 而不是写 1。

### I-04 `preset.dpr` 是推断值，可能与实际读数不一致（已修复）

**发现于** 2026-11-20 · **优先级** 低 · **关闭于 2026-11-22**

`presetFromConfig()` 先取 `fingerprint.screen.devicePixelRatio`，拿不到就用
`inferDpr(width)` 按宽度猜。实测 `getRandomPreset('macos').screen` **不含**
`devicePixelRatio`，所以走的是推断分支。

修复后的环境里 preset 报 2、实测也是 2——但这是「屏幕报的尺寸真实 → 引擎自己算出的
像素比正确」的结果，不是 preset 这个字段真的准。

**影响**：界面展示的 dpr 可能是错的（展示用，`validator` 不比对这一项）。
目前没有自动校验会因为这条误报。

**最终修法（2026-11-22）**：不走「降级成展示值」那条，因为引擎本来就支持 dpr——
`window.devicePixelRatio` 会转成 `layout.css.devPixelsPerPx`，真正按该倍率渲染。
所以改成：创建时取**宿主实测 dpr** 写进 config，`presetFromConfig` 从 config 读回，
自检把它纳入比对。实测接管前 `devicePixelRatio=1`（preset 写 2），接管后为 2，diff 为空。
细节见 [TECH §19.2](./TECH.md)。

### I-05 删除任务不删截图，磁盘只增不减

**发现于** 2026-11-20 · **优先级** 中 · **进展** 2026-11-21：三条建议全部落地（M8）

**证据**：`TaskRepo.remove()` 只有 `DELETE FROM tasks WHERE id = ?`；
`.foxbox/screenshots/` 下现存 7 个目录，其中多个属于已删除的任务（例如
`01M7WM47AMK0NMC1PRC4DC2DY1`，对应任务在冒烟脚本里已 204 删除）。

**影响**：全页截图单张 0.2–0.6MB，跑几条采集任务就是几 MB。定时任务长期跑会无声地
把磁盘吃掉，而 `screenshots/` 是唯一会写盘的地方。

**建议**：

1. 删任务时连带 `rm -rf screenshots/<taskId>`（注意 `automation_runs` 里可能引用同一批图）
2. 加一条保留策略：`FOXBOX_SCREENSHOT_TTL_DAYS`（默认 30），启动时扫一遍
3. 界面上显示截图占用空间，让「删不删」这件事有依据

### I-06 任务级没有总超时与重试

**发现于** 2026-11-20 读码 · **优先级** 中 · **进展** 2026-11-21：已实现（M8），
`timeoutMs` 默认 10 分钟、`retries` 默认 0 且只对瞬时错误生效

单步有 `timeoutMs`（上限 180s），但整条任务没有 deadline：20 步 × 180s 最长可挂 1 小时，
期间界面上一直是「执行中」。也没有重试——定时规则某一轮失败就到此为止。

**建议**：加任务级 `timeoutMs`（默认 10 分钟，超时按 `cancelled` 收尾并写明原因）；
重试作为可选字段 `retries`，只在「启动失败/导航超时」这类瞬时错误上重试，不要在
`eval` 抛错时重试（那是脚本写错了，重试只是重复失败）。

### I-07 界面里的截图预览没有实测（截图是物理像素）

**发现于** 2026-11-20 · **优先级** 低 · **已修复** 2026-11-21（实测数据见下）

本轮只验证了 `/files/...?t=<token>` 返回 `200 image/png`、磁盘文件是有效 PNG，
**没有**验证界面里 `<img>` 的实际渲染。另外截图现在是物理像素（1264×689 的视口存成
2528×1378），若界面按 CSS 像素原样铺开，会显示成两倍大、糊成一团。

**建议**：在任务详情里给 `<img>` 加 `max-width:100%` 与 `image-rendering` 之类的约束，
或存图时按 dpr 缩一半。验证时任选一条：人工点开看一眼，或用 Playwright 断言
`img.naturalWidth > img.clientWidth * 1.5`。

**修法与实测（2026-11-21）**：缩略图改为 `max-width:100%` + `max-height:160px` +
`object-fit:contain`，外层 `<a>` 点开看原图。`npm run ui-smoke` 里真跑一条带截图的任务
（start → goto → screenshot → stop），再用 `page.evaluate` 量：

```
naturalW 1264  naturalH 609   clientW 328  clientH 158   容器宽 894
```

宽度收在容器内、高度按比例、没有溢出。第一版只写了 `max-width`，实测一张 894px 宽的预览
就把任务卡片撑得很长（dpr=1 时正好等于容器宽），所以才补 `max-height`。
真机 Retina（dpr=2）下 `naturalWidth` 会是 `clientWidth` 的两倍——这正是当初担心的场景，
现在由同一套约束兜住。

### I-08 没有「跟随系统代理」这个选项

**发现于** 2026-11-20 · **优先级** 低

TECH §16.2 把「无代理 = 直连」定成默认语义，这符合 AdsPower 一类的约定。但确实有用户
希望环境跟随系统代理（比如公司统一出口）。现在没有开关，只能给每个环境单独配代理。

**建议**：环境级 `networkMode: 'direct' | 'proxy' | 'system'`，默认 `direct`；
`system` 时不写 `network.proxy.type`（即保持 Firefox 默认的 5）。加这个字段前要先想清楚
它对「同一份配置在不同机器上表现不同」这个可复现性问题的影响。

---

## 二、已修复（留档）

| 编号 | 问题 | 定位方式 | 修法 |
|---|---|---|---|
| F-01 | 没配代理却走系统代理，全站 `NS_ERROR_PROXY_CONNECTION_REFUSED`，而 `curl` 正常 | 同一 URL 用 curl 直连 200、浏览器必挂；`scutil --proxy` 显示系统代理指向 7890 | 无 proxy 时写 `firefox_user_prefs.network.proxy.type=0`（TECH §16.2） |
| F-02 | 窗口尺寸从没设定过，永远 1280×720（Playwright 默认视口） | 任务里 `eval` 打 `innerWidth` 与 `screen.width` 对比 | ~~启动时显式传 `viewport`~~ **（更正 2026-11-21：那个参数从未生效，见 O-02；真正起作用的是 F-04 的 config `window.*`）** |
| F-03 | `innerHeight = height - 120 * dpr`，Retina 上窗口凭空矮 1/4 屏 | 同上，实测 960 vs 689 | 窗口 chrome 是逻辑像素，去掉 `* dpr` |
| F-04 | 引擎把 1280 宽的屏幕抬回 1366（现代设备下限），又出屏幕范围 | 收缩到 1280 后 preset 仍报 1366，读 `camoufox/dist/fingerprints.js:raiseScreenToModernFloor` | config 里显式写 `screen.*` / `window.*`，让 `userSetScreenWindow` 为真、跳过整段修正 |
| F-05 | 宿主屏幕探测在桌面壳下静默失败 | 精简 PATH（`/usr/bin:/bin`）跑 `system_profiler` 直接 ENOENT | 改绝对路径 `/usr/sbin/system_profiler`，失败再试下一个候选 |
| F-06 | `live-task.ts` 建任务没传 `runNow`，任务停在 `queued` | 任务详情 `status: queued` 而脚本已判定"结束" | 补 `runNow: true`；`waitTask` 同时把 `queued` 视作"还没开始"，继续等 |
| F-07 | 采集脚本选择器写错（`.small` / `.quote .small`），作者全 `null` | 采集结果里 `author` 全是 null、`uniqueAuthors` 为 0 | 改成 `.author`，同时用 `textContent` 并去掉首尾引号 |
| F-08 | `npm run app` 窗口闪退，只报「窗口已关闭」，原因是 Chrome 沙箱初始化被拒 | 子进程 stderr 被设成 `ignore`，全靠手工单独跑 Chrome 才看到 `sandbox initialization failed: Operation not permitted` → GPU 进程连崩 → `FATAL: GPU process isn't usable` | `spawnShell()` 接住 stderr 留尾巴；30 秒内带崩溃标记退出时打印最后几行，确认是沙箱被拒就带 `--no-sandbox` 重试一次（只放宽本次启动） |
| F-09 | 桌面壳被强杀或崩溃后，Node 后端变成孤儿，端口一直占着 | `killall foxbox-desktop` 之后 `lsof -iTCP:65284 -sTCP:LISTEN` 仍有 node；壳里只有 `RunEvent::Exit` 才调 `stop_child()`，SIGKILL/崩溃不会走到 | 壳启动后端时传 `FOXBOX_PARENT_PID`；后端每 5s `kill(pid,0)` 探活，父进程没了就走同一条优雅关闭（只对桌面壳生效，`npm run serve` 不受影响） |

## 三、环境侧（非代码）

### E-01 本机 ClashX 的 7890 端口不可用

**发现于** 2026-11-20 · **状态** 待用户处理

`lsof` 显示 ClashX 在 7890 监听，`curl -x http://127.0.0.1:7890 https://example.com`
能建立 CONNECT 隧道（`HTTP/1.1 200 Connection established`），但随后 TLS 握手失败
（`SSL_ERROR_SYSCALL`），直连同一站点是 200。

**影响**：任何配了这个代理的环境启动后都打不开网页。F-01 修完之后，没配代理的环境
不再受影响——但配了的环境照样挂，而且报错看起来像目标站点的问题。

**处理**：换节点或检查 ClashX 的规则/订阅；确认后再用它做代理相关验收（`npm run m2 -- --proxy=...`）。

## 四、待确认

### O-01 点窗口红灯是否会退出 app 并回收后端

**2026-11-21 部分确认**：区分两种「关」——

| 关闭方式 | 是否回收后端 | 依据 |
|---|---|---|
| 点红灯 / `RunEvent::Exit` | 会（`stop_child()` 先 SIGTERM，5 秒后强杀） | 壳日志里有 `[SIGTERM] 正在关闭所有环境...` |
| `killall` / 崩溃 / 强退 | **不会**，后端成孤儿占着端口 | 实测 `killall foxbox-desktop` 后 `lsof -iTCP:65284` 仍有 node 在 LISTEN |

后者已由 F-09 兜住（父进程看护）。剩下的只有「点红灯」这一点还需要人眼确认一次：
关窗后 `lsof -iTCP:<端口>` 看 node 是否还在；若还在，说明 Tauri 的默认关窗行为没有走到 Exit。

### O-02 无头模式下 viewport 是否同样生效（已确认：viewport 根本没生效）
**结论（2026-11-21）**：这个问题问错了方向。`Camoufox({ headless, from_options, ... })`
把 `viewport` 收进 `kwargs`，而 `kwargs` 只在没有 `from_options` 时才用——我们从第一版起就
一直传 `from_options`，所以那个参数**从未生效过**。实测 `page.viewportSize()` 恒为 `null`。
窗口尺寸实际来自 config 的 `window.innerWidth/innerHeight`（引擎据此 `applyNoViewport`）。
参数已删除，详见 RUNBOOK「坑二」。

原文：

本轮所有实测都是 headed。无头走的是同一条 `launch` 路径，理论上 `viewport` 一样生效，
但无头没有「窗口」这个概念，`outerWidth/outerHeight` 会退化成视口大小——此时
`innerHeight` 与 `outerHeight` 相等，反而是个破绽（真实窗口的 outer 一定大于 inner）。

**怎么确认**：建一个 `headless: true` 的环境，跑同一套自检脚本，看
`outer - inner` 是否为 0。若为 0，考虑无头模式不伪造 `window.outer*` 而让引擎自行处理。

---

### O-04 音频噪声能不能开（已确认：不能）

`camoufox/dist/fingerprints.js` 里写着 `audio:seed is gone`，配置里出现会被删除并告警：
「the browser renders audio as stock Firefox does」。也就是说这一版引擎没有音频噪声能力。

硬要做只能在 JS 层覆写 `AudioBuffer.getChannelData` 一类接口，代价是留下可检测面
（非 native 的 `toString`、属性描述符、`instanceof`）。这类补丁应该做在 C++ 层，
所以当前**不做**，界面上如实显示「不支持」，而不是放一个永远为 false 的开关。

### O-03 能不能给外部一个 CDP 链接（已确认：不能）

**结论（2026-11-21）**：两个独立原因，缺一都不行。

1. Camoufox 是 Firefox，走 Juggler，没有 CDP——这是 PRD §4.5 / TECH §6.3 早就写过的硬限制。
2. 即使不考虑协议，`camoufox/dist/server.d.ts` 明写 `launchServer()` **不支持 persistent context**：
   Playwright 的 `PlaywrightServer` 只接受刚启动的 Browser，没法把持久化上下文挂成 ws 端点。
   而我们的环境必须持久化（身份靠 `user_data_dir` 跨会话保持）。

所以「换个参数给出 ws 链接」不存在。M10 交付的形态是 **HTTP 脚本执行**：
`GET /api/profiles/:id/automation` 如实返回 `cdp: null` + 原因 + 可粘贴示例，
`POST /api/profiles/:id/run-script` 执行采集脚本。详见 TECH §18、RUNBOOK「M10 运行」。

如果将来引入 Chromium 引擎（PRD §9 的备选），`EngineAdapter.cdpEndpoint` 字段还在，
到那时再谈 CDP 才有意义。

---

## 复现方式

上面涉及任务的条目，都可以用同一条脚本复现（不需要另写测试）：

```bash
npx tsx scripts/live-task.ts --keep    # 采集 + 全页/视口截图 + 故意失败的脚本
```

涉及屏幕的，把任务里的 `eval` 换成：

```js
({ screen: [screen.width, screen.height], avail: [screen.availWidth, screen.availHeight],
   inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight],
   dpr: devicePixelRatio, screenX, screenY })
```

正常环境应满足：`inner < avail ≤ screen`、`outer - inner ≈ 85`、`screenX/Y` 非负。
