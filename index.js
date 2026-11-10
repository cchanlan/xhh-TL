import { bootModules, loadModuleApps, prepareLegacyMigration } from './utils/moduleManager.js'
import { isModuleEnabled } from './utils/modules.js'
import { help } from './apps/help.js'
import { manage } from './apps/manage.js'

// 管理页先加载也不会提交待重启事务；只有插件入口进入启动阶段。
// 旧版升级要下载几十个包（有用户几百兆），绝不能把机器人启动卡在这里：
// 迁移放后台跑，管理入口和已有模块先可用，准备好了用户在锅巴点重启即可。
prepareLegacyMigration().catch(error => globalThis.logger?.error?.('[xhh-TL][模块迁移] 后台准备失败', error))
bootModules()
export const apps = { help, manage, ...await loadModuleApps(isModuleEnabled) }
