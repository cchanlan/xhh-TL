/** 签到只使用当前用户的角色属主 CK，不走公共查询池或消息里的 @ 目标。 */
export function getSignAccounts(user, game) {
  const mysUsers = user.mysUsers || {}
  const accounts = new Map()
  const add = (uid, ltuid) => {
    if (!uid || !ltuid) return
    uid = String(uid)
    ltuid = String(ltuid)
    const mys = mysUsers[ltuid]
    if (!/^\d+$/.test(uid) || !mys) return
    const owned = (mys.uids?.[game] || []).map(String)
    if (owned.length && !owned.includes(uid)) return
    const existing = accounts.get(uid)
    if (existing && existing.ltuid !== ltuid) {
      throw new Error(`签到角色归属冲突 game=${game} uid=${uid}`)
    }
    accounts.set(uid, { uid, ltuid, ck: mys.ck || '' })
  }

  // 原库 getCkUidList 返回 { uid, ltuid, type: 'ck', game }；兼容层的
  // getUidList 还可能补充存活通行证的角色，因此不能只取原生 CK 列表。
  for (const item of [
    ...(user.getCkUidList?.(game) || []),
    ...(user.getUidList?.(game) || []),
  ]) {
    if (item && typeof item === 'object') add(item.uid, item.ltuid || item.stuid)
  }
  // 有明确归属时可补齐缺少 ltuid 的列表项；只注册的 UID 不会混进来。
  for (const [ltuid, mys] of Object.entries(mysUsers)) {
    for (const uid of mys?.uids?.[game] || []) add(uid, ltuid)
  }
  return [...accounts.values()]
}
