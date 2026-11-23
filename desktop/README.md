# FoxBox 桌面壳（Tauri 2）

把本地服务包进一个原生窗口。壳里**没有业务逻辑**——它只负责分端口、拉起 `dist/main.js`、
等端口就绪后把窗口导航过去。这样桌面版和 `npm run serve` 跑的是同一份代码。

```
src-tauri/           Rust 侧（约 350 行）
  src/main.rs        分端口 → 找 node → 起后端 → 等就绪 → 导航
  tauri.conf.json    窗口不写在配置里，由 Rust 运行时创建（端口是动态的）
  icons/             由 icon.svg 生成，`npx tauri icon icon.svg -o src-tauri/icons`
shell/index.html    启动页：后端没起来时，失败原因直接写在这里
icon.svg            图标源文件（1024×1024）
```

## 前置

- Node ≥ 22.15（壳不内嵌 node，用本机的）
- Rust ≥ 1.77（Tauri 2 的下限）。本机已验证：Rust 1.100.0 / tauri 2.12.7
- 仓库根目录先产出 `dist/`：

```bash
cd .. && npm run build
```

## 开发与打包

```bash
npm run desktop:dev     # 在仓库根执行；会先 npm run build 再启动窗口
npm run desktop:build   # 产出 .app / .dmg（target/release/bundle/）
```

只想快速验证链路、不想要 release 编译（release 开了 LTO，很慢）：

```bash
cd desktop && npx tauri build --debug --bundles app
open src-tauri/target/debug/bundle/macos/FoxBox.app
```

实测：`cargo build` 首次 8m39s、增量 27s；debug 打包 1m15s，产物 35.3MB。

## 两个约定

**路径解析**：以 `dist/main.js` 为锚点，按 `FOXBOX_ROOT` → 当前目录 → 可执行文件往上 7 层 →
`CARGO_MANIFEST_DIR/../..` 的顺序找。可用 `FOXBOX_ROOT` 显式覆盖。

**node 解析**：从 Finder 启动时 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，Homebrew 和 nvm 的
node 都不在其中。所以依次尝试 `FOXBOX_NODE` → `PATH` → `/opt/homebrew/bin` → `/usr/local/bin` →
`~/.nvm/versions/node/*`（倒序）→ `~/.workbuddy/binaries/node/versions/*` → `~/.volta/bin`。

**每个候选都会真跑一次 `node -v`**，只收 ≥ 22.15 的：文件存在不代表能用，
太老的 node 没有 `node:sqlite`，起来后会立刻退出，伪装成端口问题。
一个都不合格时，错误信息里列出"找到但太老"的清单。

**NODE_OPTIONS 会被摘掉**：IDE / 运行时常在里面挂 `--require` 注入钩子，
后端读文件会整体抛异常，症状是 `/health` 正常但首页 500。

## 退出

关窗即退出：先给后端发 SIGTERM 让它走完优雅关闭（关掉所有浏览器进程、清 `.parentlock`），
5 秒没退再强杀。直接 kill 会留下 Firefox 残留，下次启动会卡 70 秒。

## 出问题看哪里

后端 stdout/stderr 与壳自己的话都在 **`~/.foxbox/desktop-shell.log`**：

```
FoxBox 本地服务已启动
  地址   http://127.0.0.1:53978
[壳] 后端就绪（node /…/v22.22.2/bin/node），导航到 http://127.0.0.1:53978/
```

最后一行是 `[壳] 启动失败：…` 就说明窗口停在启动页，原因和日志末尾都会同时显示在窗口里。
窗口进没进工作台，可以用 `lsof -i :<端口>` 看 WebKit 内容进程有没有建连接。
