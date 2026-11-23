# FoxBox

本地优先的多环境浏览器工作台。为每个业务账号提供一套**独立、自洽、跨会话稳定**的浏览器身份（指纹 + 存储 + 出口 IP）。

## 文档

- [需求文档（PRD）](./docs/PRD.md) — 目标、功能需求、验收标准、里程碑、合规约束
- [技术设计（TECH）](./docs/TECH.md) — 选型、架构、数据模型、模块设计、API
- [运行手册（RUNBOOK）](./docs/RUNBOOK.md) — 环境准备、验收脚本、实测记录、常见失败
- [问题台账（ISSUES）](./docs/ISSUES.md) — 已知问题、优先级、已修项留档、待确认项
- [MVP2 方案（MVP2）](./docs/MVP2.md) — M6–M9 的需求取舍、技术方案、验收断言

## 技术栈

TypeScript · Node ≥ 22.15 · Camoufox（Firefox 引擎）· SQLite（node:sqlite）· Fastify
界面：零依赖静态页（`ui/`），由同一个本地服务托管，无构建步骤
桌面：`--app` 窗口（零依赖）/ Tauri 2 原生壳（需 Rust ≥ 1.77，已实测可构建）

## 快速开始

```bash
npm install
npx camoufox fetch          # 下载浏览器内核，约 1.2GB
npm run m1                  # M1 闭环验收：创建 → 启动 → 自检 → 关闭 → 复用
npm run m2 -- --proxy=http://127.0.0.1:7890   # M2 验收：预检、分组、环境管理
npm run m3                  # M3 验收：界面托管、批量操作、离线校验
npm run m4                  # M4 验收：任务编排（加 -- --no-browser 跳过真实启动）
npm run m5                  # M5 验收：定时触发与代理失效钩子（加 -- --no-proxy 跳过巡检）
npm run m6                  # M6 验收：数据落地（collect 步骤、去重、增量、CSV/JSONL 导出）
npm run m7                  # M7 验收：会话巡检（三态判定、边沿告警、并发与取消；-- --quick 少跑几个环境）
npm run m8                  # M8 验收：可靠性（超时/重试/通知聚合/签名/TTL 清理）
npm run m9                  # M9 验收：身份健康（自检标记、跨平台屏幕解析）
npm run m9:repair           # 可行性验证：能不能"只修屏幕"（结论落 .foxbox-m9-repair.json）
npm run m10                  # M10 验收：外部自动化（automation 连接信息 + run-script 脚本执行）
npm run m11                  # M11 验收：身份三件套（地理坐标回填、dpr 接管、canvas 覆盖开关）
npm run bili -- --mode popular --limit 50   # 示例采集：B 站视频（popular/search/video，加 --detail 补逐条详情）
npm run restart-check       # 启动稳定性自检：同一环境连续启停 N 次（-- --headed 用有头模式）
npm run ui-smoke            # 界面冒烟：用自家引擎截图环境/数据/任务/弹窗到 .foxbox-ui-smoke/
npm run serve               # 起服务，浏览器打开 http://127.0.0.1:7331
npm run app                 # 桌面模式：起服务 + 开一个无地址栏的独立窗口
npx tsx scripts/live-task.ts  # 对着正在运行的实例跑采集+截图冒烟（读 /tmp/fox.env 的端口与 token）
```

界面和 API 是同一个进程：`npm run serve` 之后直接开 `http://127.0.0.1:7331`，
页面会自动带上本次运行期生成的 token（只在本机 Host 下有效）。

## 当前阶段

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 引擎可行性：启动、指纹读取、跨会话稳定性 | ✅ 通过 |
| M1 | 环境生命周期：创建 → 启动 → 自检 → 关闭 → 复用 | ✅ 通过 |
| M2 | 代理预检、分组、环境查询/更新、错误语义 | ✅ 通过 |
| M3 | 管理界面：环境列表/状态灯、指纹详情、代理预检、审计；批量操作；离线校验 | ✅ 通过 |
| M4 | 任务编排：六种步骤、逐目标执行、截图留证、取消 | ✅ 通过 |
| M5 | 定时与事件触发：cron 调度、代理巡检钩子、触发历史 | ✅ 30/30 |
| M5 | 桌面壳：`--app` 窗口、Tauri 原生壳（Rust 1.100 / tauri 2.12.7 实测打包并启动） | ✅ |
| M6 | 数据落地：`collect` 步骤、去重 upsert、增量与首次时间、CSV/JSONL 流式导出 | ✅ 32/32 |
| M7 | 会话巡检：alive/expired/**unknown** 三态、边沿触发、并发 3、可取消 | ✅ 15/15 |
| M8 | 可靠性：任务级超时与分类重试、通知聚合+签名+退避、证据/资产分离的 TTL | ✅ 13/13 |
| M9 | 身份健康：启动自检打标（不提供局部修复，已验证不可行）、Windows 屏幕探测 | ✅ 6/6 |
| M10 | 外部自动化：`automation` 连接信息（无 CDP，如实说明原因）、`run-script` 两种模式、界面自动化页 | ✅ 10/10 |
| M11 | 身份补全：geolocation 按出口回填、dpr 交由引擎接管并纳入自检、canvas 三态覆盖开关 | ✅ 10/10 |

## 目录

```
src/
├── core/
│   ├── db/            # node:sqlite 连接、schema、版本迁移
│   ├── repositories/  # profile / group / proxy / launch / audit
│   ├── services/      # 业务编排（环境、代理预检、分组、任务、自动化调度）
│   ├── automation/    # cron 解析与 next-run 计算（纯函数，零依赖）
│   ├── net/           # 代理隧道（CONNECT / SOCKS5）、原始 HTTP、出口 IP 探测
│   ├── engines/       # 引擎抽象、Camoufox 适配器、生命周期管理、预热
│   ├── crypto/        # 代理密码本地加密（AES-256-GCM）
│   ├── errors.ts      # 带 HTTP 语义的业务错误
│   └── paths.ts       # FOXBOX_HOME 布局
├── fingerprint/       # preset 生成、固化（freeze）、一致性校验
├── api/               # 本地 HTTP API + 静态资源托管
└── main.ts            # 服务入口

ui/                    # 界面（index.html / style.css / app.js），无构建步骤

desktop/               # 桌面壳（Tauri 2）
├── src-tauri/         # Rust：分端口 → 起后端 → 等就绪 → 导航窗口
├── shell/             # 启动页（失败原因直接写在这里，不白屏）
└── icon.svg           # 图标源文件（npx tauri icon 生成全套）
```

## 自动化

`cron` 规则到点跑任务；`proxy_watch` 规则定期巡检代理，连续失败达阈值时
切到同国家备用代理 / 关闭相关环境 / 跑任务。三条刻意的取舍：

- **不补跑**——错过的触发只记一条「跳过」，不在重启后集中补执行
- **心跳不落历史**——巡检无异常时不写记录，只有跨阈值和恢复才留
- **同国家才切换**——指纹里的时区与语言绑在出口国家上，换国等于让 IP 与时区自相矛盾

详见 [运行手册 · M5](./docs/RUNBOOK.md) 与 [技术设计 · 15](./docs/TECH.md)。

## 合规

仅用于管理自己拥有或已获授权运营的账号。不提供批量注册、绕过封禁、IP 池等能力。详见 PRD 第 8 节。
