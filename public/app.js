'use strict';
const app=document.getElementById('app'),tools=document.getElementById('tools');
let data=null, demo=false, live=false,scope='member', tab='My OCs',filter='', error='';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const tct=s=>s?new Date(s*1000).toISOString().slice(11,16)+' TCT':'Unconfirmed';
const day=s=>s?new Date(s*1000).toLocaleDateString('en-CA',{month:'short',day:'numeric',timeZone:'UTC'}):'Date unknown';
const duration=s=>Number.isFinite(s)?(s%60===0?(s/60)+' min':Math.floor(s/60)+'m '+s%60+'s'):'Unconfirmed';
const total=r=>(r.spans||[]).reduce((sum,x)=>sum+x.end-x.start,0);
const mine=r=>r.participants.some(p=>p.id===data.me.id)||r.blockers.some(p=>p.id===data.me.id);
const delayed=r=>total(r)>0||r.pauses.some(x=>x.end>x.start)||r.blockers.length>0;
const badge=(s,kind='')=>'<span class="badge '+kind+'">'+esc(s)+'</span>';
const row=(l,r)=>'<div class="row"><span>'+l+'</span><span>'+r+'</span></div>';
const btn=(label,action,val='',cl='pill')=>'<button type="button" class="'+cl+'" data-act="'+action+'" data-val="'+esc(val)+'">'+esc(label)+'</button>';
const empty=s=>'<p class="empty">'+esc(s)+'</p>';
const msg=e=>{const el=document.getElementById('feedback');if(el){el.textContent=e;el.hidden=false;}};
async function api(path,body){
  const r=await fetch('/api/'+path,{method:body?'POST':'GET',credentials:'same-origin',
    headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
  const j=await r.json();if(!r.ok)throw Object.assign(new Error(j.error||'Request failed.'),{status:r.status});return j;
}
function showGate(){
  tools.innerHTML='<span class="mode">FACTION ACCESS</span>';
  app.innerHTML='<section class="gate"><div class="gateIntro"><div><div class="eyebrow">Faction operations</div><h1>OC Manager</h1></div><p>Your crew, your role, and the time you need to be back in Torn.</p></div><div class="gateForm"><h2>Member sign-in</h2>'+
    (live?'<form class="form" id="login"><label for="key">Torn API key</label><input id="key" name="key" type="password" required minlength="16" maxlength="16" autocomplete="off"><button class="btn">Open my profile</button><a href="https://www.torn.com/preferences.php#tab=api" target="_blank" rel="noopener noreferrer">Create a dedicated key in Torn</a><small>Your key verifies faction membership. The site stores a verifier and a session, not the raw key.</small></form>':
    '<p class="desc">Try the member and staff screens with sample faction records. No Torn key is needed for this review.</p>')+
    '<div class="spaced">'+btn('Open sample profile','demo','',''+(live?'link':'btn'))+'</div><p id="feedback" class="error" role="alert"></p></div></section>';
}
function buttons(items,selected,action){return items.map(x=>btn(x,action,x,'pill'+(x===selected?' sel':''))).join('');}
function timing(r){
  const spans=r.spans||[], sum=total(r);
  let out='<div class="line"><h3>Delay breakdown</h3>'+badge(sum?duration(sum)+' total':'No scheduled delay recorded',sum?'red':'')+'</div>';
  if(sum)out+='<div class="bar" aria-hidden="true">'+spans.map(s=>'<i class="'+(s.id?'':'wait')+'" style="flex:'+Number(s.end-s.start)+'"></i>').join('')+'</div>';
  out+=spans.map(s=>row('<strong>'+esc(s.id?s.name:s.reason)+'</strong><br><small>'+esc(tct(s.start)+' – '+tct(s.end))+'</small>',esc(duration(s.end-s.start))+'<br><small>'+esc(s.id?'User delay · '+s.reason:'OC delay')+'</small>')).join('');
  out+=(r.pauses||[]).map(p=>row('Planning delay · '+esc(p.reason),esc(duration(p.end-p.start)))).join('');
  out+=(r.events||[]).map(e=>'<small>'+esc(tct(e.at)+' · '+e.label)+'</small>').join('');
  return out;
}
function roster(r){
  return '<h3>OC roster</h3>'+r.participants.map(p=>{
    const b=r.blockers.find(b=>b.id===p.id);
    return '<div class="'+(b?'issue':'')+'">'+row('<b>'+esc(p.name)+'</b><br><small>'+esc(p.role)+'</small>',b?'Delayed by · '+esc(b.reasons.join(', ')):'')+'</div>';
  }).join('');
}
function card(r,opened=false){
  const own=r.participants.find(p=>p.id===data.me.id);
  const item=(r.slots||[]).filter(s=>s.member&&s.available===false);
  const detail=r.phase==='History'?day(r.executed)+' · '+r.status:r.phase==='Recruiting'?
    r.slots.filter(s=>!s.member).length+' open roles':(own?own.role+' · ':'')+r.phase;
  let body='';
  if(r.phase==='Recruiting'){
    body+='<small>'+esc(r.level==null?'Level unverified':r.level<=2?'No CPR or weight requirement':'Minimum 60 CPR · maximum 7% weight')+'</small>';
    body+=r.slots.filter(s=>!s.member).map(s=>{
      const known=Number.isFinite(s.profileCPR)&&Number.isFinite(s.weight);
      const state=r.level==null?'Verify in Torn':r.level<=2?'Eligible':!known?'Verify in Torn':s.profileCPR>=60&&s.weight<=7?'Eligible':'Outside requirements';
      return row('<b>'+esc(s.role)+'</b><br><small>Your CPR · '+esc(s.profileCPR??'unverified')+'</small>',badge(state,state==='Eligible'?'':'warn'));
    }).join('')||empty('No open roles in the latest snapshot.');
    body+='<a class="link" href="https://www.torn.com/factions.php?step=your#/tab=crimes" target="_blank" rel="noopener noreferrer">Open recruiting in Torn</a>';
  }else{
    body+=row('Scheduled start',esc(tct(r.ready)));
    if(r.phase==='History')body+=row('Executed',esc(tct(r.executed)));
    for(const s of item)body+='<p class="notice">Waiting for item · '+esc(s.itemName||('Item #'+s.item))+' for '+esc(s.role)+'</p>';
    if(r.phase==='History'||delayed(r))body+=timing(r);
    body+=roster(r);
  }
  return '<details class="card"'+(opened?' open':'')+'><summary><span class="level">LV<strong>'+esc(r.level??'–')+'</strong></span><span><b>'+esc(r.name)+'</b><span class="sub">#'+esc(r.id)+' · '+esc(detail)+'</span></span></summary><div class="inner">'+body+'</div></details>';
}
function draw(){
  if(!data){showGate();return;}
  const staff=scope==='staff',m=data.me;
  const all=staff?data.crimes:data.crimes.filter(r=>mine(r)||r.phase==='Recruiting');
  const active=all.filter(r=>r.phase!=='History'&&(staff||mine(r))),history=all.filter(r=>r.phase==='History'&&(staff||mine(r)));
  const historic=tab==='OC History'||tab==='View History';
  const tabs=staff?['Active OCs','OC History',...(m.owner?['Manage staff']:[])]:['Recruiting','My OCs','View History'];
  tools.innerHTML=(demo?'<span class="reviewLabel">Sample data</span>':'')+(m.staff?btn(staff?'My Profile':'Staff','scope',staff?'member':'staff'):'')+btn('Sign out','out');
  let list=[],chooser='',heading=tab;
  if(historic){
    const choices=staff?['Delayed OCs','Successful OCs']:['Delays','Successful OCs'];
    if(!choices.includes(filter))filter=choices[0];
    chooser=buttons(choices,filter,'filter');
    list=filter==='Successful OCs'?history.filter(r=>r.status==='Successful'):
      history.filter(r=>delayed(r)&&(staff||r.blockers.some(b=>b.id===m.id)||r.spans.some(s=>s.id===m.id)));
  }else if(tab==='Recruiting'){
    list=all.filter(r=>r.phase==='Recruiting');heading='Recruiting OCs';
  }else if(tab==='Active OCs'){
    const choices=['All phases','Recruiting','Planning','Executable'];if(!choices.includes(filter))filter=choices[0];
    chooser=buttons(choices,filter,'filter');list=active.filter(r=>filter==='All phases'||filter===r.phase);
  }else if(tab==='My OCs'){list=active;heading='My active OCs';}
  const tile=(n,l)=>'<div class="tile"><b>'+n+'</b><span>'+l+'</span></div>';
  const panels='<div class="summary">'+tile(active.length,'Active OCs')+tile(history.filter(r=>r.status==='Successful').length,'Successful OCs')+
    tile(history.filter(r=>delayed(r)&&(staff||r.blockers.some(b=>b.id===m.id))).length,'Delay records')+'</div>';
  let staffPanel='';
  if(tab==='Manage staff') staffPanel='<div class="panel stack"><h2>Manage staff</h2><label for="member-search">Search faction roster</label><input class="search" id="member-search" placeholder="Name or Torn ID"><div id="roster-list"></div></div>';
  const headingText=staff?'Staff panel':'My Profile';
  const side=historic?'<div class="eyebrow">History</div><h2>Delay records</h2><p class="desc">Open a crime to see the roster, each recorded cause, and time awaiting execution.</p>':
    '<div class="eyebrow">Faction policy</div><h2>Entry requirements</h2>'+row('Levels 1–2','Unrestricted')+row('Level 3+ CPR','60 minimum')+row('Level 3+ weight','7% maximum');
  app.innerHTML='<div class="screen"><div class="hero line"><div><div class="eyebrow">Faction operations</div><h1>'+headingText+'</h1></div><div class="person"><span class="avatar">'+esc(m.name.slice(0,1))+'</span><span><b>'+esc(m.name)+'</b><br><small>'+esc(m.owner?'Owner':m.staff?'Staff':'Member')+' · #'+esc(m.id)+'</small></span></div></div>'+
    panels+'<nav class="tabs" aria-label="Profile tabs">'+tabs.map(t=>btn(t,'tab',t,t===tab?'sel':'')).join('')+'</nav>'+
    '<p id="feedback" class="error" role="alert" hidden></p>'+(staffPanel||'<div class="grid"><section class="stack"><div><h2>'+esc(heading)+'</h2>'+(chooser?'<div class="pills">'+chooser+'</div>':'')+'</div>'+
    (list.length?list.map((r,i)=>card(r,list.length===1&&i===0)).join(''):empty('No matching OCs in the available records.'))+'</section><aside class="panel side">'+side+'</aside></div>')+'</div>';
  if(staffPanel)drawRoster('');
  document.getElementById('foot').textContent=(demo?'Sample snapshot':'Last successful faction check')+' · '+(data.updated?day(data.updated)+' '+tct(data.updated):'Awaiting first check')+(!demo&&data.updated&&Date.now()/1000-data.updated>600?' · Checks overdue':'');
}
function drawRoster(q){
  const list=data.roster.filter(x=>x.name.toLowerCase().includes(q.toLowerCase())||String(x.id).includes(q));
  document.getElementById('roster-list').innerHTML=list.map(x=>row('<b>'+esc(x.name)+'</b><br><small>#'+esc(x.id)+'</small>',x.id===data.me.id?badge('Owner'):btn(x.staff?'Remove staff':'Grant staff access','grant',x.id))).join('')||empty('No matching faction member.');
}
async function reloadScope(next){
  if(!demo)data=await api('profile?scope='+next);
  scope=next;tab=next==='staff'?'Active OCs':data.crimes.some(r=>r.phase!=='History'&&mine(r))?'My OCs':'Recruiting';filter='';draw();
}
document.addEventListener('input',e=>{if(e.target.id==='member-search')drawRoster(e.target.value);});
document.addEventListener('click',async e=>{
  const b=e.target.closest('[data-act]');if(!b)return;
  const {act,val}=b.dataset;
  try{
    if(act==='demo'){demo=true;data=window.ocSample();await reloadScope('member');}
    if(act==='out'){if(!demo)await api('logout',{});demo=false;data=null;scope='member';document.getElementById('foot').textContent='Faction operations';showGate();}
    if(act==='scope')await reloadScope(val);
    if(act==='tab'){tab=val;filter='';draw();}
    if(act==='filter'){filter=val;draw();}
    if(act==='grant'){const person=data.roster.find(x=>x.id===Number(val));if(!person)return;const grant=!person.staff;
      if(!demo){await api('staff',{id:person.id,grant});data=await api('profile?scope=staff');}else{person.staff=grant;}
      drawRoster(document.getElementById('member-search').value);msg((grant?'Granted staff access to ':'Removed staff access from ')+person.name+'.');}
  }catch(err){msg(err.message);}
});
document.addEventListener('submit',async e=>{
  if(e.target.id!=='login')return;e.preventDefault();const input=e.target.elements.key, key=input.value.trim();input.value='';
  try{await api('login',{key});demo=false;data=await api('profile');await reloadScope('member');}catch(err){msg(err.message);}
});
document.getElementById('brand').addEventListener('click',async e=>{e.preventDefault();if(data)try{await reloadScope('member');}catch(err){msg(err.message);}});
(async()=>{
  if(!window.OC_OFFLINE && ['http:','https:'].includes(location.protocol)){
    try{live=(await api('config')).live;if(live){data=await api('profile');await reloadScope('member');return;}}catch(err){if(err.status!==401)error=err.message;}
  }
  showGate();if(live&&error)msg(error);
})();
