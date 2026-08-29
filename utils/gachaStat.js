/**
 * 抽卡记录统计（口径对齐 genshin 的 gachaLog.analyse / randData）
 *
 * 单独实现一份是因为不是每个实例都装了 plugins/genshin —— 之前直接 import 它的
 * model/gachaLog.js，在没装的机器上会直接 Cannot find module，整个功能不可用。
 * 这里只读 data/srJson 下的记录自己算，图标走 miao 的星铁元数据。
 */

/** 星铁常驻五星角色：在活动池里抽到就算「歪」 */
const STANDARD_5 = ['姬子', '瓦尔特', '克拉拉', '彦卿', '白露', '布洛妮娅', '杰帕德']

/**
 * 曾作为 UP 出现过的角色及其 UP 期间，与 genshin gachaLog.js 里的 role5join 同源。
 * 这些角色在列出的时间段**之外**抽到就算歪（那是从别人的池子里歪出来的）。
 * 新角色复刻后要往这里补时间段，否则会把歪的算成 UP。
 */
const UP_PERIODS = {
  希儿: [
    ['2023-04-26 06:00:00', '2023-05-17 17:59:59'],
    ['2023-10-27 12:00:00', '2023-11-14 14:59:59'],
  ],
  刃: [
    ['2023-07-19 06:00:00', '2023-08-09 11:59:59'],
    ['2023-12-27 06:00:00', '2024-01-17 11:59:59'],
  ],
  符玄: [
    ['2023-09-20 12:00:00', '2023-10-10 14:59:59'],
    ['2024-05-29 12:00:00', '2024-06-18 14:59:59'],
  ],
  银狼: [
    ['2023-06-07 06:00:00', '2023-06-28 11:59:59'],
    ['2023-12-06 12:00:00', '2023-12-26 14:59:59'],
    ['2025-02-05 12:00:00', '2025-02-25 14:59:59'],
    ['2025-09-02 12:00:00', '2025-09-23 14:59:59'],
  ],
  银枝: [
    ['2023-12-06 12:00:00', '2023-12-26 14:59:59'],
    ['2024-07-10 12:00:00', '2024-07-31 14:59:59'],
  ],
  云璃: [
    ['2024-07-31 06:00:00', '2024-08-21 11:59:59'],
    ['2025-02-26 06:00:00', '2025-03-19 11:59:59'],
  ],
}

const ts = s => Date.parse(String(s).replace(/-/g, '/'))

/** 这一条五星角色记录是不是当期 UP */
function isUpRole(row) {
  if (STANDARD_5.includes(row.name)) return false
  const periods = UP_PERIODS[row.name]
  if (!periods) return true
  const t = ts(row.time)
  if (!t) return true
  return periods.some(([s, e]) => t >= ts(s) && t <= ts(e))
}

let miaoModels
async function loadMiao() {
  if (miaoModels !== undefined) return miaoModels
  try {
    // 不能用 '#miao.models'：xhh-TL 自带 package.json，Node 会在本插件里找 imports 字段
    miaoModels = await import('../../miao-plugin/models/index.js')
  } catch (err) {
    logger?.debug?.(`[xhh-TL][抽卡记录] miao 元数据不可用：${err.message}`)
    miaoModels = null
  }
  return miaoModels
}

/** 名字 → miao 里的头像相对路径（/meta-sr/...），拿不到就空串 */
export async function getIcon(name, itemType) {
  const models = await loadMiao()
  if (!models || !name) return ''
  const isChar = itemType === '角色'
  const meta = isChar ? models.Character?.get?.(name, 'sr') : models.Weapon?.get?.(name, 'sr')
  const icon = (isChar ? meta?.imgs?.face : meta?.imgs?.icon) || ''
  // 角色的 face 带前导斜杠、光锥的 icon 不带，模板里要拼 {{_miao_path}} 所以统一补上
  return icon && !icon.startsWith('/') ? `/${icon}` : icon
}

/** 单池保底上限：光锥池 80，其余 90 */
export const poolMax = type => (['12', '22', 12, 22].includes(type) ? 80 : 90)

/**
 * 统计一个池。list 是 srJson 里的原始数组（新→旧）
 * 返回值字段名与 genshin analyse() 保持一致，方便对照
 */
export function analyse(list, type) {
  const all = Array.isArray(list) ? list : []
  const fiveLog = []
  const fourLog = {}
  let fiveNum = 0
  let fourNum = 0
  let fiveLogNum = 0
  let fourLogNum = 0
  let noFiveNum = 0
  let noFourNum = 0
  let wai = 0
  let weaponNum = 0
  let weaponFourNum = 0
  let bigNum = 0
  let allNum = all.length

  for (const row of all) {
    const rank = String(row.rank_type)
    if (rank === '4') {
      fourNum++
      if (noFourNum === 0) noFourNum = fourLogNum
      fourLogNum = 0
      fourLog[row.name] = (fourLog[row.name] || 0) + 1
      if (row.item_type === '光锥' || row.item_type === '武器') weaponFourNum++
    }
    fourLogNum++

    if (rank === '5') {
      fiveNum++
      if (fiveLog.length > 0) fiveLog[fiveLog.length - 1].num = fiveLogNum
      else noFiveNum = fiveLogNum
      fiveLogNum = 0

      let isUp = false
      if (row.item_type === '角色') {
        if (isUpRole(row)) isUp = true
        else wai++
      } else {
        weaponNum++
      }
      fiveLog.push({
        name: row.name,
        item_type: row.item_type,
        item_id: row.item_id,
        num: 0,
        isUp,
      })
    }
    fiveLogNum++
  }

  if (fiveLog.length > 0) {
    fiveLog[fiveLog.length - 1].num = fiveLogNum
    // 上一个五星是不是常驻（小保底标记）
    fiveLog.forEach((it, i) => {
      const prev = fiveLog[i + 1]
      if (prev && !prev.isUp) {
        it.minimum = true
        bigNum++
      } else {
        it.minimum = false
      }
    })
  } else {
    noFiveNum = allNum
  }

  const four = Object.entries(fourLog)
    .map(([name, num]) => ({ name, num }))
    .sort((a, b) => b.num - a.num)
  if (!four.length) four.push({ name: '无', num: 0 })

  const fiveAvg = fiveNum > 0 ? Math.round((allNum - noFiveNum) / fiveNum) : 0
  const fourAvg = fourNum > 0 ? Math.round((allNum - noFourNum) / fourNum) : 0

  let isvalidNum = 0
  if (fiveNum > 0 && fiveNum > wai) {
    isvalidNum =
      fiveLog.length > 0 && !fiveLog[0].isUp
        ? Math.round((allNum - noFiveNum - fiveLog[0].num) / (fiveNum - wai))
        : Math.round((allNum - noFiveNum) / (fiveNum - wai))
  }
  const raw = isvalidNum * 160
  const upYs = raw >= 10000 ? `${(raw / 10000).toFixed(2)}w` : raw.toFixed(0)

  let noWaiRate = 0
  if (fiveNum > 0 && fiveNum - bigNum > 0) {
    const rate = ((fiveNum - bigNum - wai) / (fiveNum - bigNum)) * 100
    // 常驻池歪的比五星还多时会算出负数，夹一下（常驻池本来也不显示这项）
    noWaiRate = Math.min(100, Math.max(0, rate)).toFixed(1)
  }

  return {
    allNum,
    noFiveNum,
    noFourNum,
    fiveNum,
    fourNum,
    fiveAvg,
    fourAvg,
    wai,
    isvalidNum,
    maxFour: four[0],
    weaponNum,
    weaponFourNum,
    fiveLog,
    upYs,
    noWaiRate,
    firstTime: all[all.length - 1]?.time?.substring(0, 16) || '',
    lastTime: all[0]?.time?.substring(0, 16) || '',
  }
}

/** 底部十项统计，两行五列，字段名沿用 genshin（lable 这个拼写也照抄，模板复用） */
export function buildLine(data, type) {
  const nums = data.fiveLog.filter(x => x.num !== 0).map(x => x.num)
  const maxValue = nums.length ? Math.max(...nums) : 0
  const minValue = nums.length ? Math.min(...nums) : 0
  const t = String(type)

  // 角色池（含联动角色）：关心歪不歪
  if (['11', '21'].includes(t)) {
    return [
      [
        { lable: '未出五星', num: data.noFiveNum, unit: '抽' },
        { lable: '五星', num: data.fiveNum, unit: '个' },
        { lable: '五星平均', num: data.fiveAvg, unit: '抽' },
        { lable: '小保底不歪', num: `${data.noWaiRate}%`, unit: '' },
        { lable: '最非', num: maxValue, unit: '抽' },
      ],
      [
        { lable: '未出四星', num: data.noFourNum, unit: '抽' },
        { lable: '五星常驻', num: data.wai, unit: '个' },
        { lable: 'UP平均', num: data.isvalidNum, unit: '抽' },
        { lable: 'UP花费星琼', num: data.upYs, unit: '' },
        { lable: '最欧', num: minValue, unit: '抽' },
      ],
    ]
  }

  // 光锥池、常驻池、新手池：没有 UP 概念，改看四星
  return [
    [
      { lable: '未出五星', num: data.noFiveNum, unit: '抽' },
      { lable: '五星', num: data.fiveNum, unit: '个' },
      { lable: '五星平均', num: data.fiveAvg, unit: '抽' },
      { lable: t === '1' || t === '2' ? '五星光锥' : '四星光锥', num: t === '1' || t === '2' ? data.weaponNum : data.weaponFourNum, unit: '个' },
      { lable: '最非', num: maxValue, unit: '抽' },
    ],
    [
      { lable: '未出四星', num: data.noFourNum, unit: '抽' },
      { lable: '四星', num: data.fourNum, unit: '个' },
      { lable: '四星平均', num: data.fourAvg, unit: '抽' },
      { lable: '四星最多', num: data.maxFour.num, unit: data.maxFour.name.slice(0, 4) },
      { lable: '最欧', num: minValue, unit: '抽' },
    ],
  ]
}

export default { analyse, buildLine, getIcon, poolMax }
