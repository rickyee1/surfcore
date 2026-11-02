# T2b-P local semantic search — protocol v1

Fixed model: BAAI/bge-small-zh-v1.5, revision
7999e1d3359715c523056ef9478215996d62a620, CPU512 normalized dimensions.
No configurable provider/path, network, pickle weights or remote model code.
Optional packages are in requirements-semantic.txt. The normal memory.query
substring/keyword/recent contract is unchanged.

| Operation | Params | Result/authority |
| --- | --- | --- |
| memory.semantic.configure | `{enabled:boolean}` | Management; default false, disabling cancels work |
| memory.semantic.status | `{audience?:"session"|"character"}` | Current allowed-set coverage, fixed model/fingerprint, active job; character requires management |
| memory.semantic.query.start | `{query,limit?:1..20,audience?:"session"|"character",offset?:0,expected_memory_epoch?}` | Own binding; query<=1000 chars; async auto-builds missing cache for this page |
| memory.semantic.rebuild.start | `{audience?:"session"|"character",offset?:0,expected_memory_epoch?}` | Management; explicitly recomputes this page |
| memory.semantic.job.status | `{job_id}` | Only original opaque binding/role; no implicit management read of others' results |
| memory.semantic.job.cancel | `{job_id}` | Original binding; cancelled terminal, no late resurrection |

Defaults always use session audience, including management. Explicit character
audience allows management to work across the current character, never another
character or quarantined migration data. Normal visibility includes only the
existing session/public audiences and recursively active, current source proofs.
Identity is never accepted from params.

Start returns job_id/state/memory_epoch/character_epoch/model_fingerprint and
coverage. One global active slot, no unbounded queue. States are queued, running,
succeeded, failed, cancelled, stale. Status returns safe code/error/hint for failed,
cancelled or stale tasks. Query success has memories with semantic_score and the
ordinary memory record fields; rebuild success has indexed count. No status from
another binding reveals existence, counts, text or scores.

Coverage is `{eligible_count,offset,page_size:64,has_more,next_offset,complete}`.
Ordering is pinned DESC then newest existing rowid DESC; offset pages MUST supply
the first job's expected_memory_epoch. Any memory/character change makes the task
stale; pages cannot be mixed across epochs. Results are page-only when has_more is
true, not a full-library top-k. The host must expose that limitation and request the
next page explicitly. All allowed candidates are filtered before scoring or worker
text. The allowed active audience is bounded at4096 records, provenance depth64 and
256 nodes per record; excess returns an explicit limit error, never silent truncation.

An empty query uses the existing visible recent context and does not start a worker
or load an embedding model. Disabled configuration performs no idle inference;
no periodic model work. Nonempty queries/rebuild require enabled=true and a ready
unlocked tool authority (emergency/persistence fault cancels semantic work).

The single lazy subprocess only embeds bounded text via anonymous pipes, never
receives a DB path/key and does not import a database module. Its background I/O
thread handles model startup and pipe I/O, while the service authority continues
T3 polling/cancellation. CPU thread limit2, segments<=3500 chars, batches<=32.
Long segments are tokenizer-split before encoding rather than silently truncating
the tail. The authority validates finite normalized512 vectors and commits cache
only when current epoch, binding, record revision/body hash and recursive source
fingerprint still match. Embeddings and provenance stay in SQLCipher; no plaintext
vector side store, disk text jobs or model telemetry.

Cache is derived: source correction/suspension/deletion invalidates dependent
vectors; new unrelated episodes preserve valid cache. Restore clears character
vectors, cancels jobs, and never imports vectors/configuration/worker state from a
memory snapshot. Restart cancels unfinished jobs and never replays model inputs.
Cancel, role retire/switch, close, timeout and tool emergency discard late data.
No fallback provider or automatic retry/download. Missing/corrupt assets and missing
optional dependencies return explicit safe errors. Model/worker timeout120 seconds.
