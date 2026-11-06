"""Exact sources, forgiving LLM parsing, isolated line settlement and scoped materials."""
from __future__ import annotations
import copy, hashlib, json, re, uuid
from matrix_io import EngineError
from tisya_runtime import digest

MARK=re.compile(r'^[ \t\u3000]*(?:\[(?:P)?(\d+)\]|【(?:P)?(\d+)】|\((\d+)\)|P(\d+)[.、:：]?|(\d+)[.、．:：)]|(\d+)(?=[ \t\u3000]))[ \t\u3000]*',re.I)

def _paragraphs(body,strict=False):
    starts=list(re.finditer(r'(?m)^[ \t]*(\d+) ',body))
    valid=bool(starts) and not body[:starts[0].start()].strip() and [int(m[1]) for m in starts]==list(range(1,len(starts)+1))
    # Even correctly numbered text can contain an unnumbered natural paragraph.
    natural=list(re.finditer(r'\r?\n[ \t\u3000]*\r?\n+',body))
    if valid:
        for b in natural:
            rest=body[b.end():]
            if rest.strip() and not MARK.match(rest.lstrip('\r\n')):valid=False;break
    if strict and not valid:raise EngineError('PARAGRAPH_SEQUENCE','Body paragraphs require consecutive numbers')
    if valid:bounds=[0]+[m.start() for m in starts[1:]]+[len(body)]
    else:
        cuts={0,len(body)}
        for m in natural:
            if body[m.end():].strip():cuts.add(m.end())
        # Numbered paragraphs without blank lines are also common.
        for m in re.finditer(r'(?m)^[^\S\r\n]*(?:\[P?\d+\]|【P?\d+】|P\d+[.、:：]?|\d+[.、．:：)]|\d+[ \t\u3000])',body,re.I):
            if body[:m.start()].strip():cuts.add(m.start())
        bounds=sorted(cuts)
    fragments=[];normalized=[];mapping=[];pending=''
    for a,b in zip(bounds,bounds[1:]):
        raw=body[a:b]
        if not raw.strip():
            if fragments:fragments[-1]['raw_block']+=raw;fragments[-1]['source_end']=b
            else:pending+=raw
            continue
        if pending:raw=pending+raw;a-=len(pending);pending=''
        clean=raw.strip();m=MARK.match(clean);label=next((x for x in m.groups() if x is not None),None) if m else None
        prose=clean[m.end():] if m else clean;n=len(fragments)+1
        fragments.append({'paragraph_id':f'P{n}','chunk_index':n,'raw_block':raw,'chunk_text':prose,'source_start':a,'source_end':b,'original_label':label})
        normalized.append(f'{n} {prose}');mapping.append({'normalized':f'P{n}','original_label':label,'source_start':a,'source_end':b})
    for f in fragments:f['sha256']=hashlib.sha256(f['raw_block'].encode()).hexdigest()
    normalized_body='\n\n'.join(normalized)
    return fragments,normalized_body,mapping,([] if valid else [{'code':'PARAGRAPH_NORMALIZED','message':'已按自然段重排连续段号；原文与映射另存','mapping':mapping}])


def parse_reply(text,entry_id,revision=1,strict=False):
    root=re.fullmatch(r'\s*<reply\b[^>]*>(.*)</reply>\s*',text,flags=re.S|re.I)
    if not root:raise EngineError('REPLY_ROOT','A complete reply root is required')
    inner=root[1]
    def block(tag,required=False):
        found=list(re.finditer(r'<'+tag+r'\b[^>]*>(.*?)</'+tag+r'\s*>',inner,re.S|re.I))
        if len(found)>1:raise EngineError('REPLY_DUPLICATE_BLOCK','Duplicate reply block',block=tag)
        if not found:
            if required:raise EngineError('REPLY_BLOCK','Required reply block is missing',block=tag)
            return ''
        return found[0][1]
    body=block('body',True)
    if not body.strip():raise EngineError('BODY_EMPTY','Body is empty')
    fragments,normalized,mapping,warnings=_paragraphs(body,strict)
    cells=block('cells');original_ops=[x.strip() for x in cells.splitlines() if x.strip() and not x.lstrip().startswith(('#','//'))];ops=[]
    for i,line in enumerate(original_ops,1):
        m=re.search(r'\|\s*(P\d+(?:\.\.P?\d+)?)\s*$',line,re.I)
        if m:
            ns=[int(n) for n in re.findall(r'P?(\d+)',m[1],re.I)];clamped=[min(max(1,n),len(fragments)) for n in ns]
            if ns!=clamped:
                if strict:raise EngineError('PARAGRAPH_REFERENCE','Cell evidence refers to an absent paragraph',evidence=m[1])
                fixed='..'.join('P'+str(n) for n in clamped);warnings.append({'code':'PARAGRAPH_CLAMPED','line_number':i,'original_reference':m[1],'effective_reference':fixed,'message':'段号已钳制；这是修正引用，不代表额外事实证据'})
                line=line[:m.start(1)]+fixed+line[m.end(1):]
        ops.append(line)
    archive=[{'category':x.split('|')[0].strip(),'fields':[y.strip() for y in x.split('|')[1:]],'raw':x} for x in block('archive').splitlines() if x.strip() and '|' in x]
    anchors={phase:(re.search(r'<anchor\b[^>]*phase=[\"\']'+phase+r'[\"\'][^>]*>(.*?)</anchor>',inner,re.S|re.I).group(1) if re.search(r'<anchor\b[^>]*phase=[\"\']'+phase+r'[\"\'][^>]*>(.*?)</anchor>',inner,re.S|re.I) else '') for phase in ['before','after']}
    return {'entry_id':entry_id,'revision':revision,'reply_raw':text,'reply_sha256':hashlib.sha256(text.encode()).hexdigest(),'body_raw':body,'body_sha256':hashlib.sha256(body.encode()).hexdigest(),'body_normalized':normalized,'normalized_sha256':hashlib.sha256(normalized.encode()).hexdigest(),'paragraph_mapping':mapping,'fragments':fragments,'delta_ops':ops,'original_delta_ops':original_ops,'warnings':warnings,'archive_rows':archive,'title':block('title'),'actions':block('actions'),'anchors':anchors}


def accept_reply(engine,text,entry_id,revision=1,branch='main'):
    parsed=parse_reply(text,entry_id,revision);source_key=f'{branch}/{entry_id}@{revision}';operation_id='reply:'+source_key
    request={'reply_sha256':parsed['reply_sha256'],'entry_id':entry_id,'revision':revision,'branch':branch}
    prior=engine.data['runtime']['receipts'].get(operation_id)
    if prior:
        if prior['request_sha256']!=digest(request):raise EngineError('OPERATION_CONFLICT','Same reply revision has different text',source_key=source_key)
        return {'status':'REPLAY','receipt':copy.deepcopy(prior)}
    previous=[x for k,x in engine.data['runtime']['sources'].items() if k!=source_key and x.get('branch')==branch and x['entry_id']==entry_id]
    if previous:raise EngineError('REVISION_REBASE_REQUIRED','Restore this turn pre-snapshot before accepting another variant',entry_id=entry_id)
    def register():
        runtime=engine.data['runtime'];parsed['branch']=branch;runtime['sources'][source_key]=copy.deepcopy(parsed);runtime['turn_order'].append(source_key);seq=len(runtime['turn_order'])
        runtime['archive_queue'].append({'sequence':seq,'source_key':source_key,'rows':parsed['archive_rows'],'status':'staged'});formal=[]
        for batch in runtime['archive_queue']:
            if batch['status']=='staged' and batch['sequence']<=seq-2:batch['status']='formal';runtime['archive'].append(copy.deepcopy(batch));formal.append(batch['source_key'])
        if 'T_SYS_SOURCE_FRAGMENTS' in engine.data['schema']:
            for f in parsed['fragments']:
                rid=str(uuid.uuid5(uuid.NAMESPACE_URL,source_key+'#'+f['paragraph_id']))
                engine.new_record('T_SYS_SOURCE_FRAGMENTS',{'entry_id':entry_id,'revision':revision,'entry_hash':parsed['body_sha256'],'paragraph_id':f['paragraph_id'],'chunk_index':f['chunk_index'],'chunk_text':f['raw_block'],'chunk_hash':f['sha256'],'source_locator':source_key+'#'+f['paragraph_id'],'total_chunks':len(parsed['fragments'])},rid)
        return {'formalized_sources':formal}
    registered=engine.transaction(operation_id+':source',request,register)
    if registered['status']=='FAILED':return registered
    warnings=copy.deepcopy(parsed['warnings']);results=[]
    for i,line in enumerate(parsed['delta_ops'],1):
        try:
            result=engine.transaction(operation_id+f':line:{i}',{'line':line},lambda line=line:engine.micro(line,{'source_key':source_key,'entry_id':entry_id,'revision':revision,'body_sha256':parsed['body_sha256']}))
        except Exception as exc:
            result={'status':'FAILED','error':exc.as_dict() if isinstance(exc,EngineError) else {'code':'CELL_ERROR','message':str(exc)}}
        results.append({'line_number':i,'original':parsed['original_delta_ops'][i-1],'effective':line,**result})
        extra=result.get('receipt',result).get('result',{})
        if isinstance(extra,dict) and extra.get('warning'):warnings.append(dict(extra['warning'],line_number=i))
        if result['status']=='FAILED':warnings.append({'code':'CELL_FAILED','line_number':i,'original':parsed['original_delta_ops'][i-1],'error':result['error'],'message':'仅本行回滚；正文和其他成功指令已保留'})
    def finish():
        runtime=engine.data['runtime'];runtime.setdefault('warnings',[]).extend(dict(x,source_key=source_key) for x in warnings)
        runtime['sources'][source_key]['settlement']={'operations':copy.deepcopy(results),'warnings':copy.deepcopy(warnings)}
        reg=registered.get('receipt',registered).get('result',{})
        return {'source_key':source_key,'body_sha256':parsed['body_sha256'],'normalized_sha256':parsed['normalized_sha256'],'paragraphs':len(parsed['fragments']),'operations':results,'warnings':warnings,'formalized_sources':reg.get('formalized_sources',[]),'staged_rows':len(parsed['archive_rows'])}
    return engine.transaction(operation_id,request,finish)

def recall(engine,query,paragraphs=None,branch=None):
    terms=[x for x in re.split(r'[\s/,，；;]+',query) if x];results=[]
    for key,source in engine.data['runtime']['sources'].items():
        if branch and source.get('branch')!=branch:continue
        if hashlib.sha256(source['body_raw'].encode()).hexdigest()!=source['body_sha256']:raise EngineError('SOURCE_INTEGRITY','Stored source body changed',source_key=key)
        trigger=' '.join(x.get('raw','') for x in source['archive_rows']);hits=[x for x in terms if x in source['body_raw'] or x in trigger]
        if terms and not hits:continue
        fragments=[]
        for f in source['fragments']:
            if paragraphs and f['paragraph_id'] not in paragraphs:continue
            if hashlib.sha256(f['raw_block'].encode()).hexdigest()!=f['sha256']:raise EngineError('SOURCE_INTEGRITY','Stored paragraph changed',source_key=key,paragraph=f['paragraph_id'])
            fragments.append(copy.deepcopy(f))
        results.append({'source_key':key,'entry_id':source['entry_id'],'revision':source['revision'],'body_sha256':source['body_sha256'],'matched_terms':hits,'fragments':fragments})
    return results


def learn_preference(engine,owner,dimension,observation,alpha,directive,scope,confirmed,operation_id):
    if not 0<=observation<=1 or not 0<=alpha<=1:raise EngineError('PREFERENCE_WEIGHT','Observation and alpha must be in [0,1]')
    if not isinstance(confirmed,bool):raise EngineError('PREFERENCE_CONFIRMATION','Confirmation must be explicit')
    identity={'owner_ref':owner,'dimension':dimension,**scope};rid=str(uuid.uuid5(uuid.NAMESPACE_URL,digest(identity|{'confirmation_lane':confirmed})))
    def work():
        values=identity|{'alpha':alpha,'directive':directive,'confirmed':confirmed}
        if rid in engine.rows('X_PREFERENCE_POLICIES'):
            old=engine.get(f'X_PREFERENCE_POLICIES#{rid}.weight');weight=(1-alpha)*old+alpha*observation
            for k,v in values.items():engine.set(f'X_PREFERENCE_POLICIES#{rid}.{k}',v)
            engine.set(f'X_PREFERENCE_POLICIES#{rid}.weight',weight)
        else:weight=observation;engine.new_record('X_PREFERENCE_POLICIES',values|{'weight':weight},rid)
        return {'preference_id':rid,'weight':weight,'confirmed':confirmed,'scope':scope,'directive':directive}
    return engine.transaction(operation_id,{'preference':identity,'observation':observation,'alpha':alpha,'directive':directive,'confirmed':confirmed},work)


def active_preferences(engine,context):
    chosen={};clock=engine._clock().ordinal() if engine.data['runtime'].get('calendar') or engine.rows('X_WORLD_CLOCKS') else None
    for rid,rec in engine.rows('X_PREFERENCE_POLICIES').items():
        v=rec['values']
        if v.get('owner_ref')!=context.get('owner_ref'):continue
        if any(v.get(k) not in (None,'',context.get(k)) for k in ['world_ref','session_ref','branch_ref','subject_ref','relationship_ref','turn_ref']):continue
        if v.get('expires_at') is not None and clock is not None and v['expires_at']<=clock:continue
        if v.get('confirmed') is not True and not (v.get('turn_ref') and v['turn_ref']==context.get('turn_ref')):continue
        rank=100 if v.get('turn_ref') else 90 if v.get('relationship_ref') else 80 if v.get('subject_ref') else 60 if v.get('session_ref') or v.get('branch_ref') else 40 if v.get('world_ref') else 20
        score=(rank,v.get('priority') or 0);dimension=v.get('dimension')
        if dimension not in chosen or score>chosen[dimension][0]:chosen[dimension]=(score,{'preference_id':rid,**copy.deepcopy(v)})
    return [x[1] for x in chosen.values()]


def nested_records(engine,table_id):
    relations=engine.data.get('definition_meta',{}).get('relations',[])
    byparent={}
    for rel in relations:byparent.setdefault(rel.get('parent_table'),[]).append(rel)
    def visit(tid,rid,trail):
        ident=(tid,rid)
        if ident in trail:raise EngineError('NESTING_CYCLE','Declared nesting relationship cycles',table=tid,record=rid)
        rec=engine._record(tid,rid);out=copy.deepcopy(rec['values']);path=trail|{ident}
        for rel in byparent.get(tid,[]):
            child=rel['child_table'];key=rel['foreign_key'];rows=[]
            for cid,c in engine.rows(child).items():
                if c['values'].get(key)==rid:
                    for scope in rel.get('scope_fields',[]):
                        if c['values'].get(scope)!=rec['values'].get(scope):raise EngineError('NESTING_SCOPE','Nested records have different scopes',field=scope)
                    rows.append(visit(child,cid,path))
            if rel.get('cardinality')=='one' and len(rows)>1:raise EngineError('NESTING_CARDINALITY','One-to-one relationship has multiple children')
            if rel.get('required') and not rows:raise EngineError('NESTING_REQUIRED','Required nested record is missing')
            out[rel['output_field']]=rows[0] if rel.get('cardinality')=='one' and rows else None if rel.get('cardinality')=='one' else rows
        return out
    return [visit(table_id,rid,set()) for rid in engine.rows(table_id)]


def materials(engine,context=None,query=''):
    context=context or engine.data['runtime'].get('scope') or {};engine.recalculate();slots={};routed=set()
    routes={
      '世界与规则':'world_context','类型与物品':'asset_context','地点与交通':'location_context','组织与制度':'faction_context',
      '场景与环境':'current_state','状态与成长':'current_state','持有与交易':'current_state','关系与约定':'current_state',
      '人物原点':'focus_entities','人物细节':'focus_entities','认知与情报':'knowledge_material','历史与记忆':'memory_archive',
      '任务与调度':'pending_tasks','生产与设施':'current_state','冲突与检定':'current_state','创世与跨世界':'cardflow',
      '规则与执行':'cell_prompts','宿主与投影':'display_material','运行与归档':'offstage_state'}
    metadata={(r['values'].get('table_id'),r['values'].get('record_id')):r['values'] for r in engine.rows('X_RECORD_META').values()}
    def visible(tid,rid,rec):
        if tid=='T_CHAR_SECRETS' and context.get('audience')!='author':return False
        if context.get('audience')!='author' and rec.get('values',{}).get('lock_level') in {'D','E','Access D','Access E'}:return False
        m=metadata.get((tid,rid),{})
        for ck,mk in [('world_ref','scope_world_id'),('session_ref','scope_session_id'),('branch_ref','scope_branch_id')]:
            if context.get(ck) and m.get(mk) not in (None,'','GLOBAL',context[ck]):return False
        return True
    for tid,rows in engine.data['tables'].items():
        if tid.startswith(('M_','register_','R_')) or tid in {'X_RECORD_META','T_SYS_SOURCE_FRAGMENTS','X_PREFERENCE_POLICIES'}:continue
        sheet=engine.data['schema'][tid].get('sheet','');slot='tisya_material_'+routes.get(sheet,'task_material')
        blocks=[]
        for rid,rec in rows.items():
            if not visible(tid,rid,rec):continue
            fields={f['key']:f for f in engine.data['schema'][tid]['fields']}
            values={k:(v if rec['states'].get(k) in {'known','derived'} else {'unknown':'?','cleared':'!','none':'∅','not_applicable':'—'}[rec['states'][k]]) for k,v in rec['values'].items() if rec['states'].get(k) in {'known','derived','unknown','cleared','none','not_applicable'} and k!='row_uuid' and (context.get('audience')=='author' or not fields.get(k,{}).get('lock_level'))}
            for key,meta in rec.get('metadata',{}).items():
                if key in values and isinstance(meta,dict) and meta.get('gauge_max') is not None and rec['states'].get(key) in {'known','derived'}:values[key]=str(values[key])+'/'+str(meta['gauge_max'])
            if context.get('audience')!='author' and values.get('true_name_lock') in {'D','E','Access D','Access E'}:values.pop('true_name',None)
            if not values:continue
            identity=(tid,rid)
            if identity in routed:continue
            routed.add(identity);blocks.append({'table_id':tid,'record_id':rid,'values':values})
        if blocks:slots.setdefault(slot,[]).extend(blocks)
    pref=active_preferences(engine,context)
    if pref:slots['tisya_contractor_wish']='\n'.join(x.get('directive','') for x in pref if x.get('directive'))
    if engine.data['runtime']['archive']:slots['tisya_material_memory_summary']=copy.deepcopy(engine.data['runtime']['archive'])
    if query:
        if context.get('subject_ref'):
            # Event access is derived from explicit cognition/source ownership, not all archival text.
            known_events={r['values'].get('event_ref') for r in engine.rows('T_DYN_COGNITION').values() if r['values'].get('subject_ref')==context['subject_ref']}
            allowed_entries={r['values'].get('source_entry_id') for rid,r in engine.rows('T_DYN_EVENTS').items() if rid in known_events}
            hits=recall(engine,query,branch=context.get('branch_ref'));slots['tisya_material_memory_excerpt']=[x for x in hits if x['entry_id'] in allowed_entries]
        else:slots['tisya_material_memory_excerpt']=recall(engine,query,branch=context.get('branch_ref'))
    if engine.data['runtime'].get('calendar') or engine.rows('X_WORLD_CLOCKS'):slots['tisya_material_event_context']={'world_time':engine._clock().text()}
    targets={}
    for tid,rows in engine.data['tables'].items():
        active=[rid for rid,rec in rows.items() if visible(tid,rid,rec)]
        if active and tid not in {'T_SYS_SOURCE_FRAGMENTS','X_RECORD_META','X_PREFERENCE_POLICIES'}:targets[tid]=active
    from material_text import render_slots
    return render_slots(engine,slots,context,targets)


def render_preset(preset,slots):
    out=copy.deepcopy(preset)
    for p in out.get('prompts',[]):
        content=p.get('content','');m=re.fullmatch(r'\{\{(tisya_[^{}]+)\}\}',content.strip())
        if m:p['content']=slots.get(m[1],'')
    return out
