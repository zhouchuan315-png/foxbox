//! FoxBox 桌面壳。
//!
//! 壳里不放业务逻辑，只做三件事：找一个空闲端口、把 Node 后端拉起来、
//! 等它就绪后把窗口导航过去。这样"桌面版"和 `npm run serve` 跑的是同一份代码，
//! 界面里也不存在第二套 API 适配层——出问题时排查路径只有一条。
//!
//! 两个刻意的选择：
//!
//! * **不内嵌 Node**。把 node 二进制塞进 .app 要多几十兆，而且每次升级 Node
//!   都要重新打包。这里用本机的 node，找不到时直接在启动页上说清楚，
//!   而不是给一个白屏。
//! * **窗口先显示启动页，再导航**。反过来的话，后端起不来就是一个无响应窗口，
//!   用户只会以为程序卡死。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

struct Backend(Mutex<Option<Child>>);

/// 让系统分一个空闲端口。用完立刻释放，紧接着由 Node 去 bind——
/// 中间有一个极小的竞争窗口，但比写死 7331（和 `npm run serve` 抢端口）好得多。
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|addr| addr.port())
        .unwrap_or(7331)
}

fn random_token() -> String {
    use std::io::Read;
    let mut buf = [0u8; 24];
    let ok = std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .is_ok();
    if !ok {
        // Windows / 受限环境退化成时间戳，够本地工具用
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        buf[..16].copy_from_slice(&nanos.to_le_bytes());
        buf[16..].copy_from_slice(&(std::process::id() as u128).to_le_bytes());
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// 后端要求的最低 Node：`node:sqlite` 从 22.5 才有，本项目按 22.15 开发。
const MIN_NODE: (u32, u32) = (22, 15);

/// 跑 `node -v` 拿版本。返回 None 表示这个文件根本跑不起来
/// （比如是个 shim 脚本、或者架构不匹配）。
fn node_version(path: &Path) -> Option<(u32, u32)> {
    let output = Command::new(path).arg("-v").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let trimmed = text.trim().trim_start_matches('v');
    let mut parts = trimmed.split('.');
    let major: u32 = parts.next()?.parse().ok()?;
    let minor: u32 = parts.next().unwrap_or("0").parse().unwrap_or(0);
    Some((major, minor))
}

fn version_ok(version: (u32, u32)) -> bool {
    version.0 > MIN_NODE.0 || (version.0 == MIN_NODE.0 && version.1 >= MIN_NODE.1)
}

/// 从 Finder 启动时 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，
/// Homebrew 和 nvm 装的 node 都不在里面——这是桌面化最常踩的坑。
///
/// 只找得到还不够：清单里有很多"存在但不能用"的 node（版本太老的 nvm、
/// 应用自带的 shim）。所以每个候选都真跑一次 `node -v`，取第一个达标的，
/// 否则返回一份"我找到了这些，但都不合格"的清单——比"找不到 node"有用得多。
fn find_node() -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(custom) = std::env::var_os("FOXBOX_NODE") {
        let path = PathBuf::from(custom);
        // 明确指定的排最前，但仍然要过版本检查：指错了要说清楚
        candidates.push(path);
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.push(dir.join("node"));
        }
    }

    candidates.push(PathBuf::from("/opt/homebrew/bin/node"));
    candidates.push(PathBuf::from("/usr/local/bin/node"));

    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        // nvm / WorkBuddy 托管目录：目录名带版本号，倒序取，新的在前
        for base in [".nvm/versions/node", ".workbuddy/binaries/node/versions"] {
            if let Ok(entries) = std::fs::read_dir(home.join(base)) {
                let mut paths: Vec<PathBuf> = entries
                    .filter_map(|e| e.ok())
                    .map(|e| e.path().join("bin/node"))
                    .filter(|p| p.is_file())
                    .collect();
                paths.sort();
                paths.reverse();
                candidates.extend(paths);
            }
        }
        candidates.push(home.join(".volta/bin/node"));
    }

    let mut seen: Vec<PathBuf> = Vec::new();
    let mut rejected: Vec<String> = Vec::new();

    for candidate in candidates {
        if !candidate.is_file() || seen.contains(&candidate) {
            continue;
        }
        seen.push(candidate.clone());

        match node_version(&candidate) {
            Some(version) if version_ok(version) => return Ok(candidate),
            Some((major, minor)) => {
                rejected.push(format!("{} → v{major}.{minor}", candidate.display()))
            }
            // 跑不起来的直接不提，免得淹没真正有用的信息
            None => continue,
        }
    }

    let detail = if rejected.is_empty() {
        "PATH、/opt/homebrew/bin、nvm、volta 里都没有 node。".to_string()
    } else {
        format!(
            "找到的都不够新（需要 {}.{} 或更高）：\n{}",
            MIN_NODE.0,
            MIN_NODE.1,
            rejected.join("\n")
        )
    };
    Err(format!(
        "找不到可用的 node。{detail}\n装一个 Node 22 后重启本应用，或用环境变量 FOXBOX_NODE 指定路径。"
    ))
}

/// 找项目根：以 `dist/main.js` 为锚点，逐个候选目录往上找。
fn resolve_root() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(custom) = std::env::var_os("FOXBOX_ROOT") {
        candidates.push(PathBuf::from(custom));
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(PathBuf::from);
        for _ in 0..7 {
            match dir.clone() {
                Some(current) => {
                    candidates.push(current.clone());
                    dir = current.parent().map(PathBuf::from);
                }
                None => break,
            }
        }
    }
    // 开发期：desktop/src-tauri 往上两级就是仓库根
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."));

    candidates
        .into_iter()
        .map(|p| p.canonicalize().unwrap_or(p))
        .find(|p| p.join("dist/main.js").is_file())
}

/// 后端的 stdout/stderr 落到这里。之前这两路是 null，
/// 结果是"服务没起来"时只有一句"60 秒没就绪"，什么线索都没有。
fn backend_log() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let dir = home.join(".foxbox");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("desktop-shell.log")
}

/// 取日志末尾几行塞进错误提示——完整路径一并在后面给出
fn log_tail(path: &Path, max: usize) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return "（日志是空的）".to_string();
    }
    let tail: String = trimmed
        .chars()
        .rev()
        .take(max)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    tail.trim().to_string()
}

/// 先 SIGTERM 让 Node 走完优雅关闭（它会关掉所有浏览器进程并回收 .parentlock），
/// 5 秒还没退再强杀。直接 kill 会留下一堆 Firefox 残留和下次启动的 70 秒卡顿。
fn stop_child(child: &mut Child) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(child.id().to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        for _ in 0..50 {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn launch_backend(window: tauri::WebviewWindow, state: tauri::State<'_, Backend>) {
    // 等启动页的脚本先挂上 window.foxboxFail。窗口刚建好就失败的话，
    // eval 会打在空气里，用户看到一个永远转圈的启动页。
    std::thread::sleep(Duration::from_millis(500));

    let node = match find_node() {
        Ok(node) => node,
        Err(message) => {
            fail(&window, &message);
            return;
        }
    };
    let root = match resolve_root() {
        Some(root) => root,
        None => {
            fail(
                &window,
                "找不到 FoxBox 的程序目录（需要 dist/main.js）。\
                 先在项目里执行 npm run build，或用 FOXBOX_ROOT 指向项目根目录。",
            );
            return;
        }
    };

    let port = free_port();
    let token = random_token();
    let log = backend_log();

    let log_file = std::fs::File::create(&log).ok();
    let mut command = Command::new(&node);
    command
        .arg(root.join("dist/main.js"))
        .current_dir(&root)
        .env("FOXBOX_PORT", port.to_string())
        .env("FOXBOX_TOKEN", token)
        // 壳被强杀（killall / 崩溃）时不会走 RunEvent::Exit，stop_child 不会执行，
        // 后端就变成孤儿占着端口。把 pid 交给后端，由它自己盯着父进程。
        .env("FOXBOX_PARENT_PID", std::process::id().to_string())
        // Camoufox 在部分 macOS 上会因为内容沙箱起不来
        .env("MOZ_DISABLE_CONTENT_SANDBOX", "1")
        // 父进程的 NODE_OPTIONS 常常挂着 `--require` 钩子（IDE、调试器、
        // 各种运行时的注入器）。那种钩子对我们的后端毫无意义，却会让
        // 每一个读文件的请求在 handler 里抛异常——表现为"服务起来了，
        // 但首页 500"。这类问题排查成本极高，直接隔离掉。
        .env_remove("NODE_OPTIONS")
        .stdin(Stdio::null());

    match &log_file {
        Some(file) => {
            command.stdout(Stdio::from(file.try_clone().unwrap_or_else(|_| {
                std::fs::File::create(&log).expect("无法创建日志文件")
            })));
            command.stderr(Stdio::from(file.try_clone().expect("无法复制日志句柄")));
        }
        None => {
            command.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            fail(
                &window,
                &format!("启动 node 失败（{}）：{error}", node.display()),
            );
            return;
        }
    };

    // 边等边看它是不是已经死了：死掉的进程等满 60 秒毫无意义，
    // 而且"等了 60 秒"这个结论会把人引向错误的排查方向。
    let deadline = Instant::now() + Duration::from_secs(60);
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            fail(
                &window,
                &format!(
                    "本地服务启动后立即退出（{}，node {}）。日志末尾：\n{}\n\n完整日志：{}",
                    status,
                    node_version(&node)
                        .map(|(a, b)| format!("v{a}.{b}"))
                        .unwrap_or_else(|| "?".into()),
                    log_tail(&log, 700),
                    log.display()
                ),
            );
            return;
        }
        if std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
            break;
        }
        if Instant::now() >= deadline {
            stop_child(&mut child);
            fail(
                &window,
                &format!(
                    "本地服务 60 秒内没有就绪（node {}）。日志末尾：\n{}\n\n完整日志：{}",
                    node.display(),
                    log_tail(&log, 500),
                    log.display()
                ),
            );
            return;
        }
        std::thread::sleep(Duration::from_millis(150));
    }

    {
        let mut slot = state.0.lock().unwrap();
        *slot = Some(child);
    }

    match url::Url::parse(&format!("http://127.0.0.1:{port}/")) {
        Ok(url) => {
            shell_log(&format!(
                "后端就绪（node {}），导航到 {url}",
                node.display()
            ));
            if let Err(error) = window.navigate(url) {
                fail(&window, &format!("加载界面失败：{error}"));
            }
        }
        Err(error) => fail(&window, &format!("地址不合法：{error}")),
    }
}

/// 壳自己的话也写进同一个日志：出问题时只翻一个文件就够了，
/// 不用去猜"到底是后端起不来，还是窗口没导航过去"。
fn shell_log(message: &str) {
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(backend_log())
    {
        let _ = writeln!(file, "[壳] {message}");
    }
}

/// 启动页上有个 `foxboxFail`，这里只负责把话说清楚。
///
/// 页面脚本可能还没执行到，所以让页面里的 JS 自己重试几秒，
/// 而不是在 Rust 侧猜一个延迟。
fn fail(window: &tauri::WebviewWindow, message: &str) {
    shell_log(&format!("启动失败：{}", message.replace('\n', " ⏎ ")));
    let escaped = message
        .replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace('\n', "\\n");
    let _ = window.eval(&format!(
        "(function(){{var n=0;var t=setInterval(function(){{\
           if(typeof window.foxboxFail==='function'){{clearInterval(t);window.foxboxFail('{escaped}');}}\
           else if(++n>50){{clearInterval(t);}}\
         }},100);}})();"
    ));
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(Backend(Mutex::new(None)));

            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("FoxBox")
                    .inner_size(1320.0, 880.0)
                    .min_inner_size(1024.0, 700.0)
                    .center()
                    .build()?;

            let handle = app.handle().clone();
            let for_thread = window.clone();
            std::thread::spawn(move || {
                launch_backend(for_thread, handle.state::<Backend>());
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri 初始化失败")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<Backend>() {
                    let child = state.0.lock().unwrap().take();
                    if let Some(mut child) = child {
                        stop_child(&mut child);
                    }
                }
            }
        });
}
