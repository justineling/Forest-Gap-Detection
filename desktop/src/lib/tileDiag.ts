/**
 * 影像服务失败时的「真因翻译」。
 *
 * 为什么单独成模块：这段逻辑是纯函数（输入证据 → 输出人话），
 * 值得单独测；而它所在的地方（弹窗组件）一旦要测就得把 React 拖进
 * 测试环境，代价太大。
 *
 * 背景（2026-10-20 公司电脑事故）：界面原来只有一句
 *   「影像服务没能启动。请确认：① 文件没被其它程序占用；
 *     ② 文件是标准的 GeoTIFF；③ 磁盘剩余空间足够。」
 * 它唯一的事实依据是"120 秒内 /meta 没应答"，三条建议全是猜的。
 * 现场三条全不对（真因在端口/进程层），用户照着做一圈没解决，
 * 只能来问"为什么家里能跑"。
 *
 * 所以现在按**证据**分流，每类都给可执行的下一步。
 */
import type { TileDiag } from '../api/backend'

export interface Explanation {
  /** 一句话真因（弹窗标题） */
  title: string
  /** 可执行的下一步（按顺序照做） */
  steps: string[]
}

/** 把有符号的 int32 退出码打成 0x 形式（Windows NTSTATUS 惯用写法） */
export function exitCodeHex(code: number): string {
  return '0x' + (code >>> 0).toString(16).toUpperCase().padStart(8, '0')
}

/**
 * 常见 NTSTATUS 退出码 → 人话。
 *
 * 为什么值得硬编码这两个：它们是"杀软拦截 / 运行库缺失"的直接指纹，
 * 用户看到 `0xC0000135` 只会一脸茫然，看到"缺少 VC++ 运行库"才知道要干什么。
 */
function exitHint(code: number): string | null {
  // -1073741515 = 0xC0000135 STATUS_DLL_NOT_FOUND
  if (code === -1073741515) return '本机缺少运行库（DLL 找不到），通常是 VC++ 运行库未安装或被隔离'
  // -1073741502 = 0xC0000142 STATUS_DLL_INIT_FAILED
  if (code === -1073741502) return 'DLL 初始化失败，最常见的原因是杀毒软件拦截了运行时'
  return null
}

/**
 * 依据证据给出真因与下一步。
 *
 * 判定顺序**刻意**是这个次序：先排"根本不是我们的问题"（端口被占），
 * 再看"进程死了"（退出码），再看"进程活着但没开门"，最后才回落到
 * 超时的通用建议。顺序反了就会出现老毛病：拿三条猜测盖住确切证据。
 */
export function explain(
  d: TileDiag | null,
  foreign: boolean,
  timeoutSec = 120,
): Explanation {
  // ② 进程起来了又立刻退出 —— 杀软拦截 / DLL 缺失的典型指纹
  if (d && d.exit_code !== null && d.exit_code !== 0) {
    const c = d.exit_code
    return {
      title: `影像服务启动后立即退出（退出码 ${c} / ${exitCodeHex(c)}）`,
      steps: [
        exitHint(c) ?? '服务进程刚起来就退出了，通常是安全软件拦截，或运行库不完整。',
        '把这个目录加入杀毒软件 / EDR 的白名单后重试：',
        '  %LOCALAPPDATA%\\Programs\\Forest Gap Detection',
        '需要放行的具体文件是 py-runtime\\desktop_entry\\desktop_entry.exe。',
        '下方「技术细节」里有它退出前打印的最后几行，可直接发给开发者。',
      ],
    }
  }

  // ① 进程起来了又立刻退出 —— **先判这个**：退出码是最确凿的证据。
  //    为什么顺序重要：服务崩溃后端口可能还残留（TIME_WAIT / 未回收），
  //    此时 port_open=true、ours=false；若先判端口就会误报"被别人占用"。
  //    2026-10-21 公司电脑实测：真因是服务秒退，界面却让用户去查端口占用。
  //    杀软拦截 / DLL 缺失的典型指纹
  if (d && d.exit_code !== null && d.exit_code !== 0) {
    const c = d.exit_code
    return {
      title: `影像服务启动后立即退出（退出码 ${c} / ${exitCodeHex(c)}）`,
      steps: [
        exitHint(c) ?? '服务进程刚起来就退出了，通常是安全软件拦截，或运行库不完整。',
        '把这个目录加入杀毒软件 / EDR 的白名单后重试：',
        '  %LOCALAPPDATA%\\Programs\\Forest Gap Detection',
        '需要放行的具体文件是 py-runtime\\desktop_entry\\desktop_entry.exe。',
        '下方「技术细节」里有它退出前打印的最后几行，可直接发给开发者。',
      ],
    }
  }

  // ② 端口被别人占 —— 只有"我们的进程没留下退出码"时才成立
  if (foreign || (d && d.port_open && !d.ours && d.exit_code == null)) {
    const port = d?.port ?? 8765
    return {
      title: `端口 ${port} 被其它程序占用`,
      steps: [
        '本应用的影像服务没能启动，因为端口已经被别的东西占住了 —— 不是影像文件的问题。',
        '保持本应用开着，用管理员 PowerShell 跑这一行，看是谁占的：',
        `  Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object OwningProcess`,
        '再 Get-Process -Id <上面那个 PID> 认一下是谁，关掉它（或重启电脑），然后重新点「开始使用」。',
      ],
    }
  }

  // ③ 进程活着但端口没开 —— 多半在啃大影像，别急着下结论
  if (d && d.child_alive && !d.port_open) {
    return {
      title: '服务进程在运行，但端口还没打开',
      steps: [
        '影像很大时首次加载要读索引 / 建金字塔，可能比平时慢，先再等 1~2 分钟。',
        '若长时间不动，展开下方「技术细节」看服务日志最后几行 —— 通常写着卡在哪一步。',
        '也可以关掉本应用，双击项目里的「诊断影像服务.bat」跑一次，它会把日志抓成文件。',
      ],
    }
  }

  // ④ 进程压根没起来（没有子进程、也没有退出码）
  if (d && !d.child_alive && d.exit_code === null) {
    return {
      title: '影像服务没能启动（进程没有起来）',
      steps: [
        d.start_error || '外壳没能拉起 Python 运行时 —— 可能安装不完整，或被安全软件隔离了文件。',
        '重新安装一次安装包，并确认安装过程没有被安全软件中断。',
        '仍然不行时，在安装目录里跑一次自检：',
        '  py-runtime\\desktop_entry\\desktop_entry.exe --self-test',
      ],
    }
  }

  // ⑤ 兜底：真的只是等超时（此时那三条提示才是恰当的）
  return {
    title: `${timeoutSec} 秒内影像服务没有应答`,
    steps: [
      '① 文件没被其它程序占用（ArcGIS / QGIS 打开着同一个 tif 会锁住它）；',
      '② 文件是标准的 GeoTIFF（能被 QGIS 正常打开）；',
      '③ 磁盘剩余空间足够（建议至少留出影像大小的空闲）。',
      '展开下方「技术细节」可看到服务的原始输出，报错就在那里。',
    ],
  }
}
