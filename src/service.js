import {startRecord, observe} from './observe.js';
import {present} from './model.js';

export const now=()=>Math.floor(Date.now()/1000);
export async function hash(s) {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
export class HttpError extends Error {
  constructor(status,message) {super(message);this.status=status;}
}
export async function torn(key,path) {
  const url=new URL('https://api.torn.com/v2/'+path);
  url.searchParams.set('comment','OCManagerV1');
  const r=await fetch(url,{headers:{Authorization:'ApiKey '+key},redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw new HttpError(503,'Torn is unavailable. Try again shortly.');
  const j=await r.json();
  if(j.error)throw new HttpError([1,2,13,16].includes(j.error.code)?401:503,'Torn could not verify the request (code '+Number(j.error.code)+').');
  return j;
}
export async function roster(env,refresh=false) {
  const db=env.DB, stamp=Number((await db.prepare("SELECT v FROM portal_meta WHERE k='rosterAt'").first())?.v||0);
  if(refresh || now()-stamp>=300){
    const snapshot=now();
    const {members}=await torn(env.TORN_KEY,'faction/members');
    if(!Array.isArray(members)||members.some(m=>!Number.isInteger(m.id)||!m.name))throw new HttpError(503,'Faction roster unavailable.');
    const rows=members.map(m=>db.prepare('INSERT INTO portal_roster VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,checked=excluded.checked WHERE excluded.checked>=checked').bind(m.id,m.name,snapshot));
    await db.batch([...rows,db.prepare('DELETE FROM portal_roster WHERE checked<?').bind(snapshot),
      db.prepare("INSERT INTO portal_meta VALUES ('rosterAt',?) ON CONFLICT(k) DO UPDATE SET v=MAX(CAST(v AS INTEGER),CAST(excluded.v AS INTEGER))").bind(String(snapshot))]);
    return members;
  }
  return (await db.prepare('SELECT id,name FROM portal_roster ORDER BY name').all()).results;
}
export async function identity(req,env) {
  const token=(req.headers.get('Cookie')||'').match(/(?:^|;\s*)__Host-oc_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  if(!token)throw new HttpError(401,'Sign in with your Torn key.');
  const row=await env.DB.prepare('SELECT * FROM portal_sessions WHERE digest=? AND expires>?').bind(await hash(token),now()).first();
  if(!row)throw new HttpError(401,'Your session has ended.');
  const members=await roster(env);
  const me=members.find(m=>m.id===row.member);
  if(!me){await env.DB.prepare('DELETE FROM portal_sessions WHERE member=?').bind(row.member).run();throw new HttpError(403,'Current faction membership is required.');}
  const owner=String(me.id)===String(env.OWNER_ID) && row.key_hash===env.OWNER_KEY_SHA256;
  const staff=await env.DB.prepare('SELECT key_hash FROM portal_staff WHERE id=?').bind(me.id).first();
  return {id:me.id,name:me.name,owner,staff:owner||staff?.key_hash===row.key_hash,members,keyHash:row.key_hash,token};
}
export async function login(req,env) {
  const {key}=await req.json();
  if(typeof key!=='string'||!/^[A-Za-z0-9]{16}$/.test(key))throw new HttpError(400,'Enter your 16-character Torn API key.');
  const {info}=await torn(key,'key/info');
  const id=info?.user?.id;
  if(!Number.isSafeInteger(id)||String(info.user.faction_id)!==String(env.FACTION_ID))throw new HttpError(403,'This site is for current faction members.');
  const members=await roster(env);
  const m=members.find(m=>m.id===id);
  if(!m)throw new HttpError(403,'Your player ID is absent from the current faction roster.');
  const digest=await hash(key), token=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
  if(String(id)===String(env.OWNER_ID) && env.OWNER_KEY_SHA256 && digest!==env.OWNER_KEY_SHA256)
    throw new HttpError(403,'Use the dedicated owner key for this manager.');
  const enrollment=await env.DB.prepare('SELECT enrollment FROM portal_profiles WHERE id=?').bind(id).first();
  if(enrollment && enrollment.enrollment!==digest)throw new HttpError(403,'Use your enrolled OC Manager key, or ask the owner to reset enrollment.');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO portal_profiles VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name').bind(id,m.name,now(),digest),
    env.DB.prepare('INSERT INTO portal_sessions SELECT ?,id,enrollment,? FROM portal_profiles WHERE id=? AND enrollment=?').bind(await hash(token),now()+2592000,id,digest),
    env.DB.prepare('UPDATE portal_staff SET key_hash=? WHERE id=? AND key_hash IS NULL AND EXISTS (SELECT 1 FROM portal_profiles WHERE id=? AND enrollment=?)').bind(digest,id,id,digest)
  ]);
  return token;
}
async function saveCrime(env,c,rosterMap,stamp) {
  for(let n=0;n<3;n++){
    const old=await env.DB.prepare('SELECT rev,body FROM oc_records WHERE id=?').bind(c.id).first();
    const r=old?JSON.parse(old.body):startRecord(c);
    if(r.last>=stamp || (['Successful','Failure','Expired'].includes(r.status) && r.status===c.status && r.executed===c.executed_at))return;
    observe(r,c,rosterMap,new Map(),stamp);
    const w=await env.DB.prepare('INSERT INTO oc_records VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET rev=excluded.rev,body=excluded.body,status=excluded.status,due_check=excluded.due_check WHERE oc_records.rev=?')
      .bind(c.id,(old?.rev||0)+1,JSON.stringify(r),r.status,r.nextCheck||0,old?.rev||0).run();
    if(w.meta.changes)return;
  }
  throw new Error('Concurrent update; retry on the next poll.');
}
export async function capture(env) {
  const stamp=now(), {info}=await torn(env.TORN_KEY,'key/info');
  if(!env.FACTION_ID||String(info?.user?.faction_id)!==String(env.FACTION_ID))throw new Error('Faction configuration mismatch.');
  const members=new Map((await roster(env,true)).map(m=>[m.id,m]));
  const completedThrough=Number((await env.DB.prepare("SELECT v FROM portal_meta WHERE k='completedThrough'").first())?.v) || stamp-86400;
  const end=Math.min(stamp,completedThrough+86400);
  for(const type of ['available','completed']){
    let offset=0;
    const query=type==='completed'?'&from='+Math.max(0,completedThrough-600)+'&to='+end:'';
    for(;;){
      const {crimes}=await torn(env.TORN_KEY,'faction/crimes?cat='+type+'&sort=ASC&limit=100&offset='+offset+query);
      if(!Array.isArray(crimes))throw new Error('Unexpected OC response.');
      for(const c of crimes)await saveCrime(env,c,members,stamp);
      if(crimes.length<100)break;
      offset+=100;
      if(offset>=2000)throw new Error('Too many OCs in a single window.');
    }
  }
  await env.DB.batch([
    env.DB.prepare("INSERT INTO portal_meta VALUES ('completedThrough',?) ON CONFLICT(k) DO UPDATE SET v=MAX(CAST(v AS INTEGER),CAST(excluded.v AS INTEGER))").bind(String(end)),
    env.DB.prepare('DELETE FROM portal_sessions WHERE expires<=?').bind(stamp)
  ]);
}
export async function dashboard(env,me,scope) {
  if(scope==='staff'&&!me.staff)throw new HttpError(403,'Staff access required.');
  const records=(await env.DB.prepare('SELECT body FROM oc_records ORDER BY id DESC').all()).results.map(x=>present(JSON.parse(x.body)));
  const mine=r=>r.participants.some(p=>p.id===me.id)||r.blockers.some(b=>b.id===me.id);
  const visible=scope==='staff'?records:records.filter(r=>mine(r)||r.phase==='Recruiting');
  const grants=me.owner && scope==='staff'?(await env.DB.prepare('SELECT id FROM portal_staff').all()).results.map(s=>s.id):[];
  return {me:{id:me.id,name:me.name,owner:me.owner,staff:me.staff},crimes:visible.map(r=>{
    if(scope==='staff'||mine(r))return r;
    return {...r,participants:[],blockers:[],spans:[],pauses:[],slots:r.slots.map(s=>({...s,member:s.member?'filled':null,cpr:null}))};
  }),roster:me.owner&&scope==='staff'?me.members.map(m=>({id:m.id,name:m.name,staff:grants.includes(m.id)})):[],
    updated:Math.max(0,...records.map(r=>r.updated||0))};
}
