"""Exercise the packaged companion over HTTP, with disposable blank state."""
from pathlib import Path
import base64, json, subprocess, sys, threading, urllib.error, urllib.request

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import plugin_server

server=plugin_server.ThreadingHTTPServer(('127.0.0.1',0),plugin_server.Handler)
server.allowed_origins={'tauri://localhost'}
worker=threading.Thread(target=server.serve_forever,daemon=True)
worker.start()
base=f'http://127.0.0.1:{server.server_port}'

def request(route,data=None,origin='tauri://localhost'):
    req=urllib.request.Request(base+route,data=None if data is None else json.dumps(data).encode(),headers={'Origin':origin,'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=45) as response:
        assert response.headers['Access-Control-Allow-Origin']==origin
        return json.load(response)

try:
    health=request('/api/plugin/health');assert health['ok']
    state=request('/api/blank')['state'];assert len(state['tables'])==health['tables']
    assert all(not rows for rows in state['tables'].values()),'blank state must not contain saved characters'
    output=request('/api/plugin/reconcile',{'bundle':{'state':state},'messages':[{'uid':'release-check-1','role':'assistant','text':'这是发布连接检查。'}]})
    assert output['ok'],output
    assert output['result']['processed']==1,output['result']
    exported=request('/api/export-xlsx',{'state':state})
    assert base64.b64decode(exported['workbook_base64']).startswith(b'PK')
    for asset in ['/','/host-contract.html','/extension/tisya-engine/core.mjs']:
        with urllib.request.urlopen(base+asset) as response:assert response.status==200 and response.read()
    try:request('/api/plugin/health',origin='https://unapproved.invalid')
    except urllib.error.HTTPError as error:assert error.code==403
    else:raise AssertionError('unapproved origin was accepted')
    try:request('/api/plugin/reconcile',{'bundle':{},'messages':[]})
    except urllib.error.HTTPError as error:
        assert error.code==422
        assert json.load(error)['error']['code']=='CHAT_BUNDLE'
    else:raise AssertionError('invalid state was accepted')
    model=subprocess.run(['node',str(ROOT/'public/js/persona-model.js')],input=json.dumps({'state':{},'event':{'id':'release-check','kind':'configure','values':{'instincts.食':50}}}),text=True,capture_output=True,check=True)
    assert json.loads(model.stdout)
    print(json.dumps({'status':'passed','kind':'real_local_http','tables':health['tables'],'reconcile':True,'xlsxExport':True,'cors':True,'errorPropagation':True,'personaNodeProcess':True}))
finally:
    server.shutdown();server.server_close();worker.join()
