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
      title: '小花火体力小组件',
      author: '@cchanlan',
      authorLink: 'https://github.com/cchanlan',
      link: 'https://github.com/cchanlan/xhh-TL',
      isV3: true,
      isV2: false,
      description: '支持原神/星铁/绝区零/崩坏3四游戏体力查询+全部深渊三合一'
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
            '仅原神/星铁生效（绝区零/崩三始终经典）。经典=多合一卡片；立绘卡=右侧大角色立绘（原神抽原神、星铁抽星铁）',
          component: 'Select',
          componentProps: {
            options: [
              { label: '经典（默认）', value: 'classic' },
              { label: '立绘卡', value: 'portrait' }
            ]
          }
        },
        {
          field: 'tl_portrait_folder',
          label: '立绘卡角色图目录',
          bottomHelpMessage:
            '立绘卡样式的右侧立绘来源。默认 miao-plugin 角色面板图，按游戏自动过滤原神/星铁。结构：子文件夹=角色名，内含图片随机抽取。也可填自己的图库或绝对路径',
          component: 'Input',
          componentProps: {
            placeholder: 'plugins/miao-plugin/resources/profile/normal-character'
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
          label: '剧诗/深渊背景',
          bottomHelpMessage:
            '#幻想角色、#小剧诗、#全部深渊 共用。可填单张图片或角色面板目录。默认 plugins/xhh-TL/resources/stat/imgs/bg1.png（插件自带，Win/Linux 通用）。目录结构：子文件夹=角色名，内含图片随机抽取。也可用绝对路径',
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
          field: 'bh3_stoken_dir',
          label: '崩三绑定保存目录',
          bottomHelpMessage:
            '#崩三扫码绑定 写入的目录，以及 #崩三体力 读取目录。支持绝对/相对路径；留空默认 plugins/xhh-TL/data/Stoken',
          component: 'Input',
          componentProps: {
            placeholder: 'plugins/xhh-TL/data/Stoken'
          }
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
