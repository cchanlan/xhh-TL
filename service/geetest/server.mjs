/**
 * 米游社全自动过码服务
 *
 * 输入 {gt, challenge}，输出 {validate, challenge}，供 Yunzai 插件的
 * auto_sign_verify_addr 调用（协议对齐 GT-Manual 的 register 接口）。
 *
 * 实测跑通的关键（每一步都不能少）：
 *   1) 极验 JS 用官方 gt.0.4.9.js，调 inst.verify() 才会从「智能检测」推进到滑块
 *   2) fullbg canvas 默认 display:none，必须强制显示后才能抓到完整的无缺口底图
 *   3) 缺口靠 bg vs fullbg 差分（比模板匹配稳），OpenCV 取最大轮廓
 *   4) **必须断开 CDP** —— attach 期间极验判 bot，ajax 回 forbidden
 *   5) 拖动用 xdotool 系统级指针（CDP 注入的鼠标事件会被识别）
 *   6) **必须有窗口管理器**（openbox）—— 否则 X 窗口不映射，事件送不到
 *   7) 回交要用极验返回的新 challenge（带 lk/5r 后缀），不是最初申请的
 *   8) **verify() 要反复调**，且判据不能只看 canvas 存在 —— 元素早已存在但内容空白时
 *      抓到的是 2KB 空图，要按 PNG 体积判定渲染完成
 *   9) 等待一律用条件轮询，不要写死 sleep —— 单轮 23.5s → 9s 全靠这一条
 *
 * 单轮成功率约 30%（对面风控收紧过），靠多轮重试兜到 100%。
 */

import fs from 'fs'
import path from 'path'
import { execFileSync, spawn } from 'child_process'
import { fileURLToPath } from 'url'
import http from 'http'
import os from 'os'
import md5 from 'md5'
import fetch from 'node-fetch'

const DIR = path.dirname(fileURLToPath(import.meta.url))
// 默认 :77 —— 服务自己的 Xvfb；:99 被 Napcat 占满（Maximum number of clients reached）
// 显示环境池：xdotool 的指针是 per-display 的，一个屏同一时刻只能拖一个滑块，
// 所以并发过码必须各占一个 display。由 start.sh 通过 GT_DISPLAYS 注入（如 ":77,:78,:79"）。
const DISPLAYS = (process.env.GT_DISPLAYS || process.env.GT_DISPLAY || ':77')
  .split(',')
  .map((d) => d.trim())
  .filter(Boolean)

/** 简单的 display 占用池：取不到就排队等（避免两个任务抢同一个屏的指针） */
const freeDisplays = [...DISPLAYS]
const displayWaiters = []
function acquireDisplay() {
  if (freeDisplays.length) return Promise.resolve(freeDisplays.shift())
  return new Promise((resolve) => displayWaiters.push(resolve))
}
function releaseDisplay(d) {
  const next = displayWaiters.shift()
  if (next) next(d)
  else freeDisplays.push(d)
}
// Python 解释器：优先环境变量，其次本目录下的 .venv（见 README 的部署步骤）
const PYTHON = process.env.GT_PYTHON
  || [
    path.join(DIR, '.venv', 'bin', 'python'),          // Linux / macOS
    path.join(DIR, '.venv', 'Scripts', 'python.exe'),  // Windows（本服务实际只支持 Linux）
  ].find((p) => fs.existsSync(p))
  || 'python3'
// chromium 路径各发行版不同，按常见位置探测（也认 chrome）
const CHROMIUM =
  process.env.GT_CHROMIUM ||
  [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
  ].find((p) => {
    try {
      return fs.existsSync(p)
    } catch (_) {
      return false
    }
  }) ||
  'chromium'
const PORT = Number(process.env.GT_PORT || 8766)
const MAX_ROUNDS = Number(process.env.GT_MAX_ROUNDS || 8)

/**
 * 找 puppeteer。三种部署方式都要能用：
 *   1. 装进 xhh-TL 插件里 → 往上找到 Yunzai 根的 node_modules
 *   2. 独立安装（本目录有 node_modules，用 puppeteer-core + 系统 chromium）
 *   3. 环境变量显式指定
 * puppeteer-core 不下载浏览器，配合系统 chromium 用，独立部署体积小很多。
 */
function resolvePuppeteer() {
  if (process.env.GT_PUPPETEER) return process.env.GT_PUPPETEER
  const candidates = [
    // 独立安装：本目录的 node_modules
    path.join(DIR, 'node_modules', 'puppeteer-core', 'lib', 'esm', 'puppeteer', 'puppeteer-core.js'),
    path.join(DIR, 'node_modules', 'puppeteer', 'lib', 'esm', 'puppeteer', 'puppeteer.js'),
  ]
  // 装进插件里：往上找 Yunzai 根的 node_modules
  let up = DIR
  for (let i = 0; i < 5; i++) {
    up = path.dirname(up)
    candidates.push(path.join(up, 'node_modules', 'puppeteer', 'lib', 'esm', 'puppeteer', 'puppeteer.js'))
    candidates.push(path.join(up, 'node_modules', 'puppeteer-core', 'lib', 'esm', 'puppeteer', 'puppeteer-core.js'))
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch (_) {}
  }
  return ''
}

const PUPPETEER_PATH = resolvePuppeteer()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a)

const GT_JS = fs.readFileSync(path.join(DIR, 'gt.js'), 'utf-8')
const GAP_PY = path.join(DIR, 'gap.py')

/** 米游社 bbs 通用 DS */
function getDs(query = '', body = '') {
  const SALT = 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs'
  const t = Math.round(Date.now() / 1000)
  const r = Math.floor(Math.random() * 900000 + 100000)
  return `${t},${r},${md5(`salt=${SALT}&t=${t}&r=${r}&b=${body}&q=${query}`)}`
}

/** 用调用方给的 cookie 打米游社接口（过码用的 device 由调用方保证一致） */
function bbsHeaders(cookie) {
  return {
    Cookie: cookie,
    'x-rpc-app_version': '2.40.1',
    'x-rpc-client_type': '5',
    'x-rpc-device_id': 'Yz-probe123',
    'x-rpc-device_fp': '38d7ee834d1e9',
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 12; Mi 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.73 Mobile Safari/537.36 miHoYoBBS/2.40.1',
    'X-Requested-With': 'com.mihoyo.hyperion',
    Origin: 'https://webstatic.mihoyo.com',
    Referer: 'https://webstatic.mihoyo.com',
  }
}

/** 算一次缺口：启 Python 子进程，读它写出的 gap.txt */
async function computeGap(workDir) {
  const gapFile = path.join(workDir, 'gt_gap.txt')
  fs.rmSync(gapFile, { force: true })
  const p = spawn(PYTHON, [GAP_PY, workDir], { detached: true, stdio: 'ignore' })
  p.unref()
  for (let i = 0; i < 40; i++) {
    await sleep(1000)
    if (fs.existsSync(gapFile)) {
      const v = parseInt(fs.readFileSync(gapFile, 'utf-8'), 10)
      if (Number.isFinite(v) && v > 0) return v
      return 0
    }
  }
  return 0
}

/** 轮询直到条件成立，返回实际耗时 ms；超时返回 null */
async function waitFor(fn, { timeout = 20000, interval = 250 } = {}) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try {
      if (await fn()) return Date.now() - t0
    } catch (_) {}
    await sleep(interval)
  }
  return null
}

/**
 * 抓一次三图，返回 { ok, imgs }。
 *
 * ⚠️ 判据不能只看 canvas 元素是否存在 —— 元素早就存在了，但内容还没渲染时
 * 抓到的是**空白图**（PNG 只有约 2KB，正常 bg 有 100KB+）。实测踩过：
 * 只看元素存在就抓，三张图全是 2118 字节的空图，下游算缺口直接失败。
 * 所以按 PNG 体积判定是否真的渲染完。
 *
 * fullbg 默认 display:none，这里顺手强制显示（抄 bg 的尺寸）。
 */
async function probeImages(page) {
  return await page
    .evaluate(() => {
      const fb = document.querySelector('canvas.geetest_canvas_fullbg')
      const bg = document.querySelector('canvas.geetest_canvas_bg')
      if (fb && bg) {
        fb.style.display = 'block'
        fb.style.opacity = '1'
        fb.style.width = bg.style.width
        fb.style.height = bg.style.height
      }
      const get = (sel) => {
        const c = document.querySelector(sel)
        try {
          return c ? c.toDataURL('image/png') : null
        } catch (_) {
          return null
        }
      }
      const imgs = {
        bg: get('canvas.geetest_canvas_bg'),
        fullbg: get('canvas.geetest_canvas_fullbg'),
        slice: get('canvas.geetest_canvas_slice'),
      }
      const ok =
        imgs.bg && imgs.fullbg && imgs.slice &&
        imgs.bg.length > 20000 && imgs.fullbg.length > 20000 && imgs.slice.length > 2000
      return { ok, imgs }
    })
    .catch(() => ({ ok: false, imgs: {} }))
}

/**
 * 跑一轮完整过码。
 * @returns {Promise<{validate:string, challenge:string}|null>}
 */
async function oneRound(cookie, puppeteer, round, myDisplay) {
  // 本次任务独占一个临时目录：并发时中间图/结果文件不能共用，否则互相覆盖
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-'))
  // ① 申请极验（用调用方的 cookie，保证与后续回交同一账号）
  const q = 'gids=2&is_high=false'
  const g = await fetch(
    `https://bbs-api.miyoushe.com/misc/wapi/createVerification?${q}`,
    { headers: { ...bbsHeaders(cookie), DS: getDs(q) } },
  ).then((r) => r.json())
  if (g.retcode !== 0) {
    log(`  [轮${round}] 申请极验失败:`, JSON.stringify(g).slice(0, 100))
    return null
  }
  const { gt, challenge } = g.data

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: CHROMIUM,
    // ★ 必须把本次占用的 display 传给浏览器进程（env 覆盖），
    //   否则并发时只有服务进程自己的 DISPLAY（:77）可用，:78/:79 的任务
    //   会报 "Missing X server to start the headful browser"
    env: { ...process.env, DISPLAY: myDisplay },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-position=0,0',
      '--window-size=1000,700',
    ],
    defaultViewport: { width: 1000, height: 700 },
  })
  try {
    const page = await browser.newPage()
    await page
      .goto('https://www.miyoushe.com/ys/', { waitUntil: 'domcontentloaded', timeout: 40000 })
      .catch(() => {})
    await page.evaluate(() => {
      document.body.innerHTML = '<div id="gt"></div>'
    })
    await page.evaluate((c) => {
      const s = document.createElement('script')
      s.textContent = c
      document.head.appendChild(s)
    }, GT_JS)
    await page.evaluate(
      (gtv, chv) => {
        window.__V__ = null
        window.initGeetest(
          {
            width: '100%',
            lang: 'zh-cn',
            gt: gtv,
            api_server: 'apiv6.geetest.com',
            challenge: chv,
            new_captcha: true,
            product: 'bind',
            offline: false,
            onSuccess: () => {
              window.__V__ = window.__I__?.getValidate()
            },
            onError: () => {},
          },
          (i) => {
            window.__I__ = i
          },
        )
      },
      gt,
      challenge,
    )
    // ② 推进到滑块题 + 等三图真渲染完
    //
    // 原先这里是 sleep(5000) → verify() → sleep(6000)，单轮白等 11 秒。
    // 实测（网络时间线）：initGeetest 后到 ajax.php 之间有 **4.4 秒零请求**，
    // 那是极验的本地人机检测，不是网络等待 —— 所以不能简单删掉 sleep，
    // 而是改成「反复调 verify() + 探图」：探测到图真的渲染好就立刻往下走。
    //
    // ⚠️ verify() 必须**反复调**：只调一次会卡在「智能验证检测中」，
    //    三张图永远抓不到（实测三图全空）。多调几次就能推进到滑块题。
    let grabbed = null
    for (let i = 0; i < 60; i++) {
      const hasInst = await page.evaluate(() => !!window.__I__).catch(() => false)
      if (hasInst) {
        await page.evaluate(() => {
          try {
            window.__I__.verify()
          } catch (_) {}
        }).catch(() => {})
      }
      await sleep(250)
      const r = await probeImages(page)
      if (r.ok) {
        grabbed = r.imgs
        break
      }
    }
    if (!grabbed) {
      log(`  [轮${round}] 滑块组件未就绪（超时）`)
      return null
    }

    // ③ 落盘三图
    for (const [k, v] of Object.entries(grabbed)) {
      if (v) fs.writeFileSync(path.join(workDir, `${k}.png`), Buffer.from(v.split(',')[1], 'base64'))
    }

    // ④ 校准屏幕偏移（点一个已知页面坐标，读回真实落点）
    const run0 = (args) => execFileSync('xdotool', args, { env: { ...process.env, DISPLAY: myDisplay }, timeout: 15000 })
    await page.evaluate(() => {
      window.__CAL__ = []
      document.addEventListener('mousemove', (e) =>
        window.__CAL__.push([e.clientX, e.clientY]),
      )
    })
    run0(['mousemove', '900', '900', 'sleep', '0.15', 'mousemove', '200', '200', 'sleep', '0.25'])
    await sleep(500)
    const cal = await page.evaluate(() => window.__CAL__.slice(-1)[0])
    const offX = cal ? 200 - cal[0] : 0
    const offY = cal ? 200 - cal[1] : 0

    const geo = await page.evaluate(() => {
      const b = document.querySelector('.geetest_slider_button')
      const r = b.getBoundingClientRect()
      return { bx: r.x + r.width / 2, by: r.y + r.height / 2 }
    })

    const dist = await computeGap(workDir)
    if (!dist) {
      log(`  [轮${round}] 缺口计算失败`)
      return null
    }

    // ⑤ 断开 CDP，用系统级指针拖动
    try {
      browser.disconnect()
    } catch (_) {}
    const run = (args) => execFileSync('xdotool', args, { env: { ...process.env, DISPLAY: myDisplay }, timeout: 20000 })
    const sx = Math.round(geo.bx + offX)
    const sy = Math.round(geo.by + offY)
    // 先 hover 到滑块（分开调用，确保每次都有真实事件派发）
    run(['mousemove', String(sx - 30), String(sy), 'sleep', '0.12'])
    run(['mousemove', String(sx), String(sy), 'sleep', '0.30'])
    await sleep(150)
    run(['mousedown', '1'])
    await sleep(150)
    const N = 40
    for (let i = 1; i <= N; i++) {
      const p = i / N
      const ease = p < 0.7 ? 1.4 * p * p : 1 - (Math.pow(-2 * p + 2, 2) / 2) * 0.85
      const x = Math.round(sx + dist * Math.min(ease, 1))
      const y = Math.round(sy + (Math.random() - 0.5) * 2)
      run(['mousemove', String(x), String(y), 'sleep', (0.008 + Math.random() * 0.016).toFixed(3)])
    }
    await sleep(150)
    run(['mousemove', String(Math.round(sx + dist)), String(sy), 'sleep', '0.1'])
    run(['mouseup', '1'])

    // ⑥ 重连轮询取结果
    //
    // 原先是 sleep(6000) 死等。实测拖动后结果**平均 1.7 秒**就回来了，
    // 改成轮询：拿到 validate 或页面报错就立刻返回，不用等满 6 秒。
    const b2 = await puppeteer.connect({
      browserWSEndpoint: browser.wsEndpoint(),
      defaultViewport: null,
    })
    const pages = await b2.pages()
    const p2 = pages.find((p) => p.url().includes('miyoushe')) || pages[0]
    let st = {}
    await waitFor(
      async () => {
        st = await p2.evaluate(() => ({
          v: window.__V__ || window.__I__?.getValidate?.(),
          // 极验失败时会弹出错误面板，不必再等
          err: document.querySelector('.geetest_panel_error')?.style?.display === 'block',
        })).catch(() => ({}))
        return !!(st.v?.geetest_validate || st.err)
      },
      { timeout: 15000, interval: 200 },
    )
    await b2.close()

    if (!st.v?.geetest_validate) {
      log(`  [轮${round}] 未过（缺口=${dist}）`)
      return null
    }
    return {
      validate: st.v.geetest_validate,
      challenge: st.v.geetest_challenge || challenge,
      seccode: st.v.geetest_seccode || `${st.v.geetest_validate}|jordan`,
      dist,
    }
  } finally {
    try {
      await browser.close()
    } catch (_) {}
    try {
      fs.rmSync(workDir, { recursive: true, force: true })
    } catch (_) {}
  }
}

/** 对外：完整过码（含重试 + 回交） */
export async function solveAndVerify(cookie) {
  // 占一个显示环境（并发时各用各的屏，避免抢 xdotool 指针）
  const myDisplay = await acquireDisplay()
  try {
    return await solveAndVerifyOn(cookie, myDisplay)
  } finally {
    releaseDisplay(myDisplay)
  }
}

async function solveAndVerifyOn(cookie, myDisplay) {
  const puppeteer = (await import(PUPPETEER_PATH)).default
  for (let r = 1; r <= MAX_ROUNDS; r++) {
    try {
      const v = await oneRound(cookie, puppeteer, r, myDisplay)
      if (!v) continue
      // ⑦ 回交米游社
      const body = JSON.stringify({
        geetest_challenge: v.challenge,
        geetest_validate: v.validate,
        geetest_seccode: v.seccode,
      })
      const vr = await fetch(
        'https://bbs-api.miyoushe.com/misc/wapi/verifyVerfication',
        {
          method: 'POST',
          headers: {
            ...bbsHeaders(cookie),
            'Content-Type': 'application/json',
            DS: getDs('', body),
          },
          body,
        },
      ).then((r) => r.json())
      if (vr.retcode === 0) {
        log(`✅ 过码成功（第 ${r} 轮，缺口 ${v.dist}）`)
        return { ok: true, round: r, dist: v.dist }
      }
      log(`  [轮${r}] 回交失败:`, JSON.stringify(vr).slice(0, 100))
    } catch (err) {
      log(`  [轮${r}] 异常:`, err.message)
    }
    await sleep(1500)
  }
  return { ok: false }
}

// ---------- HTTP 服务 ----------
// 对齐 GT-Manual 的 register 协议：POST body 带 {gt, challenge, uid, cookie}
// 返回 { data: { validate, challenge } }
function readBody(req) {
  return new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => resolve(b))
  })
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
  if (req.method === 'GET' && req.url.startsWith('/health')) {
    return send(200, { ok: true })
  }
  if (req.method !== 'POST') return send(405, { error: 'POST only' })
  try {
    const raw = await readBody(req)
    const body = JSON.parse(raw || '{}')

    // 批量模式：{cookies:[...]} —— 服务端并发跑（受 display 池大小限制）。
    // 插件多账号过码走这条，总耗时≈最慢那个号，而不是逐个相加。
    if (Array.isArray(body.cookies)) {
      const list = body.cookies.filter(Boolean)
      if (!list.length) return send(400, { error: 'empty cookies' })
      log(`收到批量过码请求：${list.length} 个账号（并发）`)
      const results = await Promise.all(
        list.map(async (ck, i) => {
          try {
            const r = await solveAndVerify(ck)
            return r.ok ? { ok: true, round: r.round } : { ok: false }
          } catch (err) {
            log(`  第 ${i + 1} 个账号异常:`, err.message)
            return { ok: false }
          }
        }),
      )
      return send(200, { msg: '', data: { results } })
    }

    // 单个模式：{cookie}
    const cookie = body.cookie || ''
    if (!cookie) return send(400, { error: 'missing cookie' })
    log('收到过码请求')
    const r = await solveAndVerify(cookie)
    if (!r.ok) return send(500, { error: 'verify failed' })
    return send(200, { msg: '', data: { result: 'ok', round: r.round } })
  } catch (err) {
    log('请求异常:', err.message)
    return send(500, { error: err.message })
  }
})

// 启动自检：Python / cv2 / xdotool 缺一不可，缺了现在就说清楚，
// 别等用户过码时只看到「缺口计算失败」
function selfCheck() {
  const problems = []
  try {
    execFileSync(PYTHON, ['-c', 'import cv2, numpy'], { timeout: 15000, stdio: 'pipe' })
  } catch (err) {
    problems.push(
      `Python 环境不可用（${PYTHON}）：需要 cv2 与 numpy。` +
        `请在该目录执行 python3 -m venv .venv && .venv/bin/pip install opencv-python-headless numpy`,
    )
  }
  try {
    execFileSync('xdotool', ['-h'], { timeout: 5000, stdio: 'ignore' })
  } catch (_) {
    problems.push('未安装 xdotool（Debian / Ubuntu 执行 apt install xdotool）')
  }
  for (const d of DISPLAYS) {
    try {
      execFileSync('xdotool', ['getdisplaygeometry'], {
        timeout: 5000,
        stdio: 'ignore',
        env: { ...process.env, DISPLAY: d },
      })
    } catch (_) {
      problems.push(`显示环境 ${d} 不可用（需要 Xvfb + openbox 在跑）`)
    }
  }
  if (problems.length) {
    log('⚠️ 启动自检发现问题：')
    for (const p of problems) log('   - ' + p)
    log('   过码会失败，请先按上面的提示修好依赖')
  } else {
    log('启动自检通过（Python/cv2、xdotool、显示环境都正常）')
  }
}

server.listen(PORT, '127.0.0.1', () => {
  log(`米游社过码服务已启动 http://127.0.0.1:${PORT}`)
  log(`显示环境池：${DISPLAYS.join(', ')}`)
  selfCheck()
})
