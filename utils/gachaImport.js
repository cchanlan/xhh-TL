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

/**
 * 兜底：在任意 JSON 里递归找「看起来是抽卡记录」的数组。
 * 各家小程序 / 网页工具的自有格式五花八门，只要每条带 gacha_type 且有 item_id 或 name 就能认。
 */
function findRecordArray(node, depth = 0) {
  if (!node || depth > 6) return null
  if (Array.isArray(node)) {
    const sample = node.find(x => x && typeof x === 'object' && !Array.isArray(x))
    if (
      sample &&
      ('gacha_type' in sample || 'uigf_gacha_type' in sample) &&
      ('item_id' in sample || 'name' in sample)
    ) {
      return node
    }
    for (const it of node) {
      const hit = findRecordArray(it, depth + 1)
      if (hit) return hit
    }
    return null
  }
  if (typeof node === 'object') {
    for (const v of Object.values(node)) {
      const hit = findRecordArray(v, depth + 1)
      if (hit) return hit
    }
  }
  return null
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
  // 已知结构都不匹配：在整个 JSON 里捞一遍，能捞到记录数组就照样导
  const loose = findRecordArray(json)
  if (loose?.length) {
    return {
      format: '未知结构（已自动识别记录数组）',
      uid: String(info.uid || json.uid || ''),
      records: normalize(loose, { uid: info.uid || json.uid, lang: info.lang }),
    }
  }
  const keys = Object.keys(json).slice(0, 8).join(', ')
  throw new Error(
    `不认识的 JSON 结构（顶层字段：${keys || '空'}），支持 SRGF v1.0 / UIGF v2.x / UIGF v4.x / Excel`,
  )
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

/** 逐字符解析 csv，兼容引号包裹与转义引号 */
function parseCsvText(text) {
  const rows = []
  let row = []
  let cell = ''
  let inQuote = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          inQuote = false
        }
      } else {
        cell += ch
      }
    } else if (ch === '"') {
      inQuote = true
    } else if (ch === ',' || ch === '\t' || ch === ';') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else if (ch !== '\r') {
      cell += ch
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter(r => r.some(c => String(c).trim()))
}

/** csv / tsv 导入：列按表头文字认，卡池靠「跃迁类型」那一列的文字判断 */
function parseCsv(text) {
  const rows = parseCsvText(String(text).replace(/^﻿/, ''))
  if (!rows.length) throw new Error('csv 是空的')
  const headRow = rows.findIndex(
    r => r.some(c => COL_MATCHERS.time.test(c || '')) || r.some(c => COL_MATCHERS.name.test(c || '')),
  )
  if (headRow < 0) throw new Error('csv 里没找到表头（需要「时间」或「名称」列）')

  const cols = {}
  rows[headRow].forEach((cell, i) => {
    const t = String(cell || '').trim()
    if (!t) return
    for (const [key, re] of Object.entries(COL_MATCHERS)) {
      if (cols[key] === undefined && re.test(t)) cols[key] = i
    }
  })
  if (cols.gacha_type === undefined) {
    throw new Error('csv 里没有「跃迁类型」列，认不出记录属于哪个卡池')
  }

  const records = []
  const seenPools = new Set()
  for (const row of rows.slice(headRow + 1)) {
    const pick = key => (cols[key] === undefined ? '' : String(row[cols[key]] ?? '').trim())
    const poolText = pick('gacha_type')
    const type = /^\d+$/.test(poolText)
      ? poolText
      : SHEET_TYPES.find(([re]) => re.test(poolText))?.[1]
    if (!type) continue
    const name = pick('name')
    if (!name && !pick('item_id')) continue
    seenPools.add(type)
    records.push({
      uid: '',
      gacha_id: '',
      gacha_type: type,
      item_id: pick('item_id'),
      count: '1',
      time: pick('time'),
      name,
      lang: 'zh-cn',
      item_type: pick('item_type'),
      rank_type: toRank(pick('rank_type')),
      id: pick('id'),
    })
  }
  if (!records.length) throw new Error('csv 里没解析出记录')
  return { format: `csv · ${records.length} 条 / ${seenPools.size} 个池`, uid: '', records }
}

/** 入口：按内容/扩展名判断格式并解析 */
export function parseImportFile(buf, fileName = '') {
  const isZip = buf.length > 1 && buf[0] === 0x50 && buf[1] === 0x4b
  if (isZip || /\.xlsx$/i.test(fileName)) return parseExcel(buf)
  const text = buf.toString('utf8').replace(/^﻿/, '')
  if (/\.(csv|tsv|txt)$/i.test(fileName) || !/^\s*[[{]/.test(text)) return parseCsv(text)
  return parseJson(text)
}

export default { parseImportFile }
