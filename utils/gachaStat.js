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

/**
 * 这一条五星角色记录是不是当期 UP。
 * upByGachaId 是接口权威的「期次编号 → 该期 UP 名单」（来自 pool_stat 落盘缓存），
 * 有就直接对名字，比手工维护的时间表准；拿不到才回退到下面的常驻名单 + UP 期间表。
 * 注意名字要精确比较：新形态角色叫「姬子•启行」「千冶•刃」，跟常驻的「姬子」「刃」是两个人
 */
function isUpRole(row, upByGachaId) {
  const ups = upByGachaId?.get?.(String(row.gacha_id || ''))
  if (ups?.length) return ups.includes(row.name)
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

/**
 * 单池保底上限：光锥池 80、新手池 50（始发跃迁总共只能抽 50 次且 50 抽内必出五星）、其余 90。
 * 这个数是出图进度条的分母，给错了条形长度就不对
 */
export const poolMax = type => {
  const t = String(type)
  if (t === '12' || t === '22') return 80
  if (t === '2') return 50
  return 90
}

/**
 * 统计一个池。list 是 srJson 里的原始数组（新→旧）
 * apiPity 是小程序接口给的当前垫抽——本地缺四星三星记录时靠它兜底
 * upByGachaId 是「期次编号 → 该期 UP 名单」，判歪优先用它（见 isUpRole）
 * 返回值字段名与 genshin analyse() 保持一致，方便对照
 */
export function analyse(list, type, apiPity = 0, upByGachaId = null) {
  const all = Array.isArray(list) ? list : []
  // 占位是为了凑抽数造的假记录，时间不可信，统计时间范围时要绕开
  const real = all.filter(r => !r.xhh_ph)
  const fiveLog = []
  const fourLog = {}
  let fiveNum = 0
  let fourNum = 0
  let fiveLogNum = 0
  let fourLogNum = 0
  let noFiveNum = 0
  let noFourNum = 0
  // 「最新一条就是四星」时 noFourNum 该是 0，用 flag 判首次而不是判 noFourNum===0，
  // 否则会被下一段间隔顶掉（genshin 原版就是这个写法，这里按正确的算）
  let fourSeen = false
  let wai = 0
  let weaponNum = 0
  let weaponFourNum = 0
  let bigNum = 0
  let allNum = all.length

  for (const row of all) {
    const rank = String(row.rank_type)
    if (rank === '4') {
      fourNum++
      if (!fourSeen) {
        noFourNum = fourLogNum
        fourSeen = true
      }
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
        if (isUpRole(row, upByGachaId)) isUp = true
        else wai++
      } else {
        weaponNum++
        // 光锥也标 UP：期次映射里就有当期限定光锥的名字（3135 → 你将起身歌唱这种）。
        // 拿不到映射时保持不标，不猜；wai 只统计角色池的歪，光锥不计入
        const ups = upByGachaId?.get?.(String(row.gacha_id || ''))
        if (ups?.length) isUp = ups.includes(row.name)
      }
      fiveLog.push({
        name: row.name,
        item_type: row.item_type,
        item_id: row.item_id,
        num: 0,
        isUp,
        // 小程序接口直接给的抽数，比数占位可靠（占位受 id 空间限制可能补不满）
        pity: Number(row.xhh_pity) || 0,
      })
    }
    fiveLogNum++
  }

  if (fiveLog.length > 0) {
    fiveLog[fiveLog.length - 1].num = fiveLogNum
    // 接口原值和本地间隔取更全的一方：两个来源各有缺口——接口不含四星/逐抽，
    // authkey 只给最近 6 个月（跨在截断边界上的五星间隔会偏小）。偏小的一定是被截断的那份
    for (const it of fiveLog) if (it.pity > it.num) it.num = it.pity
    // 最新五星之后的抽数：接口知道、但那些四星三星记录本地没有，取大的那个
    noFiveNum = Math.max(noFiveNum, Number(apiPity) || 0)
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
    // 占位没补满时记录数会偏少，用五星抽数之和把总抽数校正回来
    allNum = Math.max(allNum, fiveLog.reduce((n, x) => n + x.num, 0) + noFiveNum)
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
    // 时间只看真实记录：当前垫抽的占位 time 是写入时刻，拿它当「最后一抽」会显示成更新时间
    firstTime: (real[real.length - 1] || all[all.length - 1])?.time?.substring(0, 16) || '',
    lastTime: (real[0] || all[0])?.time?.substring(0, 16) || '',
  }
}

/** 底部十项统计，两行五列，字段名沿用 genshin（lable 这个拼写也照抄，模板复用） */
export function buildLine(data, type) {
  const nums = data.fiveLog.filter(x => x.num !== 0).map(x => x.num)
  const maxValue = nums.length ? Math.max(...nums) : 0
  const minValue = nums.length ? Math.min(...nums) : 0
  const t = String(type)
  // 只有小程序接口来的数据时本地一条四星记录都没有，四星那几项算出来全是 0，
  // 显示成「未出四星 0 抽」会让人以为刚出过四星。这种情况一律显示占位符
  const hasFour = data.fourNum > 0
  const four = (num, unit = '') => (hasFour ? { num, unit } : { num: '—', unit: '' })

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
        { lable: '未出四星', ...four(data.noFourNum, '抽') },
        { lable: '五星常驻', num: data.wai, unit: '个' },
        { lable: 'UP平均', num: data.isvalidNum, unit: '抽' },
        { lable: 'UP花费星琼', num: data.upYs, unit: '' },
        { lable: '最欧', num: minValue, unit: '抽' },
      ],
    ]
  }

  // 光锥池、常驻池、新手池：没有 UP 概念，改看四星
  const fiveWeapon = t === '1' || t === '2'
  return [
    [
      { lable: '未出五星', num: data.noFiveNum, unit: '抽' },
      { lable: '五星', num: data.fiveNum, unit: '个' },
      { lable: '五星平均', num: data.fiveAvg, unit: '抽' },
      fiveWeapon
        ? { lable: '五星光锥', num: data.weaponNum, unit: '个' }
        : { lable: '四星光锥', ...four(data.weaponFourNum, '个') },
      { lable: '最非', num: maxValue, unit: '抽' },
    ],
    [
      { lable: '未出四星', ...four(data.noFourNum, '抽') },
      { lable: '四星', ...four(data.fourNum, '个') },
      { lable: '四星平均', ...four(data.fourAvg, '抽') },
      { lable: '四星最多', ...(hasFour ? { num: data.maxFour.num, unit: data.maxFour.name.slice(0, 4) } : { num: '—', unit: '' }) },
      { lable: '最欧', num: minValue, unit: '抽' },
    ],
  ]
}

export default { analyse, buildLine, getIcon, poolMax }
