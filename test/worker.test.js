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
test('setup status names missing settings and keeps the cached faction banner available', async t => {
  const env = {DB:d1, FACTION_ID:'456'};
  const cached = {name:'Test faction',banner:'https://factionimages.torn.com/banner.gif'};
  db.prepare('INSERT INTO portal_meta VALUES (?,?)').run('welcome:456',JSON.stringify(cached));
  const upstream = t.mock.method(globalThis,'fetch',async () => { throw new Error('unexpected upstream request'); });
  const config = async () => (await call(env,'/api/config')).json();
  assert.deepEqual(await config(),{live:false,missing:['OWNER_ID']});
  assert.deepEqual(await (await call(env,'/api/welcome')).json(),cached);
  assert.equal((await call(env,'/api/profile')).status,503);
  env.OWNER_ID='21';
  assert.deepEqual(await config(),{live:true,missing:[]});
  assert.equal((await call(env,'/api/profile')).status,401);
  assert.equal(upstream.mock.callCount(),0);
});
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

test('owner sign-in accepts a replacement only after Cloudflare approves its fingerprint', async t => {
  db.exec("DELETE FROM portal_meta WHERE k='rosterAt'; DELETE FROM portal_roster");
  const original = 'o'.repeat(16), replacement = 'r'.repeat(16), tracker = 't'.repeat(16);
  const memberKey = 'm'.repeat(16), memberReplacement = 'n'.repeat(16);
  const env = {DB:d1, FACTION_ID:'77', OWNER_ID:'10', TORN_KEY:tracker};
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url.pathname === '/v2/faction/members') return Response.json({members:[{id:10,name:'Owner'},{id:11,name:'Member'}]});
    assert.equal(url.pathname, '/v2/key/info');
    const key = init.headers.Authorization.slice('ApiKey '.length);
    return Response.json({info:{user:{id:[memberKey,memberReplacement].includes(key) ? 11 : 10, faction_id:77}}});
  });
  const signIn = key => call(env, '/api/login', {body:{key}});
  async function session(key) {
    const result = await signIn(key);
    assert.equal(result.status, 200);
    return result.headers.get('Set-Cookie').split(';')[0];
  }
  async function denied(key, expectedCode) {
    const result = await signIn(key);
    assert.equal(result.status, 403);
    assert.equal(result.headers.get('Set-Cookie'), null);
    assert.equal((await result.json()).code, expectedCode);
  }
  await denied(original, 'owner_key_pairing');
  env.OWNER_KEY_SHA256 = '  ' + (await hash(original)).toUpperCase() + '\n';
  const first = await session(original);
  assert.equal((await call(env, '/api/profile?scope=staff', {cookie:first})).status, 200);
  await denied(replacement, 'owner_key_pairing');
  await session(memberKey);
  await denied(memberReplacement, undefined);
  env.OWNER_KEY_SHA256 = await hash(tracker);
  await denied(tracker, undefined);
  env.OWNER_KEY_SHA256 = await hash(replacement);
  assert.equal((await call(env, '/api/profile', {cookie:first})).status, 401);
  const next = await session(replacement);
  const profile = await call(env, '/api/profile?scope=staff', {cookie:next});
  assert.equal(profile.status, 200);
  assert.equal((await profile.json()).me.owner, true);
  await denied(original, 'owner_key_pairing');
  await denied(memberReplacement, undefined);
});

test('a personal key can verify a fresh public roster while the faction tracker is offline', async t => {
  db.exec("DELETE FROM portal_meta WHERE k='rosterAt'; DELETE FROM portal_roster");
  let time=1900000000, onRoster=true;
  const key='v'.repeat(16);
  const env={DB:d1,FACTION_ID:'1234',OWNER_ID:'91',OWNER_KEY_SHA256:await hash(key)};
  t.mock.method(Date,'now',()=>time*1000);
  const upstream=t.mock.method(globalThis,'fetch',async (url,init)=>{
    assert.equal(init.headers.Authorization,'ApiKey '+key);
    if(url.pathname==='/v2/key/info')return Response.json({info:{user:{id:91,faction_id:1234}}});
    assert.equal(url.pathname,'/v2/faction/1234/members');
    return Response.json({members:onRoster?[{id:91,name:'Owner'}]:[]});
  });
  const signIn=()=>call(env,'/api/login',{body:{key}});
  const start=await signIn();
  assert.equal(start.status,200);
  const cookie=start.headers.get('Set-Cookie').split(';')[0];
  const profile=await call(env,'/api/profile?scope=staff',{cookie});
  assert.equal(profile.status,200);
  const data=await profile.json();
  assert.equal(data.me.owner,true);
  assert.equal(data.trackingPaused,true);
  assert.equal(upstream.mock.callCount(),2);
  let capture;
  worker.scheduled({},env,{waitUntil:p=>capture=p});
  await assert.rejects(capture,/TORN_KEY/);
  time+=301;
  const expired=await call(env,'/api/profile',{cookie});
  assert.equal(expired.status,401);
  assert.equal((await expired.json()).code,'membership_recheck');
  assert.equal(upstream.mock.callCount(),2);
  onRoster=false;
  assert.equal((await signIn()).status,403);
  assert.equal((await call(env,'/api/profile',{cookie})).status,403);
});

test('only the owner can list current members who have signed in, including earlier enrollments', async t => {
  let time = 1910000000;
  t.mock.method(Date,'now',()=>time*1000);
  const ownerKey = 'x'.repeat(16), memberKey = 'y'.repeat(16);
  const env = {DB:d1,FACTION_ID:'914',OWNER_ID:'901',TORN_KEY:'tracker',OWNER_KEY_SHA256:await hash(ownerKey)};
  db.exec("DELETE FROM portal_meta WHERE k='rosterAt'; DELETE FROM portal_roster");
  const members = [{id:901,name:'Owner'},{id:902,name:'Staff'},{id:903,name:'Renamed'},{id:904,name:'Never signed in'}];
  t.mock.method(globalThis,'fetch',async (url,init) => {
    if(url.pathname==='/v2/faction/members')return Response.json({members});
    assert.equal(url.pathname,'/v2/key/info');
    return Response.json({info:{user:{id:init.headers.Authorization==='ApiKey '+ownerKey?901:902,faction_id:914}}});
  });
  const enroll = db.prepare('INSERT INTO portal_profiles VALUES (?,?,?,?)');
  enroll.run(903,'Old name',time-100,'old-test-enrollment');
  enroll.run(905,'Left faction',time-100,'other-test-enrollment');
  const signIn = async key => (await call(env,'/api/login',{body:{key}})).headers.get('Set-Cookie').split(';')[0];
  const owner = await signIn(ownerKey), member = await signIn(memberKey);
  const listing = cookie => call(env,'/api/members',{cookie});
  assert.equal((await listing()).status,401);
  assert.equal((await listing(member)).status,403);
  assert.equal((await call(env,'/api/staff',{cookie:owner,body:{id:902,grant:true}})).status,200);
  assert.equal((await listing(member)).status,403);
  const first = time;
  time+=60;
  assert.equal((await call(env,'/api/profile',{cookie:member})).status,200);
  time+=60;
  assert.equal((await call(env,'/api/profile?scope=staff',{cookie:member})).status,200);
  const response = await listing(owner);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{total:4,members:[
    {id:902,name:'Staff',firstSignIn:first,lastOpened:time},
    {id:901,name:'Owner',firstSignIn:first,lastOpened:null},
    {id:903,name:'Renamed',firstSignIn:first-100,lastOpened:null}
  ]});
});

test('first sign-in upgrades the legacy roster and returns only the signed-in member’s faction details', async t => {
  let time=1915000000;
  t.mock.method(Date,'now',()=>time*1000);
  db.exec('DELETE FROM portal_roster_details; DELETE FROM portal_roster');
  db.prepare('INSERT OR REPLACE INTO portal_meta VALUES (?,?)').run('rosterAt',String(time));
  db.prepare('INSERT INTO portal_roster VALUES (?,?,?)').run(967,'New member',time);
  const key='f'.repeat(16);
  const env={DB:d1,FACTION_ID:'75',OWNER_ID:'999'};
  let rosterReads=0;
  const member={id:967,name:'New member',level:8,position:'Recruit',days_in_faction:0,is_in_oc:false};
  const other={id:968,name:'Another member',level:98,position:'Leader',days_in_faction:100,is_in_oc:true};
  t.mock.method(globalThis,'fetch',async url=>{
    if(url.pathname==='/v2/key/info')return Response.json({info:{user:{id:967,faction_id:75}}});
    assert.equal(url.pathname,'/v2/faction/75/members');
    rosterReads++;
    return Response.json({members:[member,other]});
  });
  const signIn=async()=>{
    const result=await call(env,'/api/login',{body:{key}});
    assert.equal(result.status,200);
    return result.headers.get('Set-Cookie').split(';')[0];
  };
  const profile=async cookie=>(await call(env,'/api/profile',{cookie})).json();
  const first=await profile(await signIn());
  assert.deepEqual(first.profile,{level:8,position:'Recruit',daysInFaction:0,inOC:false});
  assert.deepEqual(first.roster,[]);
  assert.equal(rosterReads,1);
  time+=301;
  member.position='Member';member.is_in_oc=true;delete member.days_in_faction;
  const next=await profile(await signIn());
  assert.deepEqual(next.profile,{level:8,position:'Member',daysInFaction:null,inOC:true});
  assert.equal(rosterReads,2);
});

test('remembering this browser is optional, editable, and revoked by sign-out', async t => {
  let time=1920000000;
  t.mock.method(Date,'now',()=>time*1000);
  db.exec("DELETE FROM portal_meta WHERE k='rosterAt'; DELETE FROM portal_roster");
  const env={DB:d1,FACTION_ID:'75',OWNER_ID:'900',TORN_KEY:'tracker'};
  t.mock.method(globalThis,'fetch',async url=>Response.json(url.pathname.endsWith('/key/info')
    ? {info:{user:{id:906,faction_id:75}}} : {members:[{id:906,name:'Member'}]}));
  const key='k'.repeat(16);
  const login=async rememberDevice=>call(env,'/api/login',{body:{key,rememberDevice}});
  const setCookie=r=>r.headers.get('Set-Cookie');
  const header=r=>setCookie(r).split(';')[0];
  const change=(cookie,rememberDevice)=>call(env,'/api/device',{cookie,body:{rememberDevice}});
  const initial=await login(false),otherBrowser=await login(true);
  assert.equal(initial.status,200);
  assert.doesNotMatch(setCookie(initial),/Max-Age|Expires/i);
  assert.match(setCookie(otherBrowser),/Max-Age=34560000/);
  const profile=async cookie=>(await call(env,'/api/profile',{cookie})).json();
  assert.equal((await profile(header(initial))).rememberDevice,false);
  time+=12;
  const remembered=await change(header(initial),true);
  assert.match(setCookie(remembered),/Max-Age=34560000/);
  assert.equal((await profile(header(remembered))).rememberDevice,true);
  time+=50*86400;
  const reopened=await call(env,'/api/profile',{cookie:header(remembered)});
  assert.equal(reopened.status,200);
  assert.match(setCookie(reopened),/Max-Age=34560000/);
  delete env.TORN_KEY;
  time+=301;
  const pending=await call(env,'/api/profile',{cookie:header(remembered)});
  assert.equal((await pending.json()).code,'membership_pending');
  env.TORN_KEY='tracker';
  assert.equal((await profile(header(remembered))).rememberDevice,true);
  const temporary=await change(header(remembered),false);
  assert.doesNotMatch(setCookie(temporary),/Max-Age|Expires/i);
  assert.equal((await change(header(temporary),'yes')).status,400);
  const out=await call(env,'/api/logout',{cookie:header(temporary),body:{}});
  assert.match(setCookie(out),/Max-Age=0/);
  assert.equal((await call(env,'/api/profile',{cookie:header(remembered)})).status,401);
  assert.equal((await profile(header(otherBrowser))).rememberDevice,true);
});

test('each member sees only their qualifying openings and their own CPR even with the tracker offline', async t=>{
  const time=1940000000;
  t.mock.method(Date,'now',()=>time*1000);
  db.exec("DELETE FROM portal_meta WHERE k='rosterAt'; DELETE FROM portal_roster");
  const env={DB:d1,FACTION_ID:'54',OWNER_ID:'999'};
  const firstKey='j'.repeat(16),secondKey='l'.repeat(16),publicKey='p'.repeat(16);
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    const key=init.headers.Authorization.slice(7),id=key===secondKey?721:720;
    if(url.pathname==='/v2/key/info')return Response.json({info:{user:{id,faction_id:54},selections:{user:key===publicKey?[]:['organizedcrimes']}}});
    if(url.pathname==='/v2/faction/54/members')return Response.json({members:[{id:720,name:'First'},{id:721,name:'Second'}]});
    assert.equal(url.pathname,'/v2/user/organizedcrimes');
    const seat=(label,cpr,user=null)=>({position_info:{label},user,checkpoint_pass_rate:cpr});
    return Response.json({organizedcrimes:[
      {id:871,name:'Stage Fright',difficulty:4,status:'Recruiting',slots:[seat('Muscle #2',id===720?21:30),seat('Muscle #1',id===720?59:60),seat('Sniper',99,{id:801})]},
      {id:872,name:'Pet Project',difficulty:1,status:'Recruiting',slots:[seat('Muscle',0)]},
      {id:873,name:'Market Forces',difficulty:3,status:'Recruiting',slots:[seat('Enforcer',id===720?50:70)]}
    ]});
  });
  const login=async key=>(await call(env,'/api/login',{body:{key}})).headers.get('Set-Cookie').split(';')[0];
  const alice=await login(publicKey),bob=await login(secondKey);
  const sync=(cookie,key)=>call(env,'/api/recruiting/sync',{cookie,body:{key}});
  const profile=async cookie=>(await call(env,'/api/profile',{cookie})).json();
  assert.equal((await sync(alice,publicKey)).status,403);
  assert.equal((await sync(alice,secondKey)).status,403);
  assert.equal((await profile(alice)).cprChecked,null);
  assert.equal((await sync(alice,firstKey)).status,200);
  const result=async cookie=>(await profile(cookie)).recruiting.map(r=>[r.id,r.slots.map(s=>[s.role,s.profileCPR])]);
  assert.deepEqual(await result(alice),[[871,[['Muscle #2',21]]],[872,[['Muscle',0]]]]);
  assert.deepEqual(await result(bob),[[871,[['Muscle #2',30],['Muscle #1',60]]],[872,[['Muscle',0]]],[873,[['Enforcer',70]]]]);
});
