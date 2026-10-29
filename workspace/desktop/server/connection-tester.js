const os = require('os');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { normalizeUrl } = require('./config-manager');
const defaultRuntime = async options => (await import('./pi-engine.mjs')).runPiAgent(options);

function categorizeError(status, message = '') {
  const msg = String(message).toLowerCase();
  const code = status || Number(msg.match(/http\s+(\d{3})/)?.[1]);
  if (/insufficient_quota|quota exhausted|额度/.test(msg)) return {code:'QUOTA_EXHAUSTED',message:'模型服务额度已耗尽，请恢复额度后重试。'};
  if (code===429 || /rate.?limit/.test(msg)) return {code:'RATE_LIMITED',message:'模型服务限流，请稍后重试。'};
  if (/accessdenied.unpurchased|access to model denied/.test(msg)) return {code:'MODEL_ACCESS_DENIED',message:'当前账号未开通该模型或无权访问，请检查模型权限。'};
  if ([401,403].includes(code) || /unauthorized|invalid api key|authentication/.test(msg)) return {code:'AUTH_FAILED',message:'鉴权失败：密钥无效或权限不足。'};
  if (code === 404 || /model not found|does not exist|invalid model/.test(msg)) return {code:'MODEL_NOT_FOUND',message:'模型或接口路径不存在，请检查模型 ID、地址与协议。'};
  if (/timeout|timed out|etimedout|abort|stopped/.test(msg)) return {code:'TIMEOUT',message:'请求超时或已取消。'};
  if (/econnrefused|enotfound|fetch failed/.test(msg)) return {code:'NETWORK_ERROR',message:'无法连接模型服务。'};
  if (code >= 500) return {code:'SERVER_ERROR',message:'模型服务暂时不可用。'};
  return {code:'PROTOCOL_ERROR',message:'未完成预期协议交互，请检查模型能力及接口设置。'};
}
class ConnectionTester {
  constructor(configManager, { piRuntime = defaultRuntime } = {}) { this.configManager = configManager; this.runtime = piRuntime; }
  async test({connectionId,level='chat',model:testModel,overrideKey,overrideBaseUrl,protocol:overrideProtocol,credentialAction,signal}) {
    if (!['chat','agent'].includes(level)) throw Object.assign(new Error('Invalid test level.'),{status:400});
    const conn = this.configManager.getConnection(connectionId);
    if (!conn && !overrideBaseUrl) throw Object.assign(new Error('Connection not found.'),{status:404});
    const protocol = overrideProtocol || conn?.protocol || 'openai';
    if (!['openai','anthropic','ollama'].includes(protocol)) throw Object.assign(new Error('Invalid protocol.'),{status:400});
    const baseUrl = normalizeUrl(overrideBaseUrl || conn.baseUrl, protocol);
    const apiKey = credentialAction === 'delete' ? '' : overrideKey !== undefined ? overrideKey : this.configManager.getConnectionSecret(connectionId);
    if (protocol !== 'ollama' && !apiKey) throw Object.assign(new Error('Configure a credential before testing.'),{status:400});
    const model = testModel || conn?.defaultModel;
    if (!model) throw Object.assign(new Error('Choose a model ID.'),{status:400});
    const start = Date.now(), controller = new AbortController();
    const abort = () => controller.abort(); signal?.addEventListener('abort',abort,{once:true});
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(abort,35000);
    const root = await fs.mkdtemp(path.join(os.tmpdir(),'52hz-agent-probe-'));
    try {
      const nonce = crypto.randomBytes(16).toString('hex'), calls = new Map(); let verified = false;
      await fs.writeFile(path.join(root,'probe.txt'),nonce);
      const result = await this.runtime({
        config:{provider:conn?.id || connectionId,protocol,model,mode:level==='chat'?'chat':'plan'},
        channel:'probe',userDataPath:root,projectDir:root,baseUrl,apiKey,
        prompt:level==='chat'?'Reply with OK.':'Use the read tool to read probe.txt and reply with its exact contents.',
        allowedTools:level==='chat'?[]:['read'], signal:controller.signal,
        onDelta(){},onAssistant(){},onMutation(){throw new Error('Probe cannot modify files.');},onApproval:async()=>false,
        onTool:event=>{
          if(event.phase==='start') calls.set(event.toolCallId,event);
          if(event.phase==='end' && calls.get(event.toolCallId)?.tool==='read' && !event.isError && event.output?.includes(nonce)) verified=true;
        },
      });
      const valid = level==='chat' ? Boolean(result.content?.trim()) : verified && result.content?.includes(nonce);
      return {ok:Boolean(valid),level,model,latencyMs:Date.now()-start,toolExecuted:verified,
        usage:result.usage, message:valid?(level==='chat'?'对话链路已验证。':'只读工具调用与结果续传已验证。'):undefined,
        errorCode:valid?undefined:'CAPABILITY_NOT_VERIFIED',error:valid?undefined:'未完成预期验证，不能确认该能力可用。'};
    } catch(error) {const detail=categorizeError(error.status,error.message);return {ok:false,level,model,latencyMs:Date.now()-start,errorCode:detail.code,error:detail.message};}
    finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);if(root.startsWith(path.join(os.tmpdir(),'52hz-agent-probe-'))) await fs.rm(root,{recursive:true,force:true});}
  }
}
module.exports={ConnectionTester,categorizeError};
