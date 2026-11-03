'use client';
import * as React from 'react';
import {workspaceApi} from '@/lib/api';
import {useVisibilityPolling} from '@/lib/use-visibility-polling';
interface State {native:boolean;agentName?:string;agentId?:string;fingerprint?:string;valid?:boolean;policy?:{notice:string}|null}
export function NativeQuotaControls({channel,running}:{channel:string|null;running:boolean}){
  const [state,setState]=React.useState<State|null>(null),[ack,setAck]=React.useState(false),[busy,setBusy]=React.useState(false),[error,setError]=React.useState('');
  const current=React.useRef(channel);current.current=channel;
  const refresh=React.useCallback(async()=>{
    if(!channel||channel.startsWith('draft:'))return;
    try{const next=await workspaceApi.request<State>(`/v1/runtime/native-budget-policy?channel=${encodeURIComponent(channel)}`);if(current.current===channel)setState(next);}catch{/* Keep last visible state while offline. */}
  },[channel]);
  React.useEffect(()=>{setState(null);setError('');void refresh();},[refresh]);
  React.useEffect(()=>{setAck(false);},[state?.fingerprint,state?.agentId]);
  React.useEffect(()=>{void refresh();},[running,refresh]);
  useVisibilityPolling(refresh,10000);
  const change=async(revoke=false)=>{
    if(!channel||busy||running)return;setBusy(true);setError('');
    try{await workspaceApi.request(`/v1/runtime/native-budget-policy?channel=${encodeURIComponent(channel)}`,{method:revoke?'DELETE':'POST',
      ...(revoke?{}:{body:JSON.stringify({channel,mode:'native-managed',acknowledged:true,expectedFingerprint:state?.fingerprint})})});setAck(false);await refresh();}
    catch(e){setError(e instanceof Error?e.message:'预算策略更新失败');await refresh();}finally{setBusy(false);}
  };
  if(!state?.native)return null;
  return <details className="mt-2 rounded-lg border border-border bg-surface1 px-3 py-2 text-xs" data-testid="native-quota-controls">
    <summary className="cursor-pointer font-medium">{state.agentName} · {state.valid?'本会话使用原生配额':'原生预算准入（未确认）'}</summary>
    <p className="mt-2 leading-5 text-foreground-muted">{state.policy?.notice || '原生客户端不能逐请求执行工作台 Token、步数和费用硬上限。可保留现有拦截，或明确确认仅本会话当前 Agent 使用原生配额；全局预算配置不会改变，时间限制和操作审批继续生效。'}</p>
    {!state.valid&&<label className="mt-2 flex items-start gap-2"><input type="checkbox" checked={ack} disabled={running||busy} onChange={e=>setAck(e.target.checked)} className="mt-0.5"/>我确认此会话当前 Agent 的原生调用不受工作台 Token、步数和费用硬上限约束，累计费用可能超过全局阈值。此选择不授权命令或文件操作。</label>}
    <button type="button" disabled={running||busy||(!state.valid&&!ack)} onClick={()=>void change(Boolean(state.valid))} className="mt-2 rounded border border-border px-2 py-1 disabled:opacity-40">{busy?'正在更新':state.valid?'撤销本会话例外':'确认仅本会话使用原生配额'}</button>
    <p className="mt-2 leading-5 text-foreground-muted">Agent、连接或预算配置变化后需重新确认；不会沿用到其他会话或协作批次。未知用量与费用保留为未知。</p>
    {error&&<p role="alert" className="mt-2 text-red-500">{error}</p>}
  </details>;
}
