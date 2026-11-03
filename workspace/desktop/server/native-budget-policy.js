'use strict';
const crypto = require('node:crypto');
const fail = message => Object.assign(new Error(message), { status:409, code:'NATIVE_BUDGET_AUTHORIZATION_REQUIRED' });
function participant(store, agent) {
  const current = store.storage.agentDefinitions.requireActive(agent.id);
  const connection = agent.connectionId ? store.storage.agentConnections.requireRegistered(agent.connectionId) : null;
  return { id: current.id, revision: current.revision, connectionId: connection?.id || null,
    connectionRevision: connection?.revision || null, limits: current.limits };
}
function snapshot(store, channel, agents) {
  return { channel, globalBudget:store.storage.budgets.get(), sessionBudget:store.storage.budgets.getForSession(channel),
    participants: [...new Map(agents.map(a=>[a.id,participant(store,a)])).values()].sort((a,b)=>a.id.localeCompare(b.id)) };
}
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function createNativeBudgetPolicy(store, channel, agents, input, parentRun, scope='batch') {
  if (!input) return null;
  if (parentRun || input.mode !== 'native-managed' || input.acknowledged !== true) throw fail('原生预算例外只能由用户明确确认，Agent 不能自行授权。');
  const limits = snapshot(store,channel,agents);
  return { mode:'native-managed',scope, approvedBy:'human:user', approvedAt:new Date().toISOString(), fingerprint:digest(limits), limits,
    notice:`仅${scope==='session'?'本会话当前 Agent':'本批次原生 Agent'}不受工作台 Token、步数和费用硬上限约束，可能使累计费用超过全局阈值；原生配额自行管理，返回用量后再观测。未知用量/费用不按零处理。全局配置保持不变，时间限制和操作审批继续生效。` };
}
function allowsNativeBudgetPolicy(store, policy, channel, agent) {
  if (!policy || policy.mode !== 'native-managed' || policy.approvedBy !== 'human:user' || policy.limits?.channel !== channel || !Array.isArray(policy.limits?.participants)) return false;
  const approved = policy.limits.participants.find(p=>p.id===agent.id);
  if (!approved || agent.revision !== approved.revision) return false;
  try {
    const current = policy.limits.participants.map(p=>store.storage.agentDefinitions.requireActive(p.id));
    return digest(snapshot(store,channel,current))===policy.fingerprint;
  } catch { return false; }
}
const sessionPolicyKey=channel=>`native-budget-session:${channel}`;
const previewNativeBudgetPolicy=(store,channel,agents)=>{const limits=snapshot(store,channel,agents);return {limits,fingerprint:digest(limits)};};
module.exports={createNativeBudgetPolicy,allowsNativeBudgetPolicy,sessionPolicyKey,previewNativeBudgetPolicy};
