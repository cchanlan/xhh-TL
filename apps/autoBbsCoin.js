/**
 * 米游币社区任务 —— 自动做任务（原神 / 星铁 / 绝区零 版块）
 *
 * 与 autoSign.js（游戏签到领原石）是两套独立功能，互不影响：
 *   autoSign  : 游戏 UID 维度，认证 cookie_token，签到领原石
 *   本模块    : 米游社账号(stuid) 维度，认证 stoken，做社区任务赚米游币
 *
 * 移植自 xiaoyao-cvs-plugin 的「米游社签到」，改为本插件的 opt-in 订阅形态（仿 autoSign）：
 *   - 用户发 #开启自动米游币 后才纳入每日自动任务
 *   - 每日 cron 按「订阅群」分组，跑完汇总成一张图发到群里
 *   - 所有指令仅支持群内使用，私聊一律拒绝
 *
 * 指令（仅群内）：
 *   #开启自动米游币 / #自动米游币          开启每日自动做任务
 *   #关闭自动米游币                        关闭
 *   #米游币签到                            立即跑一次并回报
 *   #米游币余额                            只查余额，不做任务
 *   #自动米游币列表                        查看自己的订阅
 *
 * 注：查余额用「#米游币余额」而非「#米游币查询」，后者被 xiaoyao-cvs-plugin 占用。
 */

import fs from 'fs'
import path from 'path'
import moment from 'moment'
import plugin from '../../../lib/plugins/plugin.js'
import Runtime from '../../../lib/plugins/runtime.js'
import { runCoinTask, queryCoin, listBbsAccounts, FORUMS } from '../utils/bbsCoinClient.js'
import { extractRenderBuffer, toWebp } from '../utils/renderImage.js'
import { quoteEnabled } from '../utils/replyHelper.js'
import {
  config,
  pluginDir,
  getRenderScaleStyle,
  pickHelpBgImage,
  toFileUrl,
  toDataUrl,
} from '../utils/pluginConfig.js'

const DATA_DIR = path.join(pluginDir, 'data')
const CONFIG_FILE = path.join(DATA_DIR, 'bbs_coin.json')

// 默认清晨随机分钟；错开 autoSign 的 00:23，避免同时段风控叠加
const DEFAULT_CRON = '41 6 * * *'

// 汇总图各版块行图标（复用帮助图标）
const GAME_ICON = {
  gs: 'help/icons/gs-logo.webp',
  sr: 'help/icons/sr-logo.webp',
  zzz: 'help/icons/zzz.webp',
}

// ============ 配置读写 ============
// 结构：{ "<qq>": { group: "<gid>" } }
function ensureDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  } catch (_) {}
}

function loadSubs() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}
    }
  } catch (err) {
    logger?.error?.(`[xhh-TL][米游币] 读取配置失败: ${err.message}`)
  }
  return {}
}

function saveSubs(subs) {
  try {
    ensureDir()
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(subs, null, 2))
  } catch (err) {
    logger?.error?.(`[xhh-TL][米游币] 保存配置失败: ${err.message}`)
  }
}

/** 解析配置里的版块列表，非法值回落到全部 */
function resolveGames() {
  const raw = String(config().bbs_coin_games || '').trim()
  if (!raw) return Object.keys(FORUMS)
  const list = raw
    .split(/[,，\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter((x) => FORUMS[x])
  return list.length ? list : Object.keys(FORUMS)
}

export class autoBbsCoin extends plugin {
  constructor() {
    const cfg = config()
    const cron = cfg.bbs_coin_cron || DEFAULT_CRON

    super({
      name: '[小火花]米游币社区任务',
      dsc: '原神/星铁/绝区零 版块签到+看帖+点赞+分享，每日自动赚米游币',
      event: 'message',
      priority: -Infinity,
      rule: [
        // 关闭 —— 必须先于开启匹配
        { reg: '^\\s*#?(?:关闭自动米游币|自动米游币\\s*(?:关闭|关|取消|停止))\\s*$', fnc: 'off' },
        // 开启
        { reg: '^\\s*#?(?:开启自动米游币|自动米游币\\s*(?:开启|开|打开)?)\\s*$', fnc: 'on' },
        // 立即执行
        { reg: '^\\s*#?米游币(?:签到|任务)\\s*$', fnc: 'runNow' },
        // 查余额（避开 xiaoyao 占用的 #米游币查询）
        { reg: '^\\s*#?米(?:游)?币余额\\s*$', fnc: 'balance' },
        // 列表
        { reg: '^\\s*#?自动米游币(?:列表|状态)\\s*$', fnc: 'listSubs' },
      ],
    })

    if (cfg.bbs_coin_enable !== false) {
      this.task = {
        name: 'xhh-TL-米游币社区任务',
        cron,
        fnc: () => this.runAll(),
        log: false,
      }
    } else {
      this.task = { name: '', fnc: '', cron: '' }
    }
  }

  _disabled(e) {
    if (config().bbs_coin_enable === false) {
      e.reply('米游币任务功能已被管理员关闭~', quoteEnabled())
      return true
    }
    return false
  }

  // 与 autoSign 一致：签到相关一律不支持私聊
  _groupOnly(e) {
    if (!e.isGroup) {
      e.reply('米游币任务仅支持在群内使用，请到群里发送该指令~', quoteEnabled())
      return true
    }
    return false
  }

  // -------- 开启订阅 --------
  async on(e) {
    if (this._groupOnly(e)) return true
    if (this._disabled(e)) return true

    // 校验必须有可用 stoken 账号，避免「订阅成功但 cron 永远跑不动」的静默失效
    const accounts = await listBbsAccounts(e.user_id, e)
    if (!accounts.length) {
      e.reply(
        '没有可用的米游社账号，请先【#扫码登录】~',
        true,
      )
      return true
    }

    const subs = loadSubs()
    subs[String(e.user_id)] = { group: String(e.group_id) }
    saveSubs(subs)

    const games = resolveGames()
      .map((g) => FORUMS[g].name)
      .join('/')
    e.reply(
      `✅ 已开启每日自动米游币（名下 ${accounts.length} 个米游社账号）\n版块：${games}\n每天将自动做任务，本群统一发送汇总图\n发送 #米游币签到 可立即跑一次`,
      true,
    )
    return true
  }

  // -------- 关闭订阅 --------
  async off(e) {
    if (this._groupOnly(e)) return true
    const subs = loadSubs()
    const qq = String(e.user_id)
    if (subs[qq]) {
      delete subs[qq]
      saveSubs(subs)
      e.reply('已关闭自动米游币', quoteEnabled())
    } else {
      e.reply('你还没有开启自动米游币', quoteEnabled())
    }
    return true
  }

  // -------- 列表 --------
  async listSubs(e) {
    if (this._groupOnly(e)) return true
    const subs = loadSubs()
    const sub = subs[String(e.user_id)]
    if (!sub) {
      e.reply('📋 你还没有开启自动米游币（发送 #开启自动米游币 试试）', quoteEnabled())
      return true
    }
    e.reply(
      `📋 自动米游币：已开启${sub.group ? `（群 ${sub.group} 回报）` : ''}\n版块：${resolveGames().map((g) => FORUMS[g].name).join('/')}`,
      true,
    )
    return true
  }

  // -------- 查余额 --------
  async balance(e) {
    if (this._groupOnly(e)) return true
    const accounts = await listBbsAccounts(e.user_id, e)
    if (!accounts.length) {
      e.reply('没有可用的米游社账号，请先【#扫码登录】~', quoteEnabled())
      return true
    }
    const lines = ['💰 米游币余额：']
    for (const acc of accounts) {
      const r = await queryCoin(acc)
      lines.push(
        r.ok
          ? `· ${acc.stuid}：${r.total} 币，今日剩余可获取 ${r.canGet}`
          : `· ${acc.stuid}：${r.msg}`,
      )
    }
    e.reply(lines.join('\n'), quoteEnabled())
    return true
  }

  // -------- 立即执行 --------
  async runNow(e) {
    if (this._groupOnly(e)) return true
    if (this._disabled(e)) return true

    const accounts = await listBbsAccounts(e.user_id, e)
    if (!accounts.length) {
      e.reply(
        '没有可用的米游社账号，请先【#扫码登录】~',
        true,
      )
      return true
    }

    const games = resolveGames()
    e.reply(
      `开始米游币任务：${accounts.length} 个账号 × ${games.length} 个版块，预计 ${this._estimate(accounts.length, games.length)}内完成，请稍候~`,
      true,
    )

    const results = await this.runAccounts(accounts, games, e)
    const lines = ['米游币任务结果：']
    for (const r of results) {
      if (r.code === 'ok') {
        const detail = r.rows
          .map((x) => `${x.name}${x.signed ? '✓' : '✗'}${x.err ? `(${x.err})` : ''}`)
          .join(' ')
        lines.push(`· ${r.stuid}：+${r.gained} 币，共 ${r.after}\n  ${detail}`)
      } else {
        lines.push(`· ${r.stuid}：${r.msg}`)
      }
    }
    e.reply(lines.join('\n'), quoteEnabled())
    return true
  }

  /** 逐账号跑任务，账号间留间隔 */
  async runAccounts(accounts, games, e = null) {
    const verifyAddr = e ? config().auto_sign_verify_addr || '' : ''
    const results = []
    for (const acc of accounts) {
      try {
        results.push(await runCoinTask(acc, { games, e, verifyAddr }))
      } catch (err) {
        logger?.error?.(`[xhh-TL][米游币] ${acc.stuid} 任务异常: ${err.message}`)
        results.push({ code: 'fail', msg: '任务异常', stuid: acc.stuid, rows: [], gained: 0, after: 0 })
      }
      // 账号间间隔，降低风控
      await new Promise((r) => setTimeout(r, 2000 + Math.floor(Math.random() * 2000)))
    }
    return results
  }

  // ============ 定时全量执行 ============
  // 按订阅群分组：一次性把该群所有订阅者跑完，汇总成一张图发到群里
  async runAll() {
    const cfg = config()
    if (cfg.bbs_coin_enable === false) return
    const subs = loadSubs()
    const games = resolveGames()

    // groupId -> [qq]
    const plan = {}
    for (const [qq, sub] of Object.entries(subs)) {
      if (!sub?.group) continue
      const gid = String(sub.group)
      ;(plan[gid] || (plan[gid] = [])).push(qq)
    }

    // task 是 log:false（跑几分钟，不想刷屏 [开始处理]/[完成]），Yunzai 那两行会降级成 debug。
    // 加上「全失败则不出图」，整条链路可以一行日志都不留，看着就像定时任务压根没触发。
    // 这一头一尾两条 mark 是排查时唯一能证明「跑过」的锚点，别删。
    const totalSubs = Object.values(plan).reduce((n, l) => n + l.length, 0)
    logger?.mark?.(
      `[xhh-TL][米游币] 定时任务开始：${Object.keys(plan).length} 个群 / ${totalSubs} 位订阅者`,
    )

    for (const gid of Object.keys(plan)) {
      const startTs = Date.now()
      const agg = {
        participants: new Set(),
        gained: 0,
        totalCoin: 0,
        failed: 0,
        rows: {},
      }
      for (const g of games) {
        agg.rows[g] = { signed: 0, read: 0, vote: 0, share: 0, err: 0 }
      }

      for (const qq of plan[gid]) {
        try {
          const authE = this.makeFakeE(qq, gid)
          const accounts = await listBbsAccounts(qq, authE)
          if (!accounts.length) {
            logger?.mark?.(`[xhh-TL][米游币] QQ ${qq} 无可用米游社账号，跳过`)
            continue
          }
          agg.participants.add(String(qq))
          const results = await this.runAccounts(accounts, games, null)
          for (const r of results) {
            if (r.code === 'ok' || r.code === 'done') {
              agg.gained += r.gained || 0
              agg.totalCoin += r.after || 0
            } else {
              agg.failed++
              logger?.mark?.(`[xhh-TL][米游币] ${r.stuid} 失败(${r.code})：${r.msg || '未知'}`)
            }
            for (const row of r.rows || []) {
              const bucket = agg.rows[row.game]
              if (!bucket) continue
              if (row.signed) bucket.signed++
              bucket.read += row.read
              bucket.vote += row.vote
              bucket.share += row.share
              if (row.err) bucket.err++
            }
          }
        } catch (err) {
          logger?.error?.(`[xhh-TL][米游币] ${qq} 定时任务失败: ${err.message}`)
        }
      }

      try {
        await this.reportGroup(gid, agg, games, this._fmtCost(Date.now() - startTs))
      } catch (err) {
        logger?.error?.(`[xhh-TL][米游币] 群 ${gid} 汇总回报失败: ${err.message}`)
      }
    }

    logger?.mark?.('[xhh-TL][米游币] 定时任务结束')
  }

  /**
   * 预估耗时。每版块约 13 次请求（签到1+列表1+看帖5+点赞5+分享1），请求间 jitter 均值 2 秒；
   * 另有每账号查询/复查各 1 次、账号间 3 秒间隔。
   * 原来按「账号×版块=分钟数」报，3 版块说 3 分钟、实测 1 分 28 秒，偏保守一倍。
   */
  _estimate(accountCount, gameCount) {
    const seconds = accountCount * (gameCount * 13 * 2 + 2 * 2 + 3)
    return this._fmtCost(seconds * 1000)
  }

  /** 毫秒 → “X小时Y分Z秒” */
  _fmtCost(ms) {
    const s = Math.max(0, Math.round(ms / 1000))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    let out = ''
    if (h) out += `${h}小时`
    if (h || m) out += `${m}分`
    out += `${sec}秒`
    return out
  }

  /** 渲染并发送某群的米游币汇总图 */
  async reportGroup(gid, agg, games, totalCost) {
    // 配置里开了哪些版块就画哪些行，全 0 的也照画。
    // 早先会把「一件事没做」的行 continue 掉、行空则整张图不发，
    // 结果「今日已拿满」和「任务没触发」在群里长得一模一样，只能翻日志分辨。
    const rows = []
    for (const game of games) {
      const b = agg.rows[game]
      if (!b) continue
      rows.push({
        name: FORUMS[game].name,
        icon: toFileUrl(path.join(pluginDir, 'resources', GAME_ICON[game])),
        signed: b.signed,
        read: b.read,
        vote: b.vote,
        share: b.share,
        err: b.err,
      })
    }
    if (!rows.length) {
      // bbs_coin_games 配置为空或所有订阅者均无可用账号，仍然出图说明情况
      logger?.mark?.(`[xhh-TL][米游币] 群 ${gid} 无可渲染版块，仍发空图`)
    }

    // 一件事都没做时给一句话说明，免得三行全 0 被当成故障
    let note = ''
    if (!agg.participants.size) {
      note = '本群无可用米游社账号，请发送 #扫码登录 绑定'
    } else if (!rows.length) {
      note = '无可渲染版块，请检查 bbs_coin_games 配置'
    } else {
      const idle = !rows.some((r) => r.signed || r.read || r.vote || r.share)
      if (idle) {
        note = agg.failed
          ? '本次未能完成，多为 stoken 失效或撞风控，可发送 #米游币签到 重试'
          : '今日米游币已拿满，无需重复任务'
      }
    }

    const headerIcons = [...agg.participants]
      .slice(0, 6)
      .map((qq) => `https://q1.qlogo.cn/g?b=qq&s=640&nk=${qq}.jpg`)

    const image = await this.renderSummary({
      rows,
      gained: agg.gained,
      totalCoin: agg.totalCoin,
      failed: agg.failed,
      note,
      totalCost,
      headerIcons,
    })
    if (!image) return
    try {
      const group = Bot.pickGroup(Number(gid))
      await group.sendMsg(segment.image(image))
      logger?.mark?.(`[xhh-TL][米游币] 已发送群 ${gid} 汇总图（+${agg.gained} 币，${rows.length} 个版块${note ? `，${note}` : ''}）`)
    } catch (err) {
      logger?.error?.(`[xhh-TL][米游币] 群 ${gid} 汇总图发送失败: ${err.message}`)
    }
  }

  /** 组装 renderData 并出图；定时场景借 Runtime 拿 render 能力 */
  async renderSummary({ rows, gained, totalCoin, failed, note, totalCost, headerIcons }) {
    const cfg = config()
    // 主题优先级：米游币 → 自动签到 → 角色持有率 → 全部深渊 → 浅色
    const themeRaw = String(
      cfg.bbs_coin_theme || cfg.auto_sign_theme || cfg.hold_rate_theme || cfg.gs_all_abyss_theme || 'light',
    ).toLowerCase()
    const theme = themeRaw === 'dark' ? 'dark' : 'light'
    const renderScale = getRenderScaleStyle(cfg, 2.0)
    // CSS background 用 file:// 有截图竞态（见 pluginConfig.toDataUrl 注释），内联成 data URI
    const bgImage = toDataUrl(pickHelpBgImage({ logTag: 'xhh-TL][bbsCoin' }))
    const coinIcon = toFileUrl(path.join(pluginDir, 'resources/help/icons/signin.webp'))
    const tplFile = path.join(pluginDir, 'resources/bbs_coin/bbs_coin.html')
    const ppath = '../../../../plugins/xhh-TL/resources/'

    const renderData = {
      theme,
      bgImage,
      coinIcon,
      headerIcons,
      gained,
      totalCoin,
      failed,
      note,
      totalCost,
      rows,
      generatedAt: moment().format('MM-DD HH:mm'),
    }

    const fakeE = this.makeFakeE('0', '')
    if (!fakeE.runtime?.render) {
      logger?.error?.('[xhh-TL][米游币] 渲染引擎不可用（runtime.render）')
      return null
    }
    try {
      const renderResult = await fakeE.runtime.render('xhh-TL', 'bbs_coin', renderData, {
        retType: 'base64',
        imgType: 'png',
        beforeRender({ data }) {
          return {
            ...data,
            imgType: 'png',
            sys: { scale: renderScale },
            ppath,
            tplFile,
            saveId: 'bbs_coin',
          }
        },
      })
      const image = await toWebp(extractRenderBuffer(renderResult))
      if (!image) throw new Error('渲染结果中没有图片数据')
      return image
    } catch (err) {
      logger?.error?.('[xhh-TL][米游币] 渲染失败:', err)
      return null
    }
  }

  /** 构造假 e，供定时场景 render 复用 */
  makeFakeE(qq, groupId) {
    const bot = Bot
    let group = null
    if (groupId) {
      try { group = bot.pickGroup?.(Number(groupId)) } catch (_) {}
    }
    const fakeE = {
      user_id: qq,
      self_id: bot?.uin,
      isGroup: !!groupId,
      group_id: groupId || undefined,
      group,
      message: [],
      msg: '',
      reply: () => {},
      sender: { nickname: String(qq) },
    }
    try { fakeE.runtime = new Runtime(fakeE) } catch (_) {}
    return fakeE
  }
}

export default autoBbsCoin
