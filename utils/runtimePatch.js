/**
 * Runtime 补丁：在无 genshin（或 Runtime.getMysInfo 不可用）时，
 * 让 miao-plugin 的 MysApi.init / getData 仍可工作。
 *
 * 有 genshin 时：不覆盖系统 getMysInfo，仅补全缺失方法。
 * 无 genshin 时：注入 getMysInfo / getUid / getMysApi + e.user。
 */

import { createUser, hasRuntimeBinding } from './userBind.js'
import LiteMysApi, { getServer, gameKey as resolveGame } from './mysClient.js'
import { cookiePart, stokenToCookie, findStokenEntry } from './auth.js'

/** miao-plugin 的 MysApi（懒加载，避免循环依赖） */
let _miaoMysApi = null
async function getMiaoMysApi() {
  if (_miaoMysApi) return _miaoMysApi
  try {
    const mod = await import('../../miao-plugin/models/index.js')
    _miaoMysApi = mod?.MysApi || null
  } catch (_) {
    _miaoMysApi = null
  }
  return _miaoMysApi
}

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
  const runtimeAuthoritative = hasRuntimeBinding(e)
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

  // 1) mysUsers 里的 ck。归属匹配优先于凭证质量：
  //    先选「uids 里明确包含该 uid」的账号；没有任何账号声明归属时才退回归属未知的。
  //    有账号声明过归属、却都不含该 uid 时宁可不用，避免拿错账号凭证冒充本 UID
  //    （widget 接口不带 uid，用错凭证 = 多号体力完全一样）。
  const mysUsers = user.mysUsers || {}
  const quality = (mys) =>
    (/cookie_token/.test(mys.ck) ? 4 : 0) + (/ltoken=/.test(mys.ck) ? 2 : 0)
  const candidates = []
  for (const [lt, mys] of Object.entries(mysUsers)) {
    if (!mys?.ck) continue
    const uids = (mys.uids?.[g] || []).map(String)
    candidates.push({ lt, mys, known: uids.length > 0, match: uids.includes(String(uid)) })
  }
  const byQuality = (a, b) => quality(b.mys) - quality(a.mys)
  const matching = candidates.filter((c) => c.known && c.match).sort(byQuality)
  const anyKnownOwner = candidates.some((c) => c.known)
  const picked = matching[0] || (anyKnownOwner ? null : [...candidates].sort(byQuality)[0])
  if (picked) {
    ck = picked.mys.ck
    ltuid = String(picked.lt)
  }

  // 2) 有 ltoken 但无 cookie_token 时，仍尝试用 stoken 换完整 ck
  if (!runtimeAuthoritative && (!ck || (needCookie && !/cookie_token/.test(ck)))) {
    try {
      const entry = findStokenEntry(targetQq, uid)
      if (entry) {
        const converted = await stokenToCookie(entry)
        if (converted) {
          ck = converted
          ltuid = entry.stuid || ltuid
        }
      }
    } catch (err) {
      logger?.debug?.(`[xhh-TL][runtime] load stoken: ${err.message}`)
    }
  }

  // 3) 查自己时可用 self 绑定
  if (!runtimeAuthoritative && !ck && targetQq !== selfQq) {
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

  // 已有完整 genshin MysInfo：可复用其 getMysInfo 解析 UID/CK
  const systemOk = hasSystemMysInfo(runtime)

  if (!systemOk) {
    // 无 genshin：补齐 getMysInfo / getUid
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
          e.reply?.('请先绑定 UID（【#绑定uid】或【#扫码登录】）')
        }
        return false
      }
      if (!auth.ck) {
        if (e.noTips !== true) {
          e.reply?.(`UID:${auth.uid} 未找到可用 Cookie，请【#刷新ck】，仍不行则【#扫码登录】`)
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

    // 暴露 NoteUser 兼容
    if (!runtime.NoteUser) {
      runtime._xhhCompatNoteUser = true
      Object.defineProperty(runtime, 'NoteUser', {
        value: { create: createUser },
        configurable: true,
      })
    }
  }

  /**
   * 无论有无 genshin，本插件路径都用 LiteMysApi 发请求。
   * 这样星铁混沌/虚构/末日/异相默认带 need_all=true，用户无需改 genshin apiTool.js。
   * 仅挂在当前 e.runtime（单次消息），不影响其它插件长期行为。
   */
  if (!runtime._xhhLiteMysApi) {
    runtime._xhhLiteMysApi = true
    runtime.getMysApi = async function getMysApiLite(targetType = 'all', option = {}, isSr = false) {
      const mys = await this.getMysInfo(targetType)
      if (!mys?.uid || !mys?.ckInfo?.ck) return false
      const game = isSr || e.isSr || option.game === 'sr' ? 'sr' : detectGame(e, option.game)
      return new LiteMysApi(mys.uid, mys.ckInfo.ck, { ...option, game })
    }
    runtime.createMysApi = function createMysApiLite(uid, ck, option = {}, isSr = false) {
      const game = isSr || option.game === 'sr' ? 'sr' : option.game || detectGame(e)
      return new LiteMysApi(uid, ck, { ...option, game })
    }
  }

  return runtime
}

/**
 * 旧版 miao-plugin 的 MysApi 没有 checkCk 方法（如 #全部深渊 issue IKLCLU 报的
 * "mys.checkCk is not a function"）。给原型补一次兜底：有 ck 就算可用，
 * 真正的接口失败由后续请求自己的错误分支处理。
 * 只在缺失时挂，不覆盖新版 miao 自带的真校验实现。
 */
async function patchMysApiCheckCk() {
  try {
    const MysApi = await getMiaoMysApi()
    const proto = MysApi?.prototype
    if (proto && typeof proto.checkCk !== 'function') {
      proto.checkCk = async function () {
        try {
          return !!(this.ckInfo?.ck || this.ckUser?.ck || this.ck)
        } catch (_) {
          return false
        }
      }
    }
  } catch (_) {}
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
  await patchMysApiCheckCk()
  await ensureRuntime(e, { game: gameHint })
  return e
}

export { resolveAuth, stokenToCookie, detectGame, LiteMysApi }
export default { ensureRuntime, prepareMysContext }
