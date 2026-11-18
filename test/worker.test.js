import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';
import { hash, torn } from '../src/service.js';
const db=new DatabaseSync(':memory:'); db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
const d1={prepare(sql){const build=(args=[])=>({bind:(...a)=>build(a),first:async()=>db.prepare(sql).get(...args),all:async()=>({results:db.prepare(sql).all(...args)}),run:async()=>({meta:db.prepare(sql).run(...args)})});return build();},async batch(stmts){return Promise.all(stmts.map(s=>s.run()));}};
const domain='https://oc.example';
function call(env,path,{cookie,body}={}){return worker.fetch(new Request(domain+path,{method:body?'POST':'GET',headers:{Origin:domain,...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined}),env);}
test('Torn requests use the Workers redirect mode and reject a redirect before reading data', async t => {
  const upstream = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.origin, 'https://api.torn.com');
    assert.equal(options.redirect, 'manual');
    return Response.redirect('https://elsewhere.invalid/', 302);
  });
  await assert.rejects(torn('test-key','faction/basic'), {status:503});
  assert.equal(upstream.mock.callCount(), 1);
});
test('the signed-out welcome shows only the configured faction name and banner and reuses the last good result', async t => {
  const env = {DB:d1, FACTION_ID:'123', TORN_KEY:'server-test-key'};
  let current = 1800000000;
  let image = 'our-banner.png';
  let outage = false;
  t.mock.method(Date, 'now', () => current * 1000);
  const upstream = t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url.pathname, '/v2/faction/basic');
    assert.equal(init.headers.Authorization, 'ApiKey ' + env.TORN_KEY);
    if (outage) throw new Error('Torn unavailable');
    return Response.json({basic:{id:123, name:'Faction One', banner_image:image, leader_id:999}});
  });
  const welcome = async () => (await call(env, '/api/welcome')).json();
  const expected = {name:'Faction One', banner:'https://factionimages.torn.com/our-banner.png'};
  assert.deepEqual(await welcome(), expected);
  assert.deepEqual(await welcome(), expected);
  assert.equal(upstream.mock.callCount(), 1);
  current += 3601;
  outage = true;
  assert.deepEqual(await welcome(), expected);
  assert.deepEqual(await welcome(), expected);
  assert.equal(upstream.mock.callCount(), 2);
  current += 61;
  outage = false;
  image = 'https://factionimages.torn.com/new-banner.gif';
  assert.deepEqual(await welcome(), {name:'Faction One', banner:image});
  current += 3601;
  image = '';
  assert.deepEqual(await welcome(), {name:'Faction One', banner:null});
});
test('welcome explains a cold-start lookup failure and recovers on the next retry', async t => {
  const env = {DB:d1, FACTION_ID:' 124 ', TORN_KEY:' server-key '};
  let time = 1800000000;
  let denying = true;
  t.mock.method(Date, 'now', () => time * 1000);
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(init.headers.Authorization, 'ApiKey server-key');
    return Response.json(denying ? {error:{code:16}} : {basic:{id:124,name:'Our Crew',banner_image:'crew.gif'}});
  });
  const welcome = async () => (await call(env, '/api/welcome')).json();
  assert.match((await welcome()).error, /code 16/);
  assert.match((await welcome()).error, /code 16/);
  denying = false;
  time += 61;
  assert.deepEqual(await welcome(), {name:'Our Crew',banner:'https://factionimages.torn.com/crew.gif'});
});
test('real Worker routes isolate member and staff data and revoke active sessions on removal',async()=>{
  const ownerKey='a'.repeat(16), memberKey='b'.repeat(16);
  const env={DB:d1,FACTION_ID:'50',OWNER_ID:'1',TORN_KEY:'mock',OWNER_KEY_SHA256:await hash(ownerKey)};
  const original=globalThis.fetch;
  globalThis.fetch=async(url,init)=>Response.json(url.pathname.endsWith('/key/info')?{info:{user:{id:init.headers.Authorization.includes(ownerKey)?1:2,faction_id:init.headers.Authorization.includes('c'.repeat(16))?99:50}}}:{members:[{id:1,name:'Owner'},{id:2,name:'Member'}]});
  try{
    const login=async key=>(await call(env,'/api/login',{body:{key}})).headers.get('Set-Cookie')?.split(';')[0];
    assert.equal((await call(env,'/api/login',{body:{key:'c'.repeat(16)}})).status,403);
    const owner=await login(ownerKey),member=await login(memberKey);assert.ok(member&&owner);
    assert.equal((await call(env,'/api/profile?scope=staff',{cookie:member})).status,403);
    assert.equal((await call(env,'/api/staff',{cookie:member,body:{id:1,grant:true}})).status,403);
    assert.equal((await call(env,'/api/staff',{cookie:owner,body:{id:2,grant:true}})).status,200);
    assert.equal((await call(env,'/api/profile?scope=staff',{cookie:member})).status,200);
    assert.equal((await call(env,'/api/staff',{cookie:owner,body:{id:2,grant:false}})).status,200);
    assert.equal((await call(env,'/api/profile?scope=staff',{cookie:member})).status,403);
    assert.equal((await call(env,'/api/logout',{cookie:member,body:{}})).status,200);
    assert.equal((await call(env,'/api/profile',{cookie:member})).status,401);
  }finally{globalThis.fetch=original;}
});
test('the scheduled trigger records member history without any website session and preserves last success on failure',async()=>{
  db.exec('DELETE FROM oc_records; DELETE FROM portal_meta; DELETE FROM portal_sessions; DELETE FROM portal_profiles');
  const env={DB:d1,FACTION_ID:'50',TORN_KEY:'scheduled-key'};
  const origin=globalThis.fetch, clock=Date.now, base=1800000000;
  let time=base, fail=false;
  Date.now=()=>time*1000;
  globalThis.fetch=async(url)=>{
    if(fail)throw new Error('simulated upstream outage');
    if(url.pathname.endsWith('/key/info'))return Response.json({info:{user:{id:1,faction_id:50}}});
    if(url.pathname.endsWith('/faction/members'))return Response.json({members:[{id:2,name:'Crew',status:{state:'Abroad'}}]});
    const done=time>=base+600, record={id:7,name:'Test OC',difficulty:3,status:done?'Successful':'Planning',ready_at:base,executed_at:done?time:null,slots:[{position:'Driver',user:{id:2,progress:100}}]};
    return Response.json({crimes:(url.searchParams.get('cat')==='completed')===done?[record]:[]});
  };
  async function tick(){let p;worker.scheduled({},env,{waitUntil:v=>p=v});await p;}
  try{
    for(time of [base,base+300,base+600])await tick();
    const rec=JSON.parse(db.prepare('SELECT body FROM oc_records').get().body);
    assert.equal(rec.status,'Successful');assert.equal(rec.blocks[2].runs[0].end,base+300);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM portal_sessions').get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM portal_profiles').get().n,0);
    fail=true;time+=300;await assert.rejects(tick);
    assert.equal(Number(db.prepare("SELECT v FROM portal_meta WHERE k='lastSuccess'").get().v),base+600);
  }finally{globalThis.fetch=origin;Date.now=clock;}
});
