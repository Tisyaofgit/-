/** Deterministic workbook calculation runtime. No eval, network, or host writes. */
import {createHash} from 'node:crypto';
export class MechanicalError extends Error {
  constructor(code,message,details={}){super(message);this.name='MechanicalError';this.code=code;this.details=details;}
  toJSON(){return {code:this.code,message:this.message,details:this.details};}
}
const fail=(code,message,details)=>{throw new MechanicalError(code,message,details);};
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o??{},k);
const blank=v=>v===null||v===undefined||v==='';
const missing=(v,label)=>blank(v)?fail('MISSING_INPUT',`Missing input: ${label}`,{label}):v;
function num(v,label='number'){missing(v,label);if(typeof v!=='number'||!Number.isFinite(v))fail('TYPE_NUMBER',`${label} must be a finite number`,{label,value:v});return v;}
function integer(v,label='integer'){num(v,label);if(!Number.isSafeInteger(v))fail('TYPE_INTEGER',`${label} must be a safe integer`,{label,value:v});return v;}
function positive(v,label){num(v,label);if(v<=0)fail('POSITIVE_REQUIRED',`${label} must be positive`,{label,value:v});return v;}
function positiveInteger(v,label){integer(v,label);return positive(v,label);}
function bool(v,label='boolean'){if(typeof v!=='boolean')fail('TYPE_BOOLEAN',`${label} must be boolean`,{label,value:v});return v;}
function list(v,label='list'){if(!Array.isArray(v))fail('TYPE_ARRAY',`${label} must be an array`,{label});return v;}
function finite(v){if(!Number.isFinite(v))fail('NUMERIC_OVERFLOW','Calculation result is not finite');return Object.is(v,-0)?0:v;}
function decimalShift(value,digits){const [mantissa,exponent='0']=String(value).split('e');return Number(`${mantissa}e${Number(exponent)+digits}`);}
function nonemptyNumbers(v,label){list(v,label);if(!v.length)fail('EMPTY_LIST',`${label} must contain at least one number`);return v.map((x,i)=>num(x,`${label}[${i}]`));}
function mod(a,b){return ((a%b)+b)%b;}
function jsonEqual(a,b){if(typeof a!==typeof b)return false;if(a===b)return true;if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((v,i)=>jsonEqual(v,b[i]));return false;}
function dataEqual(a,b){if(jsonEqual(a,b))return true;if(a&&b&&typeof a==='object'&&typeof b==='object'&&!Array.isArray(a)&&!Array.isArray(b)){const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>own(b,k)&&dataEqual(a[k],b[k]));}return false;}
function requireKey(v,label){if(typeof v!=='string'||!v.length)fail('MISSING_KEY',`${label} must be a nonempty string`,{label});return v;}
function resultPath(value,path){if(blank(path))return value;const parts=String(path).split('.');let at=value;for(const part of parts){if(['__proto__','prototype','constructor'].includes(part)||!own(at,part))fail('RESULT_PATH','Result field is absent',{path});at=at[part];}return at;}
function identifier(row){return row.row_uuid??row.id;}
function fieldValue(row,key){if(row.__record_state==='template')fail('TEMPLATE_RECORD','Template slots are not active business records',{row_uuid:identifier(row)});const state=row.__value_states?.[key];if(state&&!['known','已知','已确认','有值'].includes(state))fail('VALUE_STATE','Referenced value is not known',{row_uuid:identifier(row),field_key:key,state});if(!own(row,key))fail('MISSING_FIELD','Referenced field is absent',{row_uuid:identifier(row),field_key:key});return missing(row[key],key);}

export function normalizeTables(payload){
  const out={};
  for(const [id,rows] of Object.entries(payload.tables??{})){
    list(rows,id);out[id]=rows.map(row=>row.values?{...row.values,row_uuid:row.row_uuid,__record_state:row.record_state??'active',__value_states:{...(row.value_states??{})},__cell_metadata:row.cell_metadata??{},__context:row._context??row.context??{},__children:row.children??{}}:{...row,__value_states:{...(row.__value_states??{})}});
  }
  for(const [id,rows] of Object.entries(payload.child_tables??{})){
    if(own(out,id))fail('DUPLICATE_TABLE','Table occurs in both tables and child_tables',{table_id:id});
    out[id]=list(rows,id).map(x=>({...x,__value_states:{...(x.__value_states??{})}}));
  }
  for(const [table,rows] of Object.entries(out)){
    const seen=new Set();for(const row of rows){const id=identifier(row);if(blank(id))continue;if(seen.has(id))fail('DUPLICATE_KEY','Duplicate record identity',{table_id:table,row_uuid:id});seen.add(id);}
  }
  return out;
}

export function resolveCell(tables,coordinate){
  const {table_id,row_uuid,field_key}=coordinate;
  requireKey(table_id,'table_id');requireKey(row_uuid,'row_uuid');requireKey(field_key,'field_key');
  if(!own(tables,table_id))fail('MISSING_TABLE','Referenced table is absent',{table_id});
  const matches=tables[table_id].filter(r=>identifier(r)===row_uuid);
  if(matches.length!==1)fail(matches.length?'DUPLICATE_KEY':'BROKEN_REFERENCE','Reference must resolve to exactly one record',coordinate);
  return fieldValue(matches[0],field_key);
}

export function findChildren(tables,tableId,foreignKey,parentId){
  if(!own(tables,tableId))fail('MISSING_TABLE','Child table is absent',{table_id:tableId});
  requireKey(foreignKey,'foreign_key');missing(parentId,'parent_id');
  return tables[tableId].filter(row=>row[foreignKey]===parentId).map(row=>({...row}));
}

/** Relation definitions explicitly distinguish traversal from ordinary cyclic references. */
export function nestRecords(tables,rootTable,relations){
  if(!own(tables,rootTable))fail('MISSING_TABLE','Root table is absent',{table_id:rootTable});
  const byParent=new Map();
  for(const rel of list(relations,'relations')){
    for(const k of ['parent_table','child_table','foreign_key','output_field'])requireKey(rel[k],k);
    if(!['many','one'].includes(rel.cardinality))fail('CARDINALITY','Relation cardinality must be one or many',rel);
    if(!own(tables,rel.parent_table)||!own(tables,rel.child_table))fail('MISSING_TABLE','Relation table is absent',rel);
    if(!byParent.has(rel.parent_table))byParent.set(rel.parent_table,[]);byParent.get(rel.parent_table).push(rel);
    const ids=new Set(tables[rel.parent_table].map(identifier));
    for(const child of tables[rel.child_table])if(!blank(child[rel.foreign_key])&&!ids.has(child[rel.foreign_key]))fail('BROKEN_REFERENCE','Child parent reference is absent',{table_id:rel.child_table,row_uuid:identifier(child),foreign_key:rel.foreign_key,value:child[rel.foreign_key]});
  }
  const visit=(table,row,trail)=>{
    const identity=JSON.stringify([table,identifier(row)]);if(trail.has(identity))fail('NESTING_CYCLE','Nested relation contains a record cycle',{identity});
    const next=new Set(trail);next.add(identity);const out={...row};delete out.__value_states;
    for(const rel of byParent.get(table)??[]){
      if(own(out,rel.output_field))fail('FIELD_COLLISION','Nested output would overwrite an existing field',rel);
      const children=tables[rel.child_table].filter(c=>c[rel.foreign_key]===identifier(row));
      if(rel.cardinality==='one'&&children.length>1)fail('CARDINALITY','One-to-one relation has multiple child records',{...rel,parent_id:identifier(row)});
      for(const child of children)for(const key of rel.scope_fields??[])if(child[key]!==row[key])fail('SCOPE_MISMATCH','Nested child crosses a required scope',{field_key:key,parent_id:identifier(row),child_id:identifier(child)});
      if(rel.required&&children.length===0)fail('MISSING_CHILD','Required child record is absent',{...rel,parent_id:identifier(row)});
      const values=children.map(c=>visit(rel.child_table,c,next));out[rel.output_field]=rel.cardinality==='many'?values:(values[0]??null);
    }return out;
  };
  return tables[rootTable].map(r=>visit(rootTable,r,new Set()));
}

function arity(args,min,max=min){if(args.length<min||args.length>max)fail('ARITY','Operator argument count is invalid',{actual:args.length,min,max});}
const exprOps={
 ADD:a=>{arity(a,2,Infinity);return finite(a.reduce((s,x)=>s+num(x),0));},
 SUBTRACT:a=>{arity(a,2);return finite(num(a[0])-num(a[1]));},
 MULTIPLY:a=>{arity(a,2,Infinity);return finite(a.reduce((s,x)=>s*num(x),1));},
 DIVIDE:a=>{arity(a,2);const d=num(a[1]);if(d===0)fail('DIVIDE_BY_ZERO','Division denominator is zero');return finite(num(a[0])/d);},
 MODULO:a=>{arity(a,2);const d=num(a[1]);if(d===0)fail('DIVIDE_BY_ZERO','Modulo denominator is zero');return finite(mod(num(a[0]),d));},
 MIN:a=>{arity(a,1,Infinity);return Math.min(...a.map(x=>num(x)));},MAX:a=>{arity(a,1,Infinity);return Math.max(...a.map(x=>num(x)));},
 ABS:a=>{arity(a,1);return Math.abs(num(a[0]));},FLOOR:a=>{arity(a,1);return Math.floor(num(a[0]));},CEIL:a=>{arity(a,1);return Math.ceil(num(a[0]));},
  ROUND:a=>{arity(a,2);const x=num(a[0]),digits=integer(a[1],'digits');if(Math.abs(digits)>12)fail('ROUND_PRECISION','Supported decimal digits are -12..12');const shifted=decimalShift(Math.abs(x),digits);return finite(Math.sign(x)*decimalShift(Math.floor(shifted+0.5),-digits));},
 POWER:a=>{arity(a,2);return finite(num(a[0])**num(a[1]));},
 EQUAL:a=>{arity(a,2);return jsonEqual(a[0],a[1]);},NOT_EQUAL:a=>{arity(a,2);return !jsonEqual(a[0],a[1]);},
 GT:a=>{arity(a,2);return num(a[0])>num(a[1]);},GTE:a=>{arity(a,2);return num(a[0])>=num(a[1]);},LT:a=>{arity(a,2);return num(a[0])<num(a[1]);},LTE:a=>{arity(a,2);return num(a[0])<=num(a[1]);},
 NOT:a=>{arity(a,1);return !bool(a[0]);},
 IN:a=>{arity(a,2);return list(a[1]).some(x=>jsonEqual(x,a[0]));},SUM:a=>{arity(a,1);return finite(nonemptyNumbers(a[0],'values').reduce((s,x)=>s+x,0));},
};

export function evaluateExpression(node,context={},ancestors=new Set()){
  if(!node||typeof node!=='object'||Array.isArray(node))fail('AST_NODE','Expression node must be an object');
  if(ancestors.has(node))fail('EXPRESSION_CYCLE','Expression AST contains a cycle');
  const stack=new Set(ancestors);stack.add(node);
  if(node.kind==='literal')return missing(node.value,'literal');
  if(node.kind==='param'){
    requireKey(node.key,'parameter key');if(own(context.parameters,node.key))return missing(context.parameters[node.key],node.key);
    const definitions=(context.parameter_bindings??[]).filter(d=>d.parameter_key===node.key);if(definitions.length===0)fail('MISSING_PARAMETER','Parameter is absent',{key:node.key});if(definitions.length>1)fail('DUPLICATE_PARAMETER_DEFINITION','Parameter key has more than one definition',{key:node.key});
    const d=definitions[0],common=['__COMMON__','@COMMON'].includes(d.table_id),table=common?(node.source_table??context.active_owner?.owner_table):d.table_id;
    if(!table)fail('MISSING_PARAMETER_CONTEXT','Common parameter requires a source table or owner context',{key:node.key});if(node.source_table&&!common&&node.source_table!==table)fail('PARAMETER_TABLE_MISMATCH','Selected table differs from registered parameter table');
    let rowId=node.source_row_uuid??(context.active_owner?.owner_table===table?context.active_owner.owner_row_uuid:undefined);
    if(!rowId){const rows=(context.tables?.[table]??[]).filter(r=>r.__record_state!=='template');if(rows.length>1)fail('AMBIGUOUS_PARAMETER_ROW','Parameter table contains multiple active records; select source_row_uuid',{key:node.key,table_id:table});if(rows.length!==1)fail('MISSING_PARAMETER_CONTEXT','No active record supplies this parameter',{key:node.key,table_id:table});rowId=rows[0].row_uuid;}
    try{return resultPath(resolveCell(context.tables??{},{table_id:table,row_uuid:rowId,field_key:d.field_key}),node.result_path);}
    catch(error){if(error instanceof MechanicalError&&(error.code==='MISSING_FIELD'||error.code==='MISSING_INPUT'||(error.code==='VALUE_STATE'&&['unset','none','cleared','not_applicable'].includes(error.details?.state))))fail('MISSING_PARAMETER','Registered parameter has no present value',{key:node.key,table_id:table,row_uuid:rowId,field_key:d.field_key,state:error.details?.state??'unset'});throw error;}
  }
  if(node.kind==='cell')return resultPath(resolveCell(context.tables??{},node),node.result_path??node.value_path);
  if(node.kind==='step'){
    if(!own(context.steps,node.step_id))fail('MISSING_STEP','Step result is absent',{step_id:node.step_id});
    return missing(resultPath(context.steps[node.step_id],node.result_path),'step result');
  }
  if(node.kind!=='op')fail('AST_KIND','Unsupported expression node kind',{kind:node.kind});
  const args=list(node.args,'args');
  if(node.operator==='IF'){arity(args,3);return evaluateExpression(bool(evaluateExpression(args[0],context,stack))?args[1]:args[2],context,stack);}
  if(node.operator==='AND'||node.operator==='OR'){
    arity(args,1,Infinity);for(const arg of args){const v=bool(evaluateExpression(arg,context,stack));if(node.operator==='AND'&&!v)return false;if(node.operator==='OR'&&v)return true;}return node.operator==='AND';
  }
  if(!own(exprOps,node.operator))fail('UNSUPPORTED_OPERATOR','Expression operator is not registered',{operator:node.operator});
  return exprOps[node.operator](args.map(x=>evaluateExpression(x,context,stack)));
}

export function convertUnit(value,from,to,dimension,ratios,scope={}){
  num(value,'value');requireKey(from,'from_unit');requireKey(to,'to_unit');requireKey(dimension,'dimension');
  const registered=list(ratios,'unit ratios');
  const candidates=registered.filter(r=>r.from_unit===from&&r.to_unit===to&&(['calendar_ref','scope_world_id'].every(k=>blank(scope[k])||r[k]===scope[k])));
  if(candidates.length>1)fail('DUPLICATE_CONVERSION','Multiple conversion definitions match',{from,to});
  if(candidates.length===0){
    if(from===to){
      const identitySources=registered.filter(r=>r.dimension===dimension&&(r.from_unit===from||r.to_unit===from)&&['calendar_ref','scope_world_id'].every(k=>blank(scope[k])||r[k]===scope[k]));
      if(identitySources.length){for(const r of identitySources){if(r.value_state&&r.value_state!=='known')fail('VALUE_STATE','Identity conversion source is not known',{state:r.value_state});for(const k of ['calendar_ref','scope_world_id'])if(!blank(r[k])&&blank(scope[k]))fail('UNIT_SCOPE_REQUIRED','Identity conversion requires explicit matching unit scope',{key:k});}return value;}
    }
    fail('MISSING_CONVERSION','No explicit direct conversion is registered',{from,to,dimension});
  }
  const r=candidates[0];if(r.value_state&&r.value_state!=='known')fail('VALUE_STATE','Conversion ratio is not known',{state:r.value_state});for(const k of ['calendar_ref','scope_world_id'])if(!blank(r[k])&&blank(scope[k]))fail('UNIT_SCOPE_REQUIRED','Scoped conversion requires explicit matching scope',{key:k});if(r.dimension!==dimension)fail('UNIT_DIMENSION','Conversion dimension differs',{expected:dimension,actual:r.dimension});
  const n=positive(r.numerator,'numerator'),d=positive(r.denominator,'denominator'),offset=num(r.offset,'offset');return finite(value*n/d+offset);
}

export function compileUnitRatios(tables){
  return (tables.M_UNIT_RATIOS??[]).map(row=>{
    const from=singleRecord(tables,'M_UNITS',requireKey(row.from_unit,'from_unit')),to=singleRecord(tables,'M_UNITS',requireKey(row.to_unit,'to_unit'));
    const dimensionOf=u=>u.dimension==='custom'?`custom:${requireKey(u.custom_dimension,'custom_dimension')}`:requireKey(u.dimension,'dimension');
    const dimension=dimensionOf(from);if(dimension!==dimensionOf(to))fail('UNIT_DIMENSION','Unit definitions have different dimensions',{from_unit:row.from_unit,to_unit:row.to_unit});
    const calendar_ref=from.calendar_ref??null;if((to.calendar_ref??null)!==calendar_ref)fail('CALENDAR_MISMATCH','Units belong to different calendars');
    if(dimension==='time'&&(!blank(from.time_component)||!blank(to.time_component))&&blank(calendar_ref))fail('MISSING_CALENDAR_SCOPE','Calendar-dependent time units require a bound calendar');
    if(!blank(row.calendar_ref)&&row.calendar_ref!==calendar_ref)fail('CALENDAR_MISMATCH','Ratio calendar disagrees with unit definitions');
    if(!blank(from.scope_world_id)&&!blank(to.scope_world_id)&&from.scope_world_id!==to.scope_world_id)fail('UNIT_SCOPE','Units belong to different worlds');
    const unitWorld=from.scope_world_id??to.scope_world_id??null;
    if(!blank(row.scope_world_id)&&!blank(unitWorld)&&row.scope_world_id!==unitWorld)fail('UNIT_SCOPE','Ratio world differs from unit world');
    const mode=requireKey(row.conversion_mode,'conversion_mode');let denominator,offset;
    if(mode==='LINEAR_FACTOR'){
      if(!blank(row.denominator)&&row.denominator!==1)fail('CONVERSION_MODE_CONFLICT','Linear-factor denominator is structurally 1');if(!blank(row.offset)&&row.offset!==0)fail('CONVERSION_MODE_CONFLICT','Linear-factor offset is structurally 0');denominator=1;offset=0;
    }else if(mode==='FRACTION'){
      if(!blank(row.offset)&&row.offset!==0)fail('CONVERSION_MODE_CONFLICT','Fraction conversion offset is structurally 0');denominator=row.denominator;offset=0;
    }else if(mode==='AFFINE'){denominator=row.denominator;offset=row.offset;}else fail('CONVERSION_MODE','Conversion mode is not registered',{mode});
    const result={...row,dimension,calendar_ref,scope_world_id:row.scope_world_id??unitWorld,denominator,offset};
    if(result.value_state==='known'){positive(result.numerator,'numerator');positive(result.denominator,'denominator');num(result.offset,'offset');}
    return result;
  });
}

function calendarConfig(c){
  if(!c||typeof c!=='object')fail('MISSING_CALENDAR','Calendar definition is absent');requireKey(c.calendar_id,'calendar_id');integer(c.epoch_year,'epoch_year');
  if(c.value_state&&!['known','已知','已确认'].includes(c.value_state))fail('VALUE_STATE','Calendar definition is not known',{state:c.value_state});
  if(!['astronomical','historical_no_zero'].includes(c.year_numbering))fail('NEED_CALENDAR_RULE','Year numbering requires an implemented calendar rule',{year_numbering:c.year_numbering});
  if(c.year_numbering==='historical_no_zero'&&c.epoch_year===0)fail('YEAR_ZERO','Historical year numbering has no year zero');
  const mode=c.mode??(c.month_lengths?.length?'MONTH_TABLE':'FIXED');if(!['FIXED','MONTH_TABLE','SEASON_FIXED'].includes(mode))fail('CALENDAR_MODE','Unsupported calendar mode',{mode});
  if(mode==='SEASON_FIXED'){
    for(const key of ['months_per_season','months_per_year','days_per_month'])if(!blank(c[key]))fail('CALENDAR_TOPOLOGY_CONFLICT','A season-day calendar must not contain month ratios',{key});
    if((c.month_lengths??[]).length||(c.leap_rules??[]).length)fail('CALENDAR_TOPOLOGY_CONFLICT','Month rows and month-based leap rules do not apply to SEASON_FIXED');
    const seasons=positiveInteger(c.seasons_per_year,'seasons_per_year'),days_per_season=positiveInteger(c.days_per_season,'days_per_season');
    const day_only=['hours_per_day','minutes_per_hour','ticks_per_minute'].every(k=>blank(c[k]));
    const hours=day_only?1:positiveInteger(c.hours_per_day,'hours_per_day'),minutes=day_only?1:positiveInteger(c.minutes_per_hour,'minutes_per_hour'),ticks=day_only?1:positiveInteger(c.ticks_per_minute,'ticks_per_minute');
    return {...c,mode,seasons,days_per_season,hours,minutes,ticks,day_only,tick_unit:day_only?'day':'configured_tick',rules:[],days:[integer(seasons*days_per_season,'days_per_year')],ticks_per_day:integer(hours*minutes*ticks,'ticks_per_day')};
  }
  let months;
  if(!blank(c.months_per_year))months=positiveInteger(c.months_per_year,'months_per_year');
  if(!blank(c.seasons_per_year)||!blank(c.months_per_season)){
    const product=positiveInteger(c.seasons_per_year,'seasons_per_year')*positiveInteger(c.months_per_season,'months_per_season');
    if(months!==undefined&&months!==product)fail('CALENDAR_RATIO_CONFLICT','Direct months_per_year differs from seasons multiplied by months_per_season');months=product;
  }
  positiveInteger(months,'months_per_year');
  const days=[];
  if(mode==='FIXED')for(let m=1;m<=months;m++)days.push(positiveInteger(c.days_per_month,'days_per_month'));
  else{
    const rows=list(c.month_lengths,'month_lengths');if(rows.length!==months)fail('CALENDAR_MONTHS','Month table must define every month exactly once',{expected:months,actual:rows.length});
    for(let m=1;m<=months;m++){
      const match=rows.filter(x=>x.month===m);if(match.length!==1)fail('CALENDAR_MONTHS','Month number is missing or duplicated',{month:m});days.push(positiveInteger(match[0].days,`month ${m} days`));
    }
  }
  const hours=positiveInteger(c.hours_per_day,'hours_per_day'),minutes=positiveInteger(c.minutes_per_hour,'minutes_per_hour'),ticks=positiveInteger(c.ticks_per_minute,'ticks_per_minute');
  const rules=(c.leap_rules??[]).map(r=>{
    requireKey(r.rule_id,'rule_id');positiveInteger(r.cycle_years,'cycle_years');integer(r.remainder,'remainder');integer(r.month,'month');integer(r.extra_days,'extra_days');
    if(r.remainder<0||r.remainder>=r.cycle_years||r.month<1||r.month>months)fail('CALENDAR_RULE','Invalid leap rule range',r);
    if(!blank(r.except_cycle_years))positiveInteger(r.except_cycle_years,'except_cycle_years');return {...r};
  });
  if(new Set(rules.map(r=>r.rule_id)).size!==rules.length)fail('DUPLICATE_KEY','Calendar exception rule IDs are duplicated');
  return {...c,mode,months,days,hours,minutes,ticks,rules,ticks_per_day:integer(hours*minutes*ticks,'ticks_per_day')};
}
function matchesYear(r,year){return mod(year,r.cycle_years)===r.remainder&&(blank(r.except_cycle_years)||mod(year,r.except_cycle_years)!==0);}
function monthDays(c,year,month){const days=c.days[month-1]+c.rules.filter(r=>r.month===month&&matchesYear(r,year)).reduce((s,r)=>s+r.extra_days,0);return positiveInteger(days,'effective month length');}
function yearDays(c,year){if(c.mode==='SEASON_FIXED')return integer(c.seasons*c.days_per_season,'days_per_year');let n=0;for(let m=1;m<=c.months;m++)n+=monthDays(c,year,m);return n;}
const yearOrdinal=(c,year)=>c.year_numbering==='historical_no_zero'?(year<0?year+1:year):year;
const yearLabel=(c,ordinal)=>c.year_numbering==='historical_no_zero'?(ordinal<=0?ordinal-1:ordinal):ordinal;

export function calendarToTick(calendar,date){
  const c=calendarConfig(calendar);if(date.calendar_ref&&date.calendar_ref!==c.calendar_id)fail('CALENDAR_MISMATCH','Date uses a different calendar');
  if(date.value_state&&date.value_state!=='known')fail('VALUE_STATE','Date is not known',{state:date.value_state});
  const precision=date.precision??date.time_precision;const ranks={day:0,date:0,hour:1,minute:2,tick:3};
  if(!own(ranks,precision))fail('TIME_PRECISION','Only explicit day/hour/minute/tick precision can be calculated',{precision});
  const rank=ranks[precision],year=integer(date.year,'year'),day=positiveInteger(date.day,'day');
  if(c.day_only&&rank>0)fail('TIME_PRECISION','Day-only calendar has no defined subday units',{precision});
  if(c.year_numbering==='historical_no_zero'&&year===0)fail('YEAR_ZERO','Historical year numbering has no year zero');
  let period,withinYear;
  if(c.mode==='SEASON_FIXED'){
    if(!blank(date.month))fail('CALENDAR_TOPOLOGY_CONFLICT','A season-day date must not invent a month');
    period=positiveInteger(date.season,'season');if(period>c.seasons||day>c.days_per_season)fail('INVALID_DATE','Day or season is outside the calendar',{year,season:period,day});
    withinYear=(period-1)*c.days_per_season+day-1;
  }else{
    period=positiveInteger(date.month,'month');if(period>c.months||day>monthDays(c,year,period))fail('INVALID_DATE','Day or month is outside the calendar',{year,month:period,day});
    if(!blank(date.season)){positiveInteger(date.season,'season');if(blank(c.months_per_season)||date.season!==Math.floor((period-1)/c.months_per_season)+1)fail('SEASON_MONTH_MISMATCH','Season and month do not match the registered calendar');}
    withinYear=day-1;for(let m=1;m<period;m++)withinYear+=monthDays(c,year,m);
  }
  const hour=rank>=1?integer(date.hour,'hour'):0,minute=rank>=2?integer(date.minute,'minute'):0,tick=rank>=3?integer(date.tick,'tick'):0;
  if(hour<0||hour>=c.hours||minute<0||minute>=c.minutes||tick<0||tick>=c.ticks)fail('INVALID_TIME','Time component is outside the calendar',{hour,minute,tick});
  if((rank<1&&!blank(date.hour)&&date.hour!==0)||(rank<2&&!blank(date.minute)&&date.minute!==0)||(rank<3&&!blank(date.tick)&&date.tick!==0))fail('TIME_PRECISION','Finer nonzero components conflict with declared precision');
  let totalDays=0;const yearIndex=yearOrdinal(c,year),epochIndex=yearOrdinal(c,c.epoch_year);
  if(!c.rules.length)totalDays=(yearIndex-epochIndex)*c.days.reduce((s,n)=>s+n,0);
  else{
    if(Math.abs(yearIndex-epochIndex)>100000)fail('CALENDAR_RANGE','Configured exception traversal supports at most 100000 years from epoch');
    for(let y=epochIndex;y<yearIndex;y++)totalDays+=yearDays(c,yearLabel(c,y));for(let y=yearIndex;y<epochIndex;y++)totalDays-=yearDays(c,yearLabel(c,y));
  }
  totalDays+=withinYear;
  const result=totalDays*c.ticks_per_day+hour*c.minutes*c.ticks+minute*c.ticks+tick;return integer(result,'calendar tick');
}

export function calendarDiff(calendar,from,to){
  const fp=from.precision??from.time_precision,tp=to.precision??to.time_precision;
  if(fp!==tp)fail('TIME_PRECISION_MISMATCH','Time difference requires the same explicit precision',{from:fp,to:tp});
  const c=calendarConfig(calendar),ticks=calendarToTick(c,to)-calendarToTick(c,from),unit=fp==='date'?'day':fp;
  const divisor={day:c.ticks_per_day,hour:c.minutes*c.ticks,minute:c.ticks,tick:1}[unit];
  return {value:finite(ticks/divisor),unit,ticks,calendar_ref:c.calendar_id,precision:fp};
}

export function calendarFromTick(calendar,value,precision='day'){
  const c=calendarConfig(calendar),total=integer(value,'calendar tick');
  const divisors={day:c.ticks_per_day,hour:c.minutes*c.ticks,minute:c.ticks,tick:1};
  if(!own(divisors,precision))fail('TIME_PRECISION','Only day/hour/minute/tick inverse precision is supported',{precision});
  if(c.day_only&&precision!=='day')fail('TIME_PRECISION','Day-only calendar has no defined subday units',{precision});
  if(total%divisors[precision]!==0)fail('TIME_PRECISION','Tick is not aligned to the requested precision',{precision,total});
  const totalDays=Math.floor(total/c.ticks_per_day),dayTick=mod(total,c.ticks_per_day),epochIndex=yearOrdinal(c,c.epoch_year);
  let yi=epochIndex,dayOfYear=totalDays;
  if(!c.rules.length){const length=yearDays(c,c.epoch_year),offset=Math.floor(totalDays/length);yi+=offset;dayOfYear=mod(totalDays,length);}
  else{
    let traversed=0;while(dayOfYear<0){yi--;dayOfYear+=yearDays(c,yearLabel(c,yi));if(++traversed>100000)fail('CALENDAR_RANGE','Inverse calendar traversal exceeds 100000 years');}
    while(dayOfYear>=yearDays(c,yearLabel(c,yi))){dayOfYear-=yearDays(c,yearLabel(c,yi));yi++;if(++traversed>100000)fail('CALENDAR_RANGE','Inverse calendar traversal exceeds 100000 years');}
  }
  const year=integer(yearLabel(c,yi),'year'),out={calendar_ref:c.calendar_id,year,precision,value_state:'known'};
  if(c.mode==='SEASON_FIXED'){out.season=Math.floor(dayOfYear/c.days_per_season)+1;out.day=dayOfYear%c.days_per_season+1;}
  else{let month=1;while(dayOfYear>=monthDays(c,year,month)){dayOfYear-=monthDays(c,year,month);month++;}out.month=month;out.day=dayOfYear+1;if(!blank(c.months_per_season))out.season=Math.floor((month-1)/c.months_per_season)+1;}
  if(['hour','minute','tick'].includes(precision))out.hour=Math.floor(dayTick/(c.minutes*c.ticks));
  if(['minute','tick'].includes(precision))out.minute=Math.floor(dayTick/c.ticks)%c.minutes;
  if(precision==='tick')out.tick=dayTick%c.ticks;
  return out;
}

export function calendarAddDays(calendar,date,delta){
  const c=calendarConfig(calendar),days=integer(delta,'delta days'),precision=date.precision??date.time_precision;
  return calendarFromTick(c,integer(calendarToTick(c,date)+days*c.ticks_per_day,'calendar tick'),precision==='date'?'day':precision);
}

// Generated signature snapshot from engine_contract.json; verified against that catalog in execution tests.
export const OPERATOR_SIGNATURES={"CLAMP_ADD":{"current":"NUMBER","delta":"NUMBER","minimum":"NUMBER","maximum":"NUMBER"},"COST_CHECK":{"available":"NUMBER","required":"NUMBER","policy":"ENUM"},"MUL_CHAIN":{"values":"ARRAY"},"ROLL_D100_TABLE":{"roll":"INTEGER","ranges":"DERIVED"},"THRESHOLD_GATE":{"value":"NUMBER","comparison":"ENUM","threshold":"ANY"},"TIMER_TICK":{"current":"NUMBER","delta":"NUMBER","due":"NUMBER","basis":"KEY","repeat_interval":"NUMBER"},"WEIGHTED_DIST":{"formula_mode":"ENUM","formula_ref":"KEY","estimate":"NUMBER","target_min":"NUMBER","target_max":"NUMBER","scale":"NUMBER","values":"ARRAY","weights":"ARRAY"},"CUSTOM_EXPR":{"expression":"DERIVED"},"RATIO":{"value":"NUMBER","numerator":"NUMBER","denominator":"NUMBER"},"UNIT_CONVERT":{"value":"NUMBER","from_unit":"REF","to_unit":"REF","dimension":"KEY","calendar_ref":"REF","scope_world_id":"REF"},"CALENDAR_TO_TICK":{"calendar_ref":"REF","date":"OBJECT"},"CALENDAR_DIFF":{"calendar_ref":"REF","from":"OBJECT","to":"OBJECT"},"SUM_VALUES":{"values":"ARRAY"},"LOOKUP":{"table_id":"TABLE_KEY","row_uuid":"ROW_REF","field_key":"FIELD_KEY"},"CHILDREN":{"table_id":"TABLE_KEY","foreign_key":"FIELD_KEY","parent_id":"ROW_REF"},"INTERVAL_DISTANCE":{"estimate":"NUMBER","target_min":"NUMBER","target_max":"NUMBER","scale":"NUMBER"},"WEIGHTED_MEAN":{"values":"ARRAY","weights":"ARRAY"},"NORMALIZE_WEIGHTS":{"weights":"ARRAY"}};
export const OPERATOR_PARAMETERS=Object.fromEntries(Object.entries(OPERATOR_SIGNATURES).map(([key,parameters])=>[key,Object.keys(parameters)]));
export function executeOperator(operator,args,context={}){
  if(own(OPERATOR_PARAMETERS,operator)&&operator!=='CUSTOM_EXPR')for(const key of Object.keys(args))if(!OPERATOR_PARAMETERS[operator].includes(key))fail('UNKNOWN_PARAMETER','Parameter key is not registered for operator',{operator,parameter_key:key});
  switch(operator){
    case 'CLAMP_ADD':{
      const current=num(args.current,'current'),delta=num(args.delta,'delta'),minimum=num(args.minimum,'minimum'),maximum=num(args.maximum,'maximum');if(minimum>maximum)fail('BOUND_ORDER','Minimum exceeds maximum');const value=Math.min(maximum,Math.max(minimum,finite(current+delta)));return {value,requested_delta:delta,applied_delta:finite(value-current)};
    }
    case 'COST_CHECK':{
      const available=num(args.available,'available'),required=num(args.required,'required');if(available<0||required<0)fail('NEGATIVE_RESOURCE','Available resource and required cost must be nonnegative');if(!['BLOCK','PARTIAL','DEBT'].includes(args.policy))fail('COST_POLICY','Cost policy must be explicitly BLOCK, PARTIAL or DEBT');const shortfall=Math.max(0,required-available);
      if(shortfall&&args.policy==='BLOCK')return {allowed:false,paid:0,shortfall,remaining:available,debt:0};
      const paid=Math.min(available,required);return {allowed:true,paid,shortfall,remaining:available-paid,debt:args.policy==='DEBT'?shortfall:0};
    }
    case 'THRESHOLD_GATE':{
      const map={'>=':'GTE','<=':'LTE','==':'EQUAL','IN':'IN','>':'GT','<':'LT','!=':'NOT_EQUAL'};if(!own(map,args.comparison))fail('COMPARISON','Unsupported comparison');return {passed:evaluateExpression({kind:'op',operator:map[args.comparison],args:[{kind:'literal',value:args.value},{kind:'literal',value:args.threshold}]})};
    }
    case 'TIMER_TICK':{
      requireKey(args.basis,'basis');const current=num(args.current,'current'),delta=num(args.delta,'delta'),due=num(args.due,'due');if(delta<0)fail('NEGATIVE_STEP','Timer forward step cannot be negative');const cursor=finite(current+delta);let crossed_count=due>current&&due<=cursor?1:0,next_due=due;
      if(!blank(args.repeat_interval)){const period=positive(args.repeat_interval,'repeat_interval');const first=Math.max(0,Math.floor((current-due)/period)+1),last=Math.floor((cursor-due)/period);crossed_count=Math.max(0,last-first+1);next_due=due+(Math.max(-1,last)+1)*period;}
      return {cursor,crossed_count,remaining:finite(next_due-cursor),remaining_to_original_due:finite(due-cursor),remaining_to_next_due:finite(next_due-cursor),next_due,basis:args.basis,event_completed:false};
    }
    case 'MUL_CHAIN':return finite(nonemptyNumbers(args.values,'values').reduce((p,x)=>p*x,1));
    case 'ROLL_D100_TABLE':{
      const roll=integer(args.roll,'roll');if(roll<1||roll>100)fail('ROLL_RANGE','Explicit d100 roll must be 1..100');const ranges=list(args.ranges,'ranges');const slots=Array(100).fill(null);
      for(const r of ranges){const low=integer(r.minimum,'minimum'),high=integer(r.maximum,'maximum');if(low<1||high>100||low>high)fail('ROLL_TABLE_RANGE','Outcome interval must be within 1..100',r);missing(r.value,'outcome value');for(let n=low;n<=high;n++){if(slots[n-1]!==null)fail('ROLL_TABLE_OVERLAP','Outcome intervals overlap',{roll:n});slots[n-1]=r.value;}}
      if(slots.some(x=>x===null))fail('ROLL_TABLE_GAP','Outcome intervals must cover 1..100');return {roll,value:slots[roll-1],random_generated:false};
    }
    case 'WEIGHTED_DIST':{
      if(!blank(args.formula_mode)){
        if(!['INTERVAL_DISTANCE','WEIGHTED_MEAN','NORMALIZE_WEIGHTS'].includes(args.formula_mode))fail('FORMULA_SELECTION','Selected weighted formula mode is not registered');return executeOperator(args.formula_mode,Object.fromEntries(OPERATOR_PARAMETERS[args.formula_mode].filter(k=>own(args,k)).map(k=>[k,args[k]])),context);
      }
      if(!blank(args.formula_ref))return evaluateCompiledFormula({...context,parameters:{...(context.parameters??{}),...args}},args.formula_ref,context.active_owner??{},context.formula_stack??new Set());
      fail('MISSING_FORMULA_SELECTION','Select a registered mathematical mode or formula; no preference learning equation is inferred',{operator});
    }
    case 'INTERVAL_DISTANCE':{const value=num(args.estimate,'estimate'),min=num(args.target_min,'target_min'),max=num(args.target_max,'target_max'),scale=positive(args.scale,'scale');if(min>max)fail('BOUND_ORDER','Target interval minimum exceeds maximum');return finite(Math.max(min-value,0,value-max)/scale);}
    case 'NORMALIZE_WEIGHTS':{const weights=nonemptyNumbers(args.weights,'weights');if(weights.some(x=>x<0))fail('NEGATIVE_WEIGHT','Weights must be nonnegative');const total=positive(finite(weights.reduce((s,x)=>s+x,0)),'total weight');return weights.map(x=>x/total);}
    case 'WEIGHTED_MEAN':{const values=nonemptyNumbers(args.values,'values'),weights=executeOperator('NORMALIZE_WEIGHTS',{weights:args.weights},context);if(values.length!==weights.length)fail('WEIGHT_LENGTH','Values and weights must have equal length');return finite(values.reduce((s,x,i)=>s+x*weights[i],0));}
    case 'CUSTOM_EXPR':{const {expression,parameters,...named}=args;return evaluateExpression(expression,{...context,parameters:{...(context.parameters??{}),...named,...(parameters??{})}});}
    case 'RATIO':return evaluateExpression({kind:'op',operator:'DIVIDE',args:[{kind:'op',operator:'MULTIPLY',args:[{kind:'literal',value:args.value},{kind:'literal',value:args.numerator}]},{kind:'literal',value:args.denominator}]});
    case 'UNIT_CONVERT':{const ratios=context.unit_ratios??[],matching=ratios.filter(r=>r.from_unit===args.from_unit&&r.to_unit===args.to_unit);const dimensions=[...new Set(matching.map(r=>r.dimension))],dimension=args.dimension??(dimensions.length===1?dimensions[0]:undefined);return convertUnit(args.value,args.from_unit,args.to_unit,dimension,ratios,args);}
    case 'CALENDAR_TO_TICK':return calendarToTick(context.calendars?.[args.calendar_ref],args.date);
    case 'CALENDAR_DIFF':return calendarDiff(context.calendars?.[args.calendar_ref],args.from,args.to);
    case 'SUM_VALUES':return finite(nonemptyNumbers(args.values,'values').reduce((s,x)=>s+x,0));
    case 'LOOKUP':return resolveCell(context.tables??{},args);
    case 'CHILDREN':return findChildren(context.tables??{},args.table_id,args.foreign_key,args.parent_id);
    default:fail('UNSUPPORTED_OPERATOR','Execution operator is not registered',{operator});
  }
}

function stepDependencies(node,out=new Set()){
  if(!node||typeof node!=='object')return out;if(node.kind==='step')out.add(node.step_id);
  if(Array.isArray(node))for(const x of node)stepDependencies(x,out);else for(const x of Object.values(node))stepDependencies(x,out);return out;
}

function macroOrder(macro){
  const steps=list(macro.steps,'macro steps'),byId=new Map(),states=new Map(),order=[];
  for(const s of steps){requireKey(s.step_id,'step_id');if(byId.has(s.step_id))fail('DUPLICATE_STEP','Macro step key is duplicated',{step_id:s.step_id});byId.set(s.step_id,s);}
  const visit=id=>{if(!byId.has(id))fail('MISSING_STEP','Macro dependency is absent',{step_id:id});if(states.get(id)==='active')fail('MACRO_CYCLE','Macro contains a dependency cycle',{step_id:id});if(states.get(id)==='done')return;states.set(id,'active');const s=byId.get(id);for(const dep of new Set([...(s.depends_on??[]),...stepDependencies(s.arguments)]))visit(dep);states.set(id,'done');order.push(id);};
  for(const s of steps)visit(s.step_id);
  return {order,byId};
}
export function runMacro(macro,context={}){
  const {order,byId}=macroOrder(macro),results={},writes=[];
  for(const id of order){const s=byId.get(id),arguments_={};for(const [key,node] of Object.entries(s.arguments??{}))arguments_[key]=key==='expression'?node:evaluateExpression(node,{...context,steps:results});
    try{results[id]=executeOperator(s.operator_key,arguments_,{...context,steps:results});}catch(error){if(error instanceof MechanicalError){error.details={...error.details,step_id:id,completed_steps:Object.keys(results)};}throw error;}
    if(s.output_coordinate){const coordinate=s.output_coordinate;for(const key of ['table_id','row_uuid','field_key'])requireKey(coordinate[key],key);const value=resultPath(results[id],s.result_path);if(writes.some(w=>JSON.stringify(w.coordinate)===JSON.stringify(coordinate)))fail('WRITE_COLLISION','Macro has multiple outputs for one cell',{coordinate});writes.push({coordinate,value,step_id:id});}
  }
  return {status:'calculated',results,execution_order:order,proposed_writes:writes,committed:false};
}

function ownerScope(row){return JSON.stringify([row.owner_table??'',row.owner_row_uuid??'']);}
const ownerLocation=row=>JSON.stringify([row.owner_table??'',row.owner_row_uuid??'',row.owner_field??'']);
function knownRow(row){if(row.value_state!=='known')fail('VALUE_STATE','Mechanical row is not known',{row_uuid:row.row_uuid,state:row.value_state});}
function singleRecord(tables,table,id){const rows=tables[table]??[];const matches=rows.filter(r=>identifier(r)===id);if(matches.length!==1)fail(matches.length?'DUPLICATE_KEY':'BROKEN_REFERENCE','Record reference must resolve exactly once',{table_id:table,row_uuid:id});return matches[0];}
export function resolveRegisteredReference(tables,referenceId,{value=true}={}){
  if(referenceId&&typeof referenceId==='object'){
    if(referenceId.kind==='identity')return referenceId;
    if(Array.isArray(referenceId))fail('CARDINALITY','Expected one registered reference, got a list');
    if(referenceId.table_id){singleRecord(tables,referenceId.table_id,referenceId.row_uuid);return value&&referenceId.field_key?resolveCell(tables,referenceId):referenceId;}
  }
  const r=singleRecord(tables,'M_FIELD_REFERENCES',referenceId);
  if(r.reference_kind==='external'||r.resolution_status==='identity_only')return {kind:'identity',provider:r.external_provider??null,id:r.external_id??r.target_row_uuid,content_loaded:false};
  if(r.resolution_status!=='resolved')fail('UNRESOLVED_REFERENCE','Reference is not resolved',{reference_id:referenceId});
  const coordinate={table_id:requireKey(r.target_table,'target_table'),row_uuid:requireKey(r.target_row_uuid,'target_row_uuid'),field_key:r.target_field};
  singleRecord(tables,coordinate.table_id,coordinate.row_uuid);
  if(r.reference_kind==='record'||!value)return coordinate;
  if(r.reference_kind!=='cell')fail('REFERENCE_KIND','Reference kind is not registered',{reference_kind:r.reference_kind});
  return resolveCell(tables,coordinate);
}
function ordered(rows,key='sequence'){
  const out=[...rows].sort((a,b)=>integer(a[key],key)-integer(b[key],key));const seen=new Set();for(const r of out){if(r[key]<0||seen.has(r[key]))fail('SEQUENCE','Sequence numbers must be unique nonnegative integers');seen.add(r[key]);}return out;
}
function listAtom(row,tables){knownRow(row);switch(row.item_type){
  case 'number':return num(row.number_value,'number_value');case 'boolean':return bool(row.boolean_value,'boolean_value');case 'text':return missing(row.text_value,'text_value');
  case 'reference':{const coordinate={table_id:row.target_table,row_uuid:row.target_row_uuid,field_key:row.target_field};singleRecord(tables,coordinate.table_id,coordinate.row_uuid);return blank(row.target_field)?{table_id:row.target_table,row_uuid:row.target_row_uuid}:resolveCell(tables,coordinate);}
  default:fail('LIST_ITEM_TYPE','List item type is not registered',{item_type:row.item_type});
}}

export function compileTypedValues(rows,tables){
  const byId=new Map(rows.map(r=>[r.row_uuid,r]));if(byId.size!==rows.length)fail('DUPLICATE_KEY','Typed value node is duplicated');
  for(const row of rows)if(!blank(row.parent_value_ref)&&!byId.has(row.parent_value_ref))fail('BROKEN_REFERENCE','Typed parent value is absent in same owner field',{parent:row.parent_value_ref});
  const roots=rows.filter(r=>blank(r.parent_value_ref));if(roots.length!==1)fail('TYPED_ROOT','Typed value must have exactly one root per owner field');
  const seen=new Set();
  const build=(row,stack)=>{
    knownRow(row);if(stack.has(row.row_uuid))fail('TYPED_CYCLE','Typed object/list contains a parent cycle');const active=new Set(stack);active.add(row.row_uuid);seen.add(row.row_uuid);
    const children=rows.filter(r=>r.parent_value_ref===row.row_uuid);
    if(!['list','object'].includes(row.value_type)&&children.length)fail('TYPED_CHILDREN','Scalar typed value has child nodes');
    switch(row.value_type){
      case 'number':return num(row.number_value,'number_value');case 'integer':return integer(row.number_value,'number_value');case 'boolean':return bool(row.boolean_value,'boolean_value');case 'text':return missing(row.text_value,'text_value');
      case 'reference':return resolveRegisteredReference(tables,missing(row.reference_ref,'reference_ref'));
      case 'list':{
        if(!blank(row.list_ref)){if(children.length)fail('TYPED_LIST_SOURCE','List cannot use list_ref and nested children simultaneously');const first=singleRecord(tables,'M_LIST_VALUES',row.list_ref);return ordered((tables.M_LIST_VALUES??[]).filter(r=>ownerLocation(r)===ownerLocation(first))).map(r=>listAtom(r,tables));}
        const sorted=ordered(children);sorted.forEach((r,i)=>{if(r.sequence!==i)fail('LIST_INDEX','List child sequence must be contiguous from zero');});return sorted.map(r=>build(r,active));
      }
      case 'object':{const out={};for(const r of children){const key=requireKey(r.object_property_key,'object_property_key');if(['__proto__','prototype','constructor'].includes(key)||own(out,key))fail('OBJECT_PROPERTY','Object property is duplicated or not a valid data key',{key});out[key]=build(r,active);}return out;}
      default:fail('TYPED_KIND','Typed value kind is not registered',{value_type:row.value_type});
    }
  };
  const value=build(roots[0],new Set());if(seen.size!==rows.length)fail('TYPED_DISCONNECTED','Typed tree contains unreachable or cyclic nodes');return value;
}

function validateOwnerInheritance(tables){
  const ownership=new Map();
  for(const [id,rows] of Object.entries(tables))if(id.startsWith('M_'))for(const r of rows){
    if(blank(r.owner_table)&&blank(r.owner_row_uuid)&&blank(r.owner_field))continue;
    for(const key of ['owner_table','owner_row_uuid','owner_field'])requireKey(r[key],key);
    const parent=singleRecord(tables,r.owner_table,r.owner_row_uuid);
    ownership.set(JSON.stringify([id,r.row_uuid]),JSON.stringify([r.owner_table,r.owner_row_uuid]));
    for(const key of ['scope_world_id','scope_session_id','scope_branch_id','default_disclosure','record_status','record_revision']){
      const parentValue=parent[key]??parent.__context?.[key]??parent._owner_context?.[key],inherited=r._owner_context?.[key];if(!blank(inherited)&&!blank(parentValue)&&!dataEqual(inherited,parentValue))fail('OWNER_CONTEXT','Inherited child metadata differs from parent',{table_id:id,row_uuid:r.row_uuid,key});
      if(!blank(r[key])&&!blank(parentValue)&&!dataEqual(r[key],parentValue))fail('SCOPE_MISMATCH','Child row has conflicting explicit owner scope',{table_id:id,row_uuid:r.row_uuid,key});
    }
  }
  for(const start of ownership.keys()){const seen=new Set();let at=start;while(ownership.has(at)){if(seen.has(at))fail('OWNER_CYCLE','Owned subtable references form a cycle',{record:start});seen.add(at);at=ownership.get(at);}}
}

function hydrateOwnedFields(tables){
  const outputs={};
  for(const table of ['M_WORLD_TIME','M_QUANTITIES','M_LIST_VALUES','M_TYPED_VALUES','M_FIELD_REFERENCES','M_TIME_RANGES']){
    const groups=new Map();for(const r of tables[table]??[]){if(blank(r.owner_table))continue;const key=ownerLocation(r);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
    for(const [key,rows] of groups){
      if(own(outputs,key))fail('MULTIPLE_OWNERS','One mechanical field has competing typed owners',{owner:key});
      const first=rows[0],parent=singleRecord(tables,first.owner_table,first.owner_row_uuid);const states=rows.map(r=>r.value_state);let state=new Set(states).size===1?states[0]:'unknown',value=null;
      if(state==='known'){
        if(table==='M_WORLD_TIME'){
          if(rows.length!==1)fail('CARDINALITY','One time field must have one structured time record');requireKey(first.precision,'precision');if(!['tick','minute','hour','day','month','season','year','range','relative','unknown'].includes(first.precision))fail('TIME_PRECISION','Time precision is unsupported');value={...first};
          if(['tick','minute','hour','day','month','season','year'].includes(first.precision))integer(first.year,'year');
          const calendar=(tables.M_CALENDAR_RULES??[]).find(c=>(c.calendar_id??c.row_uuid)===first.calendar_ref);
          if(calendar?.mode==='SEASON_FIXED'){
            if(first.precision==='month'||!blank(first.month))fail('CALENDAR_TOPOLOGY_CONFLICT','A season-day time record has no month',{row_uuid:first.row_uuid});
            if(['tick','minute','hour','day','season'].includes(first.precision))positiveInteger(first.season,'season');
          }else if(['tick','minute','hour','day','month'].includes(first.precision))positiveInteger(first.month,'month');
          if(['tick','minute','hour','day'].includes(first.precision))positiveInteger(first.day,'day');
          if(calendar?.mode==='SEASON_FIXED'&&['tick','minute','hour','day'].includes(first.precision))calendarToTick({...calendar,calendar_id:calendar.calendar_id??calendar.row_uuid,month_lengths:(tables.M_CALENDAR_MONTHS??[]).filter(r=>r.calendar_ref===first.calendar_ref),leap_rules:(tables.M_CALENDAR_EXCEPTIONS??[]).filter(r=>r.calendar_ref===first.calendar_ref)},first);
        }else if(table==='M_QUANTITIES'){
          if(rows.length!==1)fail('CARDINALITY','One quantity field must have one structured quantity record');
          if(first.quantity_mode==='exact')value={value:num(first.value,'quantity value'),unit_ref:missing(first.unit_ref,'unit_ref')};
          else if(first.quantity_mode==='range'){const min=num(first.minimum,'minimum'),max=num(first.maximum,'maximum');if(min>max)fail('BOUND_ORDER','Quantity minimum exceeds maximum');value={minimum:min,maximum:max,unit_ref:missing(first.unit_ref,'unit_ref')};}
          else if(first.quantity_mode==='formula')value={formula_ref:requireKey(first.formula_ref,'formula_ref'),status:'requires_evaluation',unit_ref:first.unit_ref??null};
          else if(first.quantity_mode==='narrative_only')value={narrative:missing(first.narrative,'narrative'),computable:false};else fail('QUANTITY_MODE','Quantity mode is absent or unsupported');
        }else if(table==='M_LIST_VALUES')value=ordered(rows).map(r=>listAtom(r,tables));
        else if(table==='M_TYPED_VALUES')value=compileTypedValues(rows,tables);
        else if(table==='M_FIELD_REFERENCES'){const refs=rows.map(r=>resolveRegisteredReference(tables,r.row_uuid,{value:false}));value=refs.length===1?refs[0]:refs;}
        else{
          if(rows.length!==1)fail('CARDINALITY','One time-range field must have one range record');
          if(first.time_basis==='turn_range'){const start=integer(first.start_turn,'start_turn'),end=integer(first.end_turn,'end_turn');if(start>end)fail('TIME_RANGE_ORDER','Range start exceeds end');value={time_basis:'turn_range',start_turn:start,end_turn:end};}
          else if(first.time_basis==='duration'){const n=num(first.duration_value,'duration_value');if(n<0)fail('NEGATIVE_DURATION','Duration cannot be negative');value={time_basis:'duration',value:n,unit_ref:requireKey(first.duration_unit,'duration_unit')};}
          else if(first.time_basis==='anchor_range'){const start=singleRecord(tables,'T_SYS_TIME_ANCHORS',requireKey(first.start_anchor_ref,'start_anchor_ref')),end=singleRecord(tables,'T_SYS_TIME_ANCHORS',requireKey(first.end_anchor_ref,'end_anchor_ref'));value={time_basis:'anchor_range',start_anchor_ref:start.row_uuid,end_anchor_ref:end.row_uuid,start_time:start.story_time??null,end_time:end.story_time??null,exact_difference_computed:false};}
          else if(first.time_basis==='narrative_only')value={time_basis:'narrative_only',narrative:missing(first.narrative,'narrative'),computable:false};else fail('TIME_RANGE_BASIS','Time range basis is not registered');
        }
      }
      parent[first.owner_field]=value;parent.__value_states??={};parent.__value_states[first.owner_field]=state;
      outputs[key]={table_id:first.owner_table,row_uuid:first.owner_row_uuid,field_key:first.owner_field,value_state:state,value,source_table:table,source_rows:rows.map(r=>r.row_uuid)};
    }
  }
  return outputs;
}

export function evaluateConditionGroup(tables,owner,groupKey){
  const rows=(tables.M_CONDITIONS??[]).filter(r=>ownerLocation(r)===ownerLocation(owner)&&r.group_key===groupKey);if(!rows.length)fail('MISSING_CONDITION','Condition group has no rows',{group_key:groupKey});
  const modes=new Set(rows.map(r=>r.combine));if(modes.size!==1||!['all','any'].includes(rows[0].combine))fail('CONDITION_COMBINE','Condition group must use one explicit all/any mode');
  const checks=ordered(rows).map(r=>{knownRow(r);if(r.predicate_kind==='observed_boolean')return bool(r.observed_result,'observed_result');if(r.predicate_kind!=='comparison')fail('PREDICATE_KIND','Condition predicate is unsupported');
    if(r.comparator==='exists'){
      const coordinate=resolveRegisteredReference(tables,missing(r.lhs_ref,'lhs_ref'),{value:false});
      if(coordinate.kind==='identity')fail('IDENTITY_ONLY','Identity-only reference does not establish a known field value');
      const target=singleRecord(tables,coordinate.table_id,coordinate.row_uuid);
      if(blank(coordinate.field_key))return true;
      if(!own(target,coordinate.field_key)&&!own(target.__value_states,coordinate.field_key))fail('MISSING_FIELD','Existence check target field is not declared');
      const state=target.__value_states?.[coordinate.field_key];
      if(state==='unknown')fail('VALUE_STATE','Unknown field existence cannot be asserted');
      if(['unset','not_applicable','none','cleared'].includes(state))return false;
      if(state&&!['known','已知','已确认'].includes(state))fail('VALUE_STATE','Field existence state is not known',{state});
      return !blank(target[coordinate.field_key]);
    }
    const lhs=resolveRegisteredReference(tables,missing(r.lhs_ref,'lhs_ref'));
    const rhs=r.rhs_kind==='number'?num(r.rhs_number,'rhs_number'):r.rhs_kind==='boolean'?bool(r.rhs_boolean,'rhs_boolean'):r.rhs_kind==='text'?missing(r.rhs_text,'rhs_text'):r.rhs_kind==='reference'?resolveRegisteredReference(tables,missing(r.rhs_ref,'rhs_ref')):fail('CONDITION_RHS','Condition right value kind is unsupported');
    const map={eq:'EQUAL',ne:'NOT_EQUAL',gt:'GT',ge:'GTE',lt:'LT',le:'LTE',in:'IN',not_in:'IN'};if(!own(map,r.comparator))fail('COMPARATOR','Condition comparator is unsupported');const result=evaluateExpression({kind:'op',operator:map[r.comparator],args:[{kind:'literal',value:lhs},{kind:'literal',value:rhs}]});return r.comparator==='not_in'?!result:result;
  });return {passed:rows[0].combine==='all'?checks.every(Boolean):checks.some(Boolean),checks,source_rows:rows.map(r=>r.row_uuid)};
}

export function calculateEffects(compiled,owner){
  const rows=ordered((compiled.tables.M_EFFECTS??[]).filter(r=>ownerLocation(r)===ownerLocation(owner))),writes=[],skipped=[],shadow={};
  for(const r of rows){knownRow(r);if(r.operation==='narrative_only'){skipped.push({row_uuid:r.row_uuid,reason:'narrative_only',narrative:r.narrative??''});continue;}
    if(!blank(r.condition_group_ref)){const first=singleRecord(compiled.tables,'M_CONDITIONS',r.condition_group_ref);const gate=evaluateConditionGroup(compiled.tables,first,first.group_key);if(!gate.passed){skipped.push({row_uuid:r.row_uuid,reason:'condition_false'});continue;}}
    const coordinate=resolveRegisteredReference(compiled.tables,missing(r.target_ref,'target_ref'),{value:false});requireKey(coordinate.field_key,'target field');const key=JSON.stringify(coordinate);let result;
    const current=()=>own(shadow,key)?shadow[key]:resolveCell(compiled.tables,coordinate);
    switch(r.operation){
      case 'set':result=num(r.value,'value');break;case 'add':result=finite(num(current(),'current')+num(r.value,'value'));break;case 'multiply':result=finite(num(current(),'current')*num(r.value,'value'));break;
      case 'clamp':result=executeOperator('CLAMP_ADD',{current:current(),delta:0,minimum:r.minimum,maximum:r.maximum}).value;break;
      case 'formula':result=evaluateCompiledFormula(compiled,requireKey(r.formula_ref,'formula_ref'),owner);break;
      default:fail('EFFECT_OPERATION','Effect operation is unsupported',{operation:r.operation});
    }
    shadow[key]=result;writes.push({coordinate,value:result,source_row:r.row_uuid,unit_ref:r.unit_ref??null});
  }
  return {status:'calculated',proposed_writes:writes,skipped,committed:false};
}

/** Derived data is an internal projection. It retains source states and disclosure metadata. */
export function deriveReadOnlyProjections(tables,manifest=[]){
  tables=Object.fromEntries(Object.entries(tables).map(([id,rows])=>[id,rows.filter(r=>r.__record_state!=='template').map(r=>({...r,__value_states:{...(r.__value_states??{})}}))]));
  const outputs=[],done=new Set(),scopeKeys=['scope_world_id','scope_session_id','scope_branch_id'];
  const sameScope=(a,b)=>scopeKeys.every(k=>dataEqual(a[k]??null,b[k]??null));
  const recordProjection=(table,row,field,sourceTable,rows,keys,select)=>{
    const entries=rows.map(r=>({row_uuid:r.row_uuid,values:Object.fromEntries(keys.map(k=>[k,own(r,k)?r[k]:null])),value_states:Object.fromEntries(keys.map(k=>[k,r.__value_states?.[k]??(blank(r[k])?'unset':'known')])),scope:Object.fromEntries(scopeKeys.map(k=>[k,r[k]??null])),cell_metadata:r.__cell_metadata??{},context:r.__context??{}}));
    const complete=entries.length>0&&entries.every(e=>Object.values(e.value_states).every(v=>v==='known'));
    const value=rows.length?rows.map(r=>select?select(r):Object.fromEntries(keys.map(k=>[k,r[k]??null]))):null;
    const id=JSON.stringify([table,row.row_uuid,field]);done.add(id);outputs.push({table_id:table,row_uuid:row.row_uuid,field_key:field,status:rows.length?(complete?'derived':'partial'):'missing_source',value,entries,source_table:sourceTable,readonly:true,public_disclosure_authorized:false});row[field]=complete?value:null;row.__value_states??={};row.__value_states[field]=complete?'known':'unknown';
  };
  const join=(parent,child,fk)=> (tables[child]??[]).filter(r=>r[fk]===parent.row_uuid&&sameScope(parent,r));
  for(const row of tables.T_STATIC_FACILITY_LEVELS??[]){const rows=join(row,'T_STATIC_FACILITY_MATERIALS','upgrade_ref');for(const field of ['material_ref','material_quantity'])recordProjection('T_STATIC_FACILITY_LEVELS',row,field,'T_STATIC_FACILITY_MATERIALS',rows,['asset_ref','quantity','unit'],r=>({material_line_id:r.row_uuid,asset_ref:r.asset_ref??null,quantity:r.quantity??null,unit:r.unit??null}));}
  for(const row of tables.T_CHAR_DOSSIER??[]){for(const [field,category] of [['likes_with_reasons','喜好'],['dislikes_with_reasons','厌恶']]){const rows=join(row,'T_CHAR_ANCHORS','char_ref').filter(r=>r.category===category);recordProjection('T_CHAR_DOSSIER',row,field,'T_CHAR_ANCHORS',rows,['name','internal_motive','validity']);}}
  for(const row of tables.T_DYN_EVENTS??[]){
    recordProjection('T_DYN_EVENTS',row,'multi_party_psychology','T_DYN_EVENT_PARTICIPANTS',join(row,'T_DYN_EVENT_PARTICIPANTS','event_ref'),['entity_ref','psychology','then_understanding']);
    for(const [field,key] of [['source_entry_id','entry_id'],['source_revision','revision'],['source_hash','entry_hash'],['source_paragraphs','paragraph_id']])recordProjection('T_DYN_EVENTS',row,field,'T_SYS_SOURCE_FRAGMENTS',join(row,'T_SYS_SOURCE_FRAGMENTS','event_ref'),[key],r=>({fragment_id:r.row_uuid,[key]:r[key]??null}));
  }
  for(const row of tables.T_SYS_SETTLEMENTS??[]){
    const rows=join(row,'T_SYS_SETTLEMENT_VALUES','op_ref');
    for(const [field,roles,key] of [['input_coordinate',['输入'],'coordinate'],['input_value',['输入'],'value'],['output_coordinate',['输出'],'coordinate'],['output_value',['输出'],'value'],['delta',['资源变化','状态变化'],'delta']]){
      const relevant=rows.filter(r=>roles.includes(r.value_role));const sorted=relevant.length?ordered(relevant):[];recordProjection('T_SYS_SETTLEMENTS',row,field,'T_SYS_SETTLEMENT_VALUES',sorted,['value_role','coordinate',key],r=>({value_id:r.row_uuid,value_role:r.value_role,coordinate:r.coordinate??null,[key]:r[key]??null}));
    }
  }
  for(const row of tables.T_DYN_SCENE_PARTICIPANTS??[]){const rows=(tables.T_DYN_ENTITY_STATE??[]).filter(r=>r.entity_id===row.entity_ref&&sameScope(row,r));if(rows.length>1)fail('DUPLICATE_STATE','Scene posture resolves to multiple entity states in the same scope',{entity_ref:row.entity_ref});recordProjection('T_DYN_SCENE_PARTICIPANTS',row,'posture','T_DYN_ENTITY_STATE',rows,['posture'],r=>r.posture??null);}
  for(const row of tables.T_STATIC_ITEMS_SKILLS??[])recordProjection('T_STATIC_ITEMS_SKILLS',row,'identified_full_desc','T_STATIC_ITEMS_SKILLS',[row],['shape','material','usage','rule_effect','narrative_meaning','origin']);
  const projectScalar=(table,row,field,value,status,source)=>{const id=JSON.stringify([table,row.row_uuid,field]);done.add(id);outputs.push({table_id:table,row_uuid:row.row_uuid,field_key:field,status,value,source,readonly:true,public_disclosure_authorized:false});row[field]=status==='derived'?value:null;row.__value_states??={};row.__value_states[field]=status==='derived'?'known':'unknown';};
  const originOf=row=>{
    if(blank(row.origin_record_ref))return null;const ref=typeof row.origin_record_ref==='object'?row.origin_record_ref:resolveRegisteredReference(tables,row.origin_record_ref,{value:false});if(ref.kind==='identity')return null;singleRecord(tables,ref.table_id,ref.row_uuid);return ref;
  };
  for(const spec of manifest){const table=spec.table_id??spec.table,field=spec.field_key??spec.key;for(const row of tables[table]??[]){
    const id=JSON.stringify([table,row.row_uuid,field]);if(done.has(id))continue;
    if(table==='T_SYS_SOURCE_FRAGMENTS'&&['chunk_hash','entry_hash','total_chunks'].includes(field)){
      const known=row.__value_states?.[field]==='known';projectScalar(table,row,field,known?row[field]:null,known?'derived':'requires_complete_source',{kind:'actual_utf8_source_integrity'});continue;
    }
    if(spec.kind==='scene_time_component'){
      const knownCell=(record,key)=>!blank(record?.[key])&&(!record?.__value_states?.[key]||record.__value_states[key]==='known');
      let anchor=null,time=null;if(knownCell(row,'time_anchor_id')){anchor=singleRecord(tables,'T_SYS_TIME_ANCHORS',row.time_anchor_id);if(!sameScope(row,anchor))fail('SCOPE_MISMATCH','Scene time anchor differs from scene scope');if(knownCell(anchor,'story_time')&&typeof anchor.story_time==='object')time=anchor.story_time;}
      const timeKnown=time&&(!time.value_state||time.value_state==='known'),precision=timeKnown?time.precision:'unknown',exact=['year','season','month','day','hour','minute','tick'],allows={year:exact,season:['season','month','day','hour','minute','tick'],month:['month','day','hour','minute','tick'],day:['day','hour','minute','tick'],hour:['hour','minute','tick'],minute:['minute','tick'],tick:['tick']};
      const component=key=>timeKnown&&allows[key]?.includes(precision)&&!blank(time[key])?time[key]:null,original_text=timeKnown&&!blank(time.original_text)?time.original_text:knownCell(anchor,'time_original')?anchor.time_original:null;
      let value;if(field==='year')value=component('year');
      else if(field==='season_cycle')value={precision,season:component('season'),cycle_ref:knownCell(row,'active_festival_ref')?row.active_festival_ref:null,phase_text:knownCell(row,'active_phase')?row.active_phase:null,original_text};
      else if(field==='date_day'){
        const seasonCalendar=(tables.M_CALENDAR_RULES??[]).find(c=>(c.calendar_id??c.row_uuid)===time?.calendar_ref)?.mode==='SEASON_FIXED';
        value=seasonCalendar?{precision,season:component('season'),day:component('day'),calendar_ref:time.calendar_ref,original_text}:{precision,month:component('month'),day:component('day'),original_text};
      }
      else if(field==='time_of_day')value={precision,hour:component('hour'),minute:component('minute'),tick:component('tick'),original_text};
      else fail('SCENE_TIME_COMPONENT','Scene time component field is not registered',{field});
      const available=field==='year'?!blank(value):Object.entries(value).some(([k,v])=>k!=='precision'&&!blank(v));
      projectScalar(table,row,field,available?value:null,available?'derived':'missing_source',{kind:'scene_time_component',time_anchor_ref:anchor?.row_uuid??null,story_time_ref:time?.row_uuid??null,precision,original_text_source:timeKnown&&!blank(time?.original_text)?'M_WORLD_TIME.original_text':knownCell(anchor,'time_original')?'T_SYS_TIME_ANCHORS.time_original':null,exact_arithmetic_performed:false});continue;
    }
    if(spec.kind==='polymorphic_origin_projection'){
      const ref=originOf(row);
      if(ref){const source=singleRecord(tables,ref.table_id,ref.row_uuid);const keys=(spec.field_map??[]).filter(x=>x.table_id===ref.table_id).map(x=>x.field_key);if(!keys.length)fail('ORIGIN_TYPE','Origin table has no declared projection mapping',{table_id:ref.table_id,field});const known=keys.every(k=>(source.__value_states?.[k]??(blank(source[k])?'unset':'known'))==='known');const value=keys.length===1?source[keys[0]]:Object.fromEntries(keys.map(k=>[k,source[k]??null]));projectScalar(table,row,field,value,known?'derived':'partial',{coordinate:ref,fields:keys,cell_metadata:source.__cell_metadata??{},context:source.__context??{}});continue;}
      if(row.__value_states?.origin_record_ref==='none'&&own(row,spec.fallback_field)&&!blank(row[spec.fallback_field])){projectScalar(table,row,field,row[spec.fallback_field],'derived',{field_key:spec.fallback_field,reason:'origin explicitly none'});continue;}
    }
    if(spec.kind==='indirect_children_projection'){
      const entities=(tables[spec.identity_table]??[]).filter(entity=>{const ref=originOf(entity);return ref?.table_id===spec.origin_target_table&&ref.row_uuid===row.row_uuid;});
      const ids=new Set(entities.map(r=>r.row_uuid)),children=(tables[spec.source_table]??[]).filter(r=>ids.has(r[spec.foreign_key]));recordProjection(table,row,field,spec.source_table,children,(spec.retain_fields??[]).filter(k=>k!=='row_uuid'));continue;
    }
    if(spec.kind==='explicit_state_or_holding_projection'){
      const sources=[];if(!blank(row[spec.state_ref_field])){let ref=row[spec.state_ref_field];if(typeof ref==='object')ref=ref.row_uuid;const state=singleRecord(tables,spec.state_table,ref);if(sameScope(row,state))sources.push({table_id:spec.state_table,row:state,key:spec.state_value_field});}
      for(const holding of (tables[spec.holding_table]??[]).filter(h=>h[spec.holding_foreign_key]===row.row_uuid&&sameScope(row,h)))sources.push({table_id:spec.holding_table,row:holding,key:spec.holding_value_field});
      const values=sources.map(s=>s.row[s.key]);const known=sources.length&&sources.every(s=>(s.row.__value_states?.[s.key]??(blank(s.row[s.key])?'unset':'known'))==='known');const same=values.length&&values.every(v=>dataEqual(v,values[0]));projectScalar(table,row,field,known&&same?values[0]:null,known&&same?'derived':sources.length?'source_conflict_or_unknown':'missing_source',sources.map(s=>({table_id:s.table_id,row_uuid:s.row.row_uuid,field_key:s.key})));continue;
    }
    done.add(id);outputs.push({table_id:table,row_uuid:row.row_uuid,field_key:field,status:'requires_runtime_input_or_binding',value:null,source_contract:spec,readonly:true,public_disclosure_authorized:false});
  }}
  return outputs;
}

export function computeSourceIntegrity(tables,manifests=[]){
  const rows=(tables.T_SYS_SOURCE_FRAGMENTS??[]).filter(r=>r.__record_state!=='template'),chunks=[],groups=new Map();
  const hash=text=>createHash('sha256').update(text,'utf8').digest('hex');
  for(const row of rows){
    if(!blank(row.entry_id)&&!blank(row.revision)){const key=JSON.stringify([row.entry_id,row.revision,row.scope_world_id??null,row.scope_session_id??null,row.scope_branch_id??null]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
    const state=row.__value_states?.chunk_text??(typeof row.chunk_text==='string'?'known':'unset');if(state!=='known'||typeof row.chunk_text!=='string'){row.__value_states??={};for(const key of ['chunk_hash','entry_hash','total_chunks']){row[key]=null;row.__value_states[key]='unknown';}chunks.push({row_uuid:row.row_uuid,status:'requires_source_text',sha256:null});continue;}
    const sha256=hash(row.chunk_text);if(row.__value_states?.chunk_hash==='known'&&!blank(row.chunk_hash)&&row.chunk_hash!==sha256)fail('SOURCE_CHUNK_HASH_MISMATCH','Known source chunk hash differs from actual UTF8 bytes',{row_uuid:row.row_uuid,expected:row.chunk_hash,actual:sha256});
    row.chunk_hash=sha256;row.__value_states??={};row.__value_states.chunk_hash='known';chunks.push({row_uuid:row.row_uuid,status:'calculated',sha256,encoding:'UTF-8',normalization:'none'});
  }
  const entries=[];
  for(const rows of groups.values()){
    const first=rows[0],scope={scope_world_id:first.scope_world_id??null,scope_session_id:first.scope_session_id??null,scope_branch_id:first.scope_branch_id??null};
    const matching=manifests.filter(m=>m.entry_id===first.entry_id&&m.revision===first.revision&&Object.entries(scope).every(([k,v])=>blank(m[k])||m[k]===v));
    if(matching.length>1)fail('DUPLICATE_SOURCE_MANIFEST','Multiple whole-source manifests match one entry revision');
    const result={entry_id:first.entry_id,revision:first.revision,...scope,observed_chunk_count:rows.length,status:'requires_complete_source',entry_hash:null};
    if(matching.length){
      if(rows.some(row=>(row.__value_states?.chunk_text??(typeof row.chunk_text==='string'?'known':'unset'))!=='known'||typeof row.chunk_text!=='string'))fail('SOURCE_TEXT_UNKNOWN','Whole-source verification cannot consume unknown or missing chunk text',{entry_id:first.entry_id});
      const m=matching[0];positiveInteger(m.expected_chunks,'expected_chunks');integer(m.first_chunk_index,'first_chunk_index');if(!/^[a-f0-9]{64}$/.test(m.sha256??''))fail('SOURCE_MANIFEST_HASH','Whole-source manifest needs a SHA256 hexadecimal digest');
      const orderedRows=[...rows].sort((a,b)=>integer(a.chunk_index,'chunk_index')-integer(b.chunk_index,'chunk_index'));
      if(orderedRows.length!==m.expected_chunks)fail('SOURCE_CHUNK_COUNT','Observed source fragment count differs from whole-source manifest',{expected:m.expected_chunks,actual:orderedRows.length});
      orderedRows.forEach((row,index)=>{if(row.chunk_index!==m.first_chunk_index+index)fail('SOURCE_CHUNK_ORDER','Source chunks are not complete, unique and contiguous',{entry_id:m.entry_id,index:row.chunk_index});});
      const actual=hash(orderedRows.map(r=>r.chunk_text).join(''));if(actual!==m.sha256)fail('SOURCE_ENTRY_HASH_MISMATCH','Concatenated UTF8 chunks do not match whole-source bytes',{entry_id:m.entry_id,expected:m.sha256,actual});
      result.status='complete_verified';result.entry_hash=actual;result.total_chunks=orderedRows.length;
      for(const row of rows){row.entry_hash=actual;row.total_chunks=orderedRows.length;row.__value_states.entry_hash='known';row.__value_states.total_chunks='known';}
    }else for(const row of rows){row.entry_hash=null;row.total_chunks=null;row.__value_states.entry_hash='unknown';row.__value_states.total_chunks='unknown';}
    entries.push(result);
  }
  return {chunks,entries};
}
function compileValueRow(row,kindKey){
  if(row.value_state&&row.value_state!=='known')fail('VALUE_STATE','Binding or expression node is not known',{row_uuid:row.row_uuid,state:row.value_state});
  const kind=row[kindKey];
  if(kind==='NUMBER')return {kind:'literal',value:num(row.number_value,'number_value')};
  if(kind==='TEXT')return {kind:'literal',value:missing(row.text_value,'text_value')};
  if(kind==='BOOLEAN')return {kind:'literal',value:bool(row.boolean_value,'boolean_value')};
  if(kind==='PARAMETER')return {kind:'param',key:requireKey(row.parameter_key,'parameter_key'),source_table:row.source_table||undefined,source_row_uuid:row.source_row_uuid||undefined,result_path:row.result_path};
  if(kind==='CELL')return {kind:'cell',table_id:requireKey(row.source_table,'source_table'),row_uuid:requireKey(row.source_row_uuid,'source_row_uuid'),field_key:requireKey(row.source_field,'source_field'),result_path:row.result_path};
  if(kind==='STEP')return {kind:'step',step_id:requireKey(row.source_step_ref,'source_step_ref'),result_path:row.result_path};
  fail('BINDING_KIND','Unsupported source kind',{kind});
}

export function compileExpressionNodes(rows){
  list(rows,'expression nodes');if(!rows.length)fail('EXPRESSION_EMPTY','Expression has no nodes');const byId=new Map(),children=new Map();
  for(const row of rows){const id=requireKey(row.node_id??row.row_uuid,'node_id');if(byId.has(id))fail('DUPLICATE_NODE','Expression node ID is duplicated',{node_id:id});byId.set(id,row);if(!blank(row.parent_node_ref)){if(!children.has(row.parent_node_ref))children.set(row.parent_node_ref,[]);children.get(row.parent_node_ref).push(row);}}
  for(const parent of children.keys())if(!byId.has(parent))fail('BROKEN_NODE_REFERENCE','Parent expression node is absent',{parent});
  const roots=rows.filter(r=>blank(r.parent_node_ref));if(roots.length!==1)fail('EXPRESSION_ROOT','Expression must have exactly one root',{root_count:roots.length});
  const seen=new Set(),active=new Set();
  const build=row=>{const id=row.node_id??row.row_uuid;if(active.has(id))fail('EXPRESSION_CYCLE','Expression nodes contain a cycle',{node_id:id});active.add(id);seen.add(id);let result;
    const args=children.get(id)??[];if(row.node_kind==='OPERATOR'){
      if(!own(exprOps,row.operator_key)&&!['IF','AND','OR'].includes(row.operator_key))fail('UNSUPPORTED_OPERATOR','Expression node operator is not registered',{operator:row.operator_key});args.sort((a,b)=>integer(a.arg_index,'arg_index')-integer(b.arg_index,'arg_index'));args.forEach((a,i)=>{if(a.arg_index!==i)fail('ARGUMENT_INDEX','Child argument indexes must be unique contiguous 0..n-1',{node_id:id});});result={kind:'op',operator:requireKey(row.operator_key,'operator_key'),args:args.map(build)};
    }else{if(args.length)fail('LEAF_CHILDREN','Non-operator node cannot have children',{node_id:id});result=compileValueRow(row,'node_kind');}active.delete(id);return result;};
  const ast=build(roots[0]);if(seen.size!==rows.length)fail('EXPRESSION_DISCONNECTED','Expression contains unreachable nodes or a disconnected cycle');return ast;
}

const CALENDAR_PROJECTIONS={base_year:['epoch_year'],year_season_conversion:['seasons_per_year'],season_month_conversion:['months_per_season','months_per_year'],month_day_conversion:['days_per_month','mode'],week_day_conversion:['days_per_week'],day_time_units:['hours_per_day','minutes_per_hour','ticks_per_minute'],time_order_rule:['epoch_year','year_numbering']};
function hydrateCalendarProjections(tables,calendars){
  for(const world of tables.T_STATIC_WORLDS??[]){
    if(world.__record_state==='template')continue;
    const matches=Object.values(calendars).filter(c=>c.world_ref===world.row_uuid),explicit=world.calendar_id;
    if(matches.length>1&&blank(explicit))fail('AMBIGUOUS_CALENDAR','World has multiple calendars but no selected calendar identity',{world_ref:world.row_uuid});
    const cal=!blank(explicit)?calendars[explicit]:matches[0];
    if(!blank(explicit)&&!cal)fail('BROKEN_REFERENCE','World calendar identity does not resolve',{world_ref:world.row_uuid,calendar_ref:explicit});
    if(cal&&!blank(cal.world_ref)&&cal.world_ref!==world.row_uuid)fail('CALENDAR_WORLD','Selected calendar belongs to another world',{world_ref:world.row_uuid,calendar_ref:cal.calendar_id});
    world.__value_states??={};world.calendar_id=cal?.calendar_id??null;world.__value_states.calendar_id=cal?'known':'unknown';
    for(const [field,keys] of Object.entries(CALENDAR_PROJECTIONS)){
      const state=!cal?'unknown':cal.value_state??'known';let value=null,known=state==='known';
      if(known&&cal.mode==='SEASON_FIXED'&&['season_month_conversion','month_day_conversion'].includes(field)){world[field]=null;world.__value_states[field]='not_applicable';continue;}
      if(known){
        if(field==='month_day_conversion'&&cal.mode==='MONTH_TABLE'){
          known=cal.month_lengths.length>0&&cal.month_lengths.every(r=>(r.value_state??'known')==='known'&&!blank(r.month)&&!blank(r.days));
          value={mode:cal.mode,month_lengths:cal.month_lengths.map(r=>({month:r.month,days:r.days})),leap_rules:cal.leap_rules.map(r=>({...r}))};
        }else{known=keys.every(k=>!blank(cal[k])&&(!cal.__value_states?.[k]||cal.__value_states[k]==='known'));value=keys.length===1?cal[keys[0]]:Object.fromEntries(keys.map(k=>[k,cal[k]??null]));}
      }
      world[field]=known?value:null;world.__value_states[field]=known?'known':state==='known'?'unknown':state;
    }
  }
}

/** Registration required_when validates presence; it never grants or denies reading a known value. */
export function validateRegistrationRequirements(tables,bindings,registration={}){
  const nodes=registration.conditions??registration.nested_tables?.R_CONDITION_NODES??[],declarations=registration.declarations?.register_parameter??[],checks=[];
  const byId=new Map();for(const node of nodes){const id=requireKey(node.row_uuid,'registration condition row_uuid');if(byId.has(id))fail('DUPLICATE_CONDITION_NODE','Registration condition identity is duplicated',{row_uuid:id});byId.set(id,node);}
  const knownStates=['known','已知','已确认','有值'],absentStates=['unset','none','cleared','not_applicable'];
  for(const binding of bindings){
    const declarationsForKey=declarations.filter(d=>d.values?.parameter_key===binding.parameter_key);
    if(declarationsForKey.length>1)fail('DUPLICATE_PARAMETER_DEFINITION','Registration parameter declaration is duplicated',{parameter_key:binding.parameter_key});
    const declaration=declarationsForKey[0],conditionRef=binding.condition_ref??declaration?.values?.condition_ref;if(blank(conditionRef))continue;
    const first=byId.get(conditionRef);if(!first)fail('BROKEN_CONDITION_REFERENCE','Registered required_when does not resolve',{parameter_key:binding.parameter_key,condition_ref:conditionRef});
    const ownerId=binding.registration_row_uuid??declaration?.row_uuid;
    if(first.owner_form!=='register_parameter'||first.owner_field!=='condition_ref'||(!blank(ownerId)&&first.owner_row_uuid!==ownerId))fail('CONDITION_OWNER','Registered required_when belongs to a different declaration',{parameter_key:binding.parameter_key,condition_ref:conditionRef});
    const group=nodes.filter(n=>n.owner_form===first.owner_form&&n.owner_row_uuid===first.owner_row_uuid&&n.owner_field===first.owner_field&&n.group_key===first.group_key);
    requireKey(first.group_key,'condition group_key');const modes=new Set(group.map(n=>n.combine));if(modes.size!==1||!['all','any'].includes(first.combine))fail('CONDITION_COMBINE','Registration condition group requires one all/any mode');
    ordered(group);const common=['__COMMON__','@COMMON'].includes(binding.table_id),concreteTables=[...new Set(group.map(n=>n.target_table).filter(t=>!['__COMMON__','@COMMON'].includes(t)))];
    if(common&&concreteTables.length>1)fail('CONDITION_RECORD_CONTEXT','Common parameter conditions cannot span different target tables');
    const tableIds=common?(concreteTables.length?concreteTables:Object.keys(tables).filter(t=>!t.startsWith('M_')&&!t.startsWith('R_'))):[binding.table_id];
    const records=tableIds.flatMap(table_id=>(tables[table_id]??[]).filter(r=>r.__record_state!=='template').map(row=>({table_id,row})));
    if(!records.length){checks.push({parameter_key:binding.parameter_key,condition_ref:conditionRef,status:'pending',reason:'MISSING_PARAMETER_CONTEXT',access_policy_changed:false});continue;}
    for(const {table_id,row} of records){
      const results=[];
      for(const node of group){
        if(node.target_table!==table_id&&!['__COMMON__','@COMMON'].includes(node.target_table))fail('CONDITION_RECORD_CONTEXT','Registration conditions can only compare fields on the same target record',{parameter_key:binding.parameter_key,target_table:table_id,condition_table:node.target_table});
        requireKey(node.target_field,'condition target_field');
        if(node.comparator!=='exists'){if(node.rhs_type==='number')num(node.rhs_number,'rhs_number');else if(node.rhs_type==='text')missing(node.rhs_text,'rhs_text');else if(node.rhs_type==='boolean')bool(node.rhs_boolean,'rhs_boolean');else fail('CONDITION_RHS','Registration condition right value kind is unsupported');}
        const target={table_id,row_uuid:row.row_uuid,field_key:node.target_field},owner={owner_table:table_id,owner_row_uuid:row.row_uuid,owner_field:binding.field_key};
        const translated={row_uuid:node.row_uuid,...owner,group_key:first.group_key,sequence:0,combine:'all',predicate_kind:'comparison',comparator:node.comparator,lhs_ref:target,rhs_kind:node.rhs_type,rhs_number:node.rhs_number,rhs_text:node.rhs_text,rhs_boolean:node.rhs_boolean,value_state:'known'};
        try{results.push({row_uuid:node.row_uuid,value:evaluateConditionGroup({...tables,M_CONDITIONS:[translated]},owner,first.group_key).passed});}
        catch(error){if(error instanceof MechanicalError&&['VALUE_STATE','MISSING_FIELD','MISSING_INPUT'].includes(error.code))results.push({row_uuid:node.row_uuid,value:null,reason:error.code,state:error.details?.state??null});else throw error;}
      }
      const values=results.map(r=>r.value),condition=first.combine==='all'?(values.includes(false)?false:values.includes(null)?null:true):(values.includes(true)?true:values.includes(null)?null:false),state=row.__value_states?.[binding.field_key]??(!blank(row[binding.field_key])?'known':'unset');
      const base={parameter_key:binding.parameter_key,table_id,row_uuid:row.row_uuid,field_key:binding.field_key,condition_ref:conditionRef,condition,condition_checks:results,value_state:state,access_policy_changed:false};
      if(condition===null){checks.push({...base,status:'pending',reason:'REQUIRED_WHEN_UNKNOWN'});continue;}
      if(!condition){checks.push({...base,status:'valid',required:false});continue;}
      if(!knownStates.includes(state)&&!absentStates.includes(state)){checks.push({...base,status:'pending',required:true,reason:'REQUIRED_VALUE_UNKNOWN'});continue;}
      if(absentStates.includes(state)||blank(row[binding.field_key]))fail('REQUIRED_PARAMETER_MISSING','Required registered parameter is missing on a record whose required_when is true',base);
      checks.push({...base,status:'valid',required:true});
    }
  }
  return {status:checks.some(c=>c.status==='pending')?'PENDING':'VALID',checks,access_policy_changed:false,committed:false};
}

export function compileWorkbookPayload(payload){
  if(payload.validation?.status==='INVALID'||payload.validation==='INVALID'||payload.validation?.valid===false)fail('INVALID_PAYLOAD','Workbook exporter marked payload invalid',{validation:payload.validation});
  const tables=normalizeTables(payload),calendars={},unit_ratios=compileUnitRatios(tables),scopes={};
  if(tables.M_UNIT_RATIOS)tables.M_UNIT_RATIOS=unit_ratios.map(r=>({...r,__value_states:{...(r.__value_states??{}),dimension:'known',calendar_ref:blank(r.calendar_ref)?'none':'known',denominator:r.conversion_mode==='LINEAR_FACTOR'?'known':r.value_state??'unset',offset:['LINEAR_FACTOR','FRACTION'].includes(r.conversion_mode)?'known':r.value_state??'unset'}}));
  validateOwnerInheritance(tables);const owned_values=hydrateOwnedFields(tables);
  for(const row of tables.M_CALENDAR_RULES??[]){
    const id=row.calendar_id??row.row_uuid;if(blank(id))continue;requireKey(id,'calendar_id');if(row.row_uuid&&row.calendar_id&&row.row_uuid!==row.calendar_id)fail('CALENDAR_IDENTITY','Calendar ID alias differs from row_uuid');if(own(calendars,id))fail('DUPLICATE_CALENDAR','Calendar ID is duplicated',{calendar_id:id});
    calendars[id]={...row,calendar_id:id,month_lengths:(tables.M_CALENDAR_MONTHS??[]).filter(r=>r.calendar_ref===id),leap_rules:(tables.M_CALENDAR_EXCEPTIONS??[]).filter(r=>r.calendar_ref===id)};
    if(row.mode==='SEASON_FIXED'&&(row.value_state??'known')==='known')calendarConfig(calendars[id]);
    if((row.value_state??'known')==='known'&&['seasons_per_year','months_per_season'].every(k=>!blank(row[k])&&(!row.__value_states?.[k]||row.__value_states[k]==='known'))){
      const product=positiveInteger(row.seasons_per_year,'seasons_per_year')*positiveInteger(row.months_per_season,'months_per_season');integer(product,'months_per_year');
      if(!blank(row.months_per_year)&&(!row.__value_states?.months_per_year||row.__value_states.months_per_year==='known')&&row.months_per_year!==product)fail('CALENDAR_RATIO_CONFLICT','Direct months_per_year differs from seasons multiplied by months_per_season');
      if(blank(row.months_per_year)){
        const evidence={kind:'multiply',source_fields:['seasons_per_year','months_per_season'].map(field_key=>({table_id:'M_CALENDAR_RULES',row_uuid:row.row_uuid,field_key})),input_write:false};
        row.months_per_year=product;row.__value_states??={};row.__value_states.months_per_year='known';row.__cell_metadata={...(row.__cell_metadata??{}),months_per_year:{derived:evidence}};
        calendars[id]={...calendars[id],months_per_year:product,__value_states:{...(row.__value_states??{})},__cell_metadata:row.__cell_metadata};
      }
    }
  }
  hydrateCalendarProjections(tables,calendars);
  const scopeFor=row=>{const key=ownerScope(row);scopes[key]??={owner_table:row.owner_table??'',owner_row_uuid:row.owner_row_uuid??'',formulas:{},bindings:{},macros:{},rules:{},policies:{}};return scopes[key];};
  const selectedExecutions=new Map();
  for(const row of tables.T_SYS_FORMULA_AND_SM??[]){if(blank(row.operator)&&row.enabled!==true)continue;const owner={owner_table:'T_SYS_FORMULA_AND_SM',owner_row_uuid:row.row_uuid},s=scopeFor(owner);s.rules[row.row_uuid]={operator_key:row.operator,enabled:row.enabled===true,arguments:{}};if(row.enabled===true){requireKey(row.operator,'operator');selectedExecutions.set(JSON.stringify([ownerScope(owner),row.row_uuid]),row.operator);}}
  for(const row of tables.M_MACRO_STEPS??[])if(row.enabled===true)selectedExecutions.set(JSON.stringify([ownerScope(row),row.step_id??row.row_uuid]),row.operator_key);
  for(const row of tables.M_POLICY_RULES??[])if(row.implementation_kind==='registered_script'&&row.value_state==='known')selectedExecutions.set(JSON.stringify([ownerScope(row),row.policy_key]),row.script_key);
  const nodeGroups=new Map();for(const row of tables.M_EXPRESSION_NODES??[]){if(blank(row.rule_ref)&&blank(row.node_kind))continue;requireKey(row.rule_ref,'rule_ref');const k=JSON.stringify([ownerScope(row),row.rule_ref]);if(!nodeGroups.has(k))nodeGroups.set(k,[]);nodeGroups.get(k).push(row);}
  for(const rows of nodeGroups.values())scopeFor(rows[0]).formulas[rows[0].rule_ref]=compileExpressionNodes(rows);
  for(const row of tables.M_FORMULA_BINDINGS??[]){
    if(blank(row.execution_ref)&&blank(row.source_kind))continue;requireKey(row.execution_ref,'execution_ref');requireKey(row.parameter_name,'parameter_name');const selected=selectedExecutions.get(JSON.stringify([ownerScope(row),row.execution_ref]));if(!blank(row.template_operator)&&selected!==row.template_operator)continue;
    const optional=(selected==='TIMER_TICK'&&row.parameter_name==='repeat_interval')||(selected==='UNIT_CONVERT'&&['calendar_ref','scope_world_id'].includes(row.parameter_name))||selected==='WEIGHTED_DIST';
    const raw=row.source_kind==='NUMBER'?row.number_value:row.source_kind==='TEXT'?row.text_value:row.source_kind==='BOOLEAN'?row.boolean_value:undefined;if(optional&&['NUMBER','TEXT','BOOLEAN'].includes(row.source_kind)&&blank(raw))continue;
    const s=scopeFor(row);s.bindings[row.execution_ref]??={};if(own(s.bindings[row.execution_ref],row.parameter_name))fail('DUPLICATE_BINDING','Parameter is bound twice in one execution scope',{execution_ref:row.execution_ref,parameter_name:row.parameter_name});s.bindings[row.execution_ref][row.parameter_name]=compileValueRow(row,'source_kind');
  }
  for(const row of tables.T_SYS_FORMULA_PARAMETERS??[]){
    if(row.__record_state==='template'||(blank(row.rule_ref)&&blank(row.param_name)))continue;
    const ruleId=fieldValue(row,'rule_ref'),parameterName=requireKey(fieldValue(row,'param_name'),'param_name'),rule=singleRecord(tables,'T_SYS_FORMULA_AND_SM',ruleId),signatureType=OPERATOR_SIGNATURES[rule.operator]?.[parameterName];row.value_type=signatureType??null;row.__value_states??={};row.__value_states.value_type=signatureType?'known':'unknown';
    const candidates=['source_coordinate','literal_number','literal_text'].filter(k=>!blank(row[k])&&(!row.__value_states?.[k]||row.__value_states[k]==='known'));
    if(candidates.length!==1)fail('PARAMETER_SOURCE','Original formula parameter requires exactly one known source coordinate or literal',{row_uuid:row.row_uuid,sources:candidates});
    const source=candidates[0];let node;
    if(source==='source_coordinate'){const coordinate=resolveRegisteredReference(tables,fieldValue(row,source),{value:false});requireKey(coordinate.field_key,'source field');node={kind:'cell',...coordinate};}
    else node={kind:'literal',value:source==='literal_number'?num(fieldValue(row,source),'literal_number'):fieldValue(row,source)};
    const scope=scopeFor({owner_table:'T_SYS_FORMULA_AND_SM',owner_row_uuid:ruleId});scope.bindings[ruleId]??={};
    if(own(scope.bindings[ruleId],parameterName))fail('DUPLICATE_BINDING','Original parameter table and mechanical bindings specify the same argument',{rule_ref:ruleId,parameter_name:parameterName});
    scope.bindings[ruleId][parameterName]=node;
  }
  const d100Groups=new Map();for(const row of tables.M_D100_INTERVALS??[]){if(blank(row.execution_ref))continue;const k=JSON.stringify([ownerScope(row),row.execution_ref]);if(!d100Groups.has(k))d100Groups.set(k,[]);d100Groups.get(k).push(row);}
  for(const rows of d100Groups.values()){const first=rows[0],s=scopeFor(first);s.bindings[first.execution_ref]??={};if(own(s.bindings[first.execution_ref],'ranges'))fail('D100_RANGE_SOURCE','D100 ranges have both a binding and interval rows');s.bindings[first.execution_ref].ranges=litRows(rows.map(r=>({minimum:integer(r.minimum,'minimum'),maximum:integer(r.maximum,'maximum'),value:r.outcome_type==='NUMBER'?num(r.number_value,'number_value'):r.outcome_type==='BOOLEAN'?bool(r.boolean_value,'boolean_value'):r.outcome_type==='TEXT'?missing(r.text_value,'text_value'):fail('D100_OUTCOME_TYPE','D100 outcome type is unsupported')})));}
  for(const s of Object.values(scopes))for(const [key,rule] of Object.entries(s.rules)){rule.arguments={...(s.bindings[key]??{})};if(rule.operator_key==='CUSTOM_EXPR'&&s.formulas[key])rule.arguments.expression=s.formulas[key];}
  for(const row of tables.M_MACRO_STEPS??[]){
    if(blank(row.macro_ref)&&blank(row.operator_key))continue;if(row.enabled===false)continue;bool(row.enabled,'enabled');requireKey(row.macro_ref,'macro_ref');requireKey(row.step_id??row.row_uuid,'step_id');const s=scopeFor(row);s.macros[row.macro_ref]??={macro_ref:row.macro_ref,steps:[]};const step={step_id:row.step_id??row.row_uuid,sequence:integer(row.sequence,'sequence'),operator_key:row.operator_key,arguments:{...(s.bindings[row.step_id??row.row_uuid]??{})}};
    if(row.operator_key==='CUSTOM_EXPR'){const canonical=scopes[JSON.stringify(['T_SYS_FORMULA_AND_SM',row.rule_ref])],ast=s.formulas[row.rule_ref]??canonical?.formulas?.[row.rule_ref];if(!ast)fail('MISSING_FORMULA','Macro expression formula is absent from its owner or registered formula scope',{rule_ref:row.rule_ref});step.arguments.expression=ast;}
    const coord=[row.output_table,row.output_row_uuid,row.output_field];if(coord.some(v=>!blank(v))){if(coord.some(blank))fail('OUTPUT_COORDINATE','Output coordinate must contain table, row and field');step.output_coordinate={table_id:row.output_table,row_uuid:row.output_row_uuid,field_key:row.output_field};step.result_path=row.result_path;}
    s.macros[row.macro_ref].steps.push(step);
  }
  for(const s of Object.values(scopes))for(const macro of Object.values(s.macros)){macro.steps.sort((a,b)=>a.sequence-b.sequence);macroOrder(macro);}
  for(const row of tables.M_POLICY_RULES??[]){
    if(blank(row.policy_key)&&blank(row.implementation_kind))continue;const s=scopeFor(row),key=requireKey(row.policy_key,'policy_key');if(own(s.policies,key))fail('DUPLICATE_POLICY','Policy key is duplicated in owner scope',{policy_key:key});const arguments_={...(s.bindings[key]??{})};
    const values=[['number_value',row.number_value],['text_value',row.text_value],['boolean_value',row.boolean_value]].filter(([,v])=>!blank(v));
    if(!blank(row.parameter_key)){requireKey(row.parameter_key,'parameter_key');if(values.length!==1)fail('POLICY_PARAMETER_VALUE','Policy direct parameter requires exactly one typed value');if(own(arguments_,row.parameter_key))fail('DUPLICATE_BINDING','Policy direct parameter also has a binding',{parameter_key:row.parameter_key});arguments_[row.parameter_key]=litRows(values[0][1]);}
    else if(values.length)fail('POLICY_PARAMETER_KEY','Policy has a direct value but no parameter key');
    s.policies[key]={...row,arguments:arguments_};
  }
  const source_integrity=computeSourceIntegrity(tables,payload.source_manifests??[]);
  const derived_projections=deriveReadOnlyProjections(tables,payload.derivations??[]);
  for(const projection of derived_projections){const row=singleRecord(tables,projection.table_id,projection.row_uuid);row[projection.field_key]=projection.status==='derived'?projection.value:null;row.__value_states??={};row.__value_states[projection.field_key]=projection.status==='derived'?'known':'unknown';}
  const registration_validation=validateRegistrationRequirements(tables,payload.parameter_bindings??[],payload.registration_proposals??{});
  return {schema:'tisya.compiled-mechanical.v1',tables,parameters:{...(payload.parameters??{})},parameter_bindings:[...(payload.parameter_bindings??[])],calendars,unit_ratios,scopes,owned_values,derived_projections,source_integrity,registration_validation,source_validation:payload.validation??null,committed:false};
}

export function runCompiledMacro(compiled,macroRef,owner){
  const key=ownerScope(owner??{}),scope=compiled.scopes[key];if(!scope||!own(scope.macros,macroRef))fail('MISSING_MACRO','Macro is absent from the requested owner scope',{macro_ref:macroRef,owner_scope:key});return runMacro(scope.macros[macroRef],{...compiled,active_owner:owner});
}

const litRows=value=>({kind:'literal',value});
export function evaluateCompiledFormula(compiled,ruleRef,owner,stack=new Set()){
  const key=ownerScope(owner??{});let scope=compiled.scopes[key];if(!scope||(!own(scope.formulas,ruleRef)&&!own(scope.rules??{},ruleRef)))scope=compiled.scopes[JSON.stringify(['T_SYS_FORMULA_AND_SM',ruleRef])];
  if(!scope||(!own(scope.formulas,ruleRef)&&!own(scope.rules??{},ruleRef)))fail('MISSING_FORMULA','Formula is absent from requested owner or registered formula scope',{rule_ref:ruleRef,owner_scope:key});
  const identity=JSON.stringify([scope.owner_table,scope.owner_row_uuid,ruleRef]);if(stack.has(identity))fail('FORMULA_CYCLE','Registered formulas contain a dependency cycle',{rule_ref:ruleRef});const active=new Set(stack);active.add(identity);
  const active_owner={owner_table:scope.owner_table,owner_row_uuid:scope.owner_row_uuid};const parameters={...compiled.parameters};for(const [name,node] of Object.entries(scope.bindings[ruleRef]??{}))parameters[name]=evaluateExpression(node,{...compiled,parameters,active_owner});
  if(own(scope.rules??{},ruleRef)){const rule=scope.rules[ruleRef];if(!rule.enabled)fail('RULE_DISABLED','Formula record is not enabled',{rule_ref:ruleRef});const args={};for(const [name,node] of Object.entries(rule.arguments))args[name]=name==='expression'?node:evaluateExpression(node,{...compiled,parameters});return executeOperator(rule.operator_key,args,{...compiled,parameters,active_owner:{owner_table:scope.owner_table,owner_row_uuid:scope.owner_row_uuid},formula_stack:active});}
  return evaluateExpression(scope.formulas[ruleRef],{...compiled,parameters});
}

export function executePolicy(compiled,policyKey,owner){
  const scope=compiled.scopes[ownerScope(owner)],policy=scope?.policies?.[policyKey];if(!policy)fail('MISSING_POLICY','Policy is absent from owner scope',{policy_key:policyKey});knownRow(policy);
  if(!blank(policy.condition_ref)){const c=singleRecord(compiled.tables,'M_CONDITIONS',policy.condition_ref);if(!evaluateConditionGroup(compiled.tables,c,c.group_key).passed)return {status:'condition_false',committed:false};}
  if(policy.implementation_kind==='narrative_only')return {status:'narrative_only',narrative:policy.narrative??'',committed:false};
  if(policy.implementation_kind==='registered_formula'){const parameters={...compiled.parameters};for(const [key,node] of Object.entries(policy.arguments))parameters[key]=evaluateExpression(node,compiled);return {status:'calculated',value:evaluateCompiledFormula({...compiled,parameters},requireKey(policy.formula_ref,'formula_ref'),owner),committed:false};}
  if(policy.implementation_kind==='registered_script'){const args={};for(const [key,node] of Object.entries(policy.arguments))args[key]=evaluateExpression(node,compiled);return {status:'calculated',value:executeOperator(requireKey(policy.script_key,'script_key'),args,{...compiled,active_owner:owner}),committed:false};}
  fail('POLICY_IMPLEMENTATION','Policy implementation kind is unsupported');
}

// Standard-library-only CLI. Calculating never commits proposed writes to a host.
if(typeof process!=='undefined'&&process.argv[1]){
  const {pathToFileURL}=await import('node:url');
  if(import.meta.url===pathToFileURL(process.argv[1]).href){
    const fs=await import('node:fs/promises');
    const args=process.argv.slice(2),input=args[0];
    const option=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined;};
    try{
      if(!input||input.startsWith('--'))fail('CLI_USAGE','Usage: node mechanical_runtime.mjs input.json --output result.json [--macro KEY | --formula KEY] [--owner-table T --owner-row R]');
      const payload=JSON.parse(await fs.readFile(input,'utf8'));
      if(option('--source-file')){
        const entry_id=requireKey(option('--entry-id'),'entry-id'),revision=Number(option('--revision'));integer(revision,'revision');const bytes=await fs.readFile(option('--source-file'));
        new TextDecoder('utf-8',{fatal:true}).decode(bytes);const fragments=(payload.tables?.T_SYS_SOURCE_FRAGMENTS??[]).map(r=>r.values?{...r.values,row_uuid:r.row_uuid}:r).filter(r=>r.entry_id===entry_id&&r.revision===revision);if(!fragments.length)fail('SOURCE_FRAGMENTS','No matching fragments in payload');
        const indices=fragments.map(r=>integer(r.chunk_index,'chunk_index'));payload.source_manifests??=[];payload.source_manifests.push({entry_id,revision,expected_chunks:fragments.length,first_chunk_index:Math.min(...indices),sha256:createHash('sha256').update(bytes).digest('hex'),source_file:option('--source-file'),evidence:'actual_local_bytes'});
      }
      const compiled=compileWorkbookPayload(payload),owner={owner_table:option('--owner-table')??'',owner_row_uuid:option('--owner-row')??'',owner_field:option('--owner-field')??''};
      const result=option('--macro')?runCompiledMacro(compiled,option('--macro'),owner):option('--formula')?{status:'calculated',value:evaluateCompiledFormula(compiled,option('--formula'),owner),committed:false}:option('--policy')?executePolicy(compiled,option('--policy'),owner):args.includes('--effects')?calculateEffects(compiled,owner):compiled;
      const text=JSON.stringify(result,null,2)+'\n',output=option('--output');if(output)await fs.writeFile(output,text);else process.stdout.write(text);
    }catch(error){const result={status:'error',error:error instanceof MechanicalError?error.toJSON():{code:'RUNTIME_ERROR',message:error.message},committed:false};const text=JSON.stringify(result,null,2)+'\n',output=option('--output');if(output)await fs.writeFile(output,text);process.stderr.write(text);process.exitCode=1;}
  }
}
