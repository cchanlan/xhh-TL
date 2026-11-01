/**
 * 星穹工坊云端 → 小火花的五星 / 垫抽结构。
 * 接口与导出格式参考 YUYUYUYU2147/HoYoGet-Plugin，感谢原作者的探索：
 * https://github.com/YUYUYUYU2147/HoYoGet-Plugin
 * 接口目前仅在 Linux / JiuLi 真机验证，适配层不依赖框架特有 API。
 * 上游使用 GPL-2.0；这里独立实现协议适配，不复制上游代码或第三方数据库凭证。
 */
import fetch from 'node-fetch'

const WORKSHOP_API = 'https://api.lingyuan.design/api/v2/game_user/get_sr_draw_v3'
const ITEM_API = 'https://api-takumi.mihoyo.com/event/rpgsimulator/config?game=hkrpg'
const FIELDS = {
  role_up_card_result: '11',
  guang_up_card_result: '12',
  common_card_result: '1',
  init_card_result: '2',
  rd_card_role_up_result: '21',
  rd_card_guang_up_result: '22',
}
const TYPES = new Set(['1', '2', '11', '12', '21', '22'])
let itemIndex = new Map()
let itemIndexAt = 0

async function requestJson(url) {
  // node-fetch v2/v3 都支持 signal；不依赖较新 Node 的 AbortSignal.timeout。
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 30000)
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://starrail.lelaer.com/',
        Origin: 'https://starrail.lelaer.com',
      },
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

async function loadItemIndex() {
  if (itemIndex.size && Date.now() - itemIndexAt < 7 * 86400000) return itemIndex
  try {
    const json = await requestJson(ITEM_API)
    const next = new Map()
    for (const item of [...(json?.data?.avatar || []), ...(json?.data?.equipment || [])]) {
      const name = item.item_name || item.name
      if (item.item_id && name) next.set(String(item.item_id), name)
    }
    if (next.size) {
      itemIndex = next
      itemIndexAt = Date.now()
    }
  } catch (err) {
    globalThis.logger?.warn?.(`[xhh-TL][抽卡记录] 工坊物品配置获取失败：${err.message}`)
  }
  return itemIndex
}

function number(value, label) {
  const n = Number(value || 0)
  if (!Number.isSafeInteger(n) || n < 0 || n > 100000) throw new Error(`工坊${label}异常`)
  return n
}

/** 工坊 rd_card_* 实际对应联动 21 / 22（真机字段确认），分别计入联动池。 */
export function convertWorkshop(analysis, uid, names = new Map()) {
  if (typeof analysis === 'string') analysis = JSON.parse(analysis)
  if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) {
    throw new Error('工坊没有可用的抽卡数据')
  }
  const pools = new Map()
  const ids = new Set()
  for (const [field, fallbackType] of Object.entries(FIELDS)) {
    const data = analysis[field]
    if (!data) continue
    if (!Array.isArray(data.five_cards)) throw new Error(`工坊卡池 ${field} 格式异常`)
    const pity = number(data.dian_card_infos?.draw_total, '垫抽数')
    const pool = { type: fallbackType, remote: { list: [], pity }, poolStat: { cards: [], byUpItem: new Map() },
      at: data.analysis_last_card_time || data.dian_card_infos?.time || '' }
    pools.set(fallbackType, pool)
    for (let i = 0; i < data.five_cards.length; i++) {
      const card = data.five_cards[i]
      if (!card || typeof card !== 'object') throw new Error('工坊五星记录格式异常')
      if (card.uid && String(card.uid) !== String(uid)) throw new Error('工坊返回了其他 UID 的记录')
      const type = String(card.gacha_type || fallbackType)
      if (!TYPES.has(type)) throw new Error(`工坊卡池类型异常：${type}`)
      const itemId = String(card.item_id || '')
      if (!/^\d+$/.test(itemId)) throw new Error('工坊记录缺少物品编号')
      let id = String(card.id || '')
      if (!/^\d+$/.test(id)) {
        const sec = Math.floor(Date.parse(String(card.time || '').replace(/-/g, '/')) / 1000)
        if (!Number.isFinite(sec) || sec <= 0) throw new Error('工坊记录缺少时间与编号')
        id = String(BigInt(sec) * 1000000000n + BigInt(999999999 - i))
      }
      const key = `${type}:${id}`
      if (ids.has(key)) continue
      ids.add(key)
      if (!pools.has(type)) pools.set(type, {
        type, remote: { list: [], pity: 0 }, poolStat: { cards: [], byUpItem: new Map() }, at: '',
      })
      const target = pools.get(type)
      const gachaId = String(card.gacha_id || '')
      if (card.is_up === true && gachaId) target.poolStat.byUpItem.set(itemId, gachaId)
      const node = {
        id, time: String(card.time || ''), gacha_id: gachaId,
        gacha_count: Math.max(1, number(card.draw_total, '五星抽数')),
        item: { item_id: itemId, name: names.get(itemId) || String(card.name || ''),
          item_type: card.item_type === '光锥' || card.item_type === '武器' ? 'ItemType_Equipment' : 'ItemType_Avatar', rarity: 5 },
      }
      // 缺字段不能默认为 false，否则常驻池也会被错误标成「歪」。
      if (typeof card.is_up === 'boolean') node.is_up = card.is_up
      target.remote.list.push(node)
    }
  }
  if (!pools.size) throw new Error('工坊没有常规卡池记录')
  for (const p of pools.values()) p.remote.list.sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : BigInt(a.id) < BigInt(b.id) ? 1 : 0)
  return [...pools.values()]
}

/** 调用方只传当前用户已经绑定的 UID，不提供任意 UID 的群指令入口。 */
export async function fetchWorkshop(uid) {
  const query = new URLSearchParams({ uid: String(uid), union_id: '1' })
  // 与小程序一致：当前公开查询接口只要求 union_id 非空，没有登录凭证字段。
  // 若将来接口启用账号鉴权，按失败处理，绝不清理或覆盖本地记录。
  const json = await requestJson(`${WORKSHOP_API}?${query}`)
  if (Number(json?.code) !== 0) throw new Error(`工坊请求失败：${json?.message || '无响应'}`)
  const analysis = json?.data?.card_analysis_json
  if (!analysis) throw new Error('工坊没有这个 UID 的云端记录')
  return convertWorkshop(analysis, uid, await loadItemIndex())
}
