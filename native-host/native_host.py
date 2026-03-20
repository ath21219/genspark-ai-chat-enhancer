"""
Genspark Bridge – nativeHost + OpenAI互換APIサーバ

アーキテクチャ:
  - Firefox 拡張機能から nativeMessaging (stdin/stdout) で起動される
  - 内部で FastAPI サーバを別スレッドで起動 (デフォルト: port 5000)
  - 外部クライアントは http://localhost:5000/v1/chat/completions に
    OpenAI互換形式でリクエストを送る
  - リクエストを受け取ると、nativeMessaging 経由で拡張機能にプロンプトを送り、
    拡張機能がGensparkに入力して応答をストリーミングで中継する
"""

import sys
import os
import json
import time
import uuid
import asyncio
import threading
from typing import Optional

# stderr をログ出力に使う (stdout は nativeMessaging 用)
def log(msg: str):
    sys.stderr.write(f"[GS NativeHost] {msg}\n")
    sys.stderr.flush()

log("Starting native host...")

# FastAPI/uvicorn のインポート
try:
    from fastapi import FastAPI, Request
    from fastapi.responses import StreamingResponse, JSONResponse
    import uvicorn
except ImportError as e:
    log(f"Import error: {e}")
    log("Please install dependencies: pip install fastapi uvicorn")
    sys.exit(1)

from native_messaging import NativeMessagingIO


# ======================================================
# グローバル状態
# ======================================================

native_io = NativeMessagingIO()
app = FastAPI(title="Genspark Bridge", version="1.0.0")

# リクエストIDごとの応答キュー
# key: request_id, value: asyncio.Queue
pending_requests: dict[str, asyncio.Queue] = {}
# メインのevent loop参照 (FastAPIのスレッドから使う)
main_loop: Optional[asyncio.AbstractEventLoop] = None


# ======================================================
# nativeMessaging メッセージハンドラ
# ======================================================

def handle_native_message(message: dict):
    """拡張機能から受信したメッセージを処理する"""
    msg_type = message.get("type")
    request_id = message.get("request_id")

    log(f"Received from extension: type={msg_type}, request_id={request_id}")

    if not request_id or request_id not in pending_requests:
        if msg_type == "pong":
            log("Pong received")
            return
        log(f"Unknown or expired request_id: {request_id}")
        return

    queue = pending_requests[request_id]

    if msg_type == "prompt_sent":
        # プロンプトが送信された確認 – 特にキューには入れない
        log(f"Prompt sent confirmed for {request_id}")

    elif msg_type == "stream_delta":
        delta = message.get("delta", "")
        if delta and main_loop:
            asyncio.run_coroutine_threadsafe(
                queue.put({"type": "delta", "delta": delta}),
                main_loop,
            )

    elif msg_type == "stream_end":
        full_text = message.get("full_text", "")
        if main_loop:
            asyncio.run_coroutine_threadsafe(
                queue.put({"type": "end", "full_text": full_text}),
                main_loop,
            )

    elif msg_type == "error":
        error_msg = message.get("error", "Unknown error")
        if main_loop:
            asyncio.run_coroutine_threadsafe(
                queue.put({"type": "error", "error": error_msg}),
                main_loop,
            )


# ======================================================
# OpenAI互換 API エンドポイント
# ======================================================

@app.get("/v1/models")
async def list_models():
    """モデル一覧 (互換用)"""
    return {
        "object": "list",
        "data": [
            {
                "id": "genspark",
                "object": "model",
                "created": int(time.time()),
                "owned_by": "genspark-bridge",
            }
        ],
    }


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    """
    OpenAI互換 chat completions エンドポイント。
    stream: true の場合は SSE でストリーミング応答を返す。
    """
    body = await request.json()
    messages = body.get("messages", [])
    stream = body.get("stream", False)
    model = body.get("model", "genspark")

    if not messages:
        return JSONResponse(
            status_code=400,
            content={"error": {"message": "messages is required", "type": "invalid_request_error"}},
        )

    # 最後のユーザーメッセージを取得
    user_message = None
    for msg in reversed(messages):
        if msg.get("role") == "user":
            user_message = msg.get("content", "")
            break

    if not user_message:
        return JSONResponse(
            status_code=400,
            content={"error": {"message": "No user message found", "type": "invalid_request_error"}},
        )

    request_id = str(uuid.uuid4())
    queue = asyncio.Queue()
    pending_requests[request_id] = queue

    log(f"New request: {request_id}, stream={stream}, message={user_message[:80]}...")

    # nativeMessaging 経由で拡張機能にプロンプト送信
    native_io.send({
        "type": "send_prompt",
        "text": user_message,
        "request_id": request_id,
    })

    if stream:
        return StreamingResponse(
            stream_response(request_id, queue, model),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )
    else:
        # 非ストリーミング: 完了まで待つ
        return await non_stream_response(request_id, queue, model)


async def stream_response(request_id: str, queue: asyncio.Queue, model: str):
    """SSE ストリーミング応答ジェネレータ"""
    completion_id = f"chatcmpl-{request_id[:8]}"
    created = int(time.time())

    try:
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=120.0)
            except asyncio.TimeoutError:
                log(f"Stream timeout for {request_id}")
                # タイムアウトエラーチャンクを送信
                error_chunk = {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [{
                        "index": 0,
                        "delta": {"content": "\n\n[Error: Response timed out]"},
                        "finish_reason": "stop",
                    }],
                }
                yield f"data: {json.dumps(error_chunk)}\n\n"
                yield "data: [DONE]\n\n"
                return

            if item["type"] == "delta":
                chunk = {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [{
                        "index": 0,
                        "delta": {"content": item["delta"]},
                        "finish_reason": None,
                    }],
                }
                yield f"data: {json.dumps(chunk)}\n\n"

            elif item["type"] == "end":
                # finish chunk
                end_chunk = {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [{
                        "index": 0,
                        "delta": {},
                        "finish_reason": "stop",
                    }],
                }
                yield f"data: {json.dumps(end_chunk)}\n\n"
                yield "data: [DONE]\n\n"
                return

            elif item["type"] == "error":
                error_chunk = {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [{
                        "index": 0,
                        "delta": {"content": f"\n\n[Error: {item['error']}]"},
                        "finish_reason": "stop",
                    }],
                }
                yield f"data: {json.dumps(error_chunk)}\n\n"
                yield "data: [DONE]\n\n"
                return

    finally:
        pending_requests.pop(request_id, None)


async def non_stream_response(request_id: str, queue: asyncio.Queue, model: str):
    """非ストリーミング応答"""
    completion_id = f"chatcmpl-{request_id[:8]}"
    created = int(time.time())
    full_text = ""

    try:
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=120.0)
            except asyncio.TimeoutError:
                full_text += "\n\n[Error: Response timed out]"
                break

            if item["type"] == "delta":
                full_text += item["delta"]
            elif item["type"] == "end":
                full_text = item.get("full_text", full_text)
                break
            elif item["type"] == "error":
                return JSONResponse(
                    status_code=502,
                    content={"error": {"message": item["error"], "type": "upstream_error"}},
                )
    finally:
        pending_requests.pop(request_id, None)

    return JSONResponse(content={
        "id": completion_id,
        "object": "chat.completion",
        "created": created,
        "model": model,
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": full_text,
            },
            "finish_reason": "stop",
        }],
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        },
    })


# ======================================================
# サーバ起動 & メインループ
# ======================================================

def run_api_server(port: int = 5000):
    """別スレッドで FastAPI サーバを起動"""
    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=port,
        log_level="warning",
        # stderr にログを出す（stdout は nativeMessaging 用）
    )
    server = uvicorn.Server(config)
    server.run()


def main():
    global main_loop

    port = int(os.environ.get("GENSPARK_BRIDGE_PORT", "5000"))
    log(f"API server will listen on http://127.0.0.1:{port}")

    # FastAPI を別スレッドで起動
    api_thread = threading.Thread(target=run_api_server, args=(port,), daemon=True)
    api_thread.start()

    # asyncio event loop を取得（FastAPIのasync処理で使う）
    main_loop = asyncio.new_event_loop()
    asyncio.set_event_loop(main_loop)

    # nativeMessaging のメッセージハンドラを設定
    native_io.on_message(handle_native_message)

    # ping を送って接続確認
    native_io.send({"type": "ping"})

    log("Native host ready. Reading from stdin...")

    # stdin 読み取りループを asyncio loop と並行実行
    read_thread = threading.Thread(target=native_io.read_loop, daemon=True)
    read_thread.start()

    # event loop を実行し続ける
    try:
        main_loop.run_forever()
    except KeyboardInterrupt:
        log("Shutting down...")
    finally:
        main_loop.close()


if __name__ == "__main__":
    main()
