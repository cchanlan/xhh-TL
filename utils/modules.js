/**
 * 功能 ID、旧配置键与帮助条目的单一映射。
 * 实际生效必须同时满足：模块已安装、配置开启、未发生加载错误。
 * 安装/卸载由 moduleManager 管理；这里只处理已生效模块的业务开关。
 */

import { config } from './pluginConfig.js'
import { isInstalled, moduleError, isModuleLoaded } from './moduleManager.js'

/**
 * 模块清单。
 * key  = 写进 config.yaml 的配置键（**必须与 default_config.yaml 同名**）
 * label = 锅巴与日志里显示的名字
 */
export const MODULES = {
  tl: { key: 'Tl', label: '体力查询' },
  waves: { key: 'waves_tl_enable', label: '鸣潮体力' },
  resin_push: { key: 'resin_push_enable', label: '体力阈值推送' },
  resin_timer: { key: 'resin_timer_enable', label: '质变仪 / 洞天宝钱到期提醒' },
  auto_sign: { key: 'auto_sign_enable', label: '米游社自动签到' },
  redeem: { key: 'redeem_enable', label: '三游戏兑换码' },
  solver: { key: 'solver_deploy_enable', label: '过码服务部署' },
  captcha: { key: 'captcha_notice_enable', label: '撞码自动处理' },
  bbs_coin: { key: 'bbs_coin_enable', label: '米游币社区任务' },
  gs_all_abyss: { key: 'gs_all_abyss', label: '原神全部深渊' },
  abyss_team: { key: 'abyss_team', label: '深渊配队' },
  hard_team: { key: 'hard_team', label: '危战配队' },
  hold_rate: { key: 'hold_rate', label: '角色持有率' },
  team_damage: { key: 'team_damage', label: '队伍伤害' },
  // 小剧诗（miniRoleCombat.js）与幻想角色（role_combat.js）共用同一个键：
  // 过去 role_combat 只拦住了小剧诗，幻想角色漏在外面，锅巴说明与实现不符
  role_combat: { key: 'role_combat', label: '幻想真境剧诗 / 小剧诗' },
  sr_all_abyss: { key: 'all_abyss', label: '星铁全部深渊' },
  sr_gacha: { key: 'sr_gacha_enable', label: '星铁抽卡记录' },
  nanoka: { key: 'nanoka_abyss_enable', label: '版本配置（深渊/剧诗/危战）' },
  tmp_clean: { key: 'tmp_clean_enable', label: '临时文件清理' },
  del_ck: { key: 'del_ck_hook_enable', label: '删除 CK 对账' },
}

/** 已安装模块才读取旧开关；缺失配置键沿用旧版默认开启语义。 */
export function isModuleEnabled(id) {
  const mod = MODULES[id]
  if (!mod || !isInstalled(id) || moduleError(id)) return false
  let value
  try {
    value = config()?.[mod.key]
  } catch (_) {
    // 状态异常时不启动业务。
    return false
  }
  if (value === undefined || value === null) return true
  if (value === false || value === 0) return false
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase()
    if (s === 'false' || s === '0' || s === 'off' || s === 'no') return false
  }
  return true
}

/** 当前进程已经加载且允许使用的功能，用于帮助展示。 */
export function isModuleVisible(id) { return isModuleEnabled(id) && isModuleLoaded(id) }

/** 取某模块的配置键（日志用） */
export function moduleKey(id) {
  return MODULES[id]?.key || ''
}

/**
 * 各模块自带的「功能已被管理员关闭」提示方法名。
 *
 * 命名不统一（autoSign / autoBbsCoin 叫 _disabled，resinPush 叫 _pushDisabled），
 * 所以按名单探测而不是写死一个 —— 以后新增模块沿用任一命名都能自动接上。
 */
const DISABLED_HINT_METHODS = ['_disabled', '_pushDisabled', '_moduleDisabled']

/** 取实例上的「已关闭」提示方法，没有则返回 null */
function findDisabledHint(target) {
  for (const name of DISABLED_HINT_METHODS) {
    if (typeof target?.[name] === 'function') return target[name]
  }
  return null
}

/**
 * 给插件类的方法挂「模块开关守卫」。
 *
 * 为什么在原型上包一层，而不是在每个 fnc 里手写 if：
 * 一个模块动辄 10~18 条 rule，逐条手写既啰嗦又必然漏（role_combat 就是这么漏的）。
 * 包装在原型上，构造函数注册的 rule 拿到的就是包装后的函数，一处生效、无遗漏。
 *
 * 返回值语义（TRSS 与 JiuLi 一致，已核对两侧 loader）：
 *   false → 本插件不处理，loader 继续问别的插件
 *   'return' → 终止整个事件分发（**别用**，会把别的插件也一起吞掉）
 * 所以这里统一返回 false。
 *
 * @param {Function} cls 插件类
 * @param {string} id 模块 id
 * @param {string|string[]} fncNames 需要守卫的方法名
 */
export function guardModule(cls, id, fncNames) {
  const names = Array.isArray(fncNames) ? fncNames : [fncNames]
  const label = MODULES[id]?.label || id
  for (const name of names) {
    const original = cls.prototype?.[name]
    if (typeof original !== 'function') {
      logger?.warn?.(`[xhh-TL][modules] ${cls.name}.${name}() 不存在，「${label}」的开关守卫没挂上`)
      continue
    }
    // 同一个方法可能被多个模块守卫（如 TL 的体力指令），重复包装只留最外层
    if (original.__xhhModuleGuarded) continue

    const wrapped = async function (...args) {
      if (!isModuleEnabled(id)) {
        /**
         * 模块自带「已关闭」提示的优先复用它，否则用户发了指令只看到石沉大海，
         * 会以为是插件坏了。没有提示机制的模块（深渊那几个）静默不响应。
         *
         * 注意：这里必须 return false 而不是 true ——
         * 提示方法返回 true 只代表「提示已发出」，消息本身仍未处理，
         * 要放给别的插件去接（false = 我不处理，你继续）。
         */
        const hint = findDisabledHint(this)
        if (hint) {
          try {
            await hint.call(this, args[0])
          } catch (_) {
            // 提示失败不影响「不响应」这个结论，忽略即可
          }
        }
        return false
      }
      return original.apply(this, args)
    }
    wrapped.__xhhModuleGuarded = true
    wrapped.__xhhOriginal = original
    cls.prototype[name] = wrapped
  }
}

/**
 * 按模块开关过滤帮助图分组。
 *
 * 规则：
 * - 条目没写 module → 永远显示（如「插件更新」「帮助图」本身这类管理指令）
 * - 条目写了 module 且该模块已关 → 从帮助图里去掉
 *   module 可以是字符串或数组；数组表示「这些模块全开才显示」，
 *   用于 #鸣潮体力 这类同时依赖「体力查询」与「鸣潮体力」两个开关的条目
 * - 整组条目全被过滤掉 → 整个板块不渲染（不留空标题）
 *
 * @param {Array} groups buildHelpGroups() 的结果
 * @returns {Array} 过滤后的分组
 */
export function filterHelpGroups(groups) {
  const visible = (item) => {
    if (!item.module) return true
    const ids = Array.isArray(item.module) ? item.module : [item.module]
    return ids.every((id) => isModuleVisible(id))
  }
  return (groups || [])
    .map((g) => ({
      ...g,
      list: (g.list || []).filter(visible),
    }))
    .filter((g) => (g.list || []).length > 0)
}

/**
 * 已关闭的模块清单（帮助图底部提示用）
 * @returns {string[]} 形如 ['星铁抽卡记录', '队伍伤害']
 */
export function disabledModuleLabels() {
  return Object.keys(MODULES)
    .filter((id) => isInstalled(id) && !isModuleVisible(id))
    .map((id) => MODULES[id].label)
}
