"""Handle-pinned Windows local roots. No shell, path expansion or link following."""
import ctypes
from ctypes import wintypes
from contextlib import contextmanager, ExitStack
import os
from pathlib import PureWindowsPath
import re
from storage import ServiceError


def denied():
    return ServiceError('PATH_DENIED', '路径不在已登记的安全目录内。', '选择登记根内的普通文件或目录；链接、硬链接和设备路径不受支持。')


def windows_directory():
    if os.name != 'nt':
        raise denied()
    buffer = ctypes.create_unicode_buffer(32768)
    if not 0 < ctypes.windll.kernel32.GetWindowsDirectoryW(buffer, len(buffer)) < len(buffer):
        raise denied()
    return buffer.value


def relative_parts(value):
    if not isinstance(value, str) or len(value) > 1000 or '\x00' in value:
        raise denied()
    if value == '':
        return []
    if value.startswith(('\\', '/')) or ':' in value:
        raise denied()
    parts = re.split(r'[/\\]', value)
    if len(parts) > 12 or any(not p or p in ('.', '..') or p[-1] in ' .' or
                             re.search(r'[<>"|?*\x00-\x1f]', p) or
                             re.fullmatch(r'(?i)(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?', p) for p in parts):
        raise denied()
    return parts


def absolute_root(value):
    if not isinstance(value, str) or len(value) > 1000 or not re.match(r'^[A-Za-z]:[\\/]', value):
        raise denied()
    if not relative_parts(value[3:]) or value.startswith(('\\', '//')):
        raise denied()
    return str(PureWindowsPath(value))


class Pinned:
    def __init__(self, handle, path, identity, directory):
        self.handle, self.path, self.identity, self.directory = handle, path, identity, directory

    def read(self, limit=65536):
        if self.directory:
            raise denied()
        # Read the same kernel handle whose final path and link count were checked.
        buf, read = ctypes.create_string_buffer(limit + 1), wintypes.DWORD()
        read_file = ctypes.windll.kernel32.ReadFile
        read_file.argtypes = (wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p)
        if not read_file(self.handle, buf, limit + 1, ctypes.byref(read), None):
            raise denied()
        if read.value > limit:
            raise ServiceError('OUTPUT_LIMIT', '文件超过允许读取的大小。', '选择不超过 64 KiB 的 UTF-8 文本文件。')
        try:
            return buf.raw[:read.value].decode('utf-8-sig')
        except UnicodeError:
            raise ServiceError('INVALID_TEXT', '文件不是 UTF-8 文本。', '选择 UTF-8 文本文件。') from None


@contextmanager
def open_one(path, directory):
    if os.name != 'nt':
        raise ServiceError('PLATFORM_UNAVAILABLE', '文件工具需要 Windows 安全句柄校验。', '在 Windows 本机使用此工具。')
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateFileW.argtypes = (wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                                   wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE)
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.GetFinalPathNameByHandleW.argtypes = (wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD)
    kernel.GetFinalPathNameByHandleW.restype = wintypes.DWORD
    kernel.GetFileInformationByHandle.argtypes = (wintypes.HANDLE, ctypes.c_void_p)
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    class Info(ctypes.Structure):
        _fields_ = [('attrs', wintypes.DWORD), ('created', wintypes.FILETIME), ('accessed', wintypes.FILETIME),
                    ('written', wintypes.FILETIME), ('volume', wintypes.DWORD), ('size_high', wintypes.DWORD),
                    ('size_low', wintypes.DWORD), ('links', wintypes.DWORD), ('index_high', wintypes.DWORD), ('index_low', wintypes.DWORD)]
    # No FILE_SHARE_DELETE: every opened ancestor stays pinned through the operation.
    handle = kernel.CreateFileW(path, 0x80000000 if not directory else 0x80, 3, None, 3, 0x02200000, None)
    if handle == wintypes.HANDLE(-1).value:
        raise denied()
    try:
        info = Info()
        buf = ctypes.create_unicode_buffer(32768)
        count = kernel.GetFinalPathNameByHandleW(handle, buf, len(buf), 0)
        if not kernel.GetFileInformationByHandle(handle, ctypes.byref(info)) or not 0 < count < len(buf):
            raise denied()
        final = buf.value
        if not final.startswith('\\\\?\\') or final.startswith('\\\\?\\UNC\\'):
            raise denied()
        final = final[4:]
        if info.attrs & 0x400 or bool(info.attrs & 0x10) != directory or (not directory and info.links != 1):
            raise denied()
        if os.path.normcase(final) != os.path.normcase(str(PureWindowsPath(path))):
            raise denied()
        yield Pinned(handle, final, f'{info.volume:x}:{info.index_high:x}:{info.index_low:x}', directory)
    finally:
        kernel.CloseHandle(handle)


@contextmanager
def pinned_path(root, relative='', directory=True, expected_root=None, expected_target=None):
    root = absolute_root(root)
    parts = relative_parts(relative)
    # Pin each ancestor, including parents of the registered root, without following reparse points.
    path = PureWindowsPath(root)
    with ExitStack() as stack:
        current = str(path.anchor)
        for component in path.parts[1:]:
            current = str(PureWindowsPath(current) / component)
            node = stack.enter_context(open_one(current, True))
        base = node
        if expected_root and base.identity != expected_root:
            raise denied()
        for index, component in enumerate(parts):
            current = str(PureWindowsPath(current) / component)
            node = stack.enter_context(open_one(current, directory if index == len(parts) - 1 else True))
        if not parts and not directory:
            raise denied()
        if expected_target and node.identity != expected_target:
            raise ServiceError('TARGET_CHANGED', '确认后目标对象已被替换。', '重新发起并核对当前目标。')
        yield node


def lockscreen_state():
    """WTS current-session lock flag; failure stays explicit and fail-closed for tools."""
    if os.name != 'nt':
        return 'not_verified'
    class Level1(ctypes.Structure):
        _fields_ = [('session', wintypes.DWORD), ('state', ctypes.c_int), ('flags', wintypes.LONG),
                    ('station', wintypes.WCHAR * 33), ('user', wintypes.WCHAR * 21), ('domain', wintypes.WCHAR * 18),
                    ('logon', ctypes.c_longlong), ('connect', ctypes.c_longlong), ('disconnect', ctypes.c_longlong),
                    ('input', ctypes.c_longlong), ('current', ctypes.c_longlong),
                    ('incoming', wintypes.DWORD), ('outgoing', wintypes.DWORD), ('frames_in', wintypes.DWORD),
                    ('frames_out', wintypes.DWORD), ('compressed_in', wintypes.DWORD), ('compressed_out', wintypes.DWORD)]
    class Info(ctypes.Structure):
        _fields_ = [('level', wintypes.DWORD), ('data', Level1)]
    session, pointer, size = wintypes.DWORD(), ctypes.c_void_p(), wintypes.DWORD()
    api = ctypes.WinDLL('wtsapi32', use_last_error=True)
    api.WTSQuerySessionInformationW.argtypes = (wintypes.HANDLE, wintypes.DWORD, ctypes.c_int,
                                               ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.DWORD))
    api.WTSFreeMemory.argtypes = (ctypes.c_void_p,)
    if not ctypes.windll.kernel32.ProcessIdToSessionId(os.getpid(), ctypes.byref(session)):
        return 'not_verified'
    if not api.WTSQuerySessionInformationW(None, session, 25, ctypes.byref(pointer), ctypes.byref(size)):
        return 'not_verified'
    try:
        if size.value < ctypes.sizeof(Info):
            return 'not_verified'
        info = ctypes.cast(pointer, ctypes.POINTER(Info)).contents
        return {0: 'locked', 1: 'unlocked'}.get(info.data.flags, 'not_verified') if info.level == 1 else 'not_verified'
    finally:
        api.WTSFreeMemory(pointer)
