import {ProjectionCache} from './services.mjs';

let sequence=900000;
const active=new Map();
const documents=new ProjectionCache({maxEntries:48,maxBytes:4*1024*1024});
export const frontendReport=()=>({active:active.size,frames:[...active.keys()],templates:documents.report()});

// Executed in the child before card scripts. Rendering never calls an MVU update.
function bridge(){
  const p=parent, frame=window.frameElement;
  const helper=p.TavernHelper;
  window.__TH_IFRAME_ID=frame.id;window.name=frame.id;
  for(const name of ['_','toastr','YAML','showdown','z','EjsTemplate'])if(name in p)window[name]=p[name];
  if(helper){
    window.TavernHelper=helper;
    for(const [name,value] of Object.entries(helper))if(name!=='_bind')window[name]=value;
    for(const [name,fn] of Object.entries(helper._bind??{}))if(typeof fn==='function')window[name.replace(/^_/,'')]=fn.bind(window);
  }
  Object.defineProperty(window,'SillyTavern',{get:()=>Object.assign({},p.SillyTavern.getContext(),{getContext:p.SillyTavern.getContext})});
  Object.defineProperty(window,'Mvu',{get:()=>p.Mvu,set:()=>{},configurable:true});
  window.__VUE_PROD_DEVTOOLS__=true;window.__VUE_OPTIONS_API__=true;window.__VUE_PROD_HYDRATION_MISMATCH_DETAILS__=false;
  let observer,raf=0,disposed=false;
  const cleanups=new Set(),parentTimers=new Map();
  window.TisyaFrontend={onDispose(fn){cleanups.add(fn);return()=>cleanups.delete(fn);}};
  // Card code can use parent timers/listeners, but their lifetime belongs to this frame.
  let proxy;proxy=new Proxy(p,{get(target,key){
    if(['parent','self','window','globalThis'].includes(key))return proxy;
    if(key==='addEventListener')return(type,listener,options)=>{target.addEventListener(type,listener,options);cleanups.add(()=>target.removeEventListener(type,listener,options));};
    if(['setTimeout','setInterval','requestAnimationFrame'].includes(key))return(callback,...args)=>{let id;const run=(...values)=>{if(key!=='setInterval')parentTimers.delete(key+':'+id);return typeof callback==='function'?callback(...values):target.eval(callback);};id=target[key](run,...args);parentTimers.set(key+':'+id,()=>target[key==='requestAnimationFrame'?'cancelAnimationFrame':key==='setInterval'?'clearInterval':'clearTimeout'](id));return id;};
    if(['clearTimeout','clearInterval','cancelAnimationFrame'].includes(key))return id=>{for(const type of ['setTimeout','setInterval','requestAnimationFrame'])parentTimers.delete(type+':'+id);target[key](id);};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  Object.defineProperty(window,'parent',{get:()=>proxy,configurable:true});
  const fail=error=>frame.dispatchEvent(new CustomEvent('tisya-frame-error',{detail:String(error?.message??error)}));
  window.addEventListener('error',e=>fail(e.error??e.message??('资源加载失败：'+(e.target?.src??e.target?.href??'未知资源'))),true);
  window.addEventListener('unhandledrejection',e=>fail(e.reason));
  const measure=()=>{raf=0;if(disposed)return;const h=Math.ceil(Math.max(document.body?.getBoundingClientRect().height??0,document.body?.scrollHeight??0,1));if(frame.style.height!==h+'px')frame.style.height=h+'px';};
  const resize=()=>{if(!raf)raf=requestAnimationFrame(measure);};
  const viewport=()=>document.documentElement.style.setProperty('--TH-viewport-height',p.innerHeight+'px');
  viewport();p.addEventListener('resize',viewport);
  window.addEventListener('DOMContentLoaded',()=>{observer=new ResizeObserver(resize);observer.observe(document.body);resize();document.fonts.ready.then(resize).catch(fail);});
  window.addEventListener('load',resize);
  window.__tisyaDispose=()=>{if(disposed)return;disposed=true;observer?.disconnect();cancelAnimationFrame(raf);p.removeEventListener('resize',viewport);for(const fn of [...cleanups,...parentTimers.values()])try{fn();}catch(error){fail(error);}cleanups.clear();parentTimers.clear();window.eventClearAll?.();};
  window.addEventListener('pagehide',window.__tisyaDispose,{once:true});
}

export function makeFrameDocument(html,origin,Parser=DOMParser){
  let hash=2166136261;for(let i=0;i<html.length;i++)hash=Math.imul(hash^html.charCodeAt(i),16777619);
  return documents.read(origin+':'+(hash>>>0),html,()=>compileFrameDocument(html,origin,Parser));
}
function compileFrameDocument(html,origin,Parser){
  const doc=new Parser().parseFromString(html,'text/html');
  const stableViewport=value=>value.replace(/(-?\d*\.?\d+)(?:vh|dvh|svh|lvh)\b/g,(_,n)=>`calc(var(--TH-viewport-height) * ${Number(n)/100})`);
  for(const style of doc.querySelectorAll('style'))style.textContent=stableViewport(style.textContent);
  for(const element of doc.querySelectorAll('[style]'))element.setAttribute('style',stableViewport(element.getAttribute('style')));
  const base=doc.createElement('base');base.href=origin+'/';
  const meta=doc.createElement('meta');meta.name='viewport';meta.content='width=device-width, initial-scale=1';
  const style=doc.createElement('style');style.textContent='html,body{margin:0;padding:0;max-width:100%;overflow-x:hidden}body{display:flow-root}*,*::before,*::after{box-sizing:border-box}';
  const jquery=doc.createElement('script');jquery.src=new URL('/lib/jquery-3.5.1.min.js',origin).href;
  const dependencies=['/lib/jquery-ui.min.js','/lib/jquery.ui.touch-punch.min.js',...['vue.runtime.global.prod.js','vue-router.global.prod.js','tailwindcss.min.js'].map(name=>new URL('assets/'+name,import.meta.url).href)].map(src=>{const node=doc.createElement('script');node.src=new URL(src,origin).href;return node;});
  const icons=doc.createElement('link');icons.rel='stylesheet';icons.href=new URL('/css/fontawesome.min.css',origin).href;
  const solid=doc.createElement('link');solid.rel='stylesheet';solid.href=new URL('/css/solid.min.css',origin).href;
  const init=doc.createElement('script');init.textContent='('+bridge.toString()+')();';
  doc.head.prepend(base,meta,style,jquery,init,icons,solid,...dependencies);
  return '<!doctype html>\n'+doc.documentElement.outerHTML;
}

export function mountFrontend({source,mesid,signal},{document=globalThis.document,onError=()=>{}}={}){
  const html=source.querySelector('code')?.textContent??source.textContent;
  const parent=source.parentNode,slot=document.createElement('div');slot.className='tisya-frontend';
  const height=Number(source.dataset.tisyaHeight)||180;slot.style.minHeight=height+'px';
  const iframe=document.createElement('iframe');iframe.id=`TH-message--${mesid}--${++sequence}`;iframe.name=iframe.id;iframe.title=`第 ${mesid+1} 楼 · 卡片前端`;
  iframe.className='tisya-frontend-frame';iframe.style.height=height+'px';iframe.setAttribute('scrolling','no');
  const error=document.createElement('p');error.className='tisya-render-error';error.hidden=true;
  const report=event=>{const message=event.detail??event.message??'前端加载失败';error.hidden=false;error.textContent='卡片前端：'+message;onError(Error(message));};
  iframe.addEventListener('tisya-frame-error',report);
  // No HTML is put in the host page. This is the card's intentional script runtime.
  iframe.srcdoc=makeFrameDocument(html,document.location.origin);
  source.hidden=true;source.removeAttribute('inert');source.classList.remove('tisya-frontend-inert');parent.insertBefore(slot,source.nextSibling);slot.append(iframe,error);active.set(iframe.id,iframe);
  let disposed=false;
  const dispose=()=>{if(disposed)return;disposed=true;const measured=Math.ceil(iframe.getBoundingClientRect().height);source.dataset.tisyaHeight=String(measured||height);try{iframe.contentWindow?.__tisyaDispose?.();}catch(e){onError(e);}iframe.removeEventListener('tisya-frame-error',report);active.delete(iframe.id);iframe.srcdoc='';slot.remove();source.hidden=false;source.setAttribute('inert','');source.style.height=(measured||height)+'px';source.classList.add('tisya-frontend-inert');signal?.removeEventListener('abort',dispose);};
  signal?.addEventListener('abort',dispose,{once:true});if(signal?.aborted)dispose();return dispose;
}

export function registerFrontend(api,{onError=()=>{}}={}){
  if(api?.protocolVersion!==1||typeof api.registerParticipant!=='function')throw Error('缇斯亚前端需要 ChatSurface v1；未启用旧渲染回退。');
  return api.registerParticipant({id:'tisya-chat/frontend',protocolVersion:1,
    prepareContent({content},claims){
      for(const code of content.querySelectorAll('pre > code')){
        if(code.closest('.custom-tisya-raw-reply,.tisya-raw-reply'))continue;
        const html=['custom-language-html','custom-html','language-html','hljs-html'].some(name=>code.classList.contains(name))||/^\s*(?:<!doctype\s+html|<html\b)/i.test(code.textContent);
        if(!html)continue;const source=code.parentElement;source.classList.add('tisya-frontend-source');claims.claim(source,context=>mountFrontend(context,{document:content.ownerDocument,onError}));
      }
    }
  });
}
