import path from 'path'
import { fileURLToPath } from 'url'
import {
  readUserConfig,
  writeUserConfig,
  mergeMissingDefaults,
  readPluginConfig,
} from './utils/pluginConfig.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 加载时补全新默认键到用户 config.yaml（不覆盖已有）
try { mergeMissingDefaults() } catch (_) {}

export function supportGuoba() {
  return {
    pluginInfo: {
      name: 'xhh-TL',
      title: '小火花体力小组件',
      author: '@cchanlan',
      authorLink: 'https://github.com/cchanlan',
      link: 'https://github.com/cchanlan/xhh-TL',
      isV3: true,
      isV2: false,
      description: '支持原神/星铁/绝区零三游戏体力查询+全部深渊三合一'
    },
    configInfo: {
      schemas: [
        {
          component: 'Divider',
          label: '体力查询'
        },
        {
          field: 'Tl',
          label: '启用体力查询',
          bottomHelpMessage: '是否启用体力查询功能',
          component: 'Switch'
        },
        {
          field: 'render_scale',
          label: '渲染倍率',
          bottomHelpMessage: '全局清晰度微调。1.0=模板推荐；想更清晰可调到 1.2~1.5（图更大）',
          component: 'InputNumber',
          componentProps: {
            min: 0.8,
            max: 1.5,
            step: 0.1,
            placeholder: '默认 1.0'
          }
        },
        {
          field: 'tl_card_style',
          label: '体力卡片样式',
          bottomHelpMessage:
            '经典=多合一卡片；立绘卡=右侧大角色立绘；桌面小组件=仿米哈游官方桌面小组件竖卡（立绘复用同一目录）',
          component: 'Select',
          componentProps: {
            options: [
              { label: '经典（默认）', value: 'classic' },
              { label: '立绘卡', value: 'portrait' },
              { label: '桌面小组件', value: 'widget' }
            ]
          }
        },
        {
          field: 'tl_portrait_folder',
          label: '立绘卡角色图目录',
          bottomHelpMessage:
            '原神/星铁立绘来源。默认 miao-plugin 角色面板图，按游戏自动过滤。结构：子文件夹=角色名，内含图片随机抽取。也可填自己的图库或绝对路径',
          component: 'Input',
          componentProps: {
            placeholder: 'plugins/miao-plugin/resources/profile/normal-character'
          }
        },
        {
          field: 'tl_zzz_portrait_folder',
          label: '绝区零立绘目录',
          bottomHelpMessage:
            '绝区零立绘卡角色图来源。默认插件内置 resources/zzzrole（平铺 IconRole 图片）。支持目录随机抽图，也可填绝对路径',
          component: 'Input',
          componentProps: {
            placeholder: 'plugins/xhh-TL/resources/zzzrole'
          }
        },
        {
          field: 'tl_ww_portrait_folder',
          label: '鸣潮立绘目录',
          bottomHelpMessage:
            '鸣潮立绘卡角色图来源。默认插件内置 resources/ww_role_pile（子文件夹=角色ID，内含立绘随机抽取）。也可填自己的图库或绝对路径',
          component: 'Input',
          componentProps: {
            placeholder: 'plugins/xhh-TL/resources/ww_role_pile'
          }
        },
        {
          field: 'tl_portrait_bg',
          label: '立绘卡底图',
          bottomHelpMessage:
            '立绘卡样式的底图。支持单张图片文件，或目录（目录则每次随机抽一张）。相对 Yunzai 根或绝对路径。默认 bg1.png',
          component: 'Input',
          componentProps: {
            placeholder: 'plugins/xhh-TL/resources/stat/imgs/bg1.png'
          }
        },
        {
          field: 'tl_widget_activity',
          label: '小组件卡·限时活动',
          bottomHelpMessage:
            '仅桌面小组件卡生效。开启后卡片底部展示当前限时活动（活动名 + 进度 + 倒计时）。星铁/绝区零取自体力 widget 接口自带字段，零额外请求；原神 widget 不返回活动，需完整 CK 额外拉取 act_calendar，失败静默隐藏。关闭则不显示',
          component: 'Switch'
        },
        {
          field: 'tl_widget_activity_limit',
          label: '小组件卡·活动条数',
          bottomHelpMessage: '限时活动最多显示几条，默认 4',
          component: 'InputNumber',
          componentProps: {
            min: 1,
            max: 10,
            placeholder: '默认 4'
          }
        },
        {
          field: 'tl_priority',
          label: '插件优先级',
          bottomHelpMessage: '插件优先级，数字越小越优先',
          component: 'InputNumber',
          componentProps: {
            min: -9999,
            max: 9999,
            placeholder: '默认 -999'
          }
        },
        {
          field: 'show_all_bindings',
          label: '多账号模式',
          bottomHelpMessage: '同一 QQ 绑定的多个 UID 渲染进同一张图，多游戏合并转发',
          component: 'Switch'
        },
        {
          field: 'tl_render_mode',
          label: '体力渲染模式',
          bottomHelpMessage: '合并：同游戏多UID合并一张图；独立：按配置分组渲染',
          component: 'Select',
          componentProps: {
            options: [
              { label: '合并（默认）', value: 'merge' },
              { label: '独立', value: 'single' }
            ]
          }
        },
        {
          field: 'tl_merge_uids_per_image',
          label: '合并模式每图UID数',
          bottomHelpMessage: '合并模式下，一个游戏每张图最多渲染几个UID（默认全部）',
          component: 'InputNumber',
          componentProps: {
            min: 1,
            max: 10,
            placeholder: '默认全部'
          }
        },
        {
          field: 'tl_uids_per_image',
          label: '独立模式每图UID数',
          bottomHelpMessage: '独立模式下，一个游戏每张图渲染几个UID（默认2）',
          component: 'InputNumber',
          componentProps: {
            min: 1,
            max: 10,
            placeholder: '默认 2'
          }
        },
        {
          field: 'tl_cards_per_msg',
          label: '每条消息卡片数',
          bottomHelpMessage: '独立模式下，一条消息发几张卡片，超过则合并转发（默认3）',
          component: 'InputNumber',
          componentProps: {
            min: 1,
            max: 20,
            placeholder: '默认 3'
          }
        },
        {
          component: 'Divider',
          label: '鸣潮体力'
        },
        {
          field: 'waves_tl_enable',
          label: '启用鸣潮体力',
          bottomHelpMessage:
            '鸣潮体力由本插件自己请求库街区并出图（与三游戏同款模板），只从 gsuid_core 的鸣潮插件数据库里只读借用该 QQ 的登录凭证，不写库、不影响 core。开了之后用户还要自己发 #开启鸣潮体力（默认关），#体力 总览才会附带鸣潮；单独 #鸣潮体力 只看本开关。前提：该 QQ 已在鸣潮插件那边登录过',
          component: 'Switch'
        },
        {
          field: 'waves_tl_gsuid_db',
          label: 'gsuid_core 数据库路径',
          bottomHelpMessage:
            'core 的 GsData.db 位置（只读打开，取鸣潮绑定与凭证）。留空自动探测 /opt/gsuid_core/data/GsData.db、/root/gsuid_core/data/GsData.db；多个路径用换行分隔，取第一个存在的',
          component: 'Input',
          componentProps: {
            type: 'textarea',
            rows: 2,
            placeholder: '/root/gsuid_core/data/GsData.db',
          },
        },
        {
          field: 'waves_tl_timeout',
          label: '库街区超时（秒）',
          bottomHelpMessage: '请求库街区接口的等待上限，超时该 UID 不出图。默认 15 秒',
          component: 'InputNumber',
          componentProps: {
            min: 5,
            max: 120,
            placeholder: '15'
          }
        },
        {
          component: 'Divider',
          label: '全部深渊'
        },
        {
          field: 'all_abyss',
          label: '启用全部深渊查询',
          bottomHelpMessage: '是否启用星铁全部深渊三合一查询（混沌回忆、虚构叙事、末日幻影）',
          component: 'Switch'
        },
        {
          field: 'all_abyss_render_mode',
          label: '深渊渲染模式',
          bottomHelpMessage: '桌面端渲染(1200px宽)或手机端渲染(480px宽)',
          component: 'Select',
          componentProps: {
            options: [
              { label: '桌面端', value: 'desktop' },
              { label: '手机端', value: 'mobile' }
            ]
          }
        },
        {
          component: 'Divider',
          label: '幻想真境剧诗'
        },
        {
          field: 'role_combat',
          label: '启用幻想真境剧诗 / 小剧诗',
          bottomHelpMessage: '是否启用 #幻想角色、#小剧诗 等原神幻想真境剧诗相关查询',
          component: 'Switch'
        },
        {
          field: 'role_combat_bg_folder',
          label: '深渊/剧诗/配队背景',
          bottomHelpMessage:
            '#幻想角色、#小剧诗、#全部深渊、#深渊配队、#危战配队、#角色持有率 共用同一张背景。可填单张图片或角色面板目录。默认 plugins/xhh-TL/resources/stat/imgs/bg1.png（插件自带，Win/Linux 通用）。目录结构：子文件夹=角色名，内含图片随机抽取。也可用绝对路径',
          component: 'Input',
          componentProps: {
            placeholder: 'plugins/xhh-TL/resources/stat/imgs/bg1.png'
          }
        },
        {
          field: 'gs_all_abyss',
          label: '启用原神全部深渊',
          bottomHelpMessage: '是否启用 #全部深渊（深境螺旋 + 幽境危战 + 小剧诗关键关）',
          component: 'Switch'
        },
        {
          field: 'gs_all_abyss_theme',
          label: '全部深渊主题',
          bottomHelpMessage: '毛玻璃遮罩配色。浅色=白玻璃；深色=黑色半透明',
          component: 'Select',
          componentProps: {
            options: [
              { label: '浅色', value: 'light' },
              { label: '深色', value: 'dark' }
            ]
          }
        },
        {
          component: 'Divider',
          label: '深渊配队'
        },
        {
          field: 'abyss_team',
          label: '启用深渊配队',
          bottomHelpMessage:
            '是否启用 #深渊配队 / #深渊组队 / #深渊配对。数据来自提瓦特小助手，绑定 CK 后按本人练度排序并灰显未持有角色',
          component: 'Switch'
        },
        {
          field: 'abyss_team_theme',
          label: '深渊配队主题',
          bottomHelpMessage: '毛玻璃遮罩配色。浅色=白玻璃；深色=黑色半透明。留空则跟随「全部深渊主题」',
          component: 'Select',
          componentProps: {
            options: [
              { label: '跟随全部深渊', value: '' },
              { label: '浅色', value: 'light' },
              { label: '深色', value: 'dark' }
            ]
          }
        },
        {
          field: 'abyss_team_priority',
          label: '深渊配队优先级',
          bottomHelpMessage: '插件优先级，数字越小越优先。默认 -98',
          component: 'InputNumber',
          componentProps: {
            min: -9999,
            max: 9999,
            placeholder: '默认 -98'
          }
        },
        {
          component: 'Divider',
          label: '危战配队'
        },
        {
          field: 'hard_team',
          label: '启用危战配队',
          bottomHelpMessage:
            '是否启用 #危战配队 / #危战组队 / #危战配对。数据来自提瓦特小助手幽境危战统计，绑定 CK 后按本人练度排序并灰显未持有角色',
          component: 'Switch'
        },
        {
          field: 'hard_team_theme',
          label: '危战配队主题',
          bottomHelpMessage: '毛玻璃遮罩配色。浅色=白玻璃；深色=黑色半透明。留空则跟随「全部深渊主题」',
          component: 'Select',
          componentProps: {
            options: [
              { label: '跟随全部深渊', value: '' },
              { label: '浅色', value: 'light' },
              { label: '深色', value: 'dark' }
            ]
          }
        },
        {
          field: 'hard_team_priority',
          label: '危战配队优先级',
          bottomHelpMessage: '插件优先级，数字越小越优先。默认 -98',
          component: 'InputNumber',
          componentProps: {
            min: -9999,
            max: 9999,
            placeholder: '默认 -98'
          }
        },
        {
          component: 'Divider',
          label: '角色持有率'
        },
        {
          field: 'hold_rate',
          label: '启用角色持有率',
          bottomHelpMessage:
            '是否启用 #角色持有率 / #持有率。数据来自提瓦特小助手，为参与深渊统计玩家的角色持有比例。绑定 CK 后高亮你已持有的角色',
          component: 'Switch'
        },
        {
          field: 'hold_rate_theme',
          label: '角色持有率主题',
          bottomHelpMessage: '毛玻璃遮罩配色。浅色=白玻璃；深色=黑色半透明。留空则跟随「全部深渊主题」',
          component: 'Select',
          componentProps: {
            options: [
              { label: '跟随全部深渊', value: '' },
              { label: '浅色', value: 'light' },
              { label: '深色', value: 'dark' }
            ]
          }
        },
        {
          field: 'hold_rate_priority',
          label: '角色持有率优先级',
          bottomHelpMessage: '插件优先级，数字越小越优先。默认 -98',
          component: 'InputNumber',
          componentProps: {
            min: -9999,
            max: 9999,
            placeholder: '默认 -98'
          }
        },
        {
          component: 'Divider',
          label: '帮助图'
        },
        {
          field: 'help_bg',
          label: '帮助图背景',
          bottomHelpMessage:
            '#小火花帮助 背景。默认 plugins/xhh-TL/resources/stat/imgs/bg2.png（插件自带，Win/Linux 通用正斜杠）。可填单张图片，或目录（随机抽一张）。Windows 也可用绝对路径如 D:/Yunzai/plugins/.../xxx.png',
          component: 'Input',
          componentProps: {
            placeholder: 'plugins/xhh-TL/resources/stat/imgs/bg2.png'
          }
        },
        {
          component: 'Divider',
          label: 'CK / SToken 路径'
        },
        {
          field: 'stoken_paths',
          label: 'SToken/CK 搜索路径',
          bottomHelpMessage:
            '按优先级从上到下查找 {QQ}.yaml。支持多行，可写绝对路径或相对 Yunzai 根目录。留空则用默认：xhh / 逍遥 / 本插件 data/Stoken',
          component: 'Input',
          componentProps: {
            type: 'textarea',
            rows: 4,
            placeholder:
              'plugins/xhh/data/Stoken\nplugins/xiaoyao-cvs-plugin/data/yaml\nplugins/xhh-TL/data/Stoken'
          }
        },
        {
          component: 'Divider',
          label: '体力阈值推送'
        },
        {
          field: 'resin_push_enable',
          label: '启用体力阈值推送',
          bottomHelpMessage:
            '用户在群里各自设定阈值：原神看原粹树脂、星铁看开拓力、绝区零看电量、鸣潮看结晶波片，达到即在该群@用户并发体力图。达到后只提醒一次，回落到阈值以下自动重新监控。指令：#原神体力推送 130 / #星铁体力推送 200 / #开启鸣潮体力推送 200 / #原神体力推送关闭 / #体力推送列表（鸣潮另需打开上方「启用鸣潮体力」）',
          component: 'Switch'
        },
        {
          field: 'resin_push_cron',
          label: '检查频率 cron',
          bottomHelpMessage:
            '标准 5 段 cron（分 时 日 月 周）。默认每 10 分钟检查一次：*/10 * * * *。不建议太频繁以免触发米游社风控',
          component: 'Input',
          componentProps: {
            placeholder: '*/10 * * * *'
          }
        },
        {
          component: 'Divider',
          label: '米游社自动签到'
        },
        {
          field: 'auto_sign_enable',
          label: '启用自动签到',
          bottomHelpMessage:
            '原神/星铁/绝区零 每日自动签到。用户 opt-in：发 #原神自动签到 后才纳入。指令：#原神签到（立即签）/ #原神自动签到（开启）/ #原神自动签到关闭 / #签到列表。走稳定 device_id + 真 device_fp，弹验证码概率低',
          component: 'Switch'
        },
        {
          field: 'auto_sign_cron',
          label: '自动签到 cron',
          bottomHelpMessage:
            '标准 5 段 cron（分 时 日 月 周）。默认每天 0:23：23 0 * * *。避开整点风控高峰',
          component: 'Input',
          componentProps: {
            placeholder: '23 0 * * *'
          }
        },
        {
          field: 'auto_sign_theme',
          label: '自动签到汇总图主题',
          bottomHelpMessage:
            '每日签到完成后发到群里的汇总图配色。浅色=白玻璃；深色=黑色半透明。留空则跟随「角色持有率主题 / 全部深渊主题」',
          component: 'Select',
          componentProps: {
            options: [
              { label: '跟随全部深渊', value: '' },
              { label: '浅色', value: 'light' },
              { label: '深色', value: 'dark' }
            ]
          }
        },
        {
          field: 'auto_sign_verify_addr',
          label: '手动过码服务地址',
          bottomHelpMessage:
            '内置过码用的外部打码服务（等价 GT-Manual 的 verifyAddr）。手动 #原神签到 撞验证码时，会把 uid+gt+challenge（不含 cookie）发给它，返回链接@你手划滑块。默认沿用 GT-Manual 公益地址；留空则撞码不过码只提示。该服务非本插件提供，下线/限流则过码失效',
          component: 'Input',
          componentProps: {
            placeholder: 'https://GT.928100.xyz/GTest/register?key=...'
          }
        },
        {
          component: 'Divider',
          label: '米游币社区任务'
        },
        {
          field: 'bbs_coin_enable',
          label: '启用米游币任务',
          bottomHelpMessage:
            '与上面「自动签到」是两回事：签到领原石走游戏 UID+cookie_token；米游币是社区做任务（版块签到+看帖+点赞+分享）赚币，走米游社账号+stoken。用户 opt-in：发 #开启自动米游币 后才纳入。指令：#米游币签到（立即跑）/ #米游币余额（查余额）/ #关闭自动米游币 / #自动米游币列表。⚠️ 需要 stoken（#扫码登录才有），普通 CK 做不了',
          component: 'Switch'
        },
        {
          field: 'bbs_coin_cron',
          label: '米游币任务 cron',
          bottomHelpMessage:
            '标准 5 段 cron（分 时 日 月 周）。默认每天 0:50：50 0 * * *。已过米游社每日 0 点刷新，且与自动签到的 00:23 错开，避免同时段风控叠加',
          component: 'Input',
          componentProps: {
            placeholder: '50 0 * * *'
          }
        },
        {
          field: 'bbs_coin_games',
          label: '做哪些版块',
          bottomHelpMessage:
            '逗号分隔：gs=原神 sr=星铁 zzz=绝区零。米游币每日上限通常单版块即可拿满；版块越多耗时越长、风控概率略高。留空或填错则默认全部',
          component: 'Input',
          componentProps: {
            placeholder: 'gs,sr,zzz'
          }
        },
        {
          field: 'bbs_coin_theme',
          label: '米游币汇总图主题',
          bottomHelpMessage:
            '每日任务完成后发到群里的汇总图配色。浅色=白玻璃；深色=黑色半透明。留空则跟随「自动签到主题 / 全部深渊主题」',
          component: 'Select',
          componentProps: {
            options: [
              { label: '跟随自动签到', value: '' },
              { label: '浅色', value: 'light' },
              { label: '深色', value: 'dark' }
            ]
          }
        },
        {
          field: 'bbs_coin_gsuid_db',
          label: 'gsuid 数据库路径',
          bottomHelpMessage:
            '米游币任务需要 stoken。若你同时在跑 gsuid_core（早柚core），它#扫码登录的 stoken 存在 GsData.db 里，且带该账号注册过的真实 device_id/fp，比插件现派生的更不容易被风控，因此优先读取。留空自动探测 /opt/gsuid_core/data/GsData.db 与 /root/gsuid_core/data/GsData.db；多个路径用换行分隔。只读打开，不写入、不锁库，不影响 gsuid 运行',
          component: 'Input',
          componentProps: {
            type: 'textarea',
            rows: 2,
            placeholder: '/opt/gsuid_core/data/GsData.db',
          },
        },
        {
          component: 'Divider',
          label: '临时文件清理'
        },
        {
          field: 'tmp_clean_enable',
          label: '启用 tmp 定时清理',
          bottomHelpMessage: '自动清理 plugins/xhh-TL/data/tmp 下的渲染临时图',
          component: 'Switch'
        },
        {
          field: 'tmp_clean_cron',
          label: '清理 cron',
          bottomHelpMessage: '标准 5 段 cron（分 时 日 月 周）。默认每天 4:17：17 4 * * *',
          component: 'Input',
          componentProps: {
            placeholder: '17 4 * * *'
          }
        },
        {
          field: 'tmp_clean_max_age_hours',
          label: '保留时长（小时）',
          bottomHelpMessage: '只删除超过该小时数的文件；填 0 表示每次清空全部 tmp',
          component: 'InputNumber',
          componentProps: {
            min: 0,
            max: 720,
            placeholder: '24'
          }
        }
      ],
      getConfigData() {
        // 返回「默认 + 用户」合并结果，方便锅巴展示完整项
        return readPluginConfig()
      },
      setConfigData(data, { Result }) {
        // 只写入用户文件 config.yaml，不改 default_config.yaml
        const config = readUserConfig()
        for (const [key, value] of Object.entries(data)) {
          config[key] = value
        }
        writeUserConfig(config)
        return Result.ok({}, '保存成功~')
      }
    }
  }
}
