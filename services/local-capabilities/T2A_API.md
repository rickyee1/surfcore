# T2a backend integration contract

Additive protocol v1 extension, baseline `e9d33b4`. Existing `context.*`, `attention.*`, episode ingest and add-only `memory.propose` shapes remain valid. This backend implements deterministic storage/governance and encrypted restore; JS semantic Writer, management UI, real-model evaluation and full character/asset packaging are separate acceptance work.

## Writer path

Use the original trusted channel binding. `memory.episodes.pending {limit:20}` returns `{episodes,auto_write,memory_epoch,index}`. Limit is 1–100. Only active episodes in the **exact** binding audience are queued, and only if that episode revision has no consumption marker. Another group/private channel/role and public content outside that channel do not enter the queue. A corrected episode revision can be considered anew. Migration summaries remain quarantined; this extension does not silently promote their audience.

T2b Writer compatibility seam (after T2a acceptance): when auto-write is off, pending returns `auto_write:false,episodes:[]` without mutation or retrieval, so the host must not call a Writer model. Submit accepts 0–6 proposals; `proposals:[]` is a valid model decision that creates no assertion but atomically consumes the same validated source revisions on commit. Empty batches retain every source proof/epoch/consent/principal rule and idempotency; they cannot be used to bypass stale/deleted sources or pay for the same revision repeatedly.

Submit at most six add/supersede/invalidate proposals with 1–20 unique source IDs:

```json
{
  "proposal_id":"writer-event-batch-unique-id",
  "source_ids":["episode-id"],
  "source_revisions":{"episode-id":1},
  "expected_memory_epoch":4,
  "proposals":[
    {"operation":"add","kind":"preference","statement":"A bounded source-backed current assertion"},
    {"operation":"add","kind":"relationship_projection","statement":"A traceable shared experience"}
  ]
}
```

Kinds: `identity`, `preference`, `interest`, `project`, `relationship`, `guideline`, `relationship_projection`. Relationship projections are statements with the same provenance/invalidation rules; there is no second mood score or independent emotional authority. Each assertion receives all batch source IDs and their exact revisions. `supersede` and `invalidate` additionally require `target_id` and `expected_revision`; the target must be active, recursively visible, and in the exact writable session audience, never user-pinned. Public readability does not grant private writers authority to alter public records. Replacing a hidden assertion's source cannot silently make it visible again. Supersede requires `statement`; invalidate retains the previous body as explicitly invalidated management history.

`memory.proposals.submit` returns `{proposal_id,duplicate,status}`. Same ID and same canonical payload is idempotent; changed payload conflicts. `memory.proposals.commit {proposal_id,expected_memory_epoch}` returns `{proposal_id,ids,memory_epoch,duplicate}`. The original lifecycle, audience and principal must still match. Auto-write consent, memory epoch, source revisions and target revisions are rechecked. All assertions, writer revisions, index terms and consumption markers commit in one transaction; any item failure rolls back the entire batch. Replay of a committed batch returns its original IDs, without rewriting assertions. Reusing a consumed source revision in a new batch returns `SOURCE_CONSUMED`.

`memory.proposals.list {limit:20,offset:0}` is **management only** because history may contain old candidate wording. Deletion checks episode/target references, committed batch result IDs, and statement fingerprints. Affected pending/committed batches lose both payload and result, become deleted and cannot be replayed. This also covers refs-empty add outputs and independently sourced candidates that repeat deleted wording. Submit rejects tombstoned wording before persisting a new candidate. Lists have a 2 MiB body budget and return next_offset; this list must not become an LLM context source.

Example with the existing JS facade's trusted call path:

```js
const pending = await local.call(channel, 'memory.episodes.pending', { limit: 10 });
const episodes = pending.episodes.slice(0, 20);
// The next integration unit calls the selected model without tools and validates its bounded JSON.
const params = {
  proposal_id: batchId,
  source_ids: episodes.map(e => e.id),
  source_revisions: Object.fromEntries(episodes.map(e => [e.id, e.revision])),
  expected_memory_epoch: pending.memory_epoch,
  proposals: validatedItems,
};
await local.call(channel, 'memory.proposals.submit', params);
const applied = await local.call(channel, 'memory.proposals.commit', {
  proposal_id: batchId, expected_memory_epoch: pending.memory_epoch,
});
```

Do not refresh the epoch over a user correction to bless an old model proposal; discard/re-evaluate it. Do not claim assertions are semantically proven by this interface: source identity/revision/range is checked, while the model's textual inference still needs the T2b integration and evaluation.

## User sovereignty and local index

`memory.resume {id,expected_revision,expected_source_revisions:{sourceId:revision}}` is management only. Derived records require explicit current source revisions and recursively visible/active sources in the record's audience. Resume pins the reviewed statement and adds a user revision. Deleted/tombstoned sources cannot resume. Existing corrections still suspend all derived descendants, including relationship projections.

`memory.query` retains its default substring behavior. Optional `search_mode:"keyword"` uses deterministic ASCII words and Chinese bigrams (1–50 query terms, all terms required), after SQL audience filtering and before the existing result limit. Results retain pinned-first/newest priority and recursive provenance checks. `memory.index.rebuild {}` is management only and returns `{index:"deterministic_keywords_v1",indexed,semantic_vectors:false}`. Index data is encrypted and rebuildable from authority records; there is no embedding model or semantic-vector claim. Records add a `source_revisions` map for detail/history and future UI provenance displays.

For the T1 channel seam, active `context.sources` results additionally return the actual record `id`. Inactive/missing/other-audience results never expose an ID. `memory.ingest` optionally accepts `source_revisions`; when present it must map exactly the unique `derived_from` IDs to their current positive integer revisions, all active and recursively visible. Validation, epoch check and proof insertion share one transaction. Same-event replay with changed provenance is a version conflict, never a source reassignment. Omitting the new map retains legacy ingest behavior. This permits a private thought derived from allowed public material to be invalidated when that material is corrected, suspended or deleted.

The disabled-writer path still performs non-writing source validation before `AUTO_WRITE_DISABLED`: bounded fields, role-wide event/content/source tombstones, recursively visible parents, optional fixed revisions and duplicate provenance identity. A stable public material event previously deleted in another audience of this role returns `DELETED_SOURCE`, not a benign persistence-off result. Exact-scope `context.sources` still returns missing with no foreign body/ID; it is not widened to reveal deletion history. A genuinely new valid input still returns AUTO_WRITE_DISABLED with no record/index/epoch changes. T1 may use that specific result for its own never-persisted actual live input, but must fail closed for deletion, permission, version and validation errors. Existing per-scope idempotency remains; this patch adds no cross-role or active-other-scope query authority.

The finite disabled-write identity policy is:

| Current-role source identity | Result after input validation |
| --- | --- |
| Tombstoned event/content/ref in any audience | DELETED_SOURCE |
| Exact scope, active and recursively visible stored event | AUTO_WRITE_DISABLED; an existing legal source, not a new persistence claim |
| Exact scope suspended/invalidated or active with hidden/inactive/stale ancestor | PERMISSION_DENIED |
| Same role event retained only in another audience or quarantine | PERMISSION_DENIED; only boolean existence is read, no foreign body or ID |
| No event in this role, including when only another role has it/deleted it | AUTO_WRITE_DISABLED for an otherwise valid new live input |

With persistence enabled, the established per-scope archive/idempotency contract still applies; this stricter transient-use gate does not grant cross-audience lookup or silently reassign a stored event's provenance.

## Encrypted snapshots

All backup and restore operations require a validated management binding. Passwords must be 12–1024 characters. No password, data key or source DPAPI blob is returned or persisted in plaintext. Scrypt derives an independent 32-byte snapshot key from a fresh 16-byte salt, with fixed parameters N=16384/r=8/p=1. SQLCipher authenticates/encrypts the snapshot. Only fixed service-owned IDs are accepted; arbitrary file paths, traversal IDs and links/reparse points are refused.

`backup.create {password}` returns `{backup_id,manifest,includes_keys:false,includes_authorizations:false}`. Under the service data root it creates `backups/<backup_id>.db` and `.json`. The plaintext manifest contains only format/KDF/salt, random lineage/backup IDs, creation time, record counts, ciphertext hash/size; it contains no statements. The encrypted header binds that manifest to the logical record set. A separate encrypted local registry in the independent ledger binds the local backup ID, role, lineage and ciphertext digest; claiming a lineage in an imported manifest is insufficient to count as a verified local backup.

Snapshots contain only the selected role's memory records, revisions, fingerprints/tombstones, source-revision proofs and episode-consumption markers. They exclude live bindings, pending proposals, DPAPI/data keys, grants, attention budgets/settings and auto-write consent. Current consent/budget on the target remains authoritative. No `Connection.backup()` is invoked inside the live `BEGIN IMMEDIATE`: a separate SQLCipher connection receives a consistent bounded logical copy while the source transaction is held. Snapshot/stage limits are 100,000 rows and 64 MiB decoded data (128 MiB encrypted file); oversize input fails visibly.

`backup.inspect {backup_id,password,offset:0,limit:20}` checks manifest, ciphertext hash, SQLCipher integrity, schema, role, derivation DAG and deletion fingerprints. It returns `{character_id,counts,requires_review,preview,index,includes_keys:false,includes_authorizations:false}`. Preview is an explicit management view of snapshot contents, not live context. Limit is 1–20. Other-role snapshots return `CHARACTER_MISMATCH`, without automatic remapping. An imported pair must be placed in the owned backup folder by the future authenticated import handler; Python never accepts an arbitrary import path.

## Restore state machine

1. `backup.restore.stage {backup_id,password}` decrypts and validates in an independent connection, then writes an isolated encrypted `restore-staging/<restore_id>.db` using the target service's current key. It returns `{restore_id,base_memory_epoch,requires_review,status:"staged",snapshot_digest,ledger_instance,review_digest}`. The password is not saved. Active memory/epoch remain unchanged. The confirmation digest binds the role, selected restore ID, staged ciphertext digest, current memory epoch and current independent ledger instance.
2. `backup.restore.commit {restore_id,expected_memory_epoch,review:false}` requires the stage base epoch and current memory epoch to match. It verifies the stage hash/schema again, merges the latest independent deletion ledger, replaces only that role's memory domain, applies deletion provenance closure, rebuilds the keyword index and increments memory_epoch in one active transaction. Current tombstones are never replaced by older snapshot tombstones.
3. A locally registered backup with a healthy matching deletion authority commits to `committed`. Trust is recomputed at commit, not copied from the stage's old requires_review flag. A foreign/unregistered backup or missing/replaced latest ledger defaults to `committed_paused`. A snapshot made from paused contents is marked source_requires_review and cannot launder those contents into a trusted local backup. Normal memory/context reads and attention check/reserve are blocked with `RECOVERY_REVIEW_REQUIRED`. Management can inspect/review the restored records. The service cannot reconstruct deletions that were never supplied from another device; it must not silently pretend otherwise.
4. After local review, management fetches `backup.recovery.status {}`. It returns only the current active `{restore_id,status,requires_review,memory_epoch,snapshot_digest,ledger_instance,review_digest}`, with no key, path or private body. Submit that restore ID, **current** expected_memory_epoch, explicit `review:true` and matching `review_digest` to `backup.restore.commit`. An old restore A cannot approve a later restore B, even with a freshly recomputed epoch/digest. A stale/wrong digest leaves pause intact. Valid review releases only that role's pause without re-importing the snapshot or overwriting corrections made during review. A first commit can include review:true and the stage-returned digest. Review acknowledgement persists for that role/current restore/current ledger instance across restart, without changing global trusted to 1; another unreviewed role remains paused. Replacing the ledger invalidates the old acknowledgement. Repeat approval of the current committed task does not re-import or overwrite later corrections.
5. Every successful commit/review retires that role's active epoch/bindings and unresolved reservations. The caller must discard generated replies, queued sends and facade caches, then activate/bind afresh. `backup.restore.cancel {restore_id}` cancels only a staged task; it does not undo a committed restore. Encrypted staging/old backup files are retained, never silently promoted to active state.

Wrong password (`BACKUP_AUTH_FAILED`), corruption (`BACKUP_CORRUPT`), changed activity (`VERSION_CONFLICT`) or interrupted transaction leaves active content unchanged. Partial artifacts without published manifests/registered stages are unusable. Tests inject interruption after replacement but before commit and verify both authority rollback and still-valid old contexts.

## Host/UI work still required

The T2a baseline JS allowlist/routes require a separate trusted integration. That integration must add visible code/error/hint handling, keep password fields out of logs/persistence, provide authenticated pair import/download, and render recovery pause/review state explicitly. It must persist the local backend's written intent before restore commit (unknown IPC outcome must not allow rollback to legacy). After `character_invalidated:true`, clear the facade's cached active role/bindings before activation; do not retry an old generated reply. Existing final `context.validate` send gates remain required.

For post-restart review, an authenticated management handler obtains current confirmation fields without retaining the password or re-importing the snapshot:

```js
const status = await local.call({ kind: 'management' }, 'backup.recovery.status', {});
// Show current restore ID, memory version and snapshot digest; require an explicit user confirmation.
const result = await local.call({ kind: 'management' }, 'backup.restore.commit', {
  restore_id: status.restore_id,
  expected_memory_epoch: status.memory_epoch,
  review: true,
  review_digest: status.review_digest,
});
// On VERSION_CONFLICT refresh/review; do not silently replace confirmation fields and retry.
// On character_invalidated clear host role/binding/context caches before activating again.
```

This unit does not modify those JS/UI files, call any model, or claim real-user restoration acceptance. Only synthetic isolated stores have been opened by its tests.

## Store upgrade and rollback

On first upgrade, additive schema tables are created and the current authoritative tombstones seed independently encrypted `sovereignty.db`. Its lineage/trust marker is retained outside all snapshots. Main and ledger deletion writes use one SQLCipher attached-database transaction with DELETE journals on the same filesystem. Startup merges the independent ledger and purges any older main-file replay before serving queries. If an initialized store later loses its ledger, it pauses the affected roles instead of trusting an empty replacement. Corrupt/wrong-key ledger or mismatched lineage fails closed.

Preserve `memory.db`, `sovereignty.db`, the existing protected key file, backup manifests/ciphertexts and staging files as one deployment inventory; do not copy the source key into a portable snapshot. Root performs any real upgrade only after accepted deployment backup. Code rollback must not remove the ledger or bypass its deletion priority. A pre-T2a executable does not enforce the new recovery pause/ledger/proposals, so preserve the new data and pause instead of silently switching to the old writer. Full persona/assets/channel-state migration and semantic vectors remain separate work.
