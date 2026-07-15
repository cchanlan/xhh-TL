/**
 * Runtime 补丁：在无 genshin（或 Runtime.getMysInfo 不可用）时，
 * 让 miao-plugin 的 MysApi.init / getData 仍可工作。
 *
 * 有 genshin 时：不覆盖系统 getMysInfo，仅补全缺失方法。
 * 无 genshin 时：注入 getMysInfo / getUid / getMysApi + e.user。
 */

import crypto from 'crypto'
import md5 from 'md5'
import fetch from 'node-fetch'
import { createUser } from './userBind.js'
import LiteMysApi, { getServer, gameKey as resolveGame } from './mysClient.js'
import { getStokenCandidateFiles } from './pluginConfig.js'

const COOKIE_AUTH_APIS = new Set([
  'cookie',
  'detail',
  'dailyNote',
  'characterDetail',
  'role_combat',
  'hard_challenge',
  'hard_challenge_popularity',
  'avatarSkill',
  'compute',
  'character',
  'challengeStory',
  'challengeBoss',
  'challengePeak',
  'spiralAbyss',
  'avatarInfo',
  'index',
  'roleIndex',
])

function detectGame(e, optionGame) {
  if (optionGame) return resolveGame(optionGame, e)
  if (e?.isSr || e?.game === 'sr') return 'sr'
  if (e?.game === 'zzz') return 'zzz'
  const msg = String(e?.msg || e?.original_msg || '')
  if (/^\*/.test(msg) || /星铁|崩坏：星穹|星穹铁道/.test(msg)) return 'sr'
  return e?.game || 'gs'
}

function cookiePart(ck = '', key) {
  const m = String(ck).match(new RegExp(`(?:^|;\\s*)${key}=([^;]+)`))
  return m ? m[1] : ''
}

function makeAppDs() {
  const salt = 'rtvTthKxEyreVXQCnhluFgLXPOFKPHlA'
  const t = Math.floor(Date.now() / 1000)
  const r = Math.random().toString(36).slice(2, 8)
  const Ds = md5(`salt=${salt}&t=${t}&r=${r}`)
  return `${t},${r},${Ds}`
}

/**
 * 从 stoken 条目刷新 cookie_token / ltoken，得到可用 cookie
 */
async function stokenToCookie(entry) {
  if (!entry) return ''
  // 已有完整 cookie_token 的 ck 直接用
  if (entry.ck && /cookie_token/.test(entry.ck)) return entry.ck
  if (entry.cookie && /cookie_token/.test(entry.cookie)) return entry.cookie

  const stuid = entry.stuid || cookiePart(entry.ck_stoken || '', 'stuid') || cookiePart(entry.ck_stoken || '', 'ltuid')
  const stoken = entry.stoken || cookiePart(entry.ck_stoken || '', 'stoken')
  const mid = entry.mid || cookiePart(entry.ck_stoken || '', 'mid')
  if (!stuid || !stoken) {
    if (entry.ltoken && entry.cookie_token) {
      return `ltoken=${entry.ltoken};ltuid=${stuid || ''};cookie_token=${entry.cookie_token};account_id=${stuid || ''};`
    }
    return entry.ck || entry.ck_stoken || ''
  }

  const baseCk = mid
    ? `stuid=${stuid};stoken=${stoken};mid=${mid};`
    : `stuid=${stuid};stoken=${stoken};`

  try {
    const headers = {
      Cookie: baseCk,
      'User-Agent':
        'Mozilla/5.0 (Linux; Android 13; Mi 10 Build/UKQ1.230804.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/74.0.3729.186 Mobile Safari/537.36 miHoYoBBS/2.71.1',
      'x-rpc-app_version': '2.71.1',
      'x-rpc-client_type': '2',
      'x-rpc-sys_version': '13',
      'x-rpc-channel': 'miyousheluodi',
      'x-rpc-device_id': crypto.randomUUID(),
      DS: makeAppDs(),
    }
    const cookieRes = await fetch(
      `https://api-takumi.mihoyo.com/auth/api/getCookieAccountInfoBySToken?stoken=${encodeURIComponent(stoken)}&uid=${encodeURIComponent(stuid)}`,
      { method: 'GET', headers },
    ).then((r) => r.json())
    const ltokenRes = await fetch(
      'https://passport-api.mihoyo.com/account/auth/api/getLTokenBySToken',
      { method: 'GET', headers: { ...headers, DS: makeAppDs() } },
    ).then((r) => r.json())

    const cookieToken = cookieRes?.data?.cookie_token
    const ltoken = ltokenRes?.data?.ltoken || entry.ltoken
    if (cookieToken && ltoken) {
      return `ltoken=${ltoken};ltuid=${stuid};cookie_token=${cookieToken};account_id=${stuid};`
    }
    if (cookieToken) {
      return `stuid=${stuid};stoken=${stoken};cookie_token=${cookieToken};account_id=${stuid};`
    }
    if (typeof logger !== 'undefined') {
      logger.debug?.(
        `[xhh-TL][runtime] stoken→ck ret cookie=${cookieRes?.retcode} ltoken=${ltokenRes?.retcode}`,
      )
    }
  } catch (err) {
    if (typeof logger !== 'undefined') {
      logger.debug?.(`[xhh-TL][runtime] stoken→ck failed: ${err.message}`)
    }
  }
  // 回退：已有 ltoken + cookie_token
  if (entry.ltoken && entry.cookie_token) {
    return `ltoken=${entry.ltoken};ltuid=${stuid};cookie_token=${entry.cookie_token};account_id=${stuid};`
  }
  if (entry.ltoken) {
    return `ltoken=${entry.ltoken};ltuid=${stuid};account_id=${stuid};`
  }
  return entry.ck || entry.ck_stoken || baseCk
}

/**
 * 解析目标 QQ（@ 优先）
 */
function resolveTargetQq(e) {
  if (e?.at && String(e.at) !== String(e.self_id || e.bot?.uin || '')) {
    return String(e.at)
  }
  for (const msg of e?.message || []) {
    if (msg.type === 'at' && String(msg.qq) !== String(e.self_id || e.bot?.uin || '')) {
      return String(msg.qq)
    }
  }
  return String(e.user_id)
}

/**
 * 从 userBind + stoken 解析 uid / ck
 */
async function resolveAuth(e, { needCookie = true, game = 'gs' } = {}) {
  const targetQq = resolveTargetQq(e)
  const selfQq = String(e.user_id)
  const user = await createUser(targetQq, e)
  const g = resolveGame(game, e)

  let uid =
    (e.uid && String(e.uid)) ||
    user.getUid?.(g) ||
    ''

  // 消息里带 UID
  if (!uid) {
    const msg = String(e.msg || '')
    const m = (g === 'zzz' ? /(1[0-9]|[1-9])[0-9]{7,9}/ : /(18|[1-9])[0-9]{8}/).exec(msg)
    if (m) uid = m[0]
  }

  if (!uid) return { uid: '', ck: '', ltuid: '', user, targetQq }

  let ck = ''
  let ltuid = ''

  // 1) mysUsers 里的 ck（优先带 cookie_token 的完整 CK）
  const mysUsers = user.mysUsers || {}
  const prefer = []
  for (const [lt, mys] of Object.entries(mysUsers)) {
    if (!mys?.ck) continue
    const uids = mys.uids?.[g] || []
    const matchUid = !uids.length || uids.map(String).includes(String(uid))
    const score =
      (/cookie_token/.test(mys.ck) ? 4 : 0) +
      (/ltoken=/.test(mys.ck) ? 2 : 0) +
      (matchUid ? 1 : 0)
    prefer.push({ lt, mys, score, matchUid })
  }
  prefer.sort((a, b) => b.score - a.score)
  for (const item of prefer) {
    if (item.score <= 0 && prefer.length > 1) continue
    ck = item.mys.ck
    ltuid = String(item.lt)
    if (item.matchUid && /cookie_token|ltoken=/.test(ck)) break
  }

  // 2) 有 ltoken 但无 cookie_token 时，仍尝试用 stoken 换完整 ck
  if (!ck || (needCookie && !/cookie_token/.test(ck))) {
    try {
      const { default: YAML } = await import('yaml')
      const fs = await import('fs')
      const path = await import('path')
      const id = targetQq
      const paths = getStokenCandidateFiles(id)
      for (const p of paths) {
        if (!fs.existsSync(p)) continue
        const data = YAML.parse(fs.readFileSync(p, 'utf-8')) || {}
        // 精确 uid
        let entry = data[uid] || data[String(uid)]
        if (!entry) {
          // 任意一条同账号 stoken
          for (const v of Object.values(data)) {
            if (v?.stoken || v?.ck_stoken) {
              entry = v
              break
            }
          }
        }
        if (entry) {
          const converted = await stokenToCookie(entry)
          if (converted) {
            ck = converted
            ltuid = entry.stuid || ltuid
            break
          }
        }
      }
    } catch (err) {
      logger?.debug?.(`[xhh-TL][runtime] load stoken: ${err.message}`)
    }
  }

  // 3) 查自己时可用 self 绑定
  if (!ck && targetQq !== selfQq) {
    const selfUser = await createUser(selfQq, e)
    for (const [lt, mys] of Object.entries(selfUser.mysUsers || {})) {
      if (mys?.ck) {
        ck = mys.ck
        ltuid = String(lt)
        break
      }
    }
  }

  return { uid: String(uid), ck, ltuid, user, targetQq, game: g }
}

function buildMysInfo(e, auth) {
  const game = auth.game || detectGame(e)
  const server = getServer(auth.uid, game)
  const ckInfo = {
    ck: auth.ck || '',
    uid: auth.uid,
    qq: auth.targetQq,
    ltuid: auth.ltuid || cookiePart(auth.ck, 'ltuid') || cookiePart(auth.ck, 'account_id') || '',
    type: 'mys',
  }
  const ckUser = {
    ck: auth.ck,
    ltuid: ckInfo.ltuid,
    type: 'mys',
    getCkInfo() {
      return ckInfo
    },
  }

  const mysInfo = {
    e,
    uid: auth.uid,
    userId: String(e.user_id),
    ckInfo,
    ckUser,
    isSelf: String(auth.targetQq) === String(e.user_id),
    auth: [...COOKIE_AUTH_APIS],
    async checkCode(res) {
      if (!res) return false
      res.retcode = Number(res.retcode)
      return res
    },
    async getCookie() {
      return this.ckInfo.ck
    },
    async checkReply() {
      // 静默，由调用方处理提示
    },
  }
  e.uid = auth.uid
  e._xhhMysInfo = mysInfo
  e._xhhGame = game
  e._xhhServer = server
  return mysInfo
}

/**
 * 系统是否已具备可用的 MysInfo（有 genshin）
 */
function hasSystemMysInfo(runtime) {
  try {
    if (!runtime) return false
    // getMysInfo 存在且底层 MysInfo 可用
    if (runtime.MysInfo && typeof runtime.MysInfo.init === 'function') return true
    // 有些环境 getter 为 undefined
    return false
  } catch (_) {
    return false
  }
}

/**
 * 给 e 注入兼容 user（无 genshin 时 e.user 为空）
 */
async function ensureUser(e) {
  if (e.user && typeof e.user.getUid === 'function') return e.user
  const user = await createUser(e.user_id, e)
  e.user = user
  return user
}

/**
 * 核心：确保 e.runtime 具备 miao MysApi 所需能力
 * @returns {Promise<object>} runtime
 */
export async function ensureRuntime(e, opts = {}) {
  if (!e) return null

  // 保证有 runtime 对象
  if (!e.runtime) {
    try {
      const Runtime = (await import('../../../lib/plugins/runtime.js')).default
      e.runtime = new Runtime(e)
    } catch (_) {
      e.runtime = {
        e,
        _mysInfo: {},
        async render() {
          return false
        },
      }
    }
  }

  const runtime = e.runtime
  await ensureUser(e)

  // 已有完整 genshin MysInfo：不覆盖 getMysInfo，但补全 getUid 失败时的回退
  const systemOk = hasSystemMysInfo(runtime)

  if (!systemOk) {
    // 覆盖 getMysInfo / getUid / getMysApi
    runtime.getMysInfo = async function getMysInfoPolyfill(targetType = 'all') {
      const key = String(targetType)
      if (this._mysInfo?.[key]) return this._mysInfo[key]

      const game = detectGame(e, opts.game)
      e.game = e.game || game
      if (game === 'sr') e.isSr = true

      const needCookie = targetType === 'cookie' || targetType === 'detail'
      const auth = await resolveAuth(e, { needCookie: true, game })
      if (!auth.uid) {
        if (e.noTips !== true) {
          e.reply?.('请先绑定 UID（#绑定uid / 扫码绑定）')
        }
        return false
      }
      if (!auth.ck) {
        if (e.noTips !== true) {
          e.reply?.(`UID:${auth.uid} 未找到可用 Cookie，请扫码绑定或绑定 CK`)
        }
        // cookie 模式必须有 ck
        if (needCookie) return false
        // all 模式也尽量要求 ck（深渊接口需要）
        return false
      }

      const mysInfo = buildMysInfo(e, auth)
      this._mysInfo = this._mysInfo || {}
      this._mysInfo[key] = mysInfo
      return mysInfo
    }

    runtime.getUid = async function getUidPolyfill() {
      const game = detectGame(e)
      const auth = await resolveAuth(e, { needCookie: false, game })
      return auth.uid || false
    }

    runtime.getMysApi = async function getMysApiPolyfill(targetType = 'all', option = {}, isSr = false) {
      const mys = await this.getMysInfo(targetType)
      if (!mys?.uid || !mys?.ckInfo?.ck) return false
      const game = isSr || e.isSr ? 'sr' : detectGame(e, option.game)
      return new LiteMysApi(mys.uid, mys.ckInfo.ck, { ...option, game })
    }

    runtime.createMysApi = function createMysApiPolyfill(uid, ck, option = {}, isSr = false) {
      const game = isSr || option.game === 'sr' ? 'sr' : option.game || 'gs'
      return new LiteMysApi(uid, ck, { ...option, game })
    }

    // 暴露 NoteUser 兼容
    if (!runtime.NoteUser) {
      runtime.NoteUser = { create: createUser }
    }
  } else {
    // 有 genshin：包装 getMysInfo，失败时回退到 polyfill
    if (!runtime._xhhOrigGetMysInfo && typeof runtime.getMysInfo === 'function') {
      runtime._xhhOrigGetMysInfo = runtime.getMysInfo.bind(runtime)
      runtime.getMysInfo = async function getMysInfoWrapped(targetType = 'all') {
        try {
          const ret = await runtime._xhhOrigGetMysInfo(targetType)
          if (ret && ret.uid && ret.ckInfo?.ck) return ret
        } catch (err) {
          logger?.debug?.(`[xhh-TL][runtime] system getMysInfo fail: ${err.message}`)
        }
        // fallback
        const game = detectGame(e)
        if (game === 'sr') e.isSr = true
        e.game = e.game || game
        const auth = await resolveAuth(e, { needCookie: true, game })
        if (!auth.uid || !auth.ck) return false
        return buildMysInfo(e, auth)
      }
    }
  }

  return runtime
}

/**
 * 在调用 miao MysApi.init 前使用
 */
export async function prepareMysContext(e, gameHint) {
  if (gameHint === 'sr') {
    e.isSr = true
    e.game = 'sr'
  } else if (gameHint === 'gs') {
    e.game = 'gs'
  } else if (gameHint === 'zzz') {
    e.game = 'zzz'
  }
  await ensureRuntime(e, { game: gameHint })
  return e
}

export { resolveAuth, stokenToCookie, detectGame, LiteMysApi }
export default { ensureRuntime, prepareMysContext }
