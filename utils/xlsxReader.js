/**
 * 极简 xlsx 读取器（零依赖）
 *
 * 只做「读」，且只支持 xlsx 实际会用到的两种压缩方式（存储 / deflate）。
 * 为的是导入抽卡记录的 Excel 导出文件，不追求完整的 OOXML 支持：
 * 单元格只取字符串与数值，公式、样式、日期序列号一概不管
 * （抽卡记录导出的时间列本来就是文本）。
 */

import zlib from 'node:zlib'

/** 解开 zip，返回 Map<路径, Buffer> */
export function unzip(buf) {
  const out = new Map()
  let eocd = -1
  const min = Math.max(0, buf.length - 65558)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip / xlsx 文件')

  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)

    const lnLen = buf.readUInt16LE(localOff + 26)
    const leLen = buf.readUInt16LE(localOff + 28)
    const start = localOff + 30 + lnLen + leLen
    const raw = buf.subarray(start, start + compSize)
    try {
      out.set(name, method === 0 ? raw : zlib.inflateRawSync(raw))
    } catch (err) {
      throw new Error(`解压 ${name} 失败：${err.message}`)
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

const decodeXml = s =>
  String(s ?? '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')

/** sharedStrings.xml → 字符串表（富文本把各段 <t> 拼起来） */
function readSharedStrings(xml) {
  if (!xml) return []
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m =>
    [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => decodeXml(t[1])).join(''),
  )
}

/** A1 / BC12 → 0 基列号 */
function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || '')
  if (!m) return 0
  let n = 0
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function parseSheet(xml, strings) {
  const rows = []
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = []
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attr = cm[1] || ''
      const body = cm[2] || ''
      const idx = colIndex(/r="([A-Z]+\d+)"/.exec(attr)?.[1])
      const type = /t="([^"]+)"/.exec(attr)?.[1]
      let v = ''
      if (type === 's') {
        v = strings[Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1])] ?? ''
      } else if (type === 'inlineStr' || type === 'str') {
        v = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => decodeXml(t[1])).join('')
      } else {
        v = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '')
      }
      row[idx] = v
    }
    rows.push(row)
  }
  return rows
}

/** 读 xlsx，返回 [{ name, rows }]，rows 是二维字符串数组 */
export function readXlsx(buf) {
  const files = unzip(buf)
  const text = name => (files.has(name) ? files.get(name).toString('utf8') : '')
  const strings = readSharedStrings(text('xl/sharedStrings.xml'))

  const rels = new Map()
  for (const m of text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*)>/g)) {
    const id = /Id="([^"]+)"/.exec(m[1])?.[1]
    const target = /Target="([^"]+)"/.exec(m[1])?.[1]
    if (id && target) rels.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''))
  }

  const sheets = []
  for (const m of text('xl/workbook.xml').matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const name = /name="([^"]+)"/.exec(m[1])?.[1]
    const rid = /r:id="([^"]+)"/.exec(m[1])?.[1]
    if (!name) continue
    const target = rels.get(rid) || ''
    const candidates = [`xl/${target}`, target, `xl/worksheets/sheet${sheets.length + 1}.xml`]
    const hit = candidates.find(p => files.has(p))
    if (hit) sheets.push({ name: decodeXml(name), rows: parseSheet(text(hit), strings) })
  }
  return sheets
}

export default { unzip, readXlsx }
