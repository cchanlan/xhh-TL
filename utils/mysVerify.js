/**
 * 米游社过码 —— 全自动服务
 *
 * 撞码时把账号 cookie 交给过码服务（#过码部署 装在本机的那套，或公共/远程服务），
 * 服务自己完成「申请极验 → 解滑块 → 回交米游社」，全程不需要用户手划。
 *
 * ⚠️ game 必须一起送过去：星铁/绝区零申请极验要带 x-rpc-challenge_game（6 / 8），
 * 服务端拿不到游戏就会按原神走，zzz 的验证码清不掉。
 */

import fetch from 'node-fetch'

const log = {
  mark: (...a) => (typeof logger !== 'undefined' ? logger.mark(...a) : console.log(...a)),
  error: (...a) => (typeof logger !== 'undefined' ? logger.error(...a) : console.error(...a)),
}

/**
 * 本地自动过码服务：POST {cookie} → 服务自己跑「申请→解滑块→回交」全流程。
 *
 * @param {object} opts
 * @param {string} opts.cookie 完整 cookie（需含 cookie_token / account_id）
 * @param {string} opts.autoVerifyAddr 过码服务地址
 * @param {string|object} [opts.device] 撞码那次请求的设备（id 字符串或 { id, fp }）
 * @param {string} [opts.deviceFp] 设备指纹
 * @param {string} [opts.clientType] 客户端形态：2=App / 5=网页
 * @param {string} [opts.game] gs / sr / zzz
 * @param {object} [opts.challengeOut] 传对象进来时，会把米游社颁的 challenge 写进 .challenge ——
 *   POST 类接口（签到）必须拿它当 x-rpc-challenge 重发才放行，光清风险分不管用。
 * @returns {Promise<boolean>} 是否过码成功
 */
export async function solveByLocalService({
  cookie,
  autoVerifyAddr,
  device = null,
  deviceFp = '',
  clientType = '',
  game = '',
  challengeOut = null,
}) {
  try {
    // 把调用方的设备/客户端类型/游戏一起送过去：过码要跟调用方同一套身份，米游社才认
    const devId = typeof device === 'object' && device ? device.id : device
    const devFp = (typeof device === 'object' && device ? device.fp : '') || deviceFp || ''
    const payload = { cookie }
    if (devId) {
      payload.deviceId = String(devId)
      payload.deviceFp = String(devFp)
    }
    if (clientType) payload.clientType = String(clientType)
    if (game) payload.game = String(game)
    const res = await fetch(autoVerifyAddr, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(360000),
    }).then((r) => r.json())
    if (res?.data?.result === 'ok') {
      log.mark(`[xhh-TL][verify] 本地服务自动过码成功（第 ${res.data.round} 轮）`)
      if (challengeOut) challengeOut.challenge = res.data.challenge || ''
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
 * @param {string} [game] gs / sr / zzz
 * @returns {Promise<boolean[]>} 与 cookies 等长的结果数组
 */
export async function solveBatchByLocalService(cookies, autoVerifyAddr, game = '') {
  const n = cookies.length
  if (!autoVerifyAddr || !n) return new Array(n).fill(false)
  try {
    const payload = { cookies }
    if (game) payload.game = String(game)
    const res = await fetch(autoVerifyAddr, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
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

export default { solveByLocalService, solveBatchByLocalService }
