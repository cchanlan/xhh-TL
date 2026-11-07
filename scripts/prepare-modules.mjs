/** 在新版独立副本预下载，完成后仅把模块包/状态送到旧版插件。Node 18.17+。 */
import fs from 'node:fs'
import path from 'node:path'
import {initializeState,queueOperation,getState} from '../utils/moduleManager.js'
import {root,storeDir,stateFile,writeJson,sha256} from '../utils/moduleStore.js'
const args=process.argv.slice(2)
const index=args.indexOf('--prepare-for')
const target=index>=0?path.resolve(args[index+1]||''):null
if(target){
  if(target===root||!fs.existsSync(path.join(target,'index.js'))||!fs.existsSync(path.join(target,'config','config.yaml'))) throw new Error('请指定有用户配置的旧版小火花目录，不能指向预下载副本')
  // 外部目标同样逐段拒绝符号链接，不覆盖用户自定义文件。
  const ensureTarget=relative=>{
    let current=target
    if(fs.lstatSync(current).isSymbolicLink())throw new Error('迁移目标不能是符号链接')
    for(const part of relative.split('/').filter(Boolean)){current=path.join(current,part);try{if(fs.lstatSync(current).isSymbolicLink())throw new Error('迁移目标包含符号链接')}catch(error){if(error.code!=='ENOENT')throw error}}
    return current
  }
  const baseline=JSON.parse(fs.readFileSync(path.join(root,'config/legacy-files.json'),'utf8')).files
  const catalog=JSON.parse(fs.readFileSync(path.join(root,'config/modules-catalog.json'),'utf8'))
  for(const m of catalog.modules)for(const f of m.files){const file=ensureTarget(f.path);if(fs.existsSync(file)){const hash=sha256(fs.readFileSync(file));if(hash!==f.sha256&&hash!==baseline[f.path])throw new Error('请先备份处理自定义文件：'+f.path)}}
  const destination=ensureTarget('data/module-manager')
  if(fs.existsSync(path.join(destination,'state.json'))) throw new Error('目标已有模块安装记录，请通过锅巴完成迁移，不覆盖记录')
  const state=initializeState()
  if(Object.keys(state.installed).length) throw new Error('预下载副本已有安装模块，请使用新的空副本')
  state.migration='required';writeJson(stateFile,state)
  console.log(await queueOperation('migrate'))
  const prepared=getState()
  if(!prepared.pending) throw new Error('模块包尚未准备完成')
  fs.mkdirSync(path.join(destination,'packages'),{recursive:true})
  for(const m of Object.values(prepared.pending.target)){
    const name=`${m.id}-${m.sha256}.xhmp`,source=path.join(storeDir,'packages',name)
    const bytes=fs.readFileSync(source)
    if(sha256(bytes)!==m.sha256) throw new Error('预下载包损坏')
    const output=ensureTarget('data/module-manager/packages/'+name)
    if(fs.existsSync(output)){if(sha256(fs.readFileSync(output))!==m.sha256)throw new Error('目标缓存存在冲突')}
    else fs.writeFileSync(output,bytes,{mode:0o600,flag:'wx'})
  }
  // 状态文件最后创建；失败时旧版仍可运行，重试不会误判为迁移成功。
  fs.writeFileSync(ensureTarget('data/module-manager/state.json'),JSON.stringify(prepared,null,2),{flag:'wx',mode:0o600})
  console.log('旧版迁移包已准备。现在更新正式核心，再重启机器人。')
}else{
  const state=initializeState()
  console.log(state.migration==='required'?await queueOperation('migrate'):'当前无需迁移。')
}
