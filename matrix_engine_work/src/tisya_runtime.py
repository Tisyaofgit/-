"""Shared matrix state, registered actions, world time, memory and projections."""
from __future__ import annotations
import copy, hashlib, json, math, random, re, uuid
from decimal import Decimal
from pathlib import Path
from datetime import datetime,timezone
from matrix_io import EngineError, MatrixBook, decode_value, encoded_value, address, col
from rule_math import Formula, WorldClock


def stable_json(v):return json.dumps(v,ensure_ascii=False,sort_keys=True,separators=(',',':'))
def digest(v):return hashlib.sha256(stable_json(v).encode()).hexdigest()
def now():return datetime.now(timezone.utc).isoformat()


class Runtime:
    def __init__(self,state=None,book=None,seed=0):
        self.data=copy.deepcopy(state or {'schema':{},'tables':{},'runtime':{},'format':'tisya.matrix-state.v1'});self.book=book
        self.data.setdefault('runtime',{});r=self.data['runtime']
        for k,default in {'revision':0,'receipts':{},'failures':[],'sources':{},'archive_queue':[],'archive':[],'turn_order':[],'events':[],'preferences':[],'scope':{}}.items():r.setdefault(k,copy.deepcopy(default))
        self.rng=random.Random(seed);self.cache={};self.stack=[];self.errors={};self._in_tx=False
        if r.get('rng_state'):
            def tuples(v):return tuple(tuples(x) for x in v) if isinstance(v,list) else v
            self.rng.setstate(tuples(r['rng_state']))
        self.operators={'USE':self._use,'CRAFT':self._craft,'BUY':self._trade,'SELL':self._trade,'QUEST_ACCEPT':self._quest,'QUEST_SUBMIT':self._quest,'BUILD_UPGRADE':self._build,'ASSIGN_WORKER':self._assign,'STEPS':self._steps,'CHECK':self._check,'PROCESS_ADVANCE':self._process}
        self.clock_listeners=[]
        self.schema_undo=[]
        from domain_nodes import install
        install(self)
        from mechanical_adapter import install as install_mechanical
        install_mechanical(self)
        from persona_bridge import install as install_persona
        install_persona(self)
    @classmethod
    def from_xlsx(cls,path,catalog):
        b=MatrixBook(path,catalog);return cls(b.read(),book=b)
    @classmethod
    def from_json(cls,path):return cls(json.loads(Path(path).read_text()))
    def register_operator(self,name,handler):self.operators[name.upper()]=handler
    def register_table(self,tid,fields,label=None):
        fields=[copy.deepcopy(f) for f in fields]
        if not any(f['key']=='row_uuid' for f in fields):fields.insert(0,{'key':'row_uuid','label':'稳定记录ID','type':'ID'})
        self.data['schema'][tid]={'id':tid,'label':label or tid,'fields':fields,'sheet':label or tid};self.data['tables'].setdefault(tid,{})
    def declare_field(self,tid,spec):
        if tid not in self.data['schema']:raise EngineError('TABLE_MISSING','Register a table before adding fields',table=tid)
        if not spec.get('key') or not spec.get('type'):raise EngineError('FIELD_DEFINITION','Field key and type are required')
        if any(f['key']==spec['key'] for f in self.data['schema'][tid]['fields']):raise EngineError('FIELD_EXISTS','Field already exists',table=tid,field=spec['key'])
        self.data['schema'][tid]['fields'].append(copy.deepcopy(spec))
        if self._in_tx:self.schema_undo.append((tid,spec['key']))
        return spec
    def rows(self,tid):return self.data['tables'].get(tid,{})
    def new_record(self,tid,values=None,rid=None):
        if tid not in self.data['schema']:raise EngineError('TABLE_MISSING','Register the table before adding records',table=tid)
        rid=rid or str(uuid.uuid4())
        if rid in self.rows(tid):raise EngineError('DUPLICATE_ID','Record already exists',table=tid,record=rid)
        for key,value in (values or {}).items():
            spec=self._spec(tid,key)
            if spec.get('alias_of') in {'row_uuid','common.row_uuid'} or key=='row_uuid':
                if value!=rid:raise EngineError('IDENTITY_CHANGE','ID aliases must match record ID',table=tid,field=key)
            else:decode_value(value,spec)
        rec={'values':{'row_uuid':rid},'states':{'row_uuid':'known'},'formulas':{},'metadata':{}}
        self.data['tables'].setdefault(tid,{})[rid]=rec
        for f in self.data['schema'][tid]['fields']:
            if f.get('alias_of') in {'row_uuid','common.row_uuid'}:rec['values'][f['key']]=rid;rec['states'][f['key']]='known'
        for key,value in (values or {}).items():self.set(f'{tid}#{rid}.{key}',value)
        scope=self.data['runtime'].get('scope',{})
        if tid!='X_RECORD_META' and 'X_RECORD_META' in self.data['schema'] and any(scope.get(k) for k in ['world_ref','session_ref','branch_ref']):
            meta={'table_id':tid,'record_id':rid,'record_revision':0,'record_status':'草稿','default_source_status':'待确认'}
            for src,dest in [('world_ref','scope_world_id'),('session_ref','scope_session_id'),('branch_ref','scope_branch_id')]:
                if scope.get(src):meta[dest]=scope[src]
            self.new_record('X_RECORD_META',meta,str(uuid.uuid5(uuid.NAMESPACE_URL,tid+'#'+rid)))
        return rid
    def _record(self,tid,rid):
        if rid not in self.rows(tid):raise EngineError('RECORD_MISSING','Referenced record does not exist',table=tid,record=rid)
        return self.rows(tid)[rid]
    def _spec(self,tid,key):
        spec=next((f for f in self.data['schema'][tid]['fields'] if f['key']==key),None)
        if spec is None:raise EngineError('FIELD_MISSING','Referenced field is not registered',table=tid,field=key)
        return spec
    def _find(self,tid,token):
        if token in self.rows(tid):return token
        found=[rid for rid,rec in self.rows(tid).items() if token in {str(rec['values'].get(k,'')) for k in ['name','label','title']}]
        if len(found)!=1:raise EngineError('LOOKUP_MATCH','Lookup must resolve exactly one record',table=tid,token=token,matches=len(found))
        return found[0]
    def resolve(self,target,create=False):
        if isinstance(target,(tuple,list)) and len(target)==4:return tuple(target)
        target=str(target).strip()
        if '!' in target and '#' not in target:
            sheet,cell=target.rsplit('!',1);sheet=sheet.strip("'\"");cell=cell.replace('$','').upper()
            if self.book:
                matches=[(*key,[]) for key,value in self.book.locations.items() if value==(sheet,cell)]
                if len(matches)==1:return matches[0]
            raise EngineError('COORDINATE_MISSING','Coordinate is not an active object field',target=target)
        if '#' in target:
            tid,rest=target.split('#',1)
            if '.' not in rest:raise EngineError('REFERENCE_SYNTAX','Reference needs a field',target=target)
            rid,keypath=rest.split('.',1);key,*path=keypath.split('/');self._record(tid,rid);self._spec(tid,key);return tid,rid,key,path
        if '.' not in target:raise EngineError('REFERENCE_SYNTAX','Use table#record.field or object.property',target=target)
        subject,prop=target.rsplit('.',1);prop,*explicit_path=prop.split('/')
        # Explicit logical bindings take precedence over labels and compact object properties.
        matches=[r['values'] for r in self.rows('X_OBJECT_BINDINGS').values() if str(r['values'].get('object_ref'))==subject and r['values'].get('property_key')==prop]
        if len(matches)>1:raise EngineError('BINDING_DUPLICATE','Property has multiple owners',subject=subject,property=prop)
        if matches:
            b=matches[0];path=b.get('target_path') or [];path=json.loads(path) if isinstance(path,str) else path
            return b['target_table'],b['target_record'],b['target_field'],path
        found=[]
        for tid,rows in self.data['tables'].items():
            for rid,rec in rows.items():
                if subject not in {rid,str(rec['values'].get('name','')),str(rec['values'].get('subject_ref',''))}:continue
                for f in self.data['schema'][tid]['fields']:
                    if prop in {f['key'],f.get('label')}:found.append((tid,rid,f['key'],explicit_path))
                container=rec['values'].get('current_values')
                if isinstance(container,dict) and (prop in container or (create and not found)):found.append((tid,rid,'current_values',[prop]+explicit_path))
        if len(found)!=1:raise EngineError('PROPERTY_MATCH','Logical property must have one owner',target=target,matches=len(found))
        return found[0]
    def get(self,target):
        tid,rid,key,path=self.resolve(target);rec=self._record(tid,rid);ident=(tid,rid,key)
        if key in rec.get('formulas',{}):
            if ident in self.stack:raise EngineError('FORMULA_CYCLE','Formula dependency cycle',cycle=[list(x) for x in self.stack+[ident]])
            if ident not in self.cache:
                self.stack.append(ident)
                try:
                    sheet=self.book.locations.get(ident,('',))[0] if self.book else self.data['schema'][tid].get('sheet',tid)
                    value=self.expression(rec['formulas'][key],sheet=sheet);self.cache[ident]=value;rec['values'][key]=value;rec['states'][key]='derived';self.errors.pop('/'.join(ident),None)
                except EngineError as exc:rec['values'][key]=None;rec['states'][key]='error';self.errors['/'.join(ident)]=exc.as_dict();raise
                finally:self.stack.pop()
            value=self.cache[ident]
        else:
            status=rec['states'].get(key,'unset')
            if status not in {'known','derived'}:raise EngineError('VALUE_UNAVAILABLE','Referenced field is unavailable',table=tid,record=rid,field=key,state=status)
            value=rec['values'].get(key)
        for part in path:
            if not isinstance(value,(dict,list)) or (isinstance(value,dict) and part not in value):raise EngineError('NESTED_VALUE_MISSING','Nested property is unavailable',target=str(target),path=path)
            value=value[int(part)] if isinstance(value,list) else value[part]
        return value
    def set(self,target,value,state='known',allow_formula=False):
        tid,rid,key,path=self.resolve(target,create=True);rec=self._record(tid,rid);spec=self._spec(tid,key)
        if spec.get('alias_of') or key=='row_uuid':
            if value!=rid:raise EngineError('IDENTITY_CHANGE','Record identity is stable',target=str(target))
        if key in rec.get('formulas',{}) and not allow_formula:raise EngineError('DERIVED_WRITE','Update formula inputs instead of its result',target=str(target))
        if path:
            root=copy.deepcopy(rec['values'].get(key))
            if not isinstance(root,(dict,list)):raise EngineError('NESTED_CONTAINER','Nested value needs an initialized object',target=str(target))
            at=root
            for part in path[:-1]:at=at[int(part)] if isinstance(at,list) else at[part]
            if isinstance(at,list):at[int(path[-1])]=value
            else:at[path[-1]]=value
            value=root
        else:
            if state in {'known','derived'}:
                if isinstance(value,str) and spec.get('type') in {'NUMBER','INTEGER','DECIMAL','FLOAT','RATIO','INT'}:
                    gauge=re.fullmatch(r'([+-]?\d+(?:\.\d+)?)/([+-]?\d+(?:\.\d+)?)',value.strip())
                    if gauge:rec['metadata'].setdefault(key,{})['gauge_max']=float(gauge[2])
                value,decoded_state=decode_value(value,spec)
                if decoded_state!='known':state=decoded_state
        rec['values'][key]=value;rec['states'][key]=state;self.cache.clear();self.errors.clear()
        return value
    def delta(self,target,amount):
        old=self.get(target)
        if isinstance(old,bool) or not isinstance(old,(int,float)):raise EngineError('NUMBER_TYPE','Numeric delta needs a numeric field',target=str(target))
        exact=Decimal(str(old))+Decimal(str(amount));result=int(exact) if exact==exact.to_integral_value() else float(exact)
        if not math.isfinite(result):raise EngineError('NONFINITE','Delta result is nonfinite')
        self.set(target,result);return {'target':str(target),'before':old,'after':result,'delta':amount}
    def _cell(self,ref):
        try:return self.get(ref)
        except EngineError as exc:
            if exc.code!='COORDINATE_MISSING' or not self.book:raise
            sheet,a=ref.rsplit('!',1);a=a.replace('$','').upper();sheet=sheet.strip("'\"")
            raw=self.book.raw.get(sheet,{}).get(a)
            if raw is None:raise EngineError('VALUE_UNAVAILABLE','Referenced coordinate is empty',target=ref)
            return raw
    def _range(self,a,b):
        sheet,aa=a.rsplit('!',1);_,bb=b.rsplit('!',1);c1,r1=address(aa);c2,r2=address(bb);result=[]
        for rr in range(r1,r2+1):
            for cc in range(c1,c2+1):
                ref=f'{sheet}!{col(cc)}{rr}'
                if self.book and not any(v==(sheet,f'{col(cc)}{rr}') for v in self.book.locations.values()) and self.book.raw.get(sheet,{}).get(f'{col(cc)}{rr}') is None:result.append(None)
                else:result.append(self._cell(ref))
        return result
    def expression(self,text,context=None,sheet=''):
        def lookup(t,i,f):return self.get(f'{t}#{self._find(t,str(i))}.{f}')
        def where(t,filter_field,filter_value,sum_field=None):
            hits=[]
            for rid in self.rows(t):
                if self.get(f'{t}#{rid}.{filter_field}')==filter_value:hits.append(self.get(f'{t}#{rid}.{sum_field}') if sum_field else 1)
            return sum(hits)
        def bag_count(t,item):
            bag=self.get(t)
            if not isinstance(bag,dict):raise EngineError('BAG_TYPE','BAG_COUNT needs a bag')
            return bag.get(item,0)
        def bag_attr(t,attr):
            total=0
            for item,quantity in self.get(t).items():
                rid=self._find('X_ITEM_SPECS',item);total+=self.get(f'X_ITEM_SPECS#{rid}.{attr}')*quantity
            return total
        def matches(value,criterion):
            if not isinstance(criterion,str):return value==criterion
            m=re.fullmatch(r'(>=|<=|<>|>|<|=)(.*)',criterion)
            if not m:return str(value)==criterion
            rhs=m[2]
            try:rhs=float(rhs)
            except ValueError:pass
            return {'>=':lambda:value>=rhs,'<=':lambda:value<=rhs,'<>':lambda:value!=rhs,'>':lambda:value>rhs,'<':lambda:value<rhs,'=':lambda:value==rhs}[m[1]]()
        def sumifs(values,*pairs):
            if len(pairs)%2:raise EngineError('ARITY','SUMIFS needs range/criterion pairs')
            if any(len(pairs[i])!=len(values) for i in range(0,len(pairs),2)):raise EngineError('RANGE_SHAPE','Criteria ranges differ in length')
            return sum(v for i,v in enumerate(values) if isinstance(v,(int,float)) and all(matches(pairs[j][i],pairs[j+1]) for j in range(0,len(pairs),2)))
        funcs={'CELL':self._cell,'RANGE':self._range,'GET':self.get,'LOOKUP':lookup,'BAG_COUNT':bag_count,'SUM_BAG_ATTR':bag_attr,'SUM_WHERE':lambda t,f,v,s:where(t,f,v,s),'COUNT_WHERE':lambda t,f,v:where(t,f,v),'SUMIFS':sumifs,'SUMIF':lambda rng,criterion,vals=None:sumifs(vals or rng,rng,criterion),'COUNTIFS':lambda *p:sumifs([1]*len(p[0]),*p),'COUNTIF':lambda rng,c:sumifs([1]*len(rng),rng,c),'DICE':lambda sides:self.rng.randint(1,int(sides))}
        return Formula(funcs,context or {}).evaluate(str(text),current_sheet=sheet)
    def recalculate(self,strict=True):
        self.cache.clear();self.errors.clear()
        for tid,rows in self.data['tables'].items():
            for rid,rec in rows.items():
                for key in rec.get('formulas',{}):
                    try:self.get(f'{tid}#{rid}.{key}')
                    except EngineError:
                        if strict:raise
        return copy.deepcopy(self.errors)
    def validate(self,strict=False):
        issues=[];self.recalculate(strict=False)
        for tid,rows in self.data['tables'].items():
            for rid,rec in rows.items():
                for f in self.data['schema'][tid]['fields']:
                    key=f['key'];state=rec['states'].get(key,'unset');value=rec['values'].get(key)
                    if f.get('required') and not f.get('read_only') and not f.get('alias_of') and state not in {'known','derived'}:issues.append({'code':'REQUIRED_VALUE','level':'error' if strict else 'warning','table':tid,'record':rid,'field':key,'state':state})
                    if state=='known':
                        try:decode_value(value,f)
                        except EngineError as exc:issues.append(exc.as_dict()|{'level':'error','table':tid,'record':rid,'field':key})
                    target=f.get('ref')
                    if state=='known' and f.get('type')=='REF' and target in self.data['schema'] and value not in self.rows(target) and not (value=='GLOBAL' and f.get('allow_global')):issues.append({'code':'BROKEN_REFERENCE','level':'error','table':tid,'record':rid,'field':key,'value':value,'target_table':target})
        issues.extend(error|{'level':'error'} for error in self.errors.values());return issues
    def transaction(self,operation_id,request,callback):
        if self._in_tx:return callback()
        request_hash=digest(request);prior=self.data['runtime']['receipts'].get(operation_id)
        if prior:
            if prior['request_sha256']!=request_hash:raise EngineError('OPERATION_CONFLICT','Same operation ID has different input',operation_id=operation_id)
            return {'status':'REPLAY','receipt':copy.deepcopy(prior)}
        before=copy.deepcopy(self.data['tables']);meta=copy.deepcopy(self.data['runtime']);rng=self.rng.getstate();self._in_tx=True;self.schema_undo=[]
        try:
            result=callback();self.recalculate(strict=True);self.data['runtime']['revision']+=1
            self.data['runtime']['rng_state']=json.loads(json.dumps(self.rng.getstate()))
            receipt={'status':'COMMITTED','operation_id':operation_id,'request_sha256':request_hash,'revision':self.data['runtime']['revision'],'result':result,'written_utc':now()}
            self.data['runtime']['receipts'][operation_id]=receipt;return copy.deepcopy(receipt)
        except Exception as exc:
            self.data['tables']=before;self.data['runtime']=meta;self.rng.setstate(rng);self.cache.clear();self.stack=[];self.errors.clear()
            for tid,key in reversed(self.schema_undo):self.data['schema'][tid]['fields']=[f for f in self.data['schema'][tid]['fields'] if f['key']!=key]
            error=exc.as_dict() if isinstance(exc,EngineError) else {'code':'EXECUTION_ERROR','message':str(exc),'error_type':type(exc).__name__}
            failure={'status':'FAILED','operation_id':operation_id,'request':request,'error':error,'recorded_utc':now()};self.data['runtime']['failures'].append(failure)
            return failure
        finally:self._in_tx=False
    def _actor_target(self,ctx,kind):
        explicit=ctx.get(kind+'_target')
        if explicit:return explicit
        fields={'bag':'carry','store':'storage','currency':'money','stamina':'stamina','location':'location'}
        key=ctx.get('actor_'+kind+'_field') or fields[kind]
        if kind=='currency' and not ctx.get('actor_currency_field') and ctx.get('currency'):
            try:self.resolve(str(ctx['actor'])+'.money')
            except EngineError as exc:
                if exc.code=='PROPERTY_MATCH':key='wallet/'+str(ctx['currency'])
                else:raise
        return str(ctx['actor'])+'.'+str(key).format_map(ctx)
    def _quantity(self,ctx):
        q=ctx.get('quantity',1)
        if isinstance(q,bool) or not isinstance(q,(int,float)) or not math.isfinite(q) or q<=0:raise EngineError('QUANTITY','Quantity must be positive')
        return q
    def _bag_change(self,target,item,delta):
        bag=copy.deepcopy(self.get(target))
        if not isinstance(bag,dict):raise EngineError('BAG_TYPE','Container is not a bag',target=target)
        exact=Decimal(str(bag.get(item,0)))+Decimal(str(delta));after=int(exact) if exact==exact.to_integral_value() else float(exact)
        if after<0:raise EngineError('INSUFFICIENT_ITEMS','Container has insufficient items',target=target,item=item,available=bag.get(item,0),requested=-delta)
        if after==0:bag.pop(item,None)
        else:bag[item]=after
        self.set(target,bag);return after
    def transfer(self,source,destination,item,quantity,operation_id):
        def work():
            if quantity<=0:raise EngineError('QUANTITY','Transfer quantity must be positive')
            self._bag_change(source,item,-quantity);self._bag_change(destination,item,quantity);return {'source':source,'destination':destination,'item':item,'quantity':quantity}
        return self.transaction(operation_id,{'source':source,'destination':destination,'item':item,'quantity':quantity},work)
    def _item(self,ctx):
        table=ctx.get('definition_table') or 'X_ITEM_SPECS';rid=self._find(table,str(ctx['item']));rec=self._record(table,rid)
        return rec['values'],rid
    def effects(self,ops,ctx=None):
        ctx=ctx or {};out=[]
        if isinstance(ops,str):
            if ops.lstrip().startswith('['):ops=json.loads(ops)
            else:return [self.micro(x.strip(),ctx) for x in ops.split(';') if x.strip()]
        if not isinstance(ops,list):raise EngineError('EFFECT_TYPE','Effects must be a list of explicit operations')
        for op in ops:
            op=self._render(op,ctx);kind=op.get('op','SET').upper();target=op.get('target')
            if kind=='ADD':out.append(self.delta(target,op['value']))
            elif kind=='SET':self.set(target,op.get('value'),op.get('state','known'));out.append(op)
            elif kind in {'BAG_ADD','BAG_REMOVE'}:self._bag_change(target,op['item'],op['quantity']*(1 if kind=='BAG_ADD' else -1));out.append(op)
            elif kind=='TRANSFER':self._bag_change(target,op['item'],-op['quantity']);self._bag_change(op['destination'],op['item'],op['quantity']);out.append(op)
            elif kind=='ASSERT':
                if not self.expression(op['condition'],ctx):raise EngineError('CONDITION','Condition not satisfied',condition=op['condition'])
            elif kind=='TAG':self._tag(target,op['name'],op.get('duration'));out.append(op)
            elif kind=='EVENT':self.data['runtime']['events'].append(op['value']);out.append(op)
            elif kind=='ACTION':out.append(self.action(op['action'],op.get('arguments',{}),operation_id='nested'))
            else:raise EngineError('EFFECT_OPERATOR','Unknown effect operator',operator=kind)
        return out
    @staticmethod
    def _render(obj,ctx):
        if isinstance(obj,str):
            try:return obj.format_map(ctx)
            except KeyError as exc:raise EngineError('ARGUMENT_MISSING','Missing action parameter',argument=str(exc))
        if isinstance(obj,list):return [Runtime._render(v,ctx) for v in obj]
        if isinstance(obj,dict):return {k:Runtime._render(v,ctx) for k,v in obj.items()}
        return obj
    def action(self,name,arguments=None,operation_id=None):
        args=copy.deepcopy(arguments or {});name=name.upper();args['action']=name
        definitions=[r['values'] for rid,r in self.rows('X_ACTIONS').items() if rid.upper()==name or str(r['values'].get('name','')).upper()==name or str(r['values'].get('handler','')).upper()==name]
        if len(definitions)>1:raise EngineError('ACTION_DUPLICATE','Multiple action definitions match',action=name)
        definition=definitions[0] if definitions else {};args={k:v for k,v in definition.items() if v is not None}|args
        handler=str(definition.get('handler') or name).upper()
        def work():
            if definition.get('enabled') is False:raise EngineError('ACTION_DISABLED','Action is disabled',action=name)
            if handler not in self.operators:raise EngineError('ACTION_OPERATOR','Unknown action executor',handler=handler)
            if args.get('condition') and not self.expression(args['condition'],args):raise EngineError('CONDITION','Action condition not satisfied',action=name)
            result=self.operators[handler](args)
            if args.get('duration_minutes'):
                if args['duration_minutes']<0:raise EngineError('ACTION_DURATION','Action duration must be nonnegative')
                self._tick(args['duration_minutes'])
            return result
        return self.transaction(operation_id or str(uuid.uuid4()),{'action':name,'arguments':arguments or {}},work)
    def _use(self,ctx):
        spec,_=self._item(ctx);q=self._quantity(ctx)
        if int(q)!=q:raise EngineError('QUANTITY','Use count must be an integer')
        if spec.get('use_effects') is None:raise EngineError('MISSING_EFFECTS','Item use effects are not configured',item=ctx['item'])
        self._bag_change(self._actor_target(ctx,'bag'),spec.get('name',ctx['item']),-q)
        out=[]
        for _ in range(int(q)):out+=self.effects(spec['use_effects'],ctx)
        return {'used':ctx['item'],'quantity':q,'effects':out}
    def _craft(self,ctx):
        spec,_=self._item(ctx);q=self._quantity(ctx);recipe=spec.get('recipe')
        if not isinstance(recipe,dict) or not recipe:raise EngineError('RECIPE_MISSING','Item has no registered recipe')
        if spec.get('facility_ref'):
            level_target=ctx.get('facility_level_target') or f"{spec['facility_ref']}.{ctx.get('facility_level_field','level')}"
            if spec.get('facility_level') is None:raise EngineError('MISSING_FACILITY_LEVEL','Required facility level is missing')
            if self.get(level_target)<spec['facility_level']:raise EngineError('FACILITY_LEVEL','Facility level is insufficient')
        if spec.get('stamina_cost') is None:raise EngineError('MISSING_COST','Set an explicit stamina cost, including zero')
        cost=spec['stamina_cost']*q;stamina=self._actor_target(ctx,'stamina');bag=self._actor_target(ctx,'bag')
        if self.get(stamina)<cost:raise EngineError('INSUFFICIENT_STAMINA','Not enough stamina')
        for item,amount in recipe.items():self._bag_change(bag,item,-amount*q)
        self.delta(stamina,-cost);self._bag_change(bag,spec.get('name',ctx['item']),q);return {'crafted':ctx['item'],'quantity':q}
    def _trade(self,ctx):
        spec,item_id=self._item(ctx);q=self._quantity(ctx);buy=ctx['action']=='BUY';field='buy_price' if buy else 'sell_price';offer=None
        ctx=dict(ctx);ctx.setdefault('currency',spec.get('currency'))
        if ctx.get('offer'):
            offer=self._record('X_SHOP_OFFERS',self._find('X_SHOP_OFFERS',ctx['offer']))['values']
            if offer.get('item_ref') not in {item_id,ctx['item']}:raise EngineError('OFFER_ITEM','Offer refers to a different item')
            if offer.get('valid_until') is not None and self._clock().ordinal()>offer['valid_until']:raise EngineError('OFFER_EXPIRED','Offer has expired')
            price=offer.get(field)
            if buy and (offer.get('stock') is None or offer['stock']<q):raise EngineError('STOCK','Shop stock is insufficient or unknown')
        else:price=spec.get(field)
        if price is None:raise EngineError('PRICE_MISSING','Item price is unknown',item=ctx['item'],field=field)
        if price<0:raise EngineError('PRICE','Price must be nonnegative')
        bag=self._actor_target(ctx,'bag');money=self._actor_target(ctx,'currency');cost=float(Decimal(str(price))*Decimal(str(q)));merchant_money=None
        if offer is not None and offer.get('merchant_ref'):
            currency=offer.get('currency_ref') or spec.get('currency')
            if not currency:raise EngineError('CURRENCY_MISSING','Merchant currency is missing')
            merchant_money=ctx.get('merchant_currency_target') or str(offer['merchant_ref'])+'.wallet/'+str(currency)
            if not buy and self.get(merchant_money)<cost:raise EngineError('MERCHANT_CURRENCY','Merchant funds are insufficient')
        if buy:
            if self.get(money)<cost:raise EngineError('INSUFFICIENT_CURRENCY','Not enough currency',needed=cost)
            self.delta(money,-cost);self._bag_change(bag,spec.get('name',ctx['item']),q)
        else:self._bag_change(bag,spec.get('name',ctx['item']),-q);self.delta(money,cost)
        if merchant_money:self.delta(merchant_money,cost if buy else -cost)
        if offer is not None:
            offer_id=self._find('X_SHOP_OFFERS',ctx['offer']);self.delta(f'X_SHOP_OFFERS#{offer_id}.stock',-q if buy else q)
        return {'direction':ctx['action'],'item':ctx['item'],'quantity':q,'unit_price':price,'amount':cost}
    def _quest(self,ctx):
        tid=ctx.get('target_table') or 'X_QUEST_RULES';rid=self._find(tid,str(ctx.get('quest') or ctx.get('target')));q=self._record(tid,rid)['values'];prefix=f'{tid}#{rid}'
        if ctx['action']=='QUEST_ACCEPT':
            if q.get('status') in {'completed','已完成'} and not q.get('repeatable'):raise EngineError('QUEST_COMPLETED','Task already completed')
            if q.get('actor_ref') not in (None,'',ctx['actor']):raise EngineError('QUEST_OWNER','Task belongs to another actor')
            self.set(prefix+'.actor_ref',ctx['actor']);self.set(prefix+'.status','active');return {'accepted':rid}
        if q.get('actor_ref')!=ctx['actor']:raise EngineError('QUEST_OWNER','Submitting actor must own the task')
        if q.get('status') not in {'active','进行中'}:raise EngineError('QUEST_STATE','Task is not active',status=q.get('status'))
        if q.get('condition') and not self.expression(q['condition'],ctx):raise EngineError('QUEST_CONDITION','Task completion condition is false')
        requirements=q.get('requirements')
        if requirements is None:raise EngineError('QUEST_REQUIREMENTS','Set explicit requirements, including an empty bag')
        for item,amount in requirements.items():self._bag_change(self._actor_target(ctx,'bag'),item,-amount)
        if q.get('rewards') is None:raise EngineError('QUEST_REWARDS','Set explicit rewards, including an empty list')
        self.effects(q['rewards'],ctx);self.set(prefix+'.status','completed');self.set(prefix+'.times_completed',(q.get('times_completed') or 0)+1)
        return {'completed':rid,'actor':ctx['actor']}
    def _build(self,ctx):
        target=ctx.get('facility') or ctx.get('target');level=ctx.get('level_target') or str(target)+'.level';current=self.get(level)
        specs=[r['values'] for r in self.rows('X_FACILITY_UPGRADES').values() if r['values'].get('facility_ref')==target and r['values'].get('target_level')==current+1]
        if len(specs)!=1:raise EngineError('UPGRADE_SPEC','Exactly one next-level upgrade is required',target=target)
        spec=specs[0]
        if spec.get('materials') is None or spec.get('currency_cost') is None:raise EngineError('UPGRADE_COST','Upgrade cost is incomplete')
        money=self._actor_target(ctx,'currency');cost=spec['currency_cost']
        if self.get(money)<cost:raise EngineError('INSUFFICIENT_CURRENCY','Not enough currency for upgrade')
        for item,q in spec['materials'].items():self._bag_change(self._actor_target(ctx,'store'),item,-q)
        self.delta(money,-cost);self.delta(level,1)
        if spec.get('output_bonus') is not None:self.delta(ctx.get('output_target') or str(target)+'.base_output',spec['output_bonus'])
        if spec.get('effects') is not None:self.effects(spec['effects'],ctx)
        return {'facility':target,'level':current+1}
    def _assign(self,ctx):
        worker=ctx.get('worker') or ctx['actor'];self.set(str(worker)+'.'+ctx.get('worker_facility_field','facility'),ctx['facility']);self.set(str(worker)+'.'+ctx.get('worker_role_field','role'),ctx.get('role',''))
        return {'worker':worker,'facility':ctx['facility'],'role':ctx.get('role','')}
    def _steps(self,ctx):
        key=ctx.get('row_uuid') or ctx.get('action_ref') or ctx['action'];steps=[r['values'] for r in self.rows('X_ACTION_STEPS').values() if r['values'].get('action_ref')==key]
        phases={'condition':0,'cost':1,'effect':2,'feedback':3};steps.sort(key=lambda x:(phases.get(x.get('phase'),2),x.get('order') or 0))
        out=[]
        for step in steps:
            if step.get('condition') and not self.expression(step['condition'],ctx):raise EngineError('CONDITION',step.get('failure_text') or 'Action step condition failed')
            payload=copy.deepcopy(step.get('value') or {});payload.setdefault('op',step.get('operation','SET'));payload.setdefault('target',step.get('target'));out+=self.effects([payload],ctx)
        if not steps:raise EngineError('ACTION_STEPS','Registered action has no steps',action=key)
        return out
    def _check(self,ctx):
        rid=self._find('X_CHECK_RULES',ctx['rule']);rule=self._record('X_CHECK_RULES',rid)['values'];roll=ctx.get('roll')
        if roll is None:
            if not rule.get('sides'):raise EngineError('CHECK_SIDES','Dice sides are missing')
            roll=self.rng.randint(1,int(rule['sides']))
        names=ctx|{'roll':roll,'threshold':rule.get('threshold')};condition=rule.get('success_condition')
        if not condition:raise EngineError('CHECK_CONDITION','Check success condition is missing')
        success=bool(self.expression(condition,names))
        if rule.get('costs') is not None:self.effects(rule['costs'],names)
        outcomes=rule.get('outcomes') or {};selected=outcomes.get('success' if success else 'failure',[]);self.effects(selected,names)
        return {'roll':roll,'success':success,'rule':rid}
    def _process(self,ctx):
        rid=self._find('X_PROCESSES',ctx['process']);rec=self._record('X_PROCESSES',rid)['values'];edges=[r['values'] for r in self.rows('X_PROCESS_EDGES').values() if r['values'].get('process_ref')==rid and r['values'].get('from_stage')==rec.get('stage') and (not r['values'].get('condition') or self.expression(r['values']['condition'],ctx))]
        if not edges:raise EngineError('PROCESS_EDGE','No process transition is applicable')
        edges.sort(key=lambda x:x.get('priority') or 0,reverse=True)
        if len(edges)>1 and edges[0].get('priority')==edges[1].get('priority'):raise EngineError('PROCESS_CONFLICT','Process transition priorities conflict')
        edge=edges[0];self.effects(edge.get('on_exit') or [],ctx);self.set(f'X_PROCESSES#{rid}.stage',edge['to_stage']);self.effects(edge.get('on_enter') or [],ctx)
        return {'process':rid,'from':edge['from_stage'],'to':edge['to_stage']}
    def _clock(self):
        rows=self.rows('X_WORLD_CLOCKS');selected=self.data['runtime'].get('calendar_record_id')
        if selected is None and len(rows)==1:selected=next(iter(rows));self.data['runtime']['calendar_record_id']=selected
        if selected:
            values=self._record('X_WORLD_CLOCKS',selected)['values'];return WorldClock({k:v for k,v in values.items() if v is not None and k not in {'row_uuid','name','world_ref'}})
        return WorldClock(self.data['runtime'].get('calendar'))
    def _tag(self,target,name,duration=None):
        tags=copy.deepcopy(self.get(target))
        if not isinstance(tags,list):raise EngineError('TAGS_TYPE','Tag target must be a list')
        tag={'name':name}
        if duration is not None:clock=self._clock();tag['expires_at']=clock.ordinal()+clock.duration(duration)
        tags=[x for x in tags if x.get('name')!=name]+[tag];self.set(target,tags)
    def _tick(self,delta):
        clock=self._clock();start=clock.ordinal();elapsed=clock.advance(delta);end=clock.ordinal();expired=[]
        selected=self.data['runtime'].get('calendar_record_id')
        if selected:
            for k in ['year','season','month','day','hour','minute']:
                if k in clock.c:self.set(f'X_WORLD_CLOCKS#{selected}.{k}',clock.c[k])
            self.data['runtime'].pop('calendar',None)
        else:self.data['runtime']['calendar']=clock.c
        for tid,rows in self.data['tables'].items():
            for rid,rec in rows.items():
                for f in self.data['schema'][tid]['fields']:
                    if f.get('type')!='TAGS' or rec['states'].get(f['key'])!='known':continue
                    tags=[]
                    for tag in rec['values'][f['key']]:
                        tag=copy.deepcopy(tag)
                        if 'expires_at' not in tag and tag.get('duration') is not None:tag['expires_at']=start+clock.duration(str(tag['duration'])+tag.get('unit','m'))
                        if tag.get('expires_at') is not None and tag['expires_at']<=end:expired.append(tag['name'])
                        else:tags.append(tag)
                    rec['values'][f['key']]=tags
        due=[(rid,r['values']) for rid,r in self.rows('X_SCHEDULES').items() if r['values'].get('enabled') is True and r['values'].get('next_at') is not None and r['values']['next_at']<=end]
        due.sort(key=lambda p:(p[1]['next_at'],-(p[1].get('priority') or 0),p[0]));executed=[]
        for rid,s in due:
            interval=s.get('interval_minutes')
            if interval is not None and interval<=0:raise EngineError('SCHEDULE_INTERVAL','Repeating interval must be positive',schedule=rid)
            while s['next_at']<=end:
                at=s['next_at'];args=s.get('arguments') or {}
                if interval is None:self.set(f'X_SCHEDULES#{rid}.enabled',False)
                else:self.set(f'X_SCHEDULES#{rid}.next_at',at+interval)
                if not s.get('condition') or self.expression(s['condition'],args):executed.append(self.action(s['action_ref'],args,'schedule:'+rid+':'+str(at)))
                if interval is None:break
        for rid,r in self.rows('X_RESOURCE_CYCLES').items():
            s=r['values']
            if s.get('enabled') is not True or s.get('next_at') is None or s['next_at']>end:continue
            interval=s.get('interval_minutes')
            if not interval or interval<=0:raise EngineError('RESOURCE_INTERVAL','Resource period must be positive')
            count=(end-s['next_at'])//interval+1;value=s.get('quantity');regen=s.get('regeneration');capacity=s.get('capacity')
            if None in [value,regen,capacity]:raise EngineError('RESOURCE_PARAMETERS','Resource cycle has missing parameters')
            self.set(f'X_RESOURCE_CYCLES#{rid}.quantity',min(capacity,value+count*regen));self.set(f'X_RESOURCE_CYCLES#{rid}.next_at',s['next_at']+count*interval)
        completed_effects=[x for listener in self.clock_listeners for x in listener(start,end)]
        self.cache.clear();return {'elapsed_minutes':elapsed,'time':clock.text(),'expired':expired,'scheduled_actions':executed,'expired_effect_instances':completed_effects}
    def tick(self,delta,operation_id):return self.transaction(operation_id,{'tick':delta},lambda:self._tick(delta))
    def micro(self,line,ctx=None):
        ctx=dict(ctx or {});evidence=re.search(r'\|\s*(P\d+(?:\.\.P?\d+)?)\s*$',line,re.I)
        if evidence:ctx['evidence']=evidence[1]
        line=re.sub(r'^(@[A-Za-z_]+(?:\+)?)\s*[:：]\s*',r'\1:',line.strip());line=re.sub(r'\s*\|\s*(?:P\d+(?:\.\.P?\d+)?|P_AUTO|UI\w*|reroll\w*|auto)\s*$','',line,flags=re.I)
        if not line or line.startswith(('#','//')):return None
        if line.upper().startswith('@ROW+:'):
            payload=json.loads(line.split(':',1)[1]);tid=payload['table_id'];values=payload.get('values',{})
            for key in values:
                if self._spec(tid,key).get('read_only') and not self._spec(tid,key).get('alias_of'):raise EngineError('DERIVED_WRITE','Model-created rows cannot set a program-owned field',table=tid,field=key)
            return {'record_id':self.new_record(tid,values,payload.get('record_id')),'table_id':tid}
        if line.upper().startswith('@FIELD+:'):
            payload=json.loads(line.split(':',1)[1]);return self.declare_field(payload['table_id'],{k:v for k,v in payload.items() if k!='table_id'})
        if line.upper().startswith('@ACT:'):
            raw_action=line.split(':',1)[1].strip()
            if raw_action.startswith('{'):
                payload=json.loads(raw_action);return self.action(payload['action'],payload.get('arguments',{}),'micro:'+digest(payload))
            m=re.fullmatch(r'@ACT:\s*([A-Za-z_]+)\((.*)\)',line,re.I)
            if not m:raise EngineError('ACTION_SYNTAX','Invalid action expression')
            import csv
            args=next(csv.reader([m[2]],skipinitialspace=True));name=m[1].upper();a={'actor':args[0].strip()}
            if name in {'USE','CRAFT','BUY','SELL'}:
                token=args[1].strip();it=re.fullmatch(r'(.+?)(?:[×*](\d+(?:\.\d+)?))?',token);a.update(item=it[1],quantity=float(it[2]) if it[2] else 1)
            elif name.startswith('QUEST_'):a['quest']=args[1].strip()
            elif name=='BUILD_UPGRADE':a['facility']=args[1].strip()
            elif name in {'ASSIGN_WORKER','ASSIGN'}:name='ASSIGN_WORKER';a.update(worker=args[0].strip(),facility=args[1].strip(),role=args[2].strip() if len(args)>2 else '')
            else:raise EngineError('ACTION_ARGUMENTS','Use JSON arguments for custom actions')
            return self.action(name,a,'micro:'+digest(line))
        if line.upper().startswith('@TIME:'):
            m=re.fullmatch(r'@TIME:\s*tick\(([^)]+)\)',line,re.I)
            if not m:raise EngineError('TIME_SYNTAX','Use @TIME: tick(+1h)')
            return self._tick(m[1])
        for prefix,kind in [('@EVENTS+:','EVENTS'),('@ANCHORS+:','ANCHORS'),('@PACTS+:','PACTS')]:
            if line.upper().startswith(prefix):
                from llm_commands import append_business
                return append_business(self,kind,line[len(prefix):].strip(),ctx)
        if line.upper().startswith('@PREF:'):
            from llm_commands import preference
            return preference(self,line.split(':',1)[1].strip(),ctx)
        if ':' not in line and '：' not in line:raise EngineError('MICRO_SYNTAX','Missing target separator',line=line)
        target,op=re.split('[:：]',line,maxsplit=1);target=target.strip();op=op.strip();target=self._render(target,ctx or {})
        tid,rid,key,path=self.resolve(target,create=True)
        if self._spec(tid,key).get('read_only') and not self._spec(tid,key).get('alias_of'):raise EngineError('DERIVED_WRITE','Update the registered input or source instead',target=target)
        m=re.fullmatch(r'([+\-*/])\s*([+-]?\d+(?:\.\d+)?)',op)
        if m:
            n=float(m[2]);old=self.get(target)
            if m[1] in '+-':return self.delta(target,n if m[1]=='+' else -n)
            self.set(target,old*n if m[1]=='*' else old/n);return {'target':target,'value':self.get(target)}
        if op.startswith('->'):self.set(target,op[2:].strip());return {'target':target,'value':self.get(target)}
        if re.match(r'[+\->]\[',op):
            for symbol,body in re.findall(r'([+\->])\[([^\]]+)\]',op):
                if symbol=='>':
                    itemdest=body.rsplit('@',1)
                    if len(itemdest)!=2:raise EngineError('TRANSFER_SYNTAX','Transfer destination missing')
                    bag,_=decode_value(itemdest[0].strip(),{'key':'bag','type':'BAG'})
                    for item,q in bag.items():self._bag_change(target,item,-q);self._bag_change(itemdest[1].strip(),item,q)
                else:
                    value=self.get(target)
                    if isinstance(value,list):
                        if symbol=='+':
                            tm=re.fullmatch(r'(.+?)\((\d+(?:\.\d+)?[dhmt])\)',body)
                            self._tag(target,tm[1] if tm else body,tm[2] if tm else None)
                        else:self.set(target,[x for x in value if x.get('name')!=re.sub(r'\([^)]*\)$','',body)])
                    else:
                        bag,_=decode_value(body,{'key':'bag','type':'BAG'})
                        for item,q in bag.items():self._bag_change(target,item,q if symbol=='+' else -q)
            return {'target':target,'value':self.get(target)}
        value=op[1:].strip() if op.startswith('=') else op;tid,rid,key,path=self.resolve(target,create=True);spec=self._spec(tid,key)
        if path:
            try:value=json.loads(value)
            except Exception:pass
        # set() owns typed decoding, cell states and gauge metadata. Decoding
        # twice would turn an explicit unknown/cleared marker into an unset cell.
        written=self.set(target,value);return {'target':target,'value':value if path else written}
    def apply_ops(self,lines,operation_id):return self.transaction(operation_id,{'ops':lines},lambda:[self.micro(line) for line in lines if line.strip()])
    def save_json(self,path):
        self.recalculate();p=Path(path);p.parent.mkdir(parents=True,exist_ok=True);temp=p.with_suffix(p.suffix+'.pending');temp.write_text(json.dumps(self.data,ensure_ascii=False,indent=2));assert json.loads(temp.read_text())==self.data;temp.replace(p);return p
    def save_xlsx(self,path):
        if self.book is None:raise EngineError('WORKBOOK_SOURCE','Load a workbook before writing an XLSX')
        self.recalculate();return self.book.write(self.data,path)
    def panels(self):
        self.recalculate();out=[]
        for tid,rows in self.data['tables'].items():
            if not rows:continue
            fields=self.data['schema'][tid]['fields'];actions=[r['values'] for r in self.rows('X_UI_BINDINGS').values() if r['values'].get('table_id')==tid]
            records=[]
            for rid,rec in rows.items():
                entries=[]
                for action in actions:
                    context={'record_id':rid,'table_id':tid,**rec['values']};entry=copy.deepcopy(action)
                    try:
                        entry['arguments']=self._render(action.get('arguments') or {},context)
                        condition=action.get('condition');entry['condition_status']='passed' if condition and self.expression(condition,context) else 'failed' if condition else 'not_declared'
                        if entry['condition_status']=='failed':entry['unavailable_reason']='Configured condition is false'
                    except EngineError as exc:entry['condition_status']='error';entry['unavailable_reason']=exc.as_dict()
                    entries.append(entry)
                records.append({'record_id':rid,'values':copy.deepcopy(rec['values']),'states':copy.deepcopy(rec['states']),'actions':entries})
            out.append({'table_id':tid,'title':self.data['schema'][tid].get('label',tid),'fields':[{'key':f['key'],'label':f.get('label',f['key']),'type':f.get('type')} for f in fields],'rows':records,'actions':actions})
        return {'revision':self.data['runtime']['revision'],'world_time':self._clock().text() if self.data['runtime'].get('calendar') or self.rows('X_WORLD_CLOCKS') else None,'panels':out,'errors':self.errors}
