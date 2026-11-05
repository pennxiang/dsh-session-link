window.__ModuleLoader__.load({
  id: 'dsh-session-link',
  factory(require) {
    const React = require('react');
    const { writeClipboard, MarkdownText } = require('@deepseek-ai/dsh-client-ui-primitives');
    const { useState, useEffect, useMemo, useRef } = React;
    const h = React.createElement;
    const ID = 'dsh-session-link/relations';
    const STORAGE = 'dsh.session-link.collapsed.v1';
    const LIMIT = 200;
    const PERIOD = 60000;
    const css = `
.sl-panel{height:100%;min-height:0;overflow:auto;container-type:inline-size;color:var(--dsw-alias-label-primary);font:13px/1.5 var(--dsw-font-family,inherit)}
.sl-panel *{box-sizing:border-box}.sl-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 12px 4px}.sl-heading{font-size:13px;font-weight:500;margin:0}.sl-note{margin:4px 12px 12px;color:var(--dsw-alias-label-tertiary);font-size:12px}.sl-message{margin:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}.sl-error{color:var(--dsw-alias-state-error-primary)}
.sl-btn{appearance:none;border:0;background:none;color:inherit;font:inherit;border-radius:var(--dsw-radius-sm);padding:4px 6px;cursor:pointer}.sl-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.sl-btn:disabled{cursor:default;color:var(--dsw-alias-label-tertiary)}.sl-btn:focus-visible,.sl-node:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.sl-tree,.sl-group{list-style:none;padding:0;margin:0}.sl-tree{padding:0 8px 12px}.sl-item{position:relative;min-width:0}.sl-group{margin-left:12px;padding-left:14px}.sl-group>.sl-item:before{content:'';position:absolute;left:-12px;top:0;bottom:0;border-left:1px solid var(--dsw-alias-border-l4);pointer-events:none}.sl-group>.sl-item:last-child:before{bottom:auto;height:19px;width:9px;border-bottom:1px solid var(--dsw-alias-border-l4);border-bottom-left-radius:7px}
.sl-node{display:flex;align-items:center;gap:4px;min-width:0;min-height:38px;padding:3px 4px;border-radius:var(--dsw-radius-md)}.sl-node:hover{background:var(--dsw-alias-interactive-bg-hover)}.sl-item[aria-selected=true]>.sl-node{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.sl-item:focus-visible{outline:0}.sl-item:focus-visible>.sl-node{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}.sl-toggle{flex:0 0 22px;width:22px;padding:3px 0}.sl-spacer{width:22px;flex:0 0 22px}.sl-title{display:block;min-width:0;flex:1;padding:3px 2px;text-align:left;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.sl-meta{display:flex;align-items:center;gap:4px;flex-shrink:0;color:var(--dsw-alias-label-secondary);font-size:11px}.sl-state{white-space:nowrap}.sl-task{display:block;color:var(--dsw-alias-label-tertiary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:96px}.sl-copy{flex:0 0 24px;width:24px;padding:3px 0;color:var(--dsw-alias-label-secondary)}.sl-kind{font-size:11px;color:var(--dsw-alias-label-tertiary);margin:0 12px 6px}.sl-footer{border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px}
.sl-tool{min-width:0;color:var(--dsw-alias-label-secondary);font:13px/1.5 var(--dsw-font-family,inherit);padding:4px 0}.sl-tool summary{cursor:pointer;overflow-wrap:anywhere}.sl-tool pre{margin:8px 0;max-height:280px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 var(--ds-font-family-code,ui-monospace,monospace);color:inherit}.sl-tool-links{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0}.sl-tool-ref{display:inline-flex;max-width:100%;min-width:0;align-items:center;--sl-link-blue:var(--dsw-static-blue-600);color:var(--sl-link-blue);background:color-mix(in srgb,var(--sl-link-blue) 12%,transparent);border-radius:var(--dsw-radius-md)}.sl-tool-ref>.sl-title{max-width:260px;padding:3px 8px;color:inherit}.sl-tool-ref>.sl-title:hover:not(:disabled){background:color-mix(in srgb,var(--sl-link-blue) 12%,transparent)}.sl-tool .sl-message{margin:4px 0}.sl-tool .sl-btn{font:inherit}.sl-result{padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg)}.sl-result-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}.sl-result-badge{font-size:11px;color:var(--dsw-alias-label-tertiary)}.sl-result-body{min-width:0;overflow-wrap:anywhere;user-select:text}
[data-ds-dark-theme] .sl-tool-ref{--sl-link-blue:var(--dsw-static-blue-300)}
@container (max-width:250px){.sl-meta{font-size:10px}.sl-task{max-width:60px}.sl-group{margin-left:6px;padding-left:12px}.sl-node{gap:2px}.sl-toggle,.sl-spacer{width:18px;flex-basis:18px}}
`;
    const stateHelp = {
      running: '正在运行', idle: '空闲；不代表任务已完成',
      offline: '不在线；仅有持久记录', archived: '已归档；请先在会话列表恢复'
    };
    function readCollapsed() {
      try {
        const value = JSON.parse(localStorage.getItem(STORAGE) || '[]');
        return new Set(Array.isArray(value) ? value.filter(x => typeof x === 'string' && x.length <= 1024).slice(-LIMIT) : []);
      } catch { return new Set(); }
    }
    function saveCollapsed(value) {
      try { localStorage.setItem(STORAGE, JSON.stringify([...value].slice(-LIMIT))); } catch { /* Browser storage is optional. */ }
    }
    // The view's directed creation edges are a display tree, not native Session lineage.
    // A corrupt/repeated edge or a cycle cannot duplicate rows or recurse forever.
    function forest(value) {
      const map = new Map();
      for (const node of [value?.self, ...(Array.isArray(value?.nodes) ? value.nodes : [])]) {
        if (!node || typeof node.id !== 'string' || !node.id || map.has(node.id)) continue;
        map.set(node.id, { ...node, children: [], parent: null });
        if (map.size === 500) break;
      }
      for (const edge of Array.isArray(value?.edges) ? value.edges : []) {
        if (edge.kind !== 'created-session') continue;
        const source = map.get(edge.sourceId), target = map.get(edge.targetId);
        if (!source || !target || target.parent || source === target) continue;
        let ancestor = source;
        while (ancestor && ancestor !== target) ancestor = ancestor.parent;
        if (ancestor) continue;
        target.parent = source;
        source.children.push(target);
      }
      return [...map.values()].filter(node => !node.parent);
    }
    async function call(action, body, signal) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const abort = () => { clearTimeout(timeout); controller.abort(); };
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      try {
        const response = await fetch('/api/session-link/view', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, ...body }), signal: controller.signal
        });
        const envelope = await response.json();
        if (!response.ok || envelope?.ok !== true) throw new Error(envelope?.error?.message || `HTTP ${response.status}`);
        return envelope.value;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
      }
    }
    // One root metadata source. Native Workspace owns row rendering, selection and collapse.
    // Bounds apply to the complete published source, never to individual Session rows.
    function createWorkspaceRelations(list) {
      const MAX_WORKSPACES = 100, MAX_EDGES = 1000, MAX_MEMBERS = 50000;
      const listeners = new Set();
      let snapshot = Object.freeze({ schemaVersion: 1, edges: Object.freeze([]), truncated: false, loading: false });
      let disposed = false, interval = null, unsubscribe = null, request = null, currentPlan = null;
      const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\u0000-\u001f\u007f]/.test(id);
      const active = () => !disposed && listeners.size > 0 && document.visibilityState !== 'hidden';
      const publish = (edges, truncated, loading) => {
        if (snapshot.truncated === truncated && snapshot.loading === loading && snapshot.edges.length === edges.length
            && snapshot.edges.every((edge, i) => edge.workspaceId === edges[i].workspaceId && edge.sourceId === edges[i].sourceId && edge.targetId === edges[i].targetId)) return;
        snapshot = Object.freeze({ schemaVersion: 1, edges: Object.freeze(edges.map(edge => Object.freeze(edge))), truncated, loading });
        for (const notify of [...listeners]) {
          try { notify(); } catch (error) { console.error('Session Link relation subscriber failed', error); }
        }
      };
      const plan = () => {
        const state = list.getSnapshot();
        // Pending/reconnecting/error lists do not establish complete current membership.
        if (state?.phase !== 'ready' || state.state !== 'idle' || !Array.isArray(state.items)) {
          return { key: `unavailable:${state?.phase}:${state?.state}`, workspaces: [], truncated: true, pending: state?.state === 'loading' };
        }
        const workspaces = new Map(), duplicate = new Set();
        let truncated = state.items.length > MAX_WORKSPACES, members = 0;
        for (const item of state.items.slice(0, MAX_WORKSPACES)) {
          if (!validId(item?.workspaceId) || !Array.isArray(item.sessionIds) || members + item.sessionIds.length > MAX_MEMBERS) { truncated = true; continue; }
          if (workspaces.has(item.workspaceId) || duplicate.has(item.workspaceId)) {
            workspaces.delete(item.workspaceId); duplicate.add(item.workspaceId); truncated = true; continue;
          }
          if (!item.sessionIds.every(validId)) { truncated = true; continue; }
          members += item.sessionIds.length;
          workspaces.set(item.workspaceId, { workspaceId: item.workspaceId, members: new Set(item.sessionIds) });
        }
        const rows = [...workspaces.values()].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
        // Membership, not titles/pin order/runtime state, invalidates the metadata read.
        return { key: JSON.stringify([truncated, rows.map(row => [row.workspaceId, [...row.members].sort()])]), workspaces: rows, truncated, pending: false };
      };
      const abort = () => { request?.abort(); request = null; };
      const refresh = async () => {
        if (!active() || request || !currentPlan || currentPlan.pending) return;
        const captured = currentPlan, controller = new AbortController(); request = controller;
        const results = new Map(); let cursor = 0, used = 0, truncated = captured.truncated;
        publish(snapshot.edges, truncated, captured.workspaces.length > 0);
        const worker = async () => {
          while (active() && !controller.signal.aborted && cursor < captured.workspaces.length) {
            if (used >= MAX_EDGES) { truncated = true; return; }
            const row = captured.workspaces[cursor++];
            try {
              const value = await call('workspace-relations', { workspaceId: row.workspaceId }, controller.signal);
              if (!active() || controller.signal.aborted) return;
              if (value?.schemaVersion !== 1 || value.workspaceId !== row.workspaceId || !Array.isArray(value.edges)
                  || value.edges.length > MAX_EDGES || typeof value.truncated !== 'boolean') { truncated = true; continue; }
              truncated ||= value.truncated;
              const accepted = [], seen = new Set();
              for (const edge of value.edges) {
                if (edge?.kind !== 'created-session' || !validId(edge.sourceId) || !validId(edge.targetId) || edge.sourceId === edge.targetId
                    || (edge.workspaceId !== undefined && edge.workspaceId !== row.workspaceId)
                    || !row.members.has(edge.sourceId) || !row.members.has(edge.targetId)) { truncated = true; continue; }
                const key = JSON.stringify([edge.sourceId, edge.targetId]);
                if (seen.has(key)) continue;
                seen.add(key);
                if (used === MAX_EDGES) { truncated = true; continue; }
                accepted.push({ workspaceId: row.workspaceId, sourceId: edge.sourceId, targetId: edge.targetId, kind: 'created-session' }); used++;
              }
              results.set(row.workspaceId, accepted);
            } catch (error) {
              // Unavailable/denied reads never retain potentially stale native-tree edges.
              if (!controller.signal.aborted) truncated = true;
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(4, captured.workspaces.length) }, worker));
        if (active() && !controller.signal.aborted && request === controller) {
          // Controller notifications may be microtask-batched; commit against the current snapshot too.
          if (plan().key !== captured.key) { reconcile(); return; }
          request = null;
          publish(captured.workspaces.flatMap(row => results.get(row.workspaceId) || []), truncated, false);
        }
      };
      const reconcile = () => {
        if (!active()) return;
        const next = plan();
        if (currentPlan?.key === next.key) return;
        abort(); currentPlan = next;
        publish([], next.truncated, next.pending);
        void refresh();
      };
      const stop = () => {
        abort(); currentPlan = null;
        if (interval !== null) clearInterval(interval);
        interval = null; unsubscribe?.(); unsubscribe = null;
      };
      const visibility = () => {
        stop();
        if (!active()) { publish([], listeners.size > 0, false); return; }
        unsubscribe = list.subscribe(reconcile);
        reconcile();
        if (active()) interval = setInterval(() => { reconcile(); void refresh(); }, PERIOD);
      };
      const source = {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          if (disposed) return () => {};
          const notify = () => listener(); listeners.add(notify);
          if (listeners.size === 1) { document.addEventListener('visibilitychange', visibility); visibility(); }
          let subscribed = true;
          return () => {
            if (!subscribed) return;
            subscribed = false; listeners.delete(notify);
            if (!listeners.size) { document.removeEventListener('visibilitychange', visibility); stop(); publish([], false, false); }
          };
        }
      };
      return {
        source,
        dispose() {
          if (disposed) return;
          disposed = true; listeners.clear();
          document.removeEventListener('visibilitychange', visibility); stop(); publish([], false, false);
        }
      };
    }
    const validRefId = id => typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\u0000-\u001f\u007f]/.test(id);
    const titleFor = (title, id) => typeof title === 'string' && title.trim() && title.trim() !== id
      && title.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(title) ? title.trim() : null;
    // Users choose the scope; exact members come from the owner-admitted server plan, never the visible tree.
    function createSessionArchiveProvider() {
      const plans = new Map(), readers = new Set();
      let disposed = false;
      const invalid = () => { throw new Error('归档计划或结果无效；未自动重试。'); };
      const id = value => validRefId(value) && value.trim() === value;
      const count = value => Number.isSafeInteger(value) && value >= 0;
      const scope = value => value === 'single' || value === 'related';
      const requestId = kind => `ui-archive-${kind}:${crypto.randomUUID()}`;
      const label = value => typeof value === 'string' && value.trim() && value.length <= 4096 ? value.trim() : undefined;
      const post = async (action, input, signal) => {
        const response = await fetch('/api/session-link/archive', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...input }), ...(signal ? { signal } : {}) });
        const envelope = await response.json();
        if (!response.ok || envelope?.ok !== true) throw Object.assign(new Error(envelope?.error?.message || '归档请求失败；请检查状态，不要自动重试。'), { code: envelope?.error?.code, outcome: envelope?.error?.outcome, detail: envelope?.error });
        return envelope.value;
      };
      const readOutcome = (value, binding) => {
        if (!value || value.archiveScope !== binding.plan.archiveScope || !['succeeded', 'partial', 'unknown', 'failed'].includes(value.archiveState) || typeof value.stopActivityRequested !== 'boolean' || value.stopActivityRequested !== binding.stopActivity) return invalid();
        const members = binding.members;
        const list = values => {
          if (!Array.isArray(values) || values.length > 1000 || !values.every(value => id(value) && members.has(value)) || new Set(values).size !== values.length) return invalid();
          return Object.freeze([...values]);
        };
        if (!Array.isArray(value.failed) || value.failed.length > 1000 || !value.failed.every(item => id(item?.id) && members.has(item.id) && ['failed', 'unknown'].includes(item.state))) return invalid();
        const archivedIds = list(value.archivedIds), remaining = list(value.remaining), pending = new Set(remaining);
        if (archivedIds.length + remaining.length !== members.size || archivedIds.some(value => pending.has(value)) || new Set(value.failed.map(item => item.id)).size !== value.failed.length || value.failed.some(item => !pending.has(item.id)) || (value.archiveState === 'succeeded' && (remaining.length > 0 || value.failed.length > 0))) return invalid();
        return Object.freeze({ archiveScope: value.archiveScope, archiveState: value.archiveState, archivedIds, remaining, failed: Object.freeze(value.failed.map(item => Object.freeze({ id: item.id, state: item.state }))), stopActivityRequested: value.stopActivityRequested });
      };
      const provider = {
        id: 'dsh-session-link', version: 2,
        async prepare(targetId, options) {
          const selected = options?.archiveScope;
          if (disposed || !id(targetId) || (selected !== undefined && !scope(selected))) return invalid();
          const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
          readers.add(controller);
          let value;
          try { value = await post('plan', { targetId, requestId: requestId('plan'), ...(selected !== undefined ? { archiveScope: selected } : {}) }, controller.signal); }
          catch (error) {
            if (error?.code !== 'ARCHIVE_SCOPE_REQUIRED') throw error;
            const detail = error.detail;
            if (disposed || controller.signal.aborted || selected !== undefined || detail?.targetId !== targetId || !Array.isArray(detail.allowedScopes) || detail.allowedScopes.length !== 2 || new Set(detail.allowedScopes).size !== 2 || !detail.allowedScopes.every(scope) || ['planId', 'targets', 'outcome'].some(key => Object.hasOwn(detail, key))) return invalid();
            // A choice is not a plan: no members or commit identity exist before the user's selection.
            return Object.freeze({ kind: 'scope-choice', targetId, allowedScopes: Object.freeze(['single', 'related']) });
          }
          finally { clearTimeout(timer); readers.delete(controller); }
          if (disposed || controller.signal.aborted || value?.targetId !== targetId) return invalid();
          if (value.handled === false && selected === undefined) return undefined;
          if (!scope(selected) || value.archiveScope !== selected || value.handled !== true || !id(value.planId) || !Array.isArray(value.targets) || value.targets.length < (selected === 'related' ? 2 : 1) || value.targets.length > 1000 || (selected === 'single' && value.targets.length !== 1) || value.total !== value.targets.length || typeof value.requiresConfirmation !== 'boolean' || !Array.isArray(value.activity) || value.activity.length > value.total) return invalid();
          const members = new Set(), targets = value.targets.map(item => {
            if (!id(item?.id) || members.has(item.id) || typeof item.alreadyArchived !== 'boolean') return invalid();
            members.add(item.id);
            const title = label(item.title);
            return Object.freeze({ id: item.id, alreadyArchived: item.alreadyArchived, ...(title ? { title } : {}) });
          });
          if (targets.at(-1)?.id !== targetId) return invalid();
          const activeIds = new Set(), activity = value.activity.map(item => {
            if (!id(item?.sessionId) || !members.has(item.sessionId) || activeIds.has(item.sessionId) || !Array.isArray(item.groups) || item.groups.length > 32 || !count(item.totalGroups) || item.totalGroups < item.groups.length) return invalid();
            activeIds.add(item.sessionId);
            const groups = item.groups.map(group => {
              if (typeof group?.kind !== 'string' || !group.kind || group.kind.length > 80 || !Array.isArray(group.items) || group.items.length > 32 || !count(group.totalItems) || group.totalItems < group.items.length) return invalid();
              const items = group.items.map(entry => {
                if (!entry || (entry.id !== null && typeof entry.id !== 'string') || (entry.label !== null && typeof entry.label !== 'string')) return invalid();
                return Object.freeze({ id: entry.id, label: entry.label });
              });
              return Object.freeze({ kind: group.kind, items: Object.freeze(items), totalItems: group.totalItems });
            });
            const title = label(item.title);
            return Object.freeze({ sessionId: item.sessionId, ...(title ? { title } : {}), groups: Object.freeze(groups), totalGroups: item.totalGroups });
          });
          if (activity.some(item => item.totalGroups > 0) && !value.requiresConfirmation) return invalid();
          if (plans.size >= 1000 || plans.has(value.planId)) return invalid();
          const plan = Object.freeze({ planId: value.planId, archiveScope: selected, targetId, targets: Object.freeze(targets), activity: Object.freeze(activity), requiresConfirmation: value.requiresConfirmation, total: value.total });
          plans.set(plan.planId, { plan, members, stopActivity: null });
          return plan;
        },
        async commit(plan, options) {
          const binding = plans.get(plan?.planId);
          if (disposed || !binding || binding.plan !== plan || options?.archiveScope !== plan.archiveScope || typeof options?.stopActivity !== 'boolean' || (plan.requiresConfirmation && options.stopActivity !== true)) return invalid();
          // Scope consent is distinct from activity consent. Native owns the explicit scope/member dialog.
          // Consume before I/O: a concurrent/repeated call cannot resubmit even after an unknown/partial error.
          plans.delete(plan.planId); binding.stopActivity = options.stopActivity;
          // Do not add a client timeout/retry or abort an admitted mutation on plugin unload.
          // The server drains each native side effect and persists uncertain outcomes.
          try { return readOutcome(await post('commit', { planId: plan.planId, archiveScope: plan.archiveScope, requestId: requestId('commit'), stopActivity: binding.stopActivity }), binding); }
          catch (error) { if (error?.outcome) return readOutcome(error.outcome, binding); throw error; }
        }
      };
      return { provider, dispose() { if (disposed) return; disposed = true; for (const controller of readers) controller.abort(); readers.clear(); plans.clear(); } };
    }
    // Public catalog metadata only: observing titles never retains/hydrates a Session generation.
    // All chat seats share one lazy subscription; no per-reference polling or transcript reads.
    function createSessionTitles(getList) {
      const listeners = new Set();
      let snapshot = null, unsubscribe = null, disposed = false, epoch = 0;
      const active = () => !disposed && listeners.size > 0 && document.visibilityState !== 'hidden';
      const publish = value => {
        snapshot = value;
        for (const notify of [...listeners]) notify();
      };
      const stop = () => { epoch++; unsubscribe?.(); unsubscribe = null; };
      const visibility = () => {
        stop();
        if (!active()) { publish(null); return; }
        let list;
        try { list = getList(); } catch { /* Older Hosts may not expose catalog metadata. */ }
        if (typeof list?.getSnapshot !== 'function' || typeof list?.subscribe !== 'function') { publish(null); return; }
        const captured = epoch;
        const refresh = () => {
          if (!active() || epoch !== captured) return;
          try {
            const state = list.getSnapshot();
            publish(state?.phase === 'ready' && state.byId && typeof state.byId === 'object' ? state : null);
          } catch { publish(null); }
        };
        try { unsubscribe = list.subscribe(refresh); refresh(); } catch { stop(); publish(null); }
      };
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          if (disposed) return () => {};
          const notify = () => listener(); listeners.add(notify);
          if (listeners.size === 1) { document.addEventListener('visibilitychange', visibility); visibility(); }
          let subscribed = true;
          return () => {
            if (!subscribed) return;
            subscribed = false; listeners.delete(notify);
            if (!listeners.size) { document.removeEventListener('visibilitychange', visibility); stop(); snapshot = null; }
          };
        },
        dispose() {
          if (disposed) return;
          disposed = true; listeners.clear(); document.removeEventListener('visibilitychange', visibility); stop(); snapshot = null;
        }
      };
    }
    function uriFor(id) {
      let bytes = '';
      for (const byte of new TextEncoder().encode(JSON.stringify(id))) bytes += String.fromCharCode(byte);
      return `dsh-session:${btoa(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
    }
    function toolResult(block) {
      const texts = (Array.isArray(block?.content) ? block.content : []).filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text);
      const raw = texts.join('\n');
      let value = null;
      try { if (raw.length <= 1048576) value = JSON.parse(raw); } catch { /* Legacy or failed tool output remains inspectable. */ }
      const refs = [], ids = new Set();
      for (const ref of Array.isArray(value?.sessionRefs) ? value.sessionRefs : []) {
        if (!validRefId(ref?.id) || ids.has(ref.id) || refs.length >= 200) continue;
        // A persisted label or URI alone never establishes Session identity.
        if (ref.uri !== uriFor(ref.id)) continue;
        ids.add(ref.id); refs.push({ id: ref.id, uri: ref.uri, ...(typeof ref.title === 'string' ? { title: ref.title } : {}) });
      }
      return { raw, value, refs };
    }
    function LinkIcon() {
      return h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', 'aria-hidden': true },
        h('path', { d: 'M10 7H7a4 4 0 0 0 0 8h3m4-8h3a4 4 0 0 1 0 8h-3M8 11h8' }));
    }
    function CopyIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true },
        h('rect', { x: 7, y: 6, width: 9, height: 11, rx: 2 }), h('path', { d: 'M12 6V4a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2' }));
    }
    return {
      inject: ['slots', 'sidebarRightTabs', 'uiWorkspace', 'uiConversation', 'workspaces'],
      apply(ctx) {
        const sessionTitles = createSessionTitles(() => ctx.get('sessions')?.list);
        ctx.effect(() => () => sessionTitles.dispose(), 'session-link: shared catalog title observer');
        function useReferenceTitles(refs) {
          const [, redraw] = useState(0);
          const observing = refs.length > 0;
          useEffect(() => {
            if (!observing) return undefined;
            let mounted = true;
            const release = sessionTitles.subscribe(() => { if (mounted) redraw(value => value + 1); });
            return () => { mounted = false; release(); };
          }, [observing]);
          const state = sessionTitles.getSnapshot();
          return refs.map(ref => {
            const row = state && Object.hasOwn(state.byId, ref.id) ? state.byId[ref.id] : null;
            // Catalog keys AND typed identities must agree; displayTitle may itself be a cwd/id fallback.
            const current = row?.id === ref.id;
            const title = (current ? titleFor(row.title, ref.id) : titleFor(ref.title, ref.id)) || '未命名会话';
            return { ...ref, title };
          });
        }
        ctx.effect(() => {
          // Older Hosts keep the auxiliary tab but do not acquire any source resources.
          if (ctx.uiWorkspace.sessionRelationsVersion !== 1 || typeof ctx.uiWorkspace.registerSessionRelations !== 'function') return undefined;
          const list = ctx.get('workspaces').list;
          const owned = createWorkspaceRelations(list);
          let unregister;
          try { unregister = ctx.uiWorkspace.registerSessionRelations({ id: 'dsh-session-link', version: 1, source: owned.source }); }
          catch (error) { owned.dispose(); throw error; }
          return () => { try { unregister(); } finally { owned.dispose(); } };
        }, 'session-link: native Workspace relation metadata');
        ctx.effect(() => {
          if (ctx.uiWorkspace.sessionArchiveProvidersVersion !== 2 || typeof ctx.uiWorkspace.registerSessionArchiveProvider !== 'function') return undefined;
          const owned = createSessionArchiveProvider();
          let unregister;
          try { unregister = ctx.uiWorkspace.registerSessionArchiveProvider(owned.provider); }
          catch (error) { owned.dispose(); throw error; }
          return () => { try { unregister(); } finally { owned.dispose(); } };
        }, 'session-link: owner-admitted server-planned cascading archive');
        function Panel({ sessionId, useTabInfo }) {
          const { tab } = useTabInfo();
          const [data, setData] = useState(null);
          const [error, setError] = useState('');
          const [loading, setLoading] = useState(false);
          const [notice, setNotice] = useState('');
          const [collapsed, setCollapsed] = useState(readCollapsed);
          const [focused, setFocused] = useState(sessionId);
          const refresh = useRef(() => {});
          const elements = useRef(new Map());
          const opening = useRef(null);
          const live = useRef(false);
          useEffect(() => {
            live.current = true;
            return () => { live.current = false; opening.current?.abort(); };
          }, [sessionId, tab.signal]);
          useEffect(() => {
            setData(null); setError(''); setNotice(''); setFocused(sessionId);
          }, [sessionId]);
          // A retained hidden tab has no timer, listener or pending view read. Display reads never resolve/retain a Session.
          useEffect(() => {
            if (!tab.visible || tab.signal.aborted) return undefined;
            let alive = true, interval = null, request = null;
            const stop = () => {
              if (interval !== null) clearInterval(interval);
              interval = null;
              request?.abort(); request = null;
            };
            const load = async () => {
              if (!alive || document.visibilityState === 'hidden' || request || tab.signal.aborted) return;
              const current = new AbortController(); request = current;
              setLoading(true);
              try {
                const value = await call('relations', { sessionId }, current.signal);
                if (alive && !current.signal.aborted) { setData(value); setError(''); }
              } catch (e) {
                if (alive && !current.signal.aborted) setError(e.message || '关联会话读取失败');
              } finally {
                if (request === current) request = null;
                if (alive) setLoading(false);
              }
            };
            const resume = () => {
              stop();
              if (!alive || document.visibilityState === 'hidden' || tab.signal.aborted) return;
              load(); interval = setInterval(load, PERIOD);
            };
            refresh.current = load;
            document.addEventListener('visibilitychange', resume);
            tab.signal.addEventListener('abort', stop, { once: true });
            resume();
            return () => {
              alive = false; stop(); refresh.current = () => {};
              document.removeEventListener('visibilitychange', resume);
              tab.signal.removeEventListener('abort', stop);
            };
          }, [sessionId, tab.visible, tab.signal]);
          useEffect(() => tab.actions.bindCommands({ refresh: () => refresh.current() }), [tab.actions]);
          const roots = useMemo(() => forest(data), [data]);
          const keyFor = id => `${sessionId}\u0000${id}`;
          const visible = [];
          const visit = nodes => nodes.forEach(node => { visible.push(node); if (!collapsed.has(keyFor(node.id))) visit(node.children); });
          visit(roots);
          const focusId = visible.some(node => node.id === focused) ? focused : visible[0]?.id;
          const focus = id => { setFocused(id); elements.current.get(id)?.focus(); };
          const toggle = node => {
            setCollapsed(previous => {
              const next = new Set(previous), key = keyFor(node.id);
              if (next.has(key)) next.delete(key); else next.add(key);
              const bounded = new Set([...next].slice(-LIMIT)); saveCollapsed(bounded); return bounded;
            });
            focus(node.id);
          };
          const open = async node => {
            if (node.state === 'archived' || node.canOpen === false || tab.signal.aborted) return;
            opening.current?.abort();
            const current = new AbortController(); opening.current = current;
            setNotice('');
            try {
              const target = await call('resolve', { sessionId, targetId: node.id }, current.signal);
              if (!live.current || current.signal.aborted || tab.signal.aborted) return;
              // The resolver validates ACL/archive/availability. Never infer an address from a title, URL or ancestry.
              if (target?.targetId !== node.id) throw new Error('会话解析返回了不同的 ID，已取消导航');
              ctx.uiWorkspace.openSession(target.targetId);
            } catch (e) {
              if (live.current && !current.signal.aborted) setNotice(`无法打开：${e.message || '会话不可用'}`);
            } finally { if (opening.current === current) opening.current = null; }
          };
          const copy = async node => {
            try {
              // sessionRef is the backend's exact protocol reference; plain titles are never identity.
              if (typeof node.sessionRef !== 'string' || !node.sessionRef) throw new Error('暂未提供会话引用');
              if (!await writeClipboard(node.sessionRef)) throw new Error('剪贴板不可用');
              if (live.current) setNotice('已复制会话引用');
            } catch (e) { if (live.current) setNotice(`复制失败：${e.message}`); }
          };
          const onKey = (event, node) => {
            if (event.target !== event.currentTarget || event.nativeEvent?.isComposing) return;
            const index = visible.indexOf(node), folded = collapsed.has(keyFor(node.id));
            if (event.key === 'ArrowDown') focus(visible[Math.min(index + 1, visible.length - 1)]?.id);
            else if (event.key === 'ArrowUp') focus(visible[Math.max(index - 1, 0)]?.id);
            else if (event.key === 'Home') focus(visible[0]?.id);
            else if (event.key === 'End') focus(visible[visible.length - 1]?.id);
            else if (event.key === 'ArrowRight') { if (node.children.length && folded) toggle(node); else if (node.children.length) focus(node.children[0].id); }
            else if (event.key === 'ArrowLeft') { if (node.children.length && !folded) toggle(node); else if (node.parent) focus(node.parent.id); }
            else if (event.key === 'Enter') open(node);
            else if (event.key === ' ' && node.children.length) toggle(node);
            else return;
            event.preventDefault(); event.stopPropagation();
          };
          const rows = (nodes, level = 1) => nodes.map((node, index) => {
            const expanded = !collapsed.has(keyFor(node.id));
            const title = node.title || '未命名会话';
            const state = Object.hasOwn(stateHelp, node.state) ? node.state : 'unknown';
            const blocked = state === 'archived' || node.canOpen === false;
            return h('li', { className: 'sl-item', role: 'treeitem', key: node.id, 'aria-level': level, 'aria-posinset': index + 1, 'aria-setsize': nodes.length,
                'aria-expanded': node.children.length ? expanded : undefined, 'aria-selected': node.id === sessionId,
                'aria-label': `${title}，${node.id}，${stateHelp[state] || '状态未知'}`,
                tabIndex: node.id === focusId ? 0 : -1, ref: element => { if (element) elements.current.set(node.id, element); else elements.current.delete(node.id); },
                onFocus: event => { if (event.target === event.currentTarget) setFocused(node.id); }, onKeyDown: event => onKey(event, node) },
              h('div', { className: 'sl-node' },
                node.children.length ? h('button', { className: 'sl-btn sl-toggle', type: 'button', tabIndex: -1, 'aria-label': `${expanded ? '折叠' : '展开'} ${title}`, onClick: () => toggle(node) }, expanded ? '⌄' : '›') : h('span', { className: 'sl-spacer', 'aria-hidden': true }),
                h('button', { className: 'sl-btn sl-title', type: 'button', tabIndex: -1, disabled: blocked, title: `${title}\n${node.id}${blocked ? '\n会话不可打开' : ''}`, onClick: () => open(node) }, title),
                h('span', { className: 'sl-meta' }, h('span', null,
                  h('span', { className: 'sl-state', title: stateHelp[state] || '无法确认运行状态' }, state),
                  node.taskStatus && h('span', { className: 'sl-task', title: `任务：${node.taskStatus}${node.hasResult ? ' · 有结果' : ''}` }, `任务 ${node.taskStatus}`))),
                h('button', { className: 'sl-btn sl-copy', type: 'button', 'aria-label': `复制 ${title} 的会话引用`, title: '复制标准会话上下文引用（不是普通文本导航链接）', disabled: !node.sessionRef, onClick: () => copy(node) }, h(CopyIcon))),
              expanded && node.children.length ? h('ul', { className: 'sl-group', role: 'group' }, rows(node.children, level + 1)) : null);
          });
          return h('section', { className: 'sl-panel', 'aria-label': '关联会话' },
            h('style', null, css),
            h('div', { className: 'sl-toolbar' }, h('h2', { className: 'sl-heading' }, '关联会话'), h('button', { className: 'sl-btn', type: 'button', disabled: loading || !tab.visible, onClick: () => refresh.current(), title: '只读刷新关联和运行状态' }, loading ? '读取中…' : '刷新')),
            h('p', { className: 'sl-note' }, '只读关系与状态 · idle 不代表任务完成。关联创建不等于原生父子；原生通信可用时优先使用原生通道，Session Link 作为跨会话补充。'),
            error && h('p', { className: 'sl-message sl-error', role: 'alert' }, `读取失败：${error}${data ? '（保留上次结果）' : ''}`),
            notice && h('p', { className: 'sl-message', role: 'status' }, notice),
            !data && !error && h('p', { className: 'sl-message', role: 'status' }, loading ? '正在读取关联…' : '等待可见时读取'),
            data && h('p', { className: 'sl-kind' }, '关联创建（非原生父子关系）'),
            data && h('ul', { className: 'sl-tree', role: 'tree', 'aria-label': '关联创建会话' }, rows(roots)),
            data && roots.length <= 1 && roots[0]?.children.length === 0 && h('p', { className: 'sl-message' }, '尚无关联创建的会话'),
            data?.truncated && h('p', { className: 'sl-note sl-footer' }, '关系数据已达显示上限；未展示的会话不代表不存在'));
        }
        // Official per-tool presentation seat. This is deliberately NOT a Markdown/global-click hook.
        // Only our own persisted tool results carrying explicit sessionRefs acquire navigation buttons.
        function useSessionActions(sessionId) {
          const [notice, setNotice] = useState('');
          const pending = useRef(null);
          const mounted = useRef(false);
          useEffect(() => {
            mounted.current = true;
            return () => { mounted.current = false; pending.current?.abort(); };
          }, [sessionId]);
          const openRef = async ref => {
            pending.current?.abort();
            const controller = new AbortController(); pending.current = controller;
            setNotice('');
            try {
              const target = await call('resolve', { sessionId, targetId: ref.id }, controller.signal);
              if (!mounted.current || controller.signal.aborted) return;
              if (target?.targetId !== ref.id) throw new Error('返回会话 ID 不一致');
              ctx.uiWorkspace.openSession(target.targetId);
            } catch (e) { if (mounted.current && !controller.signal.aborted) setNotice(`无法打开：${e.message || '会话不可用'}`); }
            finally { if (pending.current === controller) pending.current = null; }
          };
          return { notice, openRef };
        }
        function referenceButtons(refs, openRef) {
          return refs.length > 0 && h('div', { className: 'sl-tool-links', 'aria-label': '结果中的会话引用' }, refs.map(ref => h('span', { className: 'sl-tool-ref', key: ref.id },
            h('button', { className: 'sl-btn sl-title', type: 'button', title: `${ref.title}\n${ref.id}`, onClick: () => openRef(ref) }, ref.title))));
        }
        function ToolSessions({ sessionId, toolName, phase, block, inspect }) {
          const { notice, openRef } = useSessionActions(sessionId);
          const result = phase === 'result' ? toolResult(block) : { raw: '', value: null, refs: [] };
          const refs = useReferenceTitles(result.refs);
          const failed = phase === 'result' && (block.isError || result.value?.ok === false);
          const args = (block?.argsRaw ?? block?.call?.argsRaw) || '';
          const status = phase === 'preparing' ? '准备中' : phase !== 'result' ? '工具执行中' : failed ? '工具失败' : '工具已返回（不代表任务完成）';
          // These labels report explicit backend metadata, never native admission or delivery/completion guarantees.
          const channel = result.value?.channel ?? result.value?.delivery?.channel;
          const route = channel === 'session-link' ? '通道：Session Link（session-link）' : channel === 'session-link-control' ? '控制路线：Session Link（session-link-control）' : '';
          const operation = result.value?.operation === 'archive' ? '归档操作（不是通信投递）' : result.value?.operation === 'archive-discovery' ? '可归档会话查询（只读）' : '';
          return h('div', { className: 'sl-tool' }, h('style', null, css),
            h('details', null, h('summary', null, ['Session Link', toolName, route, operation, status].filter(Boolean).join(' · ')),
              args && h('pre', { 'aria-label': '工具参数' }, String(args).slice(0, 48000)),
              result.raw && h('pre', { 'aria-label': '完整工具结果' }, result.raw),
              phase === 'result' && !result.raw && h('p', null, block?.error?.code || '没有文本结果'),
              inspect && h('button', { className: 'sl-btn', type: 'button', onClick: inspect }, '查看原始调用')),
            referenceButtons(refs, openRef),
            notice && h('p', { className: 'sl-message', role: 'status' }, notice));
        }
        const resultKind = 'dsh-session-link-result';
        function ownResult(message) {
          const source = message?.source;
          return message?.role === 'user' && typeof message.id === 'string' && message.id.length > 0
            && source?.kind === resultKind && source.version === 1 && source.form === 'notice'
            && typeof source.recordId === 'string' && source.recordId.length > 0
            && (source.recordKind === 'task-result' || source.recordKind === 'outgoing-message');
        }
        function ResultNode({ sessionId, node }) {
          const { notice, openRef } = useSessionActions(sessionId);
          const message = node?.data?.message;
          const valid = ownResult(message);
          const source = valid ? message.source : {}, related = source.relatedIds || {};
          // Related identities come only from typed plugin metadata, never from Markdown/peer text.
          const ids = valid ? [...new Set([source.sessionId, related.ownerId, related.targetId].filter(validRefId))] : [];
          const refs = useReferenceTitles(ids.map(id => ({ id, uri: uriFor(id) })));
          if (!valid) return null;
          const content = (Array.isArray(message.content) ? message.content : []).filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
          const labels = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' };
          return h('article', { className: 'sl-result sl-tool', 'aria-label': 'Session Link 插件记录', 'data-session-link-record': source.recordId },
            h('style', null, css),
            h('header', { className: 'sl-result-head' }, h('strong', null, source.title || (source.recordKind === 'task-result' ? '任务结果' : '发送内容')), h('span', { className: 'sl-result-badge' }, 'Session Link 存档 · 插件记录 · 未独立验证')),
            h('p', { className: 'sl-message' }, 'Session Link 存档，不是原生自动完成通知。' + (source.recordKind === 'task-result' ? '执行者回报；任务状态以账本为准。不是模型助手回答。' : '发送内容存档；不是送达、阅读或完成证明。不是模型助手回答。')),
            h('div', { className: 'sl-result-body' }, h(MarkdownText, { text: content, streaming: false, labels })),
            related.taskId && h('p', { className: 'sl-message' }, `任务 ${related.taskId}${Number.isSafeInteger(related.revision) ? ` · 版本 ${related.revision}` : ''}`),
            referenceButtons(refs, openRef),
            notice && h('p', { className: 'sl-message', role: 'status' }, notice));
        }
        ctx.effect(() => ctx.uiConversation.events.register({
          kind: resultKind, target: 'chat',
          match: event => event.type === 'user/message' && event.surfaceOp === 'append' && ownResult(event.data) ? { id: String(event.data.id), role: 'start', exclusive: true } : null,
          start: (_context, match) => ({ seq: match.event.seq, time: match.event.time, message: match.event.data }),
          update: context => context.state,
          buildViewNode: context => context.state === undefined ? null : {
            key: context.key, id: context.id, kind: resultKind, target: 'chat', anchorSeq: context.state.seq,
            location: context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' },
            visibility: 'visible', data: context.state
          }
        }), 'session-link: visible plugin result event');
        ctx.effect(() => ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
          name: 'conversation.chat.node', key: resultKind, inject: sessionId => ({ sessionId })
        }, ResultNode)), 'session-link: visible plugin result body');
        for (const name of ['link_session_create', 'link_session_archive', 'link_sessions', 'link_send', 'link_status', 'link_activity', 'link_task', 'link_reception', 'link_models', 'link_result']) {
          ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
            name: 'tool.call.toolview', key: name, inject: sessionId => ({ sessionId })
          }, ToolSessions)), `session-link: tool view ${name}`);
        }
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: ID, kind: 'session-link', title: () => '关联会话', keepMounted: true,
          guide: [{ id: 'relations', title: () => '关联会话', description: () => '只读关联创建、会话状态与精确导航', icon: LinkIcon }]
        }), 'session-link: native tab type');
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: ID, inject: sessionId => ({ sessionId })
        }, Panel)), 'session-link: native tab body');
      }
    };
  }
});
