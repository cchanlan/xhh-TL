import fs from 'fs'
import YAML from 'yaml'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const configPath = path.join(__dirname, 'config', 'config.yaml')

function readConfig() {
  try {
    if (fs.existsSync(configPath)) {
      return YAML.parse(fs.readFileSync(configPath, 'utf-8')) || {}
    }
  } catch (_) {}
  return {}
}

function writeConfig(data) {
  fs.writeFileSync(configPath, YAML.stringify(data), 'utf-8')
}

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
          field: 'img_quality',
          label: '图片渲染质量',
          bottomHelpMessage: '图片渲染质量，范围 1-100，数字越大越清晰',
          component: 'InputNumber',
          componentProps: {
            min: 1,
            max: 100,
            placeholder: '请输入 1-100'
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
        }
      ],
      getConfigData() {
        return readConfig()
      },
      setConfigData(data, { Result }) {
        const config = readConfig()
        for (const [key, value] of Object.entries(data)) {
          config[key] = value
        }
        writeConfig(config)
        return Result.ok({}, '保存成功~')
      }
    }
  }
}
