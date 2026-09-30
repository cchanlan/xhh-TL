/**
 * 调 pm2 / npm 的统一入口（跨平台）。
 *
 * 为什么不直接 `execFile('pm2', ...)`：Windows 上 npm 全局装的 pm2 是 `pm2.cmd`，
 * 而 Node 的 execFile / spawn 在 Windows 上**不能**直接执行 .cmd / .bat
 * （官方文档明确写了这一点，Node 18.20 / 20.12 起更是直接拒绝），
 * 裸名字 `pm2` 也不行 —— CreateProcess 只认 .exe、不查 PATHEXT。
 * 结果就是「明明装了 pm2」却报 command not found，还容易被误判成没装。
 *
 * 解法（思路同 @lyln/lpm2）：从 pm2 的 package.json 里解析出**真实 JS 入口**，
 * 用 process.execPath 直接跑 —— 不经过任何 .cmd / .ps1 包装器，也不用 shell。
 * 顺带避开 `pm2.ps1` 会吃掉 `--` 参数终止符的问题（`pm2 start x -- server.py`
 * 的 `--` 要是被吃了，server.py 就传不进去）。
 *
 * ⚠️ 本封装只解决「找不到 / 调不动 pm2」。若 pm2 报 `connect EPERM \\.\pipe\rpc.sock`
 *    （同机多套 pm2 抢同一个命名管道），那是另一回事，可考虑改用 @lyln/lpm2。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { pluginDir } from './pluginConfig.js'

const IS_WIN = process.platform === 'win32'

// 解析一次就够（pm2 装在哪不会在运行期变），但自动装完要失效重探
let cachedLauncher = null
let cachedResolved = false

/** 下次调用重新探测（装完 pm2 不用重启框架就能被认到） */
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

/** 找一个包的真实 JS 入口；找不到返回空串 */
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

/**
 * 决定怎么调 pm2：优先「node 跑真实 JS 入口」，实在没有才退回 PATH 上的命令名。
 * 返回 { file, prefix, shell }
 */
function resolveLauncher() {
  if (cachedResolved) return cachedLauncher
  cachedResolved = true

  const js = resolveCliJs('pm2', 'pm2')
  cachedLauncher = js
    ? { file: process.execPath, prefix: [js], shell: false }
    // 兜底：PATH 上有 pm2 时用。Windows 上裸名字 CreateProcess 找不到 .cmd，
    // 只能交给 cmd.exe 按 PATHEXT 补后缀。
    : { file: 'pm2', prefix: [], shell: IS_WIN }
  return cachedLauncher
}

function quote(s) {
  return /[\s&|()<>^"]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s)
}

/** shell 拼接模式下这些字符会让命令跑歪，宁可失败也别乱跑 */
function shellUnsafe(args) {
  return args.some((a) => /[%!"\r\n]/.test(String(a)))
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

/**
 * 跑一条 pm2 命令。
 * @param {string[]} args 参数数组，如 ['restart', 'geetest-solver']
 * @param {{timeout?: number, cwd?: string, env?: object}} opts
 * @returns {Promise<{ok: boolean, out: string, missing: boolean}>}
 */
export function pm2(args = [], { timeout = 120000, cwd, env } = {}) {
  const l = resolveLauncher()
  return runCli(l.file, l.prefix, args, {
    shell: l.shell,
    timeout,
    cwd: cwd || pluginDir,
    env: { ...process.env, ...(env || {}) },
  })
}

/** pm2 是否可用 —— 真跑一次 --version，比看文件在不在准 */
export async function hasPm2() {
  return (await pm2(['--version'], { timeout: 30000 })).ok
}

/**
 * `pm2 jlist` 并解析成数组，失败返回空数组。
 *
 * ⚠️ 不能直接 JSON.parse 整段输出：pm2 在 daemon 与 CLI 版本不一致时会先吐一段
 *    「In-memory PM2 is out-of-date, do: $ pm2 update」提示，JSON 前面有杂音，
 *    直接 parse 必炸 —— 表现为「进程明明在跑，状态却显示未部署」。
 *    所以从第一个 `[` 截到最后一个 `]`。
 */
export async function pm2Jlist({ timeout = 30000 } = {}) {
  const r = await pm2(['jlist'], { timeout })
  if (!r.ok || !r.out) return []
  const start = r.out.indexOf('[')
  const end = r.out.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const list = JSON.parse(r.out.slice(start, end + 1))
    return Array.isArray(list) ? list : []
  } catch (_) {
    return []
  }
}

/**
 * 确保 pm2 可用：没有就自动装一个（纯 npm 操作，不动系统环境）。
 *
 * npm 自己也可能是 .cmd，同样用「node 跑 npm-cli.js」的路子绕开。
 *
 * @returns {Promise<{ok: boolean, msg?: string}>}
 */
export async function ensurePm2() {
  if (await hasPm2()) return { ok: true }

  const npmJs = resolveCliJs('npm', 'npm')
  if (!npmJs) {
    return { ok: false, msg: '自动安装 pm2 失败（找不到 npm），请手动执行：npm i -g pm2' }
  }

  await runCli(process.execPath, [npmJs], ['i', '-g', 'pm2'], {
    shell: false,
    timeout: 300000,
    cwd: pluginDir,
    env: process.env,
  })
  resetCache() // 装完位置可能变了，必须重探

  if (await hasPm2()) return { ok: true }
  return { ok: false, msg: '自动安装 pm2 失败，请手动执行：npm i -g pm2' }
}
