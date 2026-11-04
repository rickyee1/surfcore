# Local capabilities protocol v1

One newline-delimited UTF-8 JSON request per stdin line, one response per stdout line. Diagnostics use stderr. Maximum request size is 1 MiB. The parent supervises the child; EOF releases the database lock. No network listener is provided by Python.

```json
{"protocol_version":1,"request_id":"unique-request","op":"memory.query","character_id":"test-character","character_epoch":1,"session_binding":"opaque-binding","deadline":1793548800000,"params":{"query":"","limit":20}}
```

`deadline` is Unix milliseconds and must be in the future. Successful responses contain `protocol_version`, `request_id`, `ok:true`, `result`; errors contain `ok:false`, `code`, `error`, `hint`. The sample binding is a placeholder, not a valid credential. Runtime bindings never survive a process restart.

| Operation | Parameters / result |
| --- | --- |
| health / capabilities | No binding needed; storage/protocol/module status, no secrets |
| character.activate | Trusted parent passes params.character_id; returns character_epoch and memory_epoch |
| session.bind | Trusted parent supplies platform/account_id/conversation_id/principal_id/audience_scope/is_owner/management; returns random session_binding |
| lifecycle.retire | Revoke the role epoch, bindings and unresolved reservations |
| memory.query | query and limit 1–100; audience-filtered memories plus memory_epoch; pinned corrections then newest records |
| memory.ingest / memory.propose | source_event_id, text, source_refs, derived_from, expected_memory_epoch; optional source_revisions must exactly bind unique derived_from IDs to current visible revisions in the same transaction; bounded automatic add, with auto_write consent and idempotency |
| memory.detail | Management only: id; record, sources and revisions |
| memory.correct | Management only: id, statement, expected_revision; pin user correction, invalidate derived descendants |
| memory.ingress.open | Private trusted stdio host only, ordinary binding: returns an opaque binding/generation-specific ingress_token; never expose through browser/model allowlists |
| memory.materials | Ordinary binding only, limit1..50; audience-first recursive active projection with optional proved received-time/source metadata; management is refused; see P1_METADATA_API.md |
| memory.suspend / memory.delete | Management only: id, expected_revision; stop usage or purge managed provenance closure |
| memory.export | Management only: explicit plaintext export of managed records |
| memory.settings | Management only: get or set auto_write |
| memory.migrate | Management only: migration_id and at most 500 records; transactional quarantine import, legacy_summary attribution |
| memory.episodes.pending | Bound audience only: limit 1–100; active unconsumed episode revisions and memory_epoch; public or another channel's episodes are not mixed into this queue |
| memory.proposals.submit | proposal_id, source_ids/source_revisions, expected_memory_epoch, 1–6 typed proposals; idempotently persist a pending writer batch |
| memory.proposals.list | Management only: bounded proposal history; not an alternate model recall API |
| memory.proposals.commit | Original principal/audience/character lifecycle: proposal_id and expected_memory_epoch; atomic assertions, source revision proofs and episode consumption |
| memory.resume | Management only: id, expected_revision, expected_source_revisions for derived records; explicit pinned review, never revives tombstoned sources |
| memory.index.rebuild | Management only: rebuild deterministic keyword projection; query can opt into search_mode=keyword; no vector model |
| backup.create / inspect | Management only: independent password; create returns an owned backup_id/manifest; inspect takes backup_id/password and bounded offset/limit |
| backup.restore.stage | Management only: backup_id/password; isolated encrypted stage; returns restore_id/base_memory_epoch/requires_review/snapshot_digest/ledger_instance/review_digest |
| backup.restore.commit | Management only: restore_id/expected_memory_epoch/review:false by default; review:true additionally requires matching review_digest; current deletion authority wins |
| backup.restore.cancel | Management only: restore_id; cancel a staged task without changing active memory |
| backup.recovery.status | Management only: current active restore_id/status/requires_review/memory_epoch/snapshot_digest/ledger_instance/review_digest; no body, key or path; restores review UI state after restart |
| context.validate | memory_epoch must match the bound role and current memory state |
| context.sources | Up to 20 unique source_event_ids; exact current audience/character lookup; active results add id/text/revision. Active text/ID require all recursive sources active and visible. Other scopes or hidden ancestry return missing without body/id; direct inactive sources expose no body/id |
| attention.configure | Management only: enabled/daily_limit/cooldown_seconds/quiet_start/quiet_end/timezone/muted/focused |
| attention.status | No params. Current ordinary owner private/Pet binding or management only. Read-only config, today_count, effective_daily_limit, unanswered, intensity, cooldown_until_ms and local_date. Counts use the same deduplicated native/portable charged-event union as check/reserve; includes reserved/unknown, excludes failed. No identities or event IDs returned. Does not initialize settings or alter the existing defaults. |
| attention.check / reserve | outreach_id; check returns allowed/reason, reserve returns reserved/reservation_id/reason; recheck may include reservation_id and memory_epoch |
| attention.finalize | outreach_id, outcome sent/failed/unknown; only original binding can finalize, final outcomes cannot be overwritten |
| attention.respond | Only trusted owner pet/private input restores responsiveness; group messages cannot |

The local Purpose page and `/companion` compatibility endpoints share one
role-level coordinator and timer. `attention.status` is the sole limit read.
The coordinator file holds material/carrier options and a migration marker,
never a second enabled/daily/cooldown ledger. Old local settings remain off until
explicit save. `attention.configure` with a nonempty patch synchronously cancels
the coordinator's original controller before its first await. Status reads and
empty compatibility reads do not cancel or initialize policy through the UI.
Passive chat does not share this purpose cancellation controller.

Original QQ/Pet ingress now opts into P1 only at the trusted live adapter.
Replies are associated with confirmed sent outreach by explicit native reply ID,
or a boot-scoped uninterrupted conversation sequence including native confirmed
outputs. P1 original owner attribution and same origin must also validate before
feedback affects a rebuilt goal. Writer/derived calls keep the default unknown
attribution. Reference-only pending and feedback never import legacy prose.

Optional public supply may return a host-only immutable public proof. It retains
the original public ordinary context, role/service generation, stable BV/event,
body hash, actual current stored revisions when present, original cancellation
guard and a maximum 120-second lifetime. A never-persisted proof is created only
after ingestion under auto-write-off validates deletion/provenance and returns
skipped, followed by an exact missing lookup. Active records use their current
governed body. Final validation requires the same context and exact missing or
active revision/body state. Deleted/suspended/invisible/unknown sources cannot
be revived from a fresh reader response. `host_observed_public` is the current
read time, never a video's event time or owner speech. These capabilities are
in-memory host objects, not memory IDs or browser/model-issued permissions.

The owner decision uses one pinned fixed-model call with only bounded explicit
materials and finite `send|skip` JSON. Every await and final synchronous gate
checks the original plan controller/persona/run frame. All material proofs are
validated before delivery. QQ retains the native intent/activity/foreground and
attention send guards. Pet uses the native event HTTP guard/sync/receipt path;
enqueue is not sent. Exactly one carrier is chosen, with configured Pet-to-QQ
fallback only on definite offline detection before any transport or generation.
Unknown, consumed and completed target identities survive unrelated source
retirement, bounded eviction and restart without retaining private prose.
Pre-dispatch terminal hashes and body hashes prevent crash replay; authenticated
proof of no attempted QQ transport permits a future fresh round. Actual final
outcomes remain separate from this reference-only deduplication state.

The JS management handler and channel handler are separate APIs. Model messages cannot issue arbitrary protocol requests. Only the authenticated local management page changes owner sharing/mappings. Scope derives from trusted transport identity, never text claiming to be the owner. Ordinary sessions see their scope plus public Bili content; quarantine requires management. Management access is not permission to publish a private-derived summary.

Pending live messages are rechecked by source ID before prompt assembly. An explicit never-stored live input may remain transient when auto-write is off; saved/deleted content cannot be recreated from a stale cache. Senders validate the original role/context immediately before the external effect; using a newly issued context to bless an old generated reply is invalid.

Replay is operation-specific. Unknown sends remain counted across restart; no automatic retry or alternate-channel resend. Disabling the service stops governed actions. Key loss never triggers empty/plaintext fallback. See [README.md](README.md) for storage and recovery limitations and the behavior tests for concrete counterexamples.

T2a additions keep the existing context/attention request shapes. Records add `source_revisions` for traceability. Successful restore retires the current character epoch and all its runtime bindings; the host must discard cached contexts and activate/bind again. Recovery pause rejects normal memory/context reads and attention check/reserve with `RECOVERY_REVIEW_REQUIRED`; management inspection remains available. See [T2A_API.md](T2A_API.md) for exact payloads, JS integration requirements and schema migration.

Disabling auto-write does not disable source validation. Before returning `AUTO_WRITE_DISABLED`, ingest/propose validates the input, role-wide deletion fingerprints and any required derived-source/revision/duplicate identity rules without writing records or advancing memory_epoch. Thus another audience's tombstoned stable event returns `DELETED_SOURCE` even though exact-scope context.sources correctly returns missing. This write gate never returns the other audience's body or ID. Only otherwise legal never-stored live input may be treated as transient; errors other than AUTO_WRITE_DISABLED must not be converted into that fallback.

For that disabled-write gate, an exact stored event must itself be active and recursively visible under the normal audience rules. Suspended/invalidated/hidden ancestry or a same-role event retained only in another scope/quarantine returns PERMISSION_DENIED; the latter is checked with a boolean existence query only. Truly absent current-role events and legitimate exact visible events may return AUTO_WRITE_DISABLED after validation. Another role's event has no effect. Enabled-write per-scope idempotency remains unchanged; source lookup is not widened.

Confirmed ordinary assistant output uses the host-only `memory.assistant-output`
entry described in [P1_METADATA_API.md](P1_METADATA_API.md). The original private
QQ/Pet context and exact nonempty input/retrieval dependencies accompany a
confirmed_assistant_output ingress token. Whole-turn confirmed bubbles commit
once under the original Writer lease, followed by independent cleanup. New
input, source/persona/role changes and cancellation invalidate the original
write. Actual sent plus memory failure is a separate result, never a platform
retry. P2 admits this exact governed assistant utterance as self material while
retaining its recursive dependency closure. Ordinary ingest/propose and Writer
cannot use this identity, and auto-write-off never persists its body.


`purpose.state {memory_epoch}` is a read-only ordinary owner private-QQ/Pet
operation. It accepts no target selector and is excluded from management and
agent allowlists. It returns only imported `{terminals, bodyHashes}` replay
hashes. Original context, audience, role-package pause and native recovery
review gates remain mandatory. It never changes configuration or budget.

Role-package `platformState.purpose` is optional for old packages and contains
only bounded terminal hashes (`unknown|done|consumed`) and unique body hashes,
maximum10000 of each. Missing means empty union, never replacement. The host
exports the fixed current role's companion journal projection and fences its
actual digest before/after capture. Sent pending receipts become consumed
hashes for transfer, with no pending work/body/authority/schedule in the package.
The existing restore commit transaction merges these hashes monotonically into
`purpose_replay`. Prior target suppression survives repeated, older and empty
packages. Enabled remains false and review/pause controls are unchanged. The
planner reads this state before selecting a purpose and the single coordinator
checks imported body hashes before dispatch. New relevant source revisions have
different candidate identities, subject to the existing material admission rules.
