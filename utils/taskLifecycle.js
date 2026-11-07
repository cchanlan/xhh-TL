import {AsyncLocalStorage} from 'node:async_hooks'
import {root} from './moduleStore.js'
const key=Symbol.for('xhh-TL.task-lifecycle.v2')
const states=globalThis[key]||(globalThis[key]=new Map())
const state=states.get(root)||{generation:0,tasks:new Set(),inflight:new Set(),context:new AsyncLocalStorage()}
states.set(root,state)
export function taskIsCurrent(){const value=state.context.getStore();return !value||value.generation===state.generation}
export function beginTaskGeneration(){
  state.generation++
  for(const task of state.tasks){try{task.job?.cancel?.()}catch(error){globalThis.logger?.warn?.('[xhh-TL] 旧任务清理失败',error)}}
  state.tasks.clear()
  return state.generation
}
export function wrapModuleClass(Base,id,generation,enabled){
  return class extends Base {
    constructor(...args){
      super(...args)
      const list=Array.isArray(this.task)?this.task:[this.task]
      for(const task of list){
        if(!task?.cron||!task.fnc)continue
        const callback=typeof task.fnc==='function'?task.fnc.bind(this):this[task.fnc]?.bind(this)
        if(!callback)continue
        const taskKey=id+':'+(task.name||task.cron)
        task.fnc=async()=>{
          if(generation!==state.generation||!enabled(id)||state.inflight.has(taskKey))return false
          state.inflight.add(taskKey)
          try{return await state.context.run({generation},callback)}finally{state.inflight.delete(taskKey)}
        }
        state.tasks.add(task)
      }
      for(const handler of this.handler||[]){
        const callback=this[handler.fn]
        if(typeof callback!=='function')continue
        this[handler.fn]=(...args)=>{
          if(generation!==state.generation||!enabled(id)){const reject=args[args.length-1];return typeof reject==='function'?reject():false}
          return state.context.run({generation},()=>callback.apply(this,args))
        }
      }
    }
  }
}
