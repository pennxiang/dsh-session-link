import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostAdapter} from '../lib/host-adapter.js';
import {createService} from '../lib/service.js';

function fixture() {
  const entries = ['self','other-directory','peer-a','peer-b'].map((id,index)=>({id,status:'idle',session:{header:{id,cwd:index===1?'/other':'/same'},isOwnSeq:()=>true}}));
  const map=new Map(entries.map(a=>[a.id,a]));
  const host=createHostAdapter({agents:{get:id=>map.get(id),list:()=>entries,roots:()=>entries},workingDirectory:{get:s=>s.header.cwd}});
  return {host,entries};
}
test('host discovery applies caller/directory filtering before the result cap',async()=>{
  const {host}=fixture();
  try {
    const result=await host.list({limit:1,excludeIds:['self'],cwd:'/same'});
    assert.deepEqual(result.sessions.map(s=>s.id),['peer-a']);
    assert.equal(result.truncated,true);
    const exact=await host.list({limit:1,excludeIds:['self'],cwd:'/same',query:'peer-b'});
    assert.deepEqual(exact.sessions.map(s=>s.id),['peer-b']);
    assert.equal(exact.truncated,false);
  } finally {host.close();}
});
test('real adapter/service integration finds a peer at limit one',async()=>{
  const {host,entries}=fixture();
  const service=createService({host,config:{sameDirectoryOnly:true},store:{read:async()=>({reception:{}}),close:async()=>{}}});
  try {
    const result=await service.execute('link_sessions',{limit:1},{agent:entries[0]});
    assert.deepEqual(result.sessions.map(s=>s.id),['peer-a']);
  } finally {await service.close();}
});
