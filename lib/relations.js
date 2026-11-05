import { isAbsolute, resolve as resolvePath } from 'node:path';
import { createReadScope } from './async-control.js';

const fail = (code, message) => Object.assign(new Error(message), { code });
const terminalReadErrors = new Set(['ABORTED', 'READ_SCOPE_CLOSED', 'METADATA_TIMEOUT']);
const taskStatuses = new Set(['offered', 'accepted', 'working', 'blocked', 'completed', 'failed', 'cancelled']);
const kinds = new Set(['session', 'sidechat', 'subagent']);
const missingCodes = new Set(['SESSION_NOT_FOUND', 'TARGET_NOT_FOUND', 'TARGET_NOT_LIVE', 'NOT_FOUND']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const short = (value, cap) => typeof value === 'string' ? value.slice(0, cap) : undefined;
// Frozen public dsh-session-reference rc.5 codec: payload encodes the JSON string,
// not the raw id. Keep this tiny host-neutral protocol usable in dependency-free tests.
const reference = (id, title) => `@[${title.replaceAll('\\', '\\\\').replaceAll(']', '\\]')}](dsh-session:${Buffer.from(JSON.stringify(id), 'utf8').toString('base64url')})`;
function identity(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) throw fail('INVALID_ARGUMENT', 'Session identity must be nonempty text of at most 256 characters without control characters.');
  return value;
}
function abort(signal) { if (signal.aborted) throw fail('ABORTED', 'The metadata request was cancelled.'); }

/** Metadata-only creation ancestry. Edges are plugin-owned provenance, never
 * native Agent ownership or an instruction to resume a Session. The caller of
 * this service must authorize the viewer before invoking it (the HTTP mount is
 * owner-only). No transcript, model, inbox, activation or mutation APIs are used.
 */
export function createRelations({ host, store, workspaces, config = {} } = {}) {
  if (typeof host?.describe !== 'function' || typeof store?.read !== 'function') throw fail('RELATIONS_UNAVAILABLE', 'Host metadata and the creation ledger are required.');
  const maxNodes = config.maxRelationNodes ?? 200;
  const sameDirectoryOnly = config.sameDirectoryOnly ?? false;
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > 200 || typeof sameDirectoryOnly !== 'boolean') throw fail('INVALID_CONFIG', 'Relation node limit must be 1–200 and sameDirectoryOnly must be boolean.');
  const scope = createReadScope({ timeoutMs: config.relationTimeoutMs ?? config.metadataTimeoutMs ?? 15000 });

  function directoryAllowed(self, peer) {
    // A cold header is not a live effective working directory. Do not turn stale
    // historical cwd into permission to cross the configured directory fence.
    return !sameDirectoryOnly || (self.live === true && peer.live === true &&
      typeof self.cwd === 'string' && typeof peer.cwd === 'string' &&
      resolvePath(self.cwd) === resolvePath(peer.cwd));
  }
  async function describe(id, signal) {
    abort(signal);
    const result = await host.describe(id, { signal });
    abort(signal);
    if (!result || result.id !== id) throw fail('IDENTITY_MISMATCH', 'Host metadata did not match the requested Session.');
    return result;
  }
  function node(metadata, state, summaries) {
    const archived = metadata.archived === true;
    const live = metadata.live === true;
    const status = ['running', 'idle', 'inactive', 'persisted', 'unknown'].includes(metadata.status) ? metadata.status : 'unknown';
    const displayState = archived ? 'archived' : live && status === 'running' ? 'running' : live && status === 'idle' ? 'idle' : 'offline';
    const paused = plain(state.reception) && own(state.reception, metadata.id) && state.reception[metadata.id]?.enabled === false;
    const task = summaries.get(metadata.id);
    const title = (short(metadata.title, 256) || metadata.id).replace(/[\u0000-\u001f\u007f]/gu, ' ');
    return { id: metadata.id, title, sessionRef: reference(metadata.id, title),
      kind: kinds.has(metadata.kind) ? metadata.kind : 'session', status, state: displayState,
      live, archived, canReceive: metadata.canReceive === true && live && !archived && !paused,
      canOpen: !archived,
      ...(task ? { taskStatus: task.status, hasResult: task.hasResult } : {}) };
  }
  async function build(sessionId, signal) {
    const selfMetadata = await describe(sessionId, signal);
    const snapshot = await store.read();
    abort(signal);
    if (!plain(snapshot)) throw fail('INVALID_STATE', 'The relationship ledger is unavailable.');
    const creations = Array.isArray(snapshot.creations) ? snapshot.creations : [];
    const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
    let truncated = creations.length > 1000 || tasks.length > 2000;
    const incoming = new Map();
    const outgoing = new Map();
    // A new ordinary Session has one creation source. Keep the first retained
    // creation record for that exact identity; duplicates cannot fabricate a DAG.
    for (const entry of creations.slice(0, 1000)) {
      if (!plain(entry) || !['ready', 'partial', 'unknown'].includes(entry.state)) continue;
      let sourceId, targetId;
      try { sourceId = identity(entry.senderId); targetId = identity(entry.sessionId); } catch { continue; }
      if (sourceId === targetId || incoming.has(targetId)) continue;
      const edge = { sourceId, targetId, kind: 'created-session',
        ...(Number.isFinite(entry.createdAt) && entry.createdAt >= 0 ? { createdAt: entry.createdAt } : {}),
        ...(short(entry.handoff?.task, 200) ? { task: short(entry.handoff.task, 200) } : {}),
        ...(short(entry.handoff?.context, 240) ? { contextPreview: short(entry.handoff.context, 240) } : {}) };
      incoming.set(targetId, edge);
      const next = outgoing.get(sourceId) ?? [];
      next.push(edge); outgoing.set(sourceId, next);
    }
    // Summary-only task state. Never return instructions, result body, tool
    // outputs or another branch's task information.
    const summaries = new Map();
    for (const task of tasks.slice(0, 2000)) {
      if (!plain(task) || !taskStatuses.has(task.status)) continue;
      const relation = incoming.get(task.assigneeId);
      if (!relation || relation.sourceId !== task.ownerId) continue;
      const time = Number.isFinite(task.updatedAt) ? task.updatedAt : Number.isFinite(task.createdAt) ? task.createdAt : 0;
      if ((summaries.get(task.assigneeId)?.time ?? -Infinity) > time) continue;
      summaries.set(task.assigneeId, { status: task.status, hasResult: typeof task.result === 'string' && task.result.trim().length > 0, time });
    }
    const self = node(selfMetadata, snapshot, summaries);
    const nodes = new Map([[sessionId, self]]);
    const edges = [];
    const rejected = new Map();
    const metadata = new Map([[sessionId, selfMetadata]]);
    const visited = new Set();
    const queue = [{ id: sessionId, direction: 'up' }, { id: sessionId, direction: 'down' }];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      abort(signal);
      const current = queue[cursor];
      const visit = JSON.stringify([current.id, current.direction]);
      if (visited.has(visit)) continue;
      visited.add(visit);
      const candidates = current.direction === 'up' ? [incoming.get(current.id)].filter(Boolean) : outgoing.get(current.id) ?? [];
      for (const edge of candidates) {
        const id = current.direction === 'up' ? edge.sourceId : edge.targetId;
        if (rejected.has(id)) continue;
        if (nodes.has(id)) continue; // includes cycles, self-edge revisits and duplicate ancestry
        if (nodes.size === maxNodes) { truncated = true; continue; }
        let peer;
        try { peer = metadata.get(id) ?? await describe(id, signal); }
        catch (error) {
          if (terminalReadErrors.has(error?.code) || signal.aborted) throw error;
          if (!missingCodes.has(error?.code)) throw error; // host failures are not "missing"
          rejected.set(id, 'TARGET_NOT_FOUND'); continue;
        }
        if (!directoryAllowed(selfMetadata, peer)) { rejected.set(id, 'ACCESS_DENIED'); continue; }
        metadata.set(id, peer);
        nodes.set(id, node(peer, snapshot, summaries));
        edges.push(edge);
        queue.push({ id, direction: current.direction });
      }
    }
    return { value: { self, nodes: [...nodes.values()], edges, truncated }, rejected };
  }
  async function workspaceMembers(workspaceId, signal) {
    abort(signal);
    if (typeof workspaces?.get !== 'function') throw fail('RELATIONS_UNAVAILABLE', 'The public Workspace registry is unavailable.');
    // get() and sessionIds are the public read-only ownership account. Never
    // infer membership from path, or ensure/attach/retain/resume a Session.
    const workspace = await workspaces.get(workspaceId);
    abort(signal);
    if (!workspace) throw fail('WORKSPACE_NOT_FOUND', 'The requested Workspace does not exist.');
    if (workspace.id !== workspaceId) throw fail('IDENTITY_MISMATCH', 'Workspace metadata did not match the requested identity.');
    const ids = workspace.sessionIds;
    if (!Array.isArray(ids)) throw fail('RELATIONS_UNAVAILABLE', 'The Workspace ownership account is unavailable.');
    return new Set(ids.filter(id => {
      try { return identity(id) === id; } catch { return false; }
    }));
  }
  async function buildWorkspace(workspaceId, signal) {
    const members = await workspaceMembers(workspaceId, signal);
    const snapshot = await store.read();
    abort(signal);
    if (!plain(snapshot)) throw fail('INVALID_STATE', 'The relationship ledger is unavailable.');
    const creations = Array.isArray(snapshot.creations) ? snapshot.creations : [];
    let truncated = creations.length > 1000;
    const edges = [];
    const firstParent = new Set();
    const parents = new Map();
    const metadata = new Map();
    const ordinary = async id => {
      if (metadata.has(id)) return metadata.get(id);
      let value;
      try { value = await describe(id, signal); }
      catch (error) {
        if (terminalReadErrors.has(error?.code) || signal.aborted) throw error;
        if (!missingCodes.has(error?.code)) throw error;
      }
      // Both ends must be existing independent ordinary Sessions; a Sidechat,
      // native child or fork cannot masquerade as plugin creation ancestry.
      const root = value?.kind === 'session' && value.parentId === undefined && value.archived === false ? value : null;
      metadata.set(id, root);
      return root;
    };
    const validCwd = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && isAbsolute(value) && !/[\u0000-\u001f\u007f]/u.test(value);
    for (const entry of creations.slice(0, 1000)) {
      abort(signal);
      if (!plain(entry) || !['ready', 'partial', 'unknown'].includes(entry.state)) continue;
      let sourceId, targetId;
      try { sourceId = identity(entry.senderId); targetId = identity(entry.sessionId); } catch { continue; }
      if (sourceId === targetId || firstParent.has(targetId)) continue;
      // First retained provenance wins even if it is inaccessible. A later
      // duplicate must not reparent an ordinary Session into this Workspace.
      firstParent.add(targetId);
      if (!members.has(sourceId) || !members.has(targetId)) continue;
      let cursor = sourceId;
      while (cursor !== targetId && parents.has(cursor)) cursor = parents.get(cursor);
      if (cursor === targetId) continue;
      if (edges.length === maxNodes) { truncated = true; break; }
      const source = await ordinary(sourceId);
      if (!source) continue;
      const target = await ordinary(targetId);
      if (!target) continue;
      if (sameDirectoryOnly && (!validCwd(source.cwd) || !validCwd(target.cwd) || !directoryAllowed(source, target))) continue;
      parents.set(targetId, sourceId);
      edges.push({ sourceId, targetId, kind: 'created-session' });
    }
    // Membership can change during awaited metadata reads. Recheck the public
    // account before returning; filtering cannot introduce a parent or a cycle.
    const current = await workspaceMembers(workspaceId, signal);
    return { schemaVersion: 1, workspaceId,
      edges: edges.filter(edge => current.has(edge.sourceId) && current.has(edge.targetId)), truncated };
  }
  return {
    workspace(workspaceId, { signal } = {}) {
      return scope.run(control => buildWorkspace(identity(workspaceId), control), { signal });
    },
    view(sessionId, { signal } = {}) {
      return scope.run(async control => (await build(identity(sessionId), control)).value, { signal });
    },
    resolve(sessionId, targetId, { signal } = {}) {
      return scope.run(async control => {
        identity(sessionId); identity(targetId);
        // The production HTTP caller is an authenticated Host owner. Exact
        // navigation may address peers outside the creation graph (for example
        // link_sessions tool references), but still obeys the directory fence.
        const self = await describe(sessionId, control);
        let target;
        try { target = targetId === sessionId ? self : await describe(targetId, control); }
        catch (error) {
          if (missingCodes.has(error?.code)) throw fail('TARGET_NOT_FOUND', 'The requested Session no longer exists.');
          throw error;
        }
        if (targetId !== sessionId && !directoryAllowed(self, target)) throw fail('ACCESS_DENIED', 'The Session is outside the permitted live directory.');
        if (target.archived === true) throw fail('TARGET_ARCHIVED', 'The Session is archived; this action does not unarchive or activate it.');
        const snapshot = await store.read();
        abort(control);
        if (!plain(snapshot)) throw fail('INVALID_STATE', 'The relationship ledger is unavailable.');
        return { targetId: target.id, node: node(target, snapshot, new Map()) };
      }, { signal });
    },
    close() { return scope.close(); },
  };
}
