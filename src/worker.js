import { HttpError,identity,login,dashboard,hash,capture,factionWelcome,memberUsage,syncRecruiting,now,sessionToken,sessionExpiry,SESSION_SECONDS } from './service.js';
const schema = [
  "CREATE TABLE IF NOT EXISTS oc_records (id INTEGER PRIMARY KEY, rev INTEGER NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, due_check INTEGER NOT NULL);",
  "CREATE TABLE IF NOT EXISTS portal_profiles (id INTEGER PRIMARY KEY, name TEXT NOT NULL, first_seen INTEGER NOT NULL, enrollment TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS portal_visits (member INTEGER PRIMARY KEY REFERENCES portal_profiles(id) ON DELETE CASCADE, last_opened INTEGER NOT NULL);",
  "CREATE TABLE IF NOT EXISTS portal_recruiting (member INTEGER PRIMARY KEY REFERENCES portal_profiles(id) ON DELETE CASCADE, checked INTEGER NOT NULL, body TEXT NOT NULL);",
  "CREATE TABLE IF NOT EXISTS portal_sessions (digest TEXT PRIMARY KEY, member INTEGER NOT NULL, key_hash TEXT NOT NULL, expires INTEGER NOT NULL);",
  "CREATE INDEX IF NOT EXISTS portal_session_expiry ON portal_sessions(expires);",
  "CREATE TABLE IF NOT EXISTS portal_staff (id INTEGER PRIMARY KEY, key_hash TEXT);",
  "CREATE TABLE IF NOT EXISTS portal_roster (id INTEGER PRIMARY KEY, name TEXT NOT NULL, checked INTEGER NOT NULL);",
  "CREATE TABLE IF NOT EXISTS portal_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);"
];
const initializedDatabases = new WeakMap();

function initializeDatabase(db) {
  let pending = initializedDatabases.get(db);
  if (!pending) {
    pending = db.batch(schema.map(statement => db.prepare(statement))).catch(error => {
      initializedDatabases.delete(db);
      throw error;
    });
    initializedDatabases.set(db, pending);
  }
  return pending;
}

const json=(v,status=200,headers={})=>Response.json(v,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
const cookie=(value,age)=>'__Host-oc_session='+value+'; Path=/; Secure; HttpOnly; SameSite=Strict'+(age==null?'':'; Max-Age='+age);
function deviceCookie(token,rememberDevice){
  // Renew the persistent browser cookie whenever the saved device opens its profile.
  return cookie(token,rememberDevice?400*24*60*60:null);
}
async function handle(req,env){
  const url=new URL(req.url), path=url.pathname, method=req.method;
  if(path==='/oc-manager.user.js'){
    const script=['// ==UserScript==','// @name OC Manager shortcut','// @namespace '+url.origin,'// @version 1.0.1','// @match https://www.torn.com/factions.php*','// @grant none','// ==/UserScript==',
    '(()=>{ if(document.getElementById("oc-manager-shortcut"))return;const a=document.createElement("a");a.id="oc-manager-shortcut";a.textContent="My OC Profile";a.href='+JSON.stringify(url.origin+'/#profile')+';a.target="_blank";a.rel="noopener noreferrer";a.style.cssText="position:fixed;bottom:70px;right:12px;z-index:9999;background:#25617c;color:white;padding:8px 12px;border-radius:6px;font:14px sans-serif";document.body.append(a);})();'].join('\n');
    return new Response(script,{headers:{'Content-Type':'text/javascript; charset=utf-8'}});
  }
  if(!path.startsWith('/api/'))return env.ASSETS.fetch(req);
  if(method!=='GET'&&req.headers.get('Origin')!==url.origin)throw new HttpError(403,'Invalid request origin.');
  if(path==='/api/welcome'&&method==='GET'){
    if(!env.DB||!env.FACTION_ID)throw new HttpError(503,'Faction banner configuration is pending.');
    await initializeDatabase(env.DB);
    return json(await factionWelcome(env));
  }
  const missing = ['DB','FACTION_ID','OWNER_ID'].filter(name => !env[name] || (typeof env[name]==='string' && !env[name].trim()));
  if(path==='/api/config')return json({live:missing.length===0,missing});
  if(missing.length)throw new HttpError(503,'Cloudflare is missing '+missing.join(', ')+'.');
  await initializeDatabase(env.DB);
  if(path==='/api/login'&&method==='POST'){
    const {token,rememberDevice}=await login(req,env);
    return json({ok:true},200,{'Set-Cookie':rememberDevice===undefined?cookie(token,SESSION_SECONDS):deviceCookie(token,rememberDevice)});
  }
  if(path==='/api/logout'&&method==='POST'){
    const token=sessionToken(req);
    if(token)await env.DB.prepare('DELETE FROM portal_sessions WHERE digest=?').bind(await hash(token)).run();
    return json({ok:true},200,{'Set-Cookie':cookie('',0)});
  }
  const me=await identity(req,env);
  if(path==='/api/recruiting/sync' && method==='POST'){
    await syncRecruiting(req,env,me);
    return json({ok:true});
  }
  if(path==='/api/device'&&method==='POST'){
    const {rememberDevice}=await req.json();
    if(typeof rememberDevice!=='boolean')throw new HttpError(400,'Choose a device preference.');
    const saved=await env.DB.prepare('UPDATE portal_sessions SET expires=? WHERE digest=? AND (expires=0 OR expires>?)')
      .bind(sessionExpiry(rememberDevice),await hash(me.token),now()).run();
    if(!saved.meta.changes)throw new HttpError(401,'Your session has ended.');
    return json({rememberDevice},200,{'Set-Cookie':deviceCookie(me.token,rememberDevice)});
  }
  if(path==='/api/members'&&method==='GET')return json(await memberUsage(env,me));
  if(path==='/api/profile'&&method==='GET'){
    const response = json(await dashboard(env,me,url.searchParams.get('scope')),200,me.rememberDevice?{'Set-Cookie':deviceCookie(me.token,true)}:{});
    await env.DB.prepare(`INSERT INTO portal_visits (member,last_opened) SELECT id,? FROM portal_profiles WHERE id=?
      ON CONFLICT(member) DO UPDATE SET last_opened=excluded.last_opened WHERE excluded.last_opened>portal_visits.last_opened`)
      .bind(now(),me.id).run().catch(()=>console.warn('Unable to record a profile visit.'));
    return response;
  }
  if(path==='/api/staff'&&method==='POST'){
    if(!me.owner)throw new HttpError(403,'Only the owner can manage staff.');
    const {id,grant}=await req.json();
    if(!Number.isSafeInteger(id)||typeof grant!=='boolean'||id===me.id||!me.members.some(m=>m.id===id))throw new HttpError(400,'Select a current faction member.');
    if(grant)await env.DB.prepare('INSERT OR IGNORE INTO portal_staff VALUES (?,(SELECT enrollment FROM portal_profiles WHERE id=?))').bind(id,id).run();
    else await env.DB.prepare('DELETE FROM portal_staff WHERE id=?').bind(id).run();
    return json({ok:true});
  }
  throw new HttpError(404,'Page unavailable.');
}
export default {
  async fetch(req,env){
    try{return await handle(req,env);}
    catch(err){
      if(err instanceof HttpError)return json({error:err.message,code:err.code},err.status);
      return json({error:'The manager is unavailable. Try again after checking the Worker configuration.'},503);
    }
  },
  scheduled(event,env,ctx){ctx.waitUntil(initializeDatabase(env.DB).then(()=>capture(env)));}
};
