/** Owner-executed, evidence-versioned capture enrichment. No generated prose or merges. */
import {createHash} from 'node:crypto';
import {operations} from '../node_modules/gbrain/src/core/operations.ts';
import {activeJudge,JEV_MODEL,passageScoreQuestion} from './jev-judgment.ts';
import {enqueueJevWork,ensureJevWork} from './jev-work.ts';
import {applyLinkBatch} from './link-batch.ts';
import {recordWorkEvent} from './work-events.ts';
const digest=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const active=new Set<string>();
const parse=(v:any)=>typeof v==='string'?JSON.parse(v):v;

export async function drainJevWork(ctx:any, id?:string, limit=10) {
  const source=ctx.auth?.sourceId;
  if(!source) throw new Error('explicit authenticated source required');
  await ensureJevWork(ctx.engine);
  // Only source-bound graph packets have an automatic publication effect. Review decisions remain visible.
  const rows=await ctx.engine.executeRaw<any>(`SELECT * FROM maintenance_jev_work
    WHERE state='queued' AND feature='capture_connections' AND identities->>0 LIKE $1
      AND ($2::text IS NULL OR id=$2) ORDER BY created_at LIMIT $3`,[source+':%',id??null,Math.max(1,Math.min(limit,50))]);
  const results=[];
  for(const row of rows){
    if(active.has(row.id)) continue;
    active.add(row.id);
    try{
      const decision=parse(row.decision); const identities=parse(row.identities);
      const receipt:any=await applyLinkBatch(ctx.engine,ctx,decision.packet);
      const verified=receipt.state==='committed' && receipt.items?.length>0 && receipt.items.every((i:any)=>['added','already_present'].includes(i.outcome));
      const retry=receipt.items?.some((i:any)=>i.outcome==='retryable');
      const state=verified?'applied':retry?'queued':'failed';
      await ctx.engine.executeRaw('UPDATE maintenance_jev_work SET state=$2,details=$3::jsonb WHERE id=$1',[row.id,state,JSON.stringify({receipt,verified})]);
      await recordWorkEvent(ctx.engine,{actor:'jev',actor_source:source,action:'capture_connections',phase:'published',outcome:state,operation_id:row.id,identities,question_id:row.question_id,details:{batch_id:decision.packet?.batch_id,verified}});
      results.push({id:row.id,state,verified});
    }catch(error){
      await recordWorkEvent(ctx.engine,{actor:'jev',actor_source:source,action:'capture_connections',phase:'degraded',outcome:'queued',operation_id:row.id,error_class:error instanceof Error?error.name:'unknown'});
      results.push({id:row.id,state:'queued',verified:false});
    }finally{active.delete(row.id);}
  }
  return {processed:results.length,results};
}

export async function enrichCapturedPage(ctx:any,p:any,baseline:any){
  if(!baseline || baseline.error || baseline.rpc_error) return baseline;
  const slug=baseline.slug || baseline.page?.slug || p.slug;
  const source=ctx.auth?.sourceId;
  if(!source || !slug)return baseline;
  const identity=`${source}:${slug}`;
  const get=operations.find(op=>op.name==='get_page'); const search=operations.find(op=>op.name==='search');
  if(!get || !search)return baseline;
  try{
    const page:any=await get.handler(ctx,{source_id:source,slug,include_content:true});
    if(!page?.content_hash || typeof page.compiled_truth!=='string')return baseline;
    const body=page.compiled_truth.slice(0,6000);
    const candidateRows=(found:any)=>(Array.isArray(found)?found:found?.results || []).filter((r:any)=>r.slug && !(r.slug===slug && (r.source_id || source)===source)).slice(0,6);
    const titleQuery=String(page.title || body.slice(0,160));
    let rows=candidateRows(await search.handler(ctx,{query:titleQuery,limit:8}));
    // Exact titles and conjunctive keyword search can find only the new page.
    // Broaden candidate retrieval once; Jev still judges the full page evidence.
    if(!rows.length){
      const terms=[...new Set(titleQuery.match(/[\p{L}\p{N}]{3,}/gu) || [])].slice(0,12);
      if(terms.length>1)rows=candidateRows(await search.handler(ctx,{query:terms.join(' OR '),limit:8}));
    }
    const candidates:Record<string,any>={};
    for(const [i,row] of rows.entries()){
      const targetSource=row.source_id || source;
      if(!(ctx.auth?.allowedSources || [source]).includes(targetSource))continue;
      const target:any=await get.handler(ctx,{source_id:targetSource,slug:row.slug,include_content:true});
      if(target?.content_hash && target.compiled_truth)candidates[`d${i}`]={source_id:targetSource,slug:row.slug,revision:target.content_hash,text:target.compiled_truth.slice(0,2200)};
    }
    const questions:Record<string,any>={role:{type:'choice',instructions:'Classify the purpose of `body`.',criteria:{source:'Source or session record',concept:'Reusable concept',decision:'Durable decision',runbook:'Operational instructions',project:'Project or entity',other:'Insufficient evidence or another role'}}};
    for(const key of Object.keys(candidates))questions[key]={...passageScoreQuestion('Would this connection help a reader understand the source page in `body`?',`candidates.${key}.text`),instructions:`Compare the actual source page in \`body\` with \`candidates.${key}.text\`. Score whether a direct related-page connection is useful. Shared generic words alone score 0. Require a concrete shared subject or an explanation applicable to the source.`,criteria:['Unrelated or generic overlap','Weak association','Some useful context','Directly relevant and useful','Strong explicit relationship']};
    const judged=await activeJudge()({model:JEV_MODEL,state:{body,candidates},questions},{engine:ctx.engine,source_id:source,identities:[identity],timeout_ms:8000,feature:'capture-connections-v1'});
    if(!judged.ok)return {...baseline,jev:{outcome:'failed',failure:judged.failure}};
    const selected=Object.keys(candidates).filter(key=>judged.response.answers[key].score>=3.2).sort((a,b)=>judged.response.answers[b].score-judged.response.answers[a].score).slice(0,3);
    const role=judged.response.answers.role.choice;
    const items=selected.map(key=>{const target=candidates[key]; const core={from:{source_id:source,slug},to:{source_id:target.source_id,slug:target.slug},provenance:'jev-capture',expected_from_revision:page.content_hash,expected_to_revision:target.revision,evidence:{source_id:source,slug,revision:page.content_hash,quote:body.slice(0,500)}};return {id:digest(core).slice(0,40),...core};});
    if(!items.length){
      await recordWorkEvent(ctx.engine,{actor:'jev',actor_source:source,action:'capture_connections',phase:'inferred',outcome:'abstained',question_id:'capture-connections-v1',identities:[identity],details:{role,reason:'no sufficiently relevant candidate'}});
      return {...baseline,jev:{outcome:'abstained',role,connections:0}};
    }
    const packet={batch_id:digest(items).slice(0,40),items};
    const work=await enqueueJevWork(ctx.engine,{question_id:'capture-connections-v1',feature:'capture_connections',identities:[identity,...items.map(i=>`${i.to.source_id}:${i.to.slug}`)],revision:page.content_hash,decision:{role,packet},state:'queued'});
    const drained=await drainJevWork(ctx,work.id);
    const result=drained.results[0];
    return {...baseline,jev:{outcome:result?.state || work.state,role,connections:result?.verified?items.length:0,work_id:work.id}};
  }catch(error){
    await recordWorkEvent(ctx.engine,{actor:'jev',actor_source:source,action:'capture_connections',phase:'degraded',outcome:'failed',identities:[identity],error_class:error instanceof Error?error.name:'unknown'});
    return {...baseline,jev:{outcome:'failed'}};
  }
}

export function installJevEnrichment(){
  if(operations.some(op=>op.name==='maintenance_jev_drain'))return;
  operations.push({name:'maintenance_jev_drain',description:'Resume bounded, source-qualified capture connection publication using existing Jev decisions and owner receipts.',scope:'write',mutating:true,params:{id:{type:'string'},limit:{type:'number'}},handler:(ctx,p)=>drainJevWork(ctx,p.id as string,Number(p.limit)||10)},
  {name:'maintenance_jev_status',description:'Read source-scoped Jev work counts and pending work identities; decision payloads omitted.',scope:'read',params:{},handler:async(ctx)=>{
    const sources=ctx.auth?.allowedSources || [ctx.auth?.sourceId].filter(Boolean);
    if(!sources.length)throw new Error('explicit authenticated source required');
    await ensureJevWork(ctx.engine);
    const rows=await ctx.engine.executeRaw<any>(`SELECT id,feature,state,identities FROM maintenance_jev_work WHERE identities->>0 LIKE ANY($1::text[])`,[sources.map(s=>s+':%')]);
    const counts:Record<string,number>={};for(const row of rows){const key=row.feature+':'+row.state;counts[key]=(counts[key]||0)+1;}
    return {counts,pending:rows.filter(r=>r.state==='queued').slice(0,50).map(r=>({...r,identities:parse(r.identities).filter((id:string)=>sources.includes(id.split(':')[0]))}))};
  }});
}
