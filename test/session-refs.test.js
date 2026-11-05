import test from 'node:test';import assert from 'node:assert/strict';
import {sessionReference,withSessionReferences} from '../lib/session-refs.js';
test('Session reference URI encodes a JSON string, not an unquoted id',()=>{
  for(const id of ['session-a','session-中文','quoted-"-id']) {
    const ref=sessionReference(id,'Visible ] title');
    assert.equal(JSON.parse(Buffer.from(ref.uri.slice('dsh-session:'.length),'base64url').toString('utf8')),id);
    assert.ok(ref.mention.includes('Visible \\] title'));
  }
  assert.equal(sessionReference('bad\nid'),undefined);
});
test('declared Session fields produce bounded deduplicated refs without treating task id as session',()=>{
  const input={task:{id:'task-not-session',ownerId:'owner',assigneeId:'worker'},delivery:{senderId:'owner',targetId:'worker'},sessionId:'created',title:'Created'};
  const output=withSessionReferences(input);
  assert.deepEqual(output.sessionRefs.map(r=>r.id),['created','owner','worker']);
  assert.equal(input.sessionRefs,undefined);
  assert.equal(output.sessionRefs[0].title,'Created');
  assert.equal(withSessionReferences({arbitrary:{id:'not-session'}}).sessionRefs,undefined);
});
