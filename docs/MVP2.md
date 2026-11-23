# FoxBox MVP2 需求取舍与技术方案（M6–M9）

| 项目 | 内容 |
|---|---|
| 文档类型 | 需求取舍 + 技术方案（PRD 增量，配合 TECH 阅读） |
| 版本 | MVP2 / v1.0 |
| 日期 | 2026-11-20 |
| 前置 | MVP1（M0–M5）全部交付并实测通过 |
| 一句话 | MVP1 解决「能不能隔离」，MVP2 解决「隔离之后拿它干什么」 |

---

## 0. 结论先行

MVP2 的主题是**从「能跑脚本」到「能产出可以拿去做决定的结论」**。

三条 P0 + 一条质量收尾：

| 里程碑 | 主题 | 一句话 |
|---|---|---|
| **M6** | 数据落地 | 采集结果不再是一段 JSON 字符串，而是一张可去重、可增量、可导出的表 |
| **M7** | 会话健康 | 50 个环境里哪些掉登录了，一屏看完，而不是一个个点开 |
| **M8** | 可靠性 | 任务有总时限会重试，失败会主动通知，磁盘不会无声涨满 |
| **M9** | 身份健康 | 旧环境的矛盾指纹变得可见，能修才修，不能修就老实说 |

明确不做：云同步/团队协作、可视化编排、多引擎、代理池、Windows 全量适配（只补一处探测）。

---

## 1. 现状盘点

### 1.1 MVP1 实际交付了什么

| 能力 | 实现位置 | 已验证 |
|---|---|---|
| 环境 CRUD / 分组 / 批量 / 软删除 | `profile.service.ts`、`group.service.ts` | M1/M3 |
| 指纹固化（创建时生成、此后不漂移） | `fingerprint/freeze.ts` | M1 9/9 零漂移 |
| 代理 CRUD、加密封存、预检、国家推断 | `proxy.service.ts`、`net/ip-probe.ts` | M2 |
| 启动阻断（代理失效 / 国家不符） | `profile.service.ts` 健康检查 | M2 |
| 任务编排（start/goto/wait/eval/screenshot/stop） | `task.service.ts` | M4 18/18 |
| 定时（自写 cron）+ 事件钩子（代理巡检） | `automation/cron.ts`、`automation.service.ts` | M5 33/33 |
| 桌面壳（Tauri）+ 启动幂等 | `desktop/`、`profile.service.ts` | M5 实测 |

一句话：**单个环境的「身份 → 存储 → 出口」闭环是真的通了**，而且是被实测数字验证过的，不是配出来的。

### 1.2 但按「运营的一天」推演一遍，断点全在闭环之外

把工具交给一个真的要管 30 个店铺的人，他一天会这样用：

| 时刻 | 他想做的事 | 现在的现实 |
|---|---|---|
| 早上 9:00 | 看哪些环境还活着、哪些要重新登录 | **不知道**。列表只有 idle/running，登录态和运行状态是两件事 |
| 上午 10:00 | 跑一遍采集，把今天的价格拉下来 | 能跑。但结果是 `result_json` 里的一段字符串，要打开任务详情、选中、复制、粘到 Excel 里手工拆 |
| 下午 15:00 | 跟昨天的数据比一比 | **做不到**。昨天的结果在另一条任务的 JSON 里，没有主键、没有去重、没法 join |
| 夜里 3:00 | 定时任务自动跑 | 跑了，但失败没人知道。第二天打开界面才发现「昨天 3 点就挂了」 |
| 一周后 | —— | 磁盘多了 1.8GB，`screenshots/` 和 `profiles/` 各占一半，不知道该删谁 |

这五条断点里，**没有一条是「引擎不够好」**。引擎已经够好了。断在「产出的东西没有出口」。

### 1.3 台账里挂着的，正好是这几条

| 编号 | 问题 | MVP2 归属 |
|---|---|---|
| I-05 | 删任务不删截图，磁盘只增不减 | M8 |
| I-06 | 任务级没有总超时与重试 | M8 |
| I-01 | 旧环境矛盾指纹不可见、不可修 | M9 |
| I-02 | Windows 缺宿主屏幕探测 | M9 |
| I-04 | `preset.dpr` 是推断值 | M9 |
| I-07 | 截图预览未实测（物理像素） | M8（顺手） |
| I-08 | 没有「跟随系统代理」选项 | 不做，见 §3.3 |

---

## 2. 需求取舍

### 2.1 七个候选方向

| 方向 | 价值 | 改动面 | 结论 |
|---|---|---|---|
| A. 采集数据落表 + 导出 | 高：自动化终于有产出物 | 新表 2 张、新步骤 1 种、导出 1 条路由 | **做（M6）** |
| B. 登录态巡检 | 高：多账号运营最痛的日常 | 新表 2 张、复用启动链路、新视图 1 个 | **做（M7）** |
| C. 任务超时/重试 + 通知 + 生命周期 | 高：A、B 上线后没有它就是半成品 | 改任务服务、新表 2 张 | **做（M8）** |
| D. 旧环境身份修复 + Windows 探测 | 中：质量债，影响可信度 | 小 | **做（M9，降级为收尾）** |
| E. 云同步 / 团队协作 / 权限 | 中：能卖更贵 | 极大：等于重做一套后端 | 不做 |
| F. RPA 可视化编排 | 低：看着像卖点 | 极大 | 不做，理由见 §2.3 |
| G. 内置代理池 / 自动换 IP | — | 中 | **不做，合规红线（PRD §8）** |

### 2.2 为什么是这个顺序

**M6 排第一，因为它是「价值兑现点」。**
MVP1 花了五个里程碑做的事，本质上是「让一台机器上能安全地同时开 30 个身份」。这件事本身不产生任何业务结果。业务结果是那 30 个身份去后台看到了什么。现在这个「什么」只存在于一段没人看的 JSON 里。先把出口打通，前面五个里程碑才第一次变成可交付的东西。

**M7 排第二，因为它是「留存点」。**
数据管道解决「能拿到」，会话巡检解决「知道什么时候拿不到」。后者是多账号运营每天第一件要做的事，也是这类工具最高频的使用场景。而且它有一个隐性的好处：**巡检会自然地让用户每天都打开这个界面**，而不只是需要跑任务时才想起来。

**M8 排第三，但它是「M6/M7 的必要配套」。**
M7 的巡检如果不通知，价值掉一半——用户还是得主动打开界面看。M6 的定时采集如果失败了不说，用户会拿着三天前的数据做决定，这比没有数据更危险。所以 M8 不是「锦上添花」，是 M6/M7 上线前必须一起做完的部分。放在第三个只是因为它依赖前两者的数据结构。

**M9 最后，因为它不产生新能力，只修复可信度。**
而且它有一步必须先验证（见 §4.5.1），不能先承诺再实现——这个项目已经在「先实测再下结论」上吃过甜头（TECH §16 两个 bug 都是实测出来的），继续按这个来。

### 2.3 一个被明确否掉的方案：可视化采集编排

**看起来的方案**：界面里点一下页面元素，自动生成选择器，拖几个字段组成表格。

**为什么不做的三条理由**：

1. **选择器会坏，而且坏得没有规律。** 后台类页面的 DOM 一周换一次，可视化点选生成的选择器是「第 3 个 div 下的 span」，一改就废。而用户自己写的 `querySelectorAll('.order-row')` 至少语义上还能看懂、能自己修。
2. **两层抽象是净负担。** 我们已经有 `eval`（任意 JS）和 `collect`（JS + 落库）。在它们之上再加一层「可视化 DSL」，等于让用户学两套东西，其中一套还更弱。
3. **成本错配。** 做一个能用（而不是能演示）的可视化编排，工作量大于 MVP2 剩下所有部分之和，而它服务的是「不想写代码的人」——这类用户本来也不是本产品的目标用户（PRD §3.1 全是运营/投放/QA，日常就要写点脚本）。

**替代方案**：`collect` 步骤接受一段返回数组的 JS，配一个「示例脚本库」（每个内置示例就是一个能直接跑的 `querySelectorAll` 循环）。用户改三行就能用，比点选更快，也比点选更抗改版。

---

## 3. MVP2 范围

### 3.1 对 PRD 的功能增量

| 编号 | 需求 | 优先级 | 验收要点 |
|---|---|---|---|
| F-80 | `collect` 步骤：页面脚本返回数组 → 写入数据集 | P0 | 三次采同数据行数不变；超限失败而非截断 |
| F-81 | 数据集管理：列表、字段、行数、最近更新 | P0 | 100 个数据集下列表不卡 |
| F-82 | 导出 CSV / JSONL（流式） | P0 | 中文不乱码；10 万行不 OOM |
| F-83 | 去重与增量：`dedupeBy` 或全字段哈希，冲突时更新 | P0 | 更新不重置 `first_seen_at`；`seen_count` 累加 |
| F-84 | 登录态探针：URL + 判定规则（元素 / URL / 脚本） | P0 | 三种规则都能判出 alive/expired |
| F-85 | 批量巡检：并发受限、可取消、进度可见 | P0 | 打不开的页面判 `unknown` 而不是 `expired` |
| F-86 | 会话状态展示：列表灯 + 顶部汇总 | P0 | 巡检不改变「最后打开时间」 |
| F-87 | 任务级 `timeoutMs` / `retries`，错误分类重试 | P1 | `eval` 报错不重试；导航超时可重试 |
| F-88 | 通知通道（Webhook）+ 60s 聚合 | P1 | 50 条同时过期只发 1 条 |
| F-89 | 存储生命周期：截图/历史 TTL、占用可视 | P1 | 清理留审计；数据集永不自动删 |
| F-90 | 身份健康标记（启动自检差异） | P2 | 不一致的环境在列表有角标 |
| F-91 | 身份局部修复（仅屏幕），**验证通过后才做** | P2 | 只改 screen 时 canvas/WebGL 采样不变 |
| F-92 | Windows 宿主屏幕探测 | P2 | 注入样本可解析；拿不到返回 null |

### 3.2 里程碑与出口标准

| 阶段 | 交付物 | 出口标准 | 状态 |
|---|---|---|---|
| **M6 数据落地** | `collect` 步骤、datasets/dataset_rows、导出 | `npm run m6` 全绿（32 项） | ✅ 32/32 |
| **M7 会话巡检** | session_probes/session_checks、巡检 runner、会话列 | `npm run m7` 全绿（15 项） | ✅ 15/15 |
| **M8 可靠性** | 任务超时重试、通知通道、保留策略、占用面板 | `npm run m8` 全绿（13 项） | ✅ 13/13 |
| **M9 身份健康** | 健康标记、Windows 探测 | `npm run m9` 全绿；repair 的结论有实测依据 | ✅ 6/6（repair：**不可做**，见 §4.5.1 实测结论） |

### 3.3 明确不做

| 不做 | 原因 |
|---|---|
| 云同步 / 团队 / 权限 / 计费 | 与「本地优先、单机、数据不出门」（PRD §6）直接冲突，做了要先毁掉现在的隐私设计 |
| 可视化编排 | §2.3 |
| Chromium / patchright 引擎接入 | 引擎抽象留着就够了，现在没有任何一个需求是 Camoufox 做不到的 |
| 内置代理池、自动换 IP | 合规红线 |
| 数据集自动清理 | 数据是资产，不是缓存。详见 §4.4.4 |
| I-08「跟随系统代理」 | 它会破坏「同一份配置在任何机器上表现一致」这个可复现性前提，收益远小于代价 |
| 环境模板市场 / 账号批量注册类辅助 | 合规 |

---

## 4. 技术方案

### 4.1 结构变化总览

```
src/core/
├── services/
│   ├── dataset.service.ts        # 新增：写入、去重、分页、导出
│   ├── session.service.ts        # 新增：探针定义、巡检 runner、边沿判定
│   ├── notify.service.ts         # 新增：事件聚合、webhook 投递、重试
│   ├── retention.service.ts      # 新增：TTL 扫描、占用统计
│   └── task.service.ts           # 改：deadline、错误分类、collect 分支
├── repositories/
│   ├── dataset.repo.ts           # 新增
│   ├── session.repo.ts           # 新增
│   └── notify.repo.ts            # 新增
├── engines/
│   ├── types.ts                  # 改：PageLike 不动；EngineAdapter 加 newPage()
│   └── camoufox.adapter.ts       # 改：newPage 走 context.newPage()
└── automation/
    └── cron.ts                   # 不改

scripts/fixtures/login-site.ts    # 新增：本地假站点（验收的地基，见 §7.1）
scripts/m6-demo.ts  m7-demo.ts  m8-demo.ts  m9-demo.ts
```

一处分层判断：**数据集写入不放 repository，放 service。** 因为「推断 schema、算哈希、超限判断、累加计数」是业务规则，不是 SQL；repo 只做 `insertOrUpdate` / `page` / `sumBytes` 这类原子操作。这是 M5 `automation.service.ts` 已经验证过的切法，继续沿用。

### 4.2 M6 数据落地

#### 4.2.1 `collect` 步骤

```ts
| {
    type: 'collect';
    /** 在页面内执行，必须返回数组，每项是一个对象 */
    script: string;
    /** 数据集名（不是 id）：脚本里写死名字，配置才能导入导出 */
    dataset: string;
    /** 用哪几个字段判重；缺省 = 全字段哈希 */
    dedupeBy?: string[];
    /** 默认 upsert：同键更新。append：只插入，重复也算新行 */
    mode?: 'upsert' | 'append';
    /** 少于这么多行算失败（默认 0 = 空也算成功） */
    expectMinRows?: number;
    timeoutMs?: number;
  }
```

三个语义决定，都需要写进 UI 提示里：

1. **`dataset` 用名字不用 id。** 任务 JSON 是会被复制、导出、贴到另一个环境里跑的（PRD F-52 的迁移场景）。写 id 的话换一台机器就断。名字的唯一性由 `datasets.name UNIQUE` 保证，冲突时**复用**已存在的数据集，不报错——这正是「同一个数据集被多条任务往里写」的正常用法。
2. **拼错数据集名等于新建一张表。** 这是这个设计唯一的坑：`orders` 打成 `order`，数据就进了另一张表，而且不报错。缓解：任务详情里回显「写入数据集：orders（新增 12 / 更新 0）」，让人一眼看见写进去了；再加一个「最近 7 天没有写入的数据集」提示（不删，只提示）。
3. **`expectMinRows` 是显式的，不猜。** 默认 0，因为「今天真的没有新数据」是完全正常的业务状态；但涉及「必须拿到数据才算成功」的场景，用户要自己写 `expectMinRows: 1`。

#### 4.2.2 数据模型（迁移 v4）

```sql
CREATE TABLE IF NOT EXISTS datasets (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  schema_json  TEXT NOT NULL,   -- [{ key, type, addedAt }]，按首次出现顺序
  dedupe_json  TEXT NOT NULL,   -- { mode: 'fields' | 'hash', fields: [] }
  row_count    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dataset_rows (
  id               TEXT PRIMARY KEY,
  dataset_id       TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  dedupe_key       TEXT NOT NULL,
  data_json        TEXT NOT NULL,
  first_profile_id TEXT,          -- 谁最先看到它
  last_profile_id  TEXT,          -- 谁最后看到它（多账号价格差异时有用）
  first_task_id    TEXT,          -- 故意不加外键，理由见 §4.4.4
  first_seen_at    INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL,
  seen_count       INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dataset_rows ON dataset_rows(dataset_id, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_dataset_rows_recent ON dataset_rows(dataset_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_dataset_rows_profile ON dataset_rows(dataset_id, last_profile_id);
```

`row_count` 存在 datasets 上是冗余，但它让列表页不用对 `dataset_rows` 做 `COUNT(*)`（10 万行时是一次全索引扫描）。写入时同一个事务里 `+n`，代价可忽略。

`first_profile_id` / `last_profile_id` 是**这个产品特有的字段**，通用爬虫不会这么设计：同一件商品，A 账号看到的价格和 B 账号看到的不一样，运营要能回答「这个价是谁看到的」。

#### 4.2.3 去重与增量

```
dedupe_key = sha256hex(canonicalJson(按 dedupeBy 取出的子对象)).slice(0, 32)
dedupeBy 缺省 → canonicalJson(整行)
```

- 用哈希而不是原始字符串：原始值可能是一段 40KB 的商品描述，直接进唯一索引会让索引体积翻几倍。
- `canonicalJson` 递归按 key 排序，保证 `{a:1,b:2}` 与 `{b:2,a:1}` 哈希一致。**这一步不做，去重会随机失效**——对象 key 顺序在 JS 里是插入序，页面脚本换个写法就变了。

写入语义（`mode: 'upsert'`）：

```sql
INSERT INTO dataset_rows (id, dataset_id, dedupe_key, data_json,
                          first_profile_id, last_profile_id, first_task_id,
                          first_seen_at, last_seen_at, seen_count)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
ON CONFLICT(dataset_id, dedupe_key) DO UPDATE SET
  data_json        = excluded.data_json,
  last_profile_id  = excluded.last_profile_id,
  last_seen_at     = excluded.last_seen_at,
  seen_count       = seen_count + 1;
```

`first_seen_at` / `first_task_id` **不更新**。这两个字段是「这条数据什么时候第一次出现」的唯一凭证，被覆盖掉就再也查不出来了。这也是「增量采集」能成立的基础：`WHERE first_seen_at > 昨天` 就是今天的新增。

`mode: 'append'` 用于「流水」类数据（每次执行都是一条新记录，比如日志）。此时 `dedupe_key` 用 `ulid()`，永冲突。

#### 4.2.4 三处硬限制（必须有，不能靠自觉）

| 限制 | 值 | 超限行为 | 为什么必须有 |
|---|---|---|---|
| 单次 `collect` 行数 | 2000 | 整步失败 | 5000 行的表格页面很常见；一次写入 5000 行会让 SQLite 的写事务从 10ms 涨到 400ms+，期间所有别的写操作排队 |
| 单行序列化后大小 | 8 KB | 整步失败 | 一行 200KB 的 HTML 快照会把 `data_json` 变成事实上的 blob 表 |
| 单批总量 | 4 MB | 整步失败 | 保证单次写事务 < 100ms，UI 和 API 都不卡 |

**超限一律失败，绝不静默截断。** 截断是最糟的选择：用户看到 2000 行，以为这就是全部，拿走去做决定。失败至少会让他知道「要分页采」。

错误信息要给出下一步动作，而不是只报错：

```
单次采集 5,214 行，超过上限 2000。
建议在脚本里翻页或分片，例如 Array.from(document.querySelectorAll('.row')).slice(0, 2000)，
或按日期/分类拆成多个 collect 步骤。
```

#### 4.2.5 导出

```
GET /api/datasets/:id/export?format=csv|jsonl&since=<ms>&profileId=<id>
```

- **CSV**：`\uFEFF` BOM 开头 + `\r\n` 换行。BOM 不是洁癖——macOS 的 Excel 没有它会按 GBK 猜，中文列名和中文内容一起变乱码。
- **列顺序**：按 `schema_json` 的顺序，不按行内 key 顺序。后来的行缺字段补空，多出来的字段追加到末尾（schema 是并集）。
- **流式**：`reply.raw` 每 1000 行 write 一次，不全量拼字符串。10 万行 × 平均 300B ≈ 30MB，拼起来会让进程 RSS 瞬间多 60MB。
- **文件名**：`Content-Disposition` 用 RFC 5987 的 `filename*=UTF-8''<percent-encoded>`，否则中文数据集名在 Safari 下会变成 `download`。
- **JSONL**：一行一个对象，给脚本用。`jq -s` 就是一张表。

#### 4.2.6 空结果不算失败（这条最容易做错）

`collect` 返回 0 行时，**步骤状态是 `ok`**，`note` 写「采到 0 行」。理由：

- 「今天没有新订单」是正常业务状态，不是错误。
- 如果判失败，定时任务每天早上都会因为「周末没数据」报一次红，一周之内用户就会把这个告警关掉——**然后真正的失败也一起被关掉了**。

对应的反面：`expectMinRows` 明确写了 1，那就按失败处理，因为用户已经声明了「必须拿到」。

这与 M5 `concludeTaskRun` 的逻辑是同一套思路：以用户声明的意图为准，不以系统猜的为准。

#### 4.2.7 任务结果里的回执

`TaskStepResult` 加一个可选字段：

```ts
collect?: { dataset: string; written: number; inserted: number; updated: number; skipped: number };
```

任务详情里显示「写入 orders：新增 30 / 更新 12」。这个回执是「采集真的发生了」的唯一证据——没有它，用户只能去数据页猜。

### 4.3 M7 会话巡检

#### 4.3.1 为什么不能用 Cookie 的过期时间

最直觉的做法是读 Cookie 的 `expires`。实际做不到：

- 大量站点的会话 Cookie 是 **session cookie**，没有 `expires`，关浏览器就没，但服务端 session 还活着。
- 有些站点用 `httpOnly` + 短 access token + refresh token，Cookie 一直在，但已失效。
- 真正的失效信号在服务端，`Set-Cookie: xxx=; Max-Age=0` 只在「它想告诉你」的时候才出现。

所以：**唯一可信的判据是「打开一个只有登录后才能看到的页面，看结果」。** 这是笨办法，但它是唯一诚实的办法。文档里必须写清楚这一点，否则实现时一定会有人试图去读 Cookie。

#### 4.3.2 三态判定，`unknown` 是设计核心

| 状态 | 含义 | 判定 |
|---|---|---|
| `alive` | 登录态有效 | 页面正常打开，规则满足 |
| `expired` | 登录态失效 | 页面**正常打开**，但规则不满足 |
| `unknown` | 判断不了 | 打不开 / 超时 / 代理失败 / 站点 5xx / 落地到第三方域 |

`unknown` 单独存在的原因是：**把「探针自己挂了」当成「账号掉登录了」，是这类功能最常见的死法。**

代理一挂，50 个环境同时报 `expired`。用户挨个去重新登录，发现账号好好的。一次之后，这个红点就再也没人看了——而它本来是整个产品最该被信任的信号。

所以 `unknown` 必须有，而且在 UI 上是**灰色问号**而不是红色。红色只留给真正确认过的 `expired`。

判定顺序写死（顺序本身就是规则）：

```
1. goto 超时 / 代理错误 / DNS 失败      → unknown
2. 落地 URL 的 host 与探针 host 不同
   且不是已知的登录域                    → unknown（被劫持/被墙/被 CDN 错误页接管）
3. 页面主文档状态 >= 500                → unknown（服务端自己挂了）
4. 规则求值为真                          → alive
5. 其余                                  → expired
```

第 2 步的「已知登录域」需要一个白名单：`login.`、`passport.`、`/login`、`/signin`、`accounts.` 这类常见前缀。命中白名单说明是「被规则性地重定向到登录页」——这才是真正的 `expired`。

#### 4.3.3 探针的三种规则

```ts
type ProbeRule =
  | { type: 'selector'; selector: string; visible?: boolean }  // 元素存在即可
  | { type: 'url'; mustNotMatch: string }                      // 落地 URL 不应匹配此正则
  | { type: 'script'; script: string };                        // 返回 boolean（最灵活）
```

- `selector` 是最常用也最脆的一种（后台改版就废），但它是唯一「一眼看懂」的。
- `url` 适合「未登录必跳 /login」的站点，最稳。
- `script` 兜底，比如 `() => !!document.cookie.match(/sid=/)`。

UI 上默认推荐 `url`（最稳），并在用户选 `selector` 时提示「改版后需要更新」。

#### 4.3.4 执行模型

```
POST /api/probes/:id/run  → { jobId }
```

- **job 只存内存**，不落库。重启后进度丢失可以接受，因为每条检查结果都实时写进 `session_checks`，事实不会丢。这与 M5「心跳不落历史」的判断一致。
- **并发 3**（`FOXBOX_PROBE_CONCURRENCY`），复用 `EngineManager.maxConcurrent` 的排队逻辑。50 个环境 × 单次 ~8s ≈ 2.5 分钟。
- **环境本来没开**：`start()` → 检查 → `stop()`。这条路径会走完整的启动链路（4–5s）。
- **环境本来就开着**：**不能复用任务正在用的那个 page**（会把用户正在看的页面导航走），也不能抢焦点。所以给 `EngineAdapter` 加一个 `newPage(handle)`——camoufox 走 `context.newPage()`，检查完 `close()`。用户窗口里的页面一动不动。
- **不改变 `last_opened_at`**：那是「用户打开过」的语义，巡检是系统行为。要记就记在 `session_checks` 里。
- **可取消**：复用任务的 `AbortSignal` 机制，取消后剩余环境标 `skipped`。

#### 4.3.5 风控代价必须写在界面上

巡检 = 反复「启动 → 打开后台 → 关闭」。这个动作序列对平台来说就是一个行为特征。所以：

- 默认**不设置定时**（`intervalHours: null`），只有用户手动点「立即巡检」。
- 如果用户设了定时，最短 6 小时，且弹一次确认：「频繁巡检可能被目标站点识别为异常访问，建议每天一次」。
- 巡检产生的启动/停止在 `audit_logs` 里记为 `session.check`，与用户手动 `profile.start` 区分开——出问题时要能查清「这个环境被自动动了多少次」。

#### 4.3.6 数据模型（迁移 v5）

```sql
CREATE TABLE IF NOT EXISTS session_probes (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  profile_id     TEXT REFERENCES profiles(id) ON DELETE CASCADE,
  group_id       TEXT REFERENCES groups(id) ON DELETE CASCADE,
  url            TEXT NOT NULL,
  rule_json      TEXT NOT NULL,
  interval_hours INTEGER,                       -- NULL = 只手动
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  CHECK ((profile_id IS NULL) <> (group_id IS NULL))   -- 二者必居其一
);

CREATE TABLE IF NOT EXISTS session_checks (
  id          TEXT PRIMARY KEY,
  probe_id    TEXT REFERENCES session_probes(id) ON DELETE CASCADE,
  profile_id  TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('alive','expired','unknown')),
  detail      TEXT,          -- 人话原因：'规则未命中 .user-avatar' / 'ERR_PROXY_CONNECTION_FAILED'
  elapsed_ms  INTEGER,
  checked_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_checks ON session_checks(probe_id, checked_at DESC);
```

`profiles` 加两列冗余（迁移 v5 一并做），列表页直接读，避免 50 行 × N 次查询：

```sql
ALTER TABLE profiles ADD COLUMN last_session_status TEXT;
ALTER TABLE profiles ADD COLUMN last_session_check_at INTEGER;
```

#### 4.3.7 边沿触发，不是电平触发

只有 `alive → expired` 的那一次算事件；连续 5 次 `expired` 只告警一次。这与 M5 的 `fail_streak` 跨阈值判定是同一个模式（TECH §15.4），直接复用那段逻辑的思路：

```ts
const changed = prev !== 'expired' && next === 'expired';
if (changed) notify('session.expired', { profileId, detail });
```

反面做法是「每次巡检到 expired 就通知」，结果是每天一条重复消息，用户第二天就静音了。

### 4.4 M8 可靠性与通知

#### 4.4.1 任务级 deadline 与重试

任务新增两个字段（迁移 v6 加列）：

| 字段 | 默认 | 上限 | 说明 |
|---|---|---|---|
| `timeoutMs` | 600000（10 分钟） | 3600000 | 整条任务的总时限，跨所有目标 |
| `retries` | 0 | 3 | 只对 `transient` 类错误重试 |

实现：`AbortSignal.any([cancelSignal, AbortSignal.timeout(timeoutMs)])`（Node 22 原生支持）。到点后与「用户取消」走同一条收尾路径，但 `error_class = 'timeout'`，任务状态仍是 `failed`。

**不新增 `timed_out` 状态**：`tasks.status` 是 SQLite 的 CHECK 约束，改它要重建整张表，代价远大于收益。用 `error_class` 区分即可，UI 上照样能显示「超时」。

**重试只重跑失败的那个目标**，不重跑整条任务。并发 4 跑 50 个环境，1 个失败就全部重来，是双倍浪费，还会重复写数据集（虽然有去重兜底，但 `seen_count` 会被虚增）。间隔固定 5s，最多 3 次。

#### 4.4.2 错误分类表（不能靠猜，要枚举）

| 错误 | 分类 | 重试 |
|---|---|---|
| `goto` 超时、`ECONNREFUSED`、`NS_ERROR_*`、`ERR_PROXY_*` | transient | ✅ |
| 目标主文档 5xx | transient | ✅ |
| 环境启动失败（非版本/配置错误） | transient | ✅ 1 次 |
| 环境启动失败（node 版本不够、user-data 锁） | permanent | ❌ |
| `eval` 抛错 | permanent | ❌ |
| `collect` 返回类型不对 / 超限 / `expectMinRows` 未达 | permanent | ❌ |
| 代理预检国家不符（启动前阻断） | permanent | ❌ |
| 任务级超时 | permanent | ❌ |

判定入口只有一个函数 `classifyError(err, context)`，不许在步骤里各写各的 `try/catch`——否则同一个错误在不同步骤里会被分成两类，重试策略就不可预期了。

#### 4.4.3 通知聚合（不聚合就会被自己淹没）

```sql
CREATE TABLE IF NOT EXISTS notifiers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('webhook')),
  url         TEXT NOT NULL,
  secret      TEXT,                  -- HMAC-SHA256 签名用，可空
  events_json TEXT NOT NULL,         -- ['task.failed','session.expired','proxy.dead']
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_logs (
  id           TEXT PRIMARY KEY,
  notifier_id  TEXT,
  event        TEXT NOT NULL,
  dedupe_key   TEXT,
  status       TEXT NOT NULL,        -- sent / failed / suppressed
  http_status  INTEGER,
  error        TEXT,
  payload_json TEXT,
  created_at   INTEGER NOT NULL
);
```

**聚合规则**：按 `(notifier, event)` 分桶，60 秒窗口。窗口内的所有条目合成一条消息再发。

```
单条：「环境 店铺-US-01 会话失效（规则未命中 .user-avatar）」
聚合：「3 个环境会话失效：店铺-US-01、店铺-US-03、投放-05」（items 里带详情）
```

60 秒不是拍脑袋：一次巡检 50 个环境要跑 2.5 分钟，如果每条发一次，一次巡检就是 50 条消息。而 60 秒能把「同一批巡检」压成 1–3 条。

投递：3 次指数退避（1s / 5s / 30s），失败落 `notification_logs` 后放弃，**不阻塞巡检主流程**。签名头 `X-FoxBox-Signature: sha256=<hmac(body, secret)>`，接收端才能确认来源。

#### 4.4.4 生命周期：证据和资产分开对待

这是本节唯一需要「判断」而不是「实现」的地方。

| 数据 | 性质 | 策略 |
|---|---|---|
| `screenshots/` | **证据**：为某次失败留证 | TTL 30 天，随任务删除一并清理（关掉 I-05） |
| `tasks` / `task_runs` 历史 | 过程记录 | TTL 90 天 |
| `automation_runs` | 过程记录 | TTL 180 天 |
| `dataset_rows` | **资产**：用户采到的业务数据 | **永不自动删** |
| `profiles/*` user-data | 状态：登录态在里面 | 只能随环境删除，不参与 TTL |

判据是一句话：**删了之后用户会不会损失他花钱/花时间换来的东西。** 截图和日志删了只是少个凭证，数据删了就是丢业务。

`dataset_rows.first_task_id` 因此不加外键、也不随任务删除：任务只是「产生数据的过程」，过程可以被清理，结果不能。

清理实现：`retention.service.ts`，每天跑一次（复用 M5 的单 tick 调度器，`kind: 'retention'` 不必新建表，直接用 `setInterval` + 兜底标记）。清理前后各记一条 `audit_logs` 汇总：`'清理 128 个截图目录、37 条任务记录，释放 240MB'`。**静默删除是不可接受的**，用户必须能看见「东西被删了」。

占用面板：`GET /api/system/storage`

```json
{ "screenshots": 812000000, "profiles": 3100000000, "database": 41000000, "datasets": 9600000 }
```

用 `du -sk` 的等价实现（递归 stat）。`profiles` 这一项通常才是最大的——一个 Camoufox user-data 40–80MB，50 个环境就是 3GB，而用户对此完全没有概念。

### 4.5 M9 身份健康

#### 4.5.1 先验证，再承诺（这是本里程碑的第一个任务）

I-01 的建议 2 是「只重算 screen/window，其余身份字段不动」。这个承诺能不能成立，取决于一件我们**还没验证过**的事：

> 在 Camoufox 里换掉 `fingerprint.screen`，会不会连带改变 canvas / WebGL / 字体采样？

理论上会：`getRandomPreset()` 返回的 fingerprint 里，`webgl` 的 renderer 字符串与 `screen` 都来自同一份设备样本表（TECH §15 / §16.1 提到 webgl 采样与 screen 是绑定的）。如果它们是一起抽的，那「只改屏幕」就是做不到的。

所以第一个交付物不是代码，是 `scripts/m9-probe-repair.ts`：

```
1. 取一份已冻结的 config
2. 只改 screen.width/height/availHeight 与 window.*
3. 重新 launchOptions，导出 CAMOU_CONFIG
4. diff 全部键，特别是 webgl / canvas / fonts / audio
5. 结论：只 screen 变了 → repair 可做；其它也变了 → repair 不做
```

**两种结论对应两种交付**：

| 验证结果 | M9 交付 |
|---|---|
| 只有 screen/window 变 | 提供 `POST /api/profiles/:id/repair`，仅允许当差异项全部属于屏幕/视口时执行 |
| 牵动 webgl/canvas | **不提供 repair**。只做 §4.5.2 的标记，并在文档和 UI 里明说「旧环境的身份无法局部修复，只能重建环境」 |

把这个分支写进方案里，是为了避免实现到一半才发现承诺不成立，然后为了交差硬做一个「改了屏幕也改了 canvas」的修复——那比不修更糟。

> **实测结论（2026-11-20，`npm run m9:repair`）**：走「不可做」分支。
>
> | 路径 | 结果 |
> |---|---|
> | A. 改 `fingerprint.screen` 后重算 | 牵动 **11 个其它键**：`humanize`、`locale:language`、`locale:region`、`timezone`、`mediaDevices:*`（麦克风/扬声器/摄像头数量与标签） |
> | B. 只覆写 config 的 `screen.*` / `window.*` | 只有 screen/window 变化（0 个其它键） |
>
> 注意 A 牵动的并不是 webgl/canvas，而是 **mediaDevices / locale / timezone** ——
> 也就是说「只改屏幕」会让同一个环境在摄像头列表、语言、时区上变成另一台设备。
> 所以 M9 只做标记，不提供 repair；老环境唯一正确的处置是重建。
> B 路径本身是安全的，但它只在**创建时**起作用，不能用来修补已固化的身份。

#### 4.5.2 健康标记（无论验证结果如何都做）

启动后跑一次自检（已有 `EngineAdapter.probe`），把差异存进 `profiles.health_json`：

```json
{ "checkedAt": 1763..., "diff": [{ "key": "window.innerWidth", "expected": 1920, "actual": 1280 }] }
```

- 列表页：非空 `diff` 的环境显示一个琥珀色角标「身份待检查」。
- 详情页：逐项列出预期 vs 实际，并说明「这可能是修复前创建的环境」（I-01）。
- 不自动修复、不自动告警。只让问题**可见**。

#### 4.5.3 剩下两条小债

- **I-04**：`preset.dpr` 降级为展示值。UI 上标注「实测」，用自检采到的 `devicePixelRatio` 覆盖展示；`validator` 保持不比对（这是 M1 就定好的）。
- **I-02**：Windows 探测补一条路径，`powershell -NoProfile -Command "[System.Windows.Forms.Screen]::PrimaryScreen.Bounds"`。拿不到就返回 `null`，**绝不 fallback 到写死分辨率**——写死会让「收缩」变成「全部压成 1920×1080」，那是另一种自相矛盾。

---

## 5. 迁移与兼容

| 版本 | 内容 | 兼容性 |
|---|---|---|
| v4 | `datasets` / `dataset_rows` | 纯新增，老库零影响 |
| v5 | `session_probes` / `session_checks` + `profiles` 两列 | 纯新增 |
| v6 | `notifiers` / `notification_logs` + `tasks` 三列（`timeout_ms`/`retries`/`error_class`） | 纯新增列，老任务读到 NULL 按默认值处理 |

- 老任务 JSON 里没有 `collect` / `timeoutMs` / `retries`，全部有默认值，不改写已有记录。
- 老环境的 preset 一个字节都不动。M9 只加标记。
- `schema.sql` 同步改成「全量最新结构」，迁移写成幂等（与 v2/v3 一致）。

---

## 6. API 增量

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/tasks` | 新增 `timeoutMs` / `retries`；步骤新增 `collect` |
| GET | `/api/datasets` | 列表（行数、字段数、最近写入） |
| GET | `/api/datasets/:id` | 详情 + schema + 最近 7 天写入曲线（可选） |
| GET | `/api/datasets/:id/rows` | 分页：`offset` / `limit` / `profileId` / `q`（全字段模糊） |
| GET | `/api/datasets/:id/export` | `format=csv\|jsonl`，流式 |
| DELETE | `/api/datasets/:id` | 删数据集（CASCADE 删行），需二次确认 |
| POST | `/api/probes` | 建探针（环境级或分组级） |
| GET | `/api/probes` | 列表 + 最近一次结果 |
| POST | `/api/probes/:id/run` | 触发巡检，异步，返回 `jobId` |
| GET | `/api/probes/jobs/:jobId` | 进度（内存态，重启丢失） |
| GET | `/api/session/overview` | 汇总：`alive/expired/unknown/never` 各多少个 |
| GET/POST/DELETE | `/api/notifiers` | 通知通道，`POST /:id/test` 发测试消息 |
| GET | `/api/system/storage` | 四类占用 |
| POST | `/api/profiles/:id/repair` | 身份局部修复（条件：M9 验证通过） |

---

## 7. 验收方案

### 7.1 先建地基：本地假站点

M5 之前所有验收都依赖公网（`quotes.toscrape.com`），这在 M6/M7 上行不通：

- M7 需要「未登录跳转、登录后可访问」的站点，公网找不到可控的；
- M6 需要「数据会变」的站点，才能验去重与更新；
- 而且依赖公网意味着断网、被墙、对方改版都会让验收变红。

所以先写 `scripts/fixtures/login-site.ts`（约 120 行，零依赖 `node:http`）：

```
GET /                → 无 sid cookie → 302 /login
GET /login           → 一个「登录」按钮，点了设 sid=ok
GET /orders          → 有 sid → 12 行订单表格；无 sid → 302 /login
GET /orders?page=2   → 第二页（验分页采集）
GET /flaky           → 前 2 次 500，第 3 次 200（验重试）
GET /500             → 恒 500（验 unknown）
```

这个 120 行的文件，是 M6/M7/M8 三个里程碑全部验收的基础设施。**先写它，再写功能。**

### 7.2 各里程碑断言

**M6 `npm run m6` — 18 项**

```
1  同一任务跑 3 次 → dataset 行数 12 不变，seen_count = 3
2  第 2 次前改一行价格 → 该行 data_json 更新，first_seen_at 不变  ★
3  单行 9KB → 步骤失败，错误含「单行超过 8KB」
4  脚本返回 2001 行 → 失败，且库内行数不变（不写半截）           ★
5  返回 0 行 → 步骤 ok、任务 succeeded、note「采到 0 行」          ★
6  expectMinRows: 1 且返回 0 行 → 任务 failed
7  dedupeBy 缺省 = 全字段哈希；改任意字段 → 新增一行
8  dedupeBy: ['orderNo'] 且只改价格 → 不新增行、更新内容
9  append 模式 → 每次执行都新增 12 行
10 CSV 行数 = 12 + 1，首三字节 EF BB BF                       ★
11 CSV 中文列名 / 中文内容不乱码
12 JSONL 每行可被 JSON.parse，行数 = 12
13 10 万行导出不超内存（RSS 增量 < 100MB）
14 删任务 → dataset 行数不变（数据是资产）                      ★
15 删 dataset → 行一并删除
16 任务详情回执：inserted + updated + skipped = written
17 数据集名写错 → 新建了另一张表，列表能看到（可接受的坑，但必须可见）
18 采集跨两个环境 → first_profile_id / last_profile_id 分别正确
```

**M7 `npm run m7` — 14 项**

```
1  未登录 → expired（规则 url.mustNotMatch = /\/login/）
2  登录后 → alive
3  代理指向关闭端口 → unknown，不是 expired                      ★
4  目标恒 500 → unknown                                        ★
5  selector 规则命中 → alive；页面改版后 → expired
6  script 规则返回 false → expired
7  环境已在运行 → 新开标签页检查后关闭，原页面 URL 不变           ★
8  巡检不改变 last_opened_at
9  audit 里记为 session.check，不混入 profile.start
10 30 个环境、并发 3 → 实际最大并发 ≤ 3
11 取消 → 剩余标 skipped，已完成的检查结果保留
12 连续两次 expired → 只产生 1 次事件                           ★
13 alive → expired → alive → expired → 产生 2 次事件（边沿）
14 列表页灯色：绿/灰问号/红，never 显示「未检测」
```

**M8 `npm run m8` — 13 项**

```
1  timeoutMs=3000 跑 10s 脚本 → failed，error_class=timeout
2  /flaky → 第 3 次成功，attempts=3
3  eval 抛错 → 不重试，attempts=1                              ★
4  只重跑失败的目标（4 个环境挂 1 个 → 只重启 1 个）
5  50 个环境同时 expired → 60s 内只发 1 条聚合消息               ★
6  webhook 签名可验（HMAC-SHA256 与 header 一致）
7  webhook 返 500 → 重试 3 次后落 notification_logs，巡检继续
8  同一事件 60s 内重复触发 → suppressed 落库
9  TTL：任务 created_at 改到 100 天前 → 清理后任务与截图都不在
10 清理留 audit 汇总（含释放字节数）
11 dataset_rows 不参与清理                                     ★
12 /api/system/storage 三个数字与 du 误差 < 5%
13 截图预览 img 宽度不超过容器（I-07）
```

**M9 `npm run m9` — 按验证分支**

```
1  repair 可行性脚本给出明确结论（可做 / 不可做），不模棱两可   ★
2  标记：老环境启动后 health_json.diff 非空 → 列表出现角标
3  新环境启动后 diff 为空 → 无角标
4  Windows 探测：注入 system_profiler / PowerShell 样本 → 解析正确
5  拿不到探测结果 → fitToHost 原样返回，不写死尺寸               ★
```

带 ★ 的是这个里程碑里最容易做错、也最不能省的那几条。

---

## 8. 风险

| 风险 | 影响 | 应对 |
|---|---|---|
| 采集脚本写错，采到空表 | 用户拿着空数据做决定 | `expectMinRows` + 「采到 0 行」显式回执 + 任务详情显示写入行数 |
| 数据集名拼错，数据进错表 | 数据丢失感 | 回执里显示数据集名；「7 天无写入」提示；提供重命名 |
| 巡检被站点识别为异常访问 | 掉号（最严重后果） | 默认不定时、最短 6h、并发 3、明确警告、audit 可查 |
| 探针规则过严 → 误报 expired | 功能失去信任 | 三态 + unknown；首次可「只观察不通知」跑一周 |
| 通知洪水 | 用户关掉通知，真失败也漏 | 60s 聚合 + 边沿触发 + 每通道限流 |
| 只改 screen 牵动 canvas | repair 承诺不成立 | §4.5.1 先验证；不成立就不做，不硬做 |
| 数据集无上限增长 | DB 变大、查询变慢 | 占用面板 + 手动清理；不做自动删（资产） |
| 巡检并发与用户手动启动抢并发名额 | 用户点启动要排队 | 巡检并发独立计数，且总并发不超过 `maxConcurrent` 的 70% |

---

## 9. 实施顺序

不是「按 M6→M7→M8→M9 依次做」，而是这样排：

1. **`scripts/fixtures/login-site.ts`** —— 半天。没有它，后面三个里程碑的验收全部依赖公网，会反复返工。
2. **M6 全量** —— `collect` → dataset service → 导出 → 数据页。做完就能真实用起来（哪怕只有这一条）。
3. **M7 探针 + 巡检** —— 复用 M6 建的 fixture 站点，验收直接写。
4. **M8** —— 超时/重试（改 `task.service.ts` 一处）→ 通知 → 保留策略。M7 的巡检通知依赖它，所以不能颠倒。
5. **M9 验证脚本** —— 先只跑脚本、拿结论，再决定实现范围。这一步不阻塞前面任何一个。

每一里程碑结束都做一次 M1 回归（`npm run m1`），确认指纹链路没被碰坏——这是前面五轮一直保持的习惯，MVP2 也不能破。

---

## 10. 与 PRD 的关系

本文是 PRD 的增量，不改动 PRD 已有条目。落地时：

- PRD §4 追加 `4.9 数据落地`、`4.10 会话巡检`、`4.11 可靠性与通知`、`4.12 身份健康`（F-80 ~ F-92）
- PRD §7 里程碑表追加 M6–M9 四行
- PRD §2.2 非目标保持原样（云同步、可视化编排本来就在「不做」里，MVP2 只是再次确认）

一句话收尾：**MVP1 证明了这套隔离是真的，MVP2 要让这套隔离每天都能产出东西。**
