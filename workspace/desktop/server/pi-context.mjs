import { compact, estimateTokens } from '@earendil-works/pi-coding-agent';
// Pi 1.4.0 exposes compact publicly but not its preparation/estimate helpers.
// Keep this pinned-version bridge in one place and exercise it in integration tests.
const { prepareCompaction, estimateProjectedContextTokens } = await import(new URL('./core/compaction/compaction.js', import.meta.resolve('@earendil-works/pi-coding-agent')));

export function contextController({session,model,capacity,tools,signal,streamFn,apiKey,onUsage,onState=()=>{},autoCompact=true,keepRecentTokens}) {
  let last = null, compactions = 0;
  const overhead = Math.ceil(JSON.stringify(tools.map(tool=>({name:tool.name,description:tool.description,parameters:tool.parameters}))).length / 3) + 256;
  const reserve = model.maxTokens + Math.max(1024, Math.ceil((capacity || 0) * .05));
  const estimate = messages => Math.ceil(estimateProjectedContextTokens(session.buildSessionProjection(),session.getBranch()).tokens)
    + messages.filter(message=>message.role==='system').reduce((sum,message)=>sum+estimateTokens(message),0) + overhead;
  const status = (messages,phase='ready',extra={}) => {
    const estimated = estimate(messages);
    last = {estimated_tokens:estimated,context_window:capacity || null,reserved_tokens:reserve,
      available_tokens:capacity ? Math.max(0,capacity-reserve-estimated) : null,
      source:'estimate',phase,compactions,...extra}; onState(last); return last;
  };
  const compress = async (messages,manual=false) => {
    if(signal.aborted) throw new Error('Compaction stopped.');
    const settings={enabled:true,reserveTokens:reserve,keepRecentTokens:keepRecentTokens ?? Math.min(12000,Math.max(512,Math.floor((capacity || 20000)*.2)))};
    const preparation=prepareCompaction(session.getBranch(),settings);
    if(!preparation) {
      if(manual) throw new Error('There is not enough completed history to compact.');
      throw new Error('Context budget exceeded and no safe history can be compacted. Start a new session or reduce the request.');
    }
    status(messages,'compacting');
    try {
      const meteredStream=(...args)=>{
        const stream=streamFn(...args);let measured=false;
        return new Proxy(stream,{get(target,key){
          if(key==='result')return async()=>{const response=await target.result();if(!measured){measured=true;onUsage(response.usage);}return response;};
          const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
        }});
      };
      const result=await compact(preparation,model,apiKey,undefined,undefined,signal,undefined,meteredStream,{}, {maxRetries:0});
      if(signal.aborted) throw new Error('Compaction stopped.');
      if(!result.summary?.trim()) throw new Error('Compaction returned an empty summary.');
      // Append only a complete result. Original JSONL entries remain intact.
      session.appendCompaction(result.summary,result.firstKeptEntryId,result.tokensBefore,result.details,false,result.usage);
      compactions++;
      const system=messages.filter(message=>message.role==='system');
      const next=[...system,...session.buildSessionContext().messages.filter(message=>message.role!=='system')];
      status(next,'ready'); return next;
    } catch(error) {status(messages,'error',{error:'Compaction failed; original history is preserved.'});throw error;}
  };
  return {
    get last(){return last;},
    observe:status,
    async prepare(context) {
      let messages=context.messages;
      const before=status(messages);
      if(capacity && before.estimated_tokens + reserve >= capacity) {
        if(!autoCompact) throw new Error('Context budget reached. Compact this session before continuing.');
        messages=await compress(messages);
        if(estimate(messages)+reserve>=capacity) throw new Error('Context still exceeds the model budget after compaction. Reduce the request or start a new session.');
      }
      return {context:{...context,messages}};
    },
    compress,
  };
}
