import { raceMetadata } from './async-control.js';

const NAME = 'send_message';
const service = (ctx, key) => typeof ctx?.get === 'function' ? ctx.get(key) : ctx?.[key];
const fail = (code, message) => Object.assign(new Error(message), { code });
const boundedText = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const abort = signal => { if (signal?.aborted) throw fail('ABORTED', 'Communication policy inspection was cancelled.'); };

function schemaKind(tool) {
  const parameters = tool?.parameters;
  if (!parameters || typeof parameters !== 'object') return 'unknown';
  // defineTool uses a flat parameter map; projected JSON schemas use properties.
  const fields = parameters.type === 'object' && parameters.properties ? parameters.properties : parameters;
  const required = key => fields[key]?.type === 'string' && (fields[key].required === true || parameters.required?.includes?.(key) === true);
  if (!required('message')) return 'unknown';
  const team = required('target');
  const adjacent = required('agent_id');
  if (team && !adjacent && !Object.hasOwn(fields, 'agent_id')) return 'team-target';
  if (adjacent && !team && !Object.hasOwn(fields, 'target')) return 'adjacent-agent-id';
  return 'unknown';
}

/**
 * Read-only routing advice, never an admission probe or a dispatcher.
 * Scoped get/resolveExecution respects shadowing and PTC, but does NOT run any
 * tool policy, permission guard, lifecycle gate, or custom local Host patch.
 * Native candidates must still be admitted by the actual Host invocation.
 */
export function createCommunicationPolicy(ctx, options = {}) {
  const timeoutMs = options.metadataTimeoutMs ?? 15000;
  return {
    async inspect({ agent, targetId, self, target, signal } = {}) {
      abort(signal);
      const agents = service(ctx, 'agents');
      const nativeTool = { name: NAME, visible: false, schemaKind: 'unknown', definitionOrigin: 'not-attested', directCallable: false, sdkCallable: false };
      const output = {
        channel: 'session-link', relation: 'unknown', nativeTool,
        nativeEligibility: 'unknown', recommendedChannel: 'session-link',
        reason: 'NATIVE_CAPABILITY_UNKNOWN', nativeTarget: null,
        admission: 'not-probed', automaticDispatch: false, automaticFallback: false,
        retryPolicy: 'An unknown native delivery may already have arrived. Inspect before any explicit retry; never automatically send through both channels.',
      };
      const finish = (reason, eligibility = 'unknown', channel = 'session-link') => ({ ...output, reason, nativeEligibility: eligibility, recommendedChannel: channel });
      if (typeof agents?.get !== 'function' || !boundedText(agent?.id) || agents.get(agent.id) !== agent || !agent.session || !['idle', 'running'].includes(agent.status)) return finish('CALLER_NOT_LIVE', 'unavailable', 'none');
      if (!boundedText(targetId)) return finish('TARGET_ID_INVALID', 'unavailable', 'none');
      const targetAgent = agents.get(targetId);
      if (!targetAgent || targetAgent.id !== targetId || !targetAgent.session || !['idle', 'running'].includes(targetAgent.status)) return finish('TARGET_NOT_LIVE', 'unavailable', 'none');
      if ((self && self.id !== agent.id) || (target && target.id !== targetId)) return finish('SUMMARY_IDENTITY_MISMATCH', 'unknown', 'none');
      if (self?.live === false || target?.live === false) return finish('SUMMARY_NOT_LIVE', 'unavailable', 'none');
      const archived = service(ctx, 'workspaceRegistry')?.archivedSessionIds;
      if (self?.archived || target?.archived || (Array.isArray(archived) && (archived.includes(agent.id) || archived.includes(targetId)))) return finish('SESSION_ARCHIVED', 'unavailable', 'none');
      if (agent.id === targetId) { output.relation = 'self'; return finish('SELF_SEND_NOT_SUPPORTED', 'unavailable', 'none'); }
      const linkChannel = target?.canReceive === false ? 'none' : 'session-link';
      const read = operation => raceMetadata(operation, { signal, timeoutMs });
      const stillLive = () => agents.get(agent.id) === agent && agents.get(targetId) === targetAgent && ['idle', 'running'].includes(agent.status) && ['idle', 'running'].includes(targetAgent.status);
      const stopped = cause => {
        abort(signal);
        if (cause?.code === 'ABORTED') throw cause;
      };

      const tools = service(ctx, 'tools');
      let visible;
      let resolutionUnknown = false;
      let brandedAdjacent = false;
      function toolView() {
        if (typeof tools?.get !== 'function') { resolutionUnknown = true; return; }
        visible = tools.get(NAME, agent);
        nativeTool.visible = Boolean(visible);
        nativeTool.schemaKind = schemaKind(visible);
        if (!visible) return;
        if (typeof tools.resolveExecution !== 'function') { resolutionUnknown = true; return; }
        const direct = tools.resolveExecution(NAME, agent, false);
        const nested = tools.resolveExecution(NAME, agent, true);
        nativeTool.directCallable = direct === visible;
        nativeTool.sdkCallable = nested === visible;
        if ((direct !== undefined && direct !== visible) || (nested !== undefined && nested !== visible)) resolutionUnknown = true;
        if (nativeTool.schemaKind === 'adjacent-agent-id' && typeof options.isAdjacentAgentSendMessageTool === 'function') {
          brandedAdjacent = options.isAdjacentAgentSendMessageTool(visible) === true;
          if (brandedAdjacent) nativeTool.definitionOrigin = 'injected-adjacent-brand';
        }
      }
      try { toolView(); } catch (cause) { stopped(cause); resolutionUnknown = true; }

      // A Sidechat is an independent plugin scope, even when its persisted
      // header carries parentSession. Never infer native adjacency from that.
      if (self?.kind === 'sidechat' || target?.kind === 'sidechat') {
        output.relation = 'sidechat';
        return finish('SIDECHAT_USES_SESSION_LINK', 'unavailable', linkChannel);
      }

      let sameTeam = false;
      let teamTarget;
      let teamUnknown = false;
      const teams = service(ctx, 'agentTeams');
      if (typeof teams?.tryMembership === 'function') {
        try {
          const callerMembership = await read(() => teams.tryMembership(agent));
          const targetMembership = await read(() => teams.tryMembership(targetAgent));
          if (!stillLive()) return finish('LIVE_IDENTITY_CHANGED', 'unavailable', 'none');
          sameTeam = Boolean(callerMembership && targetMembership && boundedText(callerMembership.id) && callerMembership.id === targetMembership.id && callerMembership.root === targetMembership.root && boundedText(callerMembership.root?.id) && agents.get(callerMembership.root.id) === callerMembership.root);
          if (sameTeam) {
            output.relation = 'same-team';
            if (typeof teams.listMembers !== 'function') teamUnknown = true;
            else {
              const rows = await read(() => teams.listMembers(agent));
              if (!Array.isArray(rows) || rows.length > 1000) teamUnknown = true;
              else {
                const matches = rows.filter(row => row?.id === targetId);
                if (matches.length === 1 && ['running', 'inactive'].includes(matches[0].status) && boundedText(matches[0].name) && matches[0].name === targetMembership.name && rows.filter(row => row?.name === matches[0].name).length === 1) teamTarget = { target: matches[0].name };
                else teamUnknown = true;
              }
            }
          }
        } catch (cause) { stopped(cause); teamUnknown = true; }
      }
      if (!stillLive()) return finish('LIVE_IDENTITY_CHANGED', 'unavailable', 'none');

      const callerParent = agent.session.header?.parentSession;
      const targetParent = targetAgent.session.header?.parentSession;
      const child = targetParent === agent.id ? targetAgent : callerParent === targetId ? agent : undefined;
      const parent = child === targetAgent ? agent : child === agent ? targetAgent : undefined;
      let adjacency;
      // Exact Team membership + roster mapping takes precedence over adjacent
      // child heuristics. A future Team runtime root need not be a managed child.
      if (child && !(sameTeam && nativeTool.schemaKind === 'team-target')) {
        const direction = child === targetAgent ? 'direct-child' : 'direct-parent';
        if (!sameTeam) output.relation = direction;
        // Runtime-root exclusion independently catches seeded Sidechats/forks.
        let roots;
        try { roots = typeof agents.roots === 'function' ? agents.roots() : undefined; }
        catch (cause) { stopped(cause); }
        if (!Array.isArray(roots)) adjacency = 'unknown';
        else if (roots.includes(child)) adjacency = 'runtime-root';
        else if (child.session.header?.origin !== 'subagent') adjacency = 'unknown';
        else if (nativeTool.schemaKind === 'adjacent-agent-id' && brandedAdjacent) {
          try {
            const projections = service(ctx, 'sessionProjections');
            const query = service(ctx, 'sessionQuery');
            const identity = typeof projections?.stateOf === 'function' ? projections.stateOf(child.session, 'subagent')?.identity : undefined;
            if (Number.isSafeInteger(identity?.seq) && identity.seq >= 0 && typeof child.session.isOwnSeq === 'function' && typeof query?.readEvent === 'function') {
              if (!child.session.isOwnSeq(identity.seq)) adjacency = 'inherited';
              else {
                const window = await read(innerSignal => query.readEvent({ sessionId: child.id, seq: identity.seq, before: 0, after: 0 }, innerSignal));
                const event = window?.target;
                if (!Number.isSafeInteger(window?.inheritedEventCount) || identity.seq < window.inheritedEventCount || event?.seq !== identity.seq || event.type !== 'subagent/descriptor' || event.data?.version !== 3) adjacency = 'unknown';
                else if (event.data.provider === 'sidechat') adjacency = 'sidechat';
                else if (event.data.mode === 'one-shot') adjacency = 'one-shot';
                else if (event.data.mode === 'continuable' && boundedText(event.data.provider)) adjacency = 'verified';
                else adjacency = 'unknown';
              }
            } else {
              // Public direct-child catalog is an alternative source of bounded
              // identity facts; no private manager/resident state is inspected.
              const subagents = service(ctx, 'subagents');
              if (typeof subagents?.listChildren !== 'function') adjacency = 'unknown';
              else {
                const rows = await read(innerSignal => subagents.listChildren(parent.id, innerSignal));
                if (!Array.isArray(rows) || rows.length > 1000) adjacency = 'unknown';
                else {
                  const matches = rows.filter(row => row?.id === child.id);
                  if (matches.length !== 1) adjacency = 'unknown';
                  else if (matches[0].provider === 'sidechat') adjacency = 'sidechat';
                  else if (matches[0].mode === 'one-shot') adjacency = 'one-shot';
                  else adjacency = matches[0].mode === 'continuable' && boundedText(matches[0].provider) ? 'verified' : 'unknown';
                }
              }
            }
          } catch (cause) { stopped(cause); adjacency = 'unknown'; }
        } else adjacency = 'unknown';
      } else if (!sameTeam) output.relation = boundedText(callerParent) && callerParent === targetParent ? 'siblings' : 'cross-tree';

      if (!stillLive()) return finish('LIVE_IDENTITY_CHANGED', 'unavailable', 'none');
      abort(signal);
      // Recheck the scoped definition after asynchronous metadata reads. A
      // same-named shadow must never inherit another tool's candidate advice.
      try {
        if (visible && (tools.get(NAME, agent) !== visible || (nativeTool.directCallable && tools.resolveExecution(NAME, agent, false) !== visible) || (nativeTool.sdkCallable && tools.resolveExecution(NAME, agent, true) !== visible))) return finish('NATIVE_TOOL_CHANGED', 'unknown', linkChannel);
      } catch (cause) { stopped(cause); return finish('NATIVE_TOOL_CHANGED', 'unknown', linkChannel); }
      if (adjacency === 'sidechat' || adjacency === 'runtime-root') {
        if (adjacency === 'sidechat') output.relation = 'sidechat';
        return finish('NON_MANAGED_ROOT_USES_SESSION_LINK', 'unavailable', linkChannel);
      }
      if (resolutionUnknown) return finish('NATIVE_RESOLUTION_UNKNOWN', 'unknown', linkChannel);
      if (!nativeTool.visible) return finish('NATIVE_TOOL_NOT_VISIBLE', 'unavailable', linkChannel);
      if (!nativeTool.directCallable && !nativeTool.sdkCallable) return finish('NATIVE_TOOL_NOT_CALLABLE', 'unavailable', linkChannel);
      if (sameTeam && nativeTool.schemaKind === 'team-target') {
        if (teamUnknown || !teamTarget) return finish('TEAM_TARGET_MAPPING_UNKNOWN', 'unknown', linkChannel);
        output.nativeTarget = teamTarget;
        return finish('SAME_TEAM_NATIVE_CANDIDATE_HOST_ADMISSION_REQUIRED', 'candidate', 'native-if-host-admits');
      }
      if (child && nativeTool.schemaKind === 'adjacent-agent-id') {
        if (!brandedAdjacent) return finish('ADJACENT_TOOL_BRAND_UNVERIFIED', 'unknown', linkChannel);
        if (adjacency === 'one-shot' || adjacency === 'inherited') return finish('CHILD_NOT_NATIVE_CONTINUABLE', 'unavailable', linkChannel);
        if (adjacency !== 'verified') return finish('ADJACENCY_EVIDENCE_UNKNOWN', 'unknown', linkChannel);
        output.relation = child === targetAgent ? 'direct-child' : 'direct-parent';
        output.nativeTarget = { agent_id: targetId };
        return finish('ADJACENT_NATIVE_CANDIDATE_HOST_ADMISSION_REQUIRED', 'candidate', 'native-if-host-admits');
      }
      return finish(teamUnknown ? 'TEAM_MEMBERSHIP_UNKNOWN' : 'NO_MATCHING_NATIVE_ROUTE', teamUnknown ? 'unknown' : 'unavailable', linkChannel);
    },
  };
}
