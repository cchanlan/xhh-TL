/**
 * #小火花帮助 — 指令总览图（按板块分两级：总览 + 子帮助）
 *
 * 主图只列已安装并启用的板块入口，每个板块一张 `#xx帮助` 卡；
 * 发入口才单独渲染那个板块的全部指令（同样只列已安装并启用的模块）。
 * 新增板块/指令时的链条：buildHelpGroups() → SUB_HELP_WORDS → README。
 *
 * 图标使用本插件 resources/help/icons 内独立角色/游戏图（原神用原神角色，星铁用星铁角色）
 */
import path from 'path'
import plugin from '../../../lib/plugins/plugin.js'
import { pickHelpBgImage, pluginDir } from '../utils/pluginConfig.js'
import { quoteEnabled } from '../utils/replyHelper.js'
import { renderTpl } from '../utils/render.js'
import { filterHelpGroups, disabledModuleLabels, isModuleVisible } from '../utils/modules.js'

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
const DUP_ICON_TOLERATED = new Set(['gs-胡桃.webp', 'gs-钟离.webp', 'gs-夜兰.webp', 'spark.webp'])

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
  const wwOn = isModuleVisible('waves')
  const soloGames = ['原神', '星铁', '绝区零'].concat(wwOn ? ['鸣潮'] : [])
  const soloAlias = ['#ystl', '#xttl', '#zzztl'].concat(wwOn ? ['#mctl'] : []).join(' ')
  // 质变仪 / 洞天宝钱提醒是独立开关（resin_timer），关掉时列表里不该还写着"含…提醒"
  const timerOn = isModuleVisible('resin_timer')
  return [
    {
      group: '体力查询',
      desc: `TL · ${wwOn ? '四' : '三'}游戏体力与提醒`,
      color: 'blue',
      list: [
        {
          icon: 'gs-logo.webp',
          icon2: 'sr-logo.webp',
          module: 'tl',
          title: '#体力 #tl #体力总览',
          desc: `一次查原神 / 星铁 / 绝区零${wwOn ? '（鸣潮需先自行开启）' : ''}`,
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
          title: `#开启/关闭 ${soloGames.join(' / ')} 体力`,
          desc: `控制「体力总览」是否包含对应游戏${wwOn ? '（鸣潮默认关闭）' : ''}，单独查询不受影响`,
        },
        {
          icon: 'mask.webp',
          module: 'tl',
          // 标题按旁边那条「开启/关闭 原神/星铁/绝区零/鸣潮 体力」的写法列全四游戏，
          // 别只举原神一个例子 —— 用户只看标题，desc 里的「同理」等于没写
          title: `#关闭${soloGames.join('/')} 123456789`,
          desc: `屏蔽单个号（不解绑、不影响推送）；#屏蔽星铁体力123456789${wwOn ? ' / #隐藏鸣潮123456789' : ''} 都认；恢复：#开启原神123456789`,
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
          title: `#${soloGames.join('/')}体力推送 <阈值>`,
          desc: `只盯主号：达标即在群@你发图${wwOn ? '；鸣潮需先启用' : ''}；关闭：加「关闭」`,
        },
        {
          icon: 'gs-枫原万叶.webp',
          module: 'resin_push',
          title: `#${soloGames.join('/')}体力全推送 <阈值>`,
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
          desc: '统一设置卡片是否显示 UID（与「#开启原神体力」不同，那个是控制总览含哪几个游戏）',
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
      desc: '五星与垫抽 · 小助手文件 / 工坊云端',
      color: 'purple',
      list: [
        {
          icon: 'sr-卡芙卡.webp',
          module: 'sr_gacha',
          title: '*更新抽卡记录',
          desc: '更新五星与垫抽并出总览；别名 *获取抽卡记录；可加 xhh / 小火花前缀点名本插件',
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
          title: '*导入记录 *导入小助手记录',
          desc: '发送 JSON / Excel / csv；小助手先点「同步云端」→「导出 JSON」；别名 *导入抽卡记录 / *导入小助手抽卡记录；可加 json / excel / xlsx 或文件链接，群内加「强制」',
        },
        {
          icon: 'sr-飞霄.webp',
          module: 'sr_gacha',
          title: '*强制更新记录 *强制更新抽卡记录',
          desc: '清空当前 UID 旧记录，以官方五星与垫抽重建；「更新」可换「获取」，可加 xhh / 小火花前缀；失败保留旧记录',
        },
        {
          icon: 'sr-知更鸟.webp',
          module: 'sr_gacha',
          title: '*导入星穹工坊记录 *导入工坊记录',
          desc: '导入工坊云端历史五星与 UP 标记；别名 *更新星穹工坊记录 / *更新工坊记录；四条均可在「记录」前加「抽卡」',
        },
      ],
    },
    {
      group: '兑换码 · 国服三游戏',
      desc: '# 原神 · * 星铁 · % 绝区零 · 仅本人绑定账号',
      color: 'orange',
      list: [
        { icon: 'gs-丽莎.webp', module: 'redeem', title: '#使用兑换码 / *使用兑换码 / %使用兑换码',
          desc: '不带码：兑换近期收录码；带码：使用指定码，多个码用空格隔开，最多20个' },
        { icon: 'zzz-03.webp', module: 'redeem', title: '#兑换码使用 / *兑换码使用 / %兑换码使用',
          desc: '同「使用兑换码」；也可写 #原神使用兑换码 / #星铁使用兑换码 / #绝区零使用兑换码，游戏名优先' },
        { icon: 'zzz-02.webp', module: 'redeem', title: '#自动兑换码 / *自动兑换码 / %自动兑换码',
          desc: '不加后缀或加「开启」订阅；加「关闭」取消、加「状态」查看；每10分钟检查，支持前缀后加游戏名' },
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
          desc: '立即签到；原神可写 yuanshen / ys，星铁可写 崩铁 / 星穹铁道 / xt，绝区零可写 zzz',
        },
        {
          icon: 'gs-温迪.webp',
          module: 'auto_sign',
          title: '#原神/星铁/绝区零自动签到',
          desc: '游戏别名同签到；可加「开启 / 开 / 打开」启用，「关闭 / 关 / 取消 / 停止」停用',
        },
        {
          icon: 'gs-七七.webp',
          module: 'auto_sign',
          title: '#签到列表',
          desc: '#签到列表 / #签到状态 / #签到查询；也可写 #自动签到列表 / #自动签到状态 / #自动签到查询',
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
          desc: '只查米游币余额、今日已获得与还可获取',
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
          icon: 'sr-花火.webp',
          module: 'solver',
          title: '#过码部署 #过码服务状态',
          desc: '一键装好全自动过码服务；装完撞码自动处理，不用再管',
        },
        { icon: 'active.webp', module: 'resin_timer', title: '质变仪 / 洞天宝钱到期提醒', desc: '自动功能，无独立指令；沿用已保存的原神推送订阅，重新设置订阅需安装体力推送模块' },
        { icon: 'mask.webp', module: 'captcha', title: '撞码自动处理', desc: '自动功能，无独立指令；配合过码服务处理米游社验证码' },
        { icon: 'spark.webp', title: '锅巴 → 扩展页面 → 小火花模块中心', desc: '选择功能安装、更新或卸载，重启机器人后生效；卸载保留配置与数据' },
        {
          icon: 'spark.webp',
          title: '#小火花帮助',
          desc: '名称：小火花/xhh/xhhTL/xhh-TL，可加插件；后缀：命令/帮助/菜单/help/说明/功能/指令/使用说明',
        },
        {
          // 属运维类，从「体力查询」移过来；正则里带「体力插件」是历史别名，不是体力功能
          icon: 'plugin.webp',
          title: '#小火花更新 / #小火花体力更新 / #体力插件更新 / #更新小火花',
          desc: '仅主人；均支持强制更新别名。更新核心后，在锅巴更新模块并重启',
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

/**
 * 子帮助入口表：主图里每个业务板块只留一张入口卡，发 `<入口词>帮助` 才单独渲染该板块。
 *
 * - `word`：入口词（不含 # 和「帮助」），拼成 `#体力查询帮助` 这类指令
 * - `group`：必须与 buildHelpGroups() 里的 group 完全一致，渲染时按它取板块
 * - `desc`：主图入口卡上的摘要（手写，说明这个板块能干什么）
 * - `icon`：入口卡图标，取 resources/help/icons 下已有文件
 *
 * ⚠️ 「管理 · 其它」故意不收入口：里面是帮助/更新/模块中心这类插件自身的运维信息，
 *    再套一层子帮助等于让用户多点一次。
 */
const SUB_HELP_WORDS = [
  { key: 'tl', word: '体力查询', group: '体力查询', icon: 'gs-logo.webp', icon2: 'sr-logo.webp', desc: '体力总览、单游戏查询、阈值推送、屏蔽列表' },
  { key: 'gs_score', word: '原神成绩', group: '原神 · 成绩汇总', icon: 'gs-钟离.webp', desc: '全部深渊、配队、持有率、小剧诗与幻想角色' },
  // 入口词不能用 #队伍伤害帮助 —— 那是 teamDamage.js 出详细用法教程图的自有指令
  { key: 'gs_damage', word: '队伍', group: '原神 · 队伍伤害', icon: 'gs-胡桃.webp', desc: '队伍 DPS、自定义手法、换装模拟与详细用法' },
  { key: 'sr_abyss', word: '星铁深渊', group: '星铁 · 全部深渊', icon: 'sr-黄泉.webp', desc: '混沌 / 虚构 / 末日 / 异相四模式合一' },
  { key: 'sr_gacha', word: '抽卡记录', group: '星铁 · 抽卡记录', icon: 'sr-卡芙卡.webp', desc: '更新、查看、导入小助手与星穹工坊记录' },
  { key: 'redeem', word: '兑换码', group: '兑换码 · 国服三游戏', icon: 'gs-丽莎.webp', desc: '原神 / 星铁 / 绝区零兑换码与自动订阅' },
  { key: 'sign', word: '签到', group: '米游社签到', icon: 'signin.webp', desc: '三游戏签到、自动签到与签到列表' },
  { key: 'bbs_coin', word: '米游币', group: '米游币任务', icon: 'gs-艾尔海森.webp', desc: '自动做任务、立即执行、查余额与订阅状态' },
  { key: 'gs_version', word: '原神版本', group: '原神 · 版本配置', icon: 'gs-雷电将军.webp', desc: '版本深渊、剧诗、危战配置与期数回看' },
  { key: 'sr_version', word: '星铁版本', group: '星铁 · 版本配置', icon: 'sr-景元.webp', desc: '混沌、虚构、末日、异相各模式配置' },
].map((item) => ({ ...item, reg: new RegExp(`^\\s*#?${item.word}帮助\\s*$`) }))

const SUB_HELP_BY_GROUP = new Map(SUB_HELP_WORDS.map((item) => [item.group, item]))

/** 子帮助指令：#体力查询帮助 / #原神成绩帮助 / #抽卡记录帮助 … */
const SUB_HELP_REG = new RegExp(`^\\s*#?(?:${SUB_HELP_WORDS.map((i) => `${i.word}帮助`).join('|')})\\s*$`)

/**
 * 由完整指令表生成主图：业务板块的入口收进一个「功能模块」导航板块
 * （每个板块一条 `#xx帮助`），其余板块（管理 · 其它）原样保留。
 *
 * 传进来的 groups 必须已经过 filterHelpGroups —— 未安装/未启用模块的板块此时已消失，
 * 所以主图里不会出现「点了入口却什么都没有」的空入口。
 */
export function buildHelpIndex(groups) {
  const entries = []
  const rest = []
  for (const g of groups) {
    const entry = SUB_HELP_BY_GROUP.get(g.group)
    if (!entry) {
      rest.push(g)
      continue
    }
    entries.push({ icon: entry.icon, icon2: entry.icon2, title: `#${entry.word}帮助`, desc: entry.desc })
  }
  return entries.length
    ? [{ group: '功能模块', desc: '点入口看该模块的全部指令', color: 'blue', list: entries }, ...rest]
    : rest
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
        {
          // 子帮助入口：#体力查询帮助 / #原神成绩帮助 / #抽卡记录帮助 …
          reg: SUB_HELP_REG,
          fnc: 'subHelp',
        },
      ],
    })
  }

  /** 主帮助：每个业务板块只给入口，只列已安装并启用的模块 */
  async help(e) {
    // 提到 try 外面：渲染失败时还要用它退文字版
    let groups = []
    try {
      const rawGroups = buildHelpGroups()
      checkIconUnique(rawGroups)
      // 关掉的模块连同它的板块一起从帮助图里去掉：
      // 板块内条目全被过滤时整组消失，不留空标题
      const filtered = filterHelpGroups(rawGroups)
      groups = withIconSrc(buildHelpIndex(filtered))
      const offModules = disabledModuleLabels()
      const hasBusiness = filtered.some(g => g.list.some(item => item.module))
      const note = '<b>按模块查看</b>：发板块入口（如 #体力查询帮助）看该模块的全部指令，只列已安装并启用的模块。' +
        '<br><b>安装模块</b>：锅巴 → 扩展页面 → 小火花模块中心；安装、卸载后重启机器人。' +
        (hasBusiness ? '<br><b>提示</b>：指令大多可省略 #；个人成绩类需先绑定账号。星铁查询请带 * 或“星铁”前缀。' : '') +
        (offModules.length ? `<br><b>未启用或未加载</b>（重新开启后需重启）：${offModules.join('、')}` : '')

      return await this.renderHelpImage(e, {
        groups,
        title: '小火花帮助',
        note,
        saveId: 'help',
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

  /** 子帮助：只渲染该板块的指令，过滤规则与主图同一套（未安装/未启用的模块不列） */
  async subHelp(e) {
    const text = String(e.msg || '').trim()
    const entry = SUB_HELP_WORDS.find((item) => item.reg.test(text))
    if (!entry) return false

    const section = filterHelpGroups(buildHelpGroups()).find((g) => g.group === entry.group)
    if (!section) {
      return e.reply(`「${entry.group}」模块还没安装或未启用，先到 锅巴 → 扩展页面 → 小火花模块中心 安装/开启，装完重启机器人`, quoteEnabled())
    }

    const groups = withIconSrc([section])
    try {
      return await this.renderHelpImage(e, {
        groups,
        title: `小火花帮助 · ${section.group}`,
        subTitle: entry.desc,
        note: '<b>返回总览</b>：发送 #小火花帮助；这里只列已安装并启用的模块指令。',
        saveId: `help-${entry.key}`,
      })
    } catch (err) {
      logger?.error?.('[xhh-TL][help]', err)
      return e.reply(groupsToText(groups), quoteEnabled())
    }
  }

  /** 出帮助图（主图与子图共用）；出图服务不可用或渲染失败时退文字版 */
  async renderHelpImage(e, { groups, title, subTitle, note, saveId }) {
    // 出图服务不可用时退文字版，而不是只回一句「请稍后重试」
    if (!e.runtime?.render) {
      return e.reply(groupsToText(groups), quoteEnabled())
    }

    const data = {
      title,
      subTitle,
      groups,
      note,
      bgImage: pickHelpBgImage({ logTag: 'xhh-TL[help]' }),
      saveId,
    }

    const tplFile = path.join(pluginDir, 'resources/help/help.html')
    const rendered = await renderTpl(e, {
      tpl: 'help',
      tplFile,
      data,
      baseScale: 1.5,
      rem: true,
      saveId,
    })
    if (rendered === false) return e.reply(groupsToText(groups), quoteEnabled())
    return rendered
  }
}
