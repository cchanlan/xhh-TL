import plugin from '../../../lib/plugins/plugin.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { root } from '../utils/moduleStore.js'
import { quoteEnabled } from '../utils/replyHelper.js'
const exec = promisify(execFile)
/** 分支没设上游时 pull 会直接失败；按常见远端名挑一个兜底，优先三平台合一的 both。 */
async function defaultRemote() {
  try {
    const { stdout } = await exec('git', ['remote'], { cwd: root, windowsHide: true })
    const list = stdout.split(/\r?\n/).filter(Boolean)
    return ['both', 'origin', 'github', 'gitee', 'gitcode'].find(name => list.includes(name)) || list[0] || 'origin'
  } catch { return 'origin' }
}
export class manage extends plugin {
  constructor() {
    super({name:'[小火花]管理',event:'message',priority:-99,rule:[{
      reg:/^\s*#?(?:(?:体力插件|小火花(?:体力)?)(?:强制)?更新|(?:强制)?更新小火花)\s*$/, fnc:'updatePlugin',permission:'master',
    }]})
  }
  async updatePlugin(e) {
    if (!e.isMaster) return false
    try {
      // 强制更新也不能破坏未提交源码；不使用 checkout . 或平台相关 shell。
      const dirty=await exec('git',['status','--porcelain','--untracked-files=no'],{cwd:root,windowsHide:true})
      if(dirty.stdout.trim()) return e.reply('请先备份并处理本地修改，再更新小火花。',quoteEnabled())
      await e.reply('正在更新小火花。',quoteEnabled())
      try {
        await exec('git',['pull','--ff-only'],{cwd:root,windowsHide:true,timeout:120000})
      } catch (error) {
        // 当前分支没有跟踪信息时 pull 必然失败，退回「从远端 master 快进」。
        const remote=await defaultRemote()
        await exec('git',['fetch',remote,'master'],{cwd:root,windowsHide:true,timeout:120000})
        await exec('git',['merge','--ff-only','FETCH_HEAD'],{cwd:root,windowsHide:true,timeout:60000})
      }
      return e.reply('小火花核心已更新。请在锅巴更新已安装模块，并重启机器人。',quoteEnabled())
    } catch(error) {
      globalThis.logger?.error?.('[xhh-TL][更新]',error)
      return e.reply('更新失败，请稍后重试。',quoteEnabled())
    }
  }
}
