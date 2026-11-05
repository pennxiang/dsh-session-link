# DSH Session Link — implementation contract

Version stays `0.1.0`. Tested compatibility baseline: DSH `0.2.1-rc.5`. This is an independent ESM plugin, with an explicitly paired native Workspace extension; it is not a replacement Host, sandbox or subagent lifecycle manager.

## Identity and communication

- Nine model tools: `link_models`, `link_session_create`, `link_sessions`, `link_send`, `link_status`, `link_activity`, `link_task`, `link_reception`, `link_session_archive`. Strict schemas and bounds are defined in `lib/tool-schema.js`.
- Identity always comes from the exact live Host `exec.agent`, never body-provided sender/owner/Agent. ToolRuntime scope/filter/guard and directory fences remain authoritative.
- Prefer actually available native Team/direct-managed messaging where supported. Communication inspection is advisory, not Host admission. Link tools always dispatch Link, never implicitly switch to native or retry an uncertain native request through another channel.
- Ordinary sessions, btw and supported resumable managed children may communicate without changing ownership or permissions. Seeded-sidechat compatibility is narrow, structural and pinned to the tested Host version. Unsupported backends are not converted to resumable children.
- Deliveries are clearly peer-origin reference data, not human authority. No automatic ACK, completion mirroring or duplicate native-task ledger. Accepted/claimed/runtime-idle/task-completed remain distinct.
- Pure metadata uses bounded cancellation and runs independently of the mutating queue. Mutations are not abandoned by an outer timeout. Close cancels reads and drains admitted writes.

## Creation and task handoff

- `link_session_create` creates a persistent ordinary independent root through public Host APIs; it does not create a Team/subagent or copy a transcript.
- Only exact live independent ordinary callers may create roots. Inherit named permission and agent presets; reject unsupported custom permissions, parented forks, sidechats and managed children attempting to expand their scope.
- Exact provider/model IDs come from the public catalog; effort is validated for that model. No alias, fallback or global-default rewrite. Only the pinned instance-local compatibility setter is used where required.
- `task/context/decisions/constraints` are explicit summary strings, up to 4000 characters each and 12000 serialized total. Context fields require task; task and initialMessage are mutually exclusive. No task/message means no model generation.
- Canonical cwd and actual Workspace membership are verified. A matching path alone is not membership proof. Register/attach/verify through public APIs and preserve partial creation diagnostics.
- Persist creation intent and reception quarantine before submission. Partial/unknown creations remain quarantined for Link transport, not protected against all native UI access. Do not recreate under a fresh key.

## Tasks, visible local records and persistence

- Tasks are participant-only, owner-cancelled, assignee-updated with revision CAS. Completion requires a substantive result and is self-reported, not independent verification. Metadata cancellation does not interrupt work or retract input.
- Before remote substantive send, save the same text in the executing sender Session; before task completion, save the result in the executing assignee Session. Use the producer-owned typed notice, native append and confirmed flush. Do not fabricate a human prompt or assistant reply.
- Client definitions render only the exact owned record type. Failed/unknown persistence prevents automatic replay or false completion. Task update does not automatically send a reply.
- State uses private directory/file modes, atomic persistence and one writer lock. Do not evict active/unknown intents. Interrupted submitting records become unknown, not automatically retried. Reception changes affect only the caller.
- Default limits include 12 messages/minute per unordered pair, 8 reply hops, 1000 deliveries, 500 tasks, 2000 local-result metadata records, 1000 creation intents and 10 new creations/sender/minute. Full capacity refuses rather than silently dropping uncertain work.

## Native list and title references

- Paired native display capability: `sessionRelationsVersion: 1`, `registerSessionRelations({id,version:1,source})`. The source exposes a stable read-only `{schemaVersion:1,edges,truncated,loading}` snapshot and subscription disposal.
- Only minimal current-Workspace provenance edges are exposed; no titles, handoff text, results or transcript. Validate current membership, first provenance, unique parent, cycles, archive/fork/btw/managed-child and directory fences. No retain/resume for presentation.
- Native Workspace owns original rows, sorting, filters, search, navigation, menus, status, drag behavior and lifecycle. No DOM relocation, full browser replacement or domain parent mutation.
- Keep visible component root at depth 0; flatten surviving descendants to one depth-1 level. Only root collapses, with its toggle right of title. Root has no empty gutter; all descendants share the native gutter. Old child-collapse keys cannot hide flattened descendants. Filtered parents leave surviving children as roots; search remains flat.
- Visible subscribed consumers only: 60-second bounded refresh, up to 100 Workspaces, 50000 members, 1000 aggregate edges, four requests. Backend display edges cap at 200/Workspace; this display cap never defines archive scope. Retract stale data on hide, cancellation, membership change, error or reconnect.
- Create first, then attach/verify and publish ready provenance asynchronously. Native updated/manual root order remains native; root order is not the maximum descendant timestamp. Display projection never recreates or reparents sessions.
- Chat references display current trusted public catalog titles, including ID-only historical records and renames. One lazy shared observer; validate exact catalog key and row.id. Unnamed fallback, never ID/path as title, no transcript hydration. Labels are not identity: resolve/navigation use exact IDs.
- Own tool/result chips remain blue with no chat-copy control. Auxiliary copy uses standard `base64url(JSON.stringify(id))` Session mention encoding. Ordinary pasted mentions are native noninteractive context chips, not globally intercepted links.

## Explicit archive scope and self-archive

- Discovery reads public live/cold metadata without resume or transcript; `isSelf` identifies the exact caller. User-requested self-archive is allowed, but durable managed ancestors, invalid/cyclic/archived lineage, stale identity and strict-directory violations still fail closed.
- `archiveScope` is `single` or `related`. Missing scope with related or pending candidates returns `ARCHIVE_SCOPE_REQUIRED`, exact targetId and allowedScopes, without planId, targets, outcome or any Native archive. Tool target authorization precedes candidate inspection.
- Scope choice is not a plan and not stop consent. Prepare again with a new requestId after user choice. Explicit single takes only the target and does not inspect or authorize unrelated descendants; target-local unknown and safety guards remain. Related requires at least two eligible members; disappearance does not silently downgrade to single.
- Related planning reads the complete <=1000-entry creation ledger and current same-Workspace ordinary identities, not capped display edges. Reject incomplete/changing/pending/unknown graphs, cycles, over 1000 targets and retained uncertain overlapping mutations.
- Plans bind exact owner-or-caller namespace, target, scope, ordered members and identities. Commit must retain planId and scope. Old unscoped planned records cannot acquire consent; retained terminal history may replay read-only but never resubmit side effects.
- Preflight all selected members through real public Host activity providers before mutation. Default stopActivity=false; any activity yields zero archives. Explicit stop requires separate human consent and a new requestId for the same scoped plan. Scope consent alone never authorizes stopping.
- One shared engine serves ToolRuntime and authenticated owner UI. Owner commits and Tool creation share the service mutation queue. Owner authority is not a synthetic Tool Agent. Exact owner Connection Fetch route `/api/session-link/archive` uses strict 4KiB plan/commit bodies; no raw HTTP fallback.
- Related commit is postorder, root last, with per-item durable intent, adjacent final guards, non-raced public `WorkspaceRegistry.archiveSession` and affirmative readback. Single affects one target. Unknown/partial/restart/abort outcomes are not automatically replayed under old or new keys.
- Native order is archive/unpin persistence before stop requests. Readback proves archive state, not allStopped. Already archived is a no-op and does not stop again. Restoration does not restore pins, cancelled work, queued input or deleted reminders.
- Self-stop can cancel or dispose the caller and interrupt its response. After Native submission, persist/read back known effects without a post-submit caller/abort gate erasing the outcome. Preserve cancelledAfterSubmission; a missing reply is not permission to retry. If caller appears before later members, interruption may leave an honest partial result rather than reorder the group.
- Outcome contains archiveScope, archivedIds, remaining and failed, with succeeded/partial/unknown/failed. Complete disjoint partitions and failed subsets are validated; no fabricated empty success or atomicity claim.

## Native archive capability version 2

- Separate capability: `sessionArchiveProvidersVersion: 2`, `registerSessionArchiveProvider({id,version:2,prepare,commit})`. Relation metadata grants no mutation authority; legacy archive version 1 cannot substitute for this scope protocol.
- `prepare(target,{archiveScope?})` returns unhandled only for legitimate unselected fallback, pure scope-choice, or an immutable scoped plan. Selected prepare returning unhandled is an error, never singleton fallback.
- Pending choice binds exact provider registration, target and navigation generation. Choosing a scope prepares a fresh plan; provider replacement/unload/navigation invalidates late work. UI form state is request-keyed.
- Related always displays the actual fixed member list and requires confirmation, even if quiet. Activity has an independent unchecked stop control. Cancel scope/member/activity dialogs means zero commits. Quiet single uses the original singleton notice and Undo; related has count notices and no misleading group Undo.
- Commit binds exact plan object, planId, scope and provider lifetime, consumed before I/O. Partial/unknown/throw/concurrent calls cannot repost it. Unload aborts reads but does not abandon an admitted mutation.

## Reproducible validation and publication

See [README](./README.md) and [native integration](./docs/NATIVE-INTEGRATION.md). Tests use fixtures or explicit isolated Host runtimes, not personal profiles. Optional pure native tests may use DSH_NATIVE_SOURCE; explicit bad paths fail. Mock tests are not actual GUI proof. Uninstalled skins and unexecuted live activity scenarios remain unverified.

Publication includes only reviewed source, tests, integration instructions, the complete native source patch and license notices. Exclude personal profiles, credentials, sessions, logs, screenshots, local acceptance records, packages, installed artifacts, backups and the original worktree/history. Public source does not change the UNLICENSED status of plugin originals; see [NOTICE](./NOTICE.md).
