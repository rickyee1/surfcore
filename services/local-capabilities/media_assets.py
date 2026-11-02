"""Fixed CPU media assets. Verification runs only in media workers, never devices."""
import hashlib
import json
from pathlib import Path

HERE=Path(__file__).resolve().parent
MANIFEST=json.loads((HERE/'media-models.json').read_text(encoding='utf-8'))
ROOT=HERE.parents[1]/'.local'


def verify(groups=('asr','kws','vad')):
    if 'kws' in groups:
        item=MANIFEST['wake_file'];path=HERE/item['path']
        data=path.read_bytes()
        if len(data)!=item['bytes'] or hashlib.sha256(data).hexdigest()!=item['sha256']:raise ValueError('MEDIA_MODEL_INVALID')
    for item in MANIFEST['files']:
        relative=item['path']
        wanted=(('asr' in groups and MANIFEST['asr'] in relative) or ('kws' in groups and MANIFEST['kws'] in relative) or ('vad' in groups and relative.endswith('silero_vad.onnx')))
        if not wanted or '/test_wavs/' in relative:
            continue
        path=ROOT/relative
        for component in (path,*path.parents):
            info=component.lstat()
            if component.is_symlink() or getattr(info,'st_file_attributes',0)&0x400:
                raise ValueError('MEDIA_MODEL_INVALID')
        if path.stat().st_size!=item['bytes']:
            raise ValueError('MEDIA_MODEL_INVALID')
        with path.open('rb') as stream:
            if hashlib.file_digest(stream,'sha256').hexdigest()!=item['sha256']:
                raise ValueError('MEDIA_MODEL_INVALID')


def profiles():
    from media_native.asr import AsrProfile
    from media_native.speech_detectors import WakeProfile,VadProfile
    def transducer(name,asr):
        folder=ROOT/'models'/MANIFEST[name]
        prefix='epoch-99-avg-1' if asr else 'epoch-12-avg-2-chunk-16-left-64'
        return AsrProfile(name,folder/'tokens.txt',folder/f'encoder-{prefix}.int8.onnx',folder/f'decoder-{prefix}.onnx',folder/f'joiner-{prefix}.int8.onnx')
    return transducer('asr',True),WakeProfile(transducer('kws',False),HERE/'media-wake.txt'),VadProfile(ROOT/'models/silero_vad.onnx')
