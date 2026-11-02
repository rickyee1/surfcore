"""Pin a PortAudio selection to its live WASAPI endpoint and public properties."""
from dataclasses import dataclass
import hashlib
import json
from typing import Literal


DeviceKind = Literal["input", "output"]


class AudioDeviceError(RuntimeError):
    """Audio continuity was lost; discard the affected generation."""


def fingerprint(device: dict) -> str:
    if not isinstance(device.get("_endpoint_id"), str) or not device["_endpoint_id"] or device.get("_endpoint_active") is not True:
        raise AudioDeviceError("音频端点身份不可读或设备非活动，未启动音频；请重新选择或重启 Core")
    fields = {key: device[key] for key in (
        "_endpoint_id", "name", "hostapi_name", "max_input_channels", "max_output_channels", "default_samplerate",
    )}
    return hashlib.sha256(json.dumps(fields, sort_keys=True, ensure_ascii=True).encode("ascii")).hexdigest()


@dataclass(frozen=True)
class DeviceBinding:
    index: int
    kind: DeviceKind
    fingerprint: str

    def verify(self, devices: list[dict]) -> None:
        item = next((item for item in devices if item["id"] == self.index), None)
        if item is None or item[f"max_{self.kind}_channels"] < 1 or fingerprint(item) != self.fingerprint:
            raise ValueError("音频设备已变化，请刷新设备列表并重新选择")


def bind_device(devices: list[dict], kind: DeviceKind, index: int | None, expected: str | None = None) -> DeviceBinding:
    if kind not in ("input", "output"):
        raise ValueError("无效的音频方向")
    if index is None:
        if expected is not None:
            raise ValueError("系统默认设备不接受固定设备标识")
        item = next((item for item in devices if item.get(f"default_{kind}")), None)
    else:
        if type(index) is not int or index < 0 or not expected:
            raise ValueError("请刷新列表并重新选择音频设备")
        item = next((item for item in devices if item["id"] == index), None)
    if item is None or item[f"max_{kind}_channels"] < 1:
        raise ValueError("所选音频设备不可用，请重新选择")
    result = DeviceBinding(item["id"], kind, expected or fingerprint(item))
    result.verify(devices)
    return result
