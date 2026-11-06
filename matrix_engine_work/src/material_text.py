"""Compact single-placement text for the existing 69-slot preset; no row/token truncation."""
import re


def text(v):
    if v is None:return '~'
    if isinstance(v,bool):return '是' if v else '否'
    if isinstance(v,dict):return '；'.join(str(k)+'='+text(x) for k,x in v.items()) if v else '{}'
    if isinstance(v,list):return '、'.join(text(x) for x in v) if v else '[]'
    return str(v).replace('\r\n','\n').replace('\n',' ⏎ ')


def render_slots(engine,slots,context,targets):
    aliases={(b['table_id'],b['record_id']):(b['values'].get('short_code') or b['values'].get('name') or b['values'].get('title')) for rows in slots.values() if isinstance(rows,list) for b in rows if isinstance(b,dict) and 'table_id' in b};out={};focus=slots.get('tisya_material_focus_entities',[]);anchors={};filters={};remaining=[]
    for b in focus:
        v=b['values']
        if b['table_id']=='T_CHAR_ANCHORS':anchors.setdefault(v.get('char_ref'),[]).append(b)
        elif b['table_id']=='T_PREF_CHAR_FILTER':filters.setdefault(v.get('target_char_id'),[]).append(b)
        else:remaining.append(b)
    def line(b,skip=()):
        tid,rid,v=b['table_id'],b['record_id'],b['values'];fields={f['key']:f for f in engine.data['schema'][tid]['fields']}
        name=v.get('name') or v.get('title') or v.get('short_code') or engine.data['schema'][tid].get('label',tid)
        pairs=[]
        for k,value in v.items():
            if k in skip or fields.get(k,{}).get('alias_of') or k in {'name','title'}:continue
            pairs.append(fields.get(k,{}).get('label',k)+'='+text(value))
        return f'[{tid}#{rid}/{text(name)}] '+'；'.join(pairs)
    def anchor(b):
        v=b['values'];dims=[('锚点',v.get('name') or b['record_id']),('角色',v.get('char_ref')),('源事件',aliases.get(('T_DYN_EVENTS',v.get('origin_event_ref'))) or v.get('origin_event_ref')),('表层',v.get('actions')),('触发','；'.join(k+'='+text(x) for k,x in [('情境',v.get('trigger_situation')),('线索',v.get('trigger_cues'))] if x is not None)),('防御',v.get('psychology')),('执念',v.get('internal_motive')),('软化',v.get('response_boundary')),('权重',v.get('recall_weight')),('演化',v.get('validity'))]
        used={'name','char_ref','origin_event_ref','actions','trigger_cues','trigger_situation','psychology','internal_motive','response_boundary','recall_weight','validity'}
        extra={k:x for k,x in v.items() if k not in used and not engine._spec(b['table_id'],k).get('alias_of')}
        return '<十维行为锚点> '+' | '.join(k+'='+text(x) for k,x in dims)+('；补记='+text(extra) if extra else '')+' </十维行为锚点>'
    rendered=[];attached=set()
    for b in remaining:
        rid=b['record_id'];rendered.append(line(b))
        if b['table_id']=='T_CHAR_DOSSIER':
            for f in filters.get(rid,[]):rendered.append('<演出时角色滤镜> '+line(f)+' </演出时角色滤镜>');attached.add((f['table_id'],f['record_id']))
            if not filters.get(rid):rendered.append('<演出时角色滤镜> 沿用档案，未加偏置。 </演出时角色滤镜>')
            for a in anchors.get(rid,[]):rendered.append(anchor(a));attached.add((a['table_id'],a['record_id']))
    for group in [anchors,filters]:
        for rows in group.values():
            for b in rows:
                if (b['table_id'],b['record_id']) not in attached:rendered.append(anchor(b) if b['table_id']=='T_CHAR_ANCHORS' else '<演出时角色滤镜> '+line(b)+' </演出时角色滤镜>')
    if rendered:out['tisya_material_focus_entities']='\n'.join(rendered)
    for slot,blocks in slots.items():
        if slot=='tisya_material_focus_entities':continue
        if isinstance(blocks,str):out[slot]=blocks;continue
        rows=[]
        if slot=='tisya_material_memory_summary':
            for batch in blocks:
                for r in batch.get('rows',[]):
                    if r.get('category')=='事件':rows.append(r.get('raw','').split('|',1)[-1].strip())
                    else:rows.append(r.get('raw',''))
        elif slot=='tisya_material_memory_excerpt':
            for hit in blocks:
                rows.append('原文 '+hit['source_key']+' sha256='+hit['body_sha256'])
                rows.extend(f['paragraph_id']+'：'+f['raw_block'] for f in hit['fragments'])
        elif slot=='tisya_material_event_context':rows.append('世界历法：'+blocks['world_time'])
        else:
            for b in blocks:
                v=b['values']
                if b['table_id']=='T_DYN_EVENTS':
                    code=v.get('short_code') or b['record_id'];time=v.get('time_original_text') or v.get('story_time') or '~';spine=v.get('spine_digest') or v.get('full_process') or v.get('title') or '~'
                    rows.append(f'{code}[{text(time)}]：{text(spine)}')
                    extra={k:x for k,x in v.items() if k not in {'short_code','time_original_text','story_time','spine_digest','title','event_id','source_entry_id','source_revision','source_hash'} and x!=spine}
                    if extra:rows[-1]+='；补记：'+text(extra)
                else:rows.append(line(b))
        if rows:out[slot]='\n'.join(rows)
    # Formal delayed archives and business events have one home. A record is not
    # repeated merely because the same semantic event appeared in <archive> too.
    if out.get('tisya_material_memory_summary'):
        mem=out.get('tisya_material_memory_archive','');known={l.split('：',1)[0] for l in mem.splitlines()}
        rest=[l for l in out.pop('tisya_material_memory_summary').splitlines() if l.split('：',1)[0] not in known]
        if rest:out['tisya_material_memory_archive']='\n'.join(filter(None,[mem,*rest]))
    protocol='''回复外壳：<reply><body>1 正文…\n\n2 正文…</body><cells format="delta">仅变化指令</cells><archive>按需语义归档</archive></reply>。正文保留文学写法，系统结算只写指令区。\n<cells format="delta">逐行结算；只有本轮改变才输出，数字写增量并附 | Pn。稳定目标：表ID#记录ID.字段；容器路径用/键。未提供实际映射时，不能照抄预设示例C17/D17等物理坐标。字段未知先查字典，禁止猜价格/凭空造引用。
@ACT: USE(u01, 道具×1) | P1；自定义动作使用JSON {action,arguments}；@TIME: tick(+1h) | P1。
@EVENTS+: e01[纯世界时间]：前因->过程->已落定结果(原文:P1..P2)
@ANCHORS+: a01 | 角色ID | 源事件ID/短号 | 表层动作 | 触发语境 | 心理防御 | 隐藏执念 | 软化条件 | 0.8 | 强化
@PACTS+: p01 | 双方ID(逗号分隔) | 内容 | 期限/代价 | 状态 | P1
@PREF: 维度 +0.15 | 本轮/会话/世界/全局/角色:ID | 提示词；默认alpha=0.2，仅候选。JSON输入仍支持。
@ROW+: JSON {table_id,record_id,values}；@FIELD+: JSON {table_id,key,type,label}。正文号允许归一化，原文仍保存。'''
    dictionaries=[]
    for tid,rows in targets.items():
        specs=engine.data['schema'][tid]['fields'];used={k for rid in rows for k,state in engine.rows(tid)[rid].get('states',{}).items() if state!='unset'};writable=[f for f in specs if f['key'] in used and f['key']!='row_uuid' and not f.get('alias_of') and not f.get('read_only') and (context.get('audience')=='author' or not f.get('lock_level'))]
        # One dictionary per populated table; record identity appears in its state
        # line rather than a Cartesian product of every record and every field.
        dictionaries.append(tid+' 字段：'+'；'.join(f['key']+'('+f.get('label',f['key'])+'/'+f.get('type','TEXT')+')' for f in writable))
    rules=out.get('tisya_material_cell_prompts','');out['tisya_material_cell_prompts']='\n'.join(filter(None,[protocol,'可用动作：'+', '.join(sorted(engine.operators)),'字段字典只列本轮实际提供的列；完整定义见表单附录。未提供的字段不可猜写，缺项记录待定。',rules,*dictionaries]))
    return out


FUNNEL=[('世界与规则',['world_context','rule_material','faction_context','asset_context','location_context','cardflow']),('当前场景与状态',['current_state','offstage_state','pending_tasks','event_context']),('人物与演出',['player_archive','cast_registry','focus_entities','present_entities','character_archives','habit_anchors']),('认知与证据',['knowledge_material','secret_material','external_evidence']),('因果记忆',['memory_archive','memory_summary','memory_excerpt']),('执行与交接',['cell_prompts','calculation_result','task_analysis','task_material','tool_prompt','tool_calls','tool_result','display_material','style_card','persona_extensions','card_extensions'])]

def funnel_packet(slots):
    blocks=[];seen=set()
    if slots.get('tisya_contractor_wish'):blocks.append('[契约者偏好]\n'+slots['tisya_contractor_wish']);seen.add('tisya_contractor_wish')
    for n,(name,keys) in enumerate(FUNNEL,1):
        items=[]
        for k in keys:
            key='tisya_material_'+k;value=slots.get(key)
            if value:items.append('['+k+']\n'+value);seen.add(key)
        if items:blocks.append(f'[第{n}阶·{name}]\n'+'\n'.join(items))
    blocks.extend('['+k+']\n'+v for k,v in slots.items() if v and k not in seen and 'boundary_' not in k)
    return '\n\n'.join(blocks)
