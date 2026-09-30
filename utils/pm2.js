/**
 * 调 lpm2 / pm2 / npm 的统一入口（跨平台）。
 *
 * 为什么不直接 `execFile('pm2', ...)`：Windows 上 npm 全局装的 pm2 是 `pm2.cmd`，
 * 而 Node 的 execFile / spawn 在 Windows 上**不能**直接执行 .cmd / .bat
 * （官方文档明确写了这一点，Node 18.20 / 20.12 起更是直接拒绝），
 * 裸名字 `pm2` 也不行 —— CreateProcess 只认 .exe、不查 PATHEXT。
 * 结果就是「明明装了 pm2」却报 command not found，还容易被误判成没装。
 *
 * 解法：从包的 package.json 里解析出**真实 JS 入口**，用 process.execPath 直接跑 ——
 * 不经过任何 .cmd / .ps1 包装器，也不用 shell。顺带避开 `pm2.ps1` 会吃掉 `--`
 * 参数终止符的问题（`pm2 start x -- server.py` 的 `--` 要是被吃了，server.py 就传不进去）。
 *
 * 平台分工 —— **两端刻意分开，逻辑不共用**：
 *
 *   Windows：默认经 **lpm2**（@lyln/lpm2）启动，并给**专属 PM2_HOME**（data/pm2，已 gitignore）。
 *     Windows 上 pm2 把 daemon 传输管道**写死**成 `\\.\pipe\rpc.sock`（不分用户、不分
 *     PM2_HOME、不分项目）。同机多套 pm2 就抢同一个管道：轻则 `connect EPERM` 把 CLI 带崩，
 *     重则**连上别人的 daemon**、把别的项目的进程列成自己的 ——#过码服务状态 会显示一堆
 *     不相干的进程，`restart all` / `delete all` 还会动错项目。lpm2 把管道按 PM2_HOME 派生
 *     （`\\.\pipe\lpm2-<hash>-rpc.sock`），pm2 仍是引擎、参数原样转发，不经过 shell。
 *     专属 PM2_HOME 这一步也是必须的：两套 daemon 共用默认 `~/.pm2` 时进程表各看各的、
 *     dump 却是同一个文件，插件的 `pm2 save` 会把用户原有的进程从 dump 里抹掉
 *     （开机会 resurrect 不出来）。
 *
 *   Linux / macOS：**保持原样** —— 直连 pm2 的真实 JS 入口、用默认 `~/.pm2`。
 *     不引入 lpm2、不装额外依赖、不改 daemon home：那边 pm2 的 socket 本来就放在
 *     PM2_HOME 里，没有 Windows 这个固定管道问题，多一层 lpm2 只是白添依赖。
 *     行为与接入 lpm2 之前完全一致。
 *
 * Windows 的退路：lpm2 装不上（离线 / 没权限 / 没有 npm）时退回直连 pm2，并且**不设
 * PM2_HOME** —— 行为跟接入 lpm2 之前完全一致（原因见 launcherEnv）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { pluginDir } from './pluginConfig.js'

const IS_WIN = process.platform === 'win32'

/** 启动器包名：缺了就装它，并把 pm2 显式一起装上（peer 自动安装并不可靠） */
const LPM2_PKG = '@lyln/lpm2'

/**
 * 专属 PM2_HOME（只在 Windows 上用）。
 * 管道名由它派生 → 与机器上其它 pm2 彻底隔离；dump / logs 也落在插件自己的
 * data/ 目录里（该目录已 gitignore），不会去动用户的 ~/.pm2。
 */
const PM2_HOME_DIR = path.join(pluginDir, 'data', 'pm2')

// 解析一次就够（装在哪不会在运行期变），但自动装完要失效重探
let cachedLauncher = null
let cachedResolved = false

/** 下次调用重新探测（装完启动器不用重启框架就能被认到） */
export function resetCache() {
  cachedResolved = false
  cachedLauncher = null
}

/** 从某个 package.json 里读出 bin 指向的真实 JS 入口，不存在则返回空串 */
function readBin(pkgJsonPath, binKey) {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'))
    const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[binKey]
    if (!rel) return ''
    const abs = path.resolve(path.dirname(pkgJsonPath), rel)
    return fs.existsSync(abs) ? abs : ''
  } catch (_) {
    return ''
  }
}

/** 全局安装的常见落点（Node 的模块解析默认不会去全局目录找，只能自己列） */
function globalRoots() {
  const nodeDir = path.dirname(process.execPath)
  if (IS_WIN) {
    return [
      process.env.APPDATA && path.join(process.env.APPDATA, 'npm'), // npm i -g 的默认落点
      nodeDir, // 官方安装包会把全局包放在 node 目录下
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs'),
      process.env.ALLUSERSPROFILE && path.join(process.env.ALLUSERSPROFILE, 'npm'),
    ]
      .filter(Boolean)
      .map((d) => path.join(d, 'node_modules'))
  }
  return [
    path.join(nodeDir, '..', 'lib', 'node_modules'), // nvm / 官方安装包
    '/usr/local/lib/node_modules', // npm i -g 默认
    '/usr/lib/node_modules', // 发行版包管理器
    process.env.HOME && path.join(process.env.HOME, '.local', 'lib', 'node_modules'),
  ].filter(Boolean)
}

/** 找一个包的真实 JS 入口；找不到返回空串（pkgName 可以是 @scope/name） */
function resolveCliJs(pkgName, binKey) {
  // ① 走模块解析：本地安装 / NODE_PATH / pnpm 软链都能命中
  for (const base of [path.join(pluginDir, '__resolve__.js'), import.meta.url]) {
    try {
      const req = createRequire(base)
      const abs = readBin(req.resolve(`${pkgName}/package.json`), binKey)
      if (abs) return abs
    } catch (_) {}
  }
  // ② 全局安装的固定落点
  for (const root of globalRoots()) {
    const abs = readBin(path.join(root, pkgName, 'package.json'), binKey)
    if (abs) return abs
  }
  return ''
}

/** 启动器（lpm2）的真实 JS 入口；没装返回空串 */
function resolveLpm2Js() {
  return resolveCliJs(LPM2_PKG, 'lpm2')
}

/** pm2 自己的真实 JS 入口（lpm2 缺失时的退路） */
function resolvePm2Js() {
  return resolveCliJs('pm2', 'pm2')
}

/**
 * Windows 上给 lpm2 指一个专属 PM2_HOME（data/pm2）。
 * 用户自己显式设了 PM2_HOME / LPM2_HOME 就尊重他的设置，不抢。
 * POSIX 上不设：那边 pm2 的 socket 本来就按 PM2_HOME 分，保持默认行为即可。
 *
 * ⚠️ 这个 env 只在「Windows + lpm2」这条路上用。Windows 上退回直连 pm2 时**绝不能设**：
 *    pm2 的管道写死在 `\\.\pipe\rpc.sock`，配专属 home 会变成「连上用户的 daemon、
 *    却按我们的 home 读写 dump」，两边的进程表和 dump 全乱。
 */
function launcherEnv() {
  if (!IS_WIN) return null
  if (process.env.LPM2_HOME || process.env.PM2_HOME) return null
  return { PM2_HOME: PM2_HOME_DIR }
}

/** 真要拉起进程前才建目录（launcherInfo 这类只读调用不该有副作用） */
function ensureHomeDir(env) {
  if (!env?.PM2_HOME) return
  try {
    fs.mkdirSync(env.PM2_HOME, { recursive: true })
  } catch (_) {}
}

/**
 * 决定怎么调（平台分工见文件头，两端刻意分开）：
 *   Windows：① lpm2（隔离管道 + 专属 home）② pm2 真实入口 ③ PATH 上的 pm2
 *   POSIX  ：只有 ② / ③，不碰 lpm2 —— 那边 pm2 的 socket 本来就按 PM2_HOME 分
 * 返回 { kind, file, prefix, shell, env }
 */
function resolveLauncher() {
  if (cachedResolved) return cachedLauncher
  cachedResolved = true

  // ★ 只有 Windows 需要 lpm2（固定管道问题）；Linux / macOS 直连 pm2，保持原样
  const lpm2Js = IS_WIN ? resolveLpm2Js() : ''
  if (lpm2Js) {
    cachedLauncher = {
      kind: 'lpm2',
      file: process.execPath,
      prefix: [lpm2Js],
      shell: false,
      env: launcherEnv(),
    }
    return cachedLauncher
  }

  // Windows 上裸名字 CreateProcess 找不到 .cmd，只能交给 cmd.exe 按 PATHEXT 补后缀
  const pm2Js = resolvePm2Js()
  cachedLauncher = pm2Js
    ? { kind: 'pm2', file: process.execPath, prefix: [pm2Js], shell: false, env: null }
    : { kind: 'pm2-path', file: 'pm2', prefix: [], shell: IS_WIN, env: null }
  return cachedLauncher
}

function quote(s) {
  return /[\s&|()<>^"]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s)
}

/** shell 拼接模式下这些字符会让命令跑歪，宁可失败也别乱跑 */
function shellUnsafe(args) {
  return args.some((a) => /[%!"\r\n]/.test(String(a)))
}

/** 输出尾巴，够说明失败原因（EPERM 要管理员 / 网络超时 / 代理不对） */
function tail(out, n = 400) {
  const s = String(out || '').trim()
  return s.length > n ? `…${s.slice(-n)}` : s
}

/** 起一个子进程收输出，不抛异常 */
function runCli(file, prefix, args, { shell, timeout, cwd, env }) {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    let timer
    const finish = (ok, extra = '', missing = false) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok, out: out + extra, missing })
    }

    let child
    try {
      if (shell) {
        if (shellUnsafe([file, ...args])) {
          return resolve({ ok: false, out: '参数含 shell 不支持的字符，已放弃', missing: false })
        }
        child = spawn([file, ...args].map(quote).join(' '), {
          shell: true,
          cwd,
          env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } else {
        child = spawn(file, [...prefix, ...args], {
          cwd,
          env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      }
    } catch (err) {
      const code = err?.code
      return resolve({ ok: false, out: String(err?.message || err), missing: code === 'ENOENT' || code === 'EINVAL' })
    }

    child.stdout?.on('data', (d) => (out += d))
    child.stderr?.on('data', (d) => (out += d))
    child.on('error', (err) => {
      const code = err?.code
      finish(false, String(err?.message || err), code === 'ENOENT' || code === 'EINVAL')
    })
    child.on('close', (code) => finish(code === 0))
    timer = setTimeout(() => {
      try {
        child.kill()
      } catch (_) {}
      finish(false, '\n(超时)')
    }, timeout)
  })
}

/** 绕过 lpm2 直接调 pm2：退路用，也用来判断「现有的 pm2 到底还能不能用」 */
function runDirect(args, { timeout = 30000 } = {}) {
  const js = resolvePm2Js()
  const l = js
    ? { file: process.execPath, prefix: [js], shell: false }
    : { file: 'pm2', prefix: [], shell: IS_WIN }
  return runCli(l.file, l.prefix, args, {
    shell: l.shell,
    timeout,
    cwd: pluginDir,
    env: process.env,
  })
}

/**
 * 跑一条 pm2 命令（默认经 lpm2，参数原样转发）。
 * @param {string[]} args 参数数组，如 ['restart', 'geetest-solver']
 * @param {{timeout?: number, cwd?: string, env?: object}} opts
 * @returns {Promise<{ok: boolean, out: string, missing: boolean}>}
 */
export function pm2(args = [], { timeout = 120000, cwd, env } = {}) {
  const l = resolveLauncher()
  ensureHomeDir(l.env)
  return runCli(l.file, l.prefix, args, {
    shell: l.shell,
    timeout,
    cwd: cwd || pluginDir,
    env: { ...process.env, ...(l.env || {}), ...(env || {}) },
  })
}

/** 当前用的是哪种启动方式（给 #过码服务状态 显示用；只读，不启进程） */
export function launcherInfo() {
  const l = resolveLauncher()
  return {
    kind: l.kind,
    isolated: !!l.env?.PM2_HOME,
    pm2Home: l.env?.PM2_HOME || process.env.LPM2_HOME || process.env.PM2_HOME || '(默认 ~/.pm2)',
  }
}

/** pm2 是否可用 —— 真跑一次 --version，比看文件在不在准（会连带验证 lpm2 能不能解析到 pm2） */
export async function hasPm2() {
  return (await pm2(['--version'], { timeout: 30000 })).ok
}

/**
 * 从一坨输出里找出 pm2 的 JSON 数组。
 *
 * ⚠️ 不能直接 JSON.parse 整段，也不能只做「从第一个 `[` 切到最后一个 `]`」：
 * pm2 的提示里带方括号，最典型的是首次拉起 daemon 时先打一行
 *   [PM2] Spawning PM2 daemon with pm2_home=C:\Users\x\.pm2
 * 再输出 JSON —— 从第一个 `[` 切就会切到那行提示上，parse 必炸，表现为
 * 「进程明明在跑，状态却显示未部署」。版本不一致时的
 * `>>>> In-memory PM2 is out-of-date, do: $ pm2 update` 没方括号，但同样不该假定。
 * 所以这里扫一遍候选起点，按括号配对找出第一个**真能 parse 成数组**的片段。
 */
function extractJsonArray(text) {
  for (let start = text.indexOf('['); start !== -1; start = text.indexOf('[', start + 1)) {
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < text.length; i++) {
      const c = text[i]
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') inStr = true
      else if (c === '[' || c === '{') depth++
      else if (c === ']' || c === '}') {
        depth--
        if (depth === 0) {
          if (c === ']') {
            try {
              const v = JSON.parse(text.slice(start, i + 1))
              if (Array.isArray(v)) return v
            } catch (_) {}
          }
          break // 这个起点配不成合法数组，换下一个
        }
      }
    }
  }
  return []
}

/**
 * `pm2 jlist` 并解析成数组，失败返回空数组。
 */
export async function pm2Jlist({ timeout = 30000 } = {}) {
  const r = await pm2(['jlist'], { timeout })
  if (!r.ok || !r.out) return []
  return extractJsonArray(r.out)
}

/**
 * 本插件的 daemon 里有没有这个进程。
 * 用来区分「已被本插件接管」和「跑在别的 pm2 daemon 里」（旧版直连留下的进程）。
 */
export async function pm2HasProcess(name) {
  const list = await pm2Jlist()
  return list.some((p) => p.name === name)
}

/**
 * 确保进程管理器可用（平台分工见文件头，两端分开处理）。
 *
 * Windows：优先 lpm2，缺了就 `npm i -g @lyln/lpm2 pm2` —— 顺手把 pm2 显式一起装上，
 *   因为 peer 自动安装并不可靠（npm 6 没有这机制、pnpm 关掉 auto-install-peers、
 *   `--legacy-peer-deps` 都会跳过），只装到 lpm2 的话它会以
 *   「could not resolve pm2 from this directory」直接退出。
 *   装不上（离线 / 没权限 / 没有 npm）**不把路堵死**：现有的 pm2 还能直连就照旧用，
 *   只是没有管道隔离 —— 至少不会因为装不上 lpm2 就整个部署不了。
 *
 * Linux / macOS：**不碰 lpm2**，只保证 pm2 可用 —— 没有就 `npm i -g pm2`，
 *   跟接入 lpm2 之前的行为完全一样。
 *
 * npm 自己也可能是 .cmd，同样用「node 跑 npm-cli.js」的路子绕开。
 *
 * @returns {Promise<{ok: boolean, via?: 'lpm2'|'pm2', degraded?: boolean, msg?: string, detail?: string}>}
 */
export async function ensurePm2() {
  const npmJs = resolveCliJs('npm', 'npm')

  // ── Linux / macOS：直连 pm2，保持原样 ──────────────────────────────
  if (!IS_WIN) {
    if (await hasPm2()) return { ok: true, via: 'pm2' }
    if (!npmJs) return { ok: false, msg: '自动安装 pm2 失败（找不到 npm），请手动执行：npm i -g pm2' }
    const r = await runCli(process.execPath, [npmJs], ['i', '-g', 'pm2'], {
      shell: false,
      timeout: 300000,
      cwd: pluginDir,
      env: process.env,
    })
    resetCache()
    if (await hasPm2()) return { ok: true, via: 'pm2' }
    return { ok: false, msg: '自动安装 pm2 失败，请手动执行：npm i -g pm2', detail: tail(r.out) }
  }

  // ── Windows：lpm2（隔离管道）优先 ─────────────────────────────────
  if (resolveLpm2Js() && (await hasPm2())) return { ok: true, via: 'lpm2' }

  let detail = ''
  if (npmJs) {
    const r = await runCli(process.execPath, [npmJs], ['i', '-g', LPM2_PKG, 'pm2'], {
      shell: false,
      timeout: 300000,
      cwd: pluginDir,
      env: process.env,
    })
    detail = tail(r.out)
    resetCache() // 装完位置可能变了，必须重探
    if (resolveLpm2Js() && (await hasPm2())) return { ok: true, via: 'lpm2' }
  }

  if ((await runDirect(['--version'])).ok) {
    return {
      ok: true,
      via: 'pm2',
      degraded: true,
      detail,
      msg: npmJs
        ? 'lpm2 没装上，退回直接调用现有的 pm2（没有进程隔离）'
        : '这台机器上没有 npm，退回直接调用现有的 pm2（没有进程隔离）',
    }
  }

  return {
    ok: false,
    msg: `自动安装失败，请手动执行：npm i -g ${LPM2_PKG} pm2`,
    detail,
  }
}
