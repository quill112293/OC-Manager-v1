import test from 'node:test';
import assert from 'node:assert/strict';
import { timeline,eligibility,phase } from '../src/model.js';
test('each minute goes to one member, then to time awaiting execution',()=>{
  const at=1800000000, m=n=>at+60*n;
  const run=(a,b)=>({start:m(a),end:m(b),reason:'Travelling'});
  const r={ready:m(0),executed:m(65),blocks:{1:{name:'Aaron',runs:[run(0,18)]},2:{name:'Noor',runs:[run(15,60)]}},unknown:[{...run(60,65),reason:'Awaiting execution. No verified member blocker.'}]};
  assert.deepEqual(timeline(r).map(s=>[s.name,(s.end-s.start)/60]),[['Aaron',18],['Noor',42],['',5]]);
});
test('unverified time and simultaneous causes remain unassigned',()=>{
  const block={runs:[{start:100,end:120,reason:'Abroad'}]};
  const spans=timeline({ready:100,executed:140,blocks:{1:block,2:block}});
  assert.deepEqual(spans.map(s=>s.reason),['Concurrent causes · needs review','Timing unverified']);
});
test('faction recruiting rules include the boundaries',()=>{
  assert.equal(eligibility(2,null,null),'Eligible');
  assert.equal(eligibility(3,60,7),'Eligible');
  assert.equal(eligibility(3,60.1,7.1),'Outside requirements');
  assert.equal(eligibility(3,null,1),'Verify in Torn');
  assert.equal(phase({status:'Planning',ready:100},100),'Executable');
});
