import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createReadScope } from './async-control.js';

const get = (ctx, key) => typeof ctx?.get === 'function' ? ctx.get(key) : ctx?.[key];
const fail = (code, message, data = {}) => Object.assign(new Error(message), { code, ...data });
const abort = signal => { if (signal?.aborted) throw fail('ABORTED', 'Cascade cancelled before the next submission.'); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const valid = value => typeof value === 'string' && value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
function id(value, max = 256) {
  if (!valid(value) || value.length > max) throw fail('INVALID_ARGUMENT', 'A bounded exact identifier is required.');
  return value;
}
const clean = (value, max = 200) => typeof value === 'string' && value.trim() ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, max) : null;
const ordinary = header => header && header.origin !== 'subagent' && header.parentSession === undefined && header.isSeeded !== true;
const signature = header => hash(header);
function groups(value) {
  if (!Array.isArray(value)) throw fail('ARCHIVE_ACTIVITY_UNAVAILABLE', 'Activity providers did not return a complete activity array.');
  return value.slice(0, 32).map(group => ({ kind: clean(group?.kind, 80) ?? 'unknown',
    items: (Array.isArray(group?.items) ? group.items : []).slice(0, 32).map(item => ({ id: clean(item?.id, 128), label: clean(item?.label, 120) })),
    totalItems: Array.isArray(group?.items) ? group.items.length : 0,
  }));
}

/** Owner methods are INTERNAL capabilities for an already owner-admitted Host UI.
 * Tool methods require the real exec.agent and per-target authorization callback.
 * No model argument can switch authority. No native mutation is raced or rolled back. */
export function createArchiveCascade({ ctx, store, config = {}, metadataTimeoutMs = 15000, now = Date.now, uuid = randomUUID, authorizeTool, validateToolScope } = {}) {
  const capacity = config.maxArchives ?? 1000;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10000) throw fail('INVALID_CONFIG', 'Invalid cascade capacity.');
  const reads = createReadScope({ timeoutMs: metadataTimeoutMs });
  const references = new Map(); const cachedTitles = new Map();
  let tail = Promise.resolve(); let closed = false; let recovered = false; let closing;
  const enqueue = operation => {
    if (closed) return Promise.reject(fail('ARCHIVER_CLOSED', 'Cascade archiver is closed.'));
    const result = tail.then(operation); tail = result.catch(() => {}); return result;
  };
  function registry() {
    const value = get(ctx, 'workspaceRegistry');
    if (!value || typeof value.archiveSession !== 'function' || !Array.isArray(value.archivedSessionIds)) throw fail('ARCHIVE_HOST_UNAVAILABLE', 'Native Workspace archive is unavailable.');
    return value;
  }
  function actor(exec) {
    if (config.enabled === false) throw fail('DISABLED', 'Session Link is disabled.');
    if (!exec) return { authority: 'owner', senderId: null };
    abort(exec.signal);
    const agent = exec.agent;
    if (!agent || get(ctx, 'agents')?.get?.(agent.id) !== agent || agent.session?.header?.id !== agent.id || !['idle', 'running'].includes(agent.status)) throw fail('SENDER_NOT_LIVE', 'The exact caller Agent must be live.');
    if (typeof authorizeTool !== 'function') throw fail('ARCHIVE_AUTH_UNAVAILABLE', 'Per-target Tool authorization is unavailable.');
    return { authority: 'tool', senderId: agent.id };
  }
  const owned = (entry, who) => entry.authority === who.authority && entry.senderId === who.senderId;
  async function recover() {
    if (recovered) return;
    await store.mutate(draft => {
      draft.archivePlans ??= [];
      if (!Array.isArray(draft.archivePlans)) throw fail('INVALID_STATE', 'Cascade plan ledger is malformed.');
      for (const plan of draft.archivePlans) {
        if (plan.state === 'committing') {
          plan.state = 'unknown';
          for (const item of plan.items ?? []) if (item.state === 'submitting') item.state = 'unknown';
          const attempt = plan.attempts?.find(item => item.state === 'committing');
          if (attempt) { attempt.state = 'unknown'; attempt.error = { code: 'ARCHIVE_RESTART_UNKNOWN', message: 'Interrupted cascade; never automatically resubmit.' }; }
        } else if (plan.state === 'planned') plan.state = 'expired';
      }
    });
    recovered = true;
  }
  async function creationLedger() {
    const snapshot = await store.read();
    if (snapshot.creations !== undefined && !Array.isArray(snapshot.creations)) throw fail('INVALID_STATE', 'Creation ledger is malformed.');
    const entries = snapshot.creations ?? [];
    if (entries.length > 1000) throw fail('ARCHIVE_GRAPH_INCOMPLETE', 'Complete creation ledger exceeds the 1000-entry bound; no partial cascade is allowed.');
    return entries;
  }
  function assertNoOverlap(snapshot, ids, ownPlanId, archiveScope = 'related') {
    const targets = new Set(ids);
    const cascade = (snapshot.archivePlans ?? []).some(old => old.planId !== ownPlanId && ['unknown', 'committing'].includes(old.state) && old.items.some(item => targets.has(item.id) && (archiveScope !== 'single' || old.state === 'committing' || ['unknown', 'submitting'].includes(item.state))));
    const legacy = (snapshot.archives ?? []).some(old => ['unknown', 'archiving'].includes(old.state) && targets.has(old.targetId));
    if (cascade || legacy) throw fail('ARCHIVE_PRIOR_UNKNOWN', 'An overlapping archive has an unresolved outcome; no fresh or previously prepared plan may repeat it.');
  }
  function parentMap(entries) {
    const parents = new Map();
    for (const entry of entries) {
      if (!['ready', 'partial', 'unknown'].includes(entry?.state)) continue;
      if (!valid(entry.senderId) || !valid(entry.sessionId)) continue;
      if (!parents.has(entry.sessionId)) parents.set(entry.sessionId, entry.senderId);
    }
    return parents;
  }
  async function directory(signal, onlyId) {
    const query = get(ctx, 'sessionQuery');
    if (typeof query?.listSessions !== 'function') throw fail('ARCHIVE_METADATA_UNAVAILABLE', 'Header-only Session metadata is required.');
    const rows = await query.listSessions(signal); abort(signal);
    if (!Array.isArray(rows) || rows.length > 100000) throw fail('ARCHIVE_METADATA_INVALID', 'Session directory is incomplete or invalid.');
    const headers = new Map();
    for (const row of rows) if (valid(row?.header?.id) && (onlyId === undefined || row.header.id === onlyId)) {
      const old = headers.get(row.header.id);
      if (old && signature(old) !== signature(row.header)) throw fail('ARCHIVE_PLAN_CHANGED', 'Session directory has conflicting identities.');
      headers.set(row.header.id, row.header);
    }
    const live = onlyId === undefined ? get(ctx, 'agents')?.list?.() ?? [] : [get(ctx, 'agents')?.get?.(onlyId)].filter(Boolean);
    for (const agent of live) {
      if (agent.session?.header?.id !== agent.id || (onlyId !== undefined && agent.id !== onlyId)) throw fail('ARCHIVE_PLAN_CHANGED', 'Live Session identity is unstable.');
      headers.set(agent.id, agent.session.header);
    }
    return headers;
  }
  function workspace(targetId, requested) {
    const reg = registry();
    if (typeof reg.list !== 'function' || typeof reg.get !== 'function') throw fail('ARCHIVE_WORKSPACE_UNAVAILABLE', 'A complete current Workspace account is required.');
    const all = reg.list();
    if (!Array.isArray(all) || all.length > 10000) throw fail('ARCHIVE_WORKSPACE_UNAVAILABLE', 'Workspace directory is incomplete.');
    const matches = all.filter(row => Array.isArray(row?.sessionIds) && row.sessionIds.includes(targetId));
    if (matches.length > 1) throw fail('ARCHIVE_PLAN_CHANGED', 'Session has ambiguous current Workspace membership.');
    if (!matches.length) {
      if (requested !== undefined) throw fail('ARCHIVE_PLAN_CHANGED', 'Root is no longer in the requested Workspace.');
      return null;
    }
    const found = matches[0];
    if (!valid(found.id) || (requested !== undefined && requested !== found.id)) throw fail('ARCHIVE_PLAN_CHANGED', 'Root Workspace changed.');
    const current = reg.get(found.id);
    if (!current || current.id !== found.id || !Array.isArray(current.sessionIds) || !current.sessionIds.includes(targetId)) throw fail('ARCHIVE_PLAN_CHANGED', 'Workspace identity or membership changed.');
    return { id: current.id, members: new Set(current.sessionIds) };
  }
  function title(targetId) {
    const agent = get(ctx, 'agents')?.get?.(targetId);
    try { return clean(agent && get(ctx, 'sessionProjections')?.cachedSnapshot?.(agent.session)?.values?.title) ?? cachedTitles.get(targetId) ?? null; } catch { return cachedTitles.get(targetId) ?? null; }
  }
  function assertStableCreation(entries, selected, headers) {
    const selectedIds = new Set(selected);
    for (const entry of entries) {
      if (!selectedIds.has(entry?.senderId)) continue;
      const exists = valid(entry.sessionId) && headers.has(entry.sessionId);
      if (!['ready', 'partial', 'unknown', 'failed'].includes(entry.state) ||
          (['partial', 'unknown'].includes(entry.state) && !exists) ||
          (entry.state === 'ready' && !valid(entry.sessionId)) ||
          (entry.state === 'failed' && exists)) {
        throw fail('ARCHIVE_GRAPH_UNSTABLE', 'A selected Session has an in-flight or unresolved creation; no single-target fallback or partial group archive is safe.');
      }
    }
  }
  function scope(value, required = false) {
    if (value === undefined && !required) return value;
    if (!['single', 'related'].includes(value)) throw fail('INVALID_ARGUMENT', 'archiveScope must explicitly be single or related.');
    return value;
  }
  const scopeRequired = targetId => fail('ARCHIVE_SCOPE_REQUIRED', 'Choose only this Session or its related group before preparing an archive plan. No Session was archived.', { targetId, allowedScopes: ['single', 'related'] });
  async function hasCandidates(targetId) {
    id(targetId); const entries = await creationLedger();
    return entries.some(entry => entry?.senderId === targetId && (entry.state !== 'failed' || valid(entry.sessionId)));
  }
  async function graph(targetId, requested, signal, archiveScope = 'related') {
    // Explicit single NEVER reads creation provenance or descendants.
    const entries = archiveScope === 'single' ? null : await creationLedger(); abort(signal);
    const headers = await directory(signal, archiveScope === 'single' ? targetId : undefined);
    const root = headers.get(targetId);
    if (!root) throw fail('SESSION_NOT_FOUND', 'Exact root Session does not exist.');
    if (archiveScope === 'single') {
      const ws = workspace(targetId, requested);
      const identities = [[targetId, signature(root)]];
      return { handled: true, headers, workspaceId: ws?.id ?? null, order: [targetId], identities, archiveScope,
        fingerprint: hash([archiveScope, ws?.id ?? null, identities]) };
    }
    if (!ordinary(root)) return { handled: false, headers };
    assertStableCreation(entries, [targetId], headers);
    const ws = workspace(targetId, requested);
    if (!ws) return { handled: false, headers };
    const parents = parentMap(entries); const children = new Map();
    for (const [child, parent] of parents) {
      if (!ws.members.has(parent) || !ws.members.has(child) || !ordinary(headers.get(parent))) continue;
      if (headers.has(child) && !ordinary(headers.get(child))) continue;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(child);
    }
    const path = new Set(); const seen = new Set(); const order = []; const edges = [];
    function visit(current) {
      if (!headers.has(current)) throw fail('ARCHIVE_METADATA_INVALID', 'A related current Workspace member has no verifiable Session identity.');
      if (path.has(current)) throw fail('ARCHIVE_GRAPH_CYCLE', 'Creation ancestry contains a cycle; nothing can be archived.');
      if (seen.has(current)) return;
      assertStableCreation(entries, [current], headers);
      path.add(current);
      for (const child of children.get(current) ?? []) { edges.push([current, child]); visit(child); }
      path.delete(current); seen.add(current); order.push(current);
      if (order.length > 1000) throw fail('ARCHIVE_GRAPH_INCOMPLETE', 'Cascade exceeds the 1000-target public confirmation bound; no target may be silently truncated.');
    }
    visit(targetId);
    const identities = order.map(sessionId => [sessionId, signature(headers.get(sessionId))]);
    return { handled: order.length > 1, headers, workspaceId: ws.id, order, identities, archiveScope, fingerprint: hash([archiveScope, ws.id, identities, edges]) };
  }
  async function authorizeAll(current, exec, signal, completed = new Set()) {
    actor(exec); abort(signal);
    const before = current.order.map(targetId => [targetId, get(ctx, 'agents')?.get?.(targetId)]);
    const scopes = []; const paths = [];
    if (exec) {
      for (const targetId of current.order) if (!completed.has(targetId)) {
        const scope = await authorizeTool(targetId, exec, current.headers, signal);
        if (scope !== undefined) {
          if (typeof validateToolScope !== 'function') throw fail('ARCHIVE_AUTH_UNAVAILABLE', 'A final synchronous Tool scope validator is required.');
          scopes.push(scope);
        }
      }
    } else if (config.sameDirectoryOnly) {
      for (const targetId of current.order) {
        if (completed.has(targetId)) continue;
        const agent = get(ctx, 'agents')?.get?.(targetId);
        const path = agent && get(ctx, 'workingDirectory')?.get?.(agent.session);
        if (!agent || !['idle', 'running'].includes(agent.status) || typeof path !== 'string' || !isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path)) throw fail('ACCESS_DENIED', 'Strict directory scope requires every target live with current absolute cwd.');
        paths.push([agent, path, await realpath(path)]); abort(signal);
      }
      if (paths.some(row => row[2] !== paths[0][2])) throw fail('ACCESS_DENIED', 'Cascade targets do not share the current effective directory.');
      for (const [agent, path] of paths) if (get(ctx, 'workingDirectory').get(agent.session) !== path) throw fail('ACCESS_DENIED', 'Effective directory changed.');
    }
    const validate = () => {
      actor(exec); abort(signal);
      // Every scope is checked together AFTER the last awaited authorization.
      // Per-target checks alone allow a later target's await to invalidate an
      // earlier target. Repeat this guard immediately adjacent to native submit.
      for (const scope of scopes) validateToolScope(scope);
      for (const [agent, path] of paths) if (get(ctx, 'workingDirectory').get(agent.session) !== path) throw fail('ACCESS_DENIED', 'Effective directory changed.');
      for (const [targetId, agent] of before) if (get(ctx, 'agents')?.get?.(targetId) !== agent) throw fail('ARCHIVE_PLAN_CHANGED', 'A live target identity changed during preflight.');
      for (const [targetId, expected] of current.identities) {
        const header = get(ctx, 'agents')?.get?.(targetId)?.session?.header ?? current.headers.get(targetId);
        if (!header || signature(header) !== expected) throw fail('ARCHIVE_PLAN_CHANGED', 'A Session header identity changed.');
      }
      const ws = workspace(current.order.at(-1), current.workspaceId ?? undefined);
      if ((ws?.id ?? null) !== current.workspaceId || (ws && current.order.some(targetId => !ws.members.has(targetId)))) throw fail('ARCHIVE_PLAN_CHANGED', 'Current group Workspace membership changed.');
    };
    validate(); before.validate = validate;
    return before;
  }
  async function activity(current, signal) {
    if (typeof ctx?.waterfall !== 'function') throw fail('ARCHIVE_ACTIVITY_UNAVAILABLE', 'Complete native activity preflight is unavailable.');
    const controller = get(ctx, 'sessionController');
    if (typeof controller?.list === 'function') {
      const listing = await controller.list({}, signal); abort(signal);
      if (!Array.isArray(listing?.items) || listing.items.length > 100000) throw fail('ARCHIVE_METADATA_INVALID', 'Cached title metadata is incomplete.');
      cachedTitles.clear();
      for (const item of listing.items) {
        const name = clean(item?.projections?.values?.title);
        if (valid(item?.sessionId) && name !== null) cachedTitles.set(item.sessionId, name);
      }
    }
    const result = [];
    for (const sessionId of current.order) {
      abort(signal);
      if (registry().archivedSessionIds.includes(sessionId)) continue;
      const raw = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([])); abort(signal);
      const summary = groups(raw);
      if (raw.length) result.push({ sessionId, title: title(sessionId), titleAvailable: title(sessionId) !== null, groups: summary, totalGroups: raw.length });
    }
    return result;
  }
  function unchanged(plan, current) {
    if (!current.handled || plan.fingerprint !== current.fingerprint) throw fail('ARCHIVE_PLAN_CHANGED', 'Cascade membership, provenance or Session identity changed. Prepare and confirm a new plan; this plan cannot expand.');
    const refs = references.get(plan.planId);
    if (refs) for (const [targetId, agent] of refs) if (get(ctx, 'agents')?.get?.(targetId) !== agent) throw fail('ARCHIVE_PLAN_CHANGED', 'Live identity changed after plan preparation.');
  }
  function publicPlan(plan) {
    return { operation: 'archive-plan', channel: 'session-link-control', handled: true, hasRelatedDescendants: plan.archiveScope === 'related', archiveScope: plan.archiveScope,
      planId: plan.planId, targetId: plan.targetId, workspaceId: plan.workspaceId, total: plan.items.length,
      targets: plan.items.map(item => ({ id: item.id, title: item.title, alreadyArchived: item.alreadyArchived })),
      activity: plan.activity, requiresConfirmation: plan.activity.length > 0, state: plan.state };
  }
  function report(plan) {
    const archivedIds = plan.items.filter(item => ['archived', 'already-archived'].includes(item.state)).map(item => item.id);
    return { operation: 'archive', channel: 'session-link-control', cascade: plan.archiveScope !== 'single', archiveScope: plan.archiveScope, handled: true, planId: plan.planId,
      targetId: plan.targetId, sessionId: plan.targetId, workspaceId: plan.workspaceId, archiveState: plan.state === 'committing' ? 'unknown' : plan.state,
      archived: archivedIds.includes(plan.targetId), archivedIds,
      remaining: plan.items.filter(item => !archivedIds.includes(item.id)).map(item => item.id),
      failed: plan.items.filter(item => ['failed', 'unknown', 'submitting'].includes(item.state)).map(item => ({ id: item.id, state: item.state === 'submitting' ? 'unknown' : item.state })),
      stopActivityRequested: plan.items.some(item => item.stopActivityRequested), atomic: false };
  }
  async function plan(args, exec, signal) {
    const who = actor(exec); abort(signal);
    const targetId = id(args.targetId); const requestId = id(args.requestId, 128);
    const workspaceId = args.workspaceId === undefined ? undefined : id(args.workspaceId);
    const archiveScope = scope(args.archiveScope);
    await recover();
    const plans = (await store.read()).archivePlans;
    if (plans.some(item => owned(item, who) && item.requestId !== requestId && item.attempts.some(attempt => attempt.requestId === requestId))) throw fail('IDEMPOTENCY_CONFLICT', 'Plan requestId already belongs to a retained commit.');
    const prior = plans.find(item => owned(item, who) && item.requestId === requestId);
    if (prior) {
      if (prior.targetId !== targetId || prior.requestedWorkspace !== (workspaceId ?? null) || (prior.archiveScope !== undefined && prior.archiveScope !== archiveScope) || (exec && prior.requestedStop !== (args.stopActivity === true))) throw fail('IDEMPOTENCY_CONFLICT', 'Plan requestId already names different arguments.');
      if (prior.state === 'expired' || prior.archiveScope === undefined) throw fail('ARCHIVE_PLAN_CHANGED', 'Retained plan lacks current explicit scope consent or expired; prepare and confirm a new plan.', { ...report(prior), replayed: true });
      return { ...publicPlan(prior), replayed: true };
    }
    if (archiveScope === undefined) {
      if (await hasCandidates(targetId)) throw scopeRequired(targetId);
      return { operation: 'archive-plan', handled: false, hasRelatedDescendants: false, targetId, planId: null };
    }
    const prepared = await reads.run(async control => {
      const current = await graph(targetId, workspaceId, control, archiveScope);
      if (!current.handled) return current;
      const refs = await authorizeAll(current, exec, control);
      const active = await activity(current, control);
      const again = await graph(targetId, current.workspaceId ?? undefined, control, archiveScope);
      if (again.fingerprint !== current.fingerprint) throw fail('ARCHIVE_PLAN_CHANGED', 'Cascade changed during preparation.');
      await authorizeAll(again, exec, control);
      for (const [target, agent] of refs) if (get(ctx, 'agents')?.get?.(target) !== agent) throw fail('ARCHIVE_PLAN_CHANGED', 'Target identity changed during preparation.');
      return { ...current, refs, active };
    }, { signal });
    if (!prepared.handled) throw fail('ARCHIVE_PLAN_CHANGED', 'Related scope no longer contains at least two eligible Sessions; choose single explicitly.', { targetId, archiveScope });
    assertNoOverlap(await store.read(), prepared.order, undefined, archiveScope);
    const entry = { ...who, archiveScope, planId: uuid(), targetId, requestId, requestedWorkspace: workspaceId ?? null, requestedStop: exec ? args.stopActivity === true : false,
      workspaceId: prepared.workspaceId, fingerprint: prepared.fingerprint, state: 'planned', createdAt: now(),
      activity: prepared.active, attempts: [], items: prepared.order.map(sessionId => {
        const alreadyArchived = registry().archivedSessionIds.includes(sessionId);
        return { id: sessionId, title: title(sessionId), alreadyArchived, state: alreadyArchived ? 'already-archived' : 'pending' };
      }) };
    await store.mutate(draft => {
      abort(signal); actor(exec);
      if (draft.archivePlans.length >= capacity) throw fail('ARCHIVE_CAPACITY', 'Retained cascade plan capacity reached.');
      if (draft.archivePlans.some(item => owned(item, who) && item.requestId === requestId)) throw fail('IDEMPOTENCY_CONFLICT', 'Concurrent plan already retained.');
      draft.archivePlans.push(entry);
    });
    references.set(entry.planId, prepared.refs);
    return publicPlan(entry);
  }
  function replay(plan, attempt) {
    if (attempt.state === 'succeeded') return { ...attempt.result, replayed: true };
    throw fail(attempt.error?.code ?? 'ARCHIVE_UNCERTAIN', attempt.error?.message ?? 'Retained cascade outcome will not be resubmitted.', { ...report(plan), replayed: true, ...(attempt.error?.activity ? { activity: attempt.error.activity } : {}) });
  }
  async function commit(args, exec, signal) {
    const who = actor(exec); abort(signal);
    const planId = id(args.planId); const requestId = id(args.requestId, 128);
    if (args.stopActivity !== undefined && typeof args.stopActivity !== 'boolean') throw fail('INVALID_ARGUMENT', 'stopActivity must be boolean.');
    const stopActivity = args.stopActivity === true;
    await recover();
    const plans = (await store.read()).archivePlans;
    if (plans.some(item => owned(item, who) && item.planId !== planId && (item.requestId === requestId || item.attempts.some(attempt => attempt.requestId === requestId)))) throw fail('IDEMPOTENCY_CONFLICT', 'Commit requestId already belongs to another plan.');
    let entry = plans.find(item => item.planId === planId && owned(item, who));
    if (!entry) throw fail('ARCHIVE_PLAN_NOT_FOUND', 'No accessible exact archive plan exists.');
    if (args.targetId !== undefined && args.targetId !== entry.targetId) throw fail('IDEMPOTENCY_CONFLICT', 'planId does not name the requested targetId.');
    const prior = entry.attempts.find(item => item.requestId === requestId);
    // Historical terminal outcomes may be reconciled, never upgraded into scope consent.
    if (entry.archiveScope === undefined) {
      if (prior && entry.state !== 'planned' && entry.state !== 'expired') {
        if (args.archiveScope !== undefined || prior.stopActivity !== stopActivity) throw fail('IDEMPOTENCY_CONFLICT', 'Historical commit arguments cannot change.');
        return replay(entry, prior);
      }
      throw fail('ARCHIVE_PLAN_CHANGED', 'Legacy plan has no explicit archive scope; prepare a new scoped plan.', report(entry));
    }
    const archiveScope = scope(args.archiveScope, true);
    if (archiveScope !== entry.archiveScope) throw fail('IDEMPOTENCY_CONFLICT', 'Commit scope must match the immutable plan scope.');
    if (prior) {
      if (prior.stopActivity !== stopActivity) throw fail('IDEMPOTENCY_CONFLICT', 'Commit requestId already names different stop consent.');
      return replay(entry, prior);
    }
    if (entry.state !== 'planned') throw fail(entry.state === 'expired' ? 'ARCHIVE_PLAN_CHANGED' : 'ARCHIVE_PLAN_TERMINAL', 'This plan is terminal or uncertain and cannot be resubmitted.', report(entry));
    if (stopActivity && requestId === entry.requestId) throw fail('IDEMPOTENCY_CONFLICT', 'Stop consent requires a new requestId bound to the exact planId.');
    assertNoOverlap(await store.read(), entry.items.map(item => item.id), planId, entry.archiveScope);
    let active;
    try {
      active = await reads.run(async control => {
        const current = await graph(entry.targetId, entry.workspaceId ?? undefined, control, entry.archiveScope); unchanged(entry, current);
        await authorizeAll(current, exec, control);
        const active = await activity(current, control);
        unchanged(entry, await graph(entry.targetId, entry.workspaceId ?? undefined, control, entry.archiveScope));
        await authorizeAll(current, exec, control);
        return active;
      }, { signal });
      if (active.length && !stopActivity) throw fail('ACTIVITY_REQUIRES_CONFIRMATION', 'Related Sessions have active work. Confirm this exact plan with stopActivity=true and a new requestId.', { activity: active });
    } catch (error) {
      const safe = { code: error.code ?? 'ARCHIVE_PREFLIGHT_FAILED', message: 'Cascade preflight refused without archiving any Session.', ...(error.activity ? { activity: error.activity } : {}) };
      await store.mutate(draft => {
        const plan = draft.archivePlans.find(item => item.planId === planId);
        if (plan.attempts.length >= 32) throw fail('ARCHIVE_CAPACITY', 'Plan confirmation attempt capacity reached.');
        plan.attempts.push({ requestId, stopActivity, state: 'failed', error: safe });
      });
      throw fail(safe.code, safe.message, { ...report(entry), planId, ...(safe.activity ? { activity: safe.activity } : {}) });
    }
    await store.mutate(draft => {
      abort(signal); actor(exec);
      const plan = draft.archivePlans.find(item => item.planId === planId);
      if (plan.state !== 'planned' || plan.attempts.some(item => item.requestId === requestId)) throw fail('ARCHIVE_PLAN_CHANGED', 'Plan was concurrently consumed.');
      assertNoOverlap(draft, plan.items.map(item => item.id), planId, plan.archiveScope);
      if (plan.attempts.length >= 32) throw fail('ARCHIVE_CAPACITY', 'Plan confirmation attempt capacity reached.');
      plan.state = 'committing'; plan.attempts.push({ requestId, stopActivity, state: 'committing' });
    });
    let hostError; let submitted = false;
    const completed = new Set(); const observed = new Map();
    try {
      for (const item of entry.items) {
        // Revalidate the WHOLE group before every side effect, including targets
        // already archived by this commit. No plan expansion or silent dropping.
        await reads.run(async control => {
          const current = await graph(entry.targetId, entry.workspaceId ?? undefined, control, entry.archiveScope); unchanged(entry, current);
          await authorizeAll(current, exec, control, completed);
        }, { signal });
        abort(signal); actor(exec);
        if (registry().archivedSessionIds.includes(item.id)) {
          await store.mutate(draft => { draft.archivePlans.find(plan => plan.planId === planId).items.find(row => row.id === item.id).state = 'already-archived'; });
          continue;
        }
        await store.mutate(draft => {
          abort(signal); actor(exec);
          const plan = draft.archivePlans.find(plan => plan.planId === planId);
          assertNoOverlap(draft, plan.items.map(row => row.id), planId, plan.archiveScope);
          const row = plan.items.find(row => row.id === item.id);
          row.state = 'submitting'; row.stopActivityRequested = stopActivity;
        });
        // Final authority check after the durable intent; side effects are never raced.
        let submissionGuard;
        await reads.run(async control => {
          const current = await graph(entry.targetId, entry.workspaceId ?? undefined, control, entry.archiveScope); unchanged(entry, current);
          submissionGuard = await authorizeAll(current, exec, control, completed);
        }, { signal });
        abort(signal); actor(exec); submissionGuard.validate(); submitted = true;
        let error; let readback;
        try { await registry().archiveSession(item.id, { stopActivity }); } catch (cause) { error = cause; }
        try { readback = registry().archivedSessionIds.includes(item.id); } catch { readback = null; }
        const knownRefusal = readback === false && error?.sessionId === item.id && ['WorkspaceActiveSessionError', 'WorkspaceUnknownSessionError'].includes(error?.name);
        const itemState = readback === true ? 'archived' : knownRefusal ? 'failed' : 'unknown';
        observed.set(item.id, { state: itemState, readback, stopActivityRequested: stopActivity });
        if (readback === true && !error) {
          completed.add(item.id);
          // Host stop may legitimately dispose the just-archived Agent. Accept
          // only disappearance, never a replacement or a new target identity.
          if (!get(ctx, 'agents')?.get?.(item.id)) {
            const refs = references.get(planId);
            if (refs) references.set(planId, refs.map(row => row[0] === item.id ? [item.id, undefined] : row));
          }
        }
        await store.mutate(draft => {
          const row = draft.archivePlans.find(plan => plan.planId === planId).items.find(row => row.id === item.id);
          row.state = readback === true ? 'archived' : knownRefusal ? 'failed' : 'unknown'; row.readback = readback;
        });
        if (error || readback !== true) throw fail(knownRefusal ? error.name === 'WorkspaceActiveSessionError' ? 'ACTIVITY_REQUIRES_CONFIRMATION' : 'SESSION_NOT_FOUND' : readback === true ? 'ARCHIVE_PARTIAL' : 'ARCHIVE_UNCERTAIN', 'Native archive did not finish with a fully confirmed outcome.');
      }
    } catch (error) { hostError = error; }
    try {
      entry = (await store.read()).archivePlans.find(item => item.planId === planId);
      const changed = entry.items.some(item => item.state === 'archived');
      const uncertain = entry.items.some(item => ['unknown', 'submitting'].includes(item.state));
      const state = !hostError ? 'succeeded' : uncertain ? 'unknown' : changed ? 'partial' : 'failed';
      await store.mutate(draft => {
        const plan = draft.archivePlans.find(item => item.planId === planId); plan.state = state;
        for (const item of plan.items) if (item.state === 'submitting') item.state = 'unknown';
        const attempt = plan.attempts.find(item => item.requestId === requestId);
        attempt.state = state;
        if (hostError) attempt.error = { code: hostError.code ?? 'ARCHIVE_UNCERTAIN', message: 'Cascade stopped; inspect per-Session outcomes. It is not atomic and is never automatically repeated.' };
        attempt.result = { ...report(plan), ...(signal?.aborted && submitted ? { cancelledAfterSubmission: true } : {}) };
      });
      entry = (await store.read()).archivePlans.find(item => item.planId === planId);
    } catch {
      const snapshot = { ...entry, state: 'unknown', items: entry.items.map(item => ({ ...item, ...(observed.get(item.id) ?? {}) })) };
      throw fail('ARCHIVE_PERSISTENCE_UNCERTAIN', 'Native outcome could not be durably recorded; never automatically repeat this plan.', report(snapshot));
    }
    const attempt = entry.attempts.find(item => item.requestId === requestId);
    if (hostError) throw fail(attempt.error.code, attempt.error.message, attempt.result);
    return attempt.result;
  }
  return {
    hasCandidates,
    scopeRequired,
    assertSingleAvailable(snapshot, targetId, own) {
      const filtered = { archivePlans: snapshot.archivePlans,
        archives: (snapshot.archives ?? []).filter(item => !own || item.senderId !== own.senderId || item.requestId !== own.requestId) };
      assertNoOverlap(filtered, [targetId], undefined, 'single');
    },
    planForOwner(args, { signal } = {}) { return enqueue(() => plan(args, null, signal)); },
    commitForOwner(args, { signal } = {}) { return enqueue(() => commit(args, null, signal)); },
    planForTool(args, exec) {
      if (!exec?.agent) return Promise.reject(fail('SENDER_NOT_LIVE', 'Tool planning requires the actual caller Agent.'));
      return enqueue(() => plan(args, exec, exec.signal));
    },
    commitForTool(args, exec) {
      if (!exec?.agent) return Promise.reject(fail('SENDER_NOT_LIVE', 'Tool commit requires the actual caller Agent.'));
      return enqueue(() => commit(args, exec, exec.signal));
    },
    close() { if (!closing) { closed = true; closing = tail.then(() => reads.close()); } return closing; },
  };
}
