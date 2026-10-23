//! Forest Gap Detection 桌面端外壳（Tauri v2）。
//!
//! 职责边界（对应《桌面端开发交接简报》§12 的四项裁定）：
//!
//! | 层 | 归属 | 说明 |
//! |---|---|---|
//! | UI | React（`../src`） | 只做展示与交互，地理计算仅用于即时反馈 |
//! | 地理内核 | **Python**（`scripts/process_image.py`） | 保证 Stage 14 数字逐位可复现 |
//! | 瓦片服务 | **Python**（`scripts/tile_server.py`） | HTTP，首选 8765（被占自动往后挪），本文件负责拉起与监督 |
//! | 算法调用 | stdio NDJSON（`scripts/sidecar.py`） | 契约已冻结（95/95），**不要改成 HTTP** |
//!
//! 本文件只做三件事：
//! 1. 起窗口加载前端（dev 走 5173，release 走打包后的 dist）
//! 2. 拉起并监督瓦片服务（端口已在用则不重复启动）
//! 3. 退出时清理子进程（避免留下孤儿 python 进程占住 8765）
//!
//! ⚠️ 刻意**不引入** `tauri-plugin-shell`：托管子进程用标准库 `std::process`
//! 就够了，少一个插件少一层 capability 权限配置（也少一个打包时的坑）。

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};

use serde::Serialize;
use tauri::{Emitter, Manager, RunEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// 瓦片 / 辅助服务的**首选**端口（与 `desktop/src/api/backend.ts` 的默认值一致）。
/// 注意：真正在用的端口是 `ACTIVE_PORT` —— 8765 被别的程序占住时会往后挪。
const BACKEND_PORT: u16 = 8765;

/// 8765 被占时最多往后试这么多个（8765..=8776）。
/// 公司电脑实测：8765 被内网工具占住时，旧版直接失败并弹一句"请检查影像文件"的猜测。
const BACKEND_PORT_TRIES: u16 = 12;

/// 本次实际使用的端口。前端通过 `backend_url` 命令取它，**不要**硬编码 8765。
static ACTIVE_PORT: AtomicU16 = AtomicU16::new(BACKEND_PORT);

/// "还没有选择正射影像"的哨兵错误。前端据此显示引导卡片而不是报错。
const NEED_IMAGE: &str = "NEED_IMAGE";

#[derive(Default)]
struct Services {
    tile: Mutex<Option<Child>>,
    /// 正在运行的检测子进程（`scripts/sidecar.py`）。用于防重入与中途取消。
    detect: Mutex<Option<Child>>,
    /// 正在运行的「生成高度图 / 林地边界」子进程（`scripts/build_derived.py`）。
    ///
    /// 为什么不复用 `detect`：两者都会往 `output/` 写文件（CHM/掩膜 vs 检测结果），
    /// 但**语义不同** —— 检测可以取消（半成品无害），生成中途杀掉会留下**半个 CHM**
    /// （比没有更糟：检测会读到它而不报错）。分开放，将来给 derive 加"不可取消"更清楚。
    derive: Mutex<Option<Child>>,
    /// 正在建金字塔的子进程（`tile_server.py --overviews-only`）。
    ///
    /// 为什么必须纳管：`OVERVIEW_BUILDING` 那个 AtomicBool **只活在本进程内存里**。
    /// 真实场景：用户点了「开始」，觉得慢，直接关窗；又双击重开，看到横幅还在，
    /// 再点一次「开始」。新进程的 AtomicBool 是全新的 false（放行），
    /// 而上一轮留下的孤儿进程还在往**同一个** `.part` 里写 4.7 GB ——
    /// Windows 下两边必撞 `PermissionError: [WinError 32] 另一个程序正在使用此文件`。
    ///
    /// 所以：① 启动前先杀掉上一轮的；② 退出钩子统一 kill；③ AtomicBool 仍保留，
    /// 它防的是"同一进程内连点"，两者互补而不是重复。
    overviews: Mutex<Option<Child>>,
}

#[derive(Serialize)]
struct ServiceStatus {
    backend_url: String,
    tile_server_running: bool,
    backend: Option<String>,
    project_root: Option<String>,
}

fn port_open(port: u16) -> bool {
    let addr: SocketAddr = match format!("127.0.0.1:{port}").parse() {
        Ok(a) => a,
        Err(_) => return false,
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// 本次实际在用的后端端口（服务未起时是首选端口，前端仍能拿到一个合法地址）。
fn active_port() -> u16 {
    ACTIVE_PORT.load(Ordering::Relaxed)
}

/// 两个路径是否指向同一个文件：能规范化就比规范化结果，不能就比原样字符串。
///
/// 为什么不直接 `canonicalize(a).ok() == canonicalize(b).ok()`：
/// 两个路径**都不存在**时是 `None == None` → 被判成"相同"，
/// 而这恰好是最危险的方向 —— 僵尸服务指向一个已被删除/移走的旧影像，
/// 会被当成"一致"而直接复用，地图显示的就是旧影像。
/// 所以只有两边都能规范化时才敢下"相同"的结论；否则退化成字符串比较，
/// 不相等就判"不同"（保守方向：最多少复用一次残留服务，重开一次而已）。
fn same_file_path(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

/// 端口上的服务能否直接复用：必须是我们自己的，且服务的影像与当前配置一致。
///
/// 为什么还要比影像：`is_our_meta` 只认身份。若上次异常退出留下一个
/// **指向旧影像**的僵尸服务，身份校验会通过 → 直接复用 → 地图显示旧影像、
/// 检测却用新影像，而且界面上完全看不出来（比"换影像跳复核"更难发现）。
///
/// `wanted` 为 None（还没有选影像）时只校验身份 —— 此时没有"正确影像"可比。
fn should_reuse_service(meta_body: &str, wanted: Option<&Path>) -> bool {
    if !is_our_meta(meta_body) {
        return false;
    }
    let Some(want) = wanted else { return true };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(meta_body) else {
        return false;
    };
    let Some(src) = v.get("source").and_then(|x| x.as_str()) else {
        // 老版本（无 app 字段时期）一定有 source；这里拿不到就不能确认，
        // 保守判"不复用"
        return false;
    };
    same_file_path(Path::new(src), want)
}

/// 选一个可用的后端端口，返回 `(端口, 是否复用已有服务)`。
///
/// 规则（2026-10-21 公司电脑实测：8765 被内网工具占住，旧版直接失败）：
///   1. 端口空闲 → 用它新起服务；
///   2. 端口上是**我们自己的**服务（上一版残留）→ 复用，不重开；
///   3. 端口被**别的程序**占用 → 试下一个（8766、8767…），最多 `BACKEND_PORT_TRIES` 个。
///
/// `wanted` 是"现在该服务哪张影像"。身份对但影像不对的残留服务**不复用**
/// （理由见 `should_reuse_service`）。
///
/// ⚠️ 绝不 kill 占用者：那可能是用户的浏览器调试代理、别的业务系统。
///    连"是我们自己的但影像不对"也不 kill —— 它可能是另一个窗口正在用的。
fn pick_backend_port(wanted: Option<&Path>) -> Result<(u16, bool), String> {
    let mut reasons: Vec<String> = Vec::new();
    for offset in 0..BACKEND_PORT_TRIES {
        let port = BACKEND_PORT.saturating_add(offset);
        if !port_open(port) {
            return Ok((port, false));
        }
        // 有监听：先问身份。冷启动要打开大影像、必要时还要算降采样，
        // `/meta` 慢一两秒正常 → 给 3 次机会，别一次就下结论。
        for _ in 0..3 {
            match http_get_meta(port) {
                Ok(body) if should_reuse_service(&body, wanted) => return Ok((port, true)),
                Ok(body) => {
                    // 是我们自己的但服务着别的影像：不是"被别的程序占用"，
                    // 记的 reason 必须能区分开，否则排障时会被误导成端口冲突
                    reasons.push(if is_our_meta(&body) {
                        format!("{port} 上的瓦片服务指向别的影像，不复用")
                    } else {
                        format!("{port} 被其它程序占用")
                    });
                    break; // 身份已明确，不用再等
                }
                Err(_) => std::thread::sleep(Duration::from_millis(400)),
            }
        }
    }
    Err(format!(
        "端口 {BACKEND_PORT}~{} 全部不可用（{}）。请关掉占用这些端口的程序后重试。",
        BACKEND_PORT + BACKEND_PORT_TRIES - 1,
        reasons.join("；")
    ))
}

// ============================================================================
//  瓦片服务：探活 / 身份校验 / 排障证据
//  ---------------------------------------------------------------------------
//  为什么有这一节（2026-10-20 公司电脑事故，代价是一次装完打不开的交付）：
//
//  1. **`port_open()` 只能证明"有人在听"，不能证明"那是我们的服务"。**
//     公司机上 8765 一旦被别的软件占住，`start_tile_server` 就直接
//     `return Ok("复用现有服务")` 跳过启动 —— 外壳以为成功了，前端等 120 秒
//     也等不到 `/meta`，最后弹出那句"请确认①文件占用②标准GeoTIFF③磁盘空间"。
//     三个提示**没有一个是对的**，因为服务压根没起来。
//     → 复用前必须问一句"你是谁"：GET /meta 看 `app` 字段。
//
//  2. **release 版没有控制台，`eprintln!` 是黑洞。**
//     `windows_subsystem = "windows"` 下 stdout/stderr 全部丢弃，瓦片服务的
//     traceback（真因）就这样消失了，`app.log` 里只剩"已用 … 启动瓦片服务"。
//     → stderr 逐行转存 `app.log`，并在内存里留 200 行环形缓冲给前端回放。
//
//  3. **子进程"起来了"和"活下来了"是两件事。**
//     spawn 成功不代表成功：杀软拦截、DLL 缺失都会让进程秒退，而退出码
//     （0xC0000135 之类）是最省事的判据。原来这个数字从未被读取。
// ============================================================================

/// 本应用瓦片服务的身份标记，与 `scripts/tile_server.py` 的 `meta["app"]` 一致。
const TILE_APP_ID: &str = "fgd-tile-server";

/// 子进程 stderr 的环形缓冲（最多 200 行）。请求日志不进这里 —— 见 `push_tile_log`。
static TILE_LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());
/// 最近一次"服务自己退出"的退出码。主动 kill（重启/退出应用）不记。
static TILE_EXIT: Mutex<Option<i32>> = Mutex::new(None);
/// 最近一次启动/复用判定的失败原因，前端直接拿去展示。
static TILE_START_ERR: Mutex<String> = Mutex::new(String::new());

/// 是否正在建金字塔。
///
/// 为什么要这个互斥：建一次要 2~3 分钟，用户很容易连点两下按钮。两个进程会写
/// **同一个** `output/.tile-cache/<名>.tif.part`（原子写入用的是固定名），
/// 互相覆盖成坏文件。前端下一轮会禁用按钮，但后端不能把正确性寄托在 UI 上。
static OVERVIEW_BUILDING: AtomicBool = AtomicBool::new(false);

/// 离开作用域时复位 `OVERVIEW_BUILDING` —— 提前 `return`、`?` 传播、panic 都能覆盖到。
struct OverviewBuildGuard;

impl Drop for OverviewBuildGuard {
    fn drop(&mut self) {
        OVERVIEW_BUILDING.store(false, Ordering::SeqCst);
    }
}

/// 按字符边界截断（不能按字节切，否则中文/emoji 会切出半个 UTF-8 序列）。
fn clip_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

/// 判断一行 stderr 是不是 HTTP 访问日志（`"GET /tiles/15/1/2.png" 200 -`）。
///
/// 为什么要区分：一个满屏瓦片的地图每秒能刷几十行访问日志，全写进 `app.log`
/// 会把真正的错误冲掉，也会让日志文件无限增长。访问日志只进环形缓冲。
fn is_http_access_log(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("\"GET ") || t.starts_with("\"POST ") || t.starts_with("\"HEAD ")
}

/// 记一行瓦片服务输出：进环形缓冲；非访问日志同时写 `app.log`。
fn push_tile_log(line: &str) {
    if line.trim().is_empty() {
        return;
    }
    if let Ok(mut buf) = TILE_LOG.lock() {
        if buf.len() >= 200 {
            buf.remove(0);
        }
        buf.push(line.to_string());
    }
    if !is_http_access_log(line) {
        log_line(&format!("[tile_server] {line}"));
    }
}

/// 直接开 TCP 发 `GET /meta`，**不走系统代理、不经过 WebView**。
///
/// 为什么不用 HTTP 客户端库：项目刻意不引 reqwest（少一个依赖少一份打包体积），
/// 而这里只需要读一个小 JSON。同时它还是"服务活着但前端连不上"的判别器 ——
/// 代理有问题时 Rust 侧能通、WebView 侧不通，一眼分开。
fn http_get_meta(port: u16) -> Result<String, String> {
    let addr: SocketAddr = format!("127.0.0.1:{port}")
        .parse()
        .map_err(|e| format!("端口解析失败：{e}"))?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(800))
        .map_err(|e| format!("连不上 127.0.0.1:{port}（{e}）"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(2500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(1500)));
    stream
        .write_all(
            b"GET /meta HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
        )
        .map_err(|e| format!("写请求失败：{e}"))?;

    // 只读 64 KB：`/meta` 不到 1 KB，但对端可能是任何东西，不能无限读。
    let mut raw = Vec::new();
    stream
        .take(64 * 1024)
        .read_to_end(&mut raw)
        .map_err(|e| format!("读应答失败：{e}"))?;
    let text = String::from_utf8_lossy(&raw).to_string();
    let (head, body) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| format!("应答不是合法 HTTP：{}", clip_chars(&text, 80)))?;
    let status = head.lines().next().unwrap_or("").trim().to_string();
    if !status.contains(" 200") {
        return Err(format!("/meta 返回 {status}"));
    }
    Ok(body.to_string())
}

/// `/meta` 的应答是不是本应用的瓦片服务。
///
/// 兼容两种：带 `app` 标记的新版；以及**本次改动之前构建的旧版**（没有 `app`，
/// 但有 `ok`/`source`/`tile_url` 三件套）—— 否则用户升级外壳后，旧的服务进程
/// 会被误判成"外人"，反而多一个坑。
fn is_our_meta(body: &str) -> bool {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    if v.get("app").and_then(|x| x.as_str()) == Some(TILE_APP_ID) {
        return true;
    }
    v.get("ok").and_then(|x| x.as_bool()) == Some(true)
        && v.get("source").is_some()
        && v.get("tile_url").is_some()
}

/// 前端排障面板拿到的全部证据。字段名与 `desktop/src/api/backend.ts` 的
/// `TileDiag` 一一对应（改一处必须改另一处）。
#[derive(Serialize)]
struct TileDiag {
    port: u16,
    /// 端口上有没有人在听（只能证明"有人在听"）
    port_open: bool,
    /// 应答 `/meta` 的是不是本应用的服务（身份校验结果）
    ours: bool,
    /// `/meta` 应答前 300 字（不是自己人时，这就是"别人长什么样"）
    meta_head: String,
    /// 探活失败原因（连不上 / 无应答 / 非 200）
    probe_error: String,
    /// 我们拉起的子进程是否还活着
    child_alive: bool,
    /// 子进程退出码（自己退出的才有值；主动重启/退出应用为 null）
    exit_code: Option<i32>,
    /// 上次启动被拒的原因（端口被占等）
    start_error: String,
    /// 子进程 stderr 最近 60 行（traceback 就在这里）
    log_tail: Vec<String>,
    /// 后端形态（打包运行时 / 开发态解释器）
    backend: Option<String>,
}

/// 采集一次排障快照。前端在"等服务就绪"失败后调用，用来把兜底文案换成真因。
#[tauri::command]
fn tile_diagnose(app: tauri::AppHandle, state: tauri::State<'_, Services>) -> TileDiag {
    let port = active_port();
    let open = port_open(port);
    let (ours, head, perr) = if open {
        match http_get_meta(port) {
            Ok(body) => (is_our_meta(&body), clip_chars(&body, 300), String::new()),
            Err(e) => (false, String::new(), e),
        }
    } else {
        (false, String::new(), "端口没有监听".to_string())
    };

    // 顺手 try_wait 一次：万一监视线程还没轮到，这里也能立刻拿到退出码
    let mut alive = false;
    let mut code: Option<i32> = None;
    if let Ok(mut guard) = state.tile.lock() {
        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(Some(st)) => code = st.code(),
                Ok(None) => alive = true,
                Err(_) => alive = true,
            }
        }
    }
    if code.is_none() && !alive {
        code = *TILE_EXIT.lock().unwrap_or_else(|e| e.into_inner());
    }

    TileDiag {
        port,
        port_open: open,
        ours,
        meta_head: head,
        probe_error: perr,
        child_alive: alive,
        exit_code: code,
        start_error: TILE_START_ERR
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone(),
        log_tail: TILE_LOG
            .lock()
            .map(|b| b.iter().rev().take(60).rev().cloned().collect())
            .unwrap_or_default(),
        backend: resolve_backend(&app).map(|b| b.describe()),
    }
}

/// 仓库根：开发态是 `desktop/src-tauri` 往上两级；打包后取资源目录的上一级。
fn project_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(res) = app.path().resource_dir() {
        // 打包后不把整个仓库塞进去（太大），只带 scripts/ 与 .venv 等价物，
        // 因此这里优先返回资源目录本身。
        let cand = res.join("app");
        if cand.exists() {
            return Some(cand);
        }
        if res.join("scripts").exists() {
            return Some(res);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    dev.canonicalize().ok()
}

/// 找 Python 解释器。优先级：
/// 1. 环境变量 `FGD_PYTHON`（运维/排障时覆盖）
/// 2. 打包后的 `resources/python/`（裁定：`--onedir` 或 python-build-standalone，
///    **严禁 `--onefile`** —— 每次启动解压 350 MB 到 %TEMP%，冷启动 6~10 s 且易被杀软拦）
/// 3. 开发态仓库根的 `.venv`
/// 后端执行方式 —— 生产与开发走两条路，**互不破坏**。
///
/// | 形态 | 用什么 | 场景 |
/// |---|---|---|
/// | `Bundled` | `py-runtime/desktop_entry/desktop_entry.exe` | 安装包 / 免安装目录 |
/// | `Dev` | 仓库 `.venv/Scripts/python.exe` + `scripts/*.py` | 日常开发 |
///
/// 打包版是**单入口**（`scripts/desktop_entry.py`）：靠第一个参数分发到
/// `tile_server` 或 `sidecar`，两个服务共享同一份 `_internal` 动态库
/// —— 否则 rasterio/numpy/scipy/shapely/pyproj 会被复制两遍，包体翻倍。
enum Backend {
    Bundled(PathBuf),
    Dev { python: PathBuf, root: PathBuf },
}

impl Backend {
    fn describe(&self) -> String {
        match self {
            Backend::Bundled(p) => format!("打包运行时 {}", p.display()),
            Backend::Dev { python, .. } => format!("开发态解释器 {}", python.display()),
        }
    }

    fn is_bundled(&self) -> bool {
        matches!(self, Backend::Bundled(_))
    }
}

/// 找后端执行器。**生产优先、开发兜底**：
/// 1. `FGD_BACKEND` 环境变量（排障时可强制指定 exe 或 python）
/// 2. Tauri `resources/py-runtime/desktop_entry.exe`（安装包）
/// 3. 应用同级 `py-runtime/desktop_entry.exe`（免安装 zip 场景）
/// 4. 仓库 `.venv`（开发态）
fn resolve_backend(app: &tauri::AppHandle) -> Option<Backend> {
    if let Ok(p) = std::env::var("FGD_BACKEND") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            // 名字里带 python 就当解释器，否则当打包入口
            let is_python = pb
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.to_lowercase().contains("python"))
                .unwrap_or(false);
            if is_python {
                let root = project_root(app)?;
                return Some(Backend::Dev { python: pb, root });
            }
            return Some(Backend::Bundled(pb));
        }
    }

    let mut search_dirs: Vec<PathBuf> = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        search_dirs.push(res.clone());
        search_dirs.push(res.join("py-runtime"));
        // 免安装：主程序同级的 py-runtime
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                search_dirs.push(dir.to_path_buf());
                search_dirs.push(dir.join("py-runtime"));
            }
        }
    }
    // ⚠️ 两种布局都要认：
    //   · `py-runtime/desktop_entry/desktop_entry.exe` —— 当前 tauri.conf.json 的
    //     目录映射 `"../runtime/desktop_entry": "py-runtime/desktop_entry"` 的产物
    //   · `py-runtime/desktop_entry.exe` —— 若将来把映射改成 `"py-runtime"`
    //   少写一个变体就会出现"装好了却提示找不到后端"（实测踩过）。
    for dir in &search_dirs {
        for name in [
            "desktop_entry.exe",
            "desktop_entry/desktop_entry.exe",
            "desktop_entry",
        ] {
            let cand = dir.join(name);
            if cand.exists() {
                return Some(Backend::Bundled(cand));
            }
        }
    }

    let root = project_root(app)?;
    for cand in [".venv/Scripts/python.exe", ".venv/bin/python"] {
        let pb = root.join(cand);
        if pb.exists() {
            return Some(Backend::Dev {
                python: pb.canonicalize().ok()?,
                root,
            });
        }
    }
    None
}

/// 打包态的数据根目录：`resources/data` → 主程序同级 `data` → 主程序同级。
///
/// 打包版没有"仓库根"，而 `tile_server` 的默认探测（`drone data/`、`output/`）
/// 都是相对路径。所以这里给一个明确的工作目录，并把相对路径参数补成绝对路径。
/// 实测目录可写（写探针再删）。Windows 上"目录存在"不代表能写 ——
/// 装到 Program Files 时安装目录是只读的，必须实测。
fn dir_is_writable(dir: &std::path::Path) -> bool {
    let probe = dir.join(".fgd-write-probe");
    let ok = std::fs::write(&probe, b"1").is_ok();
    let _ = std::fs::remove_file(&probe);
    ok
}

/// 递归复制目录，**总量超过 `cap` 就整体放弃**（避免首次启动卡在几 GB 的拷贝上）。
///
/// 返回复制成功的字节数；0 表示"太大没搬"。
fn copy_dir_capped(
    src: &std::path::Path,
    dst: &std::path::Path,
    cap: u64,
) -> std::io::Result<u64> {
    fn size_of(dir: &std::path::Path) -> u64 {
        let mut total = 0u64;
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let p = e.path();
                match e.metadata() {
                    Ok(m) if m.is_dir() => total += size_of(&p),
                    Ok(m) => total += m.len(),
                    Err(_) => {}
                }
            }
        }
        total
    }
    fn copy_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<u64> {
        std::fs::create_dir_all(dst)?;
        let mut n = 0u64;
        for e in std::fs::read_dir(src)? {
            let e = e?;
            let from = e.path();
            let to = dst.join(e.file_name());
            if e.metadata()?.is_dir() {
                n += copy_all(&from, &to)?;
            } else {
                n += std::fs::copy(&from, &to)?;
            }
        }
        Ok(n)
    }
    let total = size_of(src);
    if total > cap {
        return Ok(0);
    }
    copy_all(src, dst)
}

/// 首次切到「程序旁边的 data/」时，把旧位置（%LOCALAPPDATA%\fgd\data）的数据搬过来。
///
/// 只搬小的两样：
///   · `settings.json`（记录影像路径，几 KB）
///   · `output/`（检测结果，通常几 MB；超过 200 MB 就放弃，避免首次启动卡住）
///
/// **影像本身不搬**：可能 5 GB，而且 settings.json 里存的是绝对路径，搬了反而失效。
fn migrate_from_localappdata(target: &std::path::Path) {
    let Ok(local) = std::env::var("LOCALAPPDATA") else {
        return;
    };
    let old = PathBuf::from(local).join("fgd").join("data");
    if !old.is_dir() || old == target {
        return;
    }
    // settings.json 的历史位置是 %LOCALAPPDATA%\fgd\settings.json（**不在 data/ 下**），
    // 所以这里要从上一级找，而不是 old.join("settings.json")。
    let dst_cfg = target.join("settings.json");
    if !dst_cfg.exists() {
        if let Some(src_cfg) = legacy_config_path() {
            if src_cfg.is_file() {
                let _ = std::fs::copy(&src_cfg, &dst_cfg);
            }
        }
    }
    let src_out = old.join("output");
    let dst_out = target.join("output");
    if src_out.is_dir() && !dst_out.exists() {
        let _ = copy_dir_capped(&src_out, &dst_out, 200 * 1024 * 1024);
    }
}

fn bundled_data_root(app: &tauri::AppHandle) -> PathBuf {
    // 1) 显式指定（运维 / 多套数据切换）
    if let Ok(p) = std::env::var("FGD_DATA_ROOT") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return pb;
        }
    }
    // 2) 安装目录里的 data/（可预置只读样例数据）
    if let Ok(res) = app.path().resource_dir() {
        let d = res.join("data");
        if d.exists() {
            return d;
        }
    }
    // 2.5) **便携模式：程序旁边的 data/** —— 数据跟着程序走，不占 C 盘。
    //
    // 用户要求（2026-10-23）："把数据存储在 D:\Forest Gap Detection 内，
    // 而不是把数据存储在 c 盘内"。装在 D 盘根目录时这里可写，优先用它。
    //
    // ⚠️ 必须实测可写再返回：装到 `C:\Program Files` 时安装目录只读，
    //    此时要老老实实回退到下面的 %LOCALAPPDATA%。
    // ⚠️ 只对**主程序**成立：`desktop_entry.exe` 在 py-runtime 子目录里，
    //    它不会走这里 —— 子进程的 cwd 由 `build_command` 显式传入。
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let d = dir.join("data");
            let usable = d.is_dir() || std::fs::create_dir_all(&d).is_ok();
            if usable && dir_is_writable(&d) {
                // 首次切换：把旧位置的小数据搬过来（幂等，已存在就跳过）
                migrate_from_localappdata(&d);
                return d;
            }
        }
    }

    // 3) %LOCALAPPDATA%\fgd\data —— 兜底：程序目录不可写时用这里。
    //    安装到 Program Files 时安装目录是只读的，写不了 output/ 与瓦片缓存。
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let d = PathBuf::from(local).join("fgd").join("data");
        if d.exists() {
            return d;
        }
        // 首次运行：建出来并返回（用户把 drone data/ 与 output/ 放进去即可）
        if std::fs::create_dir_all(&d).is_ok() {
            return d;
        }
    }
    // 4) 主程序同级（免安装 zip 场景）
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let d = dir.join("data");
            if d.exists() {
                return d.to_path_buf();
            }
            return dir.to_path_buf();
        }
    }
    PathBuf::from(".")
}

// ============================================================================
//  用户配置（记住"上次用的影像 / 结果文件"）
//  ---------------------------------------------------------------------------
//  为什么必须持久化：打包版没有"仓库根"，用户不可能每次都去某个隐藏目录放文件。
//  让他在界面里选一次影像，路径存到 `%LOCALAPPDATA%\fgd\settings.json`，
//  下次启动直接用 —— 这是"小白能用"的最低门槛。
// ============================================================================
#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
struct AppConfig {
    /// 正射影像路径（.tif）
    image: Option<String>,
    /// 检测结果路径（.geojson）；为空时瓦片服务会自己找默认位置
    gaps: Option<String>,
    /// 建金字塔时若产生了副本，瓦片服务改用它（检测仍用原图，像素完全相同）。
    /// 为空表示直接用 image。
    ///
    /// ⚠️ `#[serde(default)]` **不能省**：`load_config()` 是
    /// `serde_json::from_str(&text).unwrap_or_default()`，旧版 settings.json
    /// 没有这个字段 → 反序列化失败 → 静默返回 default → **用户的影像/结果路径
    /// 全被抹掉**，表现为"升级后软件又让我选一次影像"。加 default 后缺字段即 None。
    #[serde(default)]
    tile_source: Option<String>,
}

/// 配置文件**应该存在**的位置。
///
/// 便携模式（程序旁 `data/` 可写）→ `程序目录/data/settings.json`，
/// 跟数据放一起：用户能看见、能备份、换机器时拷一个目录就够。
/// 否则回退 `%LOCALAPPDATA%\fgd\settings.json`（老位置）。
///
/// ⚠️ 2026-10-23 之前配置**一直**在 `%LOCALAPPDATA%\fgd\settings.json`（不在 data/ 下），
/// 所以"数据目录搬到 D 盘"时只搬了 output/，settings 没跟过去 ——
/// 用户打开新目录只看到 output/。现在统一到数据根下。
fn config_target() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let d = dir.join("data");
            if d.is_dir() && dir_is_writable(&d) {
                return Some(d.join("settings.json"));
            }
        }
    }
    let local = std::env::var("LOCALAPPDATA").ok()?;
    Some(PathBuf::from(local).join("fgd").join("settings.json"))
}

/// 老位置（只用于一次性迁移与兜底读取）。
fn legacy_config_path() -> Option<PathBuf> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    Some(PathBuf::from(local).join("fgd").join("settings.json"))
}

fn config_path() -> Option<PathBuf> {
    config_target()
}

fn load_config() -> AppConfig {
    // 1) 目标位置优先
    if let Some(p) = config_target() {
        if let Ok(text) = std::fs::read_to_string(&p) {
            return serde_json::from_str(&text).unwrap_or_default();
        }
    }
    // 2) 目标不存在 → 读老位置，并**顺手迁移过去**（一次就够，之后走上面那条）
    let Some(old) = legacy_config_path() else {
        return AppConfig::default();
    };
    let Ok(text) = std::fs::read_to_string(&old) else {
        return AppConfig::default();
    };
    let cfg: AppConfig = serde_json::from_str(&text).unwrap_or_default();
    // 迁移失败不影响本次使用（下次启动还会再试）
    let _ = save_config(&cfg);
    cfg
}

fn save_config(cfg: &AppConfig) -> Result<(), String> {
    let p = config_target().ok_or("拿不到可写的配置目录")?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("建目录失败：{e}"))?;
    }
    let text = serde_json::to_string_pretty(cfg).map_err(|e| format!("序列化失败：{e}"))?;
    std::fs::write(&p, text).map_err(|e| format!("写配置失败：{e}"))?;
    Ok(())
}

/// 前端启动时问"我现在该显示什么"：要不要引导用户选影像？
#[derive(serde::Serialize)]
struct AppStatus {
    /// 后端执行方式（打包运行时 / 开发态解释器），排障用
    backend: Option<String>,
    /// 瓦片服务是否在监听
    tile_running: bool,
    /// 当前配置的影像与结果路径
    image: Option<String>,
    gaps: Option<String>,
    /// 数据根目录（提示用户"文件该放哪"时显示）
    data_root: String,
    /// true = 还没有可用影像，前端应显示「选择影像」引导
    needs_setup: bool,
}

/// 找数据的基准目录：开发态是仓库根（`drone data/`、`output/` 都在这），
/// 打包态是可写的数据根（`%LOCALAPPDATA%\fgd\data`）。
///
/// ⚠️ 不能一律用 `bundled_data_root` —— 开发态那样会去 `%LOCALAPPDATA%` 找，
/// 明明仓库里就有影像却弹"请选择影像"，非常反直觉。
fn data_base(app: &tauri::AppHandle) -> PathBuf {
    match resolve_backend(app) {
        Some(Backend::Dev { root, .. }) => root,
        _ => bundled_data_root(app),
    }
}

/// 从配置 + 默认探测里找影像。
/// 顺序：用户上次选的 → 数据根下的 `drone data/WGR17-002.tif` → 数据根下的 `WGR17-002.tif`
fn resolve_image(app: &tauri::AppHandle) -> Option<PathBuf> {
    let cfg = load_config();
    if let Some(p) = cfg.image {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    let data = data_base(app);
    for cand in [
        data.join("drone data").join("WGR17-002.tif"),
        data.join("drone data").join("WGR17.tif"),
        data.join("WGR17-002.tif"),
        data.join("WGR17.tif"),
    ] {
        if cand.exists() {
            return Some(cand);
        }
    }
    None
}

/// 瓦片服务该用哪张影像：建金字塔时若产生了副本（cfg.tile_source），优先用它。
/// 副本不存在（被清理了）就回落到原图 —— 绝不因为一个缓存文件缺失而打不开。
///
/// ⚠️ **只给瓦片服务用**。检测链路必须继续走 `resolve_image`：
///    副本的像素与原图完全相同，但它的路径不在检测参数指纹里，
///    换过去会让"同一张影像"算出两套缓存。
fn resolve_tile_source(app: &tauri::AppHandle) -> Option<PathBuf> {
    let cfg = load_config();
    if let Some(p) = cfg.tile_source {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    resolve_image(app)
}

/// 在**一个目录**里找名字含 `gaps` 的 geojson，按 mtime 取最新。
///
/// 为什么是"含 gaps + 按 mtime"而不是写死文件名：
/// 产物名由前端的 `job` 参数决定（当前是 `wgr17-desktop-gaps.geojson`），
/// 换一个 job 名、或者换一台机器跑，写死的名字就永远对不上 ——
/// 实测症状是"检测明明成功了（1,762 个要素在磁盘上），界面却说没有空地"。
/// 按特征 + mtime 发现，才能做到"谁最新用谁"，且与 job 名解耦。
fn scan_gaps(dir: &Path) -> Option<PathBuf> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()? {
        let Ok(e) = entry else { continue };
        let p = e.path();
        let Some(name) = p.file_name().map(|n| n.to_string_lossy().to_lowercase()) else {
            continue;
        };
        if !name.contains("gaps") || !name.ends_with(".geojson") {
            continue;
        }
        // 目录名里带 gaps 的（`output/gaps-archive/`）不该被当成结果文件
        if !p.is_file() {
            continue;
        }
        let mtime = std::fs::metadata(&p)
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        if best.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
            best = Some((mtime, p));
        }
    }
    best.map(|(_, p)| p)
}

/// 在数据根下找最新的检测结果：先看 `output/`，再退回数据根本身。
///
/// 顺序是刻意的：`output/` 是本项目约定的产物目录，数据根下偶尔会有
/// 用户手动拷出来的结果（排障/交付时很常见），作为兜底。
fn resolve_gaps_in(data: &Path) -> Option<PathBuf> {
    for sub in ["output", ""] {
        let dir = if sub.is_empty() {
            data.to_path_buf()
        } else {
            data.join(sub)
        };
        if let Some(p) = scan_gaps(&dir) {
            return Some(p);
        }
    }
    None
}

/// 结果文件：settings.json 里显式配置的优先（用户手动指定过就尊重他），
/// 否则在数据根下按 mtime 找最新的 `*gaps*.geojson`。
fn resolve_gaps(app: &tauri::AppHandle) -> Option<PathBuf> {
    let cfg = load_config();
    if let Some(p) = cfg.gaps {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    resolve_gaps_in(&data_base(app))
}

/// 写一行日志到 `%LOCALAPPDATA%\fgd\logs\app.log` 并同步打到 stderr。
///
/// 为什么需要它：release 版是 `windows_subsystem = "windows"`，没有控制台，
/// `println!` / `eprintln!` 全部丢失 —— 用户报"打不开/没影像"时完全无从下手。
/// 这个文件是唯一能看到"后端到底找到没、瓦片服务起来没"的地方。
fn log_line(msg: &str) {
    eprintln!("[fgd] {msg}");
    let Ok(local) = std::env::var("LOCALAPPDATA") else {
        return;
    };
    let dir = PathBuf::from(local).join("fgd").join("logs");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("app.log"))
    {
        use std::io::Write;
        let _ = writeln!(f, "[{stamp}] {msg}");
    }
}

/// 按后端形态构造命令，统一注入环境变量与 `CREATE_NO_WINDOW`。
fn build_command(backend: &Backend, args: &[String], bundled_cwd: &Path) -> Command {
    let mut cmd = match backend {
        Backend::Bundled(exe) => {
            let mut c = Command::new(exe);
            // ⚠️ 打包态的工作目录必须是**可写**的数据根，不能是 exe 所在目录
            //    （装到 Program Files 时那目录只读，写 output/ 与瓦片缓存会失败）。
            c.current_dir(bundled_cwd);
            c
        }
        Backend::Dev { python, root } => {
            let mut c = Command::new(python);
            c.current_dir(root);
            c
        }
    };
    for a in args {
        cmd.arg(a);
    }
    // Windows 非控制台管道默认 cp936：中文日志/路径会乱码或抛错；
    // PYTHONUNBUFFERED 让 progress 事件实时吐出（否则攒满 8 KB 才发）。
    cmd.env("PYTHONUNBUFFERED", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1");

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// 拉起瓦片服务。
///
/// **端口已被监听 ≠ 可以复用**：必须先问一句"你是谁"（`/meta` 的 `app` 字段）。
/// 公司电脑事故的根因就是这里曾经无条件 `return Ok("复用")` —— 别人的程序占着
/// 8765 时，外壳以为服务已就绪，前端却永远拿不到 `/meta`，最后报一个
/// 完全不相干的三条猜测。宁可**明确失败**，也不静默骗过用户。
fn start_tile_server(app: &tauri::AppHandle, svc: &Services) -> Result<String, String> {
    // 端口选择：8765 空闲就用；被**别的程序**占住就往后找；是我们自己的服务就复用。
    // 这一步替代了旧逻辑里"8765 有人听就报错"的行为 —— 后者在公司电脑上直接
    // 让整个功能不可用（8765 是很多内网工具/调试器的默认端口）。
    //
    // `wanted` 用**配置里的原图**而不是 tile_source：复用判定问的是
    // "这个服务服务的影像，是不是我现在要的那张"。副本只是原图的等价替身，
    // 拿副本去比会在"副本刚被清理"时误判成不一致，白重启一次。
    let wanted = resolve_image(app);
    let (port, reuse) = match pick_backend_port(wanted.as_deref()) {
        Ok(v) => v,
        Err(e) => {
            set_start_err(&e);
            log_line(&format!("瓦片服务未启动：{e}"));
            return Err(e);
        }
    };
    ACTIVE_PORT.store(port, Ordering::Relaxed);
    if reuse {
        set_start_err("");
        let msg = format!("端口 {port} 上已有本应用的瓦片服务，复用");
        log_line(&msg);
        return Ok(msg);
    }
    if port != BACKEND_PORT {
        log_line(&format!(
            "端口 {BACKEND_PORT} 被其它程序占用，改用 {port}（前端会自动跟随）"
        ));
    }

    let backend = resolve_backend(app).ok_or(
        "找不到后端：请先跑 scripts/build_desktop_runtime.ps1 打包，或配置好 .venv",
    )?;
    log_line(&format!("瓦片服务后端：{}", backend.describe()));

    // 两种形态的启动参数不同：
    //   Dev     → python scripts/tile_server.py
    //   Bundled → desktop_entry.exe --run-tile-server [--source ... --gaps ...]
    //             （打包版没有仓库根，必须显式给影像与结果的绝对路径）
    // 影像：配置优先 → 数据根默认探测。**没有影像就不启服务**，
    // 让前端显示「选择影像」引导（而不是给用户看一句开发者才懂的命令）。
    // 这里用 resolve_tile_source：建过金字塔的副本优先（像素相同、但带 overviews），
    // 没有副本时自动回落到原图 —— 与 `wanted` 的差别只在"有没有替身"。
    let image = resolve_tile_source(app);
    let gaps = resolve_gaps(app);
    // 结果文件找不到时界面只会显示"没有空地" —— 这一行是唯一的排障线索
    match &gaps {
        Some(g) => log_line(&format!("检测结果：{}", g.display())),
        None => log_line("还没有检测结果（数据根的 output/ 下没有 *gaps*.geojson）"),
    }

    let mut args: Vec<String> = Vec::new();
    if backend.is_bundled() {
        args.push("--run-tile-server".into());
        // 显式给端口：可能已经从 8765 往后挪了（8765 被别的程序占住时）
        args.push("--port".into());
        args.push(port.to_string());
        match &image {
            Some(p) => {
                args.push("--source".into());
                args.push(p.to_string_lossy().to_string());
            }
            None => {
                log_line("还没有选择正射影像，跳过瓦片服务（前端会显示选择引导）");
                return Err(NEED_IMAGE.to_string());
            }
        }
        if let Some(g) = &gaps {
            args.push("--gaps".into());
            args.push(g.to_string_lossy().to_string());
        }
    } else if let Backend::Dev { root, .. } = &backend {
        let script = root.join("scripts").join("tile_server.py");
        if !script.exists() {
            return Err(format!("找不到 {}", script.display()));
        }
        args.push(script.to_string_lossy().to_string());
        // 同上：端口可能已从 8765 往后挪
        args.push("--port".into());
        args.push(port.to_string());
        // 开发态也尊重用户选过的路径（否则"选了却不生效"很困惑）
        if let Some(p) = &image {
            args.push("--source".into());
            args.push(p.to_string_lossy().to_string());
        }
        if let Some(g) = &gaps {
            args.push("--gaps".into());
            args.push(g.to_string_lossy().to_string());
        }
    }

    let data_root = bundled_data_root(app);
    let mut cmd = build_command(&backend, &args, &data_root);
    cmd.stdout(Stdio::null()).stderr(Stdio::piped());

    // 新一轮启动：清掉上一轮的证据，否则前端看到的是上次的 traceback（会查错方向）
    if let Ok(mut buf) = TILE_LOG.lock() {
        buf.clear();
    }
    *TILE_EXIT.lock().unwrap_or_else(|e| e.into_inner()) = None;
    set_start_err("");

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("启动瓦片服务失败：{e}（{}）", backend.describe());
            set_start_err(&msg);
            log_line(&msg);
            return Err(msg);
        }
    };
    let pid = child.id();

    // 把服务的日志接住。
    //
    // ⚠️ 这里**必须**写 app.log，不能只 eprintln：
    //    release 是 `windows_subsystem = "windows"`，stderr 无人接收 —— 公司电脑
    //    现场就是这样把 GDAL/PROJ 的 traceback 全丢了，只剩一句"已启动"。
    if let Some(err) = child.stderr.take() {
        std::thread::spawn(move || {
            // ⚠️ 不能用 `.lines().map_while(Result::ok)`：只要有一行不是严格
            //    UTF-8（Windows 代码页混入、或中文横幅），迭代器就**整体停止**，
            //    后面的 traceback 全部丢失 —— 2026-10-21 实测：日志里只剩一行
            //    `====`，退出码 1 却看不到任何原因。
            //    改成按字节读到换行、再用 from_utf8_lossy 兜底：坏字节变成 �，
            //    但后续行照常记录。
            let mut reader = BufReader::new(err);
            let mut buf: Vec<u8> = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf) {
                    Ok(0) => break, // EOF
                    Ok(_) => {
                        let text = String::from_utf8_lossy(&buf);
                        let line = text.trim_end_matches(['\r', '\n']);
                        if !line.is_empty() {
                            push_tile_log(line);
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    *svc.tile.lock().unwrap() = Some(child);

    // 监视线程：等它自己退出时把**退出码**记下来。
    // 为什么需要：杀软拦截 / DLL 缺失会让进程"spawn 成功但秒退"，退出码
    // （0xC0000135 = DLL 找不到、0xC0000142 = DLL 初始化失败）是最省事的判据。
    // 原来这个数字从未被读取，于是"秒退"和"服务正常但前端连不上"在日志里
    // 长得一模一样，只能靠猜。
    let app2 = app.clone();
    std::thread::spawn(move || {
        // State 只是 app 的借用视图，必须先绑定再 lock，
        // 否则 `app2.state::<Services>().tile.lock()` 里的临时值会在语句结束被释放
        // （E0716: temporary value dropped while borrowed）。
        let services = app2.state::<Services>();
        loop {
            std::thread::sleep(Duration::from_millis(500));
            let mut guard = match services.tile.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            let Some(c) = guard.as_mut() else {
                // 被主动 kill（重启 / 退出应用）后 take() 掉了 —— 不是异常退出，不记录
                return;
            };
            if c.id() != pid {
                // 已经被新一轮启动替换掉，本线程的使命结束
                return;
            }
            match c.try_wait() {
                Ok(Some(status)) => {
                    let code = status.code();
                    *TILE_EXIT.lock().unwrap_or_else(|e| e.into_inner()) = code;
                    log_line(&format!(
                        "瓦片服务已退出：{}",
                        match code {
                            Some(0) => "退出码 0（正常结束）".to_string(),
                            // 非 0 时把十六进制一起打出来：0xC0000135 / 0xC0000142 这类
                            // NTSTATUS 是"杀软拦截 / DLL 缺失"的直接指纹
                            Some(c) => format!(
                                "退出码 {c}（0x{:08X}）—— 若非 0，见上方 [tile_server] 日志",
                                c as u32
                            ),
                            None => "被信号终止（无退出码）".to_string(),
                        }
                    ));
                    return;
                }
                Ok(None) => {}
                Err(_) => return,
            }
        }
    });

    // ⚠️ 这里**不要**再 log_line：两个调用方（setup / restart_tile_server）都会记一行，
    //    内部再记就重复了 —— 实测 app.log 里同一行出现两次，
    //    会让人误以为起了两个瓦片服务。
    Ok(format!(
        "已用 {} 启动瓦片服务（端口 {port}，数据根 {}）",
        backend.describe(),
        data_root.display()
    ))
}

/// 记录"为什么没启动"，供前端排障面板展示。
fn set_start_err(msg: &str) {
    let mut g = TILE_START_ERR.lock().unwrap_or_else(|e| e.into_inner());
    g.clear();
    g.push_str(msg);
}

// ============================================================================
//  检测：调 sidecar.py（stdio NDJSON）
//  ---------------------------------------------------------------------------
//  为什么走 stdio 而不是 HTTP：契约已冻结（95/95），sidecar 是算法唯一入口。
//
//  ★ 护栏 1（最容易踩死的一个）：**必须用两个线程分别读 stdout 与 stderr**。
//    Windows 匿名管道缓冲区只有 64 KB 左右。如果只读 stdout、等进程结束再去读
//    stderr，跑批过程中 stderr 的日志（每个瓦片都有输出）很快把它填满 →
//    Python 的 log() 阻塞在 write 上 → 整个 sidecar 永久卡死。
//    症状是"进度条停在 30% 不动、CPU 归零"，且没有任何报错 —— 极难排查。
//
//  ★ 护栏 2：Windows 非控制台管道的默认编码是 cp936，中文路径/JSON 会乱码或抛
//    UnicodeEncodeError。必须显式注入 PYTHONIOENCODING=utf-8 + PYTHONUTF8=1；
//    PYTHONUNBUFFERED=1 是为了让 progress 事件实时吐出（否则攒满 8 KB 才发）。
//
//  ★ 护栏 3：CREATE_NO_WINDOW，否则每点一次"开始检测"就闪一个黑框。
// ============================================================================
// ============================================================================
//  检测前预检（preflight_detect）
//  ---------------------------------------------------------------------------
//  为什么必须有这一步：`run_detect` 的参数里有 4 个**文件路径**，其中 chm / segment
//  缺了不会报错 —— sidecar 只回一条 W1004 就照常跑完，结果退化成"纯 RGB"。
//  用户在 350 秒后拿到一份看起来正常、语义完全不同的结果，这是最坏的一种失败。
//
//  所以把"文件在不在、输出目录写不写得进"提前到**点按钮之前**，
//  并把能自动补的（森林掩膜）自动补上。
// ============================================================================

#[derive(serde::Serialize)]
struct PreflightItem {
    key: String,
    label: String,
    path: String,
    /// ok | warn | error | info
    status: String,
    detail: String,
}

#[derive(serde::Serialize)]
struct PreflightResult {
    /// 无 error 即 true；warn 不阻塞，但前端要让用户确认
    ok: bool,
    items: Vec<PreflightItem>,
    /// 补全后的参数（绝对路径 + 自动发现的森林掩膜），前端原样交给 run_detect
    resolved: serde_json::Value,
}

/// CHM 高度阈值的三档林龄预设（与前端 `lib/chm.ts` 保持一致）。
///
/// 数值已按「大疆 DSM 平滑导致树高低估约 40%」折算成 CHM 读数。
const CHM_PRESETS: [(f64, f64, &str); 3] = [
    (5.2, 1.2, "成熟林"),
    (3.5, 0.8, "中龄林"),
    (2.2, 0.5, "幼龄林"),
];

/// 反查档位名（容差 0.05 容忍滑块步长的浮点误差）
fn chm_preset_label(core: f64, veto: f64) -> Option<&'static str> {
    CHM_PRESETS
        .iter()
        .find(|(c, v, _)| (c - core).abs() < 0.05 && (v - veto).abs() < 0.05)
        .map(|(_, _, name)| *name)
}

fn pf_item(
    key: &str,
    label: &str,
    path: &Path,
    status: &str,
    detail: impl Into<String>,
) -> PreflightItem {
    PreflightItem {
        key: key.to_string(),
        label: label.to_string(),
        path: if path.as_os_str().is_empty() {
            String::new()
        } else {
            path.to_string_lossy().to_string()
        },
        status: status.to_string(),
        detail: detail.into(),
    }
}

fn file_size_mb(p: &Path) -> f64 {
    std::fs::metadata(p)
        .map(|m| m.len() as f64 / 1_048_576.0)
        .unwrap_or(0.0)
}

/// 参数里的路径 → 绝对路径（相对的按数据基准拼）
fn absolutize(base: &Path, v: Option<&serde_json::Value>) -> Option<PathBuf> {
    let s = v?.as_str()?.trim().to_string();
    if s.is_empty() {
        return None;
    }
    let p = PathBuf::from(&s);
    Some(if p.is_absolute() { p } else { base.join(p) })
}

/// 在**一个目录**里找森林掩膜（文件名随实验变过，按前缀匹配取最新一个）。
///
/// ⚠️ 这个文件不是可选的：不套掩膜时未开发林会被算成可补种，
///    实测会多出 221 个放样点（`wgr17-elev-gaps` vs `wgr17-final-gaps` 的差）。
fn scan_forest_mask(dir: &Path) -> Option<PathBuf> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()? {
        let Ok(e) = entry else { continue };
        let p = e.path();
        let Some(name) = p.file_name().map(|n| n.to_string_lossy().to_lowercase()) else {
            continue;
        };
        if !name.starts_with("forest-mask") || !name.ends_with(".geojson") {
            continue;
        }
        let mtime = std::fs::metadata(&p)
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        if best.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
            best = Some((mtime, p));
        }
    }
    best.map(|(_, p)| p)
}

/// 「同伴文件」的搜索目录，**按优先级**：
///
/// 1. 影像所在目录 —— 用户把一套数据（ortho.tif / chm.tif / segment.tif）放一起时命中
/// 2. 影像目录下的 `output/` —— 本项目自己的约定
/// 3. 数据基准（dev=仓库根，bundled=%LOCALAPPDATA%\fgd\data）
/// 4. 数据基准下的 `output/`
///
/// 为什么要这么做：`TopToolbar` 以前把 `output/chm.tif` 写死成相对路径，
/// 用户一旦在引导里选了别的目录的影像（`E:\BlockB\ortho.tif`），
/// 这两个文件就永远找不到 —— 而 sidecar **不会报错**，只会静默退化成纯 RGB。
fn companion_dirs(image_dir: Option<&Path>, base: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(d) = image_dir {
        dirs.push(d.to_path_buf());
        dirs.push(d.join("output"));
    }
    dirs.push(base.to_path_buf());
    dirs.push(base.join("output"));
    dirs
}

fn find_companion(image_dir: Option<&Path>, base: &Path, name: &str) -> Option<PathBuf> {
    companion_dirs(image_dir, base)
        .into_iter()
        .map(|d| d.join(name))
        .find(|p| p.exists())
}

fn find_forest_mask(image_dir: Option<&Path>, base: &Path) -> Option<PathBuf> {
    for d in companion_dirs(image_dir, base) {
        if let Some(p) = scan_forest_mask(&d) {
            return Some(p);
        }
    }
    None
}

/// 预检的**纯逻辑**（不碰 AppHandle，便于单元测试）。
///
/// 所有路径都相对 `base`（dev=仓库根，bundled=数据根）解析。
fn preflight_core(base: &Path, params: &serde_json::Value) -> PreflightResult {
    let base = base;
    let params = params;
    let mut items: Vec<PreflightItem> = Vec::new();
    let mut patch: Vec<(&'static str, String)> = Vec::new();
    let mut has_error = false;

    // ---- 1. 正射影像（必需）----
    // 影像所在目录是"同伴文件"的第一搜索位置，先留个引用
    let mut image_path: Option<PathBuf> = None;
    match absolutize(&base, params.get("input")) {
        None => {
            has_error = true;
            items.push(pf_item(
                "image", "正射影像", Path::new(""), "error",
                "还没有选择影像",
            ));
        }
        Some(p) if !p.exists() => {
            has_error = true;
            items.push(pf_item(
                "image", "正射影像", &p, "error",
                "文件不存在，请点「数据」重新选择",
            ));
        }
        Some(p) => {
            let ext = p
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            let mb = file_size_mb(&p);
            if ext != "tif" && ext != "tiff" {
                items.push(pf_item(
                    "image", "正射影像", &p, "warn",
                    format!("扩展名是 .{ext}，不是 GeoTIFF，可能读不出来"),
                ));
            } else if mb < 1.0 {
                items.push(pf_item(
                    "image", "正射影像", &p, "warn",
                    format!("只有 {mb:.1} MB，不像完整影像"),
                ));
            } else {
                items.push(pf_item("image", "正射影像", &p, "ok", format!("{mb:.0} MB")));
            }
            patch.push(("input", p.to_string_lossy().to_string()));
            image_path = Some(p);
        }
    }
    let image_dir = image_path.as_ref().and_then(|p| p.parent());

    // ---- 2/3. CHM 与语义分割（缺失会静默退化，所以 warn 而不拦）----
    for (key, label, hint, fname) in [
        (
            "chm_path",
            "冠层高度模型（CHM）",
            "缺了会退化成纯 RGB 判据，水体与低矮植被会大量误判",
            "chm.tif",
        ),
        (
            "segment_path",
            "语义分割结果",
            "缺了水塘识别率会从 98% 掉回 8%",
            "segment.tif",
        ),
    ] {
        // 参数里写的位置优先（且必须真存在），否则去影像旁边找
        let explicit = absolutize(&base, params.get(key)).filter(|p| p.exists());
        let found = explicit.or_else(|| find_companion(image_dir, &base, fname));
        match found {
            Some(p) => {
                let mb = file_size_mb(&p);
                items.push(pf_item(
                    key, label, &p, "ok",
                    format!("{mb:.0} MB（自动关联）"),
                ));
                patch.push((key, p.to_string_lossy().to_string()));
            }
            None => items.push(pf_item(
                key, label, Path::new(""), "warn",
                format!(
                    "在影像同目录与 output/ 下都没找到 {fname} —— {hint}"
                ),
            )),
        }
    }

    // ---- 4. 森林掩膜（自动发现）----
    let fm = absolutize(&base, params.get("forest_mask_path"))
        .filter(|p| p.exists())
        .or_else(|| find_forest_mask(image_dir, &base));
    match fm {
        Some(p) => {
            items.push(pf_item(
                "forest_mask", "森林掩膜", &p, "ok",
                "已自动启用（剔除未开发林）",
            ));
            patch.push(("forest_mask_path", p.to_string_lossy().to_string()));
        }
        None => items.push(pf_item(
            "forest_mask", "森林掩膜", Path::new(""), "warn",
            "没找到 output/forest-mask*.geojson —— 未开发林会被算成可补种，放样点会偏多",
        )),
    }

    // ---- 5. 输出目录（写不进去就白跑 350 秒）----
    let work = absolutize(&base, params.get("work_dir"))
        .unwrap_or_else(|| base.join("output").join("jobs"));
    match std::fs::create_dir_all(&work) {
        Ok(_) => {
            // 真写一个探针文件：目录建得出来 ≠ 写不进去（权限 / 只读盘）
            let probe = work.join(".fgd-write-probe");
            match std::fs::write(&probe, b"ok") {
                Ok(_) => {
                    let _ = std::fs::remove_file(&probe);
                    items.push(pf_item("work_dir", "输出目录", &work, "ok", "可写"));
                    patch.push(("work_dir", work.to_string_lossy().to_string()));
                }
                Err(e) => {
                    has_error = true;
                    items.push(pf_item(
                        "work_dir", "输出目录", &work, "error",
                        format!("写不进去：{e}"),
                    ));
                }
            }
        }
        Err(e) => {
            has_error = true;
            items.push(pf_item(
                "work_dir", "输出目录", &work, "error",
                format!("建不出来：{e}"),
            ));
        }
    }

    // ---- 6. 圈选范围 ----
    if params.get("roi_geojson").is_some() {
        items.push(pf_item(
            "roi", "圈选范围", Path::new(""), "ok",
            "已圈选，只检测圈内",
        ));
    } else {
        match absolutize(&base, params.get("roi")) {
            Some(p) if p.exists() => items.push(pf_item(
                "roi", "圈选范围", &p, "ok", "只检测圈内",
            )),
            Some(p) => {
                has_error = true;
                items.push(pf_item(
                    "roi", "圈选范围", &p, "error", "圈选文件不存在",
                ));
            }
            None => items.push(pf_item(
                "roi", "圈选范围", Path::new(""), "info",
                "未圈选，将处理整幅影像（较慢）",
            )),
        }
    }

    // ---- 7. 参数合法性 ----
    let workers = params.get("workers").and_then(|v| v.as_i64()).unwrap_or(1);
    if !(0..=32).contains(&workers) {
        has_error = true;
        items.push(pf_item(
            "workers", "并行进程数", Path::new(""), "error",
            format!("{workers} 超出 0~32"),
        ));
    }
    let density = params
        .get("target_density_per_ha")
        .and_then(|v| v.as_f64())
        .unwrap_or(150.0);
    if !(20.0..=400.0).contains(&density) {
        has_error = true;
        items.push(pf_item(
            "density", "目标密度", Path::new(""), "error",
            format!("{density} 株/ha 超出 20~400"),
        ));
    }

    // ---- 8. CHM 高度阈值（缺陷台账 P1-3）----
    //
    // 互锁：`0.2 ≤ veto ≤ core − 0.5`。
    // 为什么必须拦：如果把否决线拉到救援线之上（例如 core=3.0 / veto=4.0），
    // 树高 3.5 m 会同时满足「≥ core」和「< veto」，结果取决于代码里两个 if
    // 的先后顺序 —— 属于**静默不可预期**，比报错糟糕得多。
    let chm_core = params
        .get("elevation_core_chm")
        .and_then(|v| v.as_f64())
        .unwrap_or(5.2);
    let chm_veto = params
        .get("elevation_veto_chm")
        .and_then(|v| v.as_f64())
        .unwrap_or(1.2);
    if !(0.5..=15.0).contains(&chm_core) {
        has_error = true;
        items.push(pf_item(
            "chm", "CHM 高度阈值", Path::new(""), "error",
            format!("救援线 {chm_core:.1} m 超出 0.5~15 m"),
        ));
    } else if chm_veto < 0.2 {
        has_error = true;
        items.push(pf_item(
            "chm", "CHM 高度阈值", Path::new(""), "error",
            format!("否决线 {chm_veto:.1} m 不能低于 0.2 m"),
        ));
    } else if chm_veto > chm_core - 0.5 {
        has_error = true;
        items.push(pf_item(
            "chm", "CHM 高度阈值", Path::new(""), "error",
            format!(
                "否决线（{chm_veto:.1} m）必须比救援线（{chm_core:.1} m）低至少 0.5 m"
            ),
        ));
    } else {
        let label = match chm_preset_label(chm_core, chm_veto) {
            Some(n) => format!("{n}档"),
            None => "自定义".to_string(),
        };
        let is_default = (chm_core - 5.2).abs() < 0.05 && (chm_veto - 1.2).abs() < 0.05;
        items.push(pf_item(
            "chm", "CHM 高度阈值", Path::new(""),
            if is_default { "ok" } else { "info" },
            format!(
                "救援 {chm_core:.1} m / 否决 {chm_veto:.1} m（{label}）{}",
                if is_default {
                    ""
                } else {
                    " —— 非 Stage 14 基线，结果不可与历史交付数字直接对比"
                }
            ),
        ));
    }

    // ---- 组装 resolved ----
    let mut resolved = params.clone();
    if let Some(o) = resolved.as_object_mut() {
        for (k, v) in patch {
            o.insert(k.to_string(), serde_json::Value::String(v));
        }
    }

    PreflightResult {
        ok: !has_error,
        items,
        resolved,
    }
}

#[tauri::command]
fn preflight_detect(
    app: tauri::AppHandle,
    params: serde_json::Value,
) -> Result<PreflightResult, String> {
    Ok(preflight_core(&data_base(&app), &params))
}

// ============================================================================
//  「生成高度图 / 林地边界」（等价于命令行跑 build_chm.py + build_forest_mask.py）
// ----------------------------------------------------------------------------
//  为什么要在界面里做：换园区时这两个文件必须重算，而命令行对现场用户不可用
//  （他们不知道 .venv、不知道 --dsm 该指哪）。不做的话，换个园区就只能出一份
//  「纯 RGB 的降级结果」，而且**界面不会报错**——这是最坏的一种失败。
// ============================================================================

/// 找出「生成派生数据」需要的输入。
///
/// 与 `preflight_core` 分成两个函数，是因为它们的**输入集不同**：
/// 检测要 chm/segment/掩膜，生成要 dsm/tree_info。混在一起会让两边的检查项互相污染。
fn derive_core(base: &Path, params: &serde_json::Value) -> PreflightResult {
    let mut items: Vec<PreflightItem> = Vec::new();
    let mut has_error = false;
    let mut resolved = serde_json::Map::new();

    let s = |k: &str| -> String {
        params
            .get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
    };

    // ---- 1. 正射影像（必需：决定 CHM 的对齐网格）----
    let input = s("input");
    let img_path = {
        let pb = PathBuf::from(&input);
        if pb.is_absolute() {
            pb
        } else {
            base.join(&input)
        }
    };
    let img_dir = img_path.parent().map(|d| d.to_path_buf());
    if input.is_empty() {
        has_error = true;
        items.push(pf_item(
            "input", "正射影像", Path::new(""), "error",
            "没有选择正射影像 —— 高度图需要按它的网格对齐",
        ));
    } else if img_path.exists() {
        items.push(pf_item(
            "input", "正射影像", &img_path, "ok",
            format!("{} MB", file_mb(&img_path)),
        ));
        resolved.insert("input".to_string(), img_path.to_string_lossy().into());
    } else {
        has_error = true;
        items.push(pf_item(
            "input", "正射影像", &img_path, "error",
            "文件不存在 —— 先选好影像",
        ));
    }

    // ---- 2. DSM（必需，唯一真正必需的输入）----
    //   CHM = DSM − 地面高程。没有 DSM 就无从谈起。
    let dsm = match find_companion(img_dir.as_deref(), base, "dsm.tif") {
        Some(p) => {
            items.push(pf_item(
                "dsm", "地表高程 DSM", &p, "ok",
                format!("{} MB · 用于算树高", file_mb(&p)),
            ));
            resolved.insert("dsm".to_string(), p.to_string_lossy().into());
            Some(p)
        }
        None => {
            has_error = true;
            items.push(pf_item(
                "dsm", "地表高程 DSM", Path::new(""), "error",
                "在影像同目录与 output/ 下都没找到 dsm.tif —— 这是唯一必需的输入，\
                 大疆智图导出目录里叫 dsm.tif",
            ));
            None
        }
    };
    let _ = dsm;

    // ---- 3. 语义分割（可选：只影响水面在 CHM 里是否置空）----
    match find_companion(img_dir.as_deref(), base, "segment.tif") {
        Some(p) => {
            items.push(pf_item(
                "segment", "语义分割", &p, "ok",
                "用于把水面在高度图里置空（缺了水面会被当成矮树）",
            ));
            resolved.insert("segment".to_string(), p.to_string_lossy().into());
        }
        None => items.push(pf_item(
            "segment", "语义分割", Path::new(""), "warn",
            "没找到 segment.tif —— 水面不会被置空，水塘可能算出偏高的树高",
        )),
    }

    // ---- 4. 树心表（可选：缺了只出 CHM，跳过林地边界）----
    match find_companion(img_dir.as_deref(), base, "tree_info.json") {
        Some(p) => {
            items.push(pf_item(
                "tree_info", "树心表", &p, "ok",
                format!("{} KB · 用于算林地边界", file_kb(&p)),
            ));
            resolved.insert("tree_info".to_string(), p.to_string_lossy().into());
        }
        None => items.push(pf_item(
            "tree_info", "树心表", Path::new(""), "info",
            "没找到 tree_info.json —— 这次只生成高度图，林地边界会被跳过",
        )),
    }

    // ---- 5. 输出目录（必需：写不进去就白跑几十秒）----
    let out_dir = base.join("output");
    match std::fs::create_dir_all(&out_dir) {
        Ok(()) => {
            // 建得出来 ≠ 写得进去（只读盘上就是这种情况），真写一个探针再删
            let probe = out_dir.join(".fgd-derive-probe");
            match std::fs::write(&probe, b"x") {
                Ok(()) => {
                    let _ = std::fs::remove_file(&probe);
                    items.push(pf_item(
                        "out_dir", "输出目录", &out_dir, "ok", "可写",
                    ));
                    resolved.insert(
                        "out_chm".to_string(),
                        out_dir.join("chm.tif").to_string_lossy().into(),
                    );
                    resolved.insert(
                        "out_mask".to_string(),
                        out_dir.join("forest-mask.geojson").to_string_lossy().into(),
                    );
                }
                Err(e) => {
                    has_error = true;
                    items.push(pf_item(
                        "out_dir", "输出目录", &out_dir, "error",
                        format!("目录建得出来但写不进去：{e}"),
                    ));
                }
            }
        }
        Err(e) => {
            has_error = true;
            items.push(pf_item(
                "out_dir", "输出目录", &out_dir, "error",
                format!("无法创建：{e}"),
            ));
        }
    }

    // ---- 6. 会被覆盖提示（不是错误，但要让人知道）----
    let chm_exists = out_dir.join("chm.tif").exists();
    let mask_exists = out_dir.join("forest-mask.geojson").exists();
    if chm_exists || mask_exists {
        let mut what = Vec::new();
        if chm_exists {
            what.push("chm.tif");
        }
        if mask_exists {
            what.push("forest-mask.geojson");
        }
        items.push(pf_item(
            "overwrite", "已有同名文件", &out_dir, "warn",
            format!(
                "{} 已存在，生成后会覆盖。如果当前检测结果是用旧的高度图算的，\
                 建议生成完重跑一次检测",
                what.join(" 与 ")
            ),
        ));
    }

    PreflightResult {
        ok: !has_error,
        items,
        resolved: serde_json::Value::Object(resolved),
    }
}

fn file_mb(p: &Path) -> String {
    std::fs::metadata(p)
        .map(|m| format!("{:.1}", m.len() as f64 / 1_048_576.0))
        .unwrap_or_else(|_| "?".into())
}

fn file_kb(p: &Path) -> String {
    std::fs::metadata(p)
        .map(|m| format!("{:.0}", m.len() as f64 / 1024.0))
        .unwrap_or_else(|_| "?".into())
}

#[tauri::command]
fn preflight_derived(app: tauri::AppHandle, params: serde_json::Value) -> Result<PreflightResult, String> {
    Ok(derive_core(&data_base(&app), &params))
}

/// 启动「生成高度图 / 林地边界」。
///
/// 事件名与检测分开（`derived-event` / `derived-log`）：前端两个进度条语义不同，
/// 混在一个通道里会出现"检测进度条在跳，但你在做别的事"。
#[tauri::command]
fn run_build_derived(
    app: tauri::AppHandle,
    state: tauri::State<'_, Services>,
    params: serde_json::Value,
) -> Result<String, String> {
    {
        let guard = state.derive.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Err("已有生成任务在运行，请等它完成".into());
        }
    }
    // 检测在跑时不允许生成：两者都会写 output/，同时跑会互相覆盖中间产物
    {
        let g = state.detect.lock().map_err(|e| e.to_string())?;
        if g.is_some() {
            return Err("检测正在运行，请等它完成再生（两者都会写 output/）".into());
        }
    }

    let backend = resolve_backend(&app).ok_or("找不到后端（打包运行时与 .venv 都不存在）")?;

    let base = bundled_data_root(&app);
    let abs = |k: &str| -> String {
        let raw = params.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        if raw.is_empty() {
            return raw;
        }
        let pb = Path::new(&raw);
        if pb.is_absolute() {
            raw
        } else {
            base.join(pb).to_string_lossy().to_string()
        }
    };

    let mut args: Vec<String> = Vec::new();
    if let Backend::Dev { root, .. } = &backend {
        let script = root.join("scripts").join("build_derived.py");
        if !script.exists() {
            return Err(format!("找不到 {}", script.display()));
        }
        args.push(script.to_string_lossy().to_string());
    } else {
        args.push("--build-derived".into());
    }
    args.push("--ortho".into());
    args.push(abs("input"));
    args.push("--dsm".into());
    args.push(abs("dsm"));
    let seg = abs("segment");
    if !seg.is_empty() {
        args.push("--segment".into());
        args.push(seg);
    }
    let ti = abs("tree_info");
    if !ti.is_empty() {
        args.push("--tree-info".into());
        args.push(ti);
    }
    args.push("--out-chm".into());
    args.push(abs("out_chm"));
    args.push("--out-mask".into());
    args.push(abs("out_mask"));

    let data_root = bundled_data_root(&app);
    let mut cmd = build_command(&backend, &args, &data_root);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动生成进程失败：{e}（{}）", backend.describe()))?;

    let stdout = child.stdout.take().ok_or("拿不到 stdout")?;
    let stderr = child.stderr.take().ok_or("拿不到 stderr")?;
    *state.derive.lock().map_err(|e| e.to_string())? = Some(child);

    let app_out = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let t = line.trim();
            if t.is_empty() {
                continue;
            }
            let payload = serde_json::from_str::<serde_json::Value>(t)
                .unwrap_or_else(|_| serde_json::json!({ "event": "raw", "line": t }));
            let _ = app_out.emit("derived-event", payload);
        }
        if let Some(st) = app_out.try_state::<Services>() {
            if let Ok(mut g) = st.derive.lock() {
                if let Some(mut c) = g.take() {
                    let _ = c.wait();
                }
            }
        }
    });

    let app_err = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = app_err.emit("derived-log", line);
        }
    });

    log_line("已启动「生成高度图 / 林地边界」");
    Ok("started".into())
}

#[tauri::command]
fn run_detect(
    app: tauri::AppHandle,
    state: tauri::State<'_, Services>,
    params: serde_json::Value,
) -> Result<String, String> {
    // 防重入：同一时间只允许一个检测（否则两个进程抢同一份瓦片缓存）
    {
        let guard = state.detect.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Err("已有检测任务在运行，请先取消或等它完成".into());
        }
    }

    let backend = resolve_backend(&app)
        .ok_or("找不到后端（打包运行时与 .venv 都不存在）")?;
    // ROI 传递：sidecar 的 `roi` 参数是**文件路径**，不接受内联几何。
    // 前端把画好的多边形作为 `roi_geojson` 传进来，这里落成临时 GeoJSON 再替换。
    let mut payload = params;
    if let Some(roi_geom) = payload.get("roi_geojson").cloned() {
        let tmp = std::env::temp_dir().join(format!("fgd-roi-{}.geojson", std::process::id()));
        let fc = serde_json::json!({
            "type": "FeatureCollection",
            "features": [{ "type": "Feature", "properties": {}, "geometry": roi_geom }]
        });
        let text = serde_json::to_string(&fc).map_err(|e| format!("ROI 序列化失败：{e}"))?;
        std::fs::write(&tmp, text).map_err(|e| format!("写 ROI 临时文件失败：{e}"))?;
        if let Some(obj) = payload.as_object_mut() {
            obj.remove("roi_geojson");
            obj.insert(
                "roi".to_string(),
                serde_json::Value::String(tmp.to_string_lossy().to_string()),
            );
        }
    }
    // 打包态没有仓库根：把相对路径参数补成 data 根下的绝对路径。
    // 前端传的是 `drone data/WGR17-002.tif`、`output/chm.tif` 这类相对路径，
    // 在 Dev 模式下靠 cwd=仓库根 就能解析；打包后必须自己拼。
    if backend.is_bundled() {
        let base = bundled_data_root(&app);
        for key in [
            "input", "chm_path", "segment_path", "out_json", "work_dir", "forest_mask",
        ] {
            if let Some(v) = payload.get_mut(key) {
                if let Some(txt) = v.as_str() {
                    if !txt.is_empty() && Path::new(txt).is_relative() {
                        *v = serde_json::Value::String(
                            base.join(txt).to_string_lossy().to_string(),
                        );
                    }
                }
            }
        }
    }

    let json = serde_json::to_string(&payload).map_err(|e| format!("参数序列化失败：{e}"))?;

    let mut args: Vec<String> = Vec::new();
    if let Backend::Dev { root, .. } = &backend {
        let script = root.join("scripts").join("sidecar.py");
        if !script.exists() {
            return Err(format!("找不到 {}", script.display()));
        }
        args.push(script.to_string_lossy().to_string());
    }
    args.push("--params-json".into());
    args.push(json);

    let data_root = bundled_data_root(&app);
    let mut cmd = build_command(&backend, &args, &data_root);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 sidecar 失败：{e}（{}）", backend.describe()))?;

    let stdout = child.stdout.take().ok_or("拿不到 sidecar stdout")?;
    let stderr = child.stderr.take().ok_or("拿不到 sidecar stderr")?;

    // 先登记句柄再起读线程：否则进程结束得很快时，读线程 take 到的会是 None
    *state.detect.lock().map_err(|e| e.to_string())? = Some(child);

    // ---- 线程 A：stdout → NDJSON 事件 → 前端 ----
    let app_out = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let t = line.trim();
            if t.is_empty() {
                continue;
            }
            let payload = match serde_json::from_str::<serde_json::Value>(t) {
                Ok(v) => v,
                // 非 JSON 行（理论上不该有，stdout 是数据通道）也要让前端看见
                Err(_) => serde_json::json!({ "event": "raw", "line": t }),
            };
            let _ = app_out.emit("sidecar-event", payload);
        }
        // 进程已退出：回收子进程并清空句柄，否则 cancel_detect 会 wait 一个死进程
        if let Some(st) = app_out.try_state::<Services>() {
            if let Ok(mut g) = st.detect.lock() {
                if let Some(mut c) = g.take() {
                    let _ = c.wait();
                }
            }
        }
    });

    // ---- 线程 B：stderr → 人类日志 → 前端状态栏 ----
    let app_err = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = app_err.emit("sidecar-log", line);
        }
    });

    Ok("started".into())
}

/// 中途取消（全量要 350 秒，用户很可能画错框想中止）
#[tauri::command]
fn cancel_detect(state: tauri::State<'_, Services>) -> Result<String, String> {
    let mut guard = state.detect.lock().map_err(|e| e.to_string())?;
    match guard.take() {
        Some(mut child) => {
            child.kill().map_err(|e| format!("取消失败：{e}"))?;
            let _ = child.wait(); // 回收，避免僵尸进程
            Ok("已取消".into())
        }
        None => Ok("当前没有运行中的检测".into()),
    }
}

/// 前端进来时问一句"是不是有任务在跑"（比如 HMR 重载后要恢复 UI 状态）
#[tauri::command]
fn detect_status(state: tauri::State<'_, Services>) -> bool {
    state
        .detect
        .lock()
        .map(|g| g.is_some())
        .unwrap_or(false)
}

/// 前端启动时问一次：现在有没有可用影像？要不要显示引导？
#[tauri::command]
fn get_status(app: tauri::AppHandle) -> AppStatus {
    let cfg = load_config();
    let image = resolve_image(&app);
    AppStatus {
        backend: resolve_backend(&app).map(|b| b.describe()),
        tile_running: port_open(active_port()),
        image: image.as_ref().map(|p| p.display().to_string()),
        gaps: cfg
            .gaps
            .clone()
            .or_else(|| resolve_gaps(&app).map(|p| p.display().to_string())),
        data_root: data_base(&app).display().to_string(),
        needs_setup: image.is_none(),
    }
}

/// 换影像且没有同时指定新结果时，必须清掉旧结果路径。
///
/// 为什么：旧结果属于上一张影像（网格原点/坐标系都可能不同）。继续挂着会让前端
/// 认为"检测已完成"直接跳到「复核结果」，同时弹"结果没读到"（2026-10-21 实测）。
///
/// 抽成纯函数而不是留在 `set_data_paths` 里内联判断：那个命令要碰文件系统、
/// 配置文件、子进程和 AppHandle，写集成测试的成本远高于收益，
/// 而这里出错的代价是"界面状态错乱"这种不报错、只让人困惑的故障 ——
/// 恰恰是最需要被测试钉住的一类。纯函数四个分支覆盖完，测试是确定性的。
fn should_clear_gaps(
    _old_image: &Option<String>,
    _new_image: &Option<String>,
    gaps_given: bool,
) -> bool {
    // ⚠️ 不再要求"影像变了"。
    //
    // 用户点「换一张影像」再选**同一张** tif 时，意图是"重新开始"，不是"继续上次"。
    // 旧逻辑 `new_image != old_image && !gaps_given` 在这种情形下返回 false →
    // cfg.gaps 保留 → 前端一加载就跳回第 4 步（2026-10-23 实测）。
    // `gaps_given` 仍然要尊重：用户明确指定了结果文件时不能清。
    !gaps_given
}

/// 用户选了影像（或结果文件）→ 存配置 + 重启瓦片服务。
///
/// `restart_tile_server` 内部会先 kill 旧进程再起新的，所以这里直接复用，
/// 但要把旧进程杀掉后等端口释放（它已经做了）。
#[tauri::command]
fn set_data_paths(
    app: tauri::AppHandle,
    state: tauri::State<'_, Services>,
    image: Option<String>,
    gaps: Option<String>,
) -> Result<AppStatus, String> {
    let mut cfg = load_config();
    let old_image = cfg.image.clone();
    if let Some(p) = image {
        let pb = PathBuf::from(&p);
        if !pb.exists() {
            return Err(format!("影像文件不存在：{p}"));
        }
        cfg.image = Some(p);
    }
    // ⚠️ 换影像且没指定新结果时，**必须清掉旧结果**：
    //    旧结果是上一张影像跑出来的，网格原点/坐标系都可能完全不同，
    //    继续挂着会让前端认为"检测已完成"直接跳到「复核结果」，
    //    同时弹出"结果没读到"（2026-10-21 公司电脑实测）。
    //    判定条件抽在 should_clear_gaps 里（有单测）。
    //
    // 换影像时 `tile_source`（金字塔副本）也必须一起清：副本属于上一张影像，
    // 留着会让瓦片服务继续显示**旧影像**，而界面上完全看不出来 ——
    // 这比"换影像跳复核"更难发现。下次建金字塔时自然会重新写。
    if cfg.image != old_image {
        cfg.tile_source = None;
    }
    if should_clear_gaps(&old_image, &cfg.image, gaps.is_some()) {
        cfg.gaps = None;
    }
    if let Some(g) = gaps {
        let pb = PathBuf::from(&g);
        if !pb.exists() {
            return Err(format!("结果文件不存在：{g}"));
        }
        cfg.gaps = Some(g);
    }
    save_config(&cfg)?;
    log_line(&format!(
        "用户选择数据：影像={:?} 结果={:?}",
        cfg.image, cfg.gaps
    ));

    // 重启瓦片服务（旧的可能在跑着"没有影像"的实例，或者指向旧影像）
    if let Some(mut child) = state.tile.lock().map_err(|e| e.to_string())?.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    for _ in 0..40 {
        if !port_open(active_port()) {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    // 主动换数据不算"异常退出"，别把上一轮的退出码留成这一轮的证据
    *TILE_EXIT.lock().unwrap_or_else(|e| e.into_inner()) = None;
    match start_tile_server(&app, &state) {
        Ok(msg) => log_line(&msg),
        Err(e) if e == NEED_IMAGE => {}
        Err(e) => {
            log_line(&format!("重启瓦片服务失败：{e}"));
            // ⚠️ 必须**当场抛回前端**，不能只写日志。
            //    以前这里吞掉了错误，前端只好空等 120 秒再弹一句
            //    "请确认①文件占用②标准GeoTIFF③磁盘空间"—— 三条全都不对。
            //    现在端口被别的程序占住这类硬失败会立刻显示真因。
            return Err(e);
        }
    }

    Ok(get_status(app))
}

// ============================================================================
//  文件读取 / 打开目录（P2：KML 导入与导出后的一步操作）
// ============================================================================

/// 读取文本文件（KML / GeoJSON）。
///
/// 为什么要 Rust 读而不是前端 `fetch('file://...')`：
/// Tauri 的 webview 有 CSP，`file://` 默认被拦；走 IPC 一次读完最简单。
///
/// ⚠️ 大小上限 16 MB：KML 通常几十 KB，真给了个几百 MB 的文件说明用户
///    选错了（比如选了 tif），直接报错比让 webview 卡死好。
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    const MAX_BYTES: u64 = 16 * 1024 * 1024;
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("文件不存在：{path}"));
    }
    let meta = std::fs::metadata(&p).map_err(|e| format!("读不到文件信息：{e}"))?;
    if meta.len() > MAX_BYTES {
        return Err(format!(
            "文件太大（{:.1} MB），范围文件通常只有几十 KB —— 是不是选错了？",
            meta.len() as f64 / 1_048_576.0
        ));
    }
    let bytes = std::fs::read(&p).map_err(|e| format!("读取失败：{e}"))?;
    // KML 有时是 GBK（老版本奥维），非法 UTF-8 时退化成有损解码而不是直接失败
    Ok(String::from_utf8(bytes)
        .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).to_string()))
}

/// 在系统资源管理器里打开目录（或选中文件）。
///
/// 导出完成后用户最想做的事就是"去文件夹里拷走" —— 少点几次鼠标。
#[tauri::command]
fn open_path(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("路径不存在：{path}"));
    }
    // 传文件时用 /select, 让资源管理器直接选中它
    let target = if p.is_dir() {
        p.clone()
    } else {
        p.parent().map(|d| d.to_path_buf()).unwrap_or_else(|| p.clone())
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut cmd = Command::new("explorer");
        cmd.arg(target.as_os_str());
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.spawn().map_err(|e| format!("打开资源管理器失败：{e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(target.as_os_str())
            .spawn()
            .map_err(|e| format!("打开访达失败：{e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(target.as_os_str())
            .spawn()
            .map_err(|e| format!("打开文件管理器失败：{e}"))?;
    }
    log_line(&format!("已打开：{}", target.display()));
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
fn backend_url() -> String {
    format!("http://127.0.0.1:{}", active_port())
}

#[tauri::command]
fn service_status(app: tauri::AppHandle) -> ServiceStatus {
    ServiceStatus {
        backend_url: format!("http://127.0.0.1:{}", active_port()),
        // 端口有人听 ≠ 我们的服务在跑（别的程序也可能占着 8765）。
        // 这里必须验身份，否则这个"状态"会在最需要它的时候撒谎。
        tile_server_running: is_our_service(),
        backend: resolve_backend(&app).map(|b| b.describe()),
        project_root: project_root(&app).map(|p| p.display().to_string()),
    }
}

/// 8765 上是否真的是本应用的瓦片服务在跑。
fn is_our_service() -> bool {
    let port = active_port();
    port_open(port)
        && http_get_meta(port)
            .map(|b| is_our_meta(&b))
            .unwrap_or(false)
}

/// 影像的「加速结构体检」结果（`--overviews-only --dry-run` 的 plan 事件）。
///
/// 字段名与 `scripts/tile_server.py::overview_plan()` 返回的键**逐字一致** ——
/// 这里派生 `Deserialize`，改一个名字就会立刻报"字段不完整"，
/// 比手工逐个 `get()` 更能防住两边悄悄分叉。
#[derive(serde::Serialize, serde::Deserialize)]
struct OverviewPlan {
    /// none | ovr | copy | inplace | error
    action: String,
    /// 给用户看的一句话（"已有金字塔，无需处理" 等）
    why: String,
    has_overviews: bool,
    size_bytes: u64,
    need_bytes: u64,
    free_bytes: u64,
    enough_space: bool,
    /// 额外文件会落在哪个目录（copy 是 output/.tile-cache，其余是影像旁边）
    target_dir: String,
    /// 有没有 gdaladdo（有它就能只占 1/3 磁盘）。python 侧是 `str | null`
    gdaladdo: Option<String>,
    /// 会不会改动用户的原始文件（只有 inplace 是 true）
    touches_source: bool,
}

/// 一次 `--overviews-only` 子进程跑完的产物。
struct OverviewRun {
    /// stdout 上解析出来的所有 JSON 事件（plan / done）
    events: Vec<serde_json::Value>,
    stderr: String,
    success: bool,
    code: Option<i32>,
}

impl OverviewRun {
    /// 取最后一个指定名字的事件（中途可能有多条，只关心最后一条）
    fn last(&self, name: &str) -> Option<&serde_json::Value> {
        self.events
            .iter()
            .rev()
            .find(|v| v.get("event").and_then(|e| e.as_str()) == Some(name))
    }
}

/// 跑一次 `--overviews-only`（`dry_run` 时加 `--dry-run`），把事件与 stderr 收回来。
///
/// 为什么体检与建金字塔共用一个函数：两者只差一个 `--dry-run` 开关，
/// 参数拼法、两个读线程、事件解析完全一样。抄两份的下场是"改了一处忘了另一处"。
/// 轮询等待建金字塔进程结束。
///
/// 为什么不用 `child.wait()`：句柄已经交给 `Services`，退出钩子随时可能把它 kill
/// 掉；而 `wait()` 期间我们拿着独占句柄，钩子反而杀不到 —— 那就退化成孤儿了。
/// 轮询 `try_wait()` 的代价是 200ms 一次，对 2~3 分钟的操作可以忽略。
fn poll_overviews_child(
    app: &tauri::AppHandle,
) -> Result<std::process::ExitStatus, String> {
    loop {
        {
            let state = app.try_state::<Services>().ok_or("拿不到 Services")?;
            let mut guard = state.overviews.lock().map_err(|e| e.to_string())?;
            match guard.as_mut() {
                Some(c) => {
                    if let Some(st) = c.try_wait().map_err(|e| e.to_string())? {
                        guard.take(); // 收尸：别留僵尸句柄，也避免下次误 kill 一个已结束的 pid
                        return Ok(st);
                    }
                }
                // 槽位被退出钩子清空了 —— 应用正在退出
                None => return Err("建立加速结构被中断（应用正在退出）".into()),
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}

fn run_overviews_child(
    app: &tauri::AppHandle,
    mode: &str,
    dry_run: bool,
) -> Result<OverviewRun, String> {
    let image = resolve_image(app).ok_or("还没有选择正射影像")?;
    let backend = resolve_backend(app).ok_or(
        "找不到后端：请先跑 scripts/build_desktop_runtime.ps1 打包，或配置好 .venv",
    )?;

    // 参数照抄 start_tile_server 的两种形态：dev 是 `python <脚本>`，
    // bundled 是 `desktop_entry.exe --run-tile-server`（同一个入口，多一个开关）。
    let mut args: Vec<String> = Vec::new();
    match &backend {
        Backend::Dev { root, .. } => {
            let script = root.join("scripts").join("tile_server.py");
            if !script.exists() {
                return Err(format!("找不到 {}", script.display()));
            }
            args.push(script.to_string_lossy().to_string());
        }
        Backend::Bundled(_) => args.push("--run-tile-server".into()),
    }
    args.push("--overviews-only".into());
    args.push("--source".into());
    args.push(image.to_string_lossy().to_string());
    args.push("--ovr-mode".into());
    args.push(mode.to_string());
    if dry_run {
        args.push("--dry-run".into());
    }

    let data_root = bundled_data_root(app);
    let mut cmd = build_command(&backend, &args, &data_root);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    log_line(&format!(
        "{}（mode={mode}，影像 {}）",
        if dry_run {
            "检查加速结构"
        } else {
            "开始建立加速结构"
        },
        image.display()
    ));
    // ⚠️ 启动前先杀掉上一轮可能还在跑的建金字塔进程。
    //
    // 这是解决"两个进程同时写同一个 .part"的**关键**：Python 侧开头会删残留
    // `.part`，但那是"清理垃圾"，不是"消除竞争" —— 如果旧进程还活着，
    // 删了它正在写的文件只会让它继续往已删除的 inode 写，或者直接撞
    // `PermissionError: [WinError 32]`。让旧的先死，竞争才真的没了。
    //
    // 触发场景（不是理论）：用户点「开始」→ 嫌慢 → 关窗 → 重开 → 再点一次。
    // 新进程的 `OVERVIEW_BUILDING` 是全新的 false，挡不住上一轮的孤儿。
    //
    // dry_run 不参与：它几百毫秒就结束，且不应该打断正在进行的正式构建。
    if !dry_run {
        if let Some(state) = app.try_state::<Services>() {
            if let Ok(mut guard) = state.overviews.lock() {
                if let Some(mut old) = guard.take() {
                    log_line("上一轮建金字塔进程仍在运行，先终止它再重新开始");
                    let _ = old.kill();
                    let _ = old.wait();
                }
            }
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动加速结构进程失败：{e}（{}）", backend.describe()))?;

    let stdout = child.stdout.take().ok_or("拿不到 stdout")?;
    let stderr = child.stderr.take().ok_or("拿不到 stderr")?;

    // 正式构建才纳管：退出钩子要能 kill 掉它，否则关窗后它还在后台写几个 GB。
    // 顺序必须是 spawn → take pipes → 放槽位，否则读线程拿不到管道。
    // 用 Option 承接：交出去之后本地就没有句柄了，下面据此决定怎么等。
    let mut child = Some(child);
    if !dry_run {
        if let Some(state) = app.try_state::<Services>() {
            if let Ok(mut guard) = state.overviews.lock() {
                *guard = child.take();
            }
        }
    }

    // ⚠️ stdout / stderr **必须各起一个读线程**。管道缓冲区在 Windows 上只有
    //    64 KB：只读其中一个、另一个写满时，子进程会阻塞在 write 上，
    //    而我们又阻塞在 wait 上 —— 两边互等，表现为"永远不结束"。
    //    这个坑本项目在 sidecar 上踩过一次。
    let out_thread = std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut buf: Vec<u8> = Vec::new();
        let mut events: Vec<serde_json::Value> = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) => break, // EOF
                Ok(_) => {
                    // 同 start_tile_server：不能用 lines().map_while(ok)，
                    // 一行非 UTF-8 会让整个迭代器停住，后面的 done 事件就丢了
                    let text = String::from_utf8_lossy(&buf);
                    let line = text.trim();
                    if line.is_empty() {
                        continue;
                    }
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                        events.push(v);
                    }
                }
                Err(_) => break,
            }
        }
        events
    });

    let err_thread = std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut buf: Vec<u8> = Vec::new();
        let mut acc = String::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) => break,
                Ok(_) => {
                    let text = String::from_utf8_lossy(&buf);
                    let line = text.trim_end_matches(['\r', '\n']);
                    if line.is_empty() {
                        continue;
                    }
                    // 落 app.log：release 没有控制台，这是失败时唯一的现场
                    log_line(&format!("[overviews] {line}"));
                    if acc.len() < 8_000 {
                        acc.push_str(line);
                        acc.push('\n');
                    }
                }
                Err(_) => break,
            }
        }
        acc
    });

    // 正式构建时句柄已经交给 `Services`（退出钩子要能 kill），这里只能轮询；
    // dry_run 的句柄还在本地，直接 wait 更简单。
    let status = match child {
        Some(mut c) => c
            .wait()
            .map_err(|e| format!("等待加速结构进程失败：{e}"))?,
        None => poll_overviews_child(app)?,
    };
    Ok(OverviewRun {
        events: out_thread.join().unwrap_or_default(),
        stderr: err_thread.join().unwrap_or_default(),
        success: status.success(),
        code: status.code(),
    })
}

/// 体检：只问"这张影像要不要处理、要花多少磁盘"，**不写盘、不改配置、不重启服务**。
///
/// 同样要 async + spawn_blocking：虽然是干跑，但读大影像的元数据 + 查磁盘
/// 也可能花上几百毫秒到几秒，卡主线程会让窗口点不动。
#[tauri::command]
async fn overview_plan(app: tauri::AppHandle) -> Result<OverviewPlan, String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || overview_plan_blocking(&app2))
        .await
        .map_err(|e| format!("体检任务异常结束：{e}"))?
}

fn overview_plan_blocking(app: &tauri::AppHandle) -> Result<OverviewPlan, String> {
    let run = run_overviews_child(app, "auto", true)?;
    let Some(plan) = run.last("plan") else {
        // 拿不到 plan 说明进程根本没走到判断那一步（python 崩了 / 参数不对）。
        // 这时 stderr 是唯一线索，必须带出去，否则界面只能显示"失败了"。
        return Err(format!(
            "没能检查影像：{}",
            clip_chars(run.stderr.trim(), 500)
        ));
    };
    serde_json::from_value::<OverviewPlan>(plan.clone())
        .map_err(|e| format!("体检结果字段不完整（前后端版本不一致？）：{e}"))
}

/// 「建金字塔」的结果，直接给界面展示。
#[derive(serde::Serialize)]
struct OverviewBuildResult {
    ok: bool,
    /// 人类可读说明（已建好 / 复用副本 / 原本就有）
    note: String,
    /// 瓦片服务最终该用的影像（可能与原图不同 —— copy 模式是副本）
    served: String,
    /// 实际耗时（秒）。大影像 2~3 分钟，界面要能显示"已经等了多久"
    elapsed_s: f64,
}

/// 给影像建金字塔（可等 2~3 分钟，**必须 async + spawn_blocking**）。
///
/// 为什么不做成同步命令：Tauri 的同步命令跑在**主线程**上，阻塞 3 分钟 =
/// 窗口假死、转圈都转不动，用户只会认为程序崩了然后强杀 ——
/// 而强杀正好会打断写盘（`.part` 原子写入就是为这个场景准备的）。
///
/// 参数 `mode` 只认四个值：`auto` / `copy` / `gdal` / `inplace`。
/// 其它值一律拒绝 —— 这个字符串会被拼进命令行，不能信前端传什么就给什么。
#[tauri::command]
async fn build_overviews(
    app: tauri::AppHandle,
    mode: String,
) -> Result<OverviewBuildResult, String> {
    if !matches!(mode.as_str(), "auto" | "copy" | "gdal" | "inplace") {
        return Err(format!(
            "内部错误：不支持的加速结构方式「{mode}」"
        ));
    }
    // 防重入：连点两下会起两个进程写同一个 .part（理由见 OVERVIEW_BUILDING 注释）
    if OVERVIEW_BUILDING.swap(true, Ordering::SeqCst) {
        return Err("正在建立加速结构，请等它完成（大影像需要 2~3 分钟）".into());
    }
    let _guard = OverviewBuildGuard;
    // AppHandle 是 Send + 'static，可以搬进阻塞线程；State 不行（借用视图）
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || build_overviews_blocking(&app2, &mode))
        .await
        .map_err(|e| format!("建立加速结构任务异常结束：{e}"))?
}

/// `build_overviews` 的阻塞主体：起子进程 → 收事件 → 记住副本 → 重启服务。
fn build_overviews_blocking(
    app: &tauri::AppHandle,
    mode: &str,
) -> Result<OverviewBuildResult, String> {
    let image = resolve_image(app).ok_or("还没有选择正射影像，无法建立加速结构")?;
    let run = run_overviews_child(app, mode, false)?;
    let done = run.last("done").cloned();
    let status = (run.success, run.code);
    let err_text = run.stderr.trim().to_string();

    // ⚠️ 先看 `done` 事件、再看退出码。python 侧"找不到 gdaladdo"这类错误是
    //    `done{ok:false,error:"找不到 gdaladdo…"}` + 退出码 3 **一起**给出的：
    //    若先按退出码报错，用户只会看到"没有输出"，真正的原因（缺 GDAL）被丢掉。
    let fail_tail = || {
        let t = clip_chars(&err_text, 500);
        if t.is_empty() {
            "没有输出".to_string()
        } else {
            t
        }
    };
    let done = match done {
        Some(v) if v.get("ok").and_then(|x| x.as_bool()) == Some(true) => v,
        Some(v) => {
            let why = v.get("error").and_then(|x| x.as_str()).unwrap_or("未知原因");
            return Err(format!("建立加速结构失败：{why}"));
        }
        None if !status.0 => {
            return Err(format!(
                "建立加速结构失败（退出码 {:?}）：{}",
                status.1,
                fail_tail()
            ));
        }
        None => {
            return Err(format!(
                "加速结构进程没有报告结果（可能被中断）：{}",
                fail_tail()
            ));
        }
    };

    let served = done
        .get("served")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let note = done
        .get("note")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let elapsed_s = done.get("elapsed_s").and_then(|v| v.as_f64()).unwrap_or(0.0);

    // 产生了副本（served 与原图不同）→ 记住它，否则下次启动又用回没金字塔的原图，
    // 用户会以为"建了一次白建"。
    if !served.is_empty() && !same_file_path(Path::new(&served), &image) {
        let mut cfg = load_config();
        cfg.tile_source = Some(served.clone());
        save_config(&cfg)?;
        log_line(&format!("瓦片服务改用带金字塔的副本：{served}"));
    }

    // 让服务用上新影像。**失败不吞**：金字塔建好了但地图还是慢，必须让用户知道。
    // 只在这条成功路径上重启 —— 失败路径绝不重启，避免把本来好的服务弄坏。
    let services = app.state::<Services>();
    restart_tile_server(app.clone(), services)
        .map_err(|e| format!("金字塔已建好，但瓦片服务重启失败：{e}"))?;

    Ok(OverviewBuildResult {
        ok: true,
        note,
        served,
        elapsed_s,
    })
}

/// 前端按钮「重新拉起服务」用（服务崩了不必重启整个 App）
#[tauri::command]
fn restart_tile_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, Services>,
) -> Result<String, String> {
    if let Some(mut child) = state.tile.lock().unwrap().take() {
        let _ = child.kill();
        // 给端口一点释放时间
        for _ in 0..20 {
            if !port_open(active_port()) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    // 主动重启不算"异常退出"：不重置的话，上一轮的退出码会被当成这一轮的证据
    *TILE_EXIT.lock().unwrap_or_else(|e| e.into_inner()) = None;
    start_tile_server(&app, &state)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 原生文件选择框：让用户在界面里选影像/结果，而不是去某个隐藏目录放文件
        .plugin(tauri_plugin_dialog::init())
        .manage(Services::default())
        .invoke_handler(tauri::generate_handler![
            backend_url,
            service_status,
            tile_diagnose,
            restart_tile_server,
            run_detect,
            preflight_detect,
            preflight_derived,
            run_build_derived,
            read_text_file,
            open_path,
            cancel_detect,
            detect_status,
            get_status,
            set_data_paths,
            build_overviews,
            overview_plan
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let state = app.state::<Services>();
            match start_tile_server(&handle, &state) {
                Ok(msg) => log_line(&msg),
                Err(e) if e == NEED_IMAGE => {
                    log_line("首次启动：等待用户在界面里选择正射影像");
                }
                Err(e) => log_line(&format!(
                    "瓦片服务未启动：{e}（前端会显示排查提示，多边形仍可查看/编辑）"
                )),
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关窗前的拦截：检测 / 生成正在跑时先劝一句。
            //
            // 为什么在 Rust 侧做而不是前端弹框：CloseRequested 是外壳事件，
            // 此时前端可能已经开始卸载，自定义弹框会闪一下就没了。
            // 用系统原生 dialog 最稳（也不受前端崩溃影响）。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle().clone();
                let (detecting, deriving) = app
                    .try_state::<Services>()
                    .map(|s| {
                        let d = s.detect.lock().map(|g| g.is_some()).unwrap_or(false);
                        let dv = s.derive.lock().map(|g| g.is_some()).unwrap_or(false);
                        (d, dv)
                    })
                    .unwrap_or((false, false));

                // 空闲时正常关闭，不打扰
                if !detecting && !deriving {
                    return;
                }

                api.prevent_close();

                let (title, body) = if detecting {
                    (
                        "检测正在运行",
                        "检测通常需要 3~6 分钟。\n\n\
                         现在关闭会中断检测：已完成的部分不会损坏（结果是原子写入的），\
                         但要重新跑一遍才能拿到完整结果。\n\n\
                         建议等它跑完再关闭。",
                    )
                } else {
                    (
                        "正在生成高度图与林地边界",
                        "关闭窗口后它会在后台继续跑完（只是看不到进度），\
                         完成后产物可直接使用。\n\n\
                         如果你想立刻停止，选「中断并退出」。",
                    )
                };

                let app2 = app.clone();
                app.dialog()
                    .message(body)
                    .title(title)
                    .kind(MessageDialogKind::Warning)
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "继续等待（不关闭）".to_string(),
                        "中断并退出".to_string(),
                    ))
                    .show(move |proceed| {
                        // proceed = 点了「继续等待」→ 什么都不做，窗口保持打开
                        if proceed {
                            return;
                        }
                        // 执意退出：杀掉检测进程。
                        // `derive` 刻意不杀 —— 它正在写的是一份有用的产物，
                        // 让它跑完比留半个 CHM 更好（与 RunEvent::Exit 的取舍一致）。
                        if let Some(state) = app2.try_state::<Services>() {
                            if let Ok(mut g) = state.detect.lock() {
                                if let Some(mut c) = g.take() {
                                    let _ = c.kill();
                                    let _ = c.wait();
                                }
                            }
                        }
                        app2.exit(0);
                    });
            }
        })
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败")
        .run(|app, event| {
            // 退出时别留孤儿 python 进程（否则下次启动端口被占）
            if matches!(event, RunEvent::Exit) {
                if let Some(state) = app.try_state::<Services>() {
                    if let Ok(mut guard) = state.tile.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                        }
                    }
                    // 检测进程也要清 —— 否则关窗后后台还在跑 350 秒的批处理
                    if let Ok(mut guard) = state.detect.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                    // 建金字塔进程必须杀：`.part` 机制保证半成品下次会被清掉，
                    // 杀掉是安全的；不杀则关窗后它还在写几个 GB，而且下次启动
                    // 再点「开始」会两个进程抢同一个 `.part`（WinError 32）。
                    if let Ok(mut guard) = state.overviews.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                    // `derive`（生成 CHM/掩膜）刻意**不杀**：它正在写的是一份有用的
                    // 产物，让它跑完比留半个 CHM 更好（检测读到半截 CHM 不报错，
                    // 那才是灾难）。代价是关窗后它会自己跑完再退出 ——
                    // 这是权衡后的选择，不是遗漏。
                }
            }
        });
}

// ============================================================================
//  预检单元测试
//  ---------------------------------------------------------------------------
//  这些测试**不依赖仓库里的真实数据**（output/ 是 gitignore 的，换台机器就没有），
//  每个用例自己在 temp 下搭一套最小目录，测完删掉。
// ============================================================================
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 造一个独立的临时工作目录（用 pid + 计数器避免并行冲突）
    fn scratch(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static N: AtomicUsize = AtomicUsize::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let d = std::env::temp_dir().join(format!(
            "fgd-pf-{}-{}-{}",
            std::process::id(),
            tag,
            n
        ));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn touch(p: &Path, bytes: usize) {
        if let Some(dir) = p.parent() {
            fs::create_dir_all(dir).unwrap();
        }
        fs::write(p, vec![b'x'; bytes]).unwrap();
    }

    /// 造一个文件并**显式设定 mtime**（自 UNIX_EPOCH 起的秒数）。
    ///
    /// 为什么不用 sleep 制造"谁更新"：文件系统的时间戳粒度与刷新时机并不保证
    /// "先写 A 后写 B 就一定 B 更新"，mtime 相同会让"取最新"退化成"取任意一个"，
    /// 测试就会偶发失败。显式设时间戳，测试才是确定性的。
    fn touch_at(p: &Path, bytes: usize, unix_secs: u64) {
        touch(p, bytes);
        let f = fs::File::options().write(true).open(p).unwrap();
        f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(unix_secs))
            .unwrap();
    }

    fn item<'a>(r: &'a PreflightResult, key: &str) -> &'a PreflightItem {
        r.items.iter().find(|i| i.key == key).expect("缺少预检项")
    }

    // ---- 「生成高度图 / 林地边界」的预检（derive_core）----
    //
    // 这一组测试的价值：生成是**不可逆的覆盖操作**（会盖掉 output/chm.tif），
    // 而且它比检测更容易"静默失败" —— 缺 DSM 时如果不拦，用户点下去会等一分钟
    // 然后拿到一句 python 的 KeyError。所以每一项都要在点按钮之前就判掉。

    #[test]
    fn derive_requires_image() {
        let base = scratch("dv-noimg");
        let r = derive_core(&base, &serde_json::json!({ "input": "" }));
        assert!(!r.ok, "没选影像必须拦住");
        assert_eq!(item(&r, "input").status, "error");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn derive_requires_dsm() {
        // 只有影像、没有 dsm.tif —— 这是最容易发生的情形（用户只拷了影像）
        let base = scratch("dv-nodsm");
        touch(&base.join("ortho.tif"), 2_000_000);
        let r = derive_core(&base, &serde_json::json!({ "input": "ortho.tif" }));
        assert!(!r.ok, "缺 DSM 是硬错误：没有它算不出树高");
        let it = item(&r, "dsm");
        assert_eq!(it.status, "error");
        assert!(
            it.detail.contains("dsm.tif"),
            "要说清缺的是哪个文件名：{}",
            it.detail
        );
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn derive_finds_inputs_next_to_image() {
        let base = scratch("dv-ok");
        let dir = base.join("BlockC");
        touch(&dir.join("ortho.tif"), 2_000_000);
        touch(&dir.join("dsm.tif"), 300_000);
        touch(&dir.join("segment.tif"), 100_000);
        touch(&dir.join("tree_info.json"), 5_000);

        let r = derive_core(
            &base,
            &serde_json::json!({ "input": dir.join("ortho.tif").to_string_lossy() }),
        );
        assert!(r.ok, "四个输入都在同目录，应该放行：{:?}", r.items.iter().map(|i| (&i.key, &i.status, &i.detail)).collect::<Vec<_>>());
        for k in ["input", "dsm", "segment", "tree_info", "out_dir"] {
            assert_eq!(item(&r, k).status, "ok", "{k} 应为 ok");
        }
        // resolved 必须给出绝对输出路径 —— 前端不做路径拼接
        assert!(r.resolved.get("out_chm").is_some(), "要给出 chm 输出路径");
        assert!(r.resolved.get("out_mask").is_some());
        let chm = r.resolved["out_chm"].as_str().unwrap();
        assert!(chm.ends_with("chm.tif"), "实际 {chm}");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn derive_missing_segment_is_warn_not_error() {
        // 分割图只影响"水面在 CHM 里是否置空"，不该拦住生成
        let base = scratch("dv-noseg");
        let dir = base.join("B");
        touch(&dir.join("ortho.tif"), 2_000_000);
        touch(&dir.join("dsm.tif"), 300_000);
        touch(&dir.join("tree_info.json"), 5_000);

        let r = derive_core(
            &base,
            &serde_json::json!({ "input": dir.join("ortho.tif").to_string_lossy() }),
        );
        assert!(r.ok, "缺分割图不该拦");
        assert_eq!(item(&r, "segment").status, "warn");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn derive_missing_tree_info_skips_mask_but_allows() {
        // 树心表缺失 → 只出 CHM。这要能放行，但必须说清"林地边界会被跳过"，
        // 否则用户会以为掩膜也生成了，检测时才发现没生效。
        let base = scratch("dv-notree");
        let dir = base.join("B");
        touch(&dir.join("ortho.tif"), 2_000_000);
        touch(&dir.join("dsm.tif"), 300_000);

        let r = derive_core(
            &base,
            &serde_json::json!({ "input": dir.join("ortho.tif").to_string_lossy() }),
        );
        assert!(r.ok, "缺树心表应放行（只出 CHM）");
        let it = item(&r, "tree_info");
        assert_eq!(it.status, "info");
        assert!(
            it.detail.contains("只生成高度图") && it.detail.contains("跳过"),
            "必须说清后果：{}",
            it.detail
        );
        assert!(
            r.resolved.get("tree_info").is_none(),
            "没有树心表就不该往 resolved 里塞空值"
        );
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn derive_warns_before_overwriting_existing_files() {
        // 已经算过 CHM 再点一次 —— 会覆盖。不是错误，但用户必须知道。
        let base = scratch("dv-ow");
        let dir = base.join("B");
        touch(&dir.join("ortho.tif"), 2_000_000);
        touch(&dir.join("dsm.tif"), 300_000);
        touch(&dir.join("tree_info.json"), 5_000);
        touch(&base.join("output").join("chm.tif"), 1_000);

        let r = derive_core(
            &base,
            &serde_json::json!({ "input": dir.join("ortho.tif").to_string_lossy() }),
        );
        assert!(r.ok, "覆盖不是错误");
        let it = item(&r, "overwrite");
        assert_eq!(it.status, "warn");
        assert!(it.detail.contains("chm.tif"), "{}", it.detail);
        assert!(
            it.detail.contains("重跑一次检测"),
            "要提醒：换了高度图后旧检测结果口径变了"
        );
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn derive_reports_output_dir_writable() {
        let base = scratch("dv-wr");
        let dir = base.join("B");
        touch(&dir.join("ortho.tif"), 2_000_000);
        touch(&dir.join("dsm.tif"), 300_000);
        touch(&dir.join("tree_info.json"), 5_000);

        let r = derive_core(
            &base,
            &serde_json::json!({ "input": dir.join("ortho.tif").to_string_lossy() }),
        );
        let it = item(&r, "out_dir");
        assert_eq!(it.status, "ok");
        assert!(
            !base.join("output").join(".fgd-derive-probe").exists(),
            "探针文件必须被删掉，不能留在用户目录里"
        );
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn missing_image_blocks_start() {
        let base = scratch("noimage");
        let r = preflight_core(&base, &serde_json::json!({ "input": "nope.tif" }));
        assert!(!r.ok, "缺影像时必须拦住");
        assert_eq!(item(&r, "image").status, "error");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn empty_input_blocks_start() {
        let base = scratch("empty");
        let r = preflight_core(&base, &serde_json::json!({}));
        assert!(!r.ok);
        assert_eq!(item(&r, "image").status, "error");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn relative_paths_are_absolutized() {
        let base = scratch("abs");
        touch(&base.join("drone data/WGR17-002.tif"), 2_000_000);
        let r = preflight_core(
            &base,
            &serde_json::json!({ "input": "drone data/WGR17-002.tif" }),
        );
        let resolved = r.resolved.get("input").unwrap().as_str().unwrap();
        assert!(Path::new(resolved).is_absolute(), "input 必须是绝对路径");
        assert!(resolved.ends_with("WGR17-002.tif"));
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn missing_chm_is_warn_not_error() {
        // chm 缺失会退化但不该拦（用户可能就是想跑纯 RGB 版本）
        let base = scratch("nochm");
        touch(&base.join("img.tif"), 2_000_000);
        let r = preflight_core(
            &base,
            &serde_json::json!({
                "input": "img.tif",
                "chm_path": "output/chm.tif",
                "segment_path": "drone data/segment.tif",
                "forest_mask_path": "",
                "work_dir": "output/jobs"
            }),
        );
        assert!(r.ok, "只有 warn 时 ok 必须为 true");
        assert_eq!(item(&r, "chm_path").status, "warn");
        assert_eq!(item(&r, "segment_path").status, "warn");
    }

    #[test]
    fn forest_mask_is_auto_discovered() {
        let base = scratch("mask");
        touch(&base.join("img.tif"), 2_000_000);
        touch(&base.join("output/forest-mask-50m-exg60.geojson"), 100);
        let r = preflight_core(
            &base,
            &serde_json::json!({ "input": "img.tif", "work_dir": "output/jobs" }),
        );
        assert_eq!(item(&r, "forest_mask").status, "ok");
        let resolved = r.resolved.get("forest_mask_path").unwrap().as_str().unwrap();
        assert!(
            resolved.ends_with("forest-mask-50m-exg60.geojson"),
            "自动发现的掩膜必须写回 resolved，否则未开发林会被算成可补种"
        );
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn missing_forest_mask_warns_about_extra_points() {
        let base = scratch("nomask");
        touch(&base.join("img.tif"), 2_000_000);
        let r = preflight_core(
            &base,
            &serde_json::json!({ "input": "img.tif", "work_dir": "output/jobs" }),
        );
        let it = item(&r, "forest_mask");
        assert_eq!(it.status, "warn");
        assert!(it.detail.contains("偏多"), "必须说清后果：{}", it.detail);
    }

    #[test]
    fn work_dir_is_created_and_writable() {
        let base = scratch("work");
        touch(&base.join("img.tif"), 2_000_000);
        let r = preflight_core(
            &base,
            &serde_json::json!({ "input": "img.tif", "work_dir": "output/jobs" }),
        );
        assert_eq!(item(&r, "work_dir").status, "ok");
        assert!(base.join("output/jobs").is_dir());
        // 探针文件必须被清掉，不能留在用户的输出目录里
        assert!(!base.join("output/jobs/.fgd-write-probe").exists());
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn bad_worker_count_blocks() {
        let base = scratch("workers");
        touch(&base.join("img.tif"), 2_000_000);
        let r = preflight_core(
            &base,
            &serde_json::json!({
                "input": "img.tif", "workers": 99, "target_density_per_ha": 150,
                "work_dir": "output/jobs"
            }),
        );
        assert!(!r.ok);
        assert_eq!(item(&r, "workers").status, "error");
    }

    #[test]
    fn bad_density_blocks() {
        let base = scratch("density");
        touch(&base.join("img.tif"), 2_000_000);
        let r = preflight_core(
            &base,
            &serde_json::json!({
                "input": "img.tif", "workers": 4, "target_density_per_ha": 5,
                "work_dir": "output/jobs"
            }),
        );
        assert!(!r.ok);
        assert_eq!(item(&r, "density").status, "error");
    }

    #[test]
    fn companion_chm_found_next_to_image() {
        // 用户选了别的目录的影像：chm 就在它旁边，必须自动关联
        let base = scratch("comp1");
        let block = base.join("BlockB");
        touch(&block.join("ortho.tif"), 2_000_000);
        touch(&block.join("chm.tif"), 300_000);

        let r = preflight_core(
            &base,
            &serde_json::json!({
                "input": block.join("ortho.tif").to_string_lossy(),
                "work_dir": "output/jobs"
            }),
        );
        let it = item(&r, "chm_path");
        assert_eq!(it.status, "ok", "应当自动找到同目录的 chm.tif：{}", it.detail);
        assert!(it.detail.contains("自动关联"));
        let resolved = r.resolved.get("chm_path").unwrap().as_str().unwrap();
        assert!(resolved.ends_with("chm.tif"));
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn companion_segment_found_in_output_subdir() {
        let base = scratch("comp2");
        let block = base.join("BlockB");
        touch(&block.join("ortho.tif"), 2_000_000);
        touch(&block.join("output/segment.tif"), 300_000);

        let r = preflight_core(
            &base,
            &serde_json::json!({
                "input": block.join("ortho.tif").to_string_lossy(),
                "work_dir": "output/jobs"
            }),
        );
        assert_eq!(
            item(&r, "segment_path").status,
            "ok",
            "影像目录下的 output/segment.tif 也要能找到"
        );
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn forest_mask_found_next_to_image() {
        let base = scratch("comp3");
        let block = base.join("BlockB");
        touch(&block.join("ortho.tif"), 2_000_000);
        touch(&block.join("forest-mask-50m-exg60.geojson"), 100);

        let r = preflight_core(
            &base,
            &serde_json::json!({
                "input": block.join("ortho.tif").to_string_lossy(),
                "work_dir": "output/jobs"
            }),
        );
        assert_eq!(item(&r, "forest_mask").status, "ok");
        let resolved = r.resolved.get("forest_mask_path").unwrap().as_str().unwrap();
        assert!(resolved.contains("BlockB"), "掩膜应来自影像同目录：{resolved}");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn missing_companion_says_where_it_looked() {
        let base = scratch("comp4");
        touch(&base.join("img.tif"), 2_000_000);
        let r = preflight_core(
            &base,
            &serde_json::json!({ "input": "img.tif", "work_dir": "output/jobs" }),
        );
        let it = item(&r, "chm_path");
        assert_eq!(it.status, "warn");
        assert!(
            it.detail.contains("同目录") && it.detail.contains("chm.tif"),
            "告警要说清找过哪里、缺的是哪个文件名：{}",
            it.detail
        );
    }

    // ---- CHM 高度阈值（缺陷台账 P1-3）----

    /// 造一个「除了 CHM 阈值以外全都正常」的参数集
    fn chm_params(core: f64, veto: f64) -> serde_json::Value {
        serde_json::json!({
            "input": "img.tif",
            "work_dir": "output/jobs",
            "workers": 4,
            "target_density_per_ha": 150,
            "elevation_core_chm": core,
            "elevation_veto_chm": veto
        })
    }

    #[test]
    fn default_chm_is_ok_and_labeled() {
        let base = scratch("chm-def");
        touch(&base.join("img.tif"), 2_000_000);
        // 不传 CHM 参数 → 走 Stage 14 默认 5.2 / 1.2
        let r = preflight_core(
            &base,
            &serde_json::json!({ "input": "img.tif", "work_dir": "output/jobs" }),
        );
        let it = item(&r, "chm");
        assert_eq!(it.status, "ok", "默认阈值不该报错：{}", it.detail);
        assert!(it.detail.contains("成熟林"), "要标出档位名：{}", it.detail);
        assert!(it.detail.contains("5.2") && it.detail.contains("1.2"));
        assert!(!it.detail.contains("非 Stage 14"), "默认档不该带「非基线」提示");
    }

    #[test]
    fn veto_above_core_blocks() {
        let base = scratch("chm-bad1");
        touch(&base.join("img.tif"), 2_000_000);
        let r = preflight_core(&base, &chm_params(3.0, 4.0));
        assert!(!r.ok, "否决线高于救援线必须拦住");
        let it = item(&r, "chm");
        assert_eq!(it.status, "error");
        assert!(it.detail.contains("低至少 0.5 m"), "原因要说清：{}", it.detail);
    }

    #[test]
    fn chm_gap_too_small_blocks() {
        let base = scratch("chm-bad2");
        touch(&base.join("img.tif"), 2_000_000);
        // 间距 0.4 < 0.5
        let r = preflight_core(&base, &chm_params(3.0, 2.6));
        assert!(!r.ok);
        assert_eq!(item(&r, "chm").status, "error");
    }

    #[test]
    fn veto_below_floor_blocks() {
        let base = scratch("chm-bad3");
        touch(&base.join("img.tif"), 2_000_000);
        let r = preflight_core(&base, &chm_params(5.2, 0.1));
        assert!(!r.ok);
        assert!(item(&r, "chm").detail.contains("0.2"));
    }

    #[test]
    fn young_preset_is_info_not_error() {
        let base = scratch("chm-young");
        touch(&base.join("img.tif"), 2_000_000);
        let r = preflight_core(&base, &chm_params(2.2, 0.5));
        assert!(r.ok, "幼龄林档位合法，不该拦");
        let it = item(&r, "chm");
        assert_eq!(it.status, "info", "非默认档用 info 提醒，不用 warn");
        assert!(it.detail.contains("幼龄林"), "要标出档位名：{}", it.detail);
        assert!(
            it.detail.contains("不可与历史交付数字直接对比"),
            "必须提醒口径变了：{}",
            it.detail
        );
    }

    #[test]
    fn custom_chm_is_labeled_custom() {
        let base = scratch("chm-custom");
        touch(&base.join("img.tif"), 2_000_000);
        let r = preflight_core(&base, &chm_params(4.0, 1.0));
        assert!(r.ok);
        let it = item(&r, "chm");
        assert_eq!(it.status, "info");
        assert!(it.detail.contains("自定义"), "不在三档里要标「自定义」：{}", it.detail);
    }

    #[test]
    fn roi_geojson_counts_as_roi() {
        let base = scratch("roi");
        touch(&base.join("img.tif"), 2_000_000);
        let r = preflight_core(
            &base,
            &serde_json::json!({
                "input": "img.tif", "work_dir": "output/jobs",
                "roi_geojson": { "type": "Polygon", "coordinates": [] }
            }),
        );
        assert_eq!(item(&r, "roi").status, "ok");
        fs::remove_dir_all(&base).ok();
    }

    // ---- 结果文件发现（缺陷：界面说"没有空地"，其实检测成功了）----

    #[test]
    fn latest_gaps_wins_by_mtime() {
        // 两个名字都含 gaps：a 更旧、b 更新 → 必须选 b
        let base = scratch("gaps-new");
        touch_at(&base.join("output/a-gaps.geojson"), 16, 1_600_000_000);
        touch_at(&base.join("output/b-gaps.geojson"), 16, 1_700_000_000);
        let got = resolve_gaps_in(&base).expect("必须找到一个结果文件");
        assert_eq!(
            got.file_name().unwrap().to_string_lossy(),
            "b-gaps.geojson",
            "必须按 mtime 取最新的那个，否则用户会一直看到上一轮的结果"
        );
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn gaps_name_is_not_hardcoded() {
        // 产物名由前端 `job` 决定（wgr17-desktop-gaps.geojson）——
        // 以前写死 wgr17-final-gaps / wgr17-elev-gaps，换 job 名就永远读不到
        let base = scratch("gaps-name");
        touch_at(&base.join("output/wgr17-desktop-gaps.geojson"), 16, 1_700_000_000);
        let got = resolve_gaps_in(&base).expect("不能只认写死的文件名");
        assert!(got.to_string_lossy().contains("wgr17-desktop-gaps"));
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn gaps_ignores_unrelated_geojson() {
        // `forest-mask-*.geojson` 名字里没有 gaps，绝不能当成检测结果
        let base = scratch("gaps-unrelated");
        touch_at(&base.join("output/forest-mask-50m-exg60.geojson"), 16, 1_700_000_000);
        touch_at(&base.join("output/ab-w1.geojson"), 16, 1_700_000_001);
        assert!(
            resolve_gaps_in(&base).is_none(),
            "非结果文件必须被忽略，否则会把掩膜当成空地展示"
        );
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn no_gaps_file_returns_none() {
        let base = scratch("gaps-none");
        fs::create_dir_all(base.join("output")).unwrap();
        assert!(resolve_gaps_in(&base).is_none());
        // output/ 不存在时也不能 panic（首次使用就是这种状态）
        let empty = scratch("gaps-noout");
        assert!(resolve_gaps_in(&empty).is_none());
        fs::remove_dir_all(&base).ok();
        fs::remove_dir_all(&empty).ok();
    }

    #[test]
    fn gaps_falls_back_to_data_root() {
        // output/ 里没有、但数据根下有一份（用户手动拷出来排障的常见形态）
        let base = scratch("gaps-root");
        fs::create_dir_all(base.join("output")).unwrap();
        touch_at(&base.join("manual-gaps.geojson"), 16, 1_700_000_000);
        let got = resolve_gaps_in(&base).expect("数据根下的结果也要认");
        assert_eq!(got.file_name().unwrap().to_string_lossy(), "manual-gaps.geojson");
        fs::remove_dir_all(&base).ok();
    }

    // ---- 瓦片服务身份校验 ----
    //
    // 这组测试守的是一个**具体事故**：8765 被别的程序占住时，
    // `start_tile_server` 曾经无条件 `return Ok("复用现有服务")`。
    // 外壳以为就绪，前端等 120 秒拿不到 /meta，最后弹三条毫不相干的猜测。
    // 所以"这个应答是不是我们的"必须判得准，且**不能把旧版自己当外人**。

    #[test]
    fn meta_with_app_id_is_ours() {
        let body = r#"{"app":"fgd-tile-server","ok":true,"source":"a.tif","tile_url":"/tiles/{z}/{x}/{y}.png"}"#;
        assert!(is_our_meta(body));
    }

    #[test]
    fn meta_from_other_app_is_foreign() {
        // 别人的服务也可能返回 ok:true —— 只判 ok 就会误认为就绪
        let body = r#"{"app":"other-service","ok":true,"source":"whatever"}"#;
        assert!(!is_our_meta(body), "app 字段不认识就必须判为外人");
        let body = r#"{"ok":true,"message":"hello"}"#;
        assert!(!is_our_meta(body));
        // 非 JSON（HTML 报错页 / 纯文本）不能 panic，一律当外人
        assert!(!is_our_meta("<html>not found</html>"));
        assert!(!is_our_meta(""));
    }

    #[test]
    fn meta_from_older_build_is_still_ours() {
        // 兼容：本次改动之前构建的瓦片服务没有 app 字段。
        // 若判成外人，用户升级外壳后会被自己上一版的残留进程挡住（更糟）。
        let body = r#"{"ok":true,"source":"D:/data/a.tif","width":100,"tile_url":"/tiles/{z}/{x}/{y}.png"}"#;
        assert!(is_our_meta(body));
    }

    #[test]
    fn meta_missing_essentials_is_foreign() {
        // 有 ok 但缺 source/tile_url —— 不足以认亲
        assert!(!is_our_meta(r#"{"ok":true}"#));
        assert!(!is_our_meta(r#"{"ok":false,"source":"a.tif","tile_url":"x"}"#));
    }

    #[test]
    fn clip_chars_respects_utf8_boundary() {
        // 按字节切会把中文切成半个 UTF-8 序列 → 前端拿到乱码/替换符
        assert_eq!(clip_chars("abcdef", 10), "abcdef");
        assert_eq!(clip_chars("abcdef", 3), "abc…");
        let s = clip_chars("油棕园空地检测", 3);
        assert_eq!(s, "油棕园…");
        assert_eq!(s.chars().count(), 4, "3 个字 + 省略号");
    }

    #[test]
    fn http_access_log_is_not_written_to_app_log() {
        // 满屏瓦片的地图每秒几十行访问日志，全写进 app.log 会把真错误冲掉
        assert!(is_http_access_log(r#""GET /tiles/15/1/2.png" 200 -"#));
        assert!(is_http_access_log(r#"  "POST /export HTTP/1.1" 200 -"#));
        assert!(!is_http_access_log("Traceback (most recent call last):"));
        assert!(!is_http_access_log("  ⚠️ 影像无金字塔"));
        assert!(!is_http_access_log(r#"RasterioIOError: D:/a.tif"#));
    }

    /// 起一个只会应答一次的玩具 HTTP 服务，返回真实端口。
    ///
    /// 为什么不用 mock：`http_get_meta` 手写了 TCP 请求与报文解析，
    /// 出错的地方恰恰在"真的发出去、真的读回来"这一步（响应头切分、状态码判断、
    /// 对端不关连接时阻塞）。纯逻辑测试覆盖不到它。
    fn spawn_fake_http(status_line: &'static str, body: &'static str) -> u16 {
        use std::io::Write as _;
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").expect("监听失败");
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                // 必须先读完请求头，否则对端可能因 RST 丢应答（Windows 常见）
                let mut req = [0u8; 1024];
                let _ = std::io::Read::read(&mut s, &mut req);
                let resp = format!(
                    "HTTP/1.0 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                );
                let _ = s.write_all(resp.as_bytes());
                let _ = s.flush();
            }
        });
        port
    }

    #[test]
    fn http_get_meta_reads_our_service() {
        let port = spawn_fake_http(
            "200 OK",
            r#"{"app":"fgd-tile-server","ok":true,"source":"a.tif","tile_url":"/tiles"}"#,
        );
        let body = http_get_meta(port).expect("/meta 应当读得到");
        assert!(body.starts_with('{'), "拿到的应该是响应体而不是响应头");
        assert!(is_our_meta(&body), "真实握手后应认出是自己人");
    }

    #[test]
    fn http_get_meta_rejects_non_200() {
        let port = spawn_fake_http("500 Internal Server Error", r#"{"ok":false}"#);
        let err = http_get_meta(port).unwrap_err();
        assert!(err.contains("500"), "错误里要带状态码，便于排障：{err}");
    }

    // ---- 端口复用必须校验"服务的是不是这张影像" ----
    //
    // 这组测试守的是一个**看不见**的故障：上次异常退出留下指向旧影像的僵尸服务，
    // 身份校验通过 → 直接复用 → 地图显示旧影像、检测用新影像，
    // 界面上没有任何提示（比"换影像跳复核"更难发现）。

    #[test]
    fn reuse_only_when_source_matches() {
        let ours = r#"{"app":"fgd-tile-server","source":"D:/a/WGR17-002.tif"}"#;
        // 身份对 + 影像一致 → 复用
        assert!(should_reuse_service(ours, Some(Path::new("D:/a/WGR17-002.tif"))));
        // 身份对 + 影像不同 → 不复用（僵尸服务指向旧影像）
        assert!(!should_reuse_service(ours, Some(Path::new("D:/a/OTHER.tif"))));
        // 没有期望影像（还没选）→ 只看身份
        assert!(should_reuse_service(ours, None));
        // 别人的服务 → 不复用
        assert!(!should_reuse_service(r#"{"ok":true}"#, None));
        // 是我们的但 meta 里没有 source → 无法确认，保守不复用
        assert!(!should_reuse_service(r#"{"app":"fgd-tile-server"}"#, Some(Path::new("D:/a/x.tif"))));
    }

    /// 两个都不存在的路径：不能因为"都 canonicalize 失败"就判成一致
    /// （否则指向已删除旧影像的僵尸服务会被复用）。
    #[test]
    fn missing_paths_are_not_assumed_equal() {
        assert!(same_file_path(Path::new("D:/no/such/a.tif"), Path::new("D:/no/such/a.tif")));
        assert!(!same_file_path(Path::new("D:/no/such/a.tif"), Path::new("D:/no/such/b.tif")));
        // 真实存在的路径走 canonicalize：同一文件的不同写法应判一致
        let base = scratch("same-path");
        let f = base.join("a.tif");
        touch(&f, 8);
        assert!(same_file_path(&f, &f));
        assert!(same_file_path(&base.join(".").join("a.tif"), &f));
        fs::remove_dir_all(&base).ok();
    }

    /// 用 `tile_server.py --overviews-only --dry-run` 的**真实输出**钉住字段名。
    ///
    /// 为什么值得有：`OverviewPlan` 与 python 的 `overview_plan()` 靠**字符串键名**
    /// 对齐，改名不会有任何编译错误，只会在运行时变成"体检结果字段不完整"——
    /// 而那行错误用户看不懂、我们也容易当成偶发。这里贴一段真输出，
    /// 谁改键名谁立刻红。
    #[test]
    fn overview_plan_deserializes_python_output() {
        let real = r#"{"event":"plan","elapsed_s":0.0,"source":"output\\_tests\\no-ovr.tif",
            "has_overviews":false,"levels":[],"width":600,"height":400,"size_bytes":720978,
            "extra_bytes":1081467,"gdaladdo":null,"mode":"auto","action":"copy",
            "why":"无 gdaladdo，复制副本（源文件不动，约占原图 100%）","touches_source":false,
            "target_dir":"D:\\repo\\output\\.tile-cache","free_bytes":176997703680,
            "need_bytes":1081467,"enough_space":true}"#;
        let plan: OverviewPlan = serde_json::from_str(real).expect("字段名必须与 python 一致");
        assert_eq!(plan.action, "copy");
        assert!(!plan.has_overviews);
        assert!(plan.enough_space);
        assert!(!plan.touches_source);
        assert_eq!(plan.need_bytes, 1_081_467);
        assert!(plan.gdaladdo.is_none(), "python 侧是 null，Rust 必须是 None");
        assert!(plan.target_dir.contains(".tile-cache"));

        // 有 gdaladdo 的情形：字符串要能进 Option<String>
        let with_gdal = r#"{"event":"plan","action":"ovr","why":"x","has_overviews":false,
            "size_bytes":1,"need_bytes":1,"free_bytes":2,"enough_space":true,
            "target_dir":"D:/a","gdaladdo":"C:/GDAL/gdaladdo.exe","touches_source":false}"#;
        let p2: OverviewPlan = serde_json::from_str(with_gdal).expect("gdaladdo 字符串要能解析");
        assert_eq!(p2.gdaladdo.as_deref(), Some("C:/GDAL/gdaladdo.exe"));
    }

    #[test]
    fn http_get_meta_on_closed_port_errors() {
        // 端口没人听：必须返回 Err 而不是 panic —— 这是"服务没起来"的常规路径
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert!(http_get_meta(port).is_err());
    }

    // ---- 换影像后清掉旧结果 ----
    //
    // 这组测试守的是 2026-10-21 的事故：换影像后旧结果还挂着，
    // 前端据此认为"检测已完成"，直接跳到「复核结果」并弹"结果没读到"。
    // 四个分支都要覆盖 —— 少判一条就会变成"重选同一张影像把结果抹了"（反向事故）。

    #[test]
    fn image_change_clears_stale_gaps() {
        let a = Some("A.tif".to_string());
        let b = Some("B.tif".to_string());
        // 换影像 + 没给新结果 → 清空
        // 影像变了 + 没给结果 → 清（原行为）
        assert!(should_clear_gaps(&a, &b, false));
        // 换影像 + 同时给了新结果 → 不清（新结果会覆盖）
        assert!(!should_clear_gaps(&a, &b, true));
        // 同一张影像 + 没给结果 → 不清（重选同一张不该抹掉现有结果）
        // ★ 影像没变 + 没给结果 → **也要清**（2026-10-23 口径变更）：
        //   用户点「换一张影像」再选同一张 tif，意图是重新开始。
        assert!(should_clear_gaps(&a, &a, false));
        // 影像没变 + 明确给了结果 → 不清
        assert!(!should_clear_gaps(&a, &a, true));
        // 首次选择（原来没有影像）→ 清空（可能残留上一次会话的结果）
        assert!(should_clear_gaps(&None, &a, false));
    }
}
