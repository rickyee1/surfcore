"""Window metadata only; enumeration never asks Windows for a thumbnail."""
import ctypes
from ctypes import wintypes
from dataclasses import dataclass
from pathlib import Path
import re


SENSITIVE = re.compile(r"password|credential|keychain|1password|bitwarden|keepass|authenticator|consent\.exe|logonui|winlogon|密码|凭据|验证码|密钥|认证器|Windows 安全", re.I)


@dataclass(frozen=True)
class WindowTarget:
    hwnd: int
    pid: int
    created: str
    executable: str
    title: str


def _check_desktop():
    import win32con
    import win32service
    desktop = win32service.OpenInputDesktop(0, False, win32con.DESKTOP_READOBJECTS)
    try:
        if win32service.GetUserObjectInformation(desktop, win32con.UOI_NAME).casefold() != "default":
            raise PermissionError("安全桌面不可捕获")
    finally:
        desktop.CloseDesktop()


def inspect_foreground(hwnd: int, excluded_pids=()):
    import win32process
    _check_desktop()
    if hwnd == 0:
        return None
    if type(hwnd) is not int or hwnd < 0:
        raise PermissionError("窗口无效")
    if win32process.GetWindowThreadProcessId(hwnd)[1] in excluded_pids:
        return None
    target = inspect_window(hwnd)
    if target.pid in excluded_pids:
        return None
    return target


def inspect_window(hwnd: int) -> WindowTarget:
    import win32api
    import win32con
    import win32gui
    import win32process
    import win32security

    if type(hwnd) is not int or hwnd <= 0:
        raise PermissionError("窗口无效")
    _check_desktop()
    shell_window = ctypes.WinDLL("user32").GetShellWindow
    shell_window.argtypes, shell_window.restype = [], wintypes.HWND
    if (not win32gui.IsWindow(hwnd) or not win32gui.IsWindowVisible(hwnd) or win32gui.IsIconic(hwnd)
            or win32gui.GetAncestor(hwnd, 2) != hwnd or hwnd in (win32gui.GetDesktopWindow(), shell_window())):
        raise PermissionError("窗口不可用")
    title = win32gui.GetWindowText(hwnd)
    if not title or len(title) > 512 or SENSITIVE.search(title):
        raise PermissionError("窗口标题未通过隐私检查")
    affinity = wintypes.DWORD()
    affinity_api = ctypes.WinDLL("user32", use_last_error=True).GetWindowDisplayAffinity
    affinity_api.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    affinity_api.restype = wintypes.BOOL
    if not affinity_api(hwnd, ctypes.byref(affinity)) or affinity.value:
        raise PermissionError("窗口受捕获保护")
    cloaked = wintypes.DWORD()
    dwm = ctypes.WinDLL("dwmapi").DwmGetWindowAttribute
    dwm.argtypes = [wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
    dwm.restype = ctypes.c_long
    if dwm(hwnd, 14, ctypes.byref(cloaked), ctypes.sizeof(cloaked)) != 0 or cloaked.value:
        raise PermissionError("窗口不可见")
    _thread, pid = win32process.GetWindowThreadProcessId(hwnd)
    process = win32api.OpenProcess(0x1000, False, pid)
    try:
        query = ctypes.WinDLL("kernel32", use_last_error=True).QueryFullProcessImageNameW
        query.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
        query.restype = wintypes.BOOL
        buffer, size = ctypes.create_unicode_buffer(32768), wintypes.DWORD(32768)
        if not query(int(process), 0, buffer, ctypes.byref(size)) or SENSITIVE.search(Path(buffer.value).name):
            raise PermissionError("应用未通过隐私检查")
        token = win32security.OpenProcessToken(process, win32con.TOKEN_QUERY)
        own_token = win32security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
        try:
            if (win32security.GetTokenInformation(token, win32security.TokenElevation)
                    or win32security.GetTokenInformation(token, win32security.TokenUser)[0]
                    != win32security.GetTokenInformation(own_token, win32security.TokenUser)[0]):
                raise PermissionError("不捕获其他用户或提升权限的应用")
        finally:
            token.Close()
            own_token.Close()
        created = win32process.GetProcessTimes(process)["CreationTime"].isoformat()
        return WindowTarget(hwnd, pid, created, str(Path(buffer.value).resolve()), title)
    finally:
        process.Close()


def verify_window(target: WindowTarget) -> None:
    if inspect_window(target.hwnd) != target:
        raise PermissionError("窗口身份或标题已变化")


def list_windows(excluded_pids=()) -> list[WindowTarget]:
    import win32gui
    result = []
    def add(hwnd, _):
        if len(result) >= 30:
            return
        try:
            target = inspect_window(hwnd)
            if target.pid not in excluded_pids:
                result.append(target)
        except Exception:
            pass
    win32gui.EnumWindows(add, None)
    return result
