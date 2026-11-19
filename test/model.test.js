import test from 'node:test';
import assert from 'node:assert/strict';
import { timeline,eligibility,phase,present } from '../src/model.js';
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
  assert.equal(eligibility(1,0,90),'Eligible');
  assert.equal(eligibility(2,0,90),'Eligible');
  assert.equal(eligibility(3,60,90),'Eligible');
  assert.equal(eligibility(10,0,7),'Eligible');
  assert.equal(eligibility(3,59.9,7.1),'Outside requirements');
  assert.equal(eligibility(3,null,1),'Eligible');
  assert.equal(eligibility(3,60,null),'Eligible');
  assert.equal(eligibility(3,null,8),'Verify in Torn');
  assert.equal(eligibility(3,59,null),'Verify in Torn');
  assert.equal(phase({status:'Planning',ready:100},100),'Executable');
});

test('saved OC records resolve role-specific weights without guessing ambiguous seats',()=>{
  const record={name:'Stage Fright',level:4,status:'Planning',slots:[
    {role:'Muscle #1',member:20},{role:'Muscle #2'},{role:'Muscle'},{role:'Sniper'}
  ],participants:[{id:20,role:'Muscle #1'}]};
  const card=present(record);
  assert.equal(card.slots[0].weight,20.01365691);
  assert.equal(card.participants[0].weight,card.slots[0].weight);
  assert.equal(card.slots[1].eligibility,'Eligible');
  assert.equal(card.slots[2].weight,null);
  assert.equal(card.slots[3].eligibility,'Verify in Torn');
  const historic=present({...record,slots:undefined,status:'Successful'});
  assert.equal(historic.participants[0].weight,card.slots[0].weight);
  assert.equal(present({...record,name:'Future OC'}).slots[1].weight,null);
});

test('newer observations remove filled and closed jobs without substituting tracker CPR',async()=>{
  const {recruitingFor}=await import('../src/model.js');
  const at=90000;
  const base={id:5,name:'Stage Fright',level:4,status:'Recruiting',last:at-10,slots:[
    {role:'Muscle #1',profileCPR:89},{role:'Sniper',profileCPR:60},{role:'Muscle #2',profileCPR:10}
  ]};
  const personal=present(base),snapshot={checked:at-10,crimes:[personal]};
  const fresh=present({...base,last:at,slots:[{member:11,role:'Muscle #1'},{role:'Sniper',cpr:9},{role:'Muscle #2',cpr:95}]});
  assert.deepEqual(recruitingFor([fresh],snapshot,at)[0].slots.map(s=>s.profileCPR),[60,10]);
  assert.deepEqual(recruitingFor([fresh],null,at)[0].slots.map(s=>[s.role,s.profileCPR]),[['Muscle #2',null]]);
  assert.deepEqual(recruitingFor([fresh],{checked:at+1,crimes:[]},at+1),[]);
  assert.deepEqual(recruitingFor([{...fresh,phase:'Planning'}],snapshot,at),[]);
  assert.deepEqual(recruitingFor([fresh],snapshot,at+901),[]);
});
