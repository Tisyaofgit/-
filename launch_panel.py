#!/usr/bin/env python3
"""Local single-page panel backed by the same Tisya Runtime. No pip dependency."""
from __future__ import annotations
import argparse, base64, copy, hashlib, json, os, sys, tempfile, time, traceback, uuid, webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT=Path(__file__).resolve().parent
SRC=ROOT/'matrix_engine_work/src'
sys.path.insert(0,str(SRC))
from matrix_io import EngineError,MatrixBook
from tisya_runtime import Runtime
from reply_memory import accept_reply,materials,recall,nested_records,learn_preference,render_preset

CATALOG=json.loads((SRC/'catalog.json').read_text(encoding='utf-8'))
BOOK=ROOT/'outputs/matrix_engine_rebuild/缇斯亚_二维多对象表单与附录.xlsx'
# Immutable generated attachments, one unpredictable token per export. No world
# state is shared between requests. Attachments live until this process stops.
DOWNLOADS={}


def blank():
    return Runtime({'schema':{t['id']:copy.deepcopy(t) for t in CATALOG['tables']},'tables':{t['id']:{} for t in CATALOG['tables']},'runtime':{},'definition_meta':{k:copy.deepcopy(CATALOG.get(k,[])) for k in ['relations','derivations','common_fields']},'format':'tisya.matrix-state.v1'})


def demo():
    e=blank();e.data['runtime']['scope']={'world_ref':'practice','session_ref':'sandbox','branch_ref':'main','owner_ref':'player'}
    e.new_record('T_STATIC_WORLDS',{'name':'练习世界'},'practice')
    e.new_record('T_CHAR_DOSSIER',{'name':'林舟'},'actor')
    e.new_record('T_CHAR_DOSSIER',{'name':'商人'},'merchant')
    for rid,subject,name,money,herbs in [('rt_actor','actor','林舟',100,2),('rt_merchant','merchant','商人',200,10)]:
        e.new_record('X_OBJECT_RUNTIME',{'subject_ref':subject,'name':name,'current_values':{'stamina':50,'level':1},'carry':{'草药':herbs,'木材':5},'storage':{},'wallet':{'铜币':money},'tags':[]},rid)
    e.new_record('X_ITEM_SPECS',{'name':'草药','buy_price':12,'sell_price':6,'currency':'铜币','weight':0.2,'stamina_cost':0,'use_effects':[{'op':'ADD','target':'{actor}.stamina','value':10}]},'herb')
    e.new_record('X_WORLD_CLOCKS',{'name':'练习时钟','world_ref':'practice','mode':'MONTH_TABLE','year':2024,'month':2,'day':28,'hour':23,'minute':30},'clock')
    e.new_record('X_QUEST_RULES',{'name':'收集木材','actor_ref':'actor','status':'active','requirements':{'木材':2},'rewards':[{'op':'ADD','target':'{actor}.wallet/铜币','value':20}],'repeatable':False,'times_completed':0},'quest')
    e.new_record('X_FINANCIAL_TERMS',{'debtor_ref':'actor','creditor_ref':'merchant','currency_ref':'铜币','amount':30,'paid':0,'status':'unpaid'},'rent')
    e.new_record('X_ACTIONS',{'name':'使用草药','handler':'USE','enabled':True},'USE')
    e.new_record('X_UI_BINDINGS',{'name':'使用草药','table_id':'X_OBJECT_RUNTIME','action_ref':'USE','arguments':{'actor':'{subject_ref}','item':'草药','quantity':1}},'use_herb')
    return e


def state_engine(data,workbook=None):
    if not isinstance(data,dict) or not isinstance(data.get('schema'),dict) or not isinstance(data.get('tables'),dict):
        raise EngineError('STATE_FORMAT','需要包含schema、tables和runtime的引擎状态JSON')
    book=None
    if workbook:
        with tempfile.TemporaryDirectory(prefix='tisya_book_context_') as td:
            p=Path(td)/'source.xlsx';p.write_bytes(base64.b64decode(workbook,validate=True));book=MatrixBook(p,CATALOG);book.read()
    return Runtime(data,book=book)


def execute(payload):
    operation=payload.get('operation');e=state_engine(payload.get('state'),payload.get('workbook_base64'));a=payload.get('args') or {};opid=payload.get('operation_id') or 'panel:'+str(uuid.uuid4());result=None
    if operation=='action':result=e.action(a['action'],a.get('arguments',{}),opid)
    elif operation=='ops':result=e.apply_ops(a.get('lines',[]),opid)
    elif operation=='tick':result=e.tick(a['delta'],opid)
    elif operation=='reply':result=accept_reply(e,a['text'],a['entry_id'],int(a.get('revision',1)),a.get('branch','main'))
    elif operation=='validate':
        issues=e.validate(bool(a.get('strict')));result={'status':'INVALID' if any(x['level']=='error' for x in issues) else 'VALID','issues':issues}
    elif operation=='materials':result=materials(e,a.get('context') or e.data['runtime'].get('scope',{}),a.get('query',''))
    elif operation=='preset':result=render_preset(a['preset'],materials(e,a.get('context') or {},a.get('query','')))
    elif operation=='recall':result=recall(e,a.get('query',''),branch=a.get('branch'))
    elif operation=='nested':result=nested_records(e,a['table_id'])
    elif operation=='panels':result=e.panels()
    elif operation=='expression':result={'value':e.expression(a['expression'],a.get('context',{}))}
    elif operation=='preference':result=learn_preference(e,operation_id=opid,**a)
    elif operation=='add-record':result=e.transaction(opid,{'table_id':a['table_id'],'record_id':a.get('record_id'),'values':a.get('values',{})},lambda:{'record_id':e.new_record(a['table_id'],a.get('values',{}),a.get('record_id'))})
    elif operation=='edit-record':
        def edit():
            target=e._record(a['table_id'],a['record_id'])
            for key,change in a.get('changes',{}).items():
                if 'formula' in change:
                    e._spec(a['table_id'],key);target['formulas'][key]=change['formula'];target['states'][key]='derived'
                else:
                    target['formulas'].pop(key,None);e.set(f"{a['table_id']}#{a['record_id']}.{key}",change.get('value'),change.get('state','known'))
            return {'record_id':a['record_id'],'fields':list(a.get('changes',{}))}
        result=e.transaction(opid,{'edit':a},edit)
    elif operation=='delete-record':
        def delete():
            e._record(a['table_id'],a['record_id']);del e.data['tables'][a['table_id']][a['record_id']]
            for rid,r in list(e.rows('X_RECORD_META').items()):
                if r['values'].get('table_id')==a['table_id'] and r['values'].get('record_id')==a['record_id']:del e.data['tables']['X_RECORD_META'][rid]
            return {'deleted':a['record_id']}
        result=e.transaction(opid,{'delete':a},delete)
    elif operation=='add-field':result=e.transaction(opid,{'field':a},lambda:e.declare_field(a['table_id'],a['field']))
    elif operation=='add-table':
        if a['table_id'] in e.data['schema']:raise EngineError('TABLE_EXISTS','表ID已存在',table=a['table_id'])
        e.register_table(a['table_id'],a.get('fields',[]),a.get('label'));result={'table_id':a['table_id'],'status':'CREATED'}
    else:raise EngineError('PANEL_OPERATION','未知面板操作',operation=operation)
    return {'ok':True,'result':result,'state':e.data}


class Handler(BaseHTTPRequestHandler):
    server_version='TisyaSandbox/1.0'
    def respond(self,status,data,kind='application/json; charset=utf-8',attachment=None):
        body=json.dumps(data,ensure_ascii=False).encode() if not isinstance(data,bytes) else data
        self.send_response(status);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(body)));self.send_header('Cache-Control','no-store');self.send_header('Access-Control-Allow-Origin','*')
        if attachment:self.send_header('Content-Disposition','attachment; filename="tisya_saved.xlsx"')
        self.end_headers();self.wfile.write(body)
    def do_OPTIONS(self):
        self.send_response(204);self.send_header('Access-Control-Allow-Origin','*');self.send_header('Access-Control-Allow-Headers','Content-Type');self.send_header('Access-Control-Allow-Methods','GET, POST, OPTIONS');self.end_headers()
    def do_GET(self):
        route=self.path.split('?',1)[0]
        if route in ['/','/index.html']:return self.respond(200,(ROOT/'backend-panel/index.html').read_bytes(),'text/html; charset=utf-8')
        if route=='/api/health':return self.respond(200,{'ok':True,'engine':'Python Runtime','python':sys.version.split()[0],'tables':len(CATALOG['tables']),'operators':list(blank().operators),'version':'panel-1'})
        if route=='/api/blank':return self.respond(200,{'ok':True,'state':blank().data})
        if route=='/api/demo':return self.respond(200,{'ok':True,'state':demo().data,'fixture_only':True})
        if route.startswith('/api/download/'):
            token=route.rsplit('/',1)[-1];blob=DOWNLOADS.get(token)
            if blob is None:return self.respond(404,{'ok':False,'error':{'code':'DOWNLOAD_MISSING','message':'此导出已不在当前服务中，请重新生成工作簿。'}})
            return self.respond(200,blob,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',attachment=True)
        if route=='/blank.xlsx':return self.respond(200,BOOK.read_bytes(),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        return self.respond(404,{'ok':False,'error':{'code':'ROUTE_MISSING','message':'没有此入口'}})
    def do_POST(self):
        request_id=str(uuid.uuid4());payload=None;started=time.perf_counter()
        try:
            payload=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))));route=self.path.split('?',1)[0]
            if route=='/api/execute':result=execute(payload)
            elif route=='/api/import-json':result={'ok':True,'state':state_engine(payload['state']).data}
            elif route in ['/api/import-xlsx','/api/export-xlsx']:
                with tempfile.TemporaryDirectory(prefix='tisya_panel_') as td:
                    source=Path(td)/'input.xlsx';source.write_bytes(base64.b64decode(payload['workbook_base64'],validate=True) if payload.get('workbook_base64') else BOOK.read_bytes())
                    book=MatrixBook(source,CATALOG);state=book.read()
                    if route=='/api/import-xlsx':result={'ok':True,'state':Runtime(state,book).data}
                    else:
                        e=state_engine(payload['state']);e.book=book;destination=Path(td)/'result.xlsx';e.save_xlsx(destination)
                        blob=destination.read_bytes();result={'ok':True,'workbook_base64':base64.b64encode(blob).decode(),'sha256':hashlib.sha256(blob).hexdigest()}
                        if payload.get('download_link'):
                            token=str(uuid.uuid4());DOWNLOADS[token]=blob;result['download_path']='/api/download/'+token
            else:raise EngineError('ROUTE_MISSING','没有此入口',path=route)
            result['request_id']=request_id;result['elapsed_ms']=round((time.perf_counter()-started)*1000,2);self.respond(200,result)
        except Exception as exc:
            error=exc.as_dict() if isinstance(exc,EngineError) else {'code':'PANEL_SERVER_ERROR','message':str(exc),'exception':type(exc).__name__,'traceback':traceback.format_exc()}
            self.log_error('%s %s',request_id,error)
            self.respond(422,{'ok':False,'request_id':request_id,'error':error,'submitted_reply':(payload or {}).get('args',{}).get('text') if isinstance(payload,dict) else None,'elapsed_ms':round((time.perf_counter()-started)*1000,2)})


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--host',default='127.0.0.1');p.add_argument('--port',type=int,default=int(os.environ.get('PORT','8765')));p.add_argument('--no-browser',action='store_true');p.add_argument('--strictPort',action='store_true',help=argparse.SUPPRESS);a=p.parse_args()
    server=ThreadingHTTPServer((a.host,a.port),Handler);port=server.server_port;url=f'http://127.0.0.1:{port}'
    print(f'缇斯亚交互沙盒已启动：{url}\n此窗口关闭后本地引擎停止；页面可导出JSON/XLSX保存。',flush=True)
    if not a.no_browser:webbrowser.open(url)
    try:server.serve_forever()
    except KeyboardInterrupt:print('\n面板引擎已停止。',flush=True)
    finally:server.server_close()

if __name__=='__main__':main()
