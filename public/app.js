'use strict';
const app=document.getElementById('app'),tools=document.getElementById('tools');
let data=null, live=false,scope='member', tab='My OCs',filter='', error='';
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
  const j=await r.json();
  if(!r.ok){
    if(j.code==='membership_pending' || (j.code==='membership_recheck' && data)){
      data=null;scope='member';document.getElementById('foot').textContent='Faction operations';showGate(j.code==='membership_pending');
    }
    throw Object.assign(new Error(j.error||'Request failed.'),{status:r.status,code:j.code});
  }
  return j;
}
let savingDevice=false;
function deviceSetting(checked=false){
  return '<label class="device-choice"><input type="checkbox" name="rememberDevice"'+(checked?' checked':'')+(savingDevice?' disabled':'')+'> Remember this device</label>';
}
// Torn's custom-key builder takes the requested selections in the preferences URL fragment.
const createKeyLink='<a href="https://www.torn.com/preferences.php#tab=api?step=addNewKey&amp;title=OC%20Manager&amp;user=organizedcrimes&amp;faction=members" target="_blank" rel="noopener noreferrer">Create OC Manager key in Torn</a>';
const keyExplanation='Your custom key lets OC Manager verify your faction membership and show your CPR for each open role. The key is discarded after the lookup.';
function showGate(pending=false){
  tools.innerHTML=pending?btn('Sign out','out'):'';
  app.innerHTML=`<section class="gate" aria-labelledby="welcome-heading">
    <div id="welcome-banner" class="welcomeBanner" ${window.OC_OFFLINE?'hidden':''}></div>
    <div class="gateForm">
      <p id="welcome-faction" class="eyebrow" hidden></p>
      <h1 id="welcome-heading">${pending?'Verify faction membership':'Welcome to OC Manager'}</h1>
      ${pending?'<p class="desc">Your device is still signed in. Retry the roster check or use your Torn key to verify membership now.</p><button type="button" class="link tight" data-act="retry">Retry roster check</button>':''}
      ${live?`<form class="form" id="login">
        ${deviceSetting(pending)}
        <label for="key">Your Torn API key</label>
        <input id="key" name="key" type="password" required pattern="[A-Za-z0-9]{16}" title="Enter your 16-character Torn API key" placeholder="Paste your 16-character key" autocomplete="off" autocapitalize="none" spellcheck="false">
        <button class="btn" type="submit">Open my profile</button>
        ${createKeyLink}
        <small>${keyExplanation}</small>
      </form>`:window.OC_OFFLINE?'<a class="btn preview-sign-in" href="https://oc-manager-v1.975y7srs57.workers.dev/">Open OC Manager to sign in</a>':'<p class="desc">Member sign-in is temporarily unavailable.</p><button class="link tight" data-act="retry">Check again</button>'}
      <p id="feedback" class="error" role="alert"></p>
      <section id="owner-pairing" class="ownerPairing" aria-labelledby="pair-heading" hidden>
        <h2 id="pair-heading">Pair this owner key</h2>
        <label for="owner-fingerprint">Fingerprint for Cloudflare</label>
        <input id="owner-fingerprint" type="text" readonly spellcheck="false">
        <button class="link" type="button" data-act="copy-fingerprint">Copy fingerprint</button>
        <small id="copy-status" role="status"></small>
        <ol>
          <li>In Cloudflare, open <strong>oc-manager-v1 → Settings → Variables and Secrets</strong>.</li>
          <li>Set <code>OWNER_KEY_SHA256</code> to the copied fingerprint and tap <strong>Deploy</strong>.</li>
          <li>Return here and sign in with the same 16-character Torn key.</li>
        </ol>
      </section>
    </div>
  </section>`;
  if(!window.OC_OFFLINE)loadWelcomeBanner();
}

async function showOwnerPairing(key) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const fingerprint = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  document.getElementById('owner-fingerprint').value = fingerprint;
  document.getElementById('owner-pairing').hidden = false;
}

async function loadWelcomeBanner(){
  const banner = document.getElementById('welcome-banner');
  const name = document.getElementById('welcome-faction');
  try {
    const faction = await api('welcome');
    if (faction?.name) {
      name.textContent = faction.name;
      name.hidden = false;
    }
    if (faction?.banner) {
      const image = new Image();
      image.alt = faction.name + ' faction banner';
      image.onerror = () => { banner.hidden = true; };
      banner.replaceChildren(image);
      image.src = faction.banner;
      return;
    }
  } catch {
    // Sign-in remains available when the banner cannot be retrieved.
  }
  banner.hidden = true;
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
const percent=value=>Number(value.toFixed(2))+'%';
const weightText=value=>Number.isFinite(value)?percent(value):'Unknown';
function roster(r){
  const seats=r.slots.length?r.slots:r.participants.map(p=>({role:p.role,member:p.id,weight:p.weight}));
  return '<h3>OC roster</h3>'+seats.map(seat=>{
    const person=r.participants.find(p=>p.id===seat.member);
    const blocker=r.blockers.find(b=>b.id===seat.member);
    const detail=person?.name || (seat.member?'Filled':'Open');
    return '<div class="'+(blocker?'issue':'')+'">'+row('<b>'+esc(seat.role)+'</b><br><small>'+esc(detail)+'</small>',
      'Weight · '+weightText(seat.weight)+(blocker?'<br><small>Delayed by · '+esc(blocker.reasons.join(', '))+'</small>':''))+'</div>';
  }).join('');
}
function weightSummary(r,own){
  if(own && Number.isFinite(own.weight))return 'Your role weight · '+percent(own.weight);
  const seats=r.slots.length?r.slots:r.participants;
  const values=seats.map(seat=>seat.weight).filter(Number.isFinite);
  if(!values.length)return 'Role weights · Unknown';
  const low=Math.min(...values),high=Math.max(...values);
  return 'Role weights · '+percent(low)+(low===high?'':'–'+percent(high));
}
function card(r,opened=false,personalOpening=false){
  const own=r.participants.find(p=>p.id===data.me.id);
  const item=(r.slots||[]).filter(s=>s.member&&s.available===false);
  const openings=r.slots.filter(s=>!s.member).length;
  const detail=r.phase==='History'?day(r.executed)+' · '+r.status:r.phase==='Recruiting'?
    openings+(personalOpening?' qualifying opening':' open role')+(openings===1?'':'s'):(own?own.role+' · ':'')+r.phase;
  let body='';
  if(r.phase==='Recruiting'){
    body+=r.slots.map(s=>{
      let state=s.member?'Filled':s.eligibility || 'Verify in Torn';
      if(!s.member && state==='Verify in Torn' && r.level>=3 && s.weight>7)state='60 CPR required';
      const cpr=personalOpening?'<br><small>Your CPR · '+esc(s.profileCPR??'Sync to check')+'</small>':'';
      return row('<b>'+esc(s.role)+'</b><br><small>Weight · '+weightText(s.weight)+'</small>'+cpr,badge(state,state==='Eligible'||s.member?'':'warn'));
    }).join('')||empty('No roles in the latest snapshot.');
    body+='<a class="link" href="https://www.torn.com/factions.php?step=your#/tab=crimes" target="_blank" rel="noopener noreferrer">Open recruiting in Torn</a>';
  }else{
    body+=row('Scheduled start',esc(tct(r.ready)));
    if(r.phase==='History')body+=row('Executed',esc(tct(r.executed)));
    for(const s of item)body+='<p class="notice">Waiting for item · '+esc(s.itemName||('Item #'+s.item))+' for '+esc(s.role)+'</p>';
    if(r.phase==='History'||delayed(r))body+=timing(r);
    body+=roster(r);
  }
  const requirements=r.level===1||r.level===2?'No requirements':r.level>=3?'60 CPR minimum unless role weight is 7% or less':'Level unverified';
  body='<p class="kicker">'+requirements+'</p>'+body;
  return '<details class="card"'+(opened?' open':'')+'><summary><span class="level">LV<strong>'+esc(r.level??'–')+'</strong></span><span><b>'+esc(r.name)+'</b><span class="sub">#'+esc(r.id)+' · '+esc(detail)+'</span><span class="sub">'+weightSummary(r,own)+'</span></span></summary><div class="inner">'+body+'</div></details>';
}
function cprForm(){
  const stamp=data.cprChecked?'Last personal sync · '+day(data.cprChecked)+' '+tct(data.cprChecked):'Sync to see your Torn CPR for each open role.';
  return '<details class="panel"><summary>Sync my CPR</summary><form id="sync-cpr" class="form tight">'+
    '<small>'+stamp+'</small>'+createKeyLink+
    '<label for="cpr-key">Your OC Manager key</label><input id="cpr-key" name="key" type="password" pattern="[A-Za-z0-9]{16}" required autocomplete="off" autocapitalize="none" spellcheck="false">'+
    '<small>'+keyExplanation+'</small>'+
    '<button type="submit" class="btn">Sync my CPR</button><small role="status"></small></form></details>';
}
function draw(){
  if(!data){showGate();return;}
  const staff=scope==='staff',m=data.me;
  const all=staff?data.crimes:data.crimes.filter(r=>mine(r)||r.phase==='Recruiting');
  const active=all.filter(r=>r.phase!=='History'&&(staff||mine(r))),history=all.filter(r=>r.phase==='History'&&(staff||mine(r)));
  const historic=tab==='OC History'||tab==='View History';
  const tabs=staff?['Active OCs','OC History']:['Recruiting','My OCs','View History'];
  if(m.owner)tabs.splice(1,0,'Members');
  if(staff && m.owner)tabs.push('Manage staff');
  tools.innerHTML=(m.staff?btn(staff?'My Profile':'Staff','scope',staff?'member':'staff'):'')+btn('Sign out','out');
  let list=[],chooser='',heading=tab;
  if(historic){
    const choices=staff?['Delayed OCs','Successful OCs']:['Delays','Successful OCs'];
    if(!choices.includes(filter))filter=choices[0];
    chooser=buttons(choices,filter,'filter');
    list=filter==='Successful OCs'?history.filter(r=>r.status==='Successful'):
      history.filter(r=>delayed(r)&&(staff||r.blockers.some(b=>b.id===m.id)||r.spans.some(s=>s.id===m.id)));
  }else if(tab==='Recruiting'){
    list=data.recruiting||[];heading='Roles you qualify for';
  }else if(tab==='Active OCs'){
    const choices=['All phases','Recruiting','Planning','Executable'];if(!choices.includes(filter))filter=choices[0];
    chooser=buttons(choices,filter,'filter');list=active.filter(r=>filter==='All phases'||filter===r.phase);
  }else if(tab==='My OCs'){list=active;heading='My active OCs';}
  const tile=(n,l)=>'<div class="tile"><b>'+n+'</b><span>'+l+'</span></div>';
  const panels='<div class="summary">'+tile(active.length,'Active OCs')+tile(history.filter(r=>r.status==='Successful').length,'Successful OCs')+
    tile(history.filter(r=>delayed(r)&&(staff||r.blockers.some(b=>b.id===m.id))).length,'Delay records')+'</div>';
  let staffPanel='';
  if(tab==='Members' && m.owner)staffPanel='<section class="panel stack" id="member-usage"><h2>Members</h2><p role="status">Loading member sign-ins…</p></section>';
  if(tab==='Manage staff') staffPanel='<div class="panel stack"><h2>Manage staff</h2><label for="member-search">Search faction roster</label><input class="search" id="member-search" placeholder="Name or Torn ID"><div id="roster-list"></div></div>';
  const headingText=staff?'Staff panel':'My Profile';
  const side=historic?'<div class="eyebrow">History</div><h2>Delay records</h2><p class="desc">Open a crime to see the roster, each recorded cause, and time awaiting execution.</p>':
    '<div class="eyebrow">Faction policy</div><h2>Entry requirements</h2>'+row('Levels 1–2','No requirements')+row('Level 3+ · weight ≤ 7%','No CPR minimum')+row('Level 3+ · weight > 7%','60 CPR minimum');
  app.innerHTML='<div class="screen"><div class="hero line"><div><div class="eyebrow">Faction operations</div><h1>'+headingText+'</h1></div><div class="person"><span class="avatar">'+esc(m.name.slice(0,1))+'</span><span><b>'+esc(m.name)+'</b><br><small>'+esc(m.owner?'Owner':m.staff?'Staff':'Member')+' · #'+esc(m.id)+'</small></span></div></div>'+
    deviceSetting(data.rememberDevice)+panels+'<nav class="tabs" aria-label="Profile tabs">'+tabs.map(t=>btn(t,'tab',t,t===tab?'sel':'')).join('')+'</nav>'+
    '<p id="feedback" class="error" role="alert" hidden></p>'+(staffPanel||'<div class="grid"><section class="stack"><div><h2>'+esc(heading)+'</h2>'+(chooser?'<div class="pills">'+chooser+'</div>':'')+'</div>'+
    (tab==='Recruiting'?cprForm():'')+(list.length?list.map((r,i)=>card(r,list.length===1&&i===0,tab==='Recruiting')).join(''):empty(tab==='Recruiting'?'No qualifying openings in the latest available data.':'No matching OCs in the available records.'))+'</section><aside class="panel side">'+side+'</aside></div>')+'</div>';
  if(tab==='Manage staff')drawRoster('');
  if(tab==='Members' && m.owner)loadMemberUsage(document.getElementById('member-usage'));
  document.getElementById('foot').textContent=(data.trackingPaused?'OC tracking paused · ':'')+'Last successful faction check · '+(data.updated?day(data.updated)+' '+tct(data.updated):'Awaiting first check')+(data.updated&&Date.now()/1000-data.updated>600?' · Checks overdue':'');
}
async function loadMemberUsage(panel){
  const status=panel.querySelector('[role="status"]');
  try {
    const {total,members}=await api('members');
    if(!panel.isConnected)return;
    status.textContent=members.length+' of '+total+' current faction members have signed in.';
    if(!members.length)return;
    panel.insertAdjacentHTML('beforeend','<label for="usage-search">Search by name or Torn ID</label><input class="search" type="search" id="usage-search"><ul class="usage-list"></ul>');
    const search=panel.querySelector('input');
    const list=panel.querySelector('ul');
    const dates=new Intl.DateTimeFormat('en-GB',{
      timeZone:'UTC',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'
    });
    const formatDate=stamp=>dates.format(stamp*1000)+' TCT';
    function renderList(){
      const q=search.value.trim().toLowerCase().replace(/^#/,'');
      const visible=members.filter(member=>member.name.toLowerCase().includes(q)||String(member.id).includes(q));
      list.innerHTML=visible.map(member=>{
        const last=member.lastOpened?formatDate(member.lastOpened):'No visit recorded yet';
        return '<li><strong>'+esc(member.name)+'</strong> <small>#'+esc(member.id)+'</small>'+
          '<br><small>First sign-in · '+esc(formatDate(member.firstSignIn))+'</small>'+
          '<br><small>Last opened · '+esc(last)+'</small></li>';
      }).join('')||'<li>No matching members.</li>';
    }
    search.addEventListener('input',renderList);
    renderList();
  } catch(err) {
    if(panel.isConnected)status.textContent=err.message;
  }
}
function drawRoster(q){
  const list=data.roster.filter(x=>x.name.toLowerCase().includes(q.toLowerCase())||String(x.id).includes(q));
  document.getElementById('roster-list').innerHTML=list.map(x=>row('<b>'+esc(x.name)+'</b><br><small>#'+esc(x.id)+'</small>',x.id===data.me.id?badge('Owner'):btn(x.staff?'Remove staff':'Grant staff access','grant',x.id))).join('')||empty('No matching faction member.');
}
async function reloadScope(next){
  data=await api('profile?scope='+next);
  scope=next;tab=next==='staff'?'Active OCs':data.crimes.some(r=>r.phase!=='History'&&mine(r))?'My OCs':'Recruiting';filter='';draw();
}
document.addEventListener('input',e=>{
  const input=e.target;
  if(input.id==='member-search')drawRoster(input.value);
  if(input.form?.id!=='login'||input.name!=='key'||e.inputType!=='insertFromPaste')return;
  input.value=input.value.trim();
  if(input.validity.valid)input.form.requestSubmit();
});
document.addEventListener('change',async e=>{
  const input=e.target;
  if(input.name!=='rememberDevice'||input.form||!data||savingDevice)return;
  const id=data.me.id;
  savingDevice=input.disabled=true;
  try {
    const result=await api('device',{rememberDevice:input.checked});
    if(data?.me.id===id)data.rememberDevice=result.rememberDevice;
  } catch(err){msg(err.message);}
  finally {
    savingDevice=false;
    const current=app.querySelector('input[name="rememberDevice"]');
    if(current){current.disabled=false;if(data)current.checked=data.rememberDevice;}
  }
});
document.addEventListener('click',async e=>{
  const b=e.target.closest('[data-act]');if(!b)return;
  const {act,val}=b.dataset;
  try{
    if(act==='retry'){b.disabled=true;await openPortal();return;}
    if(act==='copy-fingerprint'){
      const field=document.getElementById('owner-fingerprint');
      const status=document.getElementById('copy-status');
      try {
        await navigator.clipboard.writeText(field.value);
        status.textContent='Fingerprint copied.';
      } catch {
        field.focus();
        field.select();
        field.setSelectionRange(0,field.value.length);
        status.textContent='The fingerprint is selected. Tap Copy.';
      }
    }
    if(act==='out'){await api('logout',{});data=null;scope='member';document.getElementById('foot').textContent='Faction operations';showGate();}
    if(act==='scope')await reloadScope(val);
    if(act==='tab'){tab=val;filter='';draw();}
    if(act==='filter'){filter=val;draw();}
    if(act==='grant'){const person=data.roster.find(x=>x.id===Number(val));if(!person)return;const grant=!person.staff;
      await api('staff',{id:person.id,grant});
      data=await api('profile?scope=staff');
      drawRoster(document.getElementById('member-search').value);msg((grant?'Granted staff access to ':'Removed staff access from ')+person.name+'.');}
  }catch(err){msg(err.message);}
});
document.addEventListener('submit',async e=>{
  const form=e.target;
  if(form.id==='sync-cpr'){
    e.preventDefault();
    const button=form.querySelector('button'),status=form.querySelector('[role="status"]');
    if(button.disabled)return;
    button.disabled=true;
    status.textContent='Checking your open roles in Torn…';
    const key=form.elements.key.value.trim();
    form.elements.key.value='';
    const memberId=data.me.id;
    try{
      await api('recruiting/sync',{key});
      const refreshed=await api('profile?scope=member');
      if(data?.me.id===memberId && scope==='member'){
        data=refreshed;draw();
        if(tab==='Recruiting')msg('Your CPR and qualifying openings are up to date.');
      }
    }catch(err){status.textContent=err.message;}
    finally{button.disabled=false;}
    return;
  }
  if(form.id!=='login')return;
  e.preventDefault();
  const input=form.elements.key, button=form.querySelector('[type="submit"]');
  if(button.disabled)return;
  const key=input.value.trim();
  input.value='';
  input.disabled=button.disabled=true;
  button.textContent='Signing in…';
  document.getElementById('owner-pairing').hidden=true;
  document.getElementById('owner-fingerprint').value='';
  document.getElementById('copy-status').textContent='';
  msg('');
  try{
    await api('login',{key,rememberDevice:form.elements.rememberDevice.checked});
    await reloadScope('member');
  }catch(err){
    msg(err.message);
    if(err.code==='owner_key_pairing'){
      try { await showOwnerPairing(key); }
      catch { msg('Torn verified your owner account. Open this page in Safari or Chrome to copy the fingerprint for your replacement key.'); }
    }
    input.disabled=button.disabled=false;
    button.textContent='Open my profile';
    if(document.getElementById('owner-pairing').hidden)input.focus();
    else document.querySelector('[data-act="copy-fingerprint"]').focus();
  }
});
document.getElementById('brand').addEventListener('click',async e=>{e.preventDefault();if(data)try{await reloadScope('member');}catch(err){msg(err.message);}});
async function openPortal(){
  error='';
  if(!window.OC_OFFLINE && ['http:','https:'].includes(location.protocol)){
    try{
      const config=await api('config');
      live=config.live;
      if(live){await reloadScope('member');return;}
      if(config.missing?.length)error='The site owner needs to restore '+config.missing.join(', ')+' in Cloudflare.';
    }catch(err){if(err.code==='membership_pending')return;if(err.status!==401||err.code==='membership_recheck')error=err.message;}
  }
  showGate();if(error)msg(error);
}
openPortal();
