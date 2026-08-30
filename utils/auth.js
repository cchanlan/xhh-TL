/**
 * 统一鉴权：stoken 选取（体力 widget）+ stoken→cookie（深渊/记录类接口）
 *
 * - getstoken：按 UID / 存活账号 / 已删名单挑选 stoken 或完整 CK
 * - stokenToCookie：用 stoken 换 cookie_token + ltoken
 * - cookiePart：解析 cookie 字段
 */

import fs from 'fs'
import crypto from 'crypto'
import md5 from 'md5'
import YAML from 'yaml'
import fetch from 'node-fetch'
import { createUser, getAliveMysIds, hasRuntimeBinding } from './userBind.js'
import { getDeletedMap, fingerprintStoken, removeDeleted } from './deletedCk.js'
import { getStokenCandidateFiles } from './pluginConfig.js'

export function cookiePart(ck = '', key) {
  const m = String(ck).match(new RegExp(`(?:^|;\\s*)${key}=([^;]+)`))
  return m ? m[1] : ''
}

function readYaml(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return YAML.parse(fs.readFileSync(filePath, 'utf-8')) || {}
    }
  } catch (_) {}
  return {}
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
export async function stokenToCookie(entry) {
  if (!entry) return ''
  if (entry.ck && /cookie_token/.test(entry.ck)) return entry.ck
  if (entry.cookie && /cookie_token/.test(entry.cookie)) return entry.cookie

  const stuid =
    entry.stuid ||
    cookiePart(entry.ck_stoken || '', 'stuid') ||
    cookiePart(entry.ck_stoken || '', 'ltuid')
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
      { method: 'GET', headers, signal: AbortSignal.timeout(12000) },
    ).then((r) => r.json())
    const ltokenRes = await fetch(
      'https://passport-api.mihoyo.com/account/auth/api/getLTokenBySToken',
      { method: 'GET', headers: { ...headers, DS: makeAppDs() }, signal: AbortSignal.timeout(12000) },
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
        `[xhh-TL][auth] stoken→ck ret cookie=${cookieRes?.retcode} ltoken=${ltokenRes?.retcode}`,
      )
    }
  } catch (err) {
    if (typeof logger !== 'undefined') {
      logger.debug?.(`[xhh-TL][auth] stoken→ck failed: ${err.message}`)
    }
  }

  if (entry.ltoken && entry.cookie_token) {
    return `ltoken=${entry.ltoken};ltuid=${stuid};cookie_token=${entry.cookie_token};account_id=${stuid};`
  }
  if (entry.ltoken) {
    return `ltoken=${entry.ltoken};ltuid=${stuid};account_id=${stuid};`
  }
  return entry.ck || entry.ck_stoken || baseCk
}

function withStoredStoken(ltuid, mys) {
  let ck = mys?.ck || ''
  const stoken = mys?.stoken
  if (!/stoken=/.test(ck) && typeof stoken === 'string' && stoken) {
    const stuid =
      mys.stuid ||
      cookiePart(ck, 'account_id') ||
      cookiePart(ck, 'ltuid') ||
      String(ltuid || '')
    let extra = `stoken=${stoken};`
    if (stuid) extra += `stuid=${stuid};`
    if (typeof mys.mid === 'string' && mys.mid) extra += `mid=${mys.mid};`
    ck = ck ? `${ck.replace(/;?\s*$/, '')};${extra}` : extra
  }
  return ck
}

function pickUserCookie(user, uid, { allow = () => true, allowAny = false } = {}) {
  const entries = Object.entries(user?.mysUsers || {}).filter(
    ([ltuid, mys]) => mys?.ck && allow(String(ltuid), mys),
  )
  if (!entries.length) return ''

  const owned = entries.filter(([, mys]) => {
    const uids = [].concat(mys.uids?.gs || [], mys.uids?.sr || [], mys.uids?.zzz || []).map(String)
    return !uids.length || uids.includes(String(uid))
  })

  let usable = owned
  if (!usable.length && (allowAny || entries.length === 1)) usable = entries

  const pick =
    usable.find(([, mys]) => /cookie_token=/.test(mys.ck || '')) ||
    usable.find(([, mys]) => /ltoken=/.test(mys.ck || '')) ||
    usable[0]
  return pick ? withStoredStoken(pick[0], pick[1]) : ''
}

/**
 * 为某 QQ + UID 选取可用 stoken / cookie（体力 widget 与 CK 兜底共用）
 * @returns {string|false}
 */
export async function getstoken(qq, uid, e = null) {
  // 存活账号判定：#删除ck 会把对应米游社账号(ltuid)从 Yunzai 绑定库 Users.ltuids 移除。
  // - bind.hasRow=false：该 QQ 没走 genshin 绑定体系（纯扫码 stoken 用户）→ 无从比对，保持旧行为，全部放行。
  // - bind.hasRow=true：只使用「属主账号(stuid/ltuid)仍在存活集合里」的 stoken；被删账号的 stoken 判死。
  let bind = { hasRow: false, ids: new Set() }
  try {
    bind = await getAliveMysIds(qq)
  } catch (_) {}

  // 已删名单：#删除ck 时由钩子(delCkHook)记录的被删 stuid → 删除当时的 stoken 指纹。
  const deletedMap = getDeletedMap(qq) // { stuid: fingerprint }

  // 判定某 stuid 是否仍处于「已删」状态；顺带做自愈：
  // 若名单里记了指纹，而当前这把 stoken 的指纹已变（重新扫码登录），则移出名单并放行。
  const isStillDeleted = (sid, curStoken) => {
    if (!sid || !(sid in deletedMap)) return false
    const oldFp = deletedMap[sid]
    if (oldFp && curStoken) {
      const curFp = fingerprintStoken(curStoken)
      if (curFp !== oldFp) {
        removeDeleted(qq, [sid])
        delete deletedMap[sid]
        logger?.info?.(
          `[xhh-TL][getstoken] QQ ${qq} 账号 ${sid} 检测到重新登录，已恢复体力查询`,
        )
        return false
      }
    }
    return true
  }

  // Match miao-plugin semantics: once Runtime/NoteUser is available it is the
  // sole source of truth. A missing Runtime credential means deleted/unbound;
  // standalone yaml must not bring that account back.
  if (hasRuntimeBinding(e)) {
    try {
      const user = await createUser(qq, e)
      return pickUserCookie(user, uid) || false
    } catch (err) {
      logger?.debug?.(`[xhh-TL][getstoken] Runtime credential lookup failed: ${err?.message}`)
      return false
    }
  }

  const entrySid = (entry) => {
    if (!entry) return ''
    return String(
      entry.stuid ||
        cookiePart(entry.ck_stoken || '', 'stuid') ||
        cookiePart(entry.ck_stoken || '', 'ltuid') ||
        entry.ltuid ||
        '',
    )
  }

  const aliveEntry = (entry) => {
    if (!entry || !(entry.ck_stoken || entry.stoken)) return false
    const sid = entrySid(entry)
    if (sid && isStillDeleted(sid, entry.stoken || entry.ck_stoken)) return false
    if (!bind.hasRow) return true
    if (!sid) return true
    return bind.ids.has(sid)
  }

  // 1) 精确 UID  2) 单存活 stuid 同账号回退  3) 纯 stoken 用户任意条目
  const findInData = (data) => {
    if (!data) return false
    const exact = data[uid] || data[String(uid)]
    if (aliveEntry(exact)) return exact

    const candidates = []
    for (const key of Object.keys(data)) {
      const entry = data[key]
      if (aliveEntry(entry)) candidates.push(entry)
    }
    if (!candidates.length) return false

    // 按属主精确匹配：精确 UID 条目自身可能没存 stoken（私库/扫码常把 stoken
    // 只挂在属主账号那条上，UID 条目只留 uid/region/stuid），但通常带 stuid 指向
    // 它属于哪个米游社账号。据此在候选里找「同一 stuid、且带 stoken」的条目返回。
    // 原神体力 widget 接口不带 uid、只认 stoken 所属账号，故必须精确到属主，
    // 不能在多账号时乱挑一个（否则会把别的账号体力冒充成本 UID）。
    // 置于 !bind.hasRow 兜底之前：无 genshin 时同样按属主精确命中，避免任取
    // candidates[0] 把别的账号体力冒充成本 UID。
    const ownerSid = entrySid(exact)
    if (ownerSid) {
      const owned = candidates.find((c) => entrySid(c) === ownerSid)
      if (owned) return owned
    }

    if (!bind.hasRow) return candidates[0]

    const sids = [...new Set(candidates.map(entrySid).filter(Boolean))]
    if (sids.length === 1) return candidates[0]
    return false
  }

  for (const file of getStokenCandidateFiles(qq)) {
    if (!fs.existsSync(file)) continue
    const data = readYaml(file)
    const entry = findInData(data)
    if (!entry) continue
    if (entry.ck_stoken) return entry.ck_stoken
    // 按字段存在性拼接，缺失字段不写入，避免产出 mid=undefined 被米游社判非法
    let s = `stuid=${entry.stuid};stoken=${entry.stoken};`
    if (entry.mid) s += `mid=${entry.mid};`
    return s
  }

  // SQLite/redis 绑定 CK 兜底（与深渊同源）
  try {
    const user = await createUser(qq, e)
    const ck = pickUserCookie(user, uid, {
      allow: (ltuid, mys) => {
        if (isStillDeleted(ltuid, cookiePart(mys.ck, 'stoken'))) return false
        return !bind.hasRow || bind.ids.has(ltuid)
      },
      allowAny: !bind.hasRow,
    })
    if (ck) return ck
  } catch (err) {
    logger?.debug?.(`[xhh-TL][getstoken] SQLite 兜底失败: ${err?.message}`)
  }

  return false
}

/**
 * 按 UID 在 stoken yaml 中找条目（供 resolveAuth 等复用）
 * 优先精确 uid，其次任意含 stoken 的条目
 */
export function findStokenEntry(qq, uid) {
  for (const file of getStokenCandidateFiles(qq)) {
    if (!fs.existsSync(file)) continue
    const data = readYaml(file)
    if (!data || typeof data !== 'object') continue
    const exact = data[uid] || data[String(uid)]
    if (exact && (exact.stoken || exact.ck_stoken)) return exact
    for (const v of Object.values(data)) {
      if (v?.stoken || v?.ck_stoken) return v
    }
  }
  return null
}

export default { cookiePart, getstoken, stokenToCookie, findStokenEntry }
