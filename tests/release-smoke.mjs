// Run with: node --experimental-vm-modules tests/release-smoke.mjs
// A simulated loader checks the distribution entry, not a native-host UI test.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'));
const listeners=new Map(), hooks=[], participants=[];
const extensionSettings={};
const host={eventSource:{on:(name,fn)=>listeners.set(name,fn)},eventTypes:{APP_READY:'APP_READY'},
  messageFormatter:{addHook:(fn,options)=>hooks.push({fn,options}),stage:{AFTER_REGEX:1},order:{LATE:100}}};
const context=vm.createContext({console,URL,TextEncoder,structuredClone,setTimeout,clearTimeout,
  document:{readyState:'loading',addEventListener:(name,fn)=>listeners.set(name,fn)},
  SillyTavern:{getContext:()=>host},
  __TAURITAVERN__:{api:{chatSurface:{protocolVersion:1,registerParticipant:p=>{participants.push(p);return {id:p.id};}}}}});
const cache=new Map();
const settings=new vm.SyntheticModule(['extension_settings'],function(){this.setExport('extension_settings',extensionSettings);},{context});
async function load(filename){
  if(cache.has(filename))return cache.get(filename);
  const module=new vm.SourceTextModule(await fs.readFile(filename,'utf8'),{context,identifier:filename,
    initializeImportMeta:meta=>{meta.url=pathToFileURL(filename).href;}});
  cache.set(filename,module);
  await module.link((specifier,from)=>specifier==='/scripts/extensions.js'?settings:load(path.resolve(path.dirname(from.identifier),specifier)));
  return module;
}
const entry=await load(path.join(root,manifest.js));
await entry.evaluate();
assert.equal(typeof entry.namespace[manifest.hooks.chatSurface],'function');
assert.ok(listeners.has('APP_READY'),'chat module subscribes to the host');
assert.ok(listeners.has('DOMContentLoaded'),'engine module schedules initialization');
entry.namespace[manifest.hooks.chatSurface]();
assert.equal(participants.length,1);
assert.equal(hooks.length,1);
assert.equal(extensionSettings.tavern_helper.render.enabled,false);
const stylesheet=await fs.readFile(path.join(root,manifest.css),'utf8');
for(const match of stylesheet.matchAll(/@import url\('([^']+)'\)/g))await fs.access(path.resolve(root,match[1]));
console.log(JSON.stringify({status:'passed',kind:'simulated_host_loader',modules:cache.size,chatSurfaceParticipants:participants.length,formatterHooks:hooks.length,engineBootstrapScheduled:true}));
