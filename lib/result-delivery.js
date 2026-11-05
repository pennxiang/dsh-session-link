import { createHash } from 'node:crypto';
import { createReadScope } from './async-control.js';

export const RESULT_SOURCE_KIND = 'dsh-session-link-result';
const kinds = new Set(['task-result', 'outgoing-message']);
const service = (ctx, key) => typeof ctx?.get === 'function' ? ctx.get(key) : ctx?.[key];
const fail = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function text(value, name, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw fail('LOCAL_RESULT_INVALID_ARGUMENT', `${name} must be nonempty text of at most ${maximum} characters.`);
  return value;
}
function checkAbort(signal) {
  if (signal?.aborted) throw fail('ABORTED', 'Local result recording was cancelled. An already appended record is never retracted or automatically duplicated.');
}
function related(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('LOCAL_RESULT_INVALID_ARGUMENT', 'relatedIds must be an object.');
  const result = {};
  for (const key of Object.keys(value)) if (!['taskId', 'revision', 'deliveryId', 'ownerId', 'targetId'].includes(key)) throw fail('LOCAL_RESULT_INVALID_ARGUMENT', 'Unsupported relatedIds field.');
  for (const key of ['taskId', 'revision', 'deliveryId', 'ownerId', 'targetId']) {
    if (!own(value, key) || value[key] === undefined) continue;
    if (key === 'revision') {
      if (!Number.isSafeInteger(value[key]) || value[key] < 1) throw fail('LOCAL_RESULT_INVALID_ARGUMENT', 'revision must be a positive safe integer.');
      result[key] = value[key];
    } else result[key] = text(value[key], key, 256);
  }
  return result;
}
function records(state) {
  if (state.resultRecords === undefined) return [];
  if (!Array.isArray(state.resultRecords)) throw fail('LOCAL_RESULT_INVALID_STATE', 'The local result ledger is malformed.');
  return state.resultRecords;
}
const sameKey = (entry, sessionId, recordId) => entry.sessionId === sessionId && entry.recordId === recordId;
function details(entry) {
  return {
    recordId: entry.recordId, sessionId: entry.sessionId, messageId: entry.messageId,
    ...(Number.isSafeInteger(entry.eventSeq) ? { eventSeq: entry.eventSeq } : {}), localState: entry.state,
  };
}
function output(entry, replayed) {
  return { ...details(entry), persisted: true, replayed, surface: 'plugin-notice', sourceKind: RESULT_SOURCE_KIND };
}

/**
 * Persist one producer-owned user-role notice in the EXECUTING session itself.
 * This is NOT a human prompt, model response, task-completion proof or inbox send.
 * A dedicated client Conversation definition must render this source: rc.5's
 * default chat hides non-human context notices. The message still enters the
 * native surface for subsequent questions, without starting a model turn.
 *
 * Public Host contracts only: Session.append(user/message, ..., surfaceOp),
 * sessions.flush(session), and bounded SessionQuery.readEvent for exact recovery.
 * close drains this component; it never owns/closes the shared store or sessions.
 */
export function createResultDelivery({ ctx, store, createUserMessage, now = Date.now, config = {} } = {}) {
  const maxChars = config.maxResultChars ?? 16000;
  const capacity = config.maxResultRecords ?? 2000;
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 64000 || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10000) throw fail('LOCAL_RESULT_INVALID_CONFIG', 'Invalid local result limits.');
  const reads = createReadScope({ timeoutMs: config.metadataTimeoutMs ?? 15000 });
  let tail = Promise.resolve();
  let closing = false;
  let closePromise;

  function caller(agent) {
    const agents = service(ctx, 'agents');
    if (!agent || typeof agent.id !== 'string' || typeof agents?.get !== 'function' || agents.get(agent.id) !== agent || !agent.session || agent.session.header?.id !== agent.id || !['idle', 'running'].includes(agent.status)) throw fail('SENDER_NOT_LIVE', 'Only the exact live executing Agent may write its own local result.');
    if (service(ctx, 'workspaceRegistry')?.archivedSessionIds?.includes(agent.id)) throw fail('SENDER_ARCHIVED', 'An archived Agent cannot append a local result.');
    return agent.session;
  }
  function capabilities(session) {
    const sessions = service(ctx, 'sessions');
    const query = service(ctx, 'sessionQuery');
    if (typeof session.append !== 'function' || typeof sessions?.flush !== 'function' || typeof query?.readEvent !== 'function' || typeof createUserMessage !== 'function') throw fail('LOCAL_RESULT_UNAVAILABLE', 'Native surface append, durability checkpoint, bounded event query and message factory are required.');
    if (typeof store?.read !== 'function' || typeof store?.mutate !== 'function') throw fail('LOCAL_RESULT_UNAVAILABLE', 'A durable idempotency ledger is required.');
    return { sessions, query };
  }
  async function patch(entry, changes) {
    return store.mutate(state => {
      const current = records(state).find(item => sameKey(item, entry.sessionId, entry.recordId));
      if (!current || current.fingerprint !== entry.fingerprint || current.messageId !== entry.messageId) throw fail('LOCAL_RESULT_INVALID_STATE', 'Local result intent changed or disappeared.');
      Object.assign(current, changes, { updatedAt: now() });
      return current;
    });
  }
  function matches(event, entry, expectedText, inherited = 0) {
    const message = event?.data;
    return Number.isSafeInteger(event?.seq) && event.seq >= inherited && event.type === 'user/message' && event.surfaceOp === 'append'
      && message?.id === entry.messageId && message.role === 'user'
      && message.source?.kind === RESULT_SOURCE_KIND && message.source.form === 'notice' && message.source.version === 1
      && message.source.sessionId === entry.sessionId && message.source.recordId === entry.recordId
      && message.source.fingerprint === entry.fingerprint && message.source.recordKind === entry.kind
      && message.source.title === entry.title && JSON.stringify(message.source.relatedIds) === JSON.stringify(entry.relatedIds)
      && Array.isArray(message.content) && message.content.length === 1 && message.content[0]?.type === 'text' && message.content[0].text === expectedText;
  }
  async function durable(entry, agent, host, replayed) {
    // An append is already committed. Finish its durability checkpoint even if
    // cancellation arrived afterward; caller cancellation still prevents success.
    try {
      if (await host.sessions.flush(agent.session) !== true) throw fail('LOCAL_RESULT_DURABILITY_UNAVAILABLE', 'No persistence participant confirmed the local result.');
    } catch (cause) {
      throw fail(cause?.code === 'LOCAL_RESULT_DURABILITY_UNAVAILABLE' ? cause.code : 'LOCAL_RESULT_FLUSH_FAILED', 'Local result exists but its durability checkpoint did not succeed; retry this exact record to verify and flush it, never append a replacement.', details(entry));
    }
    let saved;
    try { saved = await patch(entry, { state: 'persisted' }); }
    catch { throw fail('LOCAL_RESULT_PERSISTENCE_UNCERTAIN', 'The native result was flushed, but its ledger outcome could not be saved. Inspect/retry the same record identity; never duplicate it.', details(entry)); }
    return output(saved, replayed);
  }
  async function replay(entry, args, host, body) {
    if (entry.state === 'persisted') return output(entry, true);
    if (!Number.isSafeInteger(entry.eventSeq)) throw fail('LOCAL_RESULT_UNCERTAIN', 'An earlier append may have occurred without its sequence being saved. Inspect the local transcript; this record will not be automatically appended again.', details(entry));
    caller(args.agent);
    checkAbort(args.signal);
    let window;
    try { window = await reads.run(signal => host.query.readEvent({ sessionId: entry.sessionId, seq: entry.eventSeq, before: 0, after: 0 }, signal), { signal: args.signal }); }
    catch (cause) {
      checkAbort(args.signal);
      throw fail('LOCAL_RESULT_UNCERTAIN', 'The recorded local event could not be verified; no replacement was appended.', details(entry));
    }
    caller(args.agent);
    checkAbort(args.signal);
    if (!Number.isSafeInteger(window?.inheritedEventCount) || window.inheritedEventCount < 0 || window.target?.seq !== entry.eventSeq || !matches(window.target, entry, body, window.inheritedEventCount)) throw fail('LOCAL_RESULT_IDENTITY_MISMATCH', 'The stored event does not match this executing session, producer, message and exact result. No replacement was appended.', details(entry));
    return durable(entry, args.agent, host, true);
  }
  async function record(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('LOCAL_RESULT_INVALID_ARGUMENT', 'Local result arguments must be an object.');
    checkAbort(args.signal);
    const session = caller(args.agent);
    const host = capabilities(session);
    const sessionId = args.agent.id;
    const recordId = text(args.recordId, 'recordId', 256);
    const title = text(args.title, 'title', 200);
    const bodyText = text(args.text, 'text', maxChars);
    if (!kinds.has(args.kind)) throw fail('LOCAL_RESULT_INVALID_ARGUMENT', 'kind must be task-result or outgoing-message.');
    const relatedIds = related(args.relatedIds);
    const attribution = args.kind === 'task-result'
      ? 'Session Link 插件记录的任务结果／执行者回报（未独立验证；任务状态以账本为准）。'
      : 'Session Link 插件记录的发送内容（不是送达、阅读或完成证明）。';
    const body = `${attribution}\n\n${bodyText}`;
    const fingerprint = createHash('sha256').update(JSON.stringify({ sessionId, recordId, kind: args.kind, title, text: bodyText, relatedIds })).digest('hex');
    const previous = records(await store.read()).find(item => sameKey(item, sessionId, recordId));
    if (previous && previous.fingerprint !== fingerprint) throw fail('LOCAL_RESULT_CONFLICT', 'This recordId already identifies different local result content.', details(previous));
    if (previous && previous.state !== 'not-written') {
      const value = await replay(previous, args, host, body);
      caller(args.agent); checkAbort(args.signal);
      return value;
    }
    const source = { kind: RESULT_SOURCE_KIND, form: 'notice', summary: title.replace(/[\r\n\t]/g, ' ').slice(0, 120), version: 1, recordId, recordKind: args.kind, sessionId, fingerprint, title, relatedIds };
    const message = createUserMessage({ source, content: [{ type: 'text', text: body }] });
    if (!message || typeof message.id !== 'string' || !message.id || message.id.length > 256) throw fail('LOCAL_RESULT_MESSAGE_INVALID', 'The native message factory returned no valid identity.');
    let entry = { sessionId, recordId, fingerprint, kind: args.kind, title, relatedIds, messageId: message.id, state: 'reserved', createdAt: previous?.createdAt ?? now(), updatedAt: now() };
    // Validate the complete producer-owned message before reserving an intent.
    if (!matches({ type: 'user/message', seq: 0, surfaceOp: 'append', data: message }, entry, body)) throw fail('LOCAL_RESULT_MESSAGE_INVALID', 'The native message factory changed the producer-owned result content or source.');
    const reservation = await store.mutate(state => {
      checkAbort(args.signal); caller(args.agent);
      state.resultRecords ??= [];
      const all = records(state);
      const current = all.find(item => sameKey(item, sessionId, recordId));
      if (current) {
        if (current.fingerprint !== fingerprint) throw fail('LOCAL_RESULT_CONFLICT', 'recordId already identifies different local result content.', details(current));
        if (current.state !== 'not-written') return { inserted: false, entry: current };
        Object.assign(current, entry);
        return { inserted: true, entry: current };
      }
      if (all.length >= capacity) throw fail('LOCAL_RESULT_CAPACITY', 'Local result identities are full; uncertain records are never evicted or duplicated.');
      all.push(entry);
      return { inserted: true, entry };
    });
    if (!reservation.inserted) {
      const value = await replay(reservation.entry, args, host, body);
      caller(args.agent); checkAbort(args.signal);
      return value;
    }
    entry = reservation.entry;
    // Failure before entering append is authoritatively not-written and may be
    // retried with the same logical key. Any append uncertainty is fail-closed.
    try { checkAbort(args.signal); caller(args.agent); }
    catch (cause) {
      try { entry = await patch(entry, { state: 'not-written' }); } catch { /* reserved remains fail-closed */ }
      throw Object.assign(cause, details(entry));
    }
    const anticipatedSeq = session.seq;
    let event;
    try {
      event = session.append('user/message', message, { surfaceOp: 'append' });
      if (!matches(event, entry, body) || event.seq !== anticipatedSeq) throw fail('LOCAL_RESULT_APPEND_INVALID', 'Native append returned a different result identity or sequence.');
    } catch {
      const changes = { state: 'unknown', ...(Number.isSafeInteger(anticipatedSeq) && anticipatedSeq >= 0 ? { eventSeq: anticipatedSeq } : {}) };
      try { entry = await patch(entry, changes); } catch { entry = { ...entry, ...changes }; }
      throw fail('LOCAL_RESULT_UNCERTAIN', 'Local append did not return reliable confirmation. Verify the recorded event; never automatically append a second copy.', details(entry));
    }
    try { entry = await patch(entry, { state: 'appended', eventSeq: event.seq }); }
    catch {
      throw fail('LOCAL_RESULT_PERSISTENCE_UNCERTAIN', 'Local result was appended but its sequence could not be saved. Inspect this event identity instead of appending a duplicate.', { ...details(entry), eventSeq: event.seq, localState: 'unknown' });
    }
    const value = await durable(entry, args.agent, host, false);
    try { caller(args.agent); checkAbort(args.signal); }
    catch (cause) { throw Object.assign(cause, { ...value, localState: 'persisted' }); }
    return value;
  }
  return {
    record(args) {
      if (closing) return Promise.reject(fail('LOCAL_RESULT_CLOSED', 'Local result delivery is closed.'));
      const operation = tail.then(() => record(args));
      tail = operation.catch(() => {});
      return operation;
    },
    close() {
      if (!closePromise) {
        closing = true;
        const stopReads = reads.close();
        closePromise = Promise.all([tail, stopReads]).then(() => undefined);
      }
      return closePromise;
    },
  };
}
