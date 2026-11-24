"""GPT-SoVITS 语义缓存适配器（随 dsh-roost 分发）。

源自扩展市场「语音回复」的 service-runner.py，ISC License：
Copyright (c) 2026 voice-reply contributors
Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.
THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES.

只代理 api_v2.py、不改用户目录里的任何第三方文件。
用法：APP_DIR/runtime/python.exe gpt-semantic-adapter.py --app-dir APP_DIR
    --host 127.0.0.1 --port 17860 [--config GPT_SoVITS/configs/tts_infer.yaml]

只缓存最近一次完整成功、非流式推理的 **GPT 语义 token**，不缓存音频或随机种子。
需复用时向 /voice-reply/tts POST {"if_freeze": true, ...常规 tts 参数}。
"""

import argparse
import asyncio
import copy
import hashlib
import json
import os
from pathlib import Path
import runpy
import sys
import threading

ADAPTER_VERSION = "1.1.4"
MAX_CACHE_BYTES = 16 * 1024 * 1024
MAX_CACHE_BATCHES = 256


def _cpu_copy(value):
    if hasattr(value, "detach") and hasattr(value, "clone"):
        return value.detach().cpu().clone()
    if isinstance(value, tuple):
        return tuple(_cpu_copy(v) for v in value)
    if isinstance(value, list):
        return [_cpu_copy(v) for v in value]
    if hasattr(value, "copy"):
        return value.copy()
    return copy.deepcopy(value)


def _restore(value, device):
    if hasattr(value, "detach") and hasattr(value, "clone"):
        return value.clone().to(device=device)
    if isinstance(value, tuple):
        return tuple(_restore(v, device) for v in value)
    if isinstance(value, list):
        return [_restore(v, device) for v in value]
    return _cpu_copy(value)


def _bytes(value):
    if hasattr(value, "numel") and hasattr(value, "element_size"):
        return value.numel() * value.element_size()
    if hasattr(value, "nbytes"):
        return int(value.nbytes)
    if isinstance(value, (list, tuple)):
        return 64 + sum(_bytes(v) for v in value)
    return 32


def _tolist(value):
    if hasattr(value, "detach"):
        value = value.detach().cpu()
    return value.tolist() if hasattr(value, "tolist") else value


def _gpt_identity(pipeline):
    # Read the live served config, not a request-provided claimed model name.
    path = getattr(pipeline.configs, "t2s_weights_path", None)
    if not path:
        return ("untracked-model", id(pipeline.t2s_model.model))
    path = os.path.normcase(os.path.abspath(os.fspath(path)))
    try:
        stat = os.stat(path)
        return (path, stat.st_size, stat.st_mtime_ns)
    except OSError:
        return (path, None, None)


class SemanticCache:
    """One pipeline, one complete cache, bounded CPU storage.

    ASGI serializes model-mutating requests over the entire response lifetime.
    The nonblocking guard also rejects concurrent direct Python callers instead
    of waiting on a lock on the API event loop. No lock is acquired twice.
    """
    def __init__(self, pipeline, max_bytes=MAX_CACHE_BYTES, max_batches=MAX_CACHE_BATCHES):
        self.pipeline = pipeline
        self.max_bytes = max_bytes
        self.max_batches = max_batches
        self.latest = None
        self.last_result = "miss"
        self._guard = threading.Lock()
        self._original_run = pipeline.run

    def install(self):
        self.pipeline.run = self.run
        return self

    def _key(self, req):
        return (
            req.get("text", ""), req.get("text_lang", ""),
            req.get("text_split_method", "cut5"), _gpt_identity(self.pipeline),
            req.get("batch_size", 1), req.get("batch_threshold", 0.75),
            req.get("split_bucket", True), req.get("parallel_infer", True),
            getattr(self.pipeline.configs, "hz", None),
            getattr(self.pipeline.configs, "max_sec", None),
        )

    def _batch_signature(self, args, kwargs):
        # to_batch prepends reference phones. Strip precisely that prefix so a
        # new reference voice can reuse target semantics without mixing batches.
        phones = args[0] if args else kwargs.get("x")
        prompts = args[2] if len(args) > 2 else kwargs.get("prompts")
        prefix = self.pipeline.prompt_cache.get("phones")
        prefix = _tolist(prefix) if prompts is not None and prefix is not None else []
        target = []
        for row in phones:
            row = _tolist(row)
            if prefix:
                if row[:len(prefix)] != prefix:
                    raise ValueError("Unexpected reference-phone prefix")
                row = row[len(prefix):]
            target.append(row)
        return hashlib.sha256(json.dumps(target, separators=(",", ":")).encode()).digest()

    def run(self, req):
        if not self._guard.acquire(blocking=False):
            raise RuntimeError("Voice inference is busy; retry after the current request")
        original_methods = {}
        model = None
        generator = None
        staged = []
        used = 0
        saw_audio = False
        exhausted = False
        eligible = not req.get("streaming_mode", False) and not req.get("return_fragment", False)
        index = 0
        cacheable = eligible
        self.last_result = "miss" if eligible else "bypass"
        try:
            key = self._key(req)
            previous = self.latest if eligible and req.get("if_freeze") is True else None
            previous = previous if previous and previous[0] == key else None
            all_hit = bool(previous)
            if eligible:
                model = self.pipeline.t2s_model.model
                infer_active = False

                def wrap(original):
                    def infer(*args, **kwargs):
                        nonlocal index, used, cacheable, all_hit, infer_active
                        # Prompt-free batch_infer delegates to naive_batched.
                        # Record only the outer call, including that fallback.
                        if infer_active:
                            return original(*args, **kwargs)
                        try:
                            signature = self._batch_signature(args, kwargs)
                        except (TypeError, ValueError, AttributeError):
                            signature = None
                            cacheable = False
                        record = previous[1][index] if previous and index < len(previous[1]) else None
                        if signature is not None and record and record[0] == signature:
                            output = _restore(record[1], self.pipeline.configs.device)
                        else:
                            all_hit = False
                            infer_active = True
                            try:
                                output = original(*args, **kwargs)
                            finally:
                                infer_active = False
                        index += 1
                        if cacheable:
                            try:
                                predictions, indices = output
                                if len(predictions) != len(indices) or not predictions:
                                    raise ValueError("Incomplete semantic batch")
                                # Preserve idx=0 semantics (Python [-0:] means all).
                                # Drop reference tokens from the retained CPU copy.
                                indices = [int(i) for i in indices]
                                if any(i < 0 or i > len(p) for p, i in zip(predictions, indices)):
                                    raise ValueError("Invalid semantic length")
                                trimmed = ([p[-i:] for p, i in zip(predictions, indices)], indices)
                                used += _bytes(trimmed) + len(signature)
                                if used > self.max_bytes or index > self.max_batches:
                                    cacheable = False
                                    staged.clear()
                                else:
                                    staged.append((signature, _cpu_copy(trimmed)))
                            except (TypeError, ValueError, AttributeError):
                                cacheable = False
                                staged.clear()
                        return output
                    return infer

                # TTS.run selects infer_panel AFTER generator entry. Wrapping
                # its current selectable methods is essential after every reload.
                for name in ("infer_panel", "infer_panel_batch_infer", "infer_panel_naive_batched"):
                    value = getattr(model, name, None)
                    if callable(value):
                        original_methods[name] = (name in vars(model), value)
                        setattr(model, name, wrap(value))
            generator = self._original_run(req)
            for result in generator:
                # TTS can return a silent stop/empty placeholder without raising.
                # Such an interrupted request is not a complete reusable result.
                audio = result[1]
                saw_audio = bool(audio.size and audio.any())
                yield result
            exhausted = True
            if eligible and saw_audio and not getattr(self.pipeline, "stop_flag", False) and cacheable and staged and len(staged) == index:
                # Only commit AFTER generator completion: exceptions after a
                # yielded placeholder and early generator.close() never commit.
                self.latest = (key, staged)
                self.last_result = "hit" if all_hit and index == len(previous[1]) else "miss"
            elif eligible:
                self.last_result = "miss"
                if saw_audio and not getattr(self.pipeline, "stop_flag", False):
                    # A successful oversized/unsupported result supersedes the
                    # old result even though it cannot itself be retained.
                    self.latest = None
        finally:
            try:
                if generator is not None and not exhausted:
                    generator.close()
            finally:
                if model is not None:
                    for name, (was_instance, value) in original_methods.items():
                        if was_instance:
                            setattr(model, name, value)
                        else:
                            delattr(model, name)
                # Drop staging and GPU copies when a request fails. The previous
                # complete CPU cache remains valid until the next successful run.
                self._guard.release()


class ModelRequestLock:
    """Pure ASGI middleware: includes streamed body consumption in the lock."""
    def __init__(self, app, cache):
        self.app = app
        self.cache = cache
        self.lock = asyncio.Lock()

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        read_only = path in ("/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc", "/voice-reply/status")
        if scope["type"] != "http" or read_only:
            return await self.app(scope, receive, send)
        async with self.lock:
            if path in ("/tts", "/voice-reply/tts"):
                self.cache.last_result = "miss"
            async def with_metadata(message):
                if message["type"] == "http.response.start" and path in ("/tts", "/voice-reply/tts"):
                    message = dict(message)
                    message["headers"] = list(message.get("headers", [])) + [
                        (b"x-voice-semantic-cache", self.cache.last_result.encode("ascii"))]
                await send(message)
            await self.app(scope, receive, with_metadata)


def attach_adapter(namespace):
    from fastapi import Request
    from fastapi.responses import JSONResponse

    app = namespace["APP"]
    cache = SemanticCache(namespace["tts_pipeline"]).install()

    async def status():
        return {"adapter": "roost-voice-reply", "version": ADAPTER_VERSION,
                "features": {"semanticFreeze": True}, "cachePolicy": "latest-complete",
                "cacheReady": cache.latest is not None}

    async def tts(request: Request):
        try:
            body = await request.json()
        except (ValueError, UnicodeError):
            return JSONResponse(status_code=400, content={"message": "Expected a JSON object"})
        if not isinstance(body, dict) or ("if_freeze" in body and not isinstance(body["if_freeze"], bool)):
            return JSONResponse(status_code=400, content={"message": "Expected an object with boolean if_freeze"})
        if body.get("streaming_mode", False) or body.get("return_fragment", False):
            return JSONResponse(status_code=400, content={"message": "Semantic freeze requires non-streaming synthesis"})
        return await namespace["tts_handle"](body)

    app.get("/voice-reply/status")(status)
    app.post("/voice-reply/tts")(tts)
    app.add_middleware(ModelRequestLock, cache=cache)
    return app


def load_app(app_dir, host="127.0.0.1", port=9880, config=None):
    app_dir = Path(app_dir).resolve(strict=True)
    api = app_dir / "api_v2.py"
    if not api.is_file():
        raise FileNotFoundError("APP directory must contain api_v2.py")
    os.chdir(app_dir)
    sys.path[:0] = [str(app_dir), str(app_dir / "GPT_SoVITS")]
    original_argv = sys.argv
    sys.argv = [str(api), "-a", host, "-p", str(port)]
    if config:
        sys.argv.extend(["-c", config])
    try:
        # A non-__main__ name retains the original routes but skips uvicorn.run.
        namespace = runpy.run_path(str(api), run_name="voice_reply_api_v2")
    finally:
        sys.argv = original_argv
    return attach_adapter(namespace)


def main():
    parser = argparse.ArgumentParser(description="Roost GPT-SoVITS semantic-cache adapter")
    parser.add_argument("--app-dir", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9880)
    parser.add_argument("--config")
    args = parser.parse_args()
    app = load_app(args.app_dir, args.host, args.port, args.config)
    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port, workers=1)


if __name__ == "__main__":
    main()
