import {beginTaskGeneration,wrapModuleClass} from './taskLifecycle.js'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CORE_API, CORE_VERSION, root, storeDir, stateFile, readJson, writeJson, atomicWrite, sha256, managedPath, assertNoSymlink, validateCatalog, decodePackage, download, downloadPackage, setDownloadCancelCheck, downloadThreads } from './moduleStore.js'
const key = Symbol.for('xhh-TL.module-manager.v1')
const runtimes = globalThis[key] || (globalThis[key] = new Map())
const runtime = runtimes.get(root) || { booted:false, running:{}, errors:{}, busy:false, progress:null, abort:false, abortReason:'' }
runtimes.set(root,runtime)
const catalogFile = path.join(root,'config','modules-catalog.json')
const cacheCatalogFile = path.join(storeDir,'catalog.json')
const journalFile = path.join(storeDir,'transaction.json')
const packageFile = m => path.join(storeDir,'packages',`${m.id}-${m.sha256}.xhmp`)
const legacyIds = ['tl','waves','resin_push','resin_timer','auto_sign','redeem','solver','captcha','bbs_coin','gs_all_abyss','abyss_team','hard_team','hold_rate','team_damage','role_combat','sr_all_abyss','sr_gacha','nanoka','tmp_clean','del_ck']
export function getCatalog() {
  if (runtime.catalog) return runtime.catalog
  try {runtime.catalog=validateCatalog(readJson(fs.existsSync(cacheCatalogFile)?cacheCatalogFile:catalogFile))}
  catch(error){if(!fs.existsSync(cacheCatalogFile))throw error;globalThis.logger?.warn?.('[xhh-TL] 缓存目录不兼容，使用内置目录');runtime.catalog=validateCatalog(readJson(catalogFile))}
  return runtime.catalog
}
function validateState(s) {
  const object=v=>v&&typeof v==='object'&&!Array.isArray(v)
  if(s?.schema!==1||!object(s.installed)||!Array.isArray(s.explicit))throw new Error('模块安装记录损坏，请从备份恢复')
  const validateSet=(items,explicit)=>{
    if(!object(items)||!Array.isArray(explicit)||Object.entries(items).some(([id,m])=>id!==m?.id))throw new Error('模块安装记录键值不匹配')
    validateCatalog({schema:1,coreApi:CORE_API,minCoreVersion:CORE_VERSION,minNodeVersion:'18.17.0',modules:Object.values(items)})
    if(explicit.some(id=>!Object.prototype.hasOwnProperty.call(items,id)))throw new Error('显式模块未在安装集内')
  }
  validateSet(s.installed,s.explicit)
  if(s.pending)validateSet(s.pending.target,s.pending.explicit)
  return s
}
/** 旧版安装痕迹：保存过锅巴配置、旧版业务文件还在，或 data 下有旧版用户数据。
 * 只认 config.yaml 会把「从没在锅巴保存过配置」的老用户当成全新安装，他们更新后会永远显示无需迁移、功能全丢。 */
const LEGACY_DATA = ['auto_sign.json','bbs_coin.json','deleted_ck.yaml','resin_push.json','resin_timer.json','sr_gacha_pools.json','MysCookie','tmp']
function hasLegacyInstall(){
  if(fs.existsSync(path.join(root,'config','config.yaml'))) return true
  try{
    const files=readJson(path.join(root,'config','legacy-files.json')).files||{}
    if(Object.keys(files).some(name=>{try{return fs.existsSync(path.join(root,...name.split('/')))}catch{return false}})) return true
  }catch{}
  const dataDir=path.join(root,'data')
  try{
    if(LEGACY_DATA.some(name=>fs.existsSync(path.join(dataDir,name)))) return true
    if(fs.readdirSync(dataDir).some(name=>name!=='module-manager'&&/\.ya?ml$/i.test(name))) return true
  }catch{}
  return false
}
export function getState(){
  const state=validateState(readJson(stateFile))
  // 已经误判成「无需迁移」且一个业务模块都没装的老用户，按数据痕迹纠正回待迁移。
  if(state.migration==='none'&&!legacyIds.some(id=>state.installed[id])&&hasLegacyInstall()){
    state.migration='required'
    writeJson(stateFile,state)
    globalThis.logger?.warn?.('[xhh-TL][模块迁移] 检测到旧版安装痕迹，已重新标记为待迁移')
  }
  return state
}
/** 在 config.yaml 自动创建之前调用；入口与锅巴共用。 */
export function initializeState(){
  if(fs.existsSync(stateFile)) return getState()
  const legacy=hasLegacyInstall()
  const state={schema:1,installed:{},explicit:[],pending:null,migration:legacy?'required':'none',lastError:''}
  assertNoSymlink(stateFile);fs.mkdirSync(storeDir,{recursive:true})
  let fd
  try{fd=fs.openSync(stateFile,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(state,null,2));fs.fsyncSync(fd)}
  catch(error){if(error.code==='EEXIST')return getState();throw error}
  finally{if(fd!==undefined)fs.closeSync(fd)}
  return state
}
function dependencyClosure(ids,catalog=getCatalog()){
  const byId=new Map(catalog.modules.map(m=>[m.id,m])), result={}
  const visiting=new Set()
  function visit(id){
    if(result[id]) return
    if(visiting.has(id)) throw new Error('模块依赖成环')
    const m=byId.get(id)
    if(!m) throw new Error('未找到模块：'+id)
    visiting.add(id)
    for(const dep of m.dependencies) {
      visit(dep)
      if(m.dependencyVersions?.[dep] && result[dep].version!==m.dependencyVersions[dep]) throw new Error('模块依赖版本不匹配：'+id)
    }
    visiting.delete(id);result[id]=m
  }
  for(const id of ids) visit(id)
  return result
}
const LOCK_TTL = 10 * 60 * 1000
const STALL_LIMIT = 90 * 1000
const OPERATION_LIMIT = 20 * 60 * 1000
const STALL_TEXT = '模块下载长时间没有进展，已停止。请检查网络或配置下载代理后重试。'
const TIMEOUT_TEXT = '模块准备超过 20 分钟仍未完成，已停止。已下载的包会保留，下次操作继续用；请检查网络或配置下载代理后重试。'
async function exclusive(action){
  if(runtime.busy) throw new Error('模块操作进行中，请稍后再试')
  runtime.busy=true
  const lock=path.join(storeDir,'operation.lock')
  let descriptor, token
  try {
    assertNoSymlink(lock);fs.mkdirSync(storeDir,{recursive:true})
    try { descriptor=fs.openSync(lock,'wx',0o600) }
    catch(error) {
      if(error.code!=='EEXIST') throw error
      // 进程崩溃/被重启后锁文件会留在盘上，pid 还可能被别的进程复用 —— 超时或读不出来就直接接管。
      let owner
      try { owner=readJson(lock) } catch { owner=null }
      const stale=!Number.isFinite(owner?.at)||Date.now()-owner.at>LOCK_TTL
      let alive=!stale
      if(alive){ try {process.kill(owner.pid,0)} catch(e) {if(e.code==='ESRCH') alive=false} }
      if(alive) throw new Error('模块操作进行中，请稍后再试')
      fs.unlinkSync(lock);descriptor=fs.openSync(lock,'wx',0o600)
    }
    token=`${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`
    fs.writeFileSync(descriptor,JSON.stringify({pid:process.pid,at:Date.now(),token}))
    return await action()
  } finally {
    if(descriptor!==undefined){
      fs.closeSync(descriptor)
      // 只删自己的锁：卡住的操作如果已被后来者接管，这里不能把新锁删掉。
      try { if(readJson(lock)?.token===token) fs.unlinkSync(lock) } catch {}
    }
    runtime.busy=false
  }
}
async function cachePackage(m){
  const file=packageFile(m)
  if(fs.existsSync(file)){decodePackage(fs.readFileSync(file),m);return}
  const bytes=await downloadPackage(m)
  decodePackage(bytes,m);atomicWrite(file,bytes)
}
/** 迁移要拉几十个包，串行时慢源会把整轮拖到几十分钟；三路并发只压在下载这一步。
 * 每完成一个包刷新进度，锅巴和模块中心都能看到；abort 由停滞检测/取消按钮置位。 */
async function cachePackages(mods){
  if(!mods.length)return
  const total=mods.length, totalBytes=mods.reduce((n,m)=>n+(m.bytes||0),0)
  let done=0, bytes=0
  const report=()=>{
    runtime.progress={done,total,bytes,totalBytes,updatedAt:Date.now()}
    runtime.operation=`正在下载模块 ${done}/${total}（${mb(bytes)} / ${mb(totalBytes)}）…`
  }
  report()
  let failure
  const queue=[...mods]
  const worker=async()=>{
    while(!failure&&!runtime.abort){
      const m=queue.shift()
      if(!m)return
      try{
        await cachePackage(m)
        done++;bytes+=m.bytes||0;report()
      }catch(error){failure=failure||error}
    }
  }
  const parallel=downloadThreads()
  await Promise.all(Array.from({length:Math.min(parallel,queue.length)},worker))
  runtime.progress=null
  if(runtime.abort)throw new Error(runtime.abortReason==='cancel'?'操作已取消':runtime.abortReason==='timeout'?TIMEOUT_TEXT:STALL_TEXT)
  if(failure)throw failure
}
const mb=bytes=>(bytes/1048576).toFixed(1)+' MB'
export async function refreshCatalog(){return exclusive(async()=>{
  const c=validateCatalog(JSON.parse((await download('catalog.json',4*1024*1024)).toString('utf8')))
  writeJson(cacheCatalogFile,c);runtime.catalog=c
  return '模块目录已刷新，请重新读取配置查看。'
})}
function calculateOperation(state,action,id){
  if(!['install','uninstall','update','migrate'].includes(action)) throw new Error('未知模块操作')
  const known=getCatalog().modules.find(m=>m.id===id)
  if(action!=='migrate' && (!known||known.internal)) throw new Error('请选择可管理的模块')
  if(state.migration==='required' && action!=='migrate') throw new Error('请先完成旧版功能迁移')
  let explicit=[...(state.pending?.explicit||state.explicit)]
  const previous=state.pending?.target||state.installed
  if(action==='migrate'){
    if(state.migration!=='required') throw new Error('无需迁移旧版功能。')
    explicit=[...legacyIds,...getCatalog().modules.filter(m=>m.legacyResource).map(m=>m.id)]
  }else if(action==='install'){
    if(previous[id]){
      const pendingInstall=state.pending&&!state.installed[id]
      throw new Error(pendingInstall?'该模块已安排安装，重启机器人后生效。':'该模块已安装，无需重复安装。')
    }
    if(!explicit.includes(id)) explicit.push(id)
  }else if(action==='uninstall'){
    if(!previous[id]){
      const pendingRemoval=!!(state.pending&&state.installed[id])
      throw new Error(pendingRemoval?'该模块已安排卸载，重启机器人后生效。':'该模块未安装，无需卸载。')
    }
    explicit=explicit.filter(v=>v!==id)
    const retained=dependencyClosure(explicit)
    if(retained[id]) throw new Error('请先卸载依赖它的模块：'+explicit.filter(v=>dependencyClosure([v])[id]).map(v=>getCatalog().modules.find(m=>m.id===v).label).join('、'))
  }else{
    if(!previous[id]) throw new Error('请先安装该模块')
    if(previous[id].sha256===known.sha256){
      const pendingUpdate=!!(state.pending&&state.installed[id]&&state.installed[id].sha256!==previous[id].sha256)
      throw new Error(pendingUpdate?'该模块已安排更新，重启机器人后生效。':'该模块已是最新版本。')
    }
  }
  const refreshIds=action==='update'?new Set(Object.keys(dependencyClosure([id]))):new Set()
  // 更新共享依赖时同步准备依赖它的已安装模块，避免跨版本调用断裂。
  const available=getCatalog().modules
  let candidates
  for(let round=0;round<=available.length;round++) {
    candidates=available.map(m=>previous[m.id]&&!refreshIds.has(m.id)?previous[m.id]:m)
    const selected=new Map(candidates.map(m=>[m.id,m]))
    let expanded=false
    for(const m of candidates) if(previous[m.id]||explicit.includes(m.id)) for(const dep of m.dependencies) {
      if(m.dependencyVersions?.[dep] && selected.get(dep)?.version!==m.dependencyVersions[dep]) {
        for(const related of Object.keys(dependencyClosure([m.id]))) if(!refreshIds.has(related)){refreshIds.add(related);expanded=true}
      }
    }
    if(!expanded) break
  }
  const target=dependencyClosure(explicit,{modules:candidates})
  return {target,explicit}
}
export async function queueOperation(action,id){return exclusive(async()=>{
  const state=initializeState()
  if(action==='cancel'){state.pending=null;writeJson(stateFile,state);return '待重启变更已取消。'}
  const {target,explicit}=calculateOperation(state,action,id)
  await cachePackages(Object.values(target).filter(m=>state.installed[m.id]?.sha256!==m.sha256))
  state.pending={target,explicit,action,requestedAt:new Date().toISOString()};state.lastError=''
  writeJson(stateFile,state)
  const labels=Object.values(target).filter(m=>state.installed[m.id]?.sha256!==m.sha256).map(m=>m.label)
  return action==='uninstall'?'已安排卸载，重启机器人后生效；配置和用户数据保留。':`已准备${labels.length?'：'+labels.join('、'):''}。重启机器人后生效。`
})}

function fileMap(installed){
  const map=new Map()
  for(const m of Object.values(installed)) for(const f of m.files){
    if(map.has(f.path)) throw new Error('安装文件归属冲突：'+f.path)
    map.set(f.path,{...f,module:m})
  }
  return map
}
function restoreJournal(j){
  if(j.schema!==1 || !Array.isArray(j.files) || !/^[a-zA-Z0-9_-]+$/.test(j.id)) throw new Error('模块事务日志损坏')
  for(const item of j.files){
    const target=managedPath(item.path)
    if(item.existed){
      const file=path.join(storeDir,'rollback',j.id,sha256(item.path)+'.bin')
      assertNoSymlink(file)
      const bytes=fs.readFileSync(file)
      if(sha256(bytes)!==item.sha256) throw new Error('模块恢复备份损坏')
      atomicWrite(target,bytes)
    }else if(fs.existsSync(target)) fs.unlinkSync(target)
  }
  writeJson(stateFile,j.previous)
}
function finishJournal(j){
  if(!/^[a-zA-Z0-9_-]+$/.test(j.id)) throw new Error('事务标识无效')
  if(fs.existsSync(journalFile)) fs.unlinkSync(journalFile)
  const dir=path.join(storeDir,'rollback',j.id)
  assertNoSymlink(dir);fs.rmSync(dir,{recursive:true,force:true})
}
function recoverTransaction(){
  if(!fs.existsSync(journalFile)) return
  const j=readJson(journalFile),s=getState()
  if(s.transactionId!==j.id) restoreJournal(j)
  finishJournal(j)
}
function applyPending(){
  recoverTransaction()
  const state=getState()
  if(!state.pending) return state
  const old=fileMap(state.installed),next=fileMap(state.pending.target)
  const touched=[...new Set([...old.keys(),...next.keys()])].filter(n=>old.get(n)?.sha256!==next.get(n)?.sha256)
  const journal={schema:1,id:Date.now().toString(36),previous:state,files:[]}
  // 先校验所有包，再备份/修改任何文件；按包读取，避免全部素材同时常驻内存。
  for(const m of Object.values(state.pending.target)) if(state.installed[m.id]?.sha256!==m.sha256) decodePackage(fs.readFileSync(packageFile(m)),m)
  for(const name of touched){
    const target=managedPath(name),existed=fs.existsSync(target)
    let hash=''
    if(existed){
      const bytes=fs.readFileSync(target);hash=sha256(bytes)
      if(old.has(name)&&hash!==old.get(name).sha256) throw new Error('模块文件有本地修改，请先备份处理：'+name)
      if(!old.has(name)){
        const baseline=state.migration==='required'?readJson(path.join(root,'config','legacy-files.json')).files:{}
        if(hash!==next.get(name)?.sha256 && hash!==baseline[name]) throw new Error('安装目标存在自定义文件，请先备份处理：'+name)
      }
      atomicWrite(path.join(storeDir,'rollback',journal.id,sha256(name)+'.bin'),bytes)
    }
    journal.files.push({path:name,existed,sha256:hash})
  }
  writeJson(journalFile,journal)
  try{
    const changed=new Set(touched)
    for(const m of Object.values(state.pending.target)){
      if(state.installed[m.id]?.sha256===m.sha256) continue
      for(const [name,data] of decodePackage(fs.readFileSync(packageFile(m)),m)) if(changed.has(name)) atomicWrite(managedPath(name),data)
    }
    for(const name of touched) if(!next.has(name)&&fs.existsSync(managedPath(name))) fs.unlinkSync(managedPath(name))
    const result={...state,installed:state.pending.target,explicit:state.pending.explicit,pending:null,migration:'complete',lastError:'',transactionId:journal.id}
    writeJson(stateFile,result)
    // 状态已提交且不再需要回滚后，回收所有未引用版本（包括历史升级残留）。
    // 清理失败只记日志，不能把已经提交的事务回滚。
    try {
      const retained=new Set(Object.values(result.installed).map(m=>path.basename(packageFile(m))))
      const cacheDir=path.join(storeDir,'packages');assertNoSymlink(cacheDir)
      if(fs.existsSync(cacheDir)) for(const name of fs.readdirSync(cacheDir)) {
        if(!/^[a-z][a-z0-9_]{0,63}-[a-f0-9]{64}\.xhmp$/.test(name)||retained.has(name)) continue
        try {const file=path.join(cacheDir,name);assertNoSymlink(file);fs.unlinkSync(file)}
        catch(error) {if(error.code!=='ENOENT') globalThis.logger?.warn?.('[xhh-TL] 模块缓存清理失败',error)}
      }
    } catch(error) {globalThis.logger?.warn?.('[xhh-TL] 模块缓存清理失败',error)}
    try { finishJournal(journal) } catch(error) { globalThis.logger?.warn?.('[xhh-TL] 模块事务清理待下次启动完成',error) }
    return result
  }catch(e){restoreJournal(journal);finishJournal(journal);throw e}
}
export async function prepareLegacyMigration(){
  if(runtime.booted||runtime.migrationAttempted) return
  runtime.migrationAttempted=true
  const state=initializeState()
  if(state.migration==='required'&&!state.pending){
    try { await queueOperation('migrate') }
    catch(error){ globalThis.logger?.error?.('[xhh-TL] 旧版迁移待重试',error);state.lastError=String(error.message);writeJson(stateFile,state) }
  }
}
export function bootModules(){
  if(runtime.booted) return runtime.running
  initializeState()
  try{runtime.running=applyPending().installed}
  catch(e){
    runtime.errors.boot=e.message
    globalThis.logger?.error?.('[xhh-TL][模块启动]',e)
    const state=getState();state.lastError=e.message;writeJson(stateFile,state)
    // 未能恢复的事务可能留下混合版本，不能继续注册业务；核心管理入口仍可用。
    runtime.running=fs.existsSync(journalFile)?{}:state.installed
  }
  runtime.booted=true
  return runtime.running
}
export function isInstalled(id){return !!(runtime.booted?runtime.running:initializeState().installed)[id]}
export function moduleError(id){return runtime.errors[id]||''}
export function recordModuleError(id,error){
  runtime.errors[id]=String(error?.message||error)
  globalThis.logger?.error?.(`[xhh-TL][${id}] 模块未加载`,error)
}
/** 帮助仅列出本进程实际注册的功能；修改开关不能凭空创建类或任务。 */
export function isModuleLoaded(id){
  if(!runtime.appsLoaded) return isInstalled(id)
  const visited=new Set()
  const ready=key=>{
    if(visited.has(key)) return true
    visited.add(key)
    const m=runtime.running[key]
    if(!m||runtime.errors[key]) return false
    if(m.entries.length&&!runtime.loaded?.[key]) return false
    return m.dependencies.every(ready)
  }
  return ready(id)
}
export async function loadModuleApps(isEnabled){
  const installed=bootModules(),apps={}
  runtime.appsLoaded=false;runtime.loaded={}
  const generation=beginTaskGeneration()
  for(const m of Object.values(installed)){
    if(!m.entries.length||(!m.internal&&!isEnabled(m.id))) continue
    try{
      const deps=dependencyClosure([m.id],{modules:Object.values(installed)})
      for(const dep of Object.values(deps)){
        if(dep.requiresMiao&&!fs.existsSync(path.join(root,'..','miao-plugin','models','index.js'))) throw new Error('请先安装 miao-plugin')
        for(const f of dep.files) if(!fs.existsSync(managedPath(f.path))) throw new Error('模块文件缺失：'+f.path)
      }
      if(deps.shared_account) await import(pathToFileURL(managedPath('utils/ckAutoRefresh.js')).href)
      const moduleApps={}
      for(const entry of m.entries){
        const mod=await import(pathToFileURL(managedPath(entry.path)).href)
        if(typeof mod[entry.export]!=='function') throw new Error('模块入口导出无效')
        moduleApps[m.id+'_'+entry.export]=wrapModuleClass(mod[entry.export],m.id,generation,isEnabled)
      }
      Object.assign(apps,moduleApps);runtime.loaded[m.id]=true
      delete runtime.errors[m.id]
    }catch(e){recordModuleError(m.id,e)}
  }
  runtime.appsLoaded=true
  return apps
}
export function moduleSnapshot(enabled=()=>true){
  const state=initializeState(), catalog=getCatalog()
  const modules=catalog.modules.filter(m=>!m.internal).map(m=>{
    const active=state.installed[m.id],target=state.pending?.target[m.id]
    let status=active?(enabled(m.id)?'installed':'disabled'):'available'
    if(runtime.errors[m.id]) status='failed'
    if(state.pending){
      if(!active&&target) status='pending-install'
      else if(active&&!target) status='pending-uninstall'
      else if(active&&target&&active.sha256!==target.sha256) status='pending-update'
    }
    const closure=Object.values(dependencyClosure([m.id]))
    return {id:m.id,label:m.label,description:m.description,category:m.legacyResource?'assets':'feature',
      installed:!!active,status,version:active?.version||'',latestVersion:m.version,
      updateAvailable:!!active&&active.sha256!==m.sha256,
      dependencies:[...new Set(m.dependencies.map(id=>catalog.modules.find(x=>x.id===id)?.label||id))],
      bytes:closure.reduce((sum,x)=>sum+x.bytes,0),
      requiresMiao:closure.some(x=>x.requiresMiao),
    }
  })
  return {modules,busy:runtime.busy,operation:{status:runtime.operationState||'idle',message:operationStatus(),action:runtime.action||'',moduleId:runtime.moduleId||''},
    pending:!!state.pending,migrationRequired:state.migration==='required',hasError:!!state.lastError}
}
const STATE_LABELS={installed:'已安装',disabled:'已关闭',available:'未安装',failed:'加载失败','pending-install':'待重启安装','pending-uninstall':'待重启卸载','pending-update':'待重启更新'}
export function moduleOverview(enabled=()=>true){
  const snapshot=moduleSnapshot(enabled)
  return (snapshot.operation.message?snapshot.operation.message+'\n\n':'')+snapshot.modules.map(m=>
    `${m.label}｜${STATE_LABELS[m.status]}｜${m.version||'—'} → ${m.latestVersion}${m.dependencies.length?'\n  依赖：'+m.dependencies.join('、'):''}`).join('\n')
}
export function previewOperation(action,id){
  // 取消是唯一在忙碌时也要放行的动作：下载卡住时用户总得有条退路。
  if(runtime.busy&&action!=='cancel') throw new Error(runtime.progress?runtime.operation:'模块操作进行中，请稍后再试')
  const state=initializeState()
  if(action==='refresh')return {action,changes:[],downloadBytes:0}
  if(action==='cancel')return {action,changes:[],downloadBytes:0}
  const {target}=calculateOperation(state,action,id)
  const changes=[],previous=state.pending?.target||state.installed
  let downloadBytes=0
  for(const m of Object.values(target)){
    if(previous[m.id]?.sha256!==m.sha256)changes.push({id:m.id,label:m.label,action:previous[m.id]?'update':'install'})
    if(state.installed[m.id]?.sha256!==m.sha256&&!fs.existsSync(packageFile(m)))downloadBytes+=m.bytes
  }
  for(const m of Object.values(previous))if(!target[m.id])changes.push({id:m.id,label:m.label,action:'uninstall'})
  return {action,changes,downloadBytes}
}

/** 锅巴请求只提交后台操作，避免大包下载超过面板 HTTP 超时。 */
export function startOperation(action,id){
  if(!['install','uninstall','update','migrate','cancel','refresh'].includes(action)) throw new Error('未知模块操作')
  if(runtime.busy){
    if(action!=='cancel') throw new Error(runtime.progress?runtime.operation:'模块操作进行中，请稍后再试')
    // 正在下载时点取消：先让后台停下，等它退出后再取消待重启变更。
    runtime.abort=true;runtime.abortReason='cancel'
    runtime.operation='正在停止当前模块操作，请稍候…'
    return runtime.operation
  }
  if(['install','uninstall','update'].includes(action)&&!getCatalog().modules.some(m=>m.id===id&&!m.internal)) throw new Error('请选择可管理的模块')
  previewOperation(action,id)
  runtime.operationState='running';runtime.action=action;runtime.moduleId=id||''
  runtime.operation='正在准备模块变更…'
  runtime.abort=false;runtime.abortReason='';runtime.progress=null
  setDownloadCancelCheck(()=>runtime.abort)
  const task=action==='refresh'?refreshCatalog():queueOperation(action,id)
  const startedAt=Date.now()
  const watchdog=setInterval(()=>{
    if(runtime.operationState!=='running'||runtime.abort){clearInterval(watchdog);return}
    const last=runtime.progress?.updatedAt||startedAt
    if(Date.now()-startedAt>OPERATION_LIMIT){
      runtime.abort=true;runtime.abortReason='timeout';runtime.operationState='failed';runtime.operation=TIMEOUT_TEXT
      globalThis.logger?.error?.('[xhh-TL][模块后台操作] 超过总时限，已请求停止')
    }else if(Date.now()-last>STALL_LIMIT){
      runtime.abort=true;runtime.abortReason='stall';runtime.operationState='failed';runtime.operation=STALL_TEXT
      globalThis.logger?.error?.('[xhh-TL][模块后台操作] 下载长时间无进展，已请求停止')
    }
  },10_000)
  runtime.operationPromise=task.then(message=>{runtime.operation=message;runtime.operationState='success'}).catch(error=>{
    const stopped={cancel:'当前模块操作已停止，请稍候再试。',timeout:TIMEOUT_TEXT,stall:STALL_TEXT}[runtime.abortReason]
    runtime.operationState='failed'
    runtime.operation=stopped||userFacingError(error)||'模块操作失败，请查看日志后重试。'
    globalThis.logger?.error?.('[xhh-TL][模块后台操作]',error)
    // 用户主动取消不是故障，不写进「上次操作失败」。
    if(runtime.abortReason!=='cancel'){
      try{const s=getState();s.lastError=stopped||String(error.message);writeJson(stateFile,s)}catch{}
    }
  }).finally(()=>{
    clearInterval(watchdog)
    setDownloadCancelCheck(null)
    runtime.abort=false
    runtime.abortReason=''
    runtime.progress=null
  })
  return runtime.operation
}
export function operationStatus(){return runtime.operation||''}
/** 能直接展示给用户的错误；其余技术错误只写日志。两个锅巴入口共用这一份判据，避免再出现一边认得一边不认得。 */
const USER_ERROR = [
  /^(请选择|请先|模块操作进行中|未知模块操作|无需迁移)/,
  /^(所有下载源都失败了|模块下载被平台拦截|模块包校验失败)/,
  /^(模块文件有本地修改|安装目标存在自定义文件)/,
]
// 插件主动抛的都是中文提示，英文堆栈、文件路径、超长内容才该留在日志里。
const TECH_ERROR = /[\r\n]|\bat\s+\S+\s+\(|\.js:\d|ENOENT|EPERM|EACCES|ECONN|Cannot read|is not a function|undefined is not/
export function userFacingError(error) {
  const text = String(typeof error === 'string' ? error : error?.message || '').trim()
  if (!text) return ''
  if (USER_ERROR.some(pattern => pattern.test(text))) return text
  if (text.length <= 160 && /^[\u4e00-\u9fa5]/.test(text) && !TECH_ERROR.test(text)) return text
  return ''
}
