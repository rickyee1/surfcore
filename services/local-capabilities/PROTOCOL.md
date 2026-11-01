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
| memory.ingest / memory.propose | source_event_id, text, source_refs, derived_from, expected_memory_epoch; bounded automatic add, with auto_write consent and idempotency |
| memory.detail | Management only: id; record, sources and revisions |
| memory.correct | Management only: id, statement, expected_revision; pin user correction, invalidate derived descendants |
| memory.suspend / memory.delete | Management only: id, expected_revision; stop usage or purge managed provenance closure |
| memory.export | Management only: explicit plaintext export of managed records |
| memory.settings | Management only: get or set auto_write |
| memory.migrate | Management only: migration_id and at most 500 records; transactional quarantine import, legacy_summary attribution |
| context.validate | memory_epoch must match the bound role and current memory state |
| context.sources | Up to 20 unique source_event_ids; exact current audience/character lookup; returns source_event_id/status/text?/revision? plus memory_epoch. Active text also requires all recursive derived sources to remain active and visible. Other scopes or hidden ancestry return missing without body; direct inactive sources have no body |
| attention.configure | Management only: enabled/daily_limit/cooldown_seconds/quiet_start/quiet_end/timezone/muted/focused |
| attention.check / reserve | outreach_id; check returns allowed/reason, reserve returns reserved/reservation_id/reason; recheck may include reservation_id and memory_epoch |
| attention.finalize | outreach_id, outcome sent/failed/unknown; only original binding can finalize, final outcomes cannot be overwritten |
| attention.respond | Only trusted owner pet/private input restores responsiveness; group messages cannot |

The JS management handler and channel handler are separate APIs. Model messages cannot issue arbitrary protocol requests. Only the authenticated local management page changes owner sharing/mappings. Scope derives from trusted transport identity, never text claiming to be the owner. Ordinary sessions see their scope plus public Bili content; quarantine requires management. Management access is not permission to publish a private-derived summary.

Pending live messages are rechecked by source ID before prompt assembly. An explicit never-stored live input may remain transient when auto-write is off; saved/deleted content cannot be recreated from a stale cache. Senders validate the original role/context immediately before the external effect; using a newly issued context to bless an old generated reply is invalid.

Replay is operation-specific. Unknown sends remain counted across restart; no automatic retry or alternate-channel resend. Disabling the service stops governed actions. Key loss never triggers empty/plaintext fallback. See [README.md](README.md) for storage and recovery limitations and the behavior tests for concrete counterexamples.
