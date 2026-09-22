/**
 * #过码部署 — 一键装好全自动过码服务
 *
 * 过码服务放在仓库的 solver 分支（多数用户用不上，不塞进 master）。
 * 这个指令替用户把那几步做完：
 *   拉 service/ → 建 venv 装依赖 → pm2 起服务 → 写回配置
 *
 * 服务是纯 HTTP 协议实现，不需要桌面环境或浏览器，Linux / Windows 都能跑。
 */

import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import plugin from '../../../lib/plugins/plugin.js'
import { config, pluginDir, patchUserConfig } from '../utils/pluginConfig.js'
import { quoteEnabled } from '../utils/replyHelper.js'

const exec = promisify(execFile)
const SERVICE_DIR = path.join(pluginDir, 'service', 'geetest')
const PM2_NAME = 'geetest-solver'
const PORT = 8766

// 服务运行必需的文件（都在 solver 分支上）。少任何一个都跑不起来：
// w.py 缺了生成不出 w 参数、server.py 缺了服务起不来。
// ⚠️ 这些文件是「solver 分支跟踪、master 不跟踪」，在主工作区切分支
//    （git checkout master）会被 git 静默删掉——而且服务进程照跑、/health 照绿，
//    看不出异常。所以状态检查必须真去磁盘上数一遍。
const SERVICE_FILES = ['server.py', 'w.py', 'start.sh', 'requirements.txt']

// Python 依赖：装进服务目录的 venv，不动系统环境
const PIP_PACKAGES = ['-r', 'requirements.txt']

// 依赖项 → 各自的 import 名。装完逐个真 import 一遍才知道谁没装上，
// 光看 pip 的退出码不行：pip 装成功但 .so 跑不起来（glibc 不匹配）照样是缺。
const DEP_MODULES = [
  { pkg: 'bili-ticket-gt-python', mod: 'bili_ticket_gt_python' },
  { pkg: 'pycryptodome', mod: 'Crypto' },
  { pkg: 'httpx', mod: 'httpx' },
]

// bili-ticket-gt-python 0.2.5 是 manylinux_2_31 的 wheel，glibc 低于这个版本装不上
// （0.3.x 要 2.38，更装不上，所以这个包固定在 0.2.5）
const MIN_GLIBC = [2, 31]

// pip 源候选。国内直连 pypi.org 经常几十秒超时甚至直接失败，
// 所以装依赖前先探一遍、按快慢排序，谁快用谁，第一个装失败自动换下一个。
const PIP_INDEXES = [
  { name: '清华', url: 'https://pypi.tuna.tsinghua.edu.cn/simple' },
  { name: '阿里云', url: 'https://mirrors.aliyun.com/pypi/simple/' },
  { name: '腾讯云', url: 'https://mirrors.cloud.tencent.com/pypi/simple/' },
  { name: '中科大', url: 'https://pypi.mirrors.ustc.edu.cn/simple' },
  { name: '官方', url: 'https://pypi.org/simple/' },
]

const log = {
  mark: (...a) => (typeof logger !== 'undefined' ? logger.mark(...a) : console.log(...a)),
  error: (...a) => (typeof logger !== 'undefined' ? logger.error(...a) : console.error(...a)),
}

/** 跑一条命令，返回 { ok, out }，不抛 */
async function run(cmd, args, opts = {}) {
  try {
    const { stdout, stderr } = await exec(cmd, args, { timeout: 300000, ...opts })
    return { ok: true, out: String(stdout || '') + String(stderr || '') }
  } catch (err) {
    return { ok: false, out: String(err?.stdout || '') + String(err?.stderr || '') + String(err?.message || '') }
  }
}

/** 服务是否已经在正常响应（探 /health，比看 pm2 状态更准） */
async function isServiceAlive() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(4000) })
    return res.ok
  } catch (_) {
    return false
  }
}

async function has(cmd, args = ['--version']) {
  const r = await run(cmd, args)
  return r.ok
}

/**
 * 数一遍服务目录里的必需文件，返回缺失的文件名数组。
 *
 * 为什么要单独查这个：服务进程把代码读进内存后就与磁盘脱钩了 —— 文件被删掉时
 * 进程照跑、端口照开、/health 照绿，只有真正发一次过码才会暴露。所以状态检查
 * 不能只看进程和端口。
 */
function missingServiceFiles() {
  return SERVICE_FILES.filter((f) => {
    try {
      return !fs.existsSync(path.join(SERVICE_DIR, f))
    } catch (_) {
      return true
    }
  })
}

/** 服务目录是否已经建过（用来区分「没部署」和「部署了但文件残废」） */
function serviceDirExists() {
  try {
    return fs.existsSync(SERVICE_DIR)
  } catch (_) {
    return false
  }
}

/**
 * venv 里的 python 路径（跨平台：Linux 是 bin/、Windows 是 Scripts/）。
 * 找不到返回空串 —— 调用方据此判断「还没建 venv」。
 */
function venvPython() {
  for (const rel of [
    ['bin', 'python'],              // Linux / macOS
    ['Scripts', 'python.exe'],      // Windows
  ]) {
    const p = path.join(SERVICE_DIR, '.venv', ...rel)
    try {
      if (fs.existsSync(p)) return p
    } catch (_) {}
  }
  return ''
}

/**
 * 逐个真 import 一遍，返回**没装上**的依赖项。
 *
 * 用真 import 而不是 `pip list` / `find_spec`：装了但用不了的情况（wheel 的 glibc
 * 版本跟系统对不上、.so 缺依赖库）只有 import 那一刻才会炸，查列表是看不出来的。
 */
async function missingDeps(vpy) {
  const script = [
    'import json',
    `mods = ${JSON.stringify(DEP_MODULES.map((d) => d.mod))}`,
    'missing = []',
    'for m in mods:',
    '    try:',
    '        __import__(m)',
    '    except Exception:',
    '        missing.append(m)',
    'print(json.dumps(missing))',
  ].join('\n')
  const r = await run(vpy, ['-c', script])
  // 解释器本身都跑不起来（venv 坏了）就当全缺，让上层去报错
  if (!r.ok) return DEP_MODULES.slice()
  try {
    const mods = JSON.parse(r.out.trim().split(/\r?\n/).pop())
    return DEP_MODULES.filter((d) => mods.includes(d.mod))
  } catch (_) {
    return []
  }
}

/** 本机 glibc 版本，拿不到返回空串 */
async function libcVersion(vpy) {
  const r = await run(vpy, ['-c', 'import platform;print(platform.libc_ver()[1] or "")'])
  if (!r.ok) return ''
  return (r.out.trim().split(/\r?\n/).pop() || '').trim()
}

/** glibc 是否低于 MIN_GLIBC（版本号不能直接比大小，"2.9" > "2.31" 是假的） */
function libcTooOld(v) {
  const m = String(v || '').match(/^(\d+)\.(\d+)/)
  if (!m) return false
  const maj = Number(m[1])
  const min = Number(m[2])
  return maj < MIN_GLIBC[0] || (maj === MIN_GLIBC[0] && min < MIN_GLIBC[1])
}

/** pip 输出里有没有「本地要编译 / 平台对不上」的特征，用来跟「网络不通」区分开 */
function isBuildFailure(out) {
  return /glibc|manylinux|building wheel|failed building|error: command|rustc|cargo/.test(
    String(out || '').toLowerCase(),
  )
}

/**
 * 探一遍 pip 源，返回按响应快慢排好的列表（不通的 ms 为 Infinity，排在最后）。
 *
 * 探的是「这个包」的页面而不是源的根索引 —— 根索引页动辄几 MB，测出来的
 * 是带宽不是延迟，还慢。有 HTTP 响应就算通：404 只说明这个源上没有这个包页，
 * 不代表源不能用（真正的判据是后面 pip 装不装得上）。
 */
async function probePipIndexes() {
  const list = await Promise.all(
    PIP_INDEXES.map(async (idx) => {
      const t0 = Date.now()
      try {
        const res = await fetch(`${idx.url.replace(/\/+$/, '')}/bili-ticket-gt-python/`, {
          signal: AbortSignal.timeout(3000),
        })
        await res.arrayBuffer() // 读掉 body，别留着连接挂着
        return { ...idx, ms: Date.now() - t0 }
      } catch (_) {
        return { ...idx, ms: Infinity }
      }
    }),
  )
  return list.sort((a, b) => a.ms - b.ms)
}

/**
 * 装 Python 依赖。依赖齐了就直接返回；缺就先探源、按快的顺序依次试装。
 * 返回 { ok, msg }，ok 为 false 时 msg 是发给用户的失败提示。
 */
async function ensureDeps(vpy) {
  if (!(await missingDeps(vpy)).length) return { ok: true }

  const probed = await probePipIndexes()
  log.mark(
    '[xhh-TL][部署] pip 源探测：' +
      probed.map((p) => `${p.name}=${p.ms === Infinity ? '不通' : `${p.ms}ms`}`).join(' '),
  )

  // 只试最快的三个，试太多会把失败拖得很久；全不通时退回默认源再赌一次
  const usable = probed.filter((p) => p.ms !== Infinity).slice(0, 3)
  const candidates = usable.length ? usable : [{ name: '默认', url: '' }]

  let lastOut = ''
  for (const idx of candidates) {
    const args = [
      '-m', 'pip', 'install', '-q',
      '--disable-pip-version-check',
      // 默认超时 15s × 重试 5 次，遇到慢源一个包能卡几分钟。收紧好让失败快点暴露、好换源
      '--timeout', '30', '--retries', '2',
    ]
    if (idx.url) args.push('-i', idx.url)
    args.push(...PIP_PACKAGES)

    const pip = await run(vpy, args, { cwd: SERVICE_DIR, timeout: 180000 })
    if (pip.ok) {
      log.mark(`[xhh-TL][部署] 依赖已用 ${idx.name} 装好`)
      break
    }
    lastOut = pip.out
    log.error(`[xhh-TL][部署] ${idx.name} 装依赖失败:`, pip.out.slice(0, 300))
  }

  // 装完再验一遍：pip 说成功不等于能用
  const stillMissing = await missingDeps(vpy)
  if (!stillMissing.length) return { ok: true }

  const lines = [`依赖没装全，缺：${stillMissing.map((d) => d.pkg).join('、')}`]

  // 「网络到源不通」和「这个包根本装不了」要分开报 —— 都甩一句「检查网络」的话，
  // glibc 太低的用户会照着一直重试，怎么试都好不了
  if (stillMissing.some((d) => d.mod === 'bili_ticket_gt_python')) {
    const libc = await libcVersion(vpy)
    if (libcTooOld(libc) || isBuildFailure(lastOut)) {
      lines.push(
        '',
        `bili-ticket-gt-python 需要 glibc ${MIN_GLIBC.join('.')} 以上${libc ? `，当前系统是 ${libc}` : ''}`,
        '换 Debian 12 / Ubuntu 22.04 以上的系统，或用 docker 跑',
      )
      return { ok: false, msg: lines.join('\n') }
    }
  }

  const best = candidates[0]
  const req = path.join(SERVICE_DIR, 'requirements.txt')
  lines.push(
    '',
    '在机器人所在设备执行后，再发一次本指令：',
    `"${vpy}" -m pip install${best.url ? ` -i ${best.url}` : ''} -r "${req}"`,
  )
  return { ok: false, msg: lines.join('\n') }
}

/**
 * 本地服务文件是否落后于 solver 分支上的版本。
 *
 * 用 git 的 blob hash 比对，而不是读文件内容自己算摘要 —— 这样自动绕过换行符差异
 * （Windows 的 core.autocrlf 会让工作区是 CRLF、仓库里是 LF），也不会因为 BOM、
 * 编码不同之类的细节误判「需要重装」。
 *
 * 取不到 hash（没装 git / 不是 git 仓库 / 该分支上没有这个文件）就跳过，当作一致：
 * 宁可漏报一次更新，也不要误报让主人白重装一遍。
 */
async function serviceFilesOutdated(ref) {
  if (!ref) return false
  for (const file of SERVICE_FILES) {
    const disk = path.join(SERVICE_DIR, file)
    try {
      if (!fs.existsSync(disk)) return true
    } catch (_) {
      return true
    }
    const want = await run('git', ['rev-parse', `${ref}:service/geetest/${file}`], { cwd: pluginDir })
    if (!want.ok || !want.out.trim()) continue
    const got = await run('git', ['hash-object', disk], { cwd: pluginDir })
    if (!got.ok || !got.out.trim()) continue
    if (want.out.trim() !== got.out.trim()) return true
  }
  return false
}

/**
 * 从**本地已有的引用**里找一个可用的 solver，找不到返回空串。
 *
 * 状态检查用这个而不是 fetchSolver：看状态应该是快的、离线的，不该为了比版本去连远端
 * （远端不通时逐个 remote 试会卡很久）。代价是只能跟本地已有的引用比，但用户若连
 * 引用都是旧的，那本来就该先更新插件了。
 */
async function findLocalSolverRef() {
  const r = await run(
    'git',
    ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/*/solver', 'refs/heads/solver'],
    { cwd: pluginDir },
  )
  if (!r.ok) return ''
  for (const ref of r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    const t = await run('git', ['rev-parse', '--verify', `${ref}:service/geetest/server.py`], { cwd: pluginDir })
    if (t.ok && t.out.trim()) return ref
  }
  return ''
}

/** 逐个 remote 试 fetch solver，返回能用的那个 remote 名 */
async function fetchSolver() {
  // ★ 必须带 cwd：不带就跑到云崽根目录去了，那里的 remote 是宿主仓库的 origin，
  //   跟本插件没关系，会取不到 solver 分支
  const r = await run('git', ['remote'], { cwd: pluginDir })
  if (!r.ok) return { ok: false, msg: '取不到 git remote（这目录不是 git 仓库？）' }
  const remotes = r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  if (!remotes.length) return { ok: false, msg: '没有配置任何 git remote' }
  const tried = []
  for (const remote of remotes) {
    // ★ 显式写 refspec：用户多是 `git clone --depth=1`（浅克隆 + 单分支），
    //   这种仓库 `fetch <remote> solver` 只会写 FETCH_HEAD，**不会建出 <remote>/solver 引用**，
    //   后面按引用名检出就会失败。写上 refspec 才能把引用真正建出来。
    const refspec = `solver:refs/remotes/${remote}/solver`
    const f = await run('git', ['fetch', '--depth=1', remote, refspec], { cwd: pluginDir })
    if (f.ok) return { ok: true, remote }
    tried.push(remote)
  }
  return { ok: false, msg: `这些 remote 都取不到 solver 分支：${tried.join(', ')}` }
}

export class solverDeploy extends plugin {
  constructor() {
    super({
      name: '[小火花]过码服务部署',
      dsc: '一键部署米游社全自动过码服务',
      event: 'message',
      priority: 5000,
      rule: [
        {
          // # 必带：这条会真去拉服务、装依赖、起进程，不能让裸词在群里误触发
          reg: '^\\s*#(?:过码|验证码)(?:服务)?(?:部署|安装|一键部署)\\s*$',
          fnc: 'deploy',
          permission: 'master',
        },
        {
          reg: '^\\s*#(?:过码|验证码)服务(?:状态|查看)\\s*$',
          fnc: 'status',
          permission: 'master',
        },
      ],
    })
  }

  /** 前置检查：平台 + 系统依赖。返回缺失项数组 */
  async precheck() {
    const missing = []
    // Windows 上 python 命令名不同（通常没有 python3）
    const pyCmd = process.platform === 'win32' ? 'python' : 'python3'
    if (!(await has(pyCmd, ['--version']))) {
      missing.push({
        name: 'Python 3.9+',
        fix: process.platform === 'win32' ? '到 python.org 下载安装（勾选 Add to PATH）' : 'apt install -y python3 python3-venv',
      })
    }
    if (!(await has('pm2', ['--version']))) {
      missing.push({ name: 'pm2', fix: 'npm i -g pm2' })
    }
    return missing
  }

  async deploy(e) {
    // 首次要装 Python 依赖（慢），之后只是检查一下（快）
    const firstTime = !fs.existsSync(path.join(SERVICE_DIR, '.venv', 'bin', 'python'))
      && !fs.existsSync(path.join(SERVICE_DIR, '.venv', 'Scripts', 'python.exe'))
    await e.reply(
      firstTime ? '开始部署过码服务（首次要装依赖，可能要几分钟）~' : '检查过码服务中，稍等~',
      quoteEnabled(),
    )

    // ① 系统依赖
    const missing = await this.precheck()
    if (missing.length) {
      const lines = ['缺少这些依赖，请先在机器人所在设备执行：', '']
      for (const m of missing) lines.push(`· ${m.name}：${m.fix}`)
      lines.push('', '装完再发一次本指令')
      await e.reply(lines.join('\n'), quoteEnabled())
      return true
    }

    // ② 拉服务文件：缺文件要检出，文件旧了也要检出。
    //    只判「缺不缺」是不够的 —— solver 上只改了内容没加文件时，缺文件判据永远是假，
    //    服务就再也更新不到新版本了。
    const missingFiles = missingServiceFiles()
    let refreshed = false
    {
      const f = await fetchSolver()
      if (!f.ok) {
        // 拉不到远端时：文件齐就继续（可能只是没网），缺文件就只能到此为止
        if (missingFiles.length) {
          await e.reply(`拉取服务失败：${f.msg}`, quoteEnabled())
          return true
        }
      } else {
        const outdated = await serviceFilesOutdated(`${f.remote}/solver`)
        if (missingFiles.length || outdated) {
          log.mark(
            `[xhh-TL][部署] ${missingFiles.length ? `缺少 ${missingFiles.join(', ')}` : '服务文件有更新'}，从 solver 分支检出`,
          )
          // ★ 用 restore 而不是 checkout：`checkout <ref> -- service` 会把 service 写进暂存区，
          //   之后插件目录任何一次 commit 都会把服务代码带进 master（master 就是这么被污染的）。
          //   restore 只写工作区、不碰索引，service 才能老老实实待在 gitignore 里。
          //   先试引用名（fetch 已按 refspec 建出来），旧版 git 不支持 --source 就退回 checkout。
          let co = await run('git', ['restore', '--source', `${f.remote}/solver`, '--', 'service'], { cwd: pluginDir })
          if (!co.ok) {
            co = await run('git', ['checkout', `${f.remote}/solver`, '--', 'service'], { cwd: pluginDir })
            // checkout 会污染索引，立刻清掉，别让它跟着下次提交进 master
            if (co.ok) await run('git', ['reset', '-q', '--', 'service'], { cwd: pluginDir })
          }
          if (!co.ok || !fs.existsSync(path.join(SERVICE_DIR, 'server.py'))) {
            await e.reply('检出服务文件失败，请把插件目录更新到最新再试', quoteEnabled())
            return true
          }
          refreshed = true
        }
      }
    }

    // ③ Python 依赖（装进服务目录的 venv，不动系统环境）
    const pyCmd = process.platform === 'win32' ? 'python' : 'python3'
    const py = venvPython()
    if (!py) {
      const v = await run(pyCmd, ['-m', 'venv', '.venv'], { cwd: SERVICE_DIR })
      if (!v.ok) {
        await e.reply('创建 Python 环境失败，请确认装了 python3-venv', quoteEnabled())
        return true
      }
    }
    // 依赖已在就跳过（pip install 要跑几十秒，没必要每次重来）
    const vpy = venvPython()
    if (!vpy) {
      await e.reply('创建 Python 环境失败，请确认装了 python3-venv', quoteEnabled())
      return true
    }
    const deps = await ensureDeps(vpy)
    if (!deps.ok) {
      await e.reply(deps.msg, quoteEnabled())
      return true
    }

    // ④ 起服务 / 重启服务。
    //
    // 服务代码是启动时读进内存的，光把文件换成新的不会生效 ——
    // 所以只要这次动过文件，就必须重启，否则就是「改了没反应」。
    //
    // 其余情况保持原样不动：重启会打断正在进行的过码。
    const running = await isServiceAlive()
    if (refreshed && running) {
      log.mark('[xhh-TL][部署] 服务文件有更新，重启服务使其生效')
      const rs = await run('pm2', ['restart', PM2_NAME, '--update-env'])
      if (!rs.ok) {
        log.error('[xhh-TL][部署] pm2 重启失败:', rs.out.slice(0, 300))
        await e.reply('重启服务失败，请发 #过码服务状态 看看', quoteEnabled())
        return true
      }
    } else if (!running) {
      await run('pm2', ['delete', PM2_NAME]) // 清掉残留的失败进程，避免端口占用
      const start = await run('pm2', ['start', vpy, '--name', PM2_NAME, '--', 'server.py'], {
        cwd: SERVICE_DIR,
      })
      if (!start.ok) {
        log.error('[xhh-TL][部署] pm2 启动失败:', start.out.slice(0, 300))
        await e.reply('启动服务失败，请检查 pm2 是否正常', quoteEnabled())
        return true
      }
    }

    // ⑤ 写回配置并持久化 pm2
    // ⚠️ 必须用 patchUserConfig（读-改-写），不能用 writeUserConfig —— 后者是整份覆盖，
    // 只传一个键会把用户 config.yaml 里其余几十项全洗掉（卡片样式、回复引用、
    // 多账号模式、鸣潮开关…全部静默回退默认值，用户毫无察觉）。
    try {
      patchUserConfig({ auto_verify_addr: `http://127.0.0.1:${PORT}/solve` })
    } catch (err) {
      log.error('[xhh-TL][部署] 写配置失败:', err?.message)
    }
    await run('pm2', ['save'])

    // ⑥ 验活
    await new Promise((r) => setTimeout(r, 8000))
    const alive = await isServiceAlive()

    if (alive && refreshed) {
      await e.reply('过码服务已更新到最新版，不用再管~', quoteEnabled())
    } else if (alive && running) {
      await e.reply('过码服务本来就在跑，配置已确认，不用再管~', quoteEnabled())
    } else if (alive) {
      await e.reply('过码服务装好了，撞码会自动处理，不用再管~', quoteEnabled())
    } else {
      await e.reply('服务已启动但没连上，请发 #过码服务状态 看看，或稍后再试', quoteEnabled())
    }
    return true
  }

  async status(e) {
    const lines = []
    // pm2 状态
    const r = await run('pm2', ['jlist'])
    let info = null
    try {
      const list = JSON.parse(r.out)
      info = list.find((p) => p.name === PM2_NAME)
    } catch (_) {}
    lines.push(info ? `服务进程：${info.pm2_env?.status || '未知'}` : '服务进程：未部署')

    // 健康检查
    let alive = false
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(5000) })
      alive = res.ok
    } catch (_) {}
    lines.push(`端口 ${PORT}：${alive ? '正常' : '连不上'}`)

    // 文件完整性 —— 进程活着不代表文件还在（切分支会把服务文件删掉，
    // 而服务早已把代码读进内存，端口照开、health 照绿，只有发过码才炸）
    const missing = serviceDirExists() ? missingServiceFiles() : []
    if (missing.length) {
      lines.push(`服务文件：缺 ${missing.join('、')}`)
    } else if (serviceDirExists()) {
      lines.push('服务文件：完整')
    }

    lines.push(`插件配置：${config().auto_verify_addr ? '已指向本机服务' : '未启用自动过码'}`)

    // 文件残废优先报：这种情况服务看着是活的，但一发过码就全轮失败
    if (missing.length) {
      lines.push('', '发 #过码部署 可以修好')
    } else if (!alive && !info) {
      lines.push('', '发 #过码部署 可以一键装好')
    } else if (!alive) {
      lines.push('', '发 #过码部署 重新装一次')
    } else {
      // 服务在跑、文件也全，再看要不要更新到 solver 上的新版本
      const ref = await findLocalSolverRef()
      if (ref && (await serviceFilesOutdated(ref))) {
        lines.push('', '发 #过码部署 可以更新到新版本')
      }
    }

    await e.reply(lines.join('\n'), quoteEnabled())
    return true
  }
}

export { SERVICE_DIR, PM2_NAME, PORT }
