// rc.5 dsh-session-reference protocol: base64url(JSON.stringify(id)), not raw id.
export function sessionReference(id, title = id) {
  if (typeof id !== 'string' || !id.trim() || id.length > 256 || /[\u0000-\u001f\u007f]/u.test(id)) return undefined;
  const label = String(title || id).replace(/[\u0000-\u001f\u007f]/gu,' ').slice(0,256);
  const uri = `dsh-session:${Buffer.from(JSON.stringify(id),'utf8').toString('base64url')}`;
  return { id, title: label, uri, mention: `@[${label.replaceAll('\\','\\\\').replaceAll(']','\\]')}](${uri})` };
}

/** Only declared Session identity fields, never arbitrary id/title text in results. */
export function withSessionReferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const refs = new Map();
  const add = (id,title) => { const ref = sessionReference(id,title); if (ref && refs.size < 100 && !refs.has(id)) refs.set(id,ref); };
  const session = node => { if (node && typeof node === 'object') add(node.id,node.title); };
  const task = node => { if (node && typeof node === 'object') { add(node.ownerId); add(node.assigneeId); } };
  session(value.self); session(value.session);
  for (const node of Array.isArray(value.sessions)?value.sessions:[]) session(node);
  add(value.sessionId, value.title);
  add(value.senderId); add(value.targetId);
  add(value.delivery?.senderId); add(value.delivery?.targetId);
  task(value.task);
  for (const node of Array.isArray(value.tasks)?value.tasks:[]) task(node);
  return refs.size ? {...value,sessionRefs:[...refs.values()]} : value;
}
