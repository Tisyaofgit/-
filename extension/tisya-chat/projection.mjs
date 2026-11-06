import {ProjectionCache,escapeHTML as esc} from './services.mjs';
export const projectionCache=new ProjectionCache();
export const FORMAT='tisya-onepass-1';
const read=(s,name)=>{const m=s.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`));return m?m[1].trim():null;};
export function parseReply(source){
  if(!/^\s*<reply\b[^>]*\bid=["']tisya-onepass-1["']/.test(source))return {kind:'native',source};
  if(!/<\/reply>\s*$/.test(source))return {kind:'partial',source,error:'回复尚未闭合'};
  const body=read(source,'body');if(body===null)return {kind:'invalid',source,error:'本轮回复缺少正文 body'};
  const extras=read(source,'extra')??'';
  const position=extras.match(/^@POSITION:\s*(top|after-body|tail)\s*/);
  const actions=(read(source,'actions')??'').split('\n').map(x=>x.trim()).filter(Boolean).map(line=>{const [type,text,...rest]=line.split('|');return {type:type.trim(),text:text?.trim()??'',hint:rest.join('|').trim()};}).filter(x=>x.text);
  const anchors=[...source.matchAll(/<anchor\b([^>]*)>([\s\S]*?)<\/anchor>/g)].map(m=>({phase:/phase=["']after["']/.test(m[1])?'after':'before',text:m[2].trim()}));
  return {kind:'reply',body,title:read(source,'title'),extra:position?extras.slice(position[0].length):extras,position:position?.[1]??'tail',actions,anchors,task:read(source,'task'),source};
}
const literal=text=>esc(text).replaceAll('`','&#96;');
function detail(label,text){return text?`\n\n<details class="tisya-reply-detail"><summary>${label}</summary><pre class="tisya-raw-reply"><code>${literal(text)}</code></pre></details>\n\n`:'';}
export function projectReply(source,{key='preview',streaming=false}={}){
  const data=projectionCache.read(key,FORMAT+'\0'+source,()=>parseReply(source));
  if(data.kind==='native')return source;
  if(data.kind==='partial'||data.kind==='invalid')return `${streaming?'':'<p class="tisya-render-error">'+esc(data.error)+'；原文保留如下。</p>'}\n\n<pre class="tisya-raw-reply"><code>${literal(source)}</code></pre>`;
  const extra=data.extra?'\n\n'+data.extra+'\n\n':'';
  const actions=data.actions.length?'<details class="tisya-actions"><summary>下一步 · 行动</summary>'+data.actions.map(a=>`<p><a href="#tisya-action=${encodeURIComponent(a.text)}">${esc(a.type)} · ${esc(a.text)}</a>${a.hint?'<small>'+esc(a.hint)+'</small>':''}</p>`).join('')+'</details>':'';
  return `${data.position==='top'?extra:''}${data.title?'\n\n<h3 class="tisya-chapter">'+esc(data.title)+'</h3>\n\n':''}${data.body}${data.position==='after-body'?extra:''}${data.anchors.map(a=>detail(a.phase==='after'?'本回合 · 缇斯亚的话':'开笔前 · 心声',a.text)).join('')}${detail('本轮任务与核验',data.task)}\n\n${actions}${data.position==='tail'?extra:''}${detail('原始回复',data.source)}`;
}
