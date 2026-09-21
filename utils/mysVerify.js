/**
 * 米游社「手动过码」——内置版（等价于 GT-Manual 的过码流程，装了本插件即可删掉 GT-Manual）
 *
 * 原理（与 GT-Manual 完全一致，只是搬进本插件）：
 *   1) createVerification：向 bbs-api.miyoushe.com 申请一次极验，拿到 { gt, challenge }
 *   2) 把 { gt, challenge, uid } POST 给「外部打码服务」(verifyAddr)，它返回一个网页链接
 *   3) 机器人把链接 @ 发给用户，用户在手机上手划滑块
 *   4) 轮询该服务，拿到 validate（geetest_challenge/validate/seccode）
 *   5) verifyVerification：把 validate 交回米游社，清掉该「设备」的风险分
 *   6) 之后用「同一 device_id」重试签到即可放行
 *
 * ⚠️ 重要事实（如实告知，不藏）：
 *   - 真正解验证码的是「外部打码服务」verifyAddr，本插件不含解题能力。
 *     它默认沿用 GT-Manual 那个公益地址；该服务若下线/限流，过码就失效——
 *     这跟代码在谁家无关，是外部依赖。
 *   - 过码会把账号的 uid + gt + challenge 发给该第三方服务（不含 cookie）。
 *   - device_id 必须与签到时一致，否则清了风险也白清。本模块与 signClient
 *     都用 LiteMysApi 的确定性 deviceId(uid)，天然一致。
 */

import md5 from 'md5'
import fetch from 'node-fetch'
import LiteMysApi, { getServer } from './mysClient.js'
import { quoteEnabled } from './replyHelper.js'

const log = {
  mark: (...a) => (typeof logger !== 'undefined' ? logger.mark(...a) : console.log(...a)),
  error: (...a) => (typeof logger !== 'undefined' ? logger.error(...a) : console.error(...a)),
  debug: (...a) => (typeof logger !== 'undefined' ? logger.debug?.(...a) : null),
}

const VERIFY_HOST = 'https://bbs-api.miyoushe.com/'
// bbs 通用 DS 盐（4x，与 GT-Manual getDs 同款）
const BBS_SALT = 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs'
// 星铁/绝区零 createVerification 需要的 challenge_game
const CHALLENGE_GAME = { sr: '6', zzz: '8' }

function getBbsDs(q = '', b = '') {
  const t = Math.round(Date.now() / 1000)
  const r = Math.floor(Math.random() * 900000 + 100000)
  const DS = md5(`salt=${BBS_SALT}&t=${t}&r=${r}&b=${b}&q=${q}`)
  return `${t},${r},${DS}`
}

/** bbs 验证接口 headers（client_type=5 / app_version=2.40.1，device_id 稳定，带真 fp） */
function buildBbsHeaders(cookie, device, deviceFp, game, query = '', body = '') {
  const headers = {
    Cookie: cookie,
    'x-rpc-device_id': String(device),
    'x-rpc-app_version': '2.40.1',
    'x-rpc-client_type': '5',
    'x-rpc-device_fp': deviceFp || '38d7ee834d1e9',
    'User-Agent': `Mozilla/5.0 (Linux; Android 12; ${device}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.73 Mobile Safari/537.36 miHoYoBBS/2.40.1`,
    'X-Requested-With': 'com.mihoyo.hyperion',
    Origin: 'https://webstatic.mihoyo.com',
    Referer: 'https://webstatic.mihoyo.com',
    DS: getBbsDs(query, body),
  }
  const cg = CHALLENGE_GAME[game]
  if (cg) headers['x-rpc-challenge_game'] = cg
  return headers
}

/** 申请一次极验，返回 { gt, challenge, ... } */
async function createVerification(cookie, device, deviceFp, game) {
  const query = 'gids=2&is_high=false'
  const url = `${VERIFY_HOST}misc/wapi/createVerification?${query}`
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: buildBbsHeaders(cookie, device, deviceFp, game, query, ''),
      signal: AbortSignal.timeout(12000),
    }).then((r) => r.json())
    if (res?.retcode !== 0 || !res?.data?.challenge) {
      log.debug(`[xhh-TL][verify] createVerification 失败: retcode=${res?.retcode} msg=${res?.message}`)
      return null
    }
    return res.data
  } catch (err) {
    log.error(`[xhh-TL][verify] createVerification 异常: ${err?.message}`)
    return null
  }
}

/** 把 validate 交回米游社，清风险；成功返回 true
 * validate 为打码服务返回的原始对象，对齐 GT-Manual：整体作为 body 透传，
 * 只在缺失标准字段时用别名补齐，避免因字段名不同组装成 undefined。 */
async function submitVerification(cookie, device, deviceFp, game, validate) {
  const payload = {
    geetest_challenge:
      validate.geetest_challenge || validate.challenge || '',
    geetest_validate: validate.geetest_validate || validate.validate || '',
    geetest_seccode:
      validate.geetest_seccode ||
      validate.seccode ||
      `${validate.geetest_validate || validate.validate || ''}|jordan`,
  }
  const body = JSON.stringify(payload)
  const url = `${VERIFY_HOST}misc/wapi/verifyVerfication`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...buildBbsHeaders(cookie, device, deviceFp, game, '', body),
        'Content-Type': 'application/json;charset=UTF-8',
      },
      body,
      signal: AbortSignal.timeout(12000),
    }).then((r) => r.json())
    log.mark(
      `[xhh-TL][verify] verifyVerification 回执: retcode=${res?.retcode} msg=${res?.message}`,
    )
    if (res?.retcode !== 0) {
      log.mark(`[xhh-TL][verify] 提交的 validate 字段: ${Object.keys(payload).filter((k) => payload[k]).join(',') || '空'}`)
      return false
    }
    return true
  } catch (err) {
    log.error(`[xhh-TL][verify] verifyVerification 异常: ${err?.message}`)
    return false
  }
}

/**
 * 交给外部打码服务，@用户手划，轮询拿 validate。
 * @returns {Promise<object|false>} { geetest_challenge, geetest_validate, geetest_seccode }
 */
async function solveGeetest(e, { uid, create, verifyAddr, polls = 80, intervalMs = 1500 }) {
  const gt = create?.gt
  const challenge = create?.challenge
  if (!gt || !challenge || !verifyAddr || !e?.reply) return false
  let reg
  try {
    // 对齐 GT-Manual：把 createVerification 的完整字段(gt/challenge/new_captcha…)+uid
    // 全部透传给打码服务，服务才能正确锁定「这次」的 challenge。只发 gt/challenge/uid
    // 会导致服务回一个不匹配/旧的 validate，米游社回交时报「拼图已过期」。
    reg = await fetch(verifyAddr, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, ...create }),
      signal: AbortSignal.timeout(12000),
    }).then((r) => r.json())
  } catch (err) {
    log.error(`[xhh-TL][verify] 打码服务不可用: ${err?.message}`)
    return false
  }
  if (!reg?.data?.link || !reg?.data?.result) {
    log.debug('[xhh-TL][verify] 打码服务未返回链接')
    return false
  }

  try {
    await e.reply(`需要验证，请在 2 分钟内点开链接划过：\n${reg.data.link}`, quoteEnabled(), { recallMsg: 120 })
  } catch (_) {}

  let loggedShape = false
  for (let i = 0; i < polls; i++) {
    try {
      const r = await fetch(reg.data.result, { signal: AbortSignal.timeout(10000) }).then((x) => x.json())
      // 结果可能包在 data 里，也可能直接在顶层；两处都找
      const d = r?.data && typeof r.data === 'object' ? r.data : r
      const validate = d?.geetest_validate || d?.validate
      // 首次拿到非空响应时打一次结构，便于定位字段名
      if (!loggedShape && d && Object.keys(d).length) {
        loggedShape = true
        log.mark(`[xhh-TL][verify] 轮询结果字段: ${Object.keys(d).join(',')}`)
      }
      if (validate) {
        log.mark(`[xhh-TL][verify] 已拿到 validate，提交清风险 uid=${uid}`)
        return {
          geetest_challenge: d.geetest_challenge || d.challenge || challenge,
          geetest_validate: validate,
          geetest_seccode: d.geetest_seccode || d.seccode || `${validate}|jordan`,
        }
      }
    } catch (err) {
      if (!loggedShape) log.debug(`[xhh-TL][verify] 轮询异常: ${err?.message}`)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  log.mark(`[xhh-TL][verify] 轮询 ${polls} 次未拿到 validate（用户可能未及时划或服务未回写）`)
  return false
}

/**
 * 本地自动过码服务：POST {cookie} → 服务自己跑「申请→解滑块→回交」全流程。
 * 配了 autoVerifyAddr 时优先走它，无需用户手划。
 * @returns {Promise<boolean>} 是否过码成功
 */
export async function solveByLocalService({ cookie, autoVerifyAddr }) {
  try {
    const res = await fetch(autoVerifyAddr, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie }),
      signal: AbortSignal.timeout(360000),
    }).then((r) => r.json())
    if (res?.data?.result === 'ok') {
      log.mark(`[xhh-TL][verify] 本地服务自动过码成功（第 ${res.data.round} 轮）`)
      return true
    }
    log.mark(`[xhh-TL][verify] 本地服务未过码: ${JSON.stringify(res).slice(0, 120)}`)
    return false
  } catch (err) {
    log.error(`[xhh-TL][verify] 本地服务不可用: ${err?.message}`)
    return false
  }
}

/**
 * 批量自动过码：一次把所有账号的 cookie 提交给服务，服务端并发跑。
 * 多账号时总耗时≈最慢那个号，而不是逐个相加（服务端按 display 池大小并发）。
 * @param {string[]} cookies 各账号的完整 cookie
 * @param {string} autoVerifyAddr
 * @returns {Promise<boolean[]>} 与 cookies 等长的结果数组
 */
export async function solveBatchByLocalService(cookies, autoVerifyAddr) {
  const n = cookies.length
  if (!autoVerifyAddr || !n) return new Array(n).fill(false)
  try {
    const res = await fetch(autoVerifyAddr, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies }),
      signal: AbortSignal.timeout(600000),
    }).then((r) => r.json())
    const results = res?.data?.results
    if (!Array.isArray(results)) {
      log.mark(`[xhh-TL][verify] 批量过码返回异常: ${JSON.stringify(res).slice(0, 120)}`)
      return new Array(n).fill(false)
    }
    const okCount = results.filter((r) => r?.ok).length
    log.mark(`[xhh-TL][verify] 批量自动过码完成：${okCount}/${n} 成功`)
    return results.map((r) => !!r?.ok)
  } catch (err) {
    log.error(`[xhh-TL][verify] 批量过码服务不可用: ${err?.message}`)
    return new Array(n).fill(false)
  }
}

/**
 * 完整过码流程：申请极验 → 用户手划 → 回交清风险。
 * device/deviceFp 由调用方从 LiteMysApi 取好后传入，保证与签到重试同设备。
 * @param {object} opts.autoVerifyAddr 本地自动过码服务地址；配了就走全自动，失败再回退手动
 * @returns {Promise<boolean>} 是否清风险成功（成功后可重试签到）
 */
export async function runBbsVerify(e, { uid, cookie, game = 'gs', device, deviceFp, verifyAddr, autoVerifyAddr }) {
  // 全自动优先：本地服务自己完成申请→解滑块→回交，不需要用户参与
  if (autoVerifyAddr) {
    if (await solveByLocalService({ cookie, autoVerifyAddr })) return true
    log.mark('[xhh-TL][verify] 自动过码未成功，回退到手动链接')
  }

  // 手动流程要能 reply 才有意义（定时任务 e 为空，别白申请一次极验）
  if (!e?.reply) {
    log.debug('[xhh-TL][verify] 无实时事件，跳过手动过码')
    return false
  }

  if (!verifyAddr) {
    log.debug('[xhh-TL][verify] 未配置打码服务地址，跳过')
    return false
  }
  if (!device) {
    try {
      device = new LiteMysApi(uid, cookie, { game, log: false }).device
    } catch (_) {
      device = `Yz-${md5(String(uid)).substring(0, 5)}`
    }
  }

  const create = await createVerification(cookie, device, deviceFp, game)
  if (!create) return false

  const validate = await solveGeetest(e, {
    uid,
    create,
    verifyAddr,
  })
  if (!validate) return false

  const ok = await submitVerification(cookie, device, deviceFp, game, validate)
  if (ok) log.mark(`[xhh-TL][verify] 过码成功 uid=${uid} game=${game}`)
  return ok
}

export { getServer }
export default { runBbsVerify }
