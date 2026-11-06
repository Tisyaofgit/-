#!/usr/bin/env python3
"""SillyTavern companion using the same engine and existing panel HTTP routes."""
import argparse, json, sys, traceback
from pathlib import Path
from http.server import ThreadingHTTPServer
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT))
import launch_panel
from chat_journal import reconcile
from matrix_io import EngineError

class Handler(launch_panel.Handler):
    server_version='TisyaCompanion/1.0'
    def origin_allowed(self):
        origin=self.headers.get('Origin');return not origin or origin in self.server.allowed_origins
    def respond(self,status,data,kind='application/json; charset=utf-8',attachment=None):
        body=json.dumps(data,ensure_ascii=False).encode() if not isinstance(data,bytes) else data
        self.send_response(status);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(body)));self.send_header('Cache-Control','no-store');self.send_header('Vary','Origin')
        origin=self.headers.get('Origin')
        if origin and origin in self.server.allowed_origins:self.send_header('Access-Control-Allow-Origin',origin)
        if attachment:self.send_header('Content-Disposition','attachment; filename="tisya_saved.xlsx"')
        self.end_headers();self.wfile.write(body)
    def do_OPTIONS(self):
        if not self.origin_allowed():return self.respond(403,{'ok':False,'error':{'code':'ORIGIN_NOT_ALLOWED','message':'在启动参数--allow-origin中添加酒馆页面的实际源'}})
        self.send_response(204);self.send_header('Access-Control-Allow-Origin',self.headers.get('Origin',''));self.send_header('Access-Control-Allow-Headers','Content-Type');self.send_header('Access-Control-Allow-Methods','GET, POST, OPTIONS');self.send_header('Access-Control-Allow-Private-Network','true');self.end_headers()
    def do_GET(self):
        if not self.origin_allowed():return self.respond(403,{'ok':False,'error':{'code':'ORIGIN_NOT_ALLOWED'}})
        route=self.path.split('?',1)[0]
        if route=='/host-contract.html':return self.respond(200,(ROOT/'host-contract.html').read_bytes(),'text/html; charset=utf-8')
        if route.startswith('/extension/tisya-engine/'):
            name=route.rsplit('/',1)[-1]
            if name not in {'index.js','core.mjs','style.css','manifest.json'}:return self.respond(404,{'ok':False})
            kind='text/css' if name.endswith('.css') else 'application/json' if name.endswith('.json') else 'text/javascript'
            return self.respond(200,(ROOT/'extension/tisya-engine'/name).read_bytes(),kind+'; charset=utf-8')
        if self.path.split('?',1)[0]=='/api/plugin/health':return self.respond(200,{'ok':True,'version':'tisya-plugin-1','tables':len(launch_panel.CATALOG['tables']),'features':['line-transactions','dual-source-hash','business-pipes','compact-materials','message-rewind']})
        return super().do_GET()
    def do_POST(self):
        if not self.origin_allowed():return self.respond(403,{'ok':False,'error':{'code':'ORIGIN_NOT_ALLOWED'}})
        if self.path.split('?',1)[0]!='/api/plugin/reconcile':return super().do_POST()
        try:
            p=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))));out=reconcile(p['bundle'],p['messages'],p.get('scope'));self.respond(200,out)
        except Exception as exc:
            error=exc.as_dict() if isinstance(exc,EngineError) else {'code':'PLUGIN_SERVER_ERROR','message':str(exc),'traceback':traceback.format_exc()}
            self.respond(422,{'ok':False,'error':error})

def main():
    p=argparse.ArgumentParser();p.add_argument('--host',default='127.0.0.1');p.add_argument('--port',type=int,default=8765);p.add_argument('--allow-origin',action='append',default=[]);p.add_argument('--strictPort',action='store_true',help=argparse.SUPPRESS);a=p.parse_args()
    server=ThreadingHTTPServer((a.host,a.port),Handler);server.allowed_origins=set(a.allow_origin or ['http://127.0.0.1:8000','http://localhost:8000'])|{f'http://127.0.0.1:{server.server_port}',f'http://localhost:{server.server_port}'}
    print('缇斯亚酒馆伴随引擎：http://'+a.host+':'+str(server.server_port)+'；允许来源：'+', '.join(sorted(server.allowed_origins)),flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close()
if __name__=='__main__':main()
