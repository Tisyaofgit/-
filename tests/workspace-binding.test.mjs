import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareWorkspaceBinding} from '../extension/tisya-chat/workspace-binding.mjs';
import {scopeOf} from '../extension/tisya-chat/services.mjs';
const context=metadata=>({chatId:'existing',characters:[{avatar:'actor.png'}],characterId:0,chatMetadata:metadata,saveMetadata(){throw Error('Viewing a chat must not save it');}});
test('APP_READY before autoload never invents identity or saves the existing file',()=>{
  const ctx=context({});assert.equal(prepareWorkspaceBinding(ctx),false);assert.deepEqual(ctx.chatMetadata,{});
  ctx.chatMetadata={integrity:' original identity ',custom:{preserve:true}};
  assert.equal(prepareWorkspaceBinding(ctx),true);assert.equal(ctx.chatMetadata.integrity,' original identity ');
  assert.deepEqual(ctx.chatMetadata.custom,{preserve:true});
  assert.equal(prepareWorkspaceBinding(ctx),true);
});
test('rename keeps the workspace, branch receives a distinct owner without changing native integrity',()=>{
  const ctx=context({integrity:'parent'});prepareWorkspaceBinding(ctx);const parent=scopeOf(ctx);
  ctx.chatId='renamed';prepareWorkspaceBinding(ctx);assert.equal(scopeOf(ctx),parent);
  ctx.chatMetadata=structuredClone(ctx.chatMetadata);ctx.chatMetadata.integrity='branch';ctx.chatId='branch-file';
  prepareWorkspaceBinding(ctx);assert.notEqual(scopeOf(ctx),parent);assert.equal(ctx.chatMetadata.tisya_chat.parent,parent);assert.equal(ctx.chatMetadata.integrity,'branch');
});
