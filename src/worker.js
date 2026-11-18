import { HttpError,identity,login,dashboard,hash,capture } from './service.js';
const schema = [
  "CREATE TABLE IF NOT EXISTS oc_records (id INTEGER PRIMARY KEY, rev INTEGER NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, due_check INTEGER NOT NULL);",
  "CREATE TABLE IF NOT EXISTS portal_profiles (id INTEGER PRIMARY KEY, name TEXT NOT NULL, first_seen INTEGER NOT NULL, enrollment TEXT NOT NULL);",
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
const cookie=(value,age)=>'__Host-oc_session='+value+'; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age='+age;
async function handle(req,env){
  const url=new URL(req.url), path=url.pathname, method=req.method;
  if(path==='/oc-manager.user.js'){
    const script=['// ==UserScript==','// @name OC Manager shortcut','// @namespace '+url.origin,'// @version 1.0.0','// @match https://www.torn.com/factions.php*','// @grant none','// ==/UserScript==',
    '(()=>{ if(document.getElementById("oc-manager-shortcut"))return;const a=document.createElement("a");a.id="oc-manager-shortcut";a.textContent="My OC Profile";a.href='+JSON.stringify(url.origin+'/#profile')+';a.target="_blank";a.rel="noopener noreferrer";a.style.cssText="position:fixed;bottom:70px;right:12px;z-index:9999;background:#123c36;color:white;padding:8px 12px;border-radius:6px;font:14px sans-serif";document.body.append(a);})();'].join('\n');
    return new Response(script,{headers:{'Content-Type':'text/javascript; charset=utf-8'}});
  }
  if(!path.startsWith('/api/'))return env.ASSETS.fetch(req);
  if(method!=='GET'&&req.headers.get('Origin')!==url.origin)throw new HttpError(403,'Invalid request origin.');
  if(path==='/api/config')return json({live:Boolean(env.DB&&env.FACTION_ID&&env.TORN_KEY)});
  if(!env.DB||!env.FACTION_ID||!env.TORN_KEY)throw new HttpError(503,'Faction configuration is pending.');
  await initializeDatabase(env.DB);
  if(path==='/api/login'&&method==='POST'){const token=await login(req,env);return json({ok:true},200,{'Set-Cookie':cookie(token,2592000)});}
  if(path==='/api/logout'&&method==='POST'){
    const token=(req.headers.get('Cookie')||'').match(/(?:^|;\s*)__Host-oc_session=([a-f0-9]{64})(?:;|$)/)?.[1];
    if(token)await env.DB.prepare('DELETE FROM portal_sessions WHERE digest=?').bind(await hash(token)).run();
    return json({ok:true},200,{'Set-Cookie':cookie('',0)});
  }
  const me=await identity(req,env);
  if(path==='/api/profile'&&method==='GET')return json(await dashboard(env,me,url.searchParams.get('scope')));
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
  async fetch(req,env){try{return await handle(req,env);}catch(err){return json({error:err instanceof HttpError?err.message:'The manager is unavailable. Try again after checking the Worker configuration.'},err instanceof HttpError?err.status:503);}},
  scheduled(event,env,ctx){ctx.waitUntil(initializeDatabase(env.DB).then(()=>capture(env)));}
};
