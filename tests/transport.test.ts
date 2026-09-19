import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {judge,JEV_MODEL,passageScoreQuestion,parseEnvironmentKey} from '../src/jev-judgment.ts';
import {reserve,settle,loadLedger} from '../src/usage-ledger.ts';
test('quoted credentials and HTTP failures are classified without losing accounting',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'chartroom-transport-'));const fetch=globalThis.fetch;const env={...process.env};
 try{
  delete process.env.TYPESAFE_API_KEY;delete process.env.JEV_API_KEY;
  process.env.TYPESAFE_ENV=join(dir,'key.env');process.env.GBRAIN_JEV_LEDGER=join(dir,'usage.json');
  writeFileSync(process.env.TYPESAFE_ENV,'TYPESAFE_API_KEY="synthetic-key"');
  expect(parseEnvironmentKey("export JEV_API_KEY='synthetic-key'")).toBe('synthetic-key');
  const request={model:JEV_MODEL,state:{passages:{d0:{text:'A sensor needs calibration.'}}},questions:{d0:passageScoreQuestion('calibration','passages.d0.text')}};
  globalThis.fetch=(async(_url,init)=>{expect((init!.headers as any).Authorization).toBe('Bearer synthetic-key');return Response.json({model:JEV_MODEL,answers:{d0:{type:'score',score:4,probabilities:{'0':0,'1':0,'2':0,'3':0,'4':1}}},usage:{input_tokens:10,output_tokens:1}});}) as typeof fetch;
  expect((await judge(request)).ok).toBe(true);expect(loadLedger(process.env.GBRAIN_JEV_LEDGER).accounted_usd).toBeGreaterThan(0);
  globalThis.fetch=(async()=>Response.json({}, {status:401})) as typeof fetch;
  expect((await judge(request) as any).failure).toBe('authentication');
  globalThis.fetch=(async()=>Response.json({bad:true})) as typeof fetch;
  expect((await judge(request) as any).failure).toBe('invalid_structure');
  const path=join(dir,'nested','ledger.json');expect(reserve(path,1,'test').ok).toBe(true);settle(path,{estimate:1,tokens:1000,feature:'test'});expect(loadLedger(path).reserved_usd).toBe(0);expect(loadLedger(path).by_feature.test.reserved).toBe(0);
 }finally{globalThis.fetch=fetch;for(const k of ['TYPESAFE_API_KEY','JEV_API_KEY','TYPESAFE_ENV','GBRAIN_JEV_LEDGER']){if(env[k]===undefined)delete process.env[k];else process.env[k]=env[k];}rmSync(dir,{recursive:true,force:true});}
});
