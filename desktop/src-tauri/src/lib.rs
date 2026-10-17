//! Forest Gap Detection 桌面端外壳（Tauri v2）。
//!
//! 职责边界（对应《桌面端开发交接简报》§12 的四项裁定）：
//!
//! | 层 | 归属 | 说明 |
//! |---|---|---|
//! | UI | React（`../src`） | 只做展示与交互，地理计算仅用于即时反馈 |
//! | 地理内核 | **Python**（`scripts/process_image.py`） | 保证 Stage 14 数字逐位可复现 |
//! | 瓦片服务 | **Python**（`scripts/tile_server.py`） | HTTP 8765，本文件负责拉起与监督 |
//! | 算法调用 | stdio NDJSON（`scripts/sidecar.py`） | 契约已冻结（95/95），**不要改成 HTTP** |
//!
//! 本文件只做三件事：
//! 1. 起窗口加载前端（dev 走 5173，release 走打包后的 dist）
//! 2. 拉起并监督瓦片服务（端口已在用则不重复启动）
//! 3. 退出时清理子进程（避免留下孤儿 python 进程占住 8765）
//!
//! ⚠️ 刻意**不引入** `tauri-plugin-shell`：托管子进程用标准库 `std::process`
//! 就够了，少一个插件少一层 capability 权限配置（也少一个打包时的坑）。

use std::io::{BufRead, BufReader};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager, RunEvent};

/// 瓦片 / 辅助服务端口（与 `desktop/src/api/backend.ts` 的 BACKEND_BASE 一致）
const BACKEND_PORT: u16 = 8765;

/// "还没有选择正射影像"的哨兵错误。前端据此显示引导卡片而不是报错。
const NEED_IMAGE: &str = "NEED_IMAGE";

#[derive(Default)]
struct Services {
    tile: Mutex<Option<Child>>,
    /// 正在运行的检测子进程（`scripts/sidecar.py`）。用于防重入与中途取消。
    detect: Mutex<Option<Child>>,
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
    // 3) %LOCALAPPDATA%\fgd\data —— **可写**，推荐用户把影像与结果放这里。
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
}

fn config_path() -> Option<PathBuf> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    Some(PathBuf::from(local).join("fgd").join("settings.json"))
}

fn load_config() -> AppConfig {
    let Some(p) = config_path() else {
        return AppConfig::default();
    };
    let Ok(text) = std::fs::read_to_string(&p) else {
        return AppConfig::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save_config(cfg: &AppConfig) -> Result<(), String> {
    let p = config_path().ok_or("拿不到 LOCALAPPDATA 环境变量")?;
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

/// 结果文件：配置优先，其次数据根下的常见位置。
fn resolve_gaps(app: &tauri::AppHandle) -> Option<PathBuf> {
    let cfg = load_config();
    if let Some(p) = cfg.gaps {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    let data = data_base(app);
    for name in ["wgr17-final-gaps.geojson", "wgr17-elev-gaps.geojson"] {
        for sub in ["output", ""] {
            let cand = if sub.is_empty() {
                data.join(name)
            } else {
                data.join(sub).join(name)
            };
            if cand.exists() {
                return Some(cand);
            }
        }
    }
    None
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

/// 拉起瓦片服务。已在监听则不重复启动（多人共用 / 手动起过服务的场景）。
fn start_tile_server(app: &tauri::AppHandle, svc: &Services) -> Result<String, String> {
    if port_open(BACKEND_PORT) {
        return Ok(format!("端口 {BACKEND_PORT} 已在监听，复用现有服务"));
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
    let image = resolve_image(app);
    let gaps = resolve_gaps(app);

    let mut args: Vec<String> = Vec::new();
    if backend.is_bundled() {
        args.push("--run-tile-server".into());
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

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动瓦片服务失败：{e}（{}）", backend.describe()))?;

    // 把服务的人类日志转到本进程 stderr，方便在 Tauri 控制台观察
    if let Some(err) = child.stderr.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                eprintln!("[tile_server] {line}");
            }
        });
    }

    *svc.tile.lock().unwrap() = Some(child);
    let msg = format!(
        "已用 {} 启动瓦片服务（端口 {BACKEND_PORT}，数据根 {}）",
        backend.describe(),
        data_root.display()
    );
    log_line(&msg);
    Ok(msg)
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
        tile_running: port_open(BACKEND_PORT),
        image: image.as_ref().map(|p| p.display().to_string()),
        gaps: cfg
            .gaps
            .clone()
            .or_else(|| resolve_gaps(&app).map(|p| p.display().to_string())),
        data_root: data_base(&app).display().to_string(),
        needs_setup: image.is_none(),
    }
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
    if let Some(p) = image {
        let pb = PathBuf::from(&p);
        if !pb.exists() {
            return Err(format!("影像文件不存在：{p}"));
        }
        cfg.image = Some(p);
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
        if !port_open(BACKEND_PORT) {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    match start_tile_server(&app, &state) {
        Ok(msg) => log_line(&msg),
        Err(e) if e == NEED_IMAGE => {}
        Err(e) => log_line(&format!("重启瓦片服务失败：{e}")),
    }

    Ok(get_status(app))
}

#[tauri::command]
fn backend_url() -> String {
    format!("http://127.0.0.1:{BACKEND_PORT}")
}

#[tauri::command]
fn service_status(app: tauri::AppHandle) -> ServiceStatus {
    ServiceStatus {
        backend_url: format!("http://127.0.0.1:{BACKEND_PORT}"),
        tile_server_running: port_open(BACKEND_PORT),
        backend: resolve_backend(&app).map(|b| b.describe()),
        project_root: project_root(&app).map(|p| p.display().to_string()),
    }
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
            if !port_open(BACKEND_PORT) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
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
            restart_tile_server,
            run_detect,
            cancel_detect,
            detect_status,
            get_status,
            set_data_paths
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
                }
            }
        });
}
