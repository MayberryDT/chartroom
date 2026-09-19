import {readFileSync} from 'node:fs';
import {endpoint,tokenPath} from './config.ts';
export async function call(name:string,args:Record<string,unknown>={}) {
 const token=readFileSync(tokenPath,'utf8').trim();
 const response=await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:crypto.randomUUID(),method:'tools/call',params:{name,arguments:args}}),signal:AbortSignal.timeout(120000),redirect:'error'});
 if(!response.ok)throw Error(`Owner HTTP ${response.status}`);
 const raw=await response.text();
 const payload=raw.trim().startsWith('{')?JSON.parse(raw):raw.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6))).find(p=>p.result||p.error);
 if(payload?.error)throw Error(JSON.stringify(payload.error));
 const result=payload?.result;
 const value=result?.structuredContent ?? JSON.parse(result?.content?.find((c:any)=>c.type==='text')?.text || 'null');
 if(result?.isError||value?.error)throw Error(JSON.stringify(value));
 return value;
}
if(import.meta.main){
 const [command,...args]=process.argv.slice(2);
 try{
 let result;
 if(command==='status')result=await call('chartroom_status');
 else if(command==='search')result=await call('search',{query:args.join(' '),limit:5});
 else if(command==='capture'&&args.length===2)result=await call('capture',{slug:args[0],content:readFileSync(args[1],'utf8')});
 else if(command==='page')result=await call('get_page',{source_id:'brain',slug:args[0],include_content:true});
 else if(command==='links')result=await call('get_links',{slug:args[0]});
 else if(command==='history')result=await call('maintenance_work_history',{source_id:'brain',slug:args[0],limit:20});
 else if(command==='resume')result=await call('maintenance_jev_drain',{limit:20});
 else if(command==='work')result=await call('maintenance_jev_status');
 else if(command==='call'&&args[0])result=await call(args[0],JSON.parse(args[1]||'{}'));
 else throw Error('Usage: bun run client status | capture <slug> <file> | search <query> | page|links|history <slug> | work | resume | call <tool> <json>');
 console.log(JSON.stringify(result,null,2));
 }catch(e){console.error(e instanceof Error?e.message:'Client failed');process.exitCode=1;}
}
