import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import Schema from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createStore } from './lib/store.js';
import { createService } from './lib/service.js';
import { createHostAdapter } from './lib/host-adapter.js';
import { TOOLS, concurrencySafe } from './lib/tool-schema.js';
import { createSessionCreator } from './lib/session-create.js';
import { createResultDelivery } from './lib/result-delivery.js';
import { createRelations } from './lib/relations.js';
import { mountPanelRoute } from './lib/panel-route.js';
import { withSessionReferences } from './lib/session-refs.js';
import { createCommunicationPolicy } from './lib/communication-policy.js';
import { createSessionArchiver } from './lib/session-archive.js';
import { mountArchiveRoute } from './lib/archive-route.js';
import { archiveDetails } from './lib/archive-public.js';

export const name = 'dsh-session-link';
export const inject = ['tools', 'agents', 'sessionQuery'];

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('Enable peer messaging, tasks and activity tools for this host.'),
  sameDirectoryOnly: Schema.boolean().default(false).description('Restrict all peer reads and writes to the caller working directory.'),
  maxMessageChars: Schema.number().min(256).max(8000).step(1).default(8000),
  maxMessagesPerMinute: Schema.number().min(1).max(60).step(1).default(12).description('Combined traffic per unordered pair, not per direction.'),
  maxHops: Schema.number().min(1).max(16).step(1).default(8),
  recentDeliveries: Schema.number().min(50).max(10000).step(1).default(1000),
  maxTasks: Schema.number().min(10).max(2000).step(1).default(500),
});

export function dataDirectory(env = process.env) {
  const profile = (env.DSH_PROFILE || 'default').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 100);
  const root = env.DSH_PROFILE_DIR || join(env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', profile);
  return resolve(root, 'data', 'session-link');
}

/** Exported for isolated mount tests. No endpoints, timers or transcript subscriptions. */
export async function mount(ctx, config = {}, options = {}) {
  if (config.enabled === false) return { close: async () => {}, toolNames: [] };
  const lifetime = new AbortController();
  const store = await (options.createStore || createStore)(options.directory || dataDirectory());
  let service;
  let host;
  let sessionCreator;
  let resultDelivery;
  let sessionArchiver;
  let panel;
  let archiveRoute;
  const jobs = new Set();
  const removes = [];
  let closing = false;
  let closePromise;
  const close = () => closePromise ||= (async () => {
    closing = true;
    lifetime.abort(new Error('Session Link is unloading.'));
    const routeCloseErrors = [];
    for (const route of [archiveRoute, panel]) { try { await route?.close(); } catch (error) { routeCloseErrors.push(error); } }
    for (const remove of removes.reverse()) { try { await remove(); } catch { /* continue draining */ } }
    await Promise.allSettled([...jobs]);
    if (service) await service.close();
    else {
      try { await sessionCreator?.close?.(); }
      finally { try { await resultDelivery?.close?.(); } finally { try { await sessionArchiver?.close?.(); } finally { try { await store.close(); } finally { await host?.close?.(); } } } }
    }
    if (routeCloseErrors.length) throw new AggregateError(routeCloseErrors, 'Session Link route cleanup failed after draining shared resources.');
  })();
  try {
    // The official host carrier is an INTERNAL export. Pin its verified version,
    // and disable managed-child delivery rather than guessing on a future host.
    let subagentVersion;
    let childDelivery = {};
    let isAdjacentAgentSendMessageTool;
    try {
      subagentVersion = createRequire(import.meta.url)('@deepseek-ai/dsh-subagent/package.json').version;
      if (subagentVersion === '0.2.1-rc.5') {
        const carrier = await import('@deepseek-ai/dsh-subagent/internal');
        childDelivery = { queueHostSubagentPrompt: carrier.queueHostSubagentPrompt, steerHostSubagentPrompt: carrier.steerHostSubagentPrompt };
        isAdjacentAgentSendMessageTool = carrier.isAdjacentAgentSendMessageTool;
      }
    } catch { /* Ordinary and sidechat delivery can still work without a child carrier. */ }
    host = (options.createHostAdapter || createHostAdapter)(ctx, { createUserMessage, subagentVersion, ...childDelivery });
    let controllerVersion;
    try { controllerVersion = createRequire(import.meta.url)('@deepseek-ai/dsh-api-session-controller/package.json').version; } catch { /* creation will fail closed */ }
    sessionCreator = (options.createSessionCreator || createSessionCreator)({ ctx, store, createUserMessage, controllerVersion, config });
    resultDelivery = (options.createResultDelivery || createResultDelivery)({ ctx, store, createUserMessage, config });
    sessionArchiver = (options.createSessionArchiver || createSessionArchiver)({ ctx, store, config });
    const communicationPolicy = (options.createCommunicationPolicy || createCommunicationPolicy)(ctx, { isAdjacentAgentSendMessageTool, subagentVersion });
    service = (options.createService || createService)({ host, store, sessionCreator, resultDelivery, sessionArchiver, communicationPolicy, config });
    const connection = typeof ctx.get === 'function' ? ctx.get('connection') : ctx.connection;
    if (typeof connection?.fetch?.register === 'function') {
      const workspaces = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : ctx.workspaceRegistry;
      const relations = createRelations({ host, store, workspaces, config });
      try { panel = mountPanelRoute(ctx, { relations }); }
      catch (error) { await relations.close(); throw error; }
      if (typeof sessionArchiver.planForOwner === 'function' && typeof sessionArchiver.commitForOwner === 'function' && typeof service.commitArchiveForOwner === 'function') archiveRoute = mountArchiveRoute(ctx, { archiver: {
        planForOwner: (args, options) => sessionArchiver.planForOwner(args, options),
        commitForOwner: (args, options) => service.commitArchiveForOwner(args, options),
      } });
    }
    for (const tool of TOOLS) {
      const remove = ctx.tools.register({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        // Deliberately non-deferred: a sidechat/subagent must see tools on its first turn.
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        timeoutMs: tool.timeoutMs ?? 30000,
        isConcurrencySafe: args => concurrencySafe(tool.name, args),
        execute(args, exec) {
          if (closing) throw Object.assign(new Error('Session Link is unloading.'), { code: 'CLOSED' });
          const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout((tool.timeoutMs ?? 30000) - 1000), ...(exec.signal ? [exec.signal] : [])]);
          const job = Promise.resolve().then(() => service.execute(tool.name, args, { ...exec, signal }));
          jobs.add(job);
          // Drain the original job (not a wrapped success) on unload; keep failures observable.
          job.finally(() => jobs.delete(job)).catch(() => {});
          return job.then(value => ({ ok: true, ...withSessionReferences(value) }), error => ({
            ok: false,
            error: {
              code: typeof error?.code === 'string' ? error.code : signal.aborted ? 'ABORTED' : 'INTERNAL_ERROR',
              message: String(error?.message || 'Session Link failed.').slice(0, 2000),
              ...Object.fromEntries(['deliveryId', 'taskId', 'transport', 'sessionId', 'requestedSessionId', 'workspaceId', 'targetId', 'stage', 'state', 'localState', 'archiveState', 'activitySummary', 'hostCode'].filter(key => typeof error?.[key] === 'string').map(key => [key, error[key].slice(0, key === 'activitySummary' ? 4000 : 256)])),
              ...archiveDetails(error),
              ...(Number.isSafeInteger(error?.currentRevision) ? { currentRevision: error.currentRevision } : {}),
              ...Object.fromEntries(['replayed', 'partial', 'remoteAttempted', 'archived', 'stopActivityRequested', 'readback'].filter(key => typeof error?.[key] === 'boolean').map(key => [key, error[key]])),
            },
          }));
        },
      });
      if (typeof remove !== 'function') throw new Error('Host tools.register did not return a disposer.');
      removes.push(remove);
    }
    return { close, toolNames: TOOLS.map(tool => tool.name) };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function apply(ctx, config) {
  const runtime = await mount(ctx, config);
  ctx.effect(() => () => runtime.close(), 'session-link: tools and store');
}
