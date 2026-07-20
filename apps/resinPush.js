/**
 * 体力阈值推送
 *
 * 每个用户在群里各自设定「体力阈值」，体力恢复到该值(含)以上时，
 * 机器人在该群 @用户 并发一张体力立绘卡片（复用 TL 的查询与出图）。
 *
 * - 原神 / 星铁分开指令、分开阈值、分开推送
 *   · 原神看「原粹树脂」(current_resin)
 *   · 星铁看「开拓力」(current_stamina)
 * - 仅在群里 @ 提醒
 * - 达到阈值只 @ 一次；体力回落到阈值以下后自动重新武装，下次满足再提醒
 *
 * 指令（群聊内，谁发就绑定谁）：
 *   #原神体力推送 130      —— 原粹树脂达到 130 时提醒
 *   #星铁体力推送 200      —— 开拓力达到 200 时提醒
 *   #原神体力推送关闭
 *   #星铁体力推送关闭
 *   #体力推送列表          —— 查看自己的订阅
 */

import fs from 'fs'
import path from 'path'
import plugin from '../../../lib/plugins/plugin.js'
import Runtime from '../../../lib/plugins/runtime.js'
import { TL } from './TL.js'
import { readPluginConfig, getRenderScaleStyle } from '../utils/pluginConfig.js'

const pluginDir = process.cwd() + '/plugins/xhh-TL'
const DATA_DIR = path.join(pluginDir, 'data')
const CONFIG_FILE = path.join(DATA_DIR, 'resin_push.json')

const DEFAULT_CRON = '*/10 * * * *' // 每 10 分钟检查一次

// 各游戏元信息：字段、上限键、名称、阈值合法上限
const GAME_META = {
  gs: { label: '原神', field: 'current_resin', maxField: 'max_resin', unit: '原粹树脂', cap: 200 },
  sr: { label: '星铁', field: 'current_stamina', maxField: 'max_stamina', unit: '开拓力', cap: 300 },
}

// ============ 配置读写 ============
function ensureDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  } catch (_) {}
}

/**
 * 结构：
 * {
 *   gs: { "<qq>": { threshold: 130, group: "123", armed: true } },
 *   sr: { "<qq>": { threshold: 200, group: "123", armed: true } }
 * }
 */
function loadSubs() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}
      return { gs: data.gs || {}, sr: data.sr || {} }
    }
  } catch (err) {
    logger?.error?.(`[xhh-TL][体力推送] 读取配置失败: ${err.message}`)
  }
  return { gs: {}, sr: {} }
}

function saveSubs(subs) {
  try {
    ensureDir()
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(subs, null, 2))
  } catch (err) {
    logger?.error?.(`[xhh-TL][体力推送] 保存配置失败: ${err.message}`)
  }
}

// ============ 插件 ============
export class resinPush extends plugin {
  constructor() {
    const cfg = readPluginConfig()
    const cron = cfg.resin_push_cron || DEFAULT_CRON

    super({
      name: '[小花火]体力阈值推送',
      dsc: '体力达到阈值自动@提醒',
      event: 'message',
      priority: -1000,
      rule: [
        { reg: '^\\s*#?原神体力推送\\s*(?:关闭|关|取消|停止)\\s*$', fnc: 'offGs' },
        { reg: '^\\s*#?星铁体力推送\\s*(?:关闭|关|取消|停止)\\s*$', fnc: 'offSr' },
        { reg: '^\\s*#?原神体力推送\\s*(\\d{1,3})\\s*$', fnc: 'setGs' },
        { reg: '^\\s*#?星铁体力推送\\s*(\\d{1,3})\\s*$', fnc: 'setSr' },
        { reg: '^\\s*#?(?:原神|星铁)?体力推送\\s*$', fnc: 'usage' },
        { reg: '^\\s*#?体力推送(?:列表|状态|查询)\\s*$', fnc: 'listSubs' },
      ],
    })

    if (cfg.resin_push_enable !== false) {
      this.task = {
        name: 'xhh-TL-体力阈值推送',
        cron,
        fnc: () => this.checkAll(),
        log: false,
      }
    } else {
      this.task = { name: '', fnc: '', cron: '' }
    }
  }

  // -------- 指令：设置 --------
  async setGs(e) {
    return this._set(e, 'gs')
  }

  async setSr(e) {
    return this._set(e, 'sr')
  }

  async _set(e, game) {
    const meta = GAME_META[game]
    if (!e.isGroup) {
      e.reply('体力推送只能在群里设置哦，请在需要接收提醒的群内发送该指令~', true)
      return true
    }
    const m = (e.msg || '').match(/(\d{1,3})/)
    const threshold = m ? Number(m[1]) : NaN
    if (!Number.isFinite(threshold) || threshold <= 0) {
      e.reply(`请带上阈值，例如：#${meta.label}体力推送 ${game === 'gs' ? 130 : 200}`, true)
      return true
    }
    if (threshold > meta.cap) {
      e.reply(`阈值过大啦，${meta.unit}最多设到 ${meta.cap}`, true)
      return true
    }

    const subs = loadSubs()
    subs[game][String(e.user_id)] = {
      threshold,
      group: String(e.group_id),
      armed: true,
    }
    saveSubs(subs)
    e.reply(
      `✅ 已开启${meta.label}体力推送\n当${meta.unit} ≥ ${threshold} 时，会在本群@你并发送体力图\n（达到后只提醒一次，回落后自动重新监控）`,
      true,
    )
    return true
  }

  // -------- 指令：关闭 --------
  async offGs(e) {
    return this._off(e, 'gs')
  }

  async offSr(e) {
    return this._off(e, 'sr')
  }

  async _off(e, game) {
    const meta = GAME_META[game]
    const subs = loadSubs()
    const qq = String(e.user_id)
    if (subs[game][qq]) {
      delete subs[game][qq]
      saveSubs(subs)
      e.reply(`已关闭${meta.label}体力推送`, true)
    } else {
      e.reply(`你还没有开启${meta.label}体力推送`, true)
    }
    return true
  }

  // -------- 指令：用法 --------
  async usage(e) {
    e.reply(
      [
        '📌 体力阈值推送用法',
        '#原神体力推送 130   原粹树脂达到130时@你并发图',
        '#星铁体力推送 200   开拓力达到200时@你并发图',
        '#原神体力推送关闭 / #星铁体力推送关闭',
        '#体力推送列表        查看你的订阅',
        '（需在群里设置，仅在该群@提醒；达到后提醒一次，回落后自动恢复监控）',
      ].join('\n'),
      true,
    )
    return true
  }

  // -------- 指令：列表 --------
  async listSubs(e) {
    const subs = loadSubs()
    const qq = String(e.user_id)
    const lines = ['📋 你的体力推送订阅：']
    let has = false
    for (const game of ['gs', 'sr']) {
      const sub = subs[game][qq]
      if (sub) {
        has = true
        const meta = GAME_META[game]
        lines.push(
          `· ${meta.label}：${meta.unit} ≥ ${sub.threshold}（群 ${sub.group}）${sub.armed ? '' : ' [已提醒，待回落]'}`,
        )
      }
    }
    if (!has) lines.push('（暂无，发送 #原神体力推送 130 试试）')
    e.reply(lines.join('\n'), true)
    return true
  }

  // ============ 定时检查 ============
  async checkAll() {
    const cfg = readPluginConfig()
    if (cfg.resin_push_enable === false) return
    const subs = loadSubs()

    let changed = false
    const scale = getRenderScaleStyle(cfg, 1.0)
    const tl = new TL()

    for (const game of ['gs', 'sr']) {
      const meta = GAME_META[game]
      for (const qq of Object.keys(subs[game])) {
        const sub = subs[game][qq]
        if (!sub || !sub.group) continue
        try {
          const item = await this.queryResin(tl, qq, game, sub.group)
          if (!item || item === '没有' || item === '过期' || item === false) continue

          const cur = Number(item[meta.field]) || 0

          // 回落到阈值以下 → 重新武装
          if (cur < sub.threshold) {
            if (!sub.armed) {
              sub.armed = true
              changed = true
            }
            continue
          }

          // 达到阈值且仍处于武装状态 → 推送一次
          if (sub.armed) {
            const ok = await this.pushOne(tl, qq, game, sub, item, scale)
            if (ok) {
              sub.armed = false
              changed = true
            }
          }
        } catch (err) {
          logger?.error?.(`[xhh-TL][体力推送] ${meta.label} ${qq} 检查失败: ${err.message}`)
        }
      }
    }

    if (changed) saveSubs(subs)
  }

  /** 用「假 e + Runtime」复用 TL.note 查询体力 */
  async queryResin(tl, qq, game, groupId) {
    const fakeE = this.makeFakeE(qq, groupId)
    return await tl.note(fakeE, game, true, null, null)
  }

  /** 出图并在群里 @ 用户发送 */
  async pushOne(tl, qq, game, sub, item, scale) {
    const meta = GAME_META[game]
    const fakeE = this.makeFakeE(qq, sub.group)

    // 群昵称
    let qqname = String(qq)
    try {
      const member = fakeE.group?.pickMember?.(qq)
      if (member?.card || member?.nickname) qqname = member.card || member.nickname
    } catch (_) {}

    let imgSeg = null
    try {
      imgSeg = await tl.renderPortraitCard(fakeE, game, item, { qq, qqname }, scale)
    } catch (err) {
      logger?.error?.(`[xhh-TL][体力推送] 渲染失败 ${qq}: ${err.message}`)
    }
    if (!imgSeg) return false

    const cur = Number(item[meta.field]) || 0
    const max = Number(item[meta.maxField]) || 0
    const full = max > 0 && cur >= max
    const tip = full
      ? `你的${meta.unit}已经满啦(${cur}/${max})，快去消耗吧~`
      : `你的${meta.unit}已达到 ${cur}${max ? '/' + max : ''}，别溢出啦~`

    try {
      const group = fakeE.group || Bot.pickGroup(Number(sub.group))
      await group.sendMsg([segment.at(Number(qq)), ` ${tip}\n`, imgSeg])
      logger?.mark?.(`[xhh-TL][体力推送] 已推送 ${meta.label} 给 ${qq}@群${sub.group}`)
      return true
    } catch (err) {
      logger?.error?.(`[xhh-TL][体力推送] 发送失败 ${qq}@群${sub.group}: ${err.message}`)
      return false
    }
  }

  /** 构造一个带 runtime、reply 无副作用的假事件，供 TL 查询/渲染复用 */
  makeFakeE(qq, groupId) {
    const bot = Bot
    let group = null
    try {
      group = bot.pickGroup?.(Number(groupId))
    } catch (_) {}
    const fakeE = {
      user_id: qq,
      self_id: bot?.uin,
      isGroup: true,
      group_id: groupId,
      group,
      message: [],
      msg: '',
      reply: () => {}, // 定时场景下吞掉内部提示，避免误发
      sender: { nickname: String(qq) },
    }
    fakeE.runtime = new Runtime(fakeE)
    return fakeE
  }
}

export default resinPush
