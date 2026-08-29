/**
 * 抽卡记录导入：把四种常见格式统一成 srJson 的记录结构
 *
 *   1. SRGF v1.0        {info:{uid, srgf_version:'v1.0'}, list:[...]}
 *   2. UIGF v4.x        {info:{version:'v4.x'}, hkrpg:[{uid, lang, timezone, list:[...]}]}
 *   3. UIGF v2.x / v3.0 {info:{uid, uigf_version:'v2.3'}, list:[...]}（老版单游戏结构）
 *   4. Excel (.xlsx)    一个卡池一个 sheet，按表头文字认列，不依赖列顺序
 *
 * 另外也接受裸的记录数组，方便手改文件。
 * Excel 没有记录 id，导入时用「卡池 + 时间 + 名称」判重，见 srGachaLog.js。
 */

import { readXlsx } from './xlsxReader.js'

/** sheet 名 → srJson 的 gacha_type。联动要排在前面，否则会被「角色 / 光锥」抢先命中 */
const SHEET_TYPES = [
  [/联动.*角色|角色.*联动|collab.*(char|avatar)/i, '21'],
  [/联动.*(光锥|武器)|(光锥|武器).*联动|collab.*(light|weapon|cone)/i, '22'],
  [/角色|avatar|character/i, '11'],
  [/光锥|武器|weapon|cone/i, '12'],
  [/常驻|群星|stellar|standard|regular/i, '1'],
  [/新手|departure|beginner/i, '2'],
]

const COL_MATCHERS = {
  time: /时间|日期|time|date/i,
  name: /名称|物品|道具|name|item$/i,
  item_type: /类别|类型|item.?type/i,
  rank_type: /星级|品质|稀有|rank|rarity|star/i,
  gacha_type: /跃迁类型|祈愿类型|卡池类型|卡池|gacha.?type|pool/i,
  id: /^id$|记录\s*id|record.?id/i,
  item_id: /物品\s*id|item.?id/i,
}

const RANK_WORDS = { 三: '3', 四: '4', 五: '5' }

function toRank(v) {
  const s = String(v ?? '').trim()
  if (!s) return ''
  const num = /(\d)/.exec(s)?.[1]
  if (num) return num
  for (const [word, n] of Object.entries(RANK_WORDS)) if (s.includes(word)) return n
  return ''
}

function normalize(list, ctx = {}) {
  const out = []
  for (const r of list || []) {
    if (!r || typeof r !== 'object') continue
    const gachaType = String(r.gacha_type ?? r.uigf_gacha_type ?? '').trim()
    if (!gachaType) continue
    out.push({
      uid: String(r.uid || ctx.uid || ''),
      gacha_id: String(r.gacha_id || ''),
      gacha_type: gachaType,
      item_id: String(r.item_id || ''),
      count: String(r.count || '1'),
      time: String(r.time || '').trim(),
      name: String(r.name || '').trim(),
      lang: String(r.lang || ctx.lang || 'zh-cn'),
      item_type: String(r.item_type || '').trim(),
      rank_type: toRank(r.rank_type),
      id: String(r.id || '').trim(),
    })
  }
  return out
}

function parseJson(text) {
  let json
  try {
    json = JSON.parse(String(text).replace(/^﻿/, ''))
  } catch (err) {
    throw new Error(`JSON 解析失败：${err.message}`)
  }

  if (Array.isArray(json)) {
    return { format: '记录数组', uid: '', records: normalize(json) }
  }
  const info = json.info || {}

  // UIGF v4.x：多游戏结构，星铁在 hkrpg 下，可能有多个 uid
  if (Array.isArray(json.hkrpg)) {
    const records = []
    const uids = []
    for (const pack of json.hkrpg) {
      const uid = String(pack.uid || '')
      if (uid) uids.push(uid)
      records.push(...normalize(pack.list, { uid, lang: pack.lang }))
    }
    return {
      format: `UIGF ${info.version || 'v4'}`,
      uid: uids[0] || '',
      uids,
      records,
    }
  }
  if (Array.isArray(json.hk4e) || Array.isArray(json.nap)) {
    throw new Error('这份 UIGF 里没有星铁数据（只有原神 / 绝区零）')
  }

  // SRGF v1.0 与 UIGF v2.x / v3.0 都是 info + list 的单游戏结构
  if (Array.isArray(json.list)) {
    const format = info.srgf_version
      ? `SRGF ${info.srgf_version}`
      : info.uigf_version
        ? `UIGF ${info.uigf_version}`
        : '通用 list'
    return {
      format,
      uid: String(info.uid || ''),
      records: normalize(json.list, { uid: info.uid, lang: info.lang }),
    }
  }
  throw new Error('不认识的 JSON 结构，需要 SRGF v1.0 / UIGF v2.x / UIGF v4.x')
}

function parseExcel(buf) {
  const sheets = readXlsx(buf)
  if (!sheets.length) throw new Error('Excel 里没有可读的工作表')

  const records = []
  const usedSheets = []
  for (const sheet of sheets) {
    const type = SHEET_TYPES.find(([re]) => re.test(sheet.name))?.[1]
    if (!type) continue

    // 找表头行：出现「时间」或「名称」那一行
    const headRow = sheet.rows.findIndex(
      row => row?.some(c => COL_MATCHERS.time.test(c || '')) || row?.some(c => COL_MATCHERS.name.test(c || '')),
    )
    if (headRow < 0) continue

    const cols = {}
    sheet.rows[headRow].forEach((cell, i) => {
      const text = String(cell || '').trim()
      if (!text) return
      for (const [key, re] of Object.entries(COL_MATCHERS)) {
        if (cols[key] === undefined && re.test(text)) cols[key] = i
      }
    })
    if (cols.name === undefined && cols.item_id === undefined) continue

    let n = 0
    for (const row of sheet.rows.slice(headRow + 1)) {
      if (!row || !row.length) continue
      const pick = key => (cols[key] === undefined ? '' : String(row[cols[key]] ?? '').trim())
      const name = pick('name')
      const time = pick('time')
      if (!name && !pick('item_id')) continue
      records.push({
        uid: '',
        gacha_id: '',
        gacha_type: type,
        item_id: pick('item_id'),
        count: '1',
        time,
        name,
        lang: 'zh-cn',
        item_type: pick('item_type'),
        rank_type: toRank(pick('rank_type')),
        id: pick('id'),
      })
      n++
    }
    if (n) usedSheets.push(`${sheet.name}(${n})`)
  }
  if (!records.length) {
    throw new Error(`Excel 里没找到抽卡记录，工作表：${sheets.map(s => s.name).join('/')}`)
  }
  return { format: `Excel · ${usedSheets.join(' ')}`, uid: '', records }
}

/** 入口：按内容/扩展名判断格式并解析 */
export function parseImportFile(buf, fileName = '') {
  const isZip = buf.length > 1 && buf[0] === 0x50 && buf[1] === 0x4b
  if (isZip || /\.xlsx$/i.test(fileName)) return parseExcel(buf)
  return parseJson(buf.toString('utf8'))
}

export default { parseImportFile }
