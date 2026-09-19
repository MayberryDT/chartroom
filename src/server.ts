import {mkdirSync,existsSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {home,port,tokenPath} from './config.ts';
process.env.CHARTROOM_HOME=home;
process.env.GBRAIN_HOME=join(home,'runtime');
process.env.GBRAIN_JEV_LEDGER=join(home,'jev-usage.json');
process.env.GBRAIN_SERVE_SYNC_IPC='0';
mkdirSync(home,{recursive:true,mode:0o700});
mkdirSync(process.env.GBRAIN_HOME,{recursive:true,mode:0o700});
const {PGLiteEngine}=await import('../node_modules/gbrain/src/core/pglite-engine.ts');
const {configureGateway}=await import('../node_modules/gbrain/src/core/ai/gateway.ts');
const {mintLegacyToken}=await import('../node_modules/gbrain/src/core/token-mint.ts');
const {runServeHttp}=await import('../node_modules/gbrain/src/commands/serve-http.ts');
const {operations}=await import('../node_modules/gbrain/src/core/operations.ts');
const {installLinkBatch}=await import('./link-batch.ts');
const {installWorkHistory}=await import('./work-events.ts');
const {installJevEnrichment}=await import('./jev-enrichment.ts');
const {installJevProductionPaths}=await import('./jev-paths.ts');
configureGateway({embedding_model:'openai:text-embedding-3-small',embedding_dimensions:1536,env:{...process.env}});
const db=join(home,'database');
const engine=new PGLiteEngine();
try {
 await engine.connect({engine:'pglite',database_path:db});
 await engine.initSchema();
 await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES ('brain','Chartroom','{}'::jsonb) ON CONFLICT(id) DO NOTHING");
 if(!existsSync(tokenPath)){
  const minted=await mintLegacyToken(engine,{name:'chartroom-local',scopes:['read','write'],sourceGrant:['brain'],takesHolders:['world']});
  writeFileSync(tokenPath,minted.token,{mode:0o600});
 }
 const enabled=process.env.CHARTROOM_JEV!=='off';
 installLinkBatch();installJevEnrichment();
 if(enabled)installJevProductionPaths();
 operations.push({name:'chartroom_status',description:'Chartroom runtime features and model configuration; no credentials.',scope:'read',params:{},handler:async()=>({version:'0.1.0',upstream:'0.48.2.0',jev:{enabled,configured:!!(process.env.TYPESAFE_API_KEY||process.env.JEV_API_KEY||process.env.TYPESAFE_ENV),model:'jev-1.13.0'},retrieval:process.env.OPENAI_API_KEY?'hybrid':'keyword-only',maintenance:'Explicit bounded maintenance_jev_drain; no background scheduler'})});
 installWorkHistory();
 console.error(`Chartroom MCP: http://127.0.0.1:${port}/mcp\nClient token file: ${tokenPath}\nJev: ${enabled?'enabled (requires TypeSafe key)':'off'}`);
 await runServeHttp(engine,{port,bind:'127.0.0.1',tokenTtl:86400,enableDcr:false,suppressBootstrapToken:true});
} finally {await engine.disconnect();}
