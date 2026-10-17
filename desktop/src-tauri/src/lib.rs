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
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{Manager, RunEvent};

/// 瓦片 / 辅助服务端口（与 `desktop/src/api/backend.ts` 的 BACKEND_BASE 一致）
const BACKEND_PORT: u16 = 8765;

#[derive(Default)]
struct Services {
    tile: Mutex<Option<Child>>,
}

#[derive(Serialize)]
struct ServiceStatus {
    backend_url: String,
    tile_server_running: bool,
    python: Option<String>,
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
fn resolve_python(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("FGD_PYTHON") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    if let Ok(res) = app.path().resource_dir() {
        for cand in ["python/python.exe", "python/bin/python3", "python.exe"] {
            let pb = res.join(cand);
            if pb.exists() {
                return Some(pb);
            }
        }
    }
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    for cand in [".venv/Scripts/python.exe", ".venv/bin/python"] {
        let pb = root.join(cand);
        if pb.exists() {
            return pb.canonicalize().ok();
        }
    }
    None
}

/// 拉起瓦片服务。已在监听则不重复启动（多人共用 / 手动起过服务的场景）。
fn start_tile_server(app: &tauri::AppHandle, svc: &Services) -> Result<String, String> {
    if port_open(BACKEND_PORT) {
        return Ok(format!("端口 {BACKEND_PORT} 已在监听，复用现有服务"));
    }
    let py = resolve_python(app)
        .ok_or("找不到 Python 解释器：请设置 FGD_PYTHON，或先运行 scripts/配置环境.ps1")?;
    let root = project_root(app).ok_or("定位不到项目根目录")?;
    let script = root.join("scripts").join("tile_server.py");
    if !script.exists() {
        return Err(format!("找不到 {}", script.display()));
    }

    let mut cmd = Command::new(&py);
    cmd.arg(&script)
        .current_dir(&root)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    // Windows 下别弹出黑色控制台窗口
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动瓦片服务失败：{e}（解释器 {}）", py.display()))?;

    // 把服务的人类日志转到本进程 stderr，方便在 Tauri 控制台观察
    if let Some(err) = child.stderr.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                eprintln!("[tile_server] {line}");
            }
        });
    }

    *svc.tile.lock().unwrap() = Some(child);
    Ok(format!(
        "已用 {} 启动瓦片服务（端口 {BACKEND_PORT}）",
        py.display()
    ))
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
        python: resolve_python(&app).map(|p| p.display().to_string()),
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
        .manage(Services::default())
        .invoke_handler(tauri::generate_handler![
            backend_url,
            service_status,
            restart_tile_server
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let state = app.state::<Services>();
            match start_tile_server(&handle, &state) {
                Ok(msg) => println!("[fgd] {msg}"),
                Err(e) => eprintln!("[fgd] 瓦片服务未启动：{e}\n       前端会提示「影像瓦片服务未连接」，多边形仍可查看/编辑"),
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
                }
            }
        });
}
