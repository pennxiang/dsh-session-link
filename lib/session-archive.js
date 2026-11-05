import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { createReadScope } from './async-control.js';
import { createArchiveCascade } from './archive-cascade.js';

const get = (ctx, key) => typeof ctx?.get === 'function' ? ctx.get(key) : ctx?.[key];
const fail = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
const abort = signal => { if (signal?.aborted) throw fail('ABORTED', 'Archive operation cancelled before submission.'); };
const clean = (value, max = 200) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, max) : undefined;
function id(value, name, maximum = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw fail('INVALID_ARGUMENT', `${name} must be a nonempty stable identifier of at most ${maximum} characters.`);
  return value;
}
function activitySummary(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map(group => ({
    kind: clean(group?.kind, 80) ?? 'unknown',
    ...(Array.isArray(group?.items) ? {
      items: group.items.slice(0, 8).map(item => ({ ...(clean(item?.id, 128) === undefined ? {} : { id: clean(item.id, 128) }), ...(clean(item?.label, 120) === undefined ? {} : { label: clean(item.label, 120) }) })),
      totalItems: group.items.length, truncated: group.items.length > 8,
    } : {}),
  }));
}

/** Archive CONTROL, not relay delivery. Uses only public metadata and the native
 * WorkspaceRegistry mutation. The ToolRuntime owns tool admission/permissions;
 * this module never borrows a root, rebinds exec.agent, or invokes remote fences. */
export function createSessionArchiver({ ctx, store, config = {}, metadataTimeoutMs = 15000, now = Date.now } = {}) {
  const sameDirectoryOnly = config.sameDirectoryOnly ?? false;
  const capacity = config.maxArchives ?? 1000;
  if (typeof sameDirectoryOnly !== 'boolean' || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10000) throw fail('INVALID_CONFIG', 'Invalid archive configuration.');
  const listReads = createReadScope({ timeoutMs: metadataTimeoutMs });
  const mutationReads = createReadScope({ timeoutMs: metadataTimeoutMs });
  let tail = Promise.resolve(); let closing = false; let closePromise; let recovered = false;
  const cascade = createArchiveCascade({ ctx, store, config, metadataTimeoutMs, now, authorizeTool: authorize, validateToolScope: assertDirectory });
  async function archiveWithCascade(args, exec) {
    caller(exec);
    if (Object.hasOwn(args, 'owner') || Object.hasOwn(args, 'authority') || Object.hasOwn(args, 'principal')) throw fail('INVALID_ARGUMENT', 'Tool arguments cannot assert owner authority.');
    const targetId = id(args.targetId, 'targetId');
    id(args.requestId, 'requestId', 128);
    if (args.stopActivity !== undefined && typeof args.stopActivity !== 'boolean') throw fail('INVALID_ARGUMENT', 'stopActivity must be boolean.');
    if (args.archiveScope !== undefined && !['single', 'related'].includes(args.archiveScope)) throw fail('INVALID_ARGUMENT', 'archiveScope must be single or related.');
    const retained = await store.read();
    const legacy = retained.archives?.find(item => item.senderId === exec.agent.id && item.requestId === args.requestId);
    if (legacy) {
      if (args.planId !== undefined || args.archiveScope === 'related') throw fail('IDEMPOTENCY_CONFLICT', 'requestId already belongs to a single-Session archive.');
      return archive(args, exec);
    }
    const oldPlan = retained.archivePlans?.find(item => item.authority === 'tool' && item.senderId === exec.agent.id && (item.requestId === args.requestId || item.attempts?.some(attempt => attempt.requestId === args.requestId)));
    if (oldPlan && (oldPlan.targetId !== targetId || (args.planId !== undefined && args.planId !== oldPlan.planId))) throw fail('IDEMPOTENCY_CONFLICT', 'requestId already belongs to another cascade.');
    if (args.planId !== undefined) return cascade.commitForTool(args, exec);
    if (oldPlan && oldPlan.requestId !== args.requestId) throw fail('IDEMPOTENCY_CONFLICT', 'A retained commit request must retain its exact planId.');
    if (oldPlan?.archiveScope === undefined && oldPlan) {
      const previous = oldPlan.attempts?.find(item => item.requestId === args.requestId);
      if (previous && !['planned', 'expired'].includes(oldPlan.state)) return cascade.commitForTool({ ...args, planId: oldPlan.planId }, exec);
      throw fail('ARCHIVE_PLAN_CHANGED', 'Legacy plan lacks explicit scope consent; prepare a new scoped plan.');
    }
    if (oldPlan && oldPlan.archiveScope !== args.archiveScope) throw fail('IDEMPOTENCY_CONFLICT', 'requestId already names another archive scope.');
    // Single intentionally bypasses all descendant provenance, permissions and activity.
    if (args.archiveScope === 'single') return archive(args, exec);
    if (args.archiveScope === undefined) {
      // Even the existence of a related group is disclosed only after exact
      // target authorization. This does not authorize or inspect descendants.
      const candidates = await mutationReads.run(async signal => {
        const snapshot = await metadata(signal);
        const scope = await authorize(targetId, exec, snapshot.headers, signal);
        const found = await cascade.hasCandidates(targetId);
        const sender = caller({ ...exec, signal }); lineage(sender, snapshot.headers); assertDirectory(scope);
        return found;
      }, { signal: exec.signal });
      if (candidates) throw cascade.scopeRequired(targetId);
      return archive(args, exec);
    }
    const plan = await cascade.planForTool(args, exec);
    if (args.stopActivity === true || plan.requiresConfirmation) throw fail('ACTIVITY_REQUIRES_CONFIRMATION', 'Confirm the exact related plan with planId, archiveScope, stopActivity=true and a new requestId. No Session has been archived.', { planId: plan.planId, targetId, archiveScope: plan.archiveScope, activity: plan.activity, activitySummary: JSON.stringify(plan.activity), targets: plan.targets, archivedIds: [], remaining: plan.targets.map(item => item.id), archiveState: 'planned' });
    return cascade.commitForTool({ planId: plan.planId, archiveScope: plan.archiveScope, requestId: args.requestId, stopActivity: false }, exec);
  }

  function registry() {
    const value = get(ctx, 'workspaceRegistry');
    if (typeof value?.archiveSession !== 'function' || !Array.isArray(value.archivedSessionIds)) throw fail('ARCHIVE_HOST_UNAVAILABLE', 'The native Workspace archive capability is unavailable.');
    return value;
  }
  function archived(targetId) { return registry().archivedSessionIds.includes(targetId); }
  function caller(exec) {
    if (config.enabled === false) throw fail('DISABLED', 'Session Link is disabled.');
    abort(exec?.signal);
    const agent = exec?.agent;
    if (!agent || get(ctx, 'agents')?.get?.(agent.id) !== agent || agent.session?.header?.id !== agent.id || !['idle', 'running'].includes(agent.status)) throw fail('SENDER_NOT_LIVE', 'The exact caller Agent must be live.');
    return agent;
  }
  function lineage(agent, headers) {
    const chain = new Set(); let header = agent.session.header;
    for (let depth = 0; depth < 128; depth++) {
      if (chain.has(header.id)) throw fail('SENDER_LINEAGE_UNAVAILABLE', 'Caller ancestry contains a cycle.');
      chain.add(header.id);
      if (archived(header.id)) throw fail('SENDER_ARCHIVED', 'The caller or a durable subagent ancestor is archived.');
      if (header.origin !== 'subagent' || header.parentSession === undefined) return chain;
      const parentId = header.parentSession;
      if (typeof parentId !== 'string' || !parentId) throw fail('SENDER_LINEAGE_UNAVAILABLE', 'Caller ancestry is malformed.');
      if (archived(parentId)) throw fail('SENDER_ARCHIVED', 'The caller has an archived ancestor.');
      header = get(ctx, 'agents')?.get?.(parentId)?.session?.header ?? get(ctx, 'sessions')?.get?.(parentId)?.header ?? headers.get(parentId);
      if (!header) throw fail('SENDER_LINEAGE_UNAVAILABLE', 'Caller ancestry cannot be safely resolved from metadata.');
    }
    throw fail('SENDER_LINEAGE_UNAVAILABLE', 'Caller ancestry exceeds the bounded traversal limit.');
  }
  async function metadata(signal, titles = false) {
    abort(signal);
    const query = get(ctx, 'sessionQuery');
    if (typeof query?.listSessions !== 'function') throw fail('ARCHIVE_METADATA_UNAVAILABLE', 'A header-only Session directory is required.');
    const records = await query.listSessions(signal);
    abort(signal);
    if (!Array.isArray(records) || records.length > 100000) throw fail('ARCHIVE_METADATA_INVALID', 'Session directory is invalid or exceeds the safe metadata bound.');
    const headers = new Map();
    for (const record of records) if (typeof record?.header?.id === 'string') headers.set(record.header.id, record.header);
    for (const agent of get(ctx, 'agents')?.list?.() ?? []) if (agent?.session?.header?.id === agent.id) headers.set(agent.id, agent.session.header);
    const titlesById = new Map(); let titleCapability = false;
    const controller = get(ctx, 'sessionController');
    if (titles && typeof controller?.list === 'function') {
      const listing = await controller.list({}, signal);
      abort(signal);
      if (!Array.isArray(listing?.items) || listing.items.length > 100000) throw fail('ARCHIVE_METADATA_INVALID', 'Session list did not return bounded metadata rows.');
      titleCapability = true;
      for (const item of listing.items) {
        const title = item?.projections?.values?.title;
        if (typeof item?.sessionId === 'string' && typeof title === 'string' && title.trim()) titlesById.set(item.sessionId, clean(title));
      }
    }
    return { headers, titlesById, titleCapability };
  }
  function liveTitle(agent) {
    if (!agent) return undefined;
    const projections = get(ctx, 'sessionProjections');
    try {
      const value = projections?.cachedSnapshot?.(agent.session)?.values?.title;
      return typeof value === 'string' && value.trim() ? clean(value) : undefined;
    } catch { return undefined; }
  }
  function assertDirectory(scope) {
    if (!scope) return;
    const directory = get(ctx, 'workingDirectory');
    const sourceCwd = directory?.get?.(scope.sender.session);
    const targetCwd = directory?.get?.(scope.target.session);
    if (sourceCwd !== scope.sourceCwd || targetCwd !== scope.targetCwd || get(ctx, 'agents')?.get?.(scope.target.id) !== scope.target || get(ctx, 'agents')?.get?.(scope.sender.id) !== scope.sender) throw fail('ACCESS_DENIED', 'Live directory scope changed during archive authorization.');
  }
  async function sameDirectory(sender, targetId, signal) {
    if (!sameDirectoryOnly) return;
    const target = get(ctx, 'agents')?.get?.(targetId);
    const directory = get(ctx, 'workingDirectory');
    if (!target || typeof directory?.get !== 'function') throw fail('ACCESS_DENIED', 'Strict directory scope requires a live target with current directory metadata; cold header cwd is not trusted.');
    const sourceCwd = directory.get(sender.session); const targetCwd = directory.get(target.session);
    if (typeof sourceCwd !== 'string' || typeof targetCwd !== 'string') throw fail('ACCESS_DENIED', 'Current directory metadata is unavailable.');
    const [source, destination] = await Promise.all([realpath(sourceCwd), realpath(targetCwd)]);
    abort(signal);
    if (source !== destination) throw fail('ACCESS_DENIED', 'Cross-directory archive control is disabled.');
    const scope = { sender, target, sourceCwd, targetCwd };
    assertDirectory(scope);
    return scope;
  }
  async function authorize(targetId, exec, headers, signal) {
    const sender = caller({ ...exec, signal });
    const ancestors = lineage(sender, headers);
    if (targetId !== sender.id && ancestors.has(targetId)) throw fail('ARCHIVE_SELF_OR_ANCESTOR', 'Archiving durable subagent ancestors is forbidden; self archive remains subject to native activity admission.');
    if (!headers.has(targetId) && !get(ctx, 'agents')?.get?.(targetId)) throw fail('SESSION_NOT_FOUND', 'The exact target Session is not in the metadata directory.');
    const scope = await sameDirectory(sender, targetId, signal);
    caller({ ...exec, signal });
    lineage(sender, headers);
    assertDirectory(scope);
    return scope;
  }
  async function recover() {
    if (recovered) return;
    await store.mutate(draft => {
      draft.archives ??= [];
      if (!Array.isArray(draft.archives)) throw fail('INVALID_STATE', 'Archive ledger is malformed.');
      for (const entry of draft.archives) if (entry.state === 'archiving') {
        entry.state = 'unknown'; entry.stage = 'restart';
        entry.error = { code: 'ARCHIVE_RESTART_UNKNOWN', message: 'Interrupted archive intent; inspect the target archive bit instead of automatically resubmitting.' };
      }
    });
    recovered = true;
  }
  function replay(entry) {
    if (entry.state === 'succeeded') return { ...entry.result, replayed: true };
    throw fail(entry.error?.code ?? 'ARCHIVE_UNCERTAIN', entry.error?.message ?? 'This archive request has an uncertain outcome; it will not be automatically repeated.', {
      targetId: entry.targetId, sessionId: entry.targetId, archiveScope: entry.archiveScope ?? 'single', stage: entry.stage, state: entry.state, archiveState: entry.state, replayed: true,
      ...(entry.error?.activitySummary === undefined ? {} : { activitySummary: entry.error.activitySummary }),
      ...(entry.result === undefined ? {} : { readback: entry.result.readback, archived: entry.result.archived }),
    });
  }
  async function archive(args, exec) {
    const targetId = id(args.targetId, 'targetId'); const requestId = id(args.requestId, 'requestId', 128);
    if (args.stopActivity !== undefined && typeof args.stopActivity !== 'boolean') throw fail('INVALID_ARGUMENT', 'stopActivity must be boolean.');
    const stopActivity = args.stopActivity === true;
    const sender = caller(exec);
    registry();
    if (typeof store?.read !== 'function' || typeof store?.mutate !== 'function') throw fail('STORE_UNAVAILABLE', 'A durable archive ledger is required.');
    const snapshot = await mutationReads.run(signal => metadata(signal), { signal: exec.signal });
    lineage(sender, snapshot.headers);
    const archiveScope = 'single';
    const scopedFingerprint = createHash('sha256').update(JSON.stringify({ targetId, stopActivity, archiveScope })).digest('hex');
    await recover();
    const ledger = await store.read();
    const previous = ledger.archives.find(item => item.senderId === sender.id && item.requestId === requestId);
    const fingerprint = previous && previous.archiveScope === undefined && args.archiveScope === undefined
      ? createHash('sha256').update(JSON.stringify({ targetId, stopActivity })).digest('hex') : scopedFingerprint;
    if (previous && previous.fingerprint !== fingerprint) throw fail('IDEMPOTENCY_CONFLICT', 'requestId already names different archive arguments.', { targetId: previous.targetId });
    if (!previous) cascade.assertSingleAvailable(ledger, targetId);
    await mutationReads.run(signal => authorize(targetId, exec, snapshot.headers, signal), { signal: exec.signal });
    const admission = await store.mutate(draft => {
      abort(exec.signal); caller(exec); lineage(sender, snapshot.headers);
      const old = draft.archives.find(item => item.senderId === sender.id && item.requestId === requestId);
      if (old) {
        if (old.fingerprint !== fingerprint) throw fail('IDEMPOTENCY_CONFLICT', 'requestId already names different archive arguments.', { targetId: old.targetId });
        return { inserted: false, entry: old };
      }
      cascade.assertSingleAvailable(draft, targetId);
      if (draft.archives.length >= capacity) throw fail('ARCHIVE_CAPACITY', 'Archive intent capacity reached; retained outcomes are never silently evicted.');
      const entry = { senderId: sender.id, targetId, requestId, fingerprint, archiveScope, stopActivity, state: 'archiving', stage: 'preflight', createdAt: now(), updatedAt: now() };
      draft.archives.push(entry); return { inserted: true, entry };
    });
    if (!admission.inserted) return replay(admission.entry);
    let submitted = false; let alreadyArchived = false; let hostError; let readback; let stage = 'preflight';
    try {
      const scope = await mutationReads.run(signal => authorize(targetId, exec, snapshot.headers, signal), { signal: exec.signal });
      cascade.assertSingleAvailable(await store.read(), targetId, { senderId: sender.id, requestId });
      abort(exec.signal); caller(exec); lineage(sender, snapshot.headers);
      assertDirectory(scope);
      alreadyArchived = archived(targetId);
      if (!alreadyArchived) {
        stage = 'archive'; submitted = true;
        // Native archive has side effects: NEVER race, cancel, or timeout it.
        // The Host persists archive/unpin before issuing optional stop requests.
        await registry().archiveSession(targetId, { stopActivity });
      }
    } catch (error) { hostError = error; }
    stage = submitted ? 'readback' : stage;
    try { readback = archived(targetId); } catch { readback = undefined; }
    const result = {
      operation: 'archive', channel: 'session-link-control', archiveScope, targetId, sessionId: targetId,
      archived: readback ?? null, alreadyArchived, archiveState: 'succeeded',
      stopActivityRequested: submitted && stopActivity,
      readback: readback ?? null,
      readbackStatus: readback === true ? 'confirmed-archived' : readback === false ? 'confirmed-not-archived' : 'unavailable',
      ...(exec.signal?.aborted && submitted ? { cancelledAfterSubmission: true } : {}),
    };
    let error; let state = 'succeeded';
    if (hostError || readback !== true) {
      const active = hostError?.name === 'WorkspaceActiveSessionError' && hostError.sessionId === targetId && readback === false;
      const missing = hostError?.name === 'WorkspaceUnknownSessionError' && hostError.sessionId === targetId && readback === false;
      state = !submitted || active || missing ? 'failed' : readback === true ? 'partial' : 'unknown';
      error = {
        code: active ? 'ACTIVITY_REQUIRES_CONFIRMATION' : missing ? 'SESSION_NOT_FOUND' : !submitted && typeof hostError?.code === 'string' ? hostError.code : readback === true ? 'ARCHIVE_PARTIAL' : 'ARCHIVE_UNCERTAIN',
        message: active ? 'The target has active work. Explicit human confirmation is required before requesting stopActivity=true with a new requestId.' : 'Archive did not finish with a fully confirmed outcome. Inspect the recorded target; do not automatically repeat this request.',
        ...(active ? { activitySummary: JSON.stringify(activitySummary(hostError.activity)).slice(0, 4000) } : {}),
      };
      result.archiveState = state;
    }
    try {
      await store.mutate(draft => {
        const entry = draft.archives.find(item => item.senderId === sender.id && item.requestId === requestId);
        if (!entry) throw fail('INVALID_STATE', 'Archive intent disappeared.');
        Object.assign(entry, { state, stage: state === 'succeeded' ? 'complete' : stage, result, ...(error ? { error } : {}), updatedAt: now() });
      });
    } catch {
      throw fail('ARCHIVE_PERSISTENCE_UNCERTAIN', 'Host archive outcome could not be saved. Inspect the target and retained intent; never automatically retry.', { targetId, sessionId: targetId, archiveScope, stage: 'persist-result', state: 'unknown', archiveState: 'unknown', archived: readback ?? null, readback: result.readback });
    }
    if (error) throw fail(error.code, error.message, { targetId, sessionId: targetId, archiveScope, stage, state, archiveState: state, archived: result.archived, readback: result.readback, stopActivityRequested: result.stopActivityRequested, ...(result.cancelledAfterSubmission ? { cancelledAfterSubmission: true } : {}), partial: state === 'partial', ...(error.activitySummary ? { activitySummary: error.activitySummary } : {}) });
    return result;
  }
  async function list(args, exec) {
    const sender = caller(exec); registry();
    const limit = args.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 200)) || (args.includeArchived !== undefined && typeof args.includeArchived !== 'boolean')) throw fail('INVALID_ARGUMENT', 'Invalid archive discovery query, limit, or includeArchived.');
    const { headers, titlesById, titleCapability } = await metadata(exec.signal, true);
    const ancestors = lineage(sender, headers); const needle = (args.query ?? '').toLowerCase(); const sessions = [];
    let truncated = false; let scanned = 0;
    for (const [sessionId, header] of headers) {
      if (++scanned > 5000) { truncated = true; break; }
      abort(exec.signal);
      const isArchived = archived(sessionId);
      if (isArchived && args.includeArchived !== true) continue;
      const agent = get(ctx, 'agents')?.get?.(sessionId);
      if (sameDirectoryOnly) {
        try { await sameDirectory(sender, sessionId, exec.signal); } catch (error) { if (error.code === 'ABORTED') throw error; continue; }
      }
      const title = titlesById.get(sessionId) ?? liveTitle(agent);
      if (needle && !`${sessionId} ${title ?? ''}`.toLowerCase().includes(needle)) continue;
      if (sessions.length === limit) { truncated = true; break; }
      const isSelf = sessionId === sender.id;
      const forbidden = !isSelf && ancestors.has(sessionId);
      sessions.push({ id: sessionId, isSelf, title: title ?? null, titleAvailable: title !== undefined,
        kind: header.origin === 'subagent' ? 'subagent' : 'session',
        ...(header.parentSession ? { parentId: header.parentSession } : {}),
        status: agent ? ['idle', 'running'].includes(agent.status) ? agent.status : 'unknown' : 'persisted',
        live: Boolean(agent), archived: isArchived, canArchive: !forbidden,
        ...(forbidden ? { reason: 'ARCHIVE_SELF_OR_ANCESTOR' } : {}),
      });
    }
    caller(exec); lineage(sender, headers);
    return { operation: 'archive-discovery', channel: 'session-link-control', sessions, truncated, titleCapability: titleCapability ? 'public-cached-metadata' : 'live-cache-only' };
  }
  return {
    // INTERNAL owner capabilities: the caller must already have passed Host owner
    // admission. These never synthesize an Agent or accept model owner flags.
    planForOwner(args, options = {}) {
      if (closing) return Promise.reject(fail('ARCHIVER_CLOSED', 'Session archiver is closed.'));
      const operation = tail.then(() => cascade.planForOwner(args, options));
      tail = operation.catch(() => {}); return operation;
    },
    commitForOwner(args, options = {}) {
      if (closing) return Promise.reject(fail('ARCHIVER_CLOSED', 'Session archiver is closed.'));
      const operation = tail.then(() => cascade.commitForOwner(args, options));
      tail = operation.catch(() => {}); return operation;
    },
    execute(args, exec) {
      if (closing) return Promise.reject(fail('ARCHIVER_CLOSED', 'Session archiver is closed.'));
      if (!args || typeof args !== 'object' || Array.isArray(args)) return Promise.reject(fail('INVALID_ARGUMENT', 'Archive arguments must be an object.'));
      if (args.action === 'list') return listReads.run(signal => list(args, { ...exec, signal }), { signal: exec?.signal });
      if (args.action !== 'archive') return Promise.reject(fail('INVALID_ARGUMENT', 'action must be list or archive.'));
      const operation = tail.then(() => archiveWithCascade(args, exec));
      tail = operation.catch(() => {}); return operation;
    },
    close() {
      if (!closePromise) {
        closing = true;
        const reading = listReads.close();
        // Already-admitted mutations drain; only pure list reads are cut short.
        closePromise = Promise.allSettled([reading, tail]).then(async () => { await cascade.close(); await mutationReads.close(); });
      }
      return closePromise;
    },
  };
}
