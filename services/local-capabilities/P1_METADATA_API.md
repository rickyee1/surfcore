# P1 — governed received-source metadata

Additive protocol v1 feature, attempt2, 2026-11-03. Baseline
`9f456d24b3165773b805879a5d59912a1e6af1e2`. This is source metadata only:
no purpose scheduler, personality, attention policy, JS adapter or deployment.
Existing T1/semantic failure/attempt limits remain unchanged.

## Trusted ingress

`memory.ingress.open {}` requires the original **ordinary** session binding and
returns `{ingress_token}`. Only the existing private, trusted stdio host adapter
may call it. It must never enter browser management/model operation allowlists,
prompts, logs or public responses. Management bindings are refused. A token is
bound to that exact binding/character generation, published only after COMMIT,
kept in memory, and invalidated on retirement/restore/restart. It is not permission
to change a principal or audience. At most128 live binding credentials are held.

The host may extend the existing `memory.ingest` with:

```text
ingress: {token: opaque, kind: user_input | assistant_output | external_source}
```

The host must already know that this is a genuinely original live source from its
trusted adapter. It cannot label a model proposal or derived summary as an input.
The service derives all identity fields from the original binding; no timestamp,
account, principal, scope or owner flag is accepted in this object. Public Bili
sources only accept `external_source`; pet/QQ only accept the other two kinds.
`memory.propose`, management, migration and `derived_from` cannot use a receipt to
claim original speech. Old calls without `ingress` remain valid and unknown.

Only a new persisted original episode receives a server clock stamp. Its meaning
is **received by this service during the first successful ingest**, not platform
event time, creation/publication time or when the user did the described thing.
There is no event-time field and no Date.now/rowid/log backfill. Automatic writing
off still validates source identity/deletion/proofs but writes no body or metadata.
Exact-event duplicates do not refresh, retrofit, reassign or upgrade metadata,
including a duplicate of an old unknown record or a corrected record.

The QQ group binding cache does not prove the sender of each event. Therefore
group speaker and owner attribution are always unknown in P1. A later adapter
unit must establish genuine per-event sender evidence before changing this rule.

## Ordinary bounded projection

`memory.materials {limit?:1..50}` accepts no selector, audience override or query.
Default20. It requires an ordinary binding; management is explicitly refused.
It reuses the existing SQL audience restriction and recursive active source/revision
closure **before** projection. Hidden, suspended, deleted, quarantined and paused
sources cannot be read through this endpoint. Other audiences' metadata is not
an alternate lookup or existence channel. Public Bili remains the existing allowed
public audience; its reader account/conversation identities are suppressed.

```text
{
  records: [existingRecord + {source_metadata: {
    received_at_ms: UnixMilliseconds | null,
    time_basis: service_received | unknown,
    source_speaker: {
      role: user | assistant | external | unknown,
      principal_id: boundOriginalUserPrincipal | null,
      owner_at_receive: boolean | null
    },
    origin: {platform, account_id, conversation_id} | null,
    statement_origin: original | revised | derived | unknown,
    verbatim: boolean
  }}],
  memory_epoch, character_epoch, has_more, unknown_time_count
}
```

For public Bili, origin keeps `platform:bili` but account/conversation are null.
`source_speaker` describes the original source, not necessarily the current text.
A P1 user correction preserves the source received time/speaker but reports
`revised` and `verbatim:false`. `owner_at_receive` is historical attribution,
never current owner authority or cross-channel permission. A consumer must not
turn a revised/derived statement into a user quotation, nor infer ownership from
an ancestor, `revisions.actor`, writer tags, a bound audience or a pinned flag.

Derived records get unknown time/speaker; they do not borrow a user ancestor's
timestamp. Unknown legacy records keep null time even after restart, duplicate
ingest, migration or restore. Missing metadata is normal, not zero elapsed time.
Ordering is the existing deterministic pinned/row insertion ordering, not event
chronology or semantic relevance. `has_more` describes only this permitted set.

## Storage and restoration

Optional SQLCipher table `record_metadata` contains one row per proved original
source: memory/character/scope/bound principal, received milliseconds, original
revision/content/event hashes and origin/kind/owner attribution; a separate current
record revision/actual-statement hash binds the projection after known corrections.
No existing memories columns, `user_version=1`, min-reader or DPAPI envelope
semantics change. No existing row is populated on upgrade.

Untracked old-reader changes that no longer match the original `content_hash`,
original `episode` identity with an empty `derived` array, current revision, actual
statement hash, event, scope or principal project as unknown. These are validity
requirements, not merely conditions for the `verbatim` flag. Projection, export,
snapshot validation and correction use this same complete source/frame gate.
An already-invalid frame is cleared within the owning correction/suspend
transaction, including rollback on COMMIT failure. Merely skipping its update
would permit an old revision/body to recur and match it (ABA); later corrections
cannot reattach that retired provenance. Deleted/orphan metadata is cleaned
on P1 open; ordinary deletion clears the full existing affected-source closure in
the owning transaction. Known source times are never replaced with a reopen time.

Owner-only `memory.export` additionally returns validated `record_metadata` rows.
This is the existing user's domain export, not a purpose projection permission;
it can include valid stopped history. Deleted, orphaned or untracked stale rows
are not exported. Tokens/grants/runtime bindings are never included.

Snapshots stay format v1. Their encrypted `snapshot_rows` may contain an optional
`record_metadata` sidecar. **Header counts keep exactly the existing six logical
table keys**, preserving the existing JS role-package contract. Metadata is
strictly one row per nondeleted memory, no more rows than valid memories, fully
included in the total byte bound and whole SQLCipher snapshot hash. Original and
current revision/hash, scope/principal, origin, type and provenance fingerprints
are validated. No unrecognized sidecar is accepted.

Old snapshots without this sidecar remain readable and restore unknown metadata.
Old readers explicitly reject snapshots with the extra row-set. Role packages
reuse this exact encrypted snapshot path without a new package schema or JS edit.
Restore copies valid original stamps or leaves unknown, clears replaced metadata,
merges the latest independent deletion ledger, and invalidates old ingress tokens.
Unknown-source restores stay paused until the existing explicit review; no source
metadata can grant a missing permission or bypass that review.

## Errors and integration boundary

Errors retain `{code,error,hint}`. Bad receipt fields/overrides/limits return
`INVALID_REQUEST`; wrong binding, generation, management or source kind returns
`PERMISSION_DENIED`. Existing stale-context, pause and deleted-source errors take
their original governed paths; consumers must not reinterpret them as fresh input.

JS must separately obtain/retain the private token at the genuinely trusted ingress
boundary and read materials with the actual destination's ordinary binding. P1
does not modify any existing JS caller: until that integration, current ingestion
correctly remains unknown. This API does not repair or reopen stopped T1/semantic
work and does not assert complete purpose parity.

Tests: `python scripts/test-local-capabilities-metadata.py` plus affected original
service/backend/role-package suites. Historical-reader tests use read-only
`git show 9f456d24...` from the repository, following the existing T5 fixture pattern;
they do not depend on ignored evidence or open a real user store.
