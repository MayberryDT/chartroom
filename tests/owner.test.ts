import {test,expect} from 'bun:test';
test('owner graph receipt, isolation and actual restart/resume',async()=>{
 const p=Bun.spawn([process.execPath,'tests/owner-fixture.ts'],{env:{PATH:process.env.PATH,HOME:process.env.HOME},stdout:'pipe',stderr:'pipe'});
 const [out,err,exit]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
 if(exit!==0)throw Error(out+'\n'+err);
 expect(out).toContain('owner integration passed');
},120000);
