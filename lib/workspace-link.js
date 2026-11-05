import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const fail = (code, message) => Object.assign(new Error(message), { code });
const check = signal => { if (signal?.aborted) throw fail('ABORTED', 'Workspace planning was cancelled.'); };
const service = (ctx, key) => typeof ctx?.get === 'function' ? ctx.get(key) : ctx?.[key];

/** Public Workspace API only. Planning is read-only; ensure/attach are mutations
 * and MUST NOT be Promise.raced with a timeout or an abort signal. */
export function createWorkspaceLink(ctx) {
  function registry() {
    const value = service(ctx, 'workspaceRegistry');
    if (typeof value?.list !== 'function' || typeof value?.get !== 'function' || typeof value?.create !== 'function') {
      throw fail('WORKSPACE_UNAVAILABLE', 'Workspace discovery, lookup, and registration are required for new sessions.');
    }
    return value;
  }
  function validate(entity) {
    if (!entity || typeof entity.id !== 'string' || !entity.id || typeof entity.path !== 'string' ||
        !isAbsolute(entity.path) || !Array.isArray(entity.sessionIds) || typeof entity.attachSession !== 'function') {
      throw fail('WORKSPACE_CONTRACT_INVALID', 'Workspace metadata does not match the public Host contract.');
    }
    return entity;
  }
  function all() {
    const values = registry().list();
    if (!Array.isArray(values) || values.length > 10000) throw fail('WORKSPACE_CONTRACT_INVALID', 'Workspace list is invalid or too large.');
    return values.map(validate);
  }
  function exact(id) {
    const value = registry().get(id);
    if (!value) throw fail('WORKSPACE_NOT_FOUND', 'The requested workspace is not registered.');
    if (validate(value).id !== id) throw fail('WORKSPACE_CONTRACT_INVALID', 'Workspace lookup returned a different identity from the requested workspaceId.');
    return value;
  }
  function matching(path) {
    const matches = all().filter(item => item.path === path);
    if (matches.length > 1) throw fail('WORKSPACE_AMBIGUOUS', 'Several workspaces claim the target canonical directory; choose a unique valid registration.');
    return matches[0];
  }
  return {
    pathFor(workspaceId) { return exact(workspaceId).path; },
    async plan({ sourceId, sourceCwd, targetCwd, workspaceId, signal }) {
      check(signal);
      registry();
      const targetPath = await realpath(targetCwd);
      check(signal);
      if (workspaceId !== undefined) {
        const chosen = exact(workspaceId);
        if (chosen.path !== targetPath) throw fail('WORKSPACE_CWD_MISMATCH', 'workspaceId and cwd must identify the same canonical directory.');
        return { workspaceId: chosen.id, path: targetPath, selection: 'explicit' };
      }
      const values = all();
      const matches = values.filter(item => item.path === targetPath);
      if (matches.length > 1) throw fail('WORKSPACE_AMBIGUOUS', 'The target directory has multiple workspace registrations.');
      const sourcePath = await realpath(sourceCwd);
      check(signal);
      if (sourcePath === targetPath) {
        const owners = values.filter(item => item.sessionIds.includes(sourceId));
        if (owners.length > 1) throw fail('WORKSPACE_AMBIGUOUS', 'The caller has several workspace memberships; cannot infer one safely.');
        if (owners.length === 1 && owners[0].path === targetPath) {
          return { workspaceId: owners[0].id, path: targetPath, selection: 'source-membership' };
        }
      }
      return matches.length === 1
        ? { workspaceId: matches[0].id, path: targetPath, selection: 'target-directory' }
        : { path: targetPath, selection: 'new-directory' };
    },
    async ensure(plan, { signal } = {}) {
      check(signal);
      let workspace;
      if (plan.workspaceId !== undefined) workspace = exact(plan.workspaceId);
      else {
        // Recheck after planning: another actor may have registered this path.
        workspace = matching(plan.path);
        if (!workspace) workspace = validate(await registry().create(plan.path));
      }
      // Do not throw on late cancellation before returning the identity: the
      // caller must first persist any registration performed by create().
      if (workspace.path !== plan.path) throw fail('WORKSPACE_CWD_MISMATCH', 'Workspace registration resolved to a different directory.');
      return { workspaceId: workspace.id, path: workspace.path, selection: plan.selection };
    },
    async attach({ workspaceId, path }, sessionId, { signal } = {}) {
      check(signal);
      const workspace = exact(workspaceId);
      if (workspace.path !== path) throw fail('WORKSPACE_CWD_MISMATCH', 'Workspace directory changed before attachment.');
      const owners = all().filter(item => item.sessionIds.includes(sessionId));
      if (owners.some(owner => owner.id !== workspaceId)) throw fail('WORKSPACE_MEMBERSHIP_CONFLICT', 'The new session already belongs to another workspace.');
      if (!workspace.sessionIds.includes(sessionId)) await workspace.attachSession(sessionId);
      // Read back even if cancellation arrived after the mutation. The caller
      // records the stage/identity before deciding whether to continue.
      const current = exact(workspaceId);
      const after = all().filter(item => item.sessionIds.includes(sessionId));
      if (current.path !== path || after.length !== 1 || after[0].id !== workspaceId) {
        throw fail('WORKSPACE_ATTACH_FAILED', 'Host did not confirm unique membership in the selected workspace.');
      }
      return { workspaceId, path };
    },
    verify({ workspaceId, path }, sessionId) {
      const current = exact(workspaceId);
      const owners = all().filter(item => item.sessionIds.includes(sessionId));
      if (current.path !== path || owners.length !== 1 || owners[0].id !== workspaceId) {
        throw fail('WORKSPACE_ATTACH_FAILED', 'The created session lost its expected workspace membership.');
      }
    },
  };
}
