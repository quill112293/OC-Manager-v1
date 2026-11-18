// Fictional review records. All times are fixed so the review remains reproducible.
window.ocSample = function sample() {
  const base=Date.UTC(2026,10,18,18)/1000, ago=base-86400;
  const crew=[{id:101,name:'Aaron',role:'Enforcer'},{id:102,name:'Noor',role:'Muscle'},{id:103,name:'Mika',role:'Driver'}];
  const rec=(id,name,level,phase,status,extra={})=>({id,name,level,phase,status,ready:null,executed:null,updated:base,
    slots:[],participants:[],blockers:[],spans:[],pauses:[],...extra});
  function opening(role,profileCPR,weight){return {role,member:null,profileCPR,weight};}
  return {me:{id:101,name:'Aaron',owner:true,staff:true},updated:base,roster:[{id:101,name:'Aaron',staff:true},{id:102,name:'Noor',staff:false},{id:103,name:'Mika',staff:false}],
    crimes:[
      rec(4071,'Honey Trap',3,'Planning','Planning',{ready:base+7200,participants:crew,slots:[{role:'Enforcer',member:101,cpr:72,item:1,itemName:'Billfold',available:false},{role:'Muscle',member:102,cpr:70},{role:'Driver',member:103,cpr:65}]}),
      rec(4074,'Pet Project',1,'Recruiting','Recruiting',{slots:[opening('Lookout',54,9),opening('Driver',68,6)]}),
      rec(4079,'Cash Me if You Can',3,'Recruiting','Recruiting',{slots:[opening('Collector',74,6),opening('Driver',58,8)]}),
      rec(4068,'Smoke and Wing Mirrors',4,'Executable','Planning',{ready:base-300,participants:[crew[2]],slots:[{member:103,role:'Driver'}],spans:[{start:base-300,end:base,reason:'Awaiting execution',id:null,name:''}]}),
      rec(4036,'Honey Trap',3,'History','Successful',{ready:ago,executed:ago+65*60,participants:crew,blockers:[{id:101,name:'Aaron',reasons:['Travelling']},{id:102,name:'Noor',reasons:['Travelling']}],
        spans:[{start:ago,end:ago+1080,id:101,name:'Aaron',reason:'Travelling'},{start:ago+1080,end:ago+3600,id:102,name:'Noor',reason:'Travelling'},{start:ago+3600,end:ago+3900,id:null,name:'',reason:'Awaiting execution'}],
        events:[{at:ago+900,label:'Noor departs while Aaron is away'}]}),
      rec(4021,'Pet Project',1,'History','Successful',{ready:ago-86400,executed:ago-86400,participants:[crew[0],crew[2]]}),
      rec(4016,'Market Forces',4,'History','Failure',{ready:ago-172800,executed:ago-172200,participants:[crew[1],crew[2]],blockers:[{id:102,name:'Noor',reasons:['Abroad']}],spans:[{start:ago-172800,end:ago-172200,id:102,name:'Noor',reason:'Abroad'}]})
    ]};
};
