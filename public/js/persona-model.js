/* One reducer for the native bridge, standalone preview and story adapters.
 * Narrative hours are explicit. Browser/wall-clock time never ages a character.
 */
(function(root){
  'use strict';
  const clone=x=>JSON.parse(JSON.stringify(x));
  const groups={instincts:['食','眠','色','御','执'],emotions:['喜','怒','哀','惧','爱','恶','欲'],axes:['外放','内敛','共生','独占','通透','戒备','直觉','迂回'],desires:['求安','求享','求亲','求认','求胜','求知']};
  const paths=[...['instincts','emotions','axes'].flatMap(g=>groups[g].map(k=>g+'.'+k)),...groups.desires.flatMap(k=>['light','shadow'].map(s=>'desires.'+k+'.'+s))];
  const labels={食:'吃些东西',眠:'休息一会',色:'寻求亲密',御:'确认周围安全',执:'靠近心中所系',求安:'寻求安定',求享:'享受片刻',求亲:'主动亲近',求认:'寻求认可',求胜:'争取胜利',求知:'探究疑问'};
  function initial(raw={}) {
    const d={version:1,values:{},rates:{},importance:{},threshold:85,release:65,daily:[],plans:[],statuses:[],armed:{},events:[],elapsedHours:0,target:'',...clone(raw)};
    for(const p of paths)if(!(p in d.values))d.values[p]=null;
    return d;
  }
  function number(v,label,nullable=true,min=0,max=100){
    if(v===null&&nullable)return null;
    if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw Error(label+'必须是 '+min+'–'+max+' 的有限数值'+(nullable?'，或 null':''));
    return v;
  }
  function validate(d){
    for(const [p,v] of Object.entries(d.values)){if(!paths.includes(p))throw Error('未知心性槽：'+p);number(v,p);}
    for(const [p,v] of Object.entries(d.rates)){if(!paths.includes(p))throw Error('未知增长槽：'+p);number(v,p+'每叙事小时变化',false,-100,100);}
    for(const [k,v] of Object.entries(d.importance)){if(!groups.instincts.includes(k))throw Error('未知本能：'+k);number(v,k+'重要性');}
    number(d.threshold,'触发阈值',false,1);number(d.release,'解除阈值',false,0,99);
    if(d.release>=d.threshold)throw Error('解除阈值必须低于触发阈值');
    for(const k of ['daily','plans','statuses','events'])if(!Array.isArray(d[k]))throw Error(k+'必须是数组');
    return d;
  }
  function reduce(raw,event){
    const d=validate(initial(raw));
    if(!event||typeof event.id!=='string'||!event.id.trim())throw Error('心性事件缺少唯一 id');
    if(d.events.includes(event.id))return d;
    if(event.kind==='configure'){
      for(const k of ['values','rates','importance'])if(event[k])Object.assign(d[k],clone(event[k]));
      for(const k of ['threshold','release','target'])if(k in event)d[k]=event[k];
      validate(d);
    } else if(event.kind==='tick'){
      number(event.hours,'叙事时间增量',false,0,8760);
      for(const [p,rate] of Object.entries(d.rates))if(d.values[p]!==null)d.values[p]=Math.round(Math.max(0,Math.min(100,d.values[p]+rate*event.hours))*100)/100;
      d.elapsedHours+=event.hours;
    } else if(event.kind==='delta'){
      for(const [p,delta] of Object.entries(event.deltas||{})){
        if(!paths.includes(p))throw Error('未知心性槽：'+p);
        number(delta,p+'变化',false,-100,100);
        if(d.values[p]===null)throw Error(p+'尚未登记，不能以零代替');
        d.values[p]=Math.max(0,Math.min(100,d.values[p]+delta));
      }
    } else if(event.kind==='resolve'){
      const item=[...d.daily,...d.plans].find(x=>x.id===event.itemId);
      if(!item)throw Error('未找到日常或计划');
      if(!['completed','dismissed'].includes(event.status))throw Error('未识别的处理结果');
      item.status=event.status;item.resolvedBy=event.id;
      // Completion does not infer satiation. A separate evidence-backed delta is required.
    } else throw Error('未识别的心性事件类型');
    for(const p of paths.filter(p=>p.startsWith('instincts.')||p.startsWith('desires.'))){
      const value=d.values[p],[,name,side]=p.split('.');
      if(value===null)continue;
      if(value<=d.release){d.armed[p]=true;d.statuses=d.statuses.filter(x=>x.source!==p);}
      if(value>=d.threshold){
        if(!d.statuses.some(x=>x.source===p))d.statuses.push({source:p,name:name+(side==='shadow'?' · 影端':'')+'高涨'});
        const collection=p.startsWith('instincts.')?d.daily:d.plans;
        if(d.armed[p]!==false&&!collection.some(x=>x.source===p&&x.status==='pending')){
          collection.push({id:event.id+':'+p,source:p,title:labels[name]+(side==='shadow'?' · 影向':''),status:'pending',origin:'threshold',triggerValue:value,eventId:event.id});
        }
        d.armed[p]=false;
      }
    }
    d.events.push(event.id);
    return d;
  }
  const api={groups,paths,initial,reduce,validate};
  root.TisyaPersonaModel=api;
  if(typeof module!=='undefined')module.exports=api;
  if(typeof require!=='undefined'&&require.main===module){
    try{const x=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(reduce(x.state,x.event)));}
    catch(e){process.stderr.write(e.message);process.exitCode=1;}
  }
})(globalThis);
