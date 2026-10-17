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
use tauri::{Emitter, Manager, RunEvent};

/// 瓦片 / 辅助服务端口（与 `desktop/src/api/backend.ts` 的 BACKEND_BASE 一致）
const BACKEND_PORT: u16 = 8765;

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
        // 护栏 2：Windows 非控制台管道默认 cp936，中文日志/路径会乱码或抛错
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
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

    let py = resolve_python(&app).ok_or("找不到 Python 解释器：请设置 FGD_PYTHON")?;
    let root = project_root(&app).ok_or("定位不到项目根目录")?;
    let script = root.join("scripts").join("sidecar.py");
    if !script.exists() {
        return Err(format!("找不到 {}", script.display()));
    }
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
    let json = serde_json::to_string(&payload).map_err(|e| format!("参数序列化失败：{e}"))?;

    let mut cmd = Command::new(&py);
    cmd.arg(&script)
        .arg("--params-json")
        .arg(&json)
        .current_dir(&root)
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 sidecar 失败：{e}（解释器 {}）", py.display()))?;

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
            restart_tile_server,
            run_detect,
            cancel_detect,
            detect_status
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
