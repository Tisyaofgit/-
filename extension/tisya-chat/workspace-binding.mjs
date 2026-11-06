import {scopeOf} from './services.mjs';

// APP_READY can precede the host's initial chat load. The file integrity token
// belongs exclusively to the host. Viewing a chat must never enqueue a save.
// This extension-owned binding is persisted by the next native user save.
export function prepareWorkspaceBinding(ctx) {
  const metadata=ctx.chatMetadata;
  if(!ctx.chatId||typeof metadata?.integrity!=='string'||!metadata.integrity)return false;
  const old=metadata.tisya_chat;
  if(old?.integrity===metadata.integrity&&old?.key)return true;
  const key=scopeOf(ctx);
  const parent=old?.key??(metadata.main_chat?JSON.stringify([ctx.groupId?'group':'character',ctx.groupId??ctx.characters[ctx.characterId]?.avatar,metadata.main_chat]):null);
  metadata.tisya_chat={key,integrity:metadata.integrity,parent};
  return true;
}
