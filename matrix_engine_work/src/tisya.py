#!/usr/bin/env python3
"""Single command line for matrix forms, registered actions and reply pipelines."""
from __future__ import annotations
import argparse, copy, json, sys, traceback, uuid
from pathlib import Path
from matrix_io import EngineError, MatrixBook
from tisya_runtime import Runtime
from reply_memory import accept_reply, materials, recall, render_preset, learn_preference,nested_records

ROOT=Path(__file__).resolve().parent


def load_json(arg):
    if arg is None:return {}
    p=Path(arg)
    if not arg.lstrip().startswith(('{','[')) and p.is_file():return json.loads(p.read_text())
    return json.loads(arg)


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--catalog',type=Path,default=ROOT/'catalog.json');sub=p.add_subparsers(dest='command',required=True)
    for cmd in ['inspect','export','validate','panels','project','recall','nested','add-record','action','ops','tick','reply','pipeline','preference','fork','legacy-operator']:
        a=sub.add_parser(cmd);a.add_argument('input',type=Path);a.add_argument('--out',type=Path)
        if cmd in {'action','ops','tick','reply','pipeline','preference','add-record','fork'}:a.add_argument('--operation-id')
        if cmd=='action':a.add_argument('--action',required=True);a.add_argument('--args',default='{}')
        if cmd=='ops':a.add_argument('--ops',required=True,help='JSON list or path to JSON list')
        if cmd=='tick':a.add_argument('--delta',required=True)
        if cmd in {'reply','pipeline'}:a.add_argument('--reply-file',type=Path,required=True);a.add_argument('--entry-id',required=True);a.add_argument('--revision',type=int,default=1);a.add_argument('--branch',default='main')
        if cmd=='pipeline':a.add_argument('--out-xlsx',type=Path,required=True);a.add_argument('--materials-out',type=Path,required=True);a.add_argument('--context',default='{}')
        if cmd=='project':a.add_argument('--context',default='{}');a.add_argument('--query',default='');a.add_argument('--preset',type=Path)
        if cmd=='recall':a.add_argument('--query',default='');a.add_argument('--branch')
        if cmd=='nested':a.add_argument('--table',required=True)
        if cmd=='validate':a.add_argument('--strict',action='store_true')
        if cmd=='add-record':a.add_argument('--table',required=True);a.add_argument('--record-id');a.add_argument('--values',default='{}')
        if cmd=='preference':a.add_argument('--data',required=True)
        if cmd=='fork':a.add_argument('--branch',required=True)
        if cmd=='legacy-operator':a.add_argument('--operator',required=True);a.add_argument('--args',default='{}');a.add_argument('--node',default='node')
    a=sub.add_parser('write-xlsx');a.add_argument('input',type=Path);a.add_argument('--workbook',type=Path,required=True);a.add_argument('--out',type=Path,required=True)
    args=p.parse_args();command=args.command
    if args.input.suffix.lower()=='.xlsx':
        if not args.catalog.is_file():raise EngineError('CATALOG_MISSING','Place catalog.json beside the scripts or pass --catalog',path=str(args.catalog))
        engine=Runtime.from_xlsx(args.input,json.loads(args.catalog.read_text()))
    else:engine=Runtime.from_json(args.input)
    result=None;mutated=False
    if command in {'inspect','validate'}:
        issues=engine.validate(getattr(args,'strict',False));errors=[x for x in issues if x['level']=='error']
        result={'status':'VALID' if not errors else 'INVALID','table_definitions':len(engine.data['schema']),'active_records':sum(len(x) for x in engine.data['tables'].values()),'counts_by_table':{k:len(v) for k,v in engine.data['tables'].items() if v},'issues':issues,'host_tested':False,'model_tested':False,'android_tested':False}
    elif command=='export':result={'status':'EXPORTED','active_records':sum(len(x) for x in engine.data['tables'].values())};mutated=True
    elif command=='panels':result=engine.panels()
    elif command=='project':
        slot=materials(engine,load_json(args.context),args.query)
        result=render_preset(json.loads(args.preset.read_text()),slot) if args.preset else slot
    elif command=='recall':result=recall(engine,args.query,branch=args.branch)
    elif command=='nested':result=nested_records(engine,args.table)
    elif command=='add-record':
        values=load_json(args.values);result=engine.transaction(args.operation_id or 'new-record:'+str(uuid.uuid4()),{'table':args.table,'values':values,'record_id':args.record_id},lambda:{'record_id':engine.new_record(args.table,values,args.record_id)});mutated=True
    elif command=='action':result=engine.action(args.action,load_json(args.args),args.operation_id);mutated=True
    elif command=='ops':result=engine.apply_ops(load_json(args.ops),args.operation_id or 'ops:'+str(uuid.uuid4()));mutated=True
    elif command=='tick':result=engine.tick(args.delta,args.operation_id or 'tick:'+str(uuid.uuid4()));mutated=True
    elif command in {'reply','pipeline'}:
        if command=='pipeline':engine.data['runtime']['scope'].update(load_json(args.context))
        result=accept_reply(engine,args.reply_file.read_bytes().decode('utf-8'),args.entry_id,args.revision,args.branch);mutated=True
    elif command=='preference':result=learn_preference(engine,operation_id=args.operation_id or 'preference:'+str(args.input),**load_json(args.data));mutated=True
    elif command=='fork':
        engine.data['runtime']['fork_origin']={'scope':copy.deepcopy(engine.data['runtime']['scope']),'revision':engine.data['runtime']['revision']};engine.data['runtime']['scope']['branch_ref']=args.branch;result={'status':'FORKED','branch':args.branch};mutated=True
    elif command=='write-xlsx':
        book=MatrixBook(args.workbook,json.loads(args.catalog.read_text()));book.read();engine.book=book;engine.save_xlsx(args.out);result={'status':'SAVED','workbook':str(args.out)}
    elif command=='legacy-operator':
        import subprocess
        q=subprocess.run([args.node,str(ROOT/'legacy_operator.mjs')],input=json.dumps({'operator':args.operator,'args':load_json(args.args)},ensure_ascii=False),capture_output=True,text=True)
        if q.returncode:raise EngineError('LEGACY_OPERATOR','Specialized mechanical operator failed',stdout=q.stdout,stderr=q.stderr)
        result=json.loads(q.stdout)
    if mutated:
        if not args.out:raise EngineError('OUTPUT_REQUIRED','Choose --out to save the actual result state')
        if args.out.suffix.lower()=='.xlsx':engine.save_xlsx(args.out)
        else:engine.save_json(args.out)
    elif args.out and command!='write-xlsx':args.out.parent.mkdir(parents=True,exist_ok=True);args.out.write_text(json.dumps(result,ensure_ascii=False,indent=2))
    if command=='pipeline' and result.get('status') not in {'FAILED'}:
        engine.save_xlsx(args.out_xlsx)
        # Reopen saved data before producing the next model's materials.
        reopened=Runtime.from_xlsx(args.out_xlsx,json.loads(args.catalog.read_text()))
        packet=materials(reopened,reopened.data['runtime'].get('scope',{})|{'branch_ref':args.branch})
        args.materials_out.parent.mkdir(parents=True,exist_ok=True);args.materials_out.write_text(json.dumps(packet,ensure_ascii=False,indent=2))
        result['saved_workbook']=str(args.out_xlsx);result['materials_output']=str(args.materials_out)
    if result is None:raise EngineError('COMMAND','No command result')
    print(json.dumps(result,ensure_ascii=False,indent=2))
    return 2 if isinstance(result,dict) and result.get('status') in {'FAILED','INVALID'} else 0


if __name__=='__main__':
    try:raise SystemExit(main())
    except EngineError as exc:print(json.dumps({'status':'FAILED','error':exc.as_dict()},ensure_ascii=False),file=sys.stderr);raise SystemExit(2)
    except Exception as exc:traceback.print_exc();raise SystemExit(3)
