import {taskIsCurrent} from './taskLifecycle.js'
import crypto from 'node:crypto'
/** 主动发送只认订阅来源机器人；旧记录多账号归属不明时不猜。 */
export function protocolId(value) {
  if (typeof value === 'number') return value
  const s=String(value ?? '')
  if (/^[1-9]\d*$/.test(s) && Number.isSafeInteger(Number(s))) return Number(s)
  return s
}
const idOf=bot=>typeof bot?.uin==='string'||typeof bot?.uin==='number'?String(bot.uin):''
const usable=(bot,key='')=>bot && !['stdin','mock'].includes(String(key||idOf(bot)).toLowerCase()) && typeof bot.pickGroup==='function'
export function subscriptionRoute(e){
  const botId=String(e?.self_id ?? idOf(e?.bot) ?? '')
  if(!botId || ['stdin','mock'].includes(botId.toLowerCase())) throw new Error('当前机器人不支持订阅推送')
  return {revision:crypto.randomUUID(),bot:botId,group:String(e.group_id),user:String(e.user_id),account:String(e.originalUserId ?? e.user_id)}
}
export function resolveDeliveryBot(botId='',groupId=''){
  const root=globalThis.Bot
  if(!root) throw new Error('机器人尚未就绪')
  const direct=idOf(root)
  if(botId){
    const bot=direct===String(botId)?root:(root.bots?.[botId]||root[botId])
    if(usable(bot,botId)) return bot
    throw new Error('订阅机器人不可用')
  }
  if(direct&&usable(root,direct)) return root
  const ids=Array.isArray(root.uin)?root.uin:Object.keys(root.bots||root)
  const all=[...new Set(ids.map(String))].map(id=>[id,root.bots?.[id]||root[id]]).filter(([id,b])=>usable(b,id))
  const matching=all.filter(([,b])=>b.gl?.has?.(protocolId(groupId))||b.gl?.has?.(String(groupId)))
  if(matching.length===1) return matching[0][1]
  if(!matching.length&&all.length===1) return all[0][1]
  throw new Error('旧订阅无法确定发送机器人，请重新设置订阅')
}
export function deliveryGroup(groupId,botId=''){
  if(!taskIsCurrent())throw new Error('任务所属模块已重载，停止旧任务发送')
  if(groupId===undefined||groupId===null||String(groupId)==='') throw new Error('订阅缺少群标识')
  const bot=resolveDeliveryBot(botId,groupId),group=bot.pickGroup(protocolId(groupId))
  if(typeof group?.sendMsg!=='function') throw new Error('当前协议不支持群消息发送')
  return {bot,group}
}
export function scheduledEvent(qq,groupId,route={},Runtime){
  const {bot,group}=deliveryGroup(groupId,route.bot||'')
  const event={user_id:route.user||qq,originalUserId:route.account||qq,self_id:route.bot||idOf(bot),bot,isGroup:true,group_id:groupId,group,message:[],msg:'',reply:async()=>false,sender:{nickname:String(qq)}}
  if(Runtime)event.runtime=new Runtime(event)
  return event
}
export function mention(userId){
  const id=protocolId(userId)
  if(typeof globalThis.segment?.at==='function')return globalThis.segment.at(id)
  return '@'+String(userId)+' '
}

/** 保持旧版单目的地订阅语义，但其他机器人不能覆盖或取消已有记录。 */
export function ownsSubscription(sub,e){
  if(!sub)return true
  const id=String(e?.self_id ?? idOf(e?.bot))
  if(sub.bot)return String(sub.bot)===id
  try{return idOf(resolveDeliveryBot('',sub.group))===id}catch{return false}
}
export function canChangeSubscription(sub,e){
  if(ownsSubscription(sub,e))return true
  e?.reply?.('请到原订阅机器人处关闭订阅后再设置。',false)
  return false
}
export function subscriptionMatches(current,expected){
  if(!current||!expected)return false
  const fields=['revision','bot','group','user','account','threshold']
  return fields.every(k=>String(current[k]??'')===String(expected[k]??'')) &&
    JSON.stringify(Object.keys(current.uids||{}).sort())===JSON.stringify(Object.keys(expected.uids||{}).sort())
}
