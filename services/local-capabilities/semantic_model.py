"""Pinned offline embedding assets; standard library only on the authority path."""
import hashlib
import json
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODEL_DIRECTORY = HERE.parents[1] / '.local/models/bge-small-zh-v1.5'
MANIFEST = json.loads((HERE / 'semantic-model.json').read_text(encoding='utf-8'))
FINGERPRINT = hashlib.sha256(json.dumps(MANIFEST,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode('utf-8')).hexdigest()
DIMENSION = 512


class ModelFailure(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def verify_assets(directory):
    """Done in the worker before importing ML packages; never trust optional pickle files."""
    root = Path(directory)
    try:
        for path in (root, *root.parents):
            info = path.lstat()
            if path.is_symlink() or getattr(info,'st_file_attributes',0) & 0x400:
                raise ModelFailure('SEMANTIC_MODEL_CORRUPT')
        expected = {item['path']:item for item in MANIFEST['files']}
        observed = set()
        for parent, dirs, files in os.walk(root,followlinks=False):
            for name in dirs+files:
                child = Path(parent)/name
                info = child.lstat()
                if child.is_symlink() or getattr(info,'st_file_attributes',0) & 0x400:
                    raise ModelFailure('SEMANTIC_MODEL_CORRUPT')
            observed.update((Path(parent)/name).relative_to(root).as_posix() for name in files)
        if observed != set(expected):
            raise ModelFailure('SEMANTIC_MODEL_CORRUPT')
        for relative,item in expected.items():
            path = root/relative
            if path.stat().st_size != item['bytes']:
                raise ModelFailure('SEMANTIC_MODEL_CORRUPT')
            with path.open('rb') as stream:
                if hashlib.file_digest(stream,'sha256').hexdigest() != item['sha256']:
                    raise ModelFailure('SEMANTIC_MODEL_CORRUPT')
    except FileNotFoundError:
        raise ModelFailure('SEMANTIC_MODEL_MISSING') from None
    except OSError:
        raise ModelFailure('SEMANTIC_MODEL_UNAVAILABLE') from None


ERRORS = {
    'SEMANTIC_MODEL_MISSING': ('本地语义模型缺失。','恢复已声明 revision 的本地模型文件；不会联网下载或切换供应商。'),
    'SEMANTIC_MODEL_CORRUPT': ('本地语义模型文件校验失败。','保留文件并核对 semantic-model.json 的版本与 SHA256，恢复官方完整资产。'),
    'SEMANTIC_MODEL_UNAVAILABLE': ('本地语义模型文件无法读取。','检查本地模型目录权限后重试。'),
    'SEMANTIC_DEPENDENCY_MISSING': ('本地语义推理依赖缺失。','在独立环境安装 requirements-semantic.txt 后重启服务。'),
    'SEMANTIC_MODEL_FAILED': ('本地语义模型加载或推理失败。','检查固定模型与 CPU 依赖后重新发起；不会自动重试或外发正文。'),
    'SEMANTIC_WORKER_FAILED': ('本地语义工作进程中断。','核对内存与本地环境后重新发起；旧任务不会自动重放。'),
    'SEMANTIC_TIMEOUT': ('本地语义任务超过 120 秒。','缩小本页内容或检查本地 CPU 后重新发起。'),
    'SEMANTIC_INVALID_VECTOR': ('本地语义向量校验失败。','检查模型版本与完整性后重试；旧向量未写入。'),
}
