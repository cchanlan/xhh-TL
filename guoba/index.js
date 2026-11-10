import fs from 'node:fs'
import {moduleSnapshot,previewOperation,startOperation,userFacingError} from '../utils/moduleManager.js'
import {isModuleEnabled,MODULES} from '../utils/modules.js'


// 固定核心帮助素材白名单；不接受请求参数指定文件。卸载业务模块不影响图标。
const iconFiles={"tl": "multi.webp", "waves": "ww-01.webp", "resin_push": "gs-resin.webp", "resin_timer": "active.webp", "auto_sign": "signin.webp", "redeem": "gs-丽莎.webp", "bbs_coin": "gs-七七.webp", "solver": "sr-花火.webp", "captcha": "mask.webp", "del_ck": "sr-镜流.webp", "tmp_clean": "sr-藿藿.webp", "gs_all_abyss": "gs-logo.webp", "abyss_team": "gs-枫原万叶.webp", "hard_team": "gs-钟离.webp", "hold_rate": "gs-纳西妲.webp", "team_damage": "gs-雷电将军.webp", "role_combat": "gs-芙宁娜.webp", "sr_all_abyss": "sr-logo.webp", "sr_gacha": "sr-砂金.webp", "nanoka": "sr-黑天鹅.webp", "assets_bg": "gs-甘雨.webp", "assets_zzz": "zzz-01.webp", "assets_waves": "ww-02.webp"}
let iconCache
function moduleIcons(){
 if(iconCache)return iconCache
 const images={}
 for(const [id,file] of Object.entries(iconFiles)){
  try{images[id]='data:image/webp;base64,'+fs.readFileSync(new URL('../resources/help/icons/'+file,import.meta.url)).toString('base64')}catch{}
 }
 let brand=''
 try{brand='data:image/png;base64,'+fs.readFileSync(new URL('../resources/icon.png',import.meta.url)).toString('base64')}catch{}
 return iconCache={brand,images}
}

/** 锅巴原生扩展协议；仅在其已鉴权 custom API 路由下注册。 */
export function init(ctx){
  ctx.registerPage({id:'xhh-module-center',title:'小火花模块中心',icon:'ant-design:appstore-outlined',usePluginIcon:true,src:'index.html',style:'style.css',script:'app.js',priority:60})
  const safe=handler=>async(req,res)=>{
    res.setHeader('Cache-Control','no-store')
    try{
      // 主鉴权由锅巴执行；此处额外拒绝跨站及 Cookie-only 调用。
      if(!req.headers?.['guoba-access-token'] || req.headers['sec-fetch-site']==='cross-site')return res.status(403).json({ok:false,message:'请在锅巴登录后操作。'})
      const origin=req.headers.origin
      if(origin){let url;try{url=new URL(origin)}catch{return res.status(403).json({ok:false,message:'请求来源无效。'})}
        if(url.host!==req.headers.host)return res.status(403).json({ok:false,message:'请从同一锅巴地址操作。'})}
      if(req.method!=='GET'&&!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return res.status(415).json({ok:false,message:'请求格式不支持。'})
      res.json({ok:true,result:await handler(req)})
    }
    catch(error){
      ctx.logger?.error?.('[xhh-TL][模块中心]',error)
      const message=userFacingError(error)||'操作失败，请查看日志后重试。'
      res.status(400).json({ok:false,message})
    }
  }
  const input=req=>{
    const body=req.body
    if(!body||Array.isArray(body)||typeof body!=='object'||Object.keys(body).some(k=>!['action','moduleId'].includes(k)))throw new Error('未知模块操作参数')
    if(!['install','uninstall','update','refresh','cancel','migrate'].includes(body.action))throw new Error('未知模块操作')
    if(body.moduleId!==undefined&&(typeof body.moduleId!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(body.moduleId)))throw new Error('请选择可管理的模块')
    return body
  }
  ctx.registerApi('get','/icons',safe(()=>moduleIcons()))
  ctx.registerApi('get','/modules',safe(()=>moduleSnapshot(id=>MODULES[id]?isModuleEnabled(id):true)))
  ctx.registerApi('post','/modules/preview',safe(req=>{const b=input(req);return previewOperation(b.action,b.moduleId)}))
  ctx.registerApi('post','/modules/operation',safe(req=>{const b=input(req);return {message:startOperation(b.action,b.moduleId)}}))
}
