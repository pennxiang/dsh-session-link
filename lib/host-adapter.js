// DSH 0.2.1-rc.5 host boundary. No host imports: the entry injects createUserMessage.
import { resolve } from 'node:path';
const COMPAT_VERSION = '0.2.1-rc.5';
const MODES = new Set(['auto', 'followup', 'steer', 'inject']);

function failure(code, message) {
  return Object.assign(new Error(message), { code, definitelyNotDelivered: true });
}
function checkSignal(signal) {
  if (signal?.aborted) throw failure('ABORTED', 'The operation was cancelled before acceptance.');
}
function bound(value, fallback, maximum, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw failure('INVALID_ARGUMENT', `${name} must be a positive integer.`);
  return Math.min(value, maximum);
}
function short(value, maximum = 256) {
  return typeof value === 'string' ? value.slice(0, maximum) : undefined;
}
function service(ctx, key) {
  return typeof ctx.get === 'function' ? ctx.get(key) : ctx[key];
}
function visible(value) {
  return value && value.hidden !== true && value.private !== true &&
    value.visibility !== 'private' && value.visibility !== 'hidden' &&
    !['analysis', 'reasoning', 'system'].includes(value.channel);
}
function textPreview(content) {
  if (!Array.isArray(content)) return { text: '', truncated: false };
  // Bound work as well as output. Never stringify unknown provider blocks or
  // split a whole large payload just to decide whether its preview was clipped.
  let text = '';
  let truncated = content.length > 64;
  for (let i = 0; i < Math.min(content.length, 64); i++) {
    const block = content[i];
    if (block?.type !== 'text' || !visible(block) || typeof block.text !== 'string') continue;
    const room = Math.max(0, 4000 - text.length - (text ? 1 : 0));
    truncated ||= block.text.length > room;
    text += (text ? '\n' : '') + block.text.slice(0, room);
    if (text.length >= 4000) { truncated ||= i + 1 < content.length; break; }
  }
  const lines = text.split(/\r?\n/, 41);
  truncated ||= lines.length > 40 || lines.some(line => line.length > 500);
  return { text: lines.slice(0, 40).map(line => line.slice(0, 500)).join('\n'), truncated };
}

/**
 * All reads use metadata/projections or bounded SessionQuery windows.
 * No direct log access or agents.resume. Only initially live targets are accepted.
 * Managed children use the exported, rc.5-pinned host continuation adapters:
 * the Host owns closing/structured admission, and may resume a child that closes
 * during admission. This race is NOT a guarantee of live-only delivery.
 */
export function createHostAdapter(ctx, options = {}) {
  const agents = service(ctx, 'agents');
  if (typeof agents?.get !== 'function' || typeof agents?.list !== 'function') {
    throw failure('HOST_UNAVAILABLE', 'The live Agent registry is unavailable.');
  }
  const descriptors = new WeakMap();
  const receipts = new Map();
  const disposers = [];
  let closed = false;
  const receiptLimit = bound(options.receiptLimit, 1000, 5000, 'receiptLimit');

  function assertOpen(signal) {
    if (closed) throw failure('ADAPTER_CLOSED', 'The host adapter is closed.');
    checkSignal(signal);
  }
  function projection(session, key) {
    const projections = service(ctx, 'sessionProjections');
    if (!projections?.stateOf) return undefined;
    try { return projections.stateOf(session, key); } catch { return undefined; }
  }
  function archived(id) {
    const ids = service(ctx, 'workspaceRegistry')?.archivedSessionIds;
    return Array.isArray(ids) ? ids.includes(id) : false;
  }
  function recordReceipt(targetId, messageId, state) {
    const key = JSON.stringify([targetId, messageId]);
    receipts.delete(key);
    receipts.set(key, state);
    while (receipts.size > receiptLimit) receipts.delete(receipts.keys().next().value);
  }
  if (typeof ctx.on === 'function') {
    for (const [event, state] of [['claimed', 'claimed'], ['discarded', 'discarded']]) {
      const dispose = ctx.on(`agent/inbox/${event}`, info => {
        // Bounded identities only, never message content. The Host bridge mints
        // its id internally, so claim may precede its returned receipt Promise.
        if (typeof info?.agent?.id === 'string' && typeof info?.message?.id === 'string') {
          recordReceipt(info.agent.id, info.message.id, state);
        }
      });
      if (typeof dispose === 'function') disposers.push(dispose);
    }
  }

  function seededSidechatBoundary(agent, seq, boundary) {
    const header = agent.session?.header;
    // Better Sidebar stamps its own descriptor LAST in the creation seed and
    // includes that stamp in inheritedEventCount. Unlike managed subagents it
    // creates a runtime ROOT (no parentAgent). All conditions are required:
    // neither an ancestor descriptor nor a title prefix grants direct delivery.
    if (!Number.isSafeInteger(boundary) || boundary < 1 || seq !== boundary - 1 ||
        header?.origin !== 'subagent' || header.isSeeded !== true ||
        typeof header.parentSession !== 'string' || !header.parentSession ||
        typeof agents.roots !== 'function' || agents.get(agent.id) !== agent) return false;
    try { return agents.roots().includes(agent); } catch { return false; }
  }

  async function descriptor(agent, signal) {
    const session = agent.session;
    if (!session) return undefined;
    const identity = projection(session, 'subagent')?.identity;
    if (!identity || !Number.isSafeInteger(identity.seq) || identity.seq < 0 ||
        typeof session.isOwnSeq !== 'function') return undefined;
    const own = session.isOwnSeq(identity.seq);
    const seeded = !own && seededSidechatBoundary(agent, identity.seq, session.inheritedEventCount);
    if (!own && !seeded) return undefined;
    const cached = descriptors.get(session);
    if (cached?.seq === identity.seq) return cached.value;
    const query = service(ctx, 'sessionQuery');
    if (typeof query?.readEvent !== 'function') return undefined;
    const window = await query.readEvent({ sessionId: agent.id, seq: identity.seq, before: 0, after: 0 }, signal);
    checkSignal(signal);
    const event = window.target;
    if (event?.seq !== identity.seq || event.type !== 'subagent/descriptor' ||
        !Number.isSafeInteger(window.inheritedEventCount) ||
        event.data?.version !== 3 || typeof event.data.provider !== 'string' ||
        !['continuable', 'one-shot'].includes(event.data.mode)) return undefined;
    if (seeded) {
      if (window.inheritedEventCount !== session.inheritedEventCount ||
          !seededSidechatBoundary(agent, event.seq, window.inheritedEventCount) ||
          event.data.provider !== 'sidechat' || event.data.mode !== 'continuable') return undefined;
    } else if (event.seq < window.inheritedEventCount) return undefined;
    // Retain only classification/display metadata, not persona or tool restrictions.
    const value = { provider: short(event.data.provider), mode: event.data.mode, label: short(event.data.label),
      ...(seeded ? { seedDescriptorSeq: event.seq } : {}) };
    descriptors.set(session, { seq: identity.seq, value });
    return value;
  }

  function lifecycle(agent, info) {
    if (agents.get(agent.id) !== agent) return 'TARGET_NOT_LIVE';
    if (!['idle', 'running'].includes(agent.status)) return 'TARGET_LIFECYCLE_UNAVAILABLE';
    if (archived(agent.id)) return 'TARGET_ARCHIVED';
    if (info?.seedDescriptorSeq !== undefined &&
        !seededSidechatBoundary(agent, info.seedDescriptorSeq, agent.session.inheritedEventCount)) return 'TARGET_LIFECYCLE_UNAVAILABLE';
    const managed = agent.session?.header?.origin === 'subagent' && info?.provider !== 'sidechat';
    if (info?.mode === 'one-shot') return 'TARGET_NOT_CONTINUABLE';
    if (!managed) return undefined;
    if (info?.mode !== 'continuable') return 'TARGET_NOT_CONTINUABLE';
    if (options.subagentVersion !== COMPAT_VERSION || !service(ctx, 'subagents') ||
        typeof options.queueHostSubagentPrompt !== 'function' ||
        typeof options.steerHostSubagentPrompt !== 'function') return 'TARGET_LIFECYCLE_UNAVAILABLE';
    const parent = agents.get(agent.session.header.parentSession);
    if (!parent) return 'TARGET_PARENT_NOT_LIVE';
    if (archived(parent.id)) return 'TARGET_ARCHIVED';
    // Public Agent.status cannot expose closing/structured finalization.
    // canReceive means the Host admission path exists, NOT that it will accept.
    // The native bridge rechecks exact parent ownership and all lifecycle gates.
    return undefined;
  }

  function summary(agent, info) {
    const header = agent.session?.header ?? {};
    const reason = lifecycle(agent, info);
    let cwd = header.cwd;
    const directory = service(ctx, 'workingDirectory');
    if (typeof directory?.get === 'function') cwd = directory.get(agent.session);
    return {
      id: agent.id,
      title: short(projection(agent.session, 'title')) ?? info?.label ?? agent.id,
      kind: info?.provider === 'sidechat' ? 'sidechat' : header.origin === 'subagent' ? 'subagent' : 'session',
      ...(typeof header.parentSession === 'string' ? { parentId: header.parentSession } : {}),
      ...(typeof cwd === 'string' ? { cwd: short(cwd, 4096) } : {}),
      status: agents.get(agent.id) !== agent ? 'inactive' : ['idle', 'running'].includes(agent.status) ? agent.status : 'unknown',
      live: agents.get(agent.id) === agent,
      archived: archived(agent.id),
      canReceive: !reason,
      ...(reason ? { reason } : {}),
    };
  }

  async function liveDetails(id, signal) {
    assertOpen(signal);
    const agent = agents.get(id);
    if (!agent) throw failure('TARGET_NOT_LIVE', `Session ${id} has no live Agent; cold resume is disabled.`);
    const info = await descriptor(agent, signal);
    assertOpen(signal);
    if (agents.get(id) !== agent) throw failure('TARGET_NOT_LIVE', `Session ${id} is no longer the same live Agent.`);
    return { agent, info, session: summary(agent, info) };
  }

  return {
    async list({ limit, query, excludeIds = [], cwd, includeCold = false, signal } = {}) {
      assertOpen(signal);
      const cap = bound(limit, 100, 100, 'limit');
      if (query !== undefined && typeof query !== 'string') throw failure('INVALID_ARGUMENT', 'query must be text.');
      if (!Array.isArray(excludeIds) || excludeIds.length > 1000 || excludeIds.some(id => typeof id !== 'string')) throw failure('INVALID_ARGUMENT', 'excludeIds must be a bounded list of session ids.');
      if (cwd !== undefined && (typeof cwd !== 'string' || !cwd)) throw failure('INVALID_ARGUMENT', 'cwd must be nonempty text.');
      const excluded = new Set(excludeIds);
      const directory = cwd === undefined ? undefined : resolve(cwd);
      const needle = (query ?? '').slice(0, 256).toLowerCase();
      const result = [];
      const live = agents.list();
      // Do not do per-session observations over the entire host corpus.
      const scan = live.slice(0, 500);
      let truncated = live.length > scan.length;
      for (const agent of scan) {
        assertOpen(signal);
        if (excluded.has(agent.id)) continue;
        const info = await descriptor(agent, signal);
        const item = summary(agent, info);
        // Count only accessible peers, not the caller or a different directory.
        if (!item.live || (directory !== undefined && (typeof item.cwd !== 'string' || resolve(item.cwd) !== directory)) || (needle && !`${item.id} ${item.title} ${item.cwd ?? ''}`.toLowerCase().includes(needle))) continue;
        if (result.length === cap) { truncated = true; break; }
        result.push(item);
      }
      // Cold corpus enumeration is opt-in, metadata only, and cannot make an Agent.
      if (includeCold && result.length < cap) {
        const queryService = service(ctx, 'sessionQuery');
        if (typeof queryService?.listSessions === 'function') {
          const records = await queryService.listSessions(signal);
          assertOpen(signal);
          for (const record of records.slice(0, 500)) {
            const header = record.header;
            if (!header || agents.get(header.id) || excluded.has(header.id)) continue;
            // Cold header cwd is only initial metadata, not the effective cwd.
            if (directory !== undefined) continue;
            const item = { id: header.id, title: header.id, kind: header.origin === 'subagent' ? 'subagent' : 'session',
              ...(header.parentSession ? { parentId: header.parentSession } : {}),
              ...(header.cwd ? { cwd: short(header.cwd, 4096) } : {}),
              status: 'persisted', live: false, archived: archived(header.id), canReceive: false, reason: 'TARGET_NOT_LIVE' };
            if (needle && !`${item.id} ${item.cwd ?? ''}`.toLowerCase().includes(needle)) continue;
            if (result.length === cap) { truncated = true; break; }
            result.push(item);
          }
          truncated ||= records.length > 500;
        }
      }
      return { sessions: result, truncated };
    },

    async describe(id, { signal } = {}) {
      assertOpen(signal);
      if (agents.get(id)) return (await liveDetails(id, signal)).session;
      // Historical task/receipt reads must survive a peer's exit. Directory
      // metadata is not an Agent and cannot grant a delivery capability.
      const query = service(ctx, 'sessionQuery');
      if (typeof query?.listSessions !== 'function') throw failure('SESSION_NOT_FOUND', `Session ${id} is not available.`);
      const records = await query.listSessions(signal);
      assertOpen(signal);
      if (agents.get(id)) return (await liveDetails(id, signal)).session;
      const record = records.find(item => item.header?.id === id);
      if (!record) throw failure('SESSION_NOT_FOUND', `Session ${id} was not found.`);
      const header = record.header;
      return { id: header.id, title: header.id,
        kind: header.origin === 'subagent' ? 'subagent' : 'session',
        ...(typeof header.parentSession === 'string' ? { parentId: header.parentSession } : {}),
        ...(typeof header.cwd === 'string' ? { cwd: short(header.cwd, 4096) } : {}),
        status: 'persisted', live: false, archived: archived(id), canReceive: false, reason: 'TARGET_NOT_LIVE' };
    },

    async deliver({ senderId, senderAgent, targetId, text, mode = 'auto', signal }) {
      assertOpen(signal);
      if (!MODES.has(mode)) throw failure('INVALID_MODE', 'mode must be auto, followup, steer, or inject.');
      if (typeof text !== 'string' || text.length === 0 || text.length > 65536) throw failure('INVALID_ARGUMENT', 'Message text must contain 1–65536 characters.');
      if (senderId === targetId) throw failure('SELF_SEND', 'Sending to the same Agent is not supported.');
      const sender = agents.get(senderId);
      if (!sender || (senderAgent !== undefined && senderAgent !== sender)) {
        throw failure('SENDER_NOT_LIVE', 'The actual sender must be the exact live Agent instance.');
      }
      const { agent: target, info } = await liveDetails(targetId, signal);
      assertOpen(signal);
      if (agents.get(senderId) !== sender) throw failure('SENDER_NOT_LIVE', 'The sender left the live registry.');
      const reason = lifecycle(target, info);
      if (reason) throw failure(reason, `Target ${targetId} cannot safely accept a message (${reason}).`);
      const selected = mode === 'auto' ? target.status === 'running' ? 'steer' : 'followup' : mode;
      const targetStatus = target.status;
      const content = [{ type: 'text', text }];
      const source = { kind: 'agent-message', form: 'relay', senderSessionId: sender.id };
      if (target.session.header.origin === 'subagent' && info?.provider !== 'sidechat') {
        if (selected === 'inject') throw failure('MODE_UNSUPPORTED', 'Managed subagents require waking queue or steer admission; inject is unsupported.');
        const parent = agents.get(target.session.header.parentSession);
        const bridge = selected === 'steer' ? options.steerHostSubagentPrompt : options.queueHostSubagentPrompt;
        // Parent is the actual lifecycle owner, never the claimed message author.
        // Host admission enforces closure, structured finalization and ownership.
        // It may legally continue a child that closes during this asynchronous call.
        const messageId = await bridge(service(ctx, 'subagents'), parent, targetId, content, source, signal ?? new AbortController().signal);
        if (typeof messageId !== 'string' || !messageId) throw Object.assign(failure('HOST_CONTRACT_ERROR', 'Host admission returned no message id.'), { definitelyNotDelivered: false });
        const key = JSON.stringify([targetId, messageId]);
        if (!closed && !receipts.has(key)) recordReceipt(targetId, messageId, 'pending');
        return { messageId, mode: selected, targetStatus };
      }
      if (selected === 'inject' && target.status !== 'running') throw failure('TARGET_NOT_RUNNING', 'inject is only supported for a running target; use followup to wake an idle Agent.');
      if (typeof options.createUserMessage !== 'function') throw failure('HOST_UNAVAILABLE', 'A createUserMessage factory must be injected.');
      const message = options.createUserMessage({ content, source });
      if (!message || typeof message.id !== 'string' || !message.id) throw failure('HOST_CONTRACT_ERROR', 'The host message factory returned no message id.');
      // Recheck after the injected factory: production factories are synchronous,
      // but neither tests nor future implementations should open a disposal gap.
      assertOpen(signal);
      if (agents.get(senderId) !== sender) throw failure('SENDER_NOT_LIVE', 'The sender left the live registry.');
      const finalReason = lifecycle(target, info);
      if (finalReason) throw failure(finalReason, `Target ${targetId} no longer accepts messages.`);
      if (selected === 'inject' && target.status !== 'running') throw failure('TARGET_NOT_RUNNING', 'The target is no longer running.');
      if (typeof target[selected] !== 'function') throw failure('HOST_CONTRACT_ERROR', `The target does not support ${selected}.`);
      recordReceipt(targetId, message.id, 'pending');
      // Critical admission region: no await between lifecycle guard and native send.
      // A throwing native call is uncertain; the service must not automatically retry.
      try { target[selected](message); } catch (error) {
        if (receipts.get(JSON.stringify([targetId, message.id])) === 'pending') recordReceipt(targetId, message.id, 'unknown');
        throw error;
      }
      return { messageId: message.id, mode: selected, targetStatus };
    },

    async activity(id, { limit, maxChars, signal } = {}) {
      const cap = bound(limit, 20, 50, 'limit');
      const charCap = bound(maxChars, 12000, 20000, 'maxChars');
      const { agent, session } = await liveDetails(id, signal);
      const query = service(ctx, 'sessionQuery');
      if (typeof query?.readEvent !== 'function') throw failure('ACTIVITY_UNAVAILABLE', 'The bounded SessionQuery reader is unavailable.');
      const lastSeq = agent.session.seq - 1;
      if (lastSeq < 0) return { session, events: [], truncated: false };
      // At most 51 recent raw events are examined. SessionQuery may internally
      // materialize its log; this adapter never exposes that log or walks it all.
      const window = await query.readEvent({ sessionId: id, seq: lastSeq, before: Math.min(lastSeq, 50), after: 0 }, signal);
      assertOpen(signal);
      if (agents.get(id) !== agent) throw failure('TARGET_NOT_LIVE', 'The target changed during the activity read.');
      if (!Number.isSafeInteger(window.inheritedEventCount)) throw failure('HOST_CONTRACT_ERROR', 'The event window has no trustworthy inherited boundary.');
      const calls = new Map();
      const output = [];
      let truncated = window.startSeq > window.inheritedEventCount;
      for (const event of window.events) {
        if (!Number.isSafeInteger(event.seq) || event.seq < window.inheritedEventCount || !visible(event)) continue;
        const data = event.data;
        if (!visible(data)) continue;
        const base = { seq: event.seq, ...(Number.isFinite(event.time) ? { timestamp: event.time } : {}) };
        if (event.type === 'assistant/message' && visible(data.message)) {
          const preview = textPreview(data.message.content);
          truncated ||= preview.truncated;
          if (preview.text) output.push({ ...base, type: 'assistant', text: preview.text });
        } else if (event.type === 'tool/call' && typeof data.callId === 'string' && typeof data.name === 'string') {
          const item = { ...base, type: 'tool', toolName: short(data.name, 120), status: 'started' };
          calls.set(data.callId, item);
          output.push(item);
        } else if (event.type === 'tool/result' && visible(data.message)) {
          const call = calls.get(data.message.toolCallId);
          const item = { ...base, type: 'tool', toolName: call?.toolName ?? '(tool)', status: data.message.isError === true ? 'error' : 'completed' };
          if (call && Number.isFinite(event.time) && Number.isFinite(call.timestamp) && event.time >= call.timestamp) item.elapsedMs = event.time - call.timestamp;
          output.push(item);
        }
      }
      let selected = output.slice(-cap);
      truncated ||= output.length > selected.length;
      // Bound the serialized event list, not only the assistant prose.
      while (selected.length && JSON.stringify(selected).length > charCap) {
        if (selected.length === 1 && selected[0].type === 'assistant') {
          const item = selected[0];
          const room = Math.max(0, charCap - JSON.stringify([{ ...item, text: '' }]).length);
          item.text = item.text.slice(0, room);
          while (item.text && JSON.stringify(selected).length > charCap) item.text = item.text.slice(0, -1);
          if (!item.text || JSON.stringify(selected).length > charCap) selected = [];
          truncated = true;
          break;
        }
        selected.shift();
        truncated = true;
      }
      return { session, events: selected, truncated };
    },

    async receipt(targetId, messageId, { signal } = {}) {
      assertOpen(signal);
      const key = JSON.stringify([targetId, messageId]);
      const observed = receipts.get(key);
      if (observed === 'claimed' || observed === 'discarded') return { state: observed };
      const agent = agents.get(targetId);
      const inbox = agent?.inbox;
      if ([...(inbox?.nextTurn ?? []), ...(inbox?.nextStep ?? [])].some(message => message.id === messageId)) return { state: 'pending' };
      // Absence is not evidence of claim: it may have been discarded, evicted,
      // or accepted before this adapter was installed. Never infer completion.
      return { state: 'unknown' };
    },

    close() {
      if (closed) return;
      closed = true;
      for (const dispose of disposers.splice(0)) dispose();
      receipts.clear();
    },
  };
}
