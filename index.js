import { bootModules, loadModuleApps, prepareLegacyMigration } from './utils/moduleManager.js'
import { isModuleEnabled } from './utils/modules.js'
import { help } from './apps/help.js'
import { manage } from './apps/manage.js'

// 管理页先加载也不会提交待重启事务；只有插件入口进入启动阶段。
await prepareLegacyMigration()
bootModules()
export const apps = { help, manage, ...await loadModuleApps(isModuleEnabled) }
