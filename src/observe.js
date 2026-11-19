// All stored times are Unix seconds. Each record belongs to one Torn OC.
const HOUR = 3600;
const MAX_SAMPLE_GAP = 450; // Five-minute polls with scheduling and network jitter.
const TERMINAL = new Set(['Successful', 'Failure', 'Expired']);
const STATES = { Abroad: 'Abroad', Traveling: 'Travelling', Jail: 'Jail', Hospital: 'Hospital', Federal: 'Federal jail' };
const validCash = n => Number.isSafeInteger(n) && n >= 0;
const validBalance = n => Number.isSafeInteger(n);
const nowSec = () => Math.floor(Date.now() / 1000);
function people(crime, members) {
  return (crime.slots || []).filter(s => s.user?.id).map(s => ({
    id: s.user.id, name: members.get(s.user.id)?.name || String(s.user.id),
    role: s.position_info?.label || s.position
  }));
}
function sample(crime, members, at) {
  const ready = crime.ready_at;
  const slots = crime.slots || [];
  const result = { due: false, blockers: {}, unknown: '', ready };
  if (crime.status !== 'Planning' || !Number.isInteger(ready) || ready > at || !slots.length) return result;
  result.due = true;
  if (slots.some(s => !s.user || typeof s.user.progress !== 'number' || s.user.progress < 100)) {
    result.unknown = 'Role empty or planning incomplete. No individual attribution.';
    return result;
  }
  const unavailable = [];
  for (const slot of slots) {
    const id = slot.user.id, member = members.get(id), state = member?.status?.state;
    const reasons = [];
    if (Object.hasOwn(STATES, state)) reasons.push(STATES[state]);
    if (slot.item_requirement?.is_available === false) reasons.push('Missing item #' + slot.item_requirement.id);
    if (reasons.length) result.blockers[id] = { name: member?.name || String(id), role: slot.position_info?.label || slot.position, reason: reasons.join(' + ') };
    if (!state || (!Object.hasOwn(STATES, state) && state !== 'Okay')) unavailable.push(member?.name || String(id));
  }
  if (unavailable.length) result.unknown = 'Status unverified for ' + unavailable.join(', ');
  else if (!Object.keys(result.blockers).length) result.unknown = 'Awaiting execution. No verified member blocker.';
  return result;
}
function startRecord(c) {
  return { id:c.id, name:c.name, status:c.status, ready:null, executed:null, last:0, participants:[],
    blocks:{}, unknown:[], observed:0, seen:0, prev:null, lastBalances:{}, payoutEvidence:{}, rewards:null,
    nextCheck:0, teamAlert:null };
}
function extend(runs, start, end, reason, role) {
  const prior = runs.at(-1);
  if (prior && prior.end === start && prior.reason === reason && prior.role === role) prior.end = end;
  else runs.push({ start, end, reason, role });
}
function observe(rec, c, members, balances, at) {
  if (at <= rec.last || (TERMINAL.has(rec.status) && !TERMINAL.has(c.status))) return rec;
  const before = rec.prev, snap = sample(c,members,at);
  const oldTime = rec.last;
  const joined = people(c,members);
  const cont = before?.due && snap.due && before.ready === snap.ready && at - oldTime <= MAX_SAMPLE_GAP;
  rec.level = Number.isInteger(c.difficulty) ? c.difficulty : rec.level ?? null;
  rec.expires = c.expired_at ?? rec.expires ?? null;
  rec.slots = (c.slots || []).map(s => ({
    role: s.position_info?.label || s.position,
    member: s.user?.id || null, cpr: s.user?.id ? s.checkpoint_pass_rate ?? null : null,
    item: s.item_requirement?.id || null, available: s.item_requirement?.is_available ?? null
  }));
  rec.planningPauses ||= [];
  const occupied = (c.slots || []).filter(s => s.user);
  const stalled = c.status === 'Recruiting' && occupied.length > 0 &&
    occupied.length < c.slots.length && occupied.every(s => s.user.progress === 100);
  if (stalled) extend(rec.planningPauses, rec.wasStalled && at-oldTime <= MAX_SAMPLE_GAP ? oldTime : at, at, 'Waiting for next role', '');
  rec.wasStalled = stalled;
  rec.name = c.name;
  rec.status = c.status;
  rec.ready = c.ready_at ?? rec.ready;
  rec.executed = c.executed_at ?? rec.executed;
  if (joined.length) rec.participants = joined.map(p => ({...p,name:members.get(p.id)?.name || rec.participants.find(q=>q.id===p.id)?.name || p.name}));
  if (snap.due) {
    rec.seen ||= at;
    const sameMember = Object.keys(snap.blockers).some(id=>before?.blockers?.[id]);
    if (cont && sameMember) rec.observed += at-oldTime;
    if (snap.unknown) extend(rec.unknown, cont && snap.unknown===before.unknown ? oldTime : at, at, snap.unknown, '');
    for (const [id,b] of Object.entries(snap.blockers)) {
      const m = rec.blocks[id] ||= { name:b.name, runs:[], spans:[], longest:0, qualified:0 };
      m.name = b.name;
      const held = cont && before.blockers[id];
      const span = m.spans.at(-1);
      if (held && span?.end===oldTime) span.end = at;
      else m.spans.push({start:at,end:at});
      const active = m.spans.at(-1);
      m.longest = Math.max(m.longest,active.end-active.start);
      if (m.longest > HOUR && !m.qualified) m.qualified=at;
      const sameReason = held && before.blockers[id].reason===b.reason && before.blockers[id].role===b.role;
      extend(m.runs,sameReason ? oldTime : at,at,b.reason,b.role);
    }
    if (at-snap.ready>HOUR && !rec.teamAlert) {
      rec.teamAlert={ at, overdue:at-snap.ready, blockers:Object.values(snap.blockers), unknown:snap.unknown, participants:rec.participants.map(p=>({...p})) };
    }
  }
  rec.prev=snap;
  rec.last=at;
  rec.nextCheck=c.status==='Successful' && !rec.rewards?.payout ? at+1800 : 0;
  return rec;
}
function dueElapsed(r) {
  const end=r.executed || (!TERMINAL.has(r.status) && r.prev?.due ? r.last : null);
  return r.ready && end ? Math.max(0,end-r.ready) : null;
}

export { startRecord, observe, dueElapsed };
