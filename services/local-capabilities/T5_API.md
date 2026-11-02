# T5 role package contract — attempt2 repair

Task `/root/tools_ui`, attempt1. Design approved with the three concentrated additions below. Implementation and owner-applied seams require independent acceptance. Applies the seven decisions in `.local/evidence/full-integration/t5-role-package-contract-review.md`.

Concentrated F1/F2 repair: `/root/capability_service`, attempt2. Original implementation
and attribution remain `/root/tools_ui`; shared host edits are authored as exact SHA-bound
patches and mechanically applied by root. This is a review freeze, not deployment approval.

## Identity and authenticated format

One source ID, one target ID: `sourceCharacterId === snapshot.characterId === targetCharacterId`. `new` means the same ID does not exist in either the role directory/index or the SQLCipher characters table; it never means generating a replacement ID. Existing IDs require explicit `restore_same_id`. Other IDs fail `CHARACTER_ID_CONFLICT`. Import defaults to an inactive, paused role; an active same-ID restore publishes its new epoch pointer last and remains paused until fresh review.

`SURFCORE-ROLE1` has a fixed binary header: format/schema version, fixed scrypt identifier, 16-byte salt, 12-byte nonce, uint32 ciphertext length, followed by ciphertext and 16-byte AES-256-GCM tag. The entire header is AAD. Only scrypt N=16384/r=8/p=1/dkLen32 is accepted; header lengths/version/KDF are checked before deriving. Maximum complete file 192 MiB, nested scmemory 128 MiB, persona total512 KiB/seven fixed layers each64 KiB, assets128, logical records50000, bounded UTF-8 strings. Over-limit fails rather than truncates.

After GCM authentication, payload must equal its canonical UTF-8 JSON serialization, rejecting duplicate keys/noncanonical encodings. Exact key allowlists reject extras/missing fields. Payload: `{schema,packageId,sourceCharacterId,sourceRevision,persona,snapshot,platformState,assets,exclusions}`. Persona layer keys are exactly core/daily/tone and pet/qq-private/qq-group/bili scenes, each `{present,bytes,sha256,text}`; there is no arbitrary relative path. Snapshot includes the owned scmemory bytes, digest, character ID and counts. Assets contain only logical name/version/source/license/sha256/required, never asset files, arbitrary paths, URLs to fetch or credentials. Missing local assets are diagnostic blockers, never automatic downloads.

Exclusions are explicit: keys, trusted-backup registry, bindings, accounts/cookies, provider configuration, device/tool grants, root permissions, pending sends, model exports, voice/screen results, raw DSH history, old recovery approvals, schedulers and timers. Existing memory scopes/principals remain unchanged; newly bound QQ identities cannot relabel old scopes. UI lists old scopes that have no current binding.

## Browser management API

All operations use the existing local management session/cookie/random header/exact Origin. Binary upload/download are fixed sibling routes; no free file path input or Node SQLCipher access. Errors always include nonempty code/error/hint. Passwords are request-memory only, never journal/log/storage. Stage may require re-entering the same password; successful staging uses destination encryption and needs no password for status/commit.

| Operation | Exact parameters | Result and authority |
| --- | --- | --- |
| `role.package.export.prepare` | `{password,assets}` | Seal coherent artifact in owned area; return package_id/digest/revision/manifest/counts/expiry/confirmation_digest. No download yet. |
| `role.package.export.commit` | `{package_id,package_digest,expected_revision,confirmation_digest}` | Recheck source fence; approve exactly the sealed artifact, never regenerate. |
| POST `/role-package/download` | `{package_id,package_digest}` | Approved ciphertext only, bounded authenticated transport. |
| POST `/role-package/upload` | octet-stream | Bounded encrypted owned file; returns opaque package_id/digest. Does not trust header identity or activate. |
| `role.package.import.inspect` | `{package_id,password,mode}` | Authenticate all content and nested snapshot; preview exact source/target identity, persona hashes, records/scopes, assets, exclusions and target revision. mode=`new` or `restore_same_id`. |
| `role.package.import.stage` | `{inspection_id,password,package_digest,expected_target_revision}` | Recheck identity/content fence; create isolated destination-key memory stage, operation journal and sealed pre-change backup for existing target. Return operation_id/revision/digest/expiry/confirmation_digest. No formal overwrite. |
| `role.package.import.commit` | `{operation_id,expected_revision,confirmation_digest}` | Explicit final checkbox; persistent pause/lifecycle invalidation, persona and DB commit, publication last. Returns receipt or committed_paused. Lost response means status only. |
| `role.package.import.status` | `{operation_id}` | Persistent receipt with phase, digest, targetID, pending review, uncertainty and safe next action; never applies work. |
| `role.package.import.cancel` | `{operation_id,expected_revision}` | Before begin, cancel without changing target. After begin, record cancellation request and retain pause; never undo an already committed DB. |
| `role.package.recovery.inspect` | `{operation_id}` | Compare journal, file hashes and SQLCipher receipt; show exact continuation or manual repair requirement. No auto continue. |
| `role.package.recovery.commit` | `{operation_id,expected_revision,package_digest,confirmation_digest}` | Fresh explicit approval for this exact interrupted operation. Never install an old DB over subsequent formal writes. |
| `role.package.review` | `{operation_id,expected_revision,review_digest}` | Fresh current-device native deletion-ledger review and file/DB reconciliation. Old approvals are not imported. Proactive remains off; bindings/devices must be newly granted. |
| `role.package.diagnostics` | `{}` | Labels, compatibility, existence/hashes, own-process/dependency/asset availability; no bodies, environment or account configuration. |

Approval TTL is five minutes and binds package digest, source ID, target ID, target role epoch/persona hashes/memory_epoch, destination ledger instance, stage revision and operation ID. A changed fence fails; UI never silently refreshes consent. Export fences capture role epoch/persona hashes/memory_epoch/attention revision before and after sealing; any change discards the attempt. An approved export is the already sealed bytes.

## Python management-only internal seam

New `portable_state.py` owns DB operations, minimal non-authority attention data and durable receipts; Node never opens the encrypted DB. Existing core/server/storage edits are delivered as integration.patch to their owner.

* `portable.capture {character_id,password}`: within the service transaction, create existing native backup + capture attention non-authority summary, return owned snapshot ID/header, attention_id and source memory_epoch/attention revision. The bounded non-authority summary uses an owned JSON file instead of the 1 MiB stdio request line. Node applies its before/after persona fence.
* `portable.inspect {backup_id,password,source_character_id,target_character_id,mode}`: authenticate nested snapshot; enforce same identity and target collision policy; return counts/scopes/deletion review requirements without trusting source registry.
* `portable.stage {operation_id,package_digest,backup_id,password,target_character_id,mode,expected_memory_epoch,persona_digest,attention_id}`: validate fixed schema, create native backup restore staging plus package operation row. No target authorization or activation.
* `portable.begin {operation_id,expected_revision,approval_expires_at}`: trusted coordinator supplies the immutable journal approval deadline as a finite integer Unix millisecond value; missing/noninteger/nonfinite or `approval_expires_at <= service_now` rejects before the first formal mutation. The same transaction persists target recovery latch, disables attention, bumps memory/policy/portable generations and retires bindings/Writer/tools/media/pending outreach; after commit Node may replace persona. Begin is written before any target persona overwrite.
* `portable.commit {operation_id,expected_revision}`: in one SQLCipher transaction apply native ledger-first restore, merge portable attention, and write DB receipt keyed by operation_id/packageDigest/targetID. Native scopes/principals retained. Always pause foreign-ledger results. Same digest operation returns receipt; no restore replay after new writes.
* `portable.status {operation_id}` and `portable.publish {operation_id,expected_revision,persona_digest}`: query receipt and acknowledge exact published files; publication does not grant review, restart work or authorize proactive sending.
* `portable.review {operation_id,expected_revision,review_digest}`: use existing destination-ledger/native restore review proof, then release package latch only after current file/DB reconciliation. Separate pause reasons compose rather than one reason clearing another.

Operations are management-only; arbitrary source/target IDs are not added to ordinary caller APIs. Service initialization reads package latches before issuing any session; all validation/context/attention/tool/media/Writer paths reject a latched target. Retire includes `media.retire(character)`; media_config/media_audit, RAM leases/results/queues and device authorization are excluded.

Node checks inclusive expiry at approval entry and again after awaited portable.status,
before begin. The original `row.expires` travels through any later coordinator/start await
to authoritative Python; it is not replaced with `now+TTL`. Python checks after target
identity/epoch reads, immediately before its first write. Host backend pause configuration
is published only after successful begin; the pre-begin durable marker already closes
native generation/delivery independently of backend mode. A validly begun transaction may
finish settlement after its old approval deadline; commit/recovery of an existing begun
operation does not restart it or restore the old snapshot over later writes. A staged
old journal/marker cannot refresh approval silently. Explicit recovery.inspect remains a
new, displayed confirmation step; management status/cancel/recovery remain reachable.

## Attention non-authority summary v1

Summary `{schema:1,sourceTimezone,capturedAt,attentionRevision,unanswered,intensity,events}`. Event `{eventKey,dedupeDigest,createdUtcMs,outcome,charged}`. `dedupeDigest=SHA256("surfcore-outreach-dedupe-v1\0" + characterID + "\0" + outreachID)` is independent of device lineage and contains no plaintext ID. `eventKey=SHA256(domain + originalLedgerLineage + characterID + outreachID)`; original lineage/IDs are not used as destination authority. Events retain original keys through re-export, so repeated and transitive import is a union. Export reserved/running as unknown and charged; terminal sent/unknown charged, failed uncharged but still deduped. Never export reservation, binding, account, token, epoch, queue, enabled flag or timer. Reject overflow instead of losing dedupe history.

Destination stores imported events in a separate SQLCipher table. Budget checks union native events (their own stable event keys) with imported dedupe digests, avoiding double count when a source package returns to its source. Counts are recomputed from UTC timestamps in the **destination's current timezone**, not copied source day strings; source day/TZ validation prevents malformed dates. Existing destination timezone/config stays. Daily usage/cooldown are never made more permissive by import: union charged events and latest UTC timestamp; unanswered=max(destination,source), intensity=min(destination,source), destination proactive enabled=false. Current stricter limits/quiet/focus settings are not relaxed. Repeated package receipt cannot add usage repeatedly or reduce it. Normal future authenticated owner response may reset unanswered under existing authority; import itself cannot.

A monotonically increasing attention revision is updated transactionally for configure/respond/reserve/finalize/startup reservation recovery and portable merge, including changes while no memory is written. Node source-coherence checks read this revision. All future attention reserve/check paths consult imported union; merging into an unused table alone is insufficient.

## FS/DB journal, gates and same-ID lifecycle

Owned operation journal contains only operationID, packageDigest, targetID, expected fences, file hashes, DB stage/receipt IDs and phase; no password or bodies. Per-target blocking marker is durable before `portable.begin`; journal and marker writes use exclusive files, fsync, replace and verified parent directories. Existing target is backed up before formal writes. New target is built in an owned sibling staging directory and keeps source ID.

Phases: staged → blocked → persona_installed → db_committed → published_paused → reviewed/complete. The encrypted old-persona/snapshot backup is evidence, not an automatic rollback source. After each crash, startup retains blocking and reports status. If DB has no receipt, recovery may continue only the staged exact digest after fresh consent. If DB has a receipt, recovery can only reconcile/publish that exact persona; never reapply the snapshot over new writes. After publish-before-response, status returns the immutable receipt. Manifest/index and active same-ID epoch pointer publish last. New imports remain inactive until separately selected. Cancel before blocked is clean; later cancellation stays paused and reports what is already committed.

Proposed precise `character-persona.js` changes: new shared gate module exports assertTargetReady/isTargetBlocked; switchCharacter, updateCharacter, restoreSnapshot, bumpEpoch and package-visible reads check the target latch; same-ID fast return must not bypass it. Existing readCurrentCharacter returns identity for management diagnostics, annotated packagePaused, rather than returning null and causing default-role fallback. isCurrentEpoch returns false for blocked identity. The host/facade/channel owners add assertTargetReady before new bind/context/Writer/media/tool work and immediately before final delivery (also legacy mode), not merely during switch. Pending callbacks fail through generation invalidation. Only the package coordinator's private publication function can update a blocked target's files/epoch. These shared edits require owner integration and lifecycle tests before being considered effective.

Attempt2 host gates are independent of `mode`/`guarded`: captureTargetGate captures the
actual role ID/epoch, assertTargetGate checks the current identity and fresh durable
marker. Native legacy pet chat/purpose-model/voice entry, reply queue, final HTTP/poll/audio
boundaries check it; marker creation during a model await discards the result before history
or delivery. QQ bridge startup/incoming/model prompt and final queued OneBot transport do
the same; an old initialized bridge cannot follow a new role/epoch. Automatic startup and
manual pet start reject paused roles, while management diagnostics and role-package recovery
stay available. Settings pet errors retain code/error/hint. These are host-side authorization
gates, not a forced legacy-to-local migration or an authorization imported by a package.

## Schema and old-reader rejection

Root approved two layers: schema_compat helper checks supported user_version/min_reader_schema after exclusive lock + successful old-key decryption, **before journal/secure_delete/SCHEMA or any migration write**. Reject newer versions with SCHEMA_TOO_NEW, no initialization. Current new reader handles old and interrupted transition states explicitly; no old DB swap after formal writes.

Production DPAPI keyfile is forward-upgraded without rekeying SQLCipher: restricted owned backup of old keyfile, then atomic DPAPI-protected envelope with magic/schema/min_reader_schema and the original32-byte DB key, before new schema commit. Historical binary unwraps >32bytes and rejects its existing key-length check. No key value/hash goes into diagnostics/logs/package. Crash after envelope-before-schema leaves new reader able to open old schema and resume/pause from a migration journal; never silently restore old keyfile or create an empty DB. Missing/corrupt envelope preserves evidence and fails. Tests must execute a historical Store against an isolated Windows DPAPI library and observe KEY_UNAVAILABLE, not just simulate an old reader version. The explicit SURFCORE_LOCAL_KEY development bypass cannot constrain a truly historical binary; that limitation is documented and is not represented as production rollback safety.

## Design approval / implementation boundaries

The API and lifecycle gate design is approved for implementation; shared owners apply the hooks. New JS role-package format/coordinator/client/tests/case, Python portable_state/schema_compat and tests are worker-owned. storage/core/server, management/facade and index/channel hooks remain owner-applied patches; operation gates cannot be called complete before those hooks are applied and tested.

Concentrated design additions: native and portable reserve/check union by stable dedupeDigest; eventKey remains distinct accounting provenance. charged merges with OR; sent/unknown cannot be washed out by failed. Equal dedupe with conflicting timestamps is rejected. Test A→B→A and unknown→failed. SQLCipher permanently enforces UNIQUE(target,package_digest), with at most one unfinished begun operation per target. File marker includes operation ID and uses ownership CAS; cancellation/review of A cannot remove B marker/latch. A new operation for an already committed package returns its permanent receipt without replay; review rechecks committed memory epoch and persona digest. portable.* is private host coordinator stdio only, never a browser whitelist/JSON action. Package status/inspect/recovery/review stay available while ordinary bind/context/send are blocked. The coordinator acquires an unexported in-process stdio capability; browser role.package operations are a fixed dispatch allowlist. Manual restoration of historical key.dpapi and raw-key environment bypass are outside old-binary protection. Original Luyao/source/user directories are read-only; all SQLCipher/DPAPI/fault-injection tests use new isolated libraries. Deployment/device move/long-run remain separate NOT_VERIFIED.


## Implementation handoff

The native snapshot carries the existing .scmemory manifest and password-encrypted SQLCipher bytes as fixed fields (characterId,manifest,bytes,sha256,data), with independent Python validation; no live DB or ZIP copy. Private portable.receipt {target_character_id,package_digest} looks up permanent receipts before collision handling. Private portable.fence {character_id} and portable.diagnostics {} expose only coherence/compatibility data. portable.stage consumes the bounded owned attention_id JSON rather than a large stdio body.

Owner-applied Python/host patches and before snapshots are in .local/evidence/t5/attempt1/. Root/channel registered three exact routes and the upload-only octet-stream exception. Commands: .venv/Scripts/python.exe scripts/test-role-package.py; node scripts/test-role-package.mjs; node scripts/test-role-package-management.mjs. These exercise actual SQLCipher/Windows DPAPI, fixed historical Store, production coordinator/mount and actual DSH route wrapper. No real user profile/model API/platform account is used. Imported backend remains paused and proactive off even after package review. Required assets without a host verified-local-inventory callback remain explicit blockers; no package filename is opened or downloaded. Process crash checkpoints are verified; physical power-loss/disk-corruption recovery is not claimed.
