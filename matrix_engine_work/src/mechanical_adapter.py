"""Adapt the new matrices to the preserved specialized mechanical consumers."""
from pathlib import Path
import copy,json,subprocess
from matrix_io import EngineError


def payload_from_runtime(engine):
    payload={'tables':{},'child_tables':{},'parameters':{},'derivations':engine.data.get('definition_meta',{}).get('derivations',[]),'source_manifests':[],'parameter_bindings':[]}
    metadata={(r['values'].get('table_id'),r['values'].get('record_id')):r for r in engine.rows('X_RECORD_META').values()}
    for tid,rows in engine.data['tables'].items():
        if not tid.startswith(('T_','M_')):continue
        target='child_tables' if tid.startswith('M_') else 'tables';payload[target][tid]=[]
        for rid,r in rows.items():
            meta=metadata.get((tid,rid),{});common={k:v for k,v in meta.get('values',{}).items() if k not in {'row_uuid','table_id','record_id'}};values=copy.deepcopy(common|r['values']);states={k:'known' for k in common}|copy.deepcopy(r['states'])
            if target=='tables':payload[target][tid].append({'row_uuid':rid,'values':values,'value_states':states,'record_state':'active','cell_metadata':copy.deepcopy(r.get('metadata',{}))})
            else:payload[target][tid].append(values|{'__value_states':states})
    for source in engine.data['runtime']['sources'].values():
        manifest={'entry_id':source['entry_id'],'revision':source['revision'],'expected_chunks':len(source['fragments']),'first_chunk_index':1,'sha256':source['body_sha256'],'byte_length':len(source['body_raw'].encode()),'encoding':'UTF-8','newline_normalization':False}
        payload['source_manifests'].append(manifest)
    return payload


def calculate(engine,operator=None,arguments=None,rule=None,macro=None,owner=None,node='node'):
    request={'operator':operator,'args':arguments or {}}
    if rule or macro:request={'payload':payload_from_runtime(engine),'formula_ref':rule,'macro_ref':macro,'owner':owner or {}}
    try:r=subprocess.run([node,str(Path(__file__).with_name('legacy_operator.mjs'))],input=json.dumps(request,ensure_ascii=False),capture_output=True,text=True,timeout=30)
    except (OSError,subprocess.TimeoutExpired) as exc:raise EngineError('MECHANICAL_PROCESS','Specialized operator could not run',error=str(exc))
    if r.returncode:raise EngineError('MECHANICAL_RESULT','Specialized operator reported a failure',stdout=r.stdout,stderr=r.stderr)
    result=json.loads(r.stdout)
    return result


def install(engine):
    def handler(ctx):
        result=calculate(engine,ctx.get('operator'),ctx.get('arguments'),ctx.get('rule_ref'),ctx.get('macro_ref'),ctx.get('owner'),ctx.get('node','node'))
        if ctx.get('output_target'):engine.set(ctx['output_target'],result['result'])
        return result
    engine.operators['MECHANICAL']=handler
