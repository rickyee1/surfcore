"""Offline CPU embedding subprocess. No database import/path/key or disk text jobs."""
from contextlib import redirect_stdout
import json
import sys
from semantic_model import DIMENSION, FINGERPRINT, MANIFEST, MODEL_DIRECTORY, ModelFailure, verify_assets


def load_model(directory):
    verify_assets(directory)
    try:
        import torch
        from sentence_transformers import SentenceTransformer
    except ImportError:
        raise ModelFailure('SEMANTIC_DEPENDENCY_MISSING') from None
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    model = SentenceTransformer(str(directory),device='cpu',local_files_only=True,trust_remote_code=False,
                                model_kwargs={'use_safetensors':True})
    if model.get_sentence_embedding_dimension() != DIMENSION:
        raise ModelFailure('SEMANTIC_MODEL_CORRUPT')
    model.max_seq_length = 512
    return model


def embed(model, items):
    import numpy as np
    fragments, owners = [], []
    for index,item in enumerate(items):
        # Token-aware splitting represents the tail rather than truncating long records.
        tokens = model.tokenizer(item['text'],add_special_tokens=False,truncation=False)['input_ids']
        if not tokens:
            raise ModelFailure('SEMANTIC_MODEL_FAILED')
        for offset in range(0,len(tokens),480):
            fragment = model.tokenizer.decode(tokens[offset:offset+480],skip_special_tokens=True)
            fragments.append((MANIFEST['query_instruction'] if item['query'] else '')+fragment)
            owners.append(index)
    encoded = model.encode(fragments,batch_size=32,normalize_embeddings=True,show_progress_bar=False,convert_to_numpy=True)
    result = []
    for index in range(len(items)):
        vector = np.mean(encoded[np.array(owners)==index],axis=0)
        norm = float(np.linalg.norm(vector))
        if not norm > 0:
            raise ModelFailure('SEMANTIC_INVALID_VECTOR')
        result.append((vector/norm).tolist())
    return result


def main(directory=MODEL_DIRECTORY):
    if hasattr(sys.stdin,'reconfigure'):
        sys.stdin.reconfigure(encoding='utf-8')
        sys.stdout.reconfigure(encoding='utf-8')
    model = None
    for line in sys.stdin:
        try:
            payload = json.loads(line)
            items = payload['items']
            if not isinstance(items,list) or not 1 <= len(items) <= 32 or any(not isinstance(item,dict) or
                    set(item)!= {'text','query'} or not isinstance(item['text'],str) or not 0<len(item['text'])<=3500 or
                    type(item['query']) is not bool for item in items):
                raise ModelFailure('SEMANTIC_WORKER_FAILED')
            # Libraries may print progress/warnings; protocol stdout remains vector-only.
            with redirect_stdout(sys.stderr):
                if model is None:
                    model = load_model(directory)
                vectors = embed(model,items)
            response = dict(ok=True,fingerprint=FINGERPRINT,vectors=vectors)
        except ModelFailure as error:
            response = dict(ok=False,code=error.code)
        except BaseException:
            response = dict(ok=False,code='SEMANTIC_MODEL_FAILED')
        print(json.dumps(response,separators=(',',':'),allow_nan=False),flush=True)
        if not response['ok']:
            break
        # No disk/cache payloads and no idle inference; next read blocks on the pipe.
        del line,payload,items,vectors,response


if __name__=='__main__':
    main()
