"""WASAPI endpoint identity and notification lifetime; no audio activation here."""
from contextlib import contextmanager
import ctypes as C
import os
import sys
import threading
from uuid import UUID

from media_native.audio_devices import AudioDeviceError, bind_device, fingerprint


PORTAUDIO_LOCK = threading.RLock()
_active_streams = 0
_failed_cleanup = {}
_cleanup_retries = 0
DEFAULT_ROLE = 1  # eMultimedia in the adopted PortAudio DLL, not eConsole.
CLEANUP = "音频原生资源释放未确认，未启动新的语音；请显式停止重试，仍失败时重启 Core"
UNAVAILABLE = "无法核验 Windows 音频端点身份，未启动音频；请检查设备并显式重启 Core"
CHANGED = "音频端点已移除、停用或切换，本次语音已停止；请重新选择设备"
RESTART = "音频设备列表已变化，此 PortAudio 不支持安全热刷新；请停止语音并显式重启 Core"


def retain_cleanup(owner, retry):
    with PORTAUDIO_LOCK:
        _failed_cleanup[owner] = retry


def cleanup_complete(owner):
    with PORTAUDIO_LOCK:
        _failed_cleanup.pop(owner, None)


def require_clean_audio():
    with PORTAUDIO_LOCK:
        if _failed_cleanup or _cleanup_retries:
            raise AudioDeviceError(CLEANUP)


def retry_failed_cleanup():
    """Explicit control-thread retry; never called by notification/audio callbacks."""
    global _cleanup_retries
    with PORTAUDIO_LOCK:
        pending = list(_failed_cleanup.items())
        if not pending:
            require_clean_audio()
            return
        _cleanup_retries += 1
    try:
        # Strong snapshot references and the retry count inhibit replacement
        # until callbacks finish, even if another cleanup removes their owners.
        # Never acquire a transport's control lock while holding the PA lock.
        for owner, retry in pending:
            with PORTAUDIO_LOCK:
                retained = owner in _failed_cleanup
            if not retained:
                continue
            try:
                retry()
            except Exception:
                pass
    finally:
        with PORTAUDIO_LOCK:
            _cleanup_retries -= 1
    require_clean_audio()


def close_stream(stream, action=None):
    """Check sounddevice native returns; an uncertain close requires Core restart."""
    if getattr(stream, "_close_uncertain", False):
        raise AudioDeviceError(CLEANUP)
    sd = sys.modules.get("sounddevice")
    base = getattr(sd, "_StreamBase", None)

    def invoke(name):
        method = getattr(stream, name)
        if base is not None and getattr(method, "__func__", None) is getattr(base, name):
            return method(ignore_errors=False)
        return method()  # Explicitly injected streams, never a production fallback.

    action_error = None
    if action:
        try:
            invoke(action)
        except Exception as exc:
            action_error = exc
    pointer = getattr(stream, "_ptr", None)
    try:
        invoke("close")
    except BaseException:
        # sounddevice clears _ptr even when Pa_CloseStream failed. Do not restore
        # or reuse an ambiguous handle; retain its callback/lease and inhibit PA.
        stream._close_uncertain = True
        stream._uncertain_pointer = pointer
        raise AudioDeviceError(CLEANUP) from None
    return action_error


class GUID(C.Structure):
    _fields_ = [("data1", C.c_uint32), ("data2", C.c_uint16), ("data3", C.c_uint16), ("data4", C.c_ubyte * 8)]

    @classmethod
    def parse(cls, value):
        return cls.from_buffer_copy(UUID(value).bytes_le)


class PROPERTYKEY(C.Structure):
    _fields_ = [("fmtid", GUID), ("pid", C.c_uint32)]


def _method(pointer, slot, result, *arguments):
    table = C.cast(pointer, C.POINTER(C.POINTER(C.c_void_p))).contents
    return C.WINFUNCTYPE(result, C.c_void_p, *arguments)(table[slot])


def _hr(value):
    if value < 0:
        raise AudioDeviceError(UNAVAILABLE)


class _Notification:
    """Keep the ctypes object and all eight vtable callbacks alive until unregister."""
    def __init__(self, signal):
        self.references = 1
        unknown = GUID.parse("00000000-0000-0000-c000-000000000046")
        notification = GUID.parse("7991eec9-7e89-4d85-8390-6c703cec60c0")

        def query(_this, iid, target):
            if not iid or not target:
                return -2147467261  # E_POINTER
            target[0] = None
            if bytes(iid.contents) not in (bytes(unknown), bytes(notification)):
                return -2147467262  # E_NOINTERFACE
            target[0] = C.cast(self.object, C.c_void_p).value
            self.references += 1
            return 0

        def add(_this):
            self.references += 1
            return self.references

        def release(_this):
            self.references = max(0, self.references - 1)
            return self.references

        def deliver(kind, endpoint, flow=None, role=None):
            try:
                signal(kind, endpoint, flow, role)
                return 0
            except BaseException:
                # A callback may only invalidate; never log raw endpoint IDs.
                signal("failed", None, None, None)
                return 0

        signatures = [
            (C.c_int32, (C.POINTER(GUID), C.POINTER(C.c_void_p)), query),
            (C.c_uint32, (), add), (C.c_uint32, (), release),
            (C.c_int32, (C.c_wchar_p, C.c_uint32), lambda _t, e, _s: deliver("state", e)),
            (C.c_int32, (C.c_wchar_p,), lambda _t, e: deliver("added", e)),
            (C.c_int32, (C.c_wchar_p,), lambda _t, e: deliver("removed", e)),
            (C.c_int32, (C.c_int32, C.c_int32, C.c_wchar_p), lambda _t, f, r, e: deliver("default", e, f, r)),
            (C.c_int32, (C.c_wchar_p, PROPERTYKEY), lambda _t, e, _k: deliver("property", e)),
        ]
        self.callbacks = [C.WINFUNCTYPE(result, C.c_void_p, *args)(fn) for result, args, fn in signatures]
        self.table = (C.c_void_p * 8)(*[C.cast(fn, C.c_void_p).value for fn in self.callbacks])
        self.object = (C.c_void_p * 1)(C.cast(self.table, C.c_void_p).value)
        self.pointer = C.cast(self.object, C.c_void_p)


class NativeEndpointSDK:
    def __init__(self, sd, *, library=None, ole=None):
        if os.name != "nt":
            raise AudioDeviceError(UNAVAILABLE)
        self.library = library if library is not None else C.CDLL(sd._libname)
        self.get_device = self.library.PaWasapi_GetIMMDevice
        self.get_device.argtypes = [C.c_int, C.POINTER(C.c_void_p)]
        self.get_device.restype = C.c_int
        self.update = self.library.PaWasapi_UpdateDeviceList
        self.update.argtypes, self.update.restype = [], C.c_int
        self.ole = ole if ole is not None else C.WinDLL("ole32")
        self.ole.CoInitializeEx.argtypes = [C.c_void_p, C.c_uint32]
        self.ole.CoInitializeEx.restype = C.c_int32
        self.ole.CoUninitialize.argtypes, self.ole.CoUninitialize.restype = [], None
        self.ole.CoTaskMemFree.argtypes, self.ole.CoTaskMemFree.restype = [C.c_void_p], None
        self.ole.CoCreateInstance.argtypes = [C.POINTER(GUID), C.c_void_p, C.c_uint32, C.POINTER(GUID), C.POINTER(C.c_void_p)]
        self.ole.CoCreateInstance.restype = C.c_int32

    @contextmanager
    def apartment(self, *, notification=False):
        # S_OK and S_FALSE both require a matching uninitialize on this thread.
        result = self.ole.CoInitializeEx(None, 0)
        # PortAudio's desktop initialization uses CoInitialize (STA). Read-only
        # calls may use that existing apartment; notification ownership stays MTA.
        if result == -2147417850 and not notification:  # RPC_E_CHANGED_MODE
            result = self.ole.CoInitializeEx(None, 2)
        _hr(result)
        try:
            yield
        finally:
            self.ole.CoUninitialize()

    def enumerator(self):
        pointer = C.c_void_p()
        clsid = GUID.parse("bcde0395-e52f-467c-8e3d-c4579291692e")
        iid = GUID.parse("a95664d2-9614-4f35-a746-de8db63617e6")
        _hr(self.ole.CoCreateInstance(C.byref(clsid), None, 1, C.byref(iid), C.byref(pointer)))
        if not pointer:
            raise AudioDeviceError(UNAVAILABLE)
        return pointer

    @staticmethod
    def release(pointer):
        _method(pointer, 2, C.c_uint32)(pointer)

    def identity(self, pointer):
        value = C.c_void_p()
        try:
            _hr(_method(pointer, 5, C.c_int32, C.POINTER(C.c_void_p))(pointer, C.byref(value)))
            if not value:
                raise AudioDeviceError(UNAVAILABLE)
            result = C.wstring_at(value)
            if not result or len(result) > 4096:
                raise AudioDeviceError(UNAVAILABLE)
            return result
        finally:
            if value:
                self.ole.CoTaskMemFree(value)

    def devices(self, sd):
        with self.apartment():
            enumerator = self.enumerator()
            collection = C.c_void_p()
            try:
                _hr(_method(enumerator, 3, C.c_int32, C.c_int32, C.c_uint32, C.POINTER(C.c_void_p))(
                    enumerator, 2, 1, C.byref(collection)))  # eAll, DEVICE_STATE_ACTIVE
                count = C.c_uint32()
                _hr(_method(collection, 3, C.c_int32, C.POINTER(C.c_uint32))(collection, C.byref(count)))
                if count.value > 256:
                    raise AudioDeviceError(UNAVAILABLE)
                live = set()
                for index in range(count.value):
                    endpoint = C.c_void_p()
                    _hr(_method(collection, 4, C.c_int32, C.c_uint32, C.POINTER(C.c_void_p))(
                        collection, index, C.byref(endpoint)))
                    try:
                        live.add(self.identity(endpoint))
                    finally:
                        self.release(endpoint)
                defaults = {}
                for kind, flow in (("input", 1), ("output", 0)):
                    endpoint = C.c_void_p()
                    result = _method(enumerator, 4, C.c_int32, C.c_int32, C.c_int32, C.POINTER(C.c_void_p))(
                        enumerator, flow, DEFAULT_ROLE, C.byref(endpoint))
                    if result == -2147023728:  # E_NOTFOUND: no default in this direction
                        defaults[kind] = None
                        continue
                    _hr(result)
                    try:
                        defaults[kind] = self.identity(endpoint)
                    finally:
                        self.release(endpoint)
                apis, listed, mapped = sd.query_hostapis(), [], set()
                for index, item in enumerate(sd.query_devices()):
                    if "WASAPI" not in apis[item["hostapi"]]["name"]:
                        continue
                    pointer = C.c_void_p()
                    if self.get_device(index, C.byref(pointer)) != 0 or not pointer:
                        raise AudioDeviceError(UNAVAILABLE)
                    # PortAudio returns a borrowed IMMDevice with no AddRef.
                    # Consume it under PORTAUDIO_LOCK; never Release or retain it.
                    identity = self.identity(pointer)
                    state = C.c_uint32()
                    _hr(_method(pointer, 6, C.c_int32, C.POINTER(C.c_uint32))(pointer, C.byref(state)))
                    mapped.add(identity)
                    listed.append(dict(item, id=index, hostapi_name=apis[item["hostapi"]]["name"],
                        _endpoint_id=identity, _endpoint_active=state.value == 1 and identity in live,
                        default_input=identity == defaults["input"], default_output=identity == defaults["output"]))
                if live != mapped or any(not item["_endpoint_active"] for item in listed):
                    raise AudioDeviceError(RESTART)
                return listed
            finally:
                if collection:
                    self.release(collection)
                self.release(enumerator)

    def refresh(self):
        with PORTAUDIO_LOCK:
            require_clean_audio()
            if _active_streams:
                raise AudioDeviceError(RESTART)
            with self.apartment():
                # The export is a paInternalError stub unless compiled with a
                # nonzero PA_WASAPI_MAX_CONST_DEVICE_COUNT. Never Terminate/Initialize.
                return self.update() == 0

    def watch(self, signal):
        return _NativeWatch(self, signal)


class _NativeWatch:
    def __init__(self, sdk, signal):
        self.sdk, self.signal = sdk, signal
        self.ready, self.request, self.done = threading.Event(), threading.Event(), threading.Event()
        self.error = None
        self.registered = False
        self.thread = threading.Thread(target=self._run, daemon=True, name="wasapi-endpoint-notifications")
        self.thread.start()
        if not self.ready.wait(2):
            self.request.set()
            retain_cleanup(self, self.close)
            raise AudioDeviceError(UNAVAILABLE)
        if self.error:
            self.thread.join(timeout=2)
            if self.thread.is_alive():
                retain_cleanup(self, self.close)
            raise AudioDeviceError(UNAVAILABLE)

    def _run(self):
        enumerator = None
        try:
            with self.sdk.apartment(notification=True):
                try:
                    enumerator = self.sdk.enumerator()
                    client = _Notification(self.signal)
                    _hr(_method(enumerator, 6, C.c_int32, C.c_void_p)(enumerator, client.pointer))
                    self.registered = True
                    self.ready.set()
                    while self.registered:
                        self.request.wait()
                        self.request.clear()
                        try:
                            _hr(_method(enumerator, 7, C.c_int32, C.c_void_p)(enumerator, client.pointer))
                            self.registered = False
                            self.error = None
                        except Exception:
                            # Keep callback, enumerator and MTA alive on failure.
                            # Explicit close can retry; late callbacks only signal.
                            self.error = AudioDeviceError(UNAVAILABLE)
                        self.done.set()
                finally:
                    if enumerator and not self.registered:
                        self.sdk.release(enumerator)
        except BaseException:
            self.error = AudioDeviceError(UNAVAILABLE)
        finally:
            self.ready.set()
            self.done.set()

    def close(self):
        try:
            if self.thread.is_alive():
                self.done.clear()
                self.request.set()
                if not self.done.wait(2):
                    raise AudioDeviceError(UNAVAILABLE)
            if self.registered:
                raise AudioDeviceError(UNAVAILABLE)
            self.thread.join(timeout=2)
            if self.thread.is_alive():
                raise AudioDeviceError(UNAVAILABLE)
        except BaseException:
            retain_cleanup(self, self.close)
            raise
        cleanup_complete(self)


class EndpointAccess:
    def __init__(self, sd, sdk=None):
        self.sd, self._sdk = sd, sdk

    @property
    def sdk(self):
        if self._sdk is None:
            try:
                self._sdk = NativeEndpointSDK(self.sd)
            except Exception:
                raise AudioDeviceError(UNAVAILABLE) from None
        return self._sdk

    def devices(self):
        with PORTAUDIO_LOCK:
            require_clean_audio()
            try:
                return self.sdk.devices(self.sd)
            except AudioDeviceError as exc:
                if str(exc) != RESTART or _active_streams:
                    raise
                if not self.sdk.refresh():
                    raise AudioDeviceError(RESTART) from None
                return self.sdk.devices(self.sd)
            except Exception:
                raise AudioDeviceError(UNAVAILABLE) from None


class EndpointLease:
    def __init__(self, access, selections):
        global _active_streams
        self.access, self.invalid, self.closed = access, False, False
        self.watch = None
        self.counted = False
        self.bindings = []
        with PORTAUDIO_LOCK:
            listed = access.devices()
            for kind, index, binding in selections:
                if binding is None:
                    expected = None if index is None else fingerprint(next((item for item in listed if item["id"] == index), {}))
                    binding = bind_device(listed, kind, index, expected)
                if binding.kind != kind:
                    raise AudioDeviceError(CHANGED)
                binding.verify(listed)
                self.bindings.append(binding)
            self.identities = {item["_endpoint_id"] for item in listed if any(b.index == item["id"] for b in self.bindings)}
            self.flows = {1 if b.kind == "input" else 0 for b in self.bindings}
            _active_streams += 1
            self.counted = True
            try:
                self.watch = access.sdk.watch(self.signal)
                self.verify()
            except BaseException:
                self.close()
                raise

    def signal(self, kind, endpoint, flow, role=DEFAULT_ROLE):
        # Native callback: only a monotonic flag, no locks, COM or stream work.
        # Only the DLL's multimedia role is relevant, conservatively for every
        # selected endpoint in that direction (including an explicit selection).
        if not self.closed and (kind == "failed" or kind == "default" and role == DEFAULT_ROLE and flow in self.flows
                                or kind in {"removed", "state", "property"} and endpoint in self.identities):
            self.invalid = True

    def check(self):
        if self.invalid or self.closed:
            raise AudioDeviceError(CHANGED)

    def verify(self):
        self.check()
        listed = self.access.devices()
        for binding in self.bindings:
            binding.verify(listed)
        self.check()

    def close(self):
        global _active_streams
        self.invalid = self.closed = True
        with PORTAUDIO_LOCK:
            try:
                if self.watch is not None:
                    self.watch.close()
                    self.watch = None
            except BaseException:
                retain_cleanup(self, self.close)
                raise
            if self.counted:
                _active_streams -= 1
                self.counted = False
            cleanup_complete(self)
