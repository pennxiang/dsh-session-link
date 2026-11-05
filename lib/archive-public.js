const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
const ids = value => Array.isArray(value) ? value.filter(validId).slice(0, 1000) : [];
const text = value => typeof value === 'string' ? value.slice(0, 256) : null;

/** Project only declared control metadata, never arbitrary Errors or native objects. */
export function archiveOutcome(source) {
  if (!source || !['succeeded', 'partial', 'unknown', 'failed'].includes(source.archiveState) || !Array.isArray(source.archivedIds) || !Array.isArray(source.remaining) || !Array.isArray(source.failed) || typeof source.stopActivityRequested !== 'boolean') return undefined;
  const out = { archiveState: source.archiveState, archivedIds: ids(source.archivedIds), remaining: ids(source.remaining), failed: source.failed.slice(0, 1000).filter(item => validId(item?.id) && ['failed', 'unknown'].includes(item.state)).map(item => ({ id: item.id, state: item.state })), stopActivityRequested: source.stopActivityRequested, atomic: false };
  for (const key of ['planId', 'targetId']) if (validId(source[key])) out[key] = source[key];
  if (['single', 'related'].includes(source.archiveScope)) out.archiveScope = source.archiveScope;
  if (typeof source.cancelledAfterSubmission === 'boolean') out.cancelledAfterSubmission = source.cancelledAfterSubmission;
  return out;
}

/** Bounded archive diagnostics shared by ToolRuntime and the owner-only UI route. */
export function archiveDetails(error) {
  if (error?.code === 'ARCHIVE_SCOPE_REQUIRED') {
    const choice = {};
    if (validId(error.targetId)) choice.targetId = error.targetId;
    if (!Object.hasOwn(error, 'planId') && !Object.hasOwn(error, 'targets') && !Object.hasOwn(error, 'outcome') && Array.isArray(error.allowedScopes) && error.allowedScopes.length === 2 && error.allowedScopes.includes('single') && error.allowedScopes.includes('related')) choice.allowedScopes = ['single', 'related'];
    return choice;
  }
  const out = {};
  for (const key of ['planId', 'targetId', 'archiveState']) if (typeof error?.[key] === 'string') out[key] = error[key].slice(0, 256);
  for (const key of ['atomic', 'stopActivityRequested', 'requiresConfirmation', 'cancelledAfterSubmission']) if (typeof error?.[key] === 'boolean') out[key] = error[key];
  if (['single', 'related'].includes(error?.archiveScope)) out.archiveScope = error.archiveScope;
  if (Array.isArray(error?.targets)) out.targets = error.targets.slice(0, 1000).filter(item => validId(item?.id)).map(item => ({ id: item.id, alreadyArchived: item.alreadyArchived === true, title: text(item.title) }));
  if (Array.isArray(error?.activity)) out.activity = error.activity.slice(0, 1000).filter(item => validId(item?.sessionId)).map(item => ({ sessionId: item.sessionId, title: text(item.title), totalGroups: Number.isSafeInteger(item.totalGroups) && item.totalGroups >= 0 ? item.totalGroups : Array.isArray(item.groups) ? item.groups.length : 0, groups: Array.isArray(item.groups) ? item.groups.slice(0, 16).filter(group => typeof group?.kind === 'string').map(group => ({ kind: group.kind.slice(0, 64), totalItems: Number.isSafeInteger(group.totalItems) && group.totalItems >= 0 ? group.totalItems : Array.isArray(group.items) ? group.items.length : 0, items: Array.isArray(group.items) ? group.items.slice(0, 16).map(value => ({ id: text(value?.id), label: text(value?.label) })) : [] })) : [] }));
  const outcome = archiveOutcome(error?.outcome) ?? archiveOutcome(error);
  if (outcome) Object.assign(out, outcome, { outcome });
  return out;
}
