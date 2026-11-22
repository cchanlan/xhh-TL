(() => {
'use strict'
const $=id=>document.getElementById(id)
const labels={installed:'已安装',disabled:'已关闭',available:'未安装',failed:'加载失败','pending-install':'待重启安装','pending-uninstall':'待重启卸载','pending-update':'待重启更新'}
const verbs={install:'安装',uninstall:'卸载',update:'更新',refresh:'检查更新',cancel:'取消待重启变更',migrate:'迁移旧版功能'}
let moduleImages={},iconsReady=false,nextIconAttempt=0
function imageIcon(id){
 const wrap=node('span','✦','module-icon'),src=moduleImages[id]
 if(src&&/^data:image\/(webp|png);base64,/.test(src)){
  const img=document.createElement('img');img.src=src;img.alt='';img.decoding='async';img.onerror=()=>{wrap.textContent='✦'};wrap.replaceChildren(img)
 }
 return wrap
}
let snapshot=null,filter='all',timer=null,reading=false,requesting=false,checking=false,authFailed=false,actionError=false,dialogAction=null,returnFocus=null,lastRender='',epoch=0
const cfg=window.__GUOBA__||{}
let base
try{base=new URL(cfg.apiBase,location.origin);if(!cfg.apiBase||base.origin!==location.origin)throw new Error('invalid')}catch{$('error').hidden=false;$('error-text').textContent='请从锅巴的扩展页面打开模块中心。';return}
const media=matchMedia('(prefers-color-scheme: dark)')
function theme(){
 let dark=media.matches
 try{const host=parent.document.documentElement;const value=host.getAttribute('data-theme');if(value==='dark'||value==='light')dark=value==='dark';else if(host.classList.contains('dark'))dark=true}catch{}
 document.documentElement.dataset.theme=dark?'dark':'light'
}
theme();media.addEventListener?.('change',theme)
try{new MutationObserver(theme).observe(parent.document.documentElement,{attributes:true,attributeFilter:['class','data-theme']})}catch{}
$('settings').onclick=e=>{e.preventDefault();try{parent.location.hash='/plugin/@/xhh-TL'}catch{}}
function node(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n}
const size=bytes=>bytes<1024?bytes+' B':bytes<1048576?(bytes/1024).toFixed(1)+' KB':(bytes/1048576).toFixed(1)+' MB'
async function api(route,body){
 const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000)
 try{
  const headers={'Accept':'application/json',[cfg.tokenKey||'guoba-access-token']:cfg.token||''}
  if(body)headers['Content-Type']='application/json'
  const response=await fetch(base.href.replace(/\/$/,'')+route,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,credentials:'same-origin',signal:controller.signal})
  if(response.status===401||response.status===403){authFailed=true;throw new Error('登录已失效，请重新登录锅巴后打开本页。')}
  const result=await response.json()
  if(!response.ok||!result.ok)throw new Error(result.message||'操作失败，请稍后重试。')
  return result.result
 }finally{clearTimeout(timeout)}
}
function error(e){$('error').hidden=false;$('error-text').textContent=e.name==='AbortError'?'请求超时，请稍后重试。':e.message||'连接失败，请稍后重试。';$('retry').hidden=authFailed;updateButtons()}
function button(text,action,id,kind=''){const b=node('button',text,kind);b.dataset.action=action;b.dataset.module=id||'';b.onclick=()=>preview(action,id);return b}
const canUpdate=m=>m.installed&&m.updateAvailable&&!m.status.startsWith('pending-')
function render(){
 if(!snapshot)return
 const q=$('search').value.trim().toLowerCase(),category=$('category').value
 const priority=['tl','waves','resin_push','resin_timer','auto_sign','redeem','bbs_coin']
 const sorted=[...snapshot.modules].sort((a,b)=>(a.category==='assets')-(b.category==='assets')||((priority.indexOf(a.id)+1)||99)-((priority.indexOf(b.id)+1)||99))
 const modules=sorted.filter(m=>(filter==='all'||(filter==='installed'?m.installed:filter==='updates'?canUpdate(m):!m.installed))&&(category==='all'||m.category===category)&&(!q||(m.label+' '+m.description).toLowerCase().includes(q)))
 $('result-label').textContent=modules.length+' 个模块';$('list-title').textContent=filter==='installed'?'我的模块':filter==='available'?'待发现的功能':filter==='updates'?'可更新的模块':'发现模块'
 const updateIds=snapshot.modules.filter(canUpdate).map(m=>m.id),updates=updateIds.length,op=snapshot.operation
 $('update-all').hidden=filter!=='updates';$('update-all').textContent=updates?'一键更新 '+updates+' 个':'一键更新'
 $('update-all').title='更新全部可更新的已安装模块，不受搜索和类型筛选影响'
 $('updates-filter').textContent='可更新'+(updates?' '+updates:'')
 $('update-summary').textContent=updates?'本地目录中有 '+updates+' 个已安装模块可更新':'本地目录中暂无可更新模块'
 if(op.action==='refresh'){
  if(snapshot.busy)$('update-summary').textContent='正在检查模块更新…'
  else if(op.status==='success')$('update-summary').textContent=updates?'检查完成 · '+updates+' 个已安装模块可更新':'检查完成 · 未发现可更新的已安装模块'
  else if(op.status==='failed')$('update-summary').textContent='检查失败，当前仍显示上次目录'
 }
 const fragment=document.createDocumentFragment()
 for(const m of modules){
  const card=node('article',undefined,'card');card.dataset.id=m.id
  const top=node('div',undefined,'card-top'),heading=node('div',undefined,'card-heading')
  heading.append(node('h3',m.label),node('span',m.category==='assets'?'素材图库':'功能模块','kind'))
  const badges=node('div',undefined,'badges'),updatable=canUpdate(m)
  badges.append(node('span',updatable&&m.status==='installed'?'可更新':labels[m.status]||m.status,'badge '+(updatable&&m.status==='installed'?'update-available':m.status)))
  if(updatable&&m.status!=='installed')badges.append(node('span','可更新','badge update-available'))
  top.append(imageIcon(m.id),heading,badges)
  card.append(top,node('p',m.description,'description'))
  if(m.error)card.append(node('p','加载失败：'+m.error,'error-note'))
  const details=node('dl',undefined,'details')
  for(const [label,text] of [['当前版本',m.version||'尚未安装'],['可用版本',m.latestVersion],['依赖',m.dependencies.join('、')||'无额外模块']])details.append(node('dt',label),node('dd',text))
  if(m.requiresMiao)details.append(node('dt','运行环境'),node('dd','需要 miao-plugin'))
  card.append(details)
  const bottom=node('div',undefined,'card-bottom'),actions=node('div',undefined,'card-actions')
  if(m.status.startsWith('pending-'))actions.append(node('span','重启后生效','size'))
  else if(m.installed){if(m.updateAvailable)actions.append(button('更新','update',m.id));actions.append(button('卸载','uninstall',m.id,'danger'))}
  else actions.append(button('安装','install',m.id))
  bottom.append(node('span','含依赖 '+size(m.bytes),'size'),actions);card.append(bottom);fragment.append(card)
 }
 $('modules').replaceChildren(fragment);$('modules').setAttribute('aria-busy','false');$('empty').hidden=!!modules.length
 const operationMessage=op.action==='refresh'&&op.status!=='failed'?'':op.message
 $('operation').hidden=!(operationMessage||snapshot.pending||snapshot.migrationRequired||snapshot.hasError)
 $('operation-text').textContent=operationMessage||(snapshot.migrationRequired?'检测到旧版功能，请先完成迁移。':snapshot.hasError?'上次操作未完成，请查看日志后重试。':'模块变更已准备，重启机器人后生效。')
 $('migrate').hidden=!snapshot.migrationRequired;$('cancel-pending').hidden=!snapshot.pending
 updateButtons()
}
function updateButtons(){
 const busy=requesting||snapshot?.busy||authFailed
 $('refresh').textContent=checking||(snapshot?.busy&&snapshot.operation.action==='refresh')?'检查中…':'↻ 检查更新'
 for(const b of document.querySelectorAll('[data-action],#refresh,#migrate,#cancel-pending'))b.disabled=!!busy
 $('update-all').disabled=!!busy||!snapshot||snapshot.migrationRequired||!snapshot.modules.some(canUpdate)
 if(snapshot?.migrationRequired)for(const b of document.querySelectorAll('[data-action]'))b.disabled=true
}
function schedule(){clearTimeout(timer);if(!authFailed&&!document.hidden)timer=setTimeout(load,snapshot?.busy?1200:10000)}
async function load(){
 if(reading||requesting||authFailed){schedule();return}
 reading=true;const readEpoch=epoch
 try{const iconsChanged=await loadIcons();if(authFailed)return;const data=await api('/modules');if(readEpoch!==epoch)return;snapshot=data;if(!actionError)$('error').hidden=true;const signature=JSON.stringify(data);if(iconsChanged||signature!==lastRender){lastRender=signature;render()}}
 catch(e){error(e)}finally{reading=false;schedule()}
}

async function checkUpdates(){
 if(requesting||snapshot?.busy||authFailed)return
 actionError=false;$('error').hidden=true;requesting=true;checking=true;epoch++;updateButtons();clearTimeout(timer)
 try{await api('/modules/operation',{action:'refresh'});lastRender=''}
 catch(e){actionError=true;error(e)}
 finally{requesting=false;checking=false;updateButtons();await load()}
}
async function preview(action,id){
 if(requesting||snapshot?.busy||authFailed)return
 actionError=false;$('error').hidden=true;requesting=true;updateButtons();clearTimeout(timer)
 try{
  const body={action,...(id?{moduleId:id}:{})},plan=await api('/modules/preview',body)
  dialogAction=body;returnFocus=document.activeElement
  const bulk=action==='update'&&Array.isArray(id)
  const name=bulk?'全部可更新模块（'+id.length+' 个）':snapshot.modules.find(m=>m.id===id)?.label||''
  $('dialog-title').textContent=(bulk?'一键更新':verbs[action])+(name?' · '+name:'')
  const target=snapshot.modules.find(m=>m.id===id)
  $('dialog-note').textContent=action==='uninstall'
    ? (target?.category==='assets'?'重启后移除该素材包；相关卡片会缺少对应背景/立绘，出图可能缺图。账号、配置与订阅保留。':'重启后移除所选功能及不再使用的依赖，保留账号、配置与订阅。')
    : bulk?'更新全部可更新的已安装模块及相关依赖；不受搜索筛选影响，不修改显示开关，不自动重启机器人。':action==='cancel'?'取消全部尚未生效的变更，已生效的模块不受影响。':action==='refresh'?'获取最新模块目录，不自动安装或更新任何功能。':'准备以下模块及依赖，重启机器人后生效。'
  $('dialog-changes').replaceChildren(...plan.changes.map(m=>node('li',(verbs[m.action]||m.action)+' · '+m.label)))
  $('dialog-size').textContent=plan.downloadBytes?'本次预计下载 '+size(plan.downloadBytes):'无需额外下载'
  $('confirm').textContent='确认'+verbs[action];$('modal').hidden=false;$('dismiss').focus()
 }catch(e){actionError=true;error(e)}finally{requesting=false;updateButtons();schedule()}
}
function close(){if(requesting)return;$('modal').hidden=true;dialogAction=null;returnFocus?.focus()}
$('dismiss').onclick=close
$('modal').onclick=e=>{if(e.target===$('modal'))close()}
document.addEventListener('keydown',e=>{
 if($('modal').hidden)return
 if(e.key==='Escape'){e.preventDefault();close()}
 if(e.key==='Tab'){
  const focusable=Array.from($('modal').querySelectorAll('button:not(:disabled)'))
  if(!focusable.length){e.preventDefault();return}
  const first=focusable[0],last=focusable[focusable.length-1]
  if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}
  else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}
 }
})
$('confirm').onclick=async()=>{
 if(!dialogAction||requesting)return
 requesting=true;epoch++;$('confirm').disabled=true;$('dismiss').disabled=true;updateButtons();clearTimeout(timer)
 try{await api('/modules/operation',dialogAction);$('modal').hidden=true;dialogAction=null;lastRender=''}
 catch(e){$('modal').hidden=true;dialogAction=null;actionError=true;error(e)}
 finally{requesting=false;$('confirm').disabled=false;$('dismiss').disabled=false;updateButtons();await load()}
}
for(const b of document.querySelectorAll('[data-filter]'))b.onclick=()=>{
 filter=b.dataset.filter;for(const tab of document.querySelectorAll('[data-filter]')){tab.classList.toggle('selected',tab===b);tab.setAttribute('aria-pressed',String(tab===b))}render()
}
$('search').oninput=render;$('category').onchange=render
$('update-all').onclick=()=>{const ids=(snapshot?.modules||[]).filter(canUpdate).map(m=>m.id);if(ids.length)preview('update',ids)}
$('refresh').onclick=checkUpdates;$('migrate').onclick=()=>preview('migrate');$('cancel-pending').onclick=()=>preview('cancel');$('retry').onclick=()=>{actionError=false;load()}
document.addEventListener('visibilitychange',()=>{clearTimeout(timer);if(!document.hidden)load()})
window.addEventListener('pagehide',()=>clearTimeout(timer))
async function loadIcons(){
 if(iconsReady||Date.now()<nextIconAttempt)return false
 nextIconAttempt=Date.now()+30000
 try{
  const data=await api('/icons')
  moduleImages=data.images||{}
  iconsReady=Object.keys(moduleImages).length>0
  if(/^data:image\/png;base64,/.test(data.brand||'')){
   const img=$('brand-icon');img.src=data.brand;img.hidden=false;img.onerror=()=>{img.hidden=true}
  }
  return iconsReady
 }catch(e){if(authFailed)throw e;return false}
}
async function start(){await load()}

start()
})()
