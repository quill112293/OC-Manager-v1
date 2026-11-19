import {startRecord, observe} from './observe.js';
import {present,recruitingFor} from './model.js';

export const now=()=>Math.floor(Date.now()/1000);
export async function hash(s) {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
export class HttpError extends Error {
  constructor(status,message,code) {super(message);this.status=status;this.code=code;}
}

function ownerPinMatches(env, digest) {
  const pin = String(env.OWNER_KEY_SHA256 || '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(pin) && digest === pin;
}
export async function torn(key,path) {
  const url=new URL('https://api.torn.com/v2/'+path);
  url.searchParams.set('comment','OCManagerV1');
  const r=await fetch(url,{headers:{Authorization:'ApiKey '+key},redirect:'manual',signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw new HttpError(503,'Torn is unavailable. Try again shortly.');
  const j=await r.json();
  if(j.error)throw new HttpError([1,2,13,16].includes(j.error.code)?401:503,'Torn could not verify the request (code '+Number(j.error.code)+').');
  return j;
}

function tornBanner(image) {
  if (typeof image !== 'string' || !image.trim()) return null;
  try {
    const url = new URL(image.trim(), 'https://factionimages.torn.com/');
    const tornHost = url.hostname === 'torn.com' || url.hostname.endsWith('.torn.com');
    if (url.protocol !== 'https:' || !tornHost || url.username || url.password || url.port) return null;
    return url.href;
  } catch {
    return null;
  }
}

export async function factionWelcome(env) {
  const id = String(env.FACTION_ID).trim();
  if (!/^\d+$/.test(id)) return {error:'The configured faction ID is invalid.'};
  const cacheKey = 'welcome:' + id;
  const db = env.DB;
  const read = async () => {
    const row = await db.prepare('SELECT v FROM portal_meta WHERE k=?').bind(cacheKey).first();
    return row ? JSON.parse(row.v) : null;
  };
  if(!env.TORN_KEY?.trim())return (await read()) || {error:'The faction banner is temporarily unavailable.'};
  const missing = async error => {
    // Preserve a previously verified public profile while the upstream service is unavailable.
    const previous = await read();
    if (previous?.name) return previous;
    const unavailable = {error};
    await db.prepare(`INSERT INTO portal_meta(k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE
      SET v=excluded.v WHERE json_extract(portal_meta.v,'$.name') IS NULL`)
      .bind(cacheKey, JSON.stringify(unavailable)).run();
    return (await read()) || unavailable;
  };
  const current = now();
  // Reserve the next lookup across visitors. Keep the last good banner during a Torn outage.
  const claim = await db.prepare(`INSERT INTO portal_meta(k,v) VALUES (?,?)
    ON CONFLICT(k) DO UPDATE SET v=excluded.v WHERE CAST(portal_meta.v AS INTEGER)<=?`)
    .bind(cacheKey + ':next', String(current + 60), current).run();
  if (!claim.meta.changes) return read();
  try {
    const {basic} = await torn(env.TORN_KEY.trim(), 'faction/basic');
    if (String(basic?.id) !== id || !basic.name) return missing('Torn did not return the configured faction.');
    const faction = {name: basic.name, banner: tornBanner(basic.banner_image)};
    await db.batch([
      db.prepare('INSERT OR REPLACE INTO portal_meta(k,v) VALUES (?,?)').bind(cacheKey, JSON.stringify(faction)),
      db.prepare('UPDATE portal_meta SET v=? WHERE k=?').bind(String(current + 3600), cacheKey + ':next')
    ]);
    return faction;
  } catch (err) {
    return missing(err instanceof HttpError ? err.message : 'The faction banner lookup is temporarily unavailable.');
  }
}

export async function roster(env,{refresh=false,signInKey}={}) {
  const db=env.DB, stamp=Number((await db.prepare("SELECT v FROM portal_meta WHERE k='rosterAt'").first())?.v||0);
  if(refresh || now()-stamp>=300){
    const snapshot=now();
    const trackerKey=env.TORN_KEY?.trim();
    if(!trackerKey && !signInKey)throw new HttpError(401,'Sign in again so Torn can confirm your current faction membership.','membership_recheck');
    const {members}=trackerKey
      ? await torn(trackerKey,'faction/members')
      : await torn(signInKey,'faction/'+encodeURIComponent(env.FACTION_ID)+'/members');
    if(!Array.isArray(members)||members.some(m=>!Number.isInteger(m.id)||!m.name))throw new HttpError(503,'Faction roster unavailable.');
    const rows=[db.prepare(`INSERT INTO portal_roster SELECT json_extract(value,'$.id'),json_extract(value,'$.name'),? FROM json_each(?) WHERE true
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,checked=excluded.checked WHERE excluded.checked>=checked`).bind(snapshot,JSON.stringify(members.map(m=>({id:m.id,name:m.name}))))];
    await db.batch([...rows,db.prepare('DELETE FROM portal_roster WHERE checked<?').bind(snapshot),
      db.prepare("INSERT INTO portal_meta VALUES ('rosterAt',?) ON CONFLICT(k) DO UPDATE SET v=MAX(CAST(v AS INTEGER),CAST(excluded.v AS INTEGER))").bind(String(snapshot))]);
    return members;
  }
  return (await db.prepare('SELECT id,name FROM portal_roster ORDER BY name').all()).results;
}
export const SESSION_SECONDS=30*24*60*60;
// Zero is the persisted marker for a remembered session with no server-side deadline.
export const sessionExpiry=remember=>remember===true?0:now()+SESSION_SECONDS;
export function sessionToken(req) {
  return (req.headers.get('Cookie')||'').match(/(?:^|;\s*)__Host-oc_session=([a-f0-9]{64})(?:;|$)/)?.[1];
}
export async function identity(req,env) {
  const token=sessionToken(req);
  if(!token)throw new HttpError(401,'Sign in with your Torn key.');
  const row=await env.DB.prepare('SELECT * FROM portal_sessions WHERE digest=? AND (expires=0 OR expires>?)').bind(await hash(token),now()).first();
  if(!row)throw new HttpError(401,'Your session has ended.');
  const owner=String(row.member)===String(env.OWNER_ID).trim();
  if(owner && !ownerPinMatches(env,row.key_hash))throw new HttpError(401,'Sign in with your current owner key.');
  const rememberDevice=row.expires===0;
  let members;
  try {members=await roster(env);}
  catch(err){
    if(rememberDevice)throw new HttpError(503,'Your device is still signed in. OC Manager needs a current faction roster to open your profile.','membership_pending');
    throw err;
  }
  const me=members.find(m=>m.id===row.member);
  if(!me){await env.DB.prepare('DELETE FROM portal_sessions WHERE member=?').bind(row.member).run();throw new HttpError(403,'Current faction membership is required.');}
  const staff=await env.DB.prepare('SELECT key_hash FROM portal_staff WHERE id=?').bind(me.id).first();
  return {id:me.id,name:me.name,owner,staff:owner||staff?.key_hash===row.key_hash,members,keyHash:row.key_hash,token,rememberDevice};
}
async function savePersonalOpenings(env,id,key){
  const started=Date.now();
  const {organizedcrimes}=await torn(key,'user/organizedcrimes');
  if(!Array.isArray(organizedcrimes))throw new HttpError(503,'Torn did not return your recruiting roles.');
  const crimes=organizedcrimes.filter(c=>c.status==='Recruiting' && Number.isSafeInteger(c.id)).map(c=>present({
    id:c.id,name:c.name,level:c.difficulty,status:c.status,last:Math.floor(started/1000),expires:c.expired_at,
    slots:c.slots.filter(s=>!s.user).map(s=>({role:s.position_info?.label || s.position,member:null,
      profileCPR:Number.isFinite(s.checkpoint_pass_rate) && s.checkpoint_pass_rate>=0 && s.checkpoint_pass_rate<=100?s.checkpoint_pass_rate:null}))
  }));
  await env.DB.prepare(`INSERT INTO portal_recruiting(member,checked,body) VALUES (?,?,?)
    ON CONFLICT(member) DO UPDATE SET checked=excluded.checked,body=excluded.body WHERE excluded.checked>=portal_recruiting.checked`)
    .bind(id,started,JSON.stringify(crimes)).run();
}

export async function syncRecruiting(req,env,me){
  const {key}=await req.json();
  if(typeof key!=='string'||!/^[A-Za-z0-9]{16}$/.test(key))throw new HttpError(400,'Enter your personal 16-character CPR key.');
  if(key===env.TORN_KEY?.trim())throw new HttpError(403,'Use your personal CPR key.');
  const {info}=await torn(key,'key/info');
  if(info?.user?.id!==me.id || String(info.user.faction_id)!==String(env.FACTION_ID))throw new HttpError(403,'Use a key for the Torn account signed into this profile.');
  if(!info.selections?.user?.includes('organizedcrimes'))throw new HttpError(403,'This key needs access to user/organizedcrimes. Create a CPR key using the link in Recruiting.');
  await savePersonalOpenings(env,me.id,key);
}

export async function login(req,env) {
  const {key,rememberDevice}=await req.json();
  if(rememberDevice!==undefined && typeof rememberDevice!=='boolean')throw new HttpError(400,'Choose a device preference.');
  if(typeof key!=='string'||!/^[A-Za-z0-9]{16}$/.test(key))throw new HttpError(400,'Enter your 16-character Torn API key.');
  const {info}=await torn(key,'key/info');
  const id=info?.user?.id;
  if(!Number.isSafeInteger(id)||String(info.user.faction_id)!==String(env.FACTION_ID))throw new HttpError(403,'This site is for current faction members.');
  const members=await roster(env,{signInKey:key});
  const m=members.find(m=>m.id===id);
  if(!m)throw new HttpError(403,'Your player ID is absent from the current faction roster.');
  const digest=await hash(key), token=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
  const owner=String(id)===String(env.OWNER_ID).trim();
  if(owner && key===env.TORN_KEY?.trim())throw new HttpError(403,'This is the faction tracker key. Use your separate personal owner sign-in key.');
  if(owner && !ownerPinMatches(env,digest)){
    throw new HttpError(403,'Torn verified your owner account. Use the personal key paired with OC Manager, or pair this key below.','owner_key_pairing');
  }
  const previous=sessionToken(req);
  const tokenHash=await hash(token);
  const [,session]=await env.DB.batch([
    env.DB.prepare(`INSERT INTO portal_profiles VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE
      SET name=excluded.name, enrollment=excluded.enrollment
      WHERE portal_profiles.enrollment=excluded.enrollment OR ?=1`).bind(id,m.name,now(),digest,Number(owner)),
    env.DB.prepare('INSERT INTO portal_sessions SELECT ?,id,enrollment,? FROM portal_profiles WHERE id=? AND enrollment=?').bind(tokenHash,sessionExpiry(rememberDevice),id,digest),
    env.DB.prepare('UPDATE portal_staff SET key_hash=? WHERE id=? AND key_hash IS NULL AND EXISTS (SELECT 1 FROM portal_profiles WHERE id=? AND enrollment=?)').bind(digest,id,id,digest),
    ...(previous?[env.DB.prepare('DELETE FROM portal_sessions WHERE digest=? AND member=? AND EXISTS (SELECT 1 FROM portal_sessions WHERE digest=?)').bind(await hash(previous),id,tokenHash)]:[])
  ]);
  if(session.meta.changes!==1)throw new HttpError(403,'Use your enrolled OC Manager key, or ask the owner to reset enrollment.');
  if(key!==env.TORN_KEY?.trim() && info.selections?.user?.includes('organizedcrimes')){
    try{await savePersonalOpenings(env,id,key);}catch{ /* A CPR lookup can be retried in Recruiting. */ }
  }
  return {token,rememberDevice};
}
async function saveCrimes(env,crimes,rosterMap,stamp) {
  // Batch a page of records into two database calls, leaving room for Torn requests.
  for(let offset=0;offset<crimes.length;offset+=25){
    const group=crimes.slice(offset,offset+25), ids=group.map(c=>c.id);
    for(let attempt=0;attempt<3;attempt++){
      const prior=(await env.DB.prepare('SELECT id,rev,body FROM oc_records WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).all()).results;
      const old=new Map(prior.map(r=>[r.id,r])), write=[];
      for(const c of group){
        const stored=old.get(c.id), r=stored?JSON.parse(stored.body):startRecord(c);
        if(r.last>=stamp || (['Successful','Failure','Expired'].includes(r.status) && r.status===c.status && r.executed===c.executed_at))continue;
        observe(r,c,rosterMap,new Map(),stamp);
        write.push({id:c.id,rev:(stored?.rev||0)+1,r,status:r.status,due:r.nextCheck||0});
      }
      if(!write.length)break;
      const result=await env.DB.prepare(`INSERT INTO oc_records (id,rev,body,status,due_check)
        SELECT json_extract(value,'$.id'),json_extract(value,'$.rev'),json_extract(value,'$.r'),json_extract(value,'$.status'),json_extract(value,'$.due')
        FROM json_each(?) WHERE true ON CONFLICT(id) DO UPDATE SET
        rev=excluded.rev,body=excluded.body,status=excluded.status,due_check=excluded.due_check WHERE oc_records.rev=excluded.rev-1`).bind(JSON.stringify(write)).run();
      if(result.meta.changes===write.length)break;
      if(attempt===2)throw new Error('Concurrent update; retry on the next poll.');
    }
  }
}
export async function capture(env) {
  if(!env.TORN_KEY?.trim())throw new Error('OC tracking requires the TORN_KEY secret.');
  const stamp=now(), {info}=await torn(env.TORN_KEY,'key/info');
  if(!env.FACTION_ID||String(info?.user?.faction_id)!==String(env.FACTION_ID))throw new Error('Faction configuration mismatch.');
  const members=new Map((await roster(env,{refresh:true})).map(m=>[m.id,m]));
  const completedThrough=Number((await env.DB.prepare("SELECT v FROM portal_meta WHERE k='completedThrough'").first())?.v) || stamp-86400;
  const end=Math.min(stamp,completedThrough+86400);
  for(const type of ['available','completed']){
    let offset=0;
    const query=type==='completed'?'&from='+Math.max(0,completedThrough-600)+'&to='+end:'';
    for(;;){
      const {crimes}=await torn(env.TORN_KEY,'faction/crimes?cat='+type+'&sort=ASC&limit=100&offset='+offset+query);
      if(!Array.isArray(crimes))throw new Error('Unexpected OC response.');
      await saveCrimes(env,crimes,members,stamp);
      if(crimes.length<100)break;
      offset+=100;
      if(offset>=2000)throw new Error('Too many OCs in a single window.');
    }
  }
  await env.DB.batch([
    env.DB.prepare("INSERT INTO portal_meta VALUES ('completedThrough',?) ON CONFLICT(k) DO UPDATE SET v=MAX(CAST(v AS INTEGER),CAST(excluded.v AS INTEGER))").bind(String(end)),
    env.DB.prepare("INSERT INTO portal_meta VALUES ('lastSuccess',?) ON CONFLICT(k) DO UPDATE SET v=MAX(CAST(v AS INTEGER),CAST(excluded.v AS INTEGER))").bind(String(stamp)),
    env.DB.prepare('DELETE FROM portal_sessions WHERE expires>0 AND expires<=?').bind(stamp)
  ]);
}
export async function memberUsage(env,me) {
  if(!me.owner)throw new HttpError(403,'Only the owner can view member usage.');
  const names = new Map(me.members.map(member => [member.id,member.name]));
  const {results} = await env.DB.prepare(`SELECT p.id, p.first_seen AS firstSignIn, v.last_opened AS lastOpened
    FROM portal_profiles p LEFT JOIN portal_visits v ON v.member=p.id
    WHERE p.id IN (SELECT value FROM json_each(?))
    ORDER BY COALESCE(v.last_opened,p.first_seen) DESC, p.id`).bind(JSON.stringify([...names.keys()])).all();
  return {total:names.size,members:results.map(member => ({...member,name:names.get(member.id)}))};
}

export async function dashboard(env,me,scope) {
  if(scope==='staff'&&!me.staff)throw new HttpError(403,'Staff access required.');
  const records=(await env.DB.prepare('SELECT body FROM oc_records ORDER BY id DESC').all()).results.map(x=>present(JSON.parse(x.body)));
  const mine=r=>r.participants.some(p=>p.id===me.id)||r.blockers.some(b=>b.id===me.id);
  const visible=scope==='staff'?records:records.filter(mine);
  const saved=scope==='staff'?null:await env.DB.prepare('SELECT checked,body FROM portal_recruiting WHERE member=?').bind(me.id).first();
  const snapshot=saved?{checked:Math.floor(saved.checked/1000),crimes:JSON.parse(saved.body)}:null;
  const grants=me.owner && scope==='staff'?(await env.DB.prepare('SELECT id FROM portal_staff').all()).results.map(s=>s.id):[];
  return {me:{id:me.id,name:me.name,owner:me.owner,staff:me.staff},rememberDevice:me.rememberDevice,crimes:visible,
    recruiting:scope==='staff'?[]:recruitingFor(records,snapshot,now()),cprChecked:snapshot?.checked??null,
    roster:me.owner&&scope==='staff'?me.members.map(m=>({id:m.id,name:m.name,staff:grants.includes(m.id)})):[],
    trackingPaused:!env.TORN_KEY?.trim(),updated:Number((await env.DB.prepare("SELECT v FROM portal_meta WHERE k='lastSuccess'").first())?.v)||0};
}
