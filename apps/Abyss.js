import plugin from '../../../lib/plugins/plugin.js'
import { allAbyss } from './allAbyssModule.js'
import { config } from '../utils/pluginConfig.js'

export class Abyss extends plugin {
  constructor(e) {
    super({
      name: '[小花火]深渊小组件',
      dsc: '星铁全部深渊',
      event: 'message',
      priority: config().abyss_priority ?? -98,
      rule: [
        {
          // 严格匹配：*全部深渊 / #星铁全部深渊 / *深渊总览 / *全部深渊上期
          // 不提供 *深渊、星铁深渊 短指令（避免误触）
          reg: '^\\s*(?:\\*|#\\*|#?星铁|#?\\*星铁)(?:上期)?(?:全部深渊|深渊总览|深渊汇总)(?:上期)?\\s*$',
          fnc: 'allAbyss',
        },
      ],
    })
  }

  async allAbyss(e) {
    return await allAbyss(e)
  }
}
