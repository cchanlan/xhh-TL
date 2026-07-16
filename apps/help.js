/**
 * #小火花帮助 / #小花火帮助 — 指令总览图
 * 图标使用本插件 resources/help/icons 内独立角色/游戏图（原神用原神角色，星铁用星铁角色）
 */
import path from 'path'
import fs from 'fs'
import moment from 'moment'
import plugin from '../../../lib/plugins/plugin.js'
import { extractRenderBuffer } from '../utils/renderImage.js'
import { getRenderScaleStyle, pickHelpBgImage, readPluginConfig } from '../utils/pluginConfig.js'

const pluginDir = path.join(process.cwd(), 'plugins/xhh-TL')
/** 帮助图标目录（相对插件 resources，渲染时拼到 ppath） */
const HELP_ICON_DIR = 'help/icons'

function config() {
  return readPluginConfig()
}

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf-8'))
    return pkg.version || '1.0.0'
  } catch (_) {
    return '1.0.0'
  }
}

/** 将 icon 文件名转为渲染用相对路径（相对 resources/） */
function iconSrc(icon) {
  if (!icon) return ''
  // 已是完整相对路径
  if (String(icon).includes('/')) return icon
  return `${HELP_ICON_DIR}/${icon}`
}

/** 为指令表补全 icon 图片路径 */
function withIconSrc(groups) {
  return groups.map((g) => ({
    ...g,
    list: (g.list || []).map((item) => ({
      ...item,
      iconSrc: iconSrc(item.icon),
    })),
  }))
}

/**
 * 按功能分组的指令表（对应 apps 内全部 reg）
 * icon 为本插件 resources/help/icons 下文件名，全部互不重复：
 * - 原神相关 → gs-* 原神角色
 * - 星铁相关 → sr-* 星铁角色
 * - 多游戏/管理 → multi / zzz / bh3 / spark 等
 */
export function buildHelpGroups() {
  return [
    {
      group: '体力查询',
      desc: 'TL · 四游戏实时体力',
      color: 'blue',
      list: [
        {
          icon: 'multi.webp',
          title: '#体力 #tl #体力总览',
          desc: '一次查原神 / 星铁 / 绝区零 / 崩三',
        },
        {
          icon: 'gs-纳西妲.webp',
          title: '#原神体力 #ystl',
          desc: '仅查原神体力',
        },
        {
          icon: 'sr-花火.webp',
          title: '#星铁体力 #xttl *体力',
          desc: '仅查星穹铁道体力',
        },
        {
          icon: 'zzz-battery.webp',
          title: '#绝区零体力 #zzztl',
          desc: '仅查绝区零体力',
        },
        {
          icon: 'bh3.webp',
          title: '#崩三体力 #bbbtl',
          desc: '仅查崩坏3体力',
        },
        {
          icon: 'bh3-stamina.webp',
          title: '#崩三扫码绑定 #bbb扫码绑定',
          desc: '独立扫码绑定崩坏3（全渠道服）',
        },
        {
          icon: 'mask.webp',
          title: '#开启体力uid / #关闭体力uid',
          desc: '控制卡片是否显示游戏 UID',
        },
        {
          icon: 'plugin.webp',
          title: '#体力插件更新 #小花火体力更新',
          desc: '拉取插件更新；加「强制」放弃本地修改',
        },
      ],
    },
    {
      group: '原神 · 成绩汇总',
      desc: '个人通关 · 需绑定 Cookie',
      color: 'cyan',
      list: [
        {
          icon: 'gs-钟离.webp',
          title: '#全部深渊',
          desc: '螺旋 + 危战 + 小剧诗 三列合一',
        },
        {
          icon: 'gs-芙宁娜.webp',
          title: '#小剧诗 #小幻想',
          desc: '幻想真境剧诗关键关卡通关速览',
        },
        {
          icon: 'gs-那维莱特.webp',
          title: '#小剧诗上期 #上期小幻想',
          desc: '查询上期小剧诗成绩',
        },
        {
          icon: 'gs-八重神子.webp',
          title: '#幻想剧诗 #幻想角色',
          desc: '当期限制元素 / 特邀 / 可用角色',
        },
        {
          icon: 'gs-甘雨.webp',
          title: '#幻想202607 #幻想2026年7月',
          desc: '按月份回看幻想剧诗角色池',
        },
      ],
    },
    {
      group: '星铁 · 全部深渊',
      desc: '个人成绩四合一 · * 前缀',
      color: 'purple',
      list: [
        {
          icon: 'sr-黄泉.webp',
          title: '*全部深渊 *深渊总览',
          desc: '混沌 / 虚构 / 末日 / 异相 一张图',
        },
        {
          icon: 'sr-知更鸟.webp',
          title: '*深渊汇总 #星铁全部深渊',
          desc: '同上；需 * 或「星铁」前缀',
        },
        {
          icon: 'sr-流萤.webp',
          title: '*全部深渊上期 *上期全部深渊',
          desc: '查询上期四模式成绩',
        },
      ],
    },
    {
      group: '原神 · 版本配置',
      desc: 'Nanoka 静态 · 不查个人成绩',
      color: 'orange',
      list: [
        {
          icon: 'gs-雷电将军.webp',
          title: '#版本深渊 #版本螺旋',
          desc: '深境螺旋祝福与楼层（正式服）',
        },
        {
          icon: 'gs-胡桃.webp',
          title: '#下期深渊 #下期螺旋',
          desc: '测试包最新深渊配置',
        },
        {
          icon: 'gs-夜兰.webp',
          title: '#版本剧诗 #下期剧诗',
          desc: '幻想真境剧诗限制元素与 Boss',
        },
        {
          icon: 'gs-神里绫华.webp',
          title: '#版本危战 #幽境危战',
          desc: '幽境危战强敌；#下期危战 看下期',
        },
        {
          icon: 'gs-可莉.webp',
          title: '#版本深渊列表 #版本危战列表',
          desc: '最近期数一览（剧诗同理）',
        },
        {
          icon: 'gs-刻晴.webp',
          title: '上期 / 第N期',
          desc: '接在版本指令后：#版本深渊上期',
        },
      ],
    },
    {
      group: '星铁 · 版本配置',
      desc: 'Nanoka · * / 星铁 前缀',
      color: 'pink',
      list: [
        {
          icon: 'sr-景元.webp',
          title: '*版本混沌 *版本深渊',
          desc: '混沌回忆配置；*下期混沌 看下期',
        },
        {
          icon: 'sr-银狼.webp',
          title: '*版本虚构 *下期虚构',
          desc: '虚构叙事（maze_extra / story）',
        },
        {
          icon: 'sr-刃.webp',
          title: '*版本末日 *下期末日',
          desc: '末日幻影（maze_boss）',
        },
        {
          icon: 'sr-星期日.webp',
          title: '*版本异相 *下期异相',
          desc: '异相仲裁（maze_peak）',
        },
        {
          icon: 'sr-黑天鹅.webp',
          title: '*版本混沌列表 等',
          desc: '各模式最近期数；可接上期/第N期',
        },
      ],
    },
    {
      group: '管理 · 其它',
      desc: '主人 / 运维',
      color: 'gray',
      list: [
        {
          icon: 'spark.webp',
          title: '#小火花帮助 #小花火帮助',
          desc: '显示本指令总览图',
        },
        {
          icon: 'active.webp',
          title: '#清理临时文件 #小花火清理tmp',
          desc: '主人：清理 data/tmp（加「全部」清空）',
        },
      ],
    },
  ]
}

export class help extends plugin {
  constructor() {
    super({
      name: '[小花火]帮助',
      dsc: '小火花/小花火 指令帮助图',
      event: 'message',
      priority: 500,
      rule: [
        {
          // #小火花帮助 / #小花火帮助 / #xhh帮助 / #xhh-TL帮助 / 小火花菜单 / #xhh help …
          reg: '^\\s*#?(?:小火花|小花火|xhh-?TL|xhh)(?:插件)?\\s*(?:命令|帮助|菜单|help|说明|功能|指令|使用说明)\\s*$',
          fnc: 'help',
        },
      ],
    })
  }

  async help(e) {
    try {
      if (!e.runtime?.render) {
        return e.reply('渲染引擎不可用（e.runtime.render）', true)
      }

      const groups = withIconSrc(buildHelpGroups())
      const cmdCount = groups.reduce((n, g) => n + (g.list?.length || 0), 0)
      const version = readVersion()
      const note =
        '<b>提示</b>：指令大多可省略 #；星铁相关请带 <b>*</b> 或「星铁」前缀，避免与原神冲突。' +
        'Nanoka 版本指令支持 <b>列表 / 上期 / 第N期</b>；个人成绩类需绑定 Cookie / stoken。' +
        '支持 @他人查询（对方需已绑定）。'

      const bgImage = pickHelpBgImage({ logTag: 'xhh-TL[help]' })

      const data = {
        title: '小火花帮助',
        subTitle: '体力 · 全部深渊 · 幻想剧诗 · Nanoka 版本配置',
        version,
        cmdCount,
        generatedAt: moment().format('YYYY-MM-DD HH:mm'),
        groups,
        note,
        bgImage,
        saveId: 'help',
      }

      const renderScale = getRenderScaleStyle(config(), 1.5)
      const tplFile = path.join(pluginDir, 'resources/help/help.html')
      const renderResult = await e.runtime.render('xhh-TL', 'help', data, {
        retType: 'base64',
        imgType: 'png',
        beforeRender({ data: d }) {
          return {
            ...d,
            imgType: 'png',
            sys: { scale: renderScale },
            ppath: '../../../../plugins/xhh-TL/resources/',
            tplFile,
            saveId: 'help',
          }
        },
      })

      const image = extractRenderBuffer(renderResult)
      if (!image) {
        return e.reply('帮助图渲染失败，请稍后重试', true)
      }
      return e.reply(segment.image(image))
    } catch (err) {
      logger?.error?.('[xhh-TL][help]', err)
      return e.reply(`帮助图渲染失败：${err.message || err}`, true)
    }
  }
}
