/**
 * #小火花帮助 — 指令总览图
 * 图标使用本插件 resources/help/icons 内独立角色/游戏图（原神用原神角色，星铁用星铁角色）
 */
import path from 'path'
import fs from 'fs'
import moment from 'moment'
import plugin from '../../../lib/plugins/plugin.js'
import { pickHelpBgImage, pluginDir } from '../utils/pluginConfig.js'
import { quoteEnabled } from '../utils/replyHelper.js'
import { renderTpl } from '../utils/render.js'
import { filterHelpGroups, disabledModuleLabels, isModuleEnabled } from '../utils/modules.js'

/** 帮助图标目录（相对插件 resources，渲染时拼到 ppath） */
const HELP_ICON_DIR = 'help/icons'

/**
 * 出图服务不可用时的文字兜底。
 * 与帮助图同源（同一份 groups），所以关掉的模块在这里同样不出现。
 */
function groupsToText(groups) {
  const lines = ['小火花指令一览（出图服务不可用，先发文字版）']
  for (const g of groups) {
    lines.push('', `【${g.group}】`)
    for (const item of g.list || []) {
      lines.push(`  ${item.title}${item.desc ? `　— ${item.desc}` : ''}`)
    }
  }
  return lines.join('\n')
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

/** 为指令表补全 icon 图片路径（支持 icon2 双图标并排，如原神+星铁 logo） */
function withIconSrc(groups) {
  return groups.map((g) => ({
    ...g,
    list: (g.list || []).map((item) => ({
      ...item,
      iconSrc: iconSrc(item.icon),
      icon2Src: item.icon2 ? iconSrc(item.icon2) : '',
    })),
  }))
}

/**
 * 允许复用的图标：原神条目多、gs-* 图标不够分，这几处复用是结构性的、不是撞图。
 * 数过：resources/help/icons 里 gs-* 共 24 个，而标了 gs-* 的条目有 26 条，
 * 所以至少 2 处必然复用 —— 「全部图标互不重复」这个目标本身做不到，别再按它改。
 * 只有新出现的、不在这张表里的重复才值得告警。
 */
const DUP_ICON_TOLERATED = new Set(['gs-胡桃.webp', 'gs-钟离.webp', 'gs-夜兰.webp'])

/**
 * 图标唯一性自检：撞图时告警（新增指令时容易撞图）
 * 只告警不阻断出图，重复项会在日志里点名；已知的结构性复用见 DUP_ICON_TOLERATED
 */
function checkIconUnique(groups) {
  const seen = new Map()
  const dup = []
  for (const g of groups) {
    for (const item of g.list || []) {
      for (const icon of [item.icon, item.icon2].filter(Boolean)) {
        const prev = seen.get(icon)
        // 白名单里的图标只记录、不告警：它们必然重复，每次出图都刷日志只会掩盖真问题
        if (prev && !DUP_ICON_TOLERATED.has(icon)) {
          dup.push(`${icon} 同时用于「${prev}」与「${item.title}」`)
        } else if (!prev) {
          seen.set(icon, item.title)
        }
      }
    }
  }
  if (dup.length) {
    logger?.warn?.(`[xhh-TL][help] 图标重复 ${dup.length} 处：\n  ${dup.join('\n  ')}`)
  }
  return dup
}

/**
 * 按功能分组的指令表（对应 apps 内全部 reg）
 * icon 为本插件 resources/help/icons 下文件名，尽量互不重复
 * （gs-* 数量不够分，有 3 处结构性复用，见 DUP_ICON_TOLERATED；新增条目仍请先跑 checkIconUnique）：
 * - 原神相关 → gs-* 原神角色
 * - 星铁相关 → sr-* 星铁角色
 * - 绝区零 → zzz-*（zzz.webp 游戏图标 / zzz-battery 电量 / zzz-01~05 角色圆头像）
 * - 鸣潮 → ww-01~03 角色头像
 * - 多游戏 / 管理 → multi / signin / mask / plugin / active / spark
 */
export function buildHelpGroups() {
  // 鸣潮有独立开关：关掉时这条里连它的名字和别名都不列，
  // 否则用户照着帮助图发 #鸣潮体力 却毫无反应（note_ 已被 waves 挡住）
  const wwOn = isModuleEnabled('waves')
  const soloGames = ['原神', '星铁', '绝区零'].concat(wwOn ? ['鸣潮'] : [])
  const soloAlias = ['#ystl', '#xttl', '#zzztl'].concat(wwOn ? ['#mctl'] : []).join(' ')
  // 质变仪 / 洞天宝钱提醒是独立开关（resin_timer），关掉时列表里不该还写着"含…提醒"
  const timerOn = isModuleEnabled('resin_timer')
  return [
    {
      group: '体力查询',
      desc: 'TL · 四游戏实时体力',
      color: 'blue',
      list: [
        {
          icon: 'gs-logo.webp',
          icon2: 'sr-logo.webp',
          module: 'tl',
          title: '#体力 #tl #体力总览',
          desc: '一次查原神 / 星铁 / 绝区零（鸣潮需先自行开启）',
        },
        {
          // 四游戏单查只是名字不同（TL.js 的 note_ 用同一套游戏别名），合成一条
          // 图标用「开拓力」（体力意象），与推送那条的「原粹树脂」同族但不撞图
          icon: 'sr-trailblaze.webp',
          module: 'tl',
          title: soloGames.map((g) => `#${g}体力`).join(' / '),
          desc: `单查某一游戏；别名 ${soloAlias}（*体力 = #星铁体力）；支持 @他人`,
        },
        {
          icon: 'multi.webp',
          module: 'tl',
          title: '#开启/关闭 原神 / 星铁 / 绝区零 / 鸣潮 体力',
          desc: '控制「体力总览」是否包含对应游戏（前三个默认显示、鸣潮默认关，单独查询不受影响）',
        },
        {
          icon: 'mask.webp',
          module: 'tl',
          // 标题按旁边那条「开启/关闭 原神/星铁/绝区零/鸣潮 体力」的写法列全四游戏，
          // 别只举原神一个例子 —— 用户只看标题，desc 里的「同理」等于没写
          title: '#关闭原神/星铁/绝区零/鸣潮 123456789',
          desc: '屏蔽单个号（不解绑、不影响推送）；#屏蔽星铁体力123456789 / #隐藏鸣潮123456789 都认；恢复：#开启原神123456789',
        },
        {
          icon: 'sr-忘归人.webp',
          module: 'tl',
          title: '#体力屏蔽列表',
          desc: '查看自己已屏蔽的 UID；屏蔽只影响显示，不解绑、不影响体力推送',
        },
        {
          icon: 'gs-resin.webp',
          module: 'resin_push',
          // 四游戏只是名字不同，正则也是同一个模板套游戏名，合成一条更清爽
          // （对应 setReg：`#?[开启]?<游戏名>体力推送 <阈值>`，开启前缀可省）
          title: '#原神/星铁/绝区零/鸣潮体力推送 <阈值>',
          desc: '只盯主号：达标即在群@你发图（原粹树脂/开拓力/电量/结晶波片）；鸣潮需先启用；关闭：加「关闭」',
        },
        {
          icon: 'gs-枫原万叶.webp',
          module: 'resin_push',
          title: '#原神/星铁/绝区零/鸣潮体力全推送 <阈值>',
          desc: '盯名下所有号：各自达标各自@发图；关闭：加「关闭」',
        },
        {
          icon: 'signin.webp',
          module: 'resin_push',
          title: '#体力推送列表',
          // resin_timer 关掉时就不提提醒了，免得用户以为开了却没收到
          desc: `查看自己的体力推送订阅（含全id${timerOn ? '、质变仪/洞天宝钱到期提醒' : ''}）`,
        },
        {
          icon: 'sr-砂金.webp',
          module: 'tl',
          title: '#开启体力uid / #关闭体力uid',
          // toggleUidDisplay 的 redis key 是 xhh:show_uid:<qq>，没有 game 维度 —— 确实一次管四游戏
          desc: '一次管四个游戏：卡片是否显示 UID（与「#开启原神体力」不同，那个是控制总览含哪几个游戏）',
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
          module: 'gs_all_abyss',
          title: '#全部深渊',
          // 这条只有原神：星铁同名功能走 * 前缀（见下方「星铁 · 全部深渊」板块），
          // 不带 * 的 #全部深渊 就是原神，所以标题不加游戏名，desc 里点明去处
          desc: '原神：螺旋 + 危战 + 小剧诗 三列合一；星铁同名功能发 *全部深渊',
        },
        {
          icon: 'gs-莫娜.webp',
          module: 'abyss_team',
          title: '#深渊配队 #深渊组队',
          desc: '12层满星热门双队；绑CK按练度排序',
        },
        {
          icon: 'gs-胡桃.webp',
          module: 'hard_team',
          title: '#危战配队 #危战组队',
          desc: '幽境危战上/中/下三关热门队；绑CK按练度排序',
        },
        {
          icon: 'gs-刻晴.webp',
          module: 'hold_rate',
          title: '#角色持有率 #持有率',
          desc: '深渊玩家各角色持有比例；绑CK标记已持有',
        },
        {
          icon: 'gs-芙宁娜.webp',
          module: 'role_combat',
          title: '#小剧诗 #小幻想',
          desc: '幻想真境剧诗关键关卡通关速览',
        },
        {
          icon: 'gs-那维莱特.webp',
          module: 'role_combat',
          title: '#小剧诗上期 #上期小幻想',
          desc: '查询上期小剧诗成绩',
        },
        {
          icon: 'gs-八重神子.webp',
          module: 'role_combat',
          title: '#幻想角色',
          desc: '当期限制元素 / 特邀 / 可用角色',
        },
        {
          icon: 'gs-妮露.webp',
          module: 'role_combat',
          title: '#下期幻想角色',
          desc: '下期限制元素 / 特邀 / 可用角色（未发布则回退最新）',
        },
        {
          icon: 'gs-甘雨.webp',
          module: 'role_combat',
          title: '#幻想202607 #幻想2026年7月',
          desc: '按月份回看幻想剧诗角色池',
        },
      ],
    },
    {
      // 队伍伤害从「原神 · 成绩汇总」独立出来：它不吃米游社成绩、走的是提瓦特小助手 + miao 面板，
      // 依赖和受众都与同板块其它条目不同，故单独成块、单独开关
      group: '原神 · 队伍伤害',
      desc: '提瓦特小助手算 DPS · 需 miao 面板',
      color: 'cyan',
      list: [
        {
          icon: 'gs-胡桃.webp',
          module: 'team_damage',
          title: '#队伍伤害 钟离,班尼特,香菱,行秋',
          desc: '算队伍 DPS；需先 #更新面板。加「详情」出逐条伤害',
        },
        {
          icon: 'gs-夜兰.webp',
          module: 'team_damage',
          title: '#队伍伤害 …队伍… 钟离e,班尼特q,香菱q',
          desc: '自定义手法：e/长e/短e/q/zj/a1~a6，同角色连招可省名',
        },
        {
          icon: 'gs-纳西妲.webp',
          module: 'team_damage',
          title: '#队伍伤害 香菱换六命换精5换4千岩',
          desc: '换装模拟：换武器/圣遗物/命座/精炼/天赋101313/90级',
        },
        {
          icon: 'gs-钟离.webp',
          module: 'team_damage',
          title: '#队伍伤害帮助',
          desc: '手法与换装的全部写法说明（出图）',
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
          module: 'sr_all_abyss',
          // 这三条其实是同一个 rule（Abyss.js 一条正则同时吃 全部深渊/深渊总览/深渊汇总），
          // 别名并排写出来即可，不再单占一格
          title: '*全部深渊 *深渊总览 *深渊汇总',
          desc: '混沌 / 虚构 / 末日 / 异相 一张图；也可写 #星铁全部深渊',
        },
        {
          icon: 'sr-流萤.webp',
          module: 'sr_all_abyss',
          title: '*全部深渊上期 *上期全部深渊',
          desc: '查询上期四模式成绩',
        },
      ],
    },
    {
      group: '星铁 · 抽卡记录',
      desc: '小程序同源接口 · 只有五星与垫抽',
      color: 'purple',
      list: [
        {
          icon: 'sr-卡芙卡.webp',
          module: 'sr_gacha',
          title: '*更新抽卡记录',
          desc: '免抽卡链接，直接拉五星记录与垫抽，合并进本地记录不丢旧数据；更新完回一条变动池明细并出总览图；也可发 *xhh更新抽卡记录',
        },
        {
          icon: 'sr-希儿.webp',
          module: 'sr_gacha',
          title: '*抽卡记录 *武器记录 *常驻记录',
          desc: '仿小程序「跃迁记录统计」出图，各池分开看；*全部记录 出总览图',
        },
        {
          icon: 'sr-灵砂.webp',
          module: 'sr_gacha',
          title: '*导入记录',
          desc: '发完指令再丢文件：SRGF v1.0 / UIGF v4.x / UIGF v2.x 的 json，或导出的 Excel',
        },
      ],
    },
    {
      group: '米游社签到',
      desc: '原神 / 星铁 / 绝区零 · 需绑定',
      color: 'orange',
      list: [
        {
          icon: 'gs-迪卢克.webp',
          module: 'auto_sign',
          // 标题列全三游戏（与「#开启/关闭 …体力」那条同一写法）；星铁别名多，desc 里补上
          title: '#原神/星铁/绝区零签到',
          desc: '立即签到；星铁也可写 #崩铁签到 / #星穹铁道签到 / #xt签到',
        },
        {
          icon: 'gs-温迪.webp',
          module: 'auto_sign',
          title: '#原神/星铁/绝区零自动签到',
          desc: '开启每日自动签；加「关闭 / 关 / 取消 / 停止」停用',
        },
        {
          icon: 'gs-丽莎.webp',
          module: 'auto_sign',
          title: '#过码 #米游社验证 #手动过码',
          desc: '清掉米游社验证（默认全自动）；可带游戏名（#星铁过码 / #绝区零过码），默认原神',
        },
        {
          icon: 'gs-七七.webp',
          module: 'auto_sign',
          title: '#签到列表',
          desc: '查看自己已开启的自动签到订阅',
        },
        {
          icon: 'sr-花火.webp',
          module: 'solver',
          title: '#过码部署 #过码服务状态',
          desc: '一键装好全自动过码服务；装完撞码自动处理，不用再管',
        },
      ],
    },
    {
      group: '米游币任务',
      desc: '社区做任务赚币 · 需 stoken',
      color: 'gold',
      list: [
        {
          icon: 'active.webp',
          module: 'bbs_coin',
          title: '#开启自动米游币',
          desc: '开启每日自动做任务；停用发 #关闭自动米游币',
        },
        {
          icon: 'gs-艾尔海森.webp',
          module: 'bbs_coin',
          title: '#米游币签到',
          desc: '立即跑一次：任一版块签到即拿满',
        },
        {
          icon: 'gs-流浪者.webp',
          module: 'bbs_coin',
          title: '#米游币余额',
          desc: '只查米游币余额与今日剩余可获取',
        },
        {
          icon: 'sr-大黑塔.webp',
          module: 'bbs_coin',
          title: '#自动米游币列表',
          desc: '查看自己是否已开启每日自动米游币',
        },
      ],
    },
    {
      group: '原神 · 版本配置',
      desc: 'Alioth 静态 · 不查个人成绩',
      color: 'orange',
      list: [
        {
          icon: 'gs-雷电将军.webp',
          module: 'nanoka',
          title: '#版本深渊 #版本螺旋',
          desc: '深境螺旋祝福与楼层（正式服）',
        },
        {
          icon: 'gs-可莉.webp',
          module: 'nanoka',
          title: '#下期深渊 #下期螺旋',
          desc: '测试包最新深渊配置',
        },
        {
          icon: 'gs-夜兰.webp',
          module: 'nanoka',
          title: '#版本剧诗 #下期剧诗',
          desc: '幻想真境剧诗限制元素与 Boss',
        },
        {
          icon: 'gs-神里绫华.webp',
          module: 'nanoka',
          title: '#版本危战 #危战版本',
          desc: '幽境危战强敌；#下期危战 看下期',
        },
        {
          icon: 'sr-符玄.webp',
          module: 'nanoka',
          title: '#版本深渊列表 #版本危战列表',
          desc: '最近期数一览（剧诗同理）',
        },
        {
          icon: 'sr-丹恒.webp',
          module: 'nanoka',
          title: '上期 / 第N期 / 9月',
          desc: '接在版本指令后：#版本深渊上期 · #版本深渊9月',
        },
      ],
    },
    {
      group: '星铁 · 版本配置',
      desc: 'Alioth · * / 星铁 前缀',
      color: 'pink',
      list: [
        {
          icon: 'sr-景元.webp',
          module: 'nanoka',
          title: '*版本混沌 *版本深渊',
          desc: '混沌回忆配置；*下期混沌 看下期',
        },
        {
          icon: 'sr-银狼.webp',
          module: 'nanoka',
          title: '*版本虚构 *下期虚构',
          desc: '虚构叙事',
        },
        {
          icon: 'sr-刃.webp',
          module: 'nanoka',
          title: '*版本末日 *下期末日',
          desc: '末日幻影',
        },
        {
          icon: 'sr-星期日.webp',
          module: 'nanoka',
          title: '*版本异相 *下期异相',
          desc: '异相仲裁',
        },
        {
          icon: 'sr-黑天鹅.webp',
          module: 'nanoka',
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
          title: '#小火花帮助',
          desc: '显示本指令总览图',
        },
        {
          // 属运维类，从「体力查询」移过来；正则里带「体力插件」是历史别名，不是体力功能
          icon: 'plugin.webp',
          title: '#更新小火花 #体力插件更新',
          desc: '拉取插件更新；加「强制」放弃本地修改',
        },
        {
          icon: 'sr-藿藿.webp',
          module: 'tmp_clean',
          title: '#清理临时文件 #小火花清理tmp',
          desc: '主人：清理 data/tmp（加「全部」清空）',
        },
        {
          icon: 'sr-镜流.webp',
          module: 'del_ck',
          title: '#删除ck #原神删除ck',
          desc: '配合 genshin 删号：清理残留 stoken，避免被删账号复活查询',
        },
      ],
    },
  ]
}

export class help extends plugin {
  constructor() {
    super({
      name: '[小火花]帮助',
      dsc: '小火花 指令帮助图',
      event: 'message',
      priority: 500,
      rule: [
        {
          // #小火花帮助 / #xhh帮助 / #xhh-TL帮助 / 小火花菜单 / #xhh help …
          reg: '^\\s*#?(?:小火花|xhh-?TL|xhh)(?:插件)?\\s*(?:命令|帮助|菜单|help|说明|功能|指令|使用说明)\\s*$',
          fnc: 'help',
        },
      ],
    })
  }

  async help(e) {
    // 提到 try 外面：渲染失败时还要用它退文字版
    let groups = []
    try {
      const rawGroups = buildHelpGroups()
      checkIconUnique(rawGroups)
      // 关掉的模块连同它的板块一起从帮助图里去掉：
      // 板块内条目全被过滤时整组消失，不留空标题
      groups = withIconSrc(filterHelpGroups(rawGroups))
      const cmdCount = groups.reduce((n, g) => n + (g.list?.length || 0), 0)
      const version = readVersion()
      const offModules = disabledModuleLabels()
      const note =
        '<b>提示</b>：指令大多可省略 #（过码相关须带 #）；星铁相关请带 <b>*</b> 或「星铁」前缀。' +
        '版本指令支持 <b>列表 / 上期 / 第N期</b>；个人成绩类需先绑定账号。' +
        '鸣潮体力需主人先启用并登录鸣潮。' +
        '支持 @他人查询（对方需已绑定）。' +
        // 有关掉的模块时点名，避免用户以为指令写错了
        (offModules.length
          ? `<br><b>已关闭</b>（锅巴里可重新开启）：${offModules.join('、')}`
          : '')

      // 出图服务不可用时退文字版，而不是只回一句「请稍后重试」
      if (!e.runtime?.render) {
        return e.reply(groupsToText(groups), quoteEnabled())
      }

      const bgImage = pickHelpBgImage({ logTag: 'xhh-TL[help]' })

      const data = {
        title: '小火花帮助',
        subTitle: '四游戏体力 · 全部深渊 · 幻想剧诗 · 版本配置',
        version,
        cmdCount,
        generatedAt: moment().format('YYYY-MM-DD HH:mm'),
        groups,
        note,
        bgImage,
        saveId: 'help',
      }

      const tplFile = path.join(pluginDir, 'resources/help/help.html')
      return renderTpl(e, {
        tpl: 'help',
        tplFile,
        data,
        baseScale: 1.5,
        rem: true,
      })
    } catch (err) {
      logger?.error?.('[xhh-TL][help]', err)
      // 图挂了也别只丢一句「稍后重试」——把同一份清单用文字发出去
      if (groups.length) {
        try {
          return e.reply(groupsToText(groups), quoteEnabled())
        } catch (_) {}
      }
      return e.reply(`帮助图渲染失败，请稍后重试`, quoteEnabled())
    }
  }
}
