# T4-P media authority (protocol v1)

Every media operation requires management over trusted stdio. Browser routes must
expose only catalog/status/configure, confirmation of an already prepared object,
stop/revoke and local preview reads. Lease preparation/start, delivery preparation/
consume/validate and speech.start belong only to the trusted host. Model/browser
arguments cannot supply subject identity or selection. Subject must be a current
real platform=pet binding; shared owner memory never turns QQ/Bili into a device client.

Fixed model_selection keys: `{provider,model,config_revision,endpoint_identity,
adapter_id,adapter_revision,image_capable}`. All strings<=200, endpoint_identity is
nonsecret lowercase SHA256, image_capable boolean. Trusted host resolves this from
the actual fixed T3-H prepareCall selection; only an audited image adapter may set
image_capable=true. The service never receives model credentials or calls a model.

| Operation | Params / behavior |
| --- | --- |
| media.configure | `{enabled:boolean,output_provider?:"sapi"|"external"}`; preference only; disabling revokes all current character leases |
| media.status | `{}`; config, volatile leases/deliveries, output owner, generation, fault, physical_test=NOT_VERIFIED |
| media.catalog.start/status/cancel | start `{}`; status/cancel `{catalog_id}`; async metadata only; devices, SAPI voices and safe window refs; no capture/play |
| media.lease.prepare | `{subject_binding,mode:"ptt"|"handsfree"|"window"|"output",model_selection,input_ref?,output_ref?,voice_ref?,window_ref?,duration_seconds?,frame_limit?}` |
| media.lease.confirm | `{lease_id,expected_revision,confirmation_digest}`; cannot replace parameters, does not start hardware |
| media.lease.start | `{lease_id}`; separate explicit host action after confirm; post-commit worker launch |
| media.lease.pulse | `{lease_id}`; trusted host only, at most3s visible liveness, no renewal of signed authorization |
| media.lease.status | `{lease_id}`; original current character metadata, no implicit raw data |
| media.lease.stop | `{lease_id,discard?:boolean}`; default discard=true stops/revokes; PTT discard=false quiesces input and finishes local ASR for preview |
| media.lease.revoke | `{lease_id}`; cancels worker/results/delivery, no restart |
| media.stop | `{}`; current character revocation plus output flush; no automatic resume |
| media.events.poll | `{after?:sequence,limit?:1..32}`; bounded current-character local-only events, gap/overflow explicit |
| media.frame.read | `{lease_id,result_id,result_hash,offset?,limit?:1..262144}`; immutable same-frame PNG chunk base64, no recapture |
| media.delivery.prepare | `{lease_id,result_id,result_hash,host_request_id,turn_id,context_ref,expected_memory_epoch}`; PTT/window awaiting_confirmation, handsfree authorized by explicit continuous lease |
| media.delivery.confirm | `{delivery_id,expected_revision,confirmation_digest}`; exact preview/result/target review, no replacement or renewed TTL |
| media.delivery.consume/validate | `{delivery_id,subject_binding,host_request_id,turn_id,context_ref,model_selection}`; consume returns once, validate no raw body, exact fixed selection and current permission/turn/expiry |
| media.delivery.finalize | `{delivery_id,outcome:"sent"|"failed"|"unknown"}`; receipt only, consumed is unconfirmed and not replayable |
| media.speech.start | `{lease_id,delivery_id,subject_binding,host_request_id,turn_id,context_ref,model_selection,text}`; one local SAPI PCM owner, current delivery/turn, <=4000 chars |
| media.speech.stop | `{lease_id}`; flushes current output/turn, never resumes old synth |

PTT defaults30s/max30; handsfree defaults900s/max900; window defaults single frame,
or explicitly <=60s/max3 frames; output lease<=900s. Confirmation/prepared TTL60s,
active duration starts only with explicit start but never exceeds the signed expiry.
No lease is restored on restart. KWS phrase is fixed 你好路遥. PTT is local transcript
preview until explicit Send confirmation. Handsfree's lease summary explicitly covers
local KWS/VAD/AEC/ASR, each transcript to the same selected model, original pet reply
and one local speech output. Each round still needs a new host fixed-model prepare/
delivery; no cross-turn handle reuse. All leases bind role epoch, original pet triple,
permission generation and selected endpoint/window identity. Selection changes revoke.

Window preview/read/upload uses the same frame hash, <=640px/1.5MiB PNG. Screen
inputs and derived answers are `memory_write:false,history_write:false`; do not enter
pet/DSH history. PTT transcript Send can be separately treated as ordinary user input
by the host, but media itself writes no memory. No raw PCM/images/text in DB/logs.
Delivery TTL<=120s and never beyond lease; every await and actual external send or
playback needs validate. Model input never grants tool operations or memory writing.

Single output owner: SAPI synthesizes in-memory PCM, then controlled WASAPI output;
handsfree uses that same output as AEC reverse reference. While media SAPI preference
is enabled host/Electron must suppress legacy audioKey/voxd playback, even on SAPI
failure. Existing external voxd preference/configuration is retained, never replaced
as fallback. Handsfree requires controlled SAPI output, not independent external audio.

Media workers run in a parent-owned Windows kill-on-close Job Object; anonymous
pipes only, no DB/key/model credentials. ASR/KWS/VAD model files are fixed manifest
assets, CPU only, no downloads. Native driver/model/WGC/COM work is outside JSONL.
Authority polling checks WTS, tool persistence fault/emergency, role/binding, lease
expiry and heartbeat. Revocation/interrupt/lock/exit invalidates turns, flushes and
terminates workers; late callbacks cannot restore data or playback. Queues are bounded
and overflow errors visible. Real device acceptance remains for user activation.

## Human/host sequence

PTT: choose explicit input and fixed model → prepare/display lease → confirm →
separate start on button-down → button-up host calls lease.stop with discard:false.
That mode only quiesces PTT input and finalizes local ASR; it cannot extend recording
or enter a continuous session. Show immutable transcript locally. Host prepares one
fixed model context for this result; delivery.prepare binds its context_ref/current
expected_memory_epoch. Only the user's explicit Send confirms it, then host consumes
once, validates before/after awaits and before pet delivery. It must not mutate that
context/epoch or refresh this permit via a new context. Optional ordinary-input history
handling is separate; media itself never writes memory/history. If the host chooses to
write ordinary input first, obtain the final context before the first delivery.prepare;
it cannot re-prepare an already bound result to follow a newer epoch.

Handsfree: visibly show input/output/voice, fixed model, continuous transcript-to-model
purpose and900s maximum; confirm then explicit start. Every utterance gets a new source
turn and a new host fixed-context prepare/delivery, even under the same selection. Barge-in
revokes the old turn, including pending text and speech. No handle survives a new turn.

Window: show exact window and audited image destination before capture lease approval;
then explicit capture. Preview frame.read chunks of the same result_hash, no second
capture. Delivery preparation binds fixed context/epoch and same hash; user's Ask confirms
that prepared frame. Upload and derived reply remain memory_write=false/history_write=false.

Every delivery has a fixed <=120s TTL, bounded by its source lease. Confirm does not renew
it. Confirm/consume/validate/speech.start recheck current epoch and original context_ref.
Wrong selection closes media; permission, role, WTS, expiry, emergency, parent exit and
revoke always discard (PTT preview included). No discard:false branch can bypass these.

Lease metadata includes immutable targets (selected input/output fingerprints and names,
voice identity, window HWND/PID/creation/title), original pet triple, exact purposes,
fixed selection, signed expiry, worker_state and voice_level. Display those actual
prepared targets before confirmation; do not reconstruct a different selection from
frontend defaults. Both wall-clock expiry and monotonic duration limits apply, so
clock rollback cannot renew capture/delivery. Initial window capture has an8s native
job deadline; model/audio startup20s, running heartbeat2s, catalog30s. Native speech
render reference is exactly the controlled output, not a synthetic noise-gate AEC.

Volatile bounds: at most16 lease descriptors/16 raw result slots/24 deliveries per
service, max3 retained PNGs,64 events and8MiB incoming event bytes,4 child slots and
32 queued commands per child. Overflow is visible and stops the affected device;
metadata/history cannot become an unbounded raw capture log. A stop/restart begins
fresh authority, without automatically reacquiring any device.

## Visible-control liveness

Keep the control page visibly open while recording, awaiting local ASR, previewing,
asking the model or playing a media reply. Explicit start creates an initial3s
visibility window. Trusted host sends lease.pulse only after a recent heartbeat from
that same visible control page/original pet, normally every750ms. It must not run an
unconditional background renewal timer. Pulse carries no new target/selection and
only moves visibility_deadline to min(now+3s,original signed deadline); permission,
purpose, role, devices, source result and signed expiry stay fixed. Pulse cannot start,
reopen an expired/stopped lease or restore a discarded preview. Hidden UI, renderer
loss or stale pulse makes authority's independent50ms poll discard and kill workers;
reopening requires fresh preparation/confirmation/start. PTT discard:false is also
subject to this liveness and never extends recording or preview permission.

## Attempt2: ongoing speech dependencies and final native boundaries

Public operation fields are unchanged. An independent output lease does not grant
permission to continue a reply after its source lease/result/turn, delivery epoch,
original deadline or visible-control heartbeat becomes invalid. The authority checks
that dependency during its independent poll and after transaction commit, sending a
generation-specific speech cancellation to the output owner. A handsfree cancellation
flushes that reply without reacquiring or extending the microphone lease. `sent` is a
delivery receipt, not playback completion: it preserves still-valid in-flight speech;
`reply.finished` ends playback tracking. Neither state extends the original TTL.

The internal worker pipe carries the original wall-clock and monotonic lease/delivery
deadlines plus the original source generation. Worker control invalidates synthesis
tokens immediately when it reads speech.stop; late SAPI buffers cannot enter PCM queues.
Each queued render callback rechecks that same speech permit and discards invalid PCM;
duplex renders silence while retaining otherwise-authorized capture. Pulse only moves
visibility (at most3s and never beyond the signed deadline), including source visibility
for a separate output owner. A completed window worker stays exited while the same
immutable preview remains readable under its live visible lease.

Post-commit start/speech actions revalidate before sending work. Native identity checks,
model initialization, input/output stream construction/start and WGC start/copy all have
checks after potentially slow setup and before the next device boundary. Exact expiry
is denied for both clocks and visibility. Handsfree no longer clamps expired settings
to a fresh1s; observing expiry is irreversible for that worker permit. These checks
require the original authorization and do not refresh model, role, purpose or selection.
