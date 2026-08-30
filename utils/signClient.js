/**
 * 米游社签到客户端（原神 / 星铁 / 绝区零）
 *
 * 关键点：不复用 TL.js 里那套「每次随机 device_id + 写死假 device_fp」的老 header，
 * 那是签到爱弹极验验证码(retcode 1034/5003/10035/10041)的根因。这里改走与官方
 * genshin / 早柚同源的做法：
 *   1) device_id 按 uid 稳定派生（复用 LiteMysApi 的 deviceId(uid)）
 *   2) 请求前先 getFp 拿「真」设备指纹并全程带上（复用 LiteMysApi 的 getFp 流程）
 *   3) 签到用专用 LK2 salt + x-rpc-signgame，Origin/Referer 指向 act.mihoyo.com
 *
 * 签到接口（GT-Manual / xiaoyao 同款，已核对）：
 *   info : GET  event/luna/info   act_id&region&uid&lang  —— 查询签到状态(is_sign/total_sign_day/first_bind)
 *   home : GET  event/luna/home   同上                     —— 取奖励列表(awards)
 *   sign : POST event/luna/sign   {act_id,region,uid,lang} —— 执行签到
 */

import md5 from 'md5'
import fetch from 'node-fetch'
import LiteMysApi, { getServer } from './mysClient.js'
import { runBbsVerify } from './mysVerify.js'

const log = {
  mark: (...a) => (typeof logger !== 'undefined' ? logger.mark(...a) : console.log(...a)),
  error: (...a) => (typeof logger !== 'undefined' ? logger.error(...a) : console.error(...a)),
  debug: (...a) => (typeof logger !== 'undefined' ? logger.debug?.(...a) : null),
}

// 三游戏签到活动 ID（与 TL.js / GT-Manual 一致）
const SIGN_ACT_ID = {
  gs: 'e202311201442471',
  sr: 'e202304121516551',
  zzz: 'e202406242138391',
}

// 签到接口 x-rpc-signgame（gs 传 hk4e；sr/zzz 各自 biz）
const SIGN_GAME = {
  gs: 'hk4e',
  sr: 'hkrpg',
  zzz: 'zzz',
}

const GAME_LABEL = { gs: '原神', sr: '星铁', zzz: '绝区零' }

const SIGN_HOST = 'https://api-takumi.mihoyo.com/'
// 签到专用 salt（LK2，@Womsxd）：event/luna/* 的 DS 用它，且不含 q/b
const SIGN_SALT = 'jEpJb9rRARU2rXDA9qYbZ3selxkuct9a'

function getSignDs() {
  const t = Math.round(Date.now() / 1000)
  let r = ''
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  for (let i = 0; i < 6; i++) r += chars[Math.floor(Math.random() * chars.length)]
  const DS = md5(`salt=${SIGN_SALT}&t=${t}&r=${r}`)
  return `${t},${r},${DS}`
}

/**
 * 组装签到请求 headers。cn 服；device_fp 传入真指纹，device_id 稳定派生。
 */
function buildSignHeaders(cookie, device, deviceFp, game) {
  const headers = {
    Cookie: cookie,
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 12; Mi 10 Build/SKQ1.211006.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0.4896.88 Mobile Safari/537.36 miHoYoBBS/2.73.1',
    'Content-Type': 'application/json;charset=UTF-8',
    'x-rpc-app_version': '2.73.1',
    'x-rpc-client_type': '5',
    'x-rpc-device_id': String(device),
    'x-rpc-device_fp': deviceFp || '38d7ee834d1e9',
    'x-rpc-platform': '4',
    'x-rpc-channel': 'miyousheluodi',
    Origin: 'https://act.mihoyo.com',
    Referer: 'https://webstatic.mihoyo.com/',
    DS: getSignDs(),
  }
  const sg = SIGN_GAME[game]
  if (sg) headers['x-rpc-signgame'] = sg
  return headers
}

// 撞验证码的判定：challenge 出现 或 风控码
function isCaptcha(res) {
  const rc = Number(res?.retcode)
  return !!(res?.data?.challenge || res?.data?.gt || [1034, 5003, 10035, 10041].includes(rc))
}

/**
 * 对单个 uid 执行签到。
 * @param {string} uid 游戏 uid
 * @param {string} cookie 完整 cookie（需含 cookie_token/account_id；resolveAuth 提供）
 * @param {'gs'|'sr'|'zzz'} game
 * @param {object} [opts]
 * @param {object} [opts.e] 实时事件；传入且配了 verifyAddr 时，撞码可当场过码重试
 * @param {string} [opts.verifyAddr] 外部打码服务地址；为空则撞码只回 captcha 不过码
 * @returns {Promise<{ code, msg, game, uid }>}
 *   code: 'ok' 签到成功 | 'already' 今日已签 | 'captcha' 触发验证码（未过/过码失败）|
 *         'expired' 登录失效 | 'first_bind' 需先手动签 | 'fail' 其他失败
 */
export async function signOne(uid, cookie, game = 'gs', opts = {}) {
  const { e = null, verifyAddr = '' } = opts
  const label = GAME_LABEL[game] || game
  const actId = SIGN_ACT_ID[game]
  if (!actId) return { code: 'fail', msg: `不支持的游戏: ${game}`, game, uid }
  if (!uid || !cookie) return { code: 'expired', msg: '缺少 uid 或 cookie', game, uid }

  const server = getServer(String(uid), game)

  // 复用 LiteMysApi 取「真」device_fp + 稳定 device_id（避开验证码的关键）
  let deviceFp = ''
  let device = ''
  try {
    const api = new LiteMysApi(uid, cookie, { game, server, log: false })
    device = api.device
    const fpRes = await api.getData('getFp', {
      seed_id: md5(String(uid) + Date.now()).slice(0, 16),
      Getfp: true,
    })
    deviceFp = fpRes?.data?.device_fp || ''
  } catch (err) {
    log.debug(`[xhh-TL][sign] getFp 失败 ${uid}: ${err?.message}`)
  }
  if (!device) device = `Yz-${md5(String(uid)).substring(0, 5)}`

  const infoUrl = `${SIGN_HOST}event/luna/info?act_id=${actId}&region=${server}&uid=${uid}&lang=zh-cn`
  const signUrl = `${SIGN_HOST}event/luna/sign`

  // 1) 先查状态：已签 / 首绑 / 失效 提前返回，减少无谓 sign 请求
  try {
    const infoRes = await fetch(infoUrl, {
      method: 'GET',
      headers: buildSignHeaders(cookie, device, deviceFp, game),
      signal: AbortSignal.timeout(12000),
    }).then((r) => r.json())

    if ([-100, -101, 10001, -10001].includes(Number(infoRes?.retcode))) {
      return { code: 'expired', msg: `${label} 登录已失效，请【#刷新ck】，仍不行则【#扫码登录】`, game, uid }
    }
    if (infoRes?.data?.first_bind) {
      return { code: 'first_bind', msg: `${label} 需先在米游社 App 手动签到一次`, game, uid }
    }
    if (infoRes?.data?.is_sign) {
      const day = infoRes.data.total_sign_day || 0
      return { code: 'already', msg: `${label} 已经签到过了，请勿重复签到（累计第 ${day} 天）`, game, uid }
    }
  } catch (err) {
    log.debug(`[xhh-TL][sign] info 失败 ${uid}: ${err?.message}`)
  }

  // 发一次签到 POST，归一成 { rc, res }
  const doSign = async () => {
    const body = JSON.stringify({ act_id: actId, region: server, uid: String(uid), lang: 'zh-cn' })
    const res = await fetch(signUrl, {
      method: 'POST',
      headers: buildSignHeaders(cookie, device, deviceFp, game),
      body,
      signal: AbortSignal.timeout(12000),
    }).then((r) => r.json())
    return { rc: Number(res?.retcode), res }
  }

  // 2) 执行签到（撞码且具备过码条件时，过码后重试一次）
  try {
    let { rc, res: signRes } = await doSign()

    // 撞码：手动场景(有 e) + 配了打码地址 → 当场过码再重试一次
    if (isCaptcha(signRes) && e && verifyAddr) {
      log.mark(`[xhh-TL][sign] uid=${uid} 撞验证码，尝试过码…`)
      const ok = await runBbsVerify(e, { uid, cookie, game, device, deviceFp, verifyAddr })
      if (ok) {
        ({ rc, res: signRes } = await doSign())
      }
    }

    // -5003：今日已签（部分区服签到成功也走这个码）
    if (rc === -5003) {
      return { code: 'already', msg: `${label} 已经签到过了，请勿重复签到`, game, uid }
    }
    if (isCaptcha(signRes)) {
      return { code: 'captcha', msg: `${label} 签到触发验证码`, game, uid }
    }
    if ([-100, -101, 10001, -10001].includes(rc)) {
      return { code: 'expired', msg: `${label} 登录已失效，请【#刷新ck】，仍不行则【#扫码登录】`, game, uid }
    }
    // -10002 未查询到游戏角色：此 cookie 名下没有该 UID（跨账号），上层会过滤掉
    if (rc === -10002) {
      return { code: 'no_role', msg: `${label} 该账号无此角色`, game, uid }
    }
    if (rc === 0) {
      return { code: 'ok', msg: `${label} 签到成功`, game, uid }
    }
    return { code: 'fail', msg: `${label} 签到失败：${signRes?.message || '未知错误'}(${rc})`, game, uid }
  } catch (err) {
    log.error(`[xhh-TL][sign] sign 请求异常 ${uid}: ${err?.message}`)
    return { code: 'fail', msg: `${label} 签到请求异常`, game, uid }
  }
}

export { SIGN_ACT_ID, SIGN_GAME, GAME_LABEL }
export default { signOne }
