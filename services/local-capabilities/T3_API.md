# T3 local tool protocol (attempt 1)

All calls use the existing protocol v1 envelope and a current `session_binding`.
Identity is resolved only from that opaque binding. A tool grant is independent of
`is_owner` and shared owner memory. QQ groups and Bili are rejected for all tool
operations. All failures use nonempty `code/error/hint`; adapter exceptions never
echo provider text, file bodies or credentials.

## Calls

| Operation | Params | Authority/result |
| --- | --- | --- |
| `tool.catalog` | `{}` | Fixed descriptors, schemas, hashes, limits, permission and data boundary |
| `tool.subjects` | `{}` | Management: current eligible subject bindings and resolved identities |
| `tool.propose` | `{tool_id,action,arguments,idempotency_key}` | Own subject; returns persisted execution metadata and confirmation digest |
| `tool.confirm` | `{execution_id,expected_revision,confirmation_digest}` | Management only; exact stored request, one execution, 60-second validity |
| `tool.execute` | `{execution_id}` | Original role/principal/channel; revalidates current epoch/policy/descriptor/target/grant |
| `tool.cancel` | `{execution_id}` | Own subject or management; late callbacks cannot change its terminal state |
| `tool.status` | `{execution_id}` | Own subject or management; never launches/replays |
| `tool.history` | `{limit?:1..100,idempotency_key?:string}` | Bounded newest-first history; exact-key mode always current role+resolved subject, metadata only |
| `tool.result.read` | `{result_id}` | Management only; current successful result, `{body,local_only:true,result_revision:1}` |
| `tool.roots.list` | `{}` | Management: roots including path/label/active |
| `tool.roots.register` | `{path,label}` | Management: absolute ordinary Windows directory; returns opaque root_id |
| `tool.roots.revoke` | `{root_id}` | Management; invalidates pending execution/export policy |
| `tool.grants.list` | `{}` | Management: precise subjects/tools/root/version/expiry/remaining |
| `tool.grants.create` | `{subject_binding,tool_id,action,descriptor_hash,root_id?,expires_at,uses}` | Management; expiry Unix ms, <=30 days, uses 1..100; path tools require root_id |
| `tool.grants.revoke` | `{grant_id}` | Management; immediate policy invalidation and cancellation |
| `tool.emergency.stop/reset/status` | `{}` | Management; persistent global closed/generation, lockscreen status |

Fixed tools and exact arguments:

| tool_id / action | arguments | boundary |
| --- | --- | --- |
| `time.now` / `read` | `{}` | Explicit permission exemption; public `{utc,unix_ms}` to original subject |
| `files.list` / `list` | `{root_id,relative_path}` | Local only; nonrecursive, <=200 entries, max12 path components |
| `files.read_text` / `read` | `{root_id,relative_path}` | Local only; <=64 KiB UTF-8; same verified handle read |
| `notes.create` / `create` | `{title,text}` | Local only; title<=200/text<=16000 chars; SQLCipher persistent subject notes |
| `notes.list` / `list` | `{limit?:1..100}` | Local only; own subject notes |
| `notes.read` / `read` | `{note_id}` | Local only; own subject note |
| `local.open_directory` / `open` | `{root_id,relative_path}` | Exact local action; fixed Windows Explorer executable, no shell/commands |

`relative_path:""` means the registered directory itself. No absolute paths,
drive-relative paths, UNC/device paths, ADS, traversal, reparse points or hardlinked
files. Roots and every ancestor are opened without delete sharing; final path and
object identity are verified before access and again after confirmation. The
service's own database directory and its ancestors/descendants cannot be roots.
No arbitrary adapters/tools/network/CLI registration API exists.

## Async state and idempotency

`awaiting_confirmation | authorized -> running -> succeeded | failed | cancelled | unknown`.
`revision` increases on transitions (initial authorization evaluation is revision1).
Same role+resolved subject+tool+idempotency key with different action/arguments or
descriptor hash fails `IDEMPOTENCY_CONFLICT`. Repeating execute returns the stored
metadata and never launches twice. Confirm cannot supply replacement arguments.

T3-H compatibility seam: `tool.propose` additionally returns `duplicate:false` for
a newly persisted execution, or `duplicate:true` for the same existing request.
This survives service restart/rebinding of the same subject and auto_write=false.
Host must not treat a duplicated terminal execution as a fresh model/send turn.
Subject isolation, parameter checks and execute idempotency remain unchanged; no
extra result body or database retrieval is introduced by this flag.

Before the proposal model, host can call `tool.history {idempotency_key,limit:1}`.
The optional key is an exact bounded nonempty string (<=200), never LIKE/global
search. This mode always filters SQL by current character AND resolved subject,
including management. It returns no arguments/result body and does not read time
result bodies; another subject/role or wrong key returns an empty list. Same-subject
rebinding/restart retains visibility of metadata, even with auto_write=false. Host
quietly ends the replay before any model/send; the propose duplicate flag still
guards concurrent prechecks. Omitting the filter preserves existing history behavior.

For external adapters, execute first commits `running` plus grant consumption;
only its post-commit callback starts one of two bounded daemon workers. Workers
never use SQLite. Execute returns running; callers poll status. Main-thread polling
persists outcomes/CAS, applies timeout and session-lock checks while stdin remains
responsive. There is no unbounded worker queue. SQLCipher notes/results are atomic
within one transaction. Failed persistence never invokes the adapter.

Running cancellation, timeout, parent exit or restart is conservatively `unknown`;
pending requests become `cancelled`. Old records never restart. Stop remains closed
across restart; reset increments policy and does not resurrect old work. Role retire,
reactivation, restore, grant/root revoke and session lock invalidate work/results or
exports. WTS failure is `not_verified` and fails closed for new tools. Actual lockscreen
and Explorer UI testing remains `NOT_VERIFIED` until root's visible acceptance.

Polling persistence failure is a sticky tool/export fault, from both request-driven
and idle entry points. Lock observations and next-check timestamps publish only after
COMMIT; completion queues are inspected without ACK and jobs are removed only after
COMMIT. Any failure immediately latches `persistence_fault` and cancels workers before
attempting rollback, including rollback failure. The first successful recovery poll
persists global closed + a new generation, marks running executions unknown and
pending executions/exports cancelled, then ACKs retained completions without body.
State/history remain readable after DB recovery, but tool execution, confirmation,
result body reads and export consumption/validation remain `TOOL_PERSISTENCE_FAULT`.
An in-process reset cannot clear this latch: fix storage, restart the service, review
unknown outcomes, then management reset. Old epochs/bindings/results never revive.
`tool.emergency.status` includes `persistence_fault:boolean` and
`recovery_required:"restart"|null`, and reports closed while the latch is present.

Execution metadata has character_id/character_epoch/policy_generation/tool_version (null if current catalog hash differs), execution_id/revision/state/tool_id/action/arguments_hash/
descriptor_hash/target_summary/confirmation_digest/result_id/result_revision/
local_only/error_code. Only management receives original arguments and resolved
subject. Files/notes never include body in ordinary status/history/execute. Terminal
errors include safe error/hint. Public time result is only returned while its execution
epoch/policy is current.

## Exact result export (trusted management host only)

All destination/export operations, including consume, require management. An
ordinary tool/MCP caller can never obtain local body, even with a confirmed export.
The trusted host must resolve current endpoint/config identity from the actual model
selection, freeze that selection, and validate after every await and immediately
before actual model input or private reply. It must never re-read defaults or silently
fallback to another provider/model. This service does not implement a network sender.

1. `tool.destinations.register {subject_binding,host_request_id,turn_id,model:{provider,model,config_revision,endpoint_identity},private_reply:boolean}`
   returns opaque destination_ref + fixed descriptor. endpoint_identity is a nonsecret
   SHA256 of the actual endpoint identity; config_revision identifies the nonsecret
   selected configuration. Registration invalidates the binding's previous destination.
   Descriptor purposes are model_input plus optional private_reply for the exact original
   pet or QQ-private channel triple (platform/account/conversation). Shared owner memory
   never merges these triples. memory_write is always false. No group/Bili target.
   `tool.destinations.revoke {destination_ref}` invalidates the reference.
2. `tool.result.export.prepare {result_id,expected_result_revision:1,subject_binding,host_request_id,turn_id,destination_ref}`
   accepts only a current successful result of that same resolved subject. It returns
   export_id/revision1/state/confirmation_digest/body_hash/body_bytes/result_id/
   result_revision/destination_ref/descriptor/expires_at/prior_unconfirmed_exports.
   Fixed TTL60 seconds. UI must display concrete body (result.read), purposes and exact
   targets, and any previous unconfirmed deliveries before allowing confirmation.
3. `tool.result.export.confirm {export_id,expected_revision,confirmation_digest}`
   changes prepared/revision1 to confirmed/revision2 without replacement fields or TTL
   renewal. Digest binds execution+revision, result+revision+body hash, original opaque
   binding and channel triple, host_request_id/turn_id, character epoch, current memory
   and policy generations, destination descriptor/reference, and expiry.
4. `tool.result.export.consume {export_id,subject_binding,host_request_id,turn_id,destination_ref,config_revision,endpoint_identity}`
   revalidates everything and atomically commits consumed/revision3 before returning
   body+fixed descriptor+export/turn/epoch constraints once. It is management-only and
   the supplied original subject binding must match. Concurrent/double consume and
   response loss never return the body twice (`EXPORT_ALREADY_CONSUMED`). Consumed
   means occupied/unconfirmed exposure, never sent. No memory-save permission.
5. `tool.result.export.validate` takes the same parameters as consume; returns
   `{valid:true,descriptor,expires_at,memory_epoch,policy_generation,subject_binding,
   host_request_id,turn_id,memory_write:false}` without body. Host must use this after
   model await and immediately before private reply; only a descriptor with private_reply
   permits using the generated output in the original private channel. Model-only consent
   does not authorize private reply or memory writing. TTL cannot be prolonged.
6. `tool.result.export.finalize {export_id,subject_binding,host_request_id,turn_id,outcome:"sent"|"failed"|"unknown"}`
   records one immutable receipt after consume, no body/resend. It may record uncertainty
   after expiry/revocation. `tool.result.export.status {export_id}` returns metadata only,
   including state/delivery_confirmed; restart preserves consumed/unconfirmed records.
   `tool.result.export.list {limit?:1..50}` is management-only and returns `{exports,local_only:true}` newest-first, with descriptor, export_id/revision/state/confirmation_digest (prepared only), result_id/revision, original subject binding/channel metadata, host_request_id/turn_id, expiry, outcome and unconfirmed. Each prepare/list/status item also carries prior_unconfirmed_exports (same result, at most20 IDs) and prior_unconfirmed_count (total), independent of list pagination. Neither status nor list returns body. This is the UI confirmation/history entry; ordinary callers cannot enumerate it.

Prepare/confirm/consume/validate all verify successful result revision/hash, current
original binding/role, destination, memory/policy generations and TTL. Revoke/root
revoke/emergency stop/reset/role switch/restore invalidates old work. No long-lived
export grant, regenerated permit from backup, or automatic resend exists. New consent
must explicitly display any prior unknown/unconfirmed delivery.

## Storage and integration

Additive SQLCipher tables only; no plaintext files/log bodies. Tool grants/roots/
notes/executions/results/exports are deliberately outside memory snapshot allowlist;
no DPAPI/binding/grant migration or replay. Close/restart service to load this module.
Host must retain old local closed-agent guards until tool routes are explicitly
integrated; this API does not enable old shell, MCP, Bili agent or public posting.
