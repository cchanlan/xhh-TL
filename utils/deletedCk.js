/**
 * 已删 CK 名单（xhh-TL 本地维护）
 *
 * 背景：genshin 的 #删除ck 只会把对应米游社账号(ltuid/stuid)从 Yunzai 绑定库
 * (Users.ltuids / MysUsers) 移除，但不会清理 xiaoyao / 扫码登录写入的 stoken yaml。
 * 于是被删的号仍残留在 yaml 里，体力(widget)查询会把它“复活”。
 *
 * 而“被删的号”和“从没绑过 ck 的纯扫码号”在数据库里长得一模一样（绑定库都查不到、
 * yaml 里都有 stoken），无法靠现有状态区分。因此在 #删除ck 发生的那一刻，把被删的
 * stuid 记进这份本地名单，作为 getstoken 判死的唯一可靠依据：
 *   - 属主 stuid 在名单里 → 用户主动删过 → 判死，不用于体力查询
 *   - 不在名单里         → 从没删过（纯扫码等）→ 保持原有放行逻辑
 *
 * 【自愈】重新扫码登录同一个号时，xiaoyao 会用新的 stoken 覆盖 yaml。为此名单不仅记
 * stuid，还记下删除当时那把 stoken 的“指纹”。查体力时若发现 yaml 里该 stuid 的 stoken
 * 指纹已变（≠ 名单记录），说明用户重新登录过 → 自动移出名单并放行。不需要改 xiaoyao。
 *
 * 名单按 QQ 归类存储。存储结构（向后兼容旧的纯数组格式）：
 *   { "<qq>": { "<stuid>": "<删除时的 stoken 指纹>", ... }, ... }
 * 旧格式 { "<qq>": ["<stuid>", ...] } 读入时会被视为“无指纹”，仍能判死，只是不自愈。
 */

import fs from 'fs'
import path from 'path'
import YAML from 'yaml'
import md5 from 'md5'

const dataDir = path.join(process.cwd(), 'plugins/xhh-TL/data')
const listPath = path.join(dataDir, 'deleted_ck.yaml')

function ensureDir() {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
  } catch (_) {}
}

function readAll() {
  try {
    if (fs.existsSync(listPath)) {
      const obj = YAML.parse(fs.readFileSync(listPath, 'utf-8'))
      if (obj && typeof obj === 'object') return obj
    }
  } catch (_) {}
  return {}
}

function writeAll(obj) {
  ensureDir()
  try {
    fs.writeFileSync(listPath, YAML.stringify(obj || {}), 'utf-8')
  } catch (e) {
    logger?.error?.(`[xhh-TL][deletedCk] 写入失败: ${e?.message}`)
  }
}

/** 将某 QQ 名下的条目统一成 { stuid: fingerprint } 形态（兼容旧数组格式） */
function normalizeEntry(raw) {
  const map = {}
  if (Array.isArray(raw)) {
    for (const id of raw) if (id) map[String(id)] = '' // 旧格式：无指纹
  } else if (raw && typeof raw === 'object') {
    for (const [id, fp] of Object.entries(raw)) if (id) map[String(id)] = String(fp || '')
  }
  return map
}

/** 计算一把 stoken 的指纹（用于判断是否被重新登录覆盖） */
export function fingerprintStoken(stoken) {
  const s = String(stoken || '')
  if (!s) return ''
  return md5(s)
}

/** 取某 QQ 的已删 stuid 集合（字符串） */
export function getDeletedSet(qq) {
  return new Set(Object.keys(normalizeEntry(readAll()[String(qq)])))
}

/** 取某 QQ 的已删映射 { stuid: fingerprint } */
export function getDeletedMap(qq) {
  return normalizeEntry(readAll()[String(qq)])
}

/** 判断某 stuid 是否被该 QQ 删过 */
export function isDeleted(qq, stuid) {
  if (!stuid) return false
  return getDeletedSet(qq).has(String(stuid))
}

/** 取删除当时记录的 stoken 指纹（无则返回 ''） */
export function getFingerprint(qq, stuid) {
  if (!stuid) return ''
  return normalizeEntry(readAll()[String(qq)])[String(stuid)] || ''
}

/**
 * 追加一批被删账号到某 QQ 名下（去重、幂等）。
 * @param {string|number} qq
 * @param {Array<string|{stuid:string, fp?:string, stoken?:string}>} items
 *   可传 stuid 字符串，或 { stuid, fp } / { stuid, stoken }（后者内部算指纹）
 */
export function addDeleted(qq, items = []) {
  const list = [].concat(items).filter(Boolean)
  if (!list.length) return
  const all = readAll()
  const key = String(qq)
  const cur = normalizeEntry(all[key])
  for (const it of list) {
    if (typeof it === 'object') {
      const sid = String(it.stuid || '')
      if (!sid) continue
      const fp = it.fp != null ? String(it.fp) : fingerprintStoken(it.stoken)
      // 已存在且这次没带指纹，则保留原指纹；带了就更新
      cur[sid] = fp || cur[sid] || ''
    } else {
      const sid = String(it)
      if (!sid) continue
      cur[sid] = cur[sid] || ''
    }
  }
  all[key] = cur
  writeAll(all)
}

/** 从某 QQ 名下移除若干 stuid（重新绑定/自愈时调用，恢复可查） */
export function removeDeleted(qq, stuids = []) {
  const ids = new Set([].concat(stuids).map((x) => String(x)).filter(Boolean))
  if (!ids.size) return
  const all = readAll()
  const key = String(qq)
  const cur = normalizeEntry(all[key])
  let changed = false
  for (const id of ids) {
    if (id in cur) {
      delete cur[id]
      changed = true
    }
  }
  if (changed) {
    all[key] = cur
    writeAll(all)
  }
}

export default {
  fingerprintStoken,
  getDeletedSet,
  getDeletedMap,
  isDeleted,
  getFingerprint,
  addDeleted,
  removeDeleted,
}
