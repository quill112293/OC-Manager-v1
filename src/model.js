const finished = new Set(['Successful', 'Failure', 'Failed', 'Expired', 'Cancelled']);
export function phase(r, at) {
  if (finished.has(r.status)) return 'History';
  if (r.status === 'Planning' && r.ready && r.ready <= at) return 'Executable';
  return r.status;
}
// Observations are bounded by the poller. A gap in the feed cannot establish a cause.
export function timeline(r) {
  const start = r.ready, end = r.executed || (r.prev?.due ? r.last : null);
  if (!start || !end || end <= start) return [];
  const events = Object.entries(r.blocks || {}).flatMap(([id, b]) =>
    b.runs.map(run => ({...run, id: Number(id), name: b.name})));
  const waits = (r.unknown || []).filter(x => x.reason.startsWith('Awaiting execution'));
  const bounds = [...new Set([start, end, ...[...events, ...waits].flatMap(x=>[x.start,x.end])
    .filter(t=>t>start && t<end)])].sort((a,b)=>a-b);
  const spans = [];
  let incumbent = null;
  for (let i=1; i<bounds.length; i++) {
    const from=bounds[i-1], to=bounds[i];
    const blocked=events.filter(x=>x.start<=from && x.end>=to).sort((a,b)=>a.start-b.start);
    const first=blocked.find(x=>x.id===incumbent) ||
      (blocked.length && (!blocked[1] || blocked[0].start<blocked[1].start) ? blocked[0] : null);
    incumbent=first?.id ?? null;
    const reason=first?.reason || (blocked.length ? 'Concurrent causes · needs review' :
      waits.some(x=>x.start<=from && x.end>=to) ? 'Awaiting execution' : 'Timing unverified');
    const prev=spans.at(-1);
    if (prev && prev.id===incumbent && prev.reason===reason) prev.end=to;
    else spans.push({id:incumbent,name:first?.name || '',start:from,end:to,reason});
  }
  return spans;
}
export function eligibility(level, cpr, weight) {
  if (Number.isInteger(level) && level>=1 && level<=2) return 'Eligible';
  if (!Number.isInteger(level) || level<1 || !Number.isFinite(cpr) || !Number.isFinite(weight)) return 'Verify in Torn';
  return cpr>=60 && weight<=7 ? 'Eligible' : 'Outside requirements';
}
export function present(r) {
  return {id:r.id,name:r.name,level:r.level??null,phase:phase(r,r.last),status:r.status,
    ready:r.ready,executed:r.executed,updated:r.last,participants:r.participants||[],
    slots:r.slots||[],spans:timeline(r),pauses:r.planningPauses||[],
    events:Object.entries(r.blocks||{}).flatMap(([,b])=>b.runs.map(s=>({at:s.start,label:b.name+' observed · '+s.reason}))).sort((a,b)=>a.at-b.at),
    blockers:Object.entries(r.blocks||{}).map(([id,b])=>({id:Number(id),name:b.name,reasons:[...new Set(b.runs.map(x=>x.reason))]}))};
}
