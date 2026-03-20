"""
api_server.py — OpenAI互換 API サーバ + native_bridge.py との TCP 通信

起動:
  python api_server.py

外部クライアント → HTTP :5000 → api_server.py ←TCP :5001→ native_bridge.py ←nativeMsg→ Firefox
"""

import sys
import os
import json
import time
import uuid
import asyncio
import re
import struct
import socket
import threading
from typing import Optional
from dataclasses import dataclass, field

def log(msg: str):
    print(f"[GS ApiServer] {msg}", flush=True)

log("Starting API server...")

try:
    from fastapi import FastAPI, Request
    from fastapi.responses import StreamingResponse, JSONResponse
    from fastapi.middleware.cors import CORSMiddleware
    import uvicorn
except ImportError as e:
    log(f"Import error: {e}")
    log("Please install dependencies: pip install fastapi uvicorn")
    sys.exit(1)


# ======================================================
# 設定
# ======================================================

HTTP_PORT = int(os.environ.get("GENSPARK_BRIDGE_PORT", "5000"))
TCP_PORT = int(os.environ.get("GENSPARK_BRIDGE_TCP_PORT", "5001"))

RESPONSE_TIMEOUT_SEC = 120.0
QUEUE_CLEANUP_SEC = 600.0
CONVERSATION_TTL_SEC = 1800.0
MAX_PENDING_REQUESTS = 20


# ======================================================
# TCP クライアント管理 (native_bridge.py との通信)
# ======================================================

class BridgeConnection:
    def __init__(self):
        self._socket: Optional[socket.socket] = None
        self._write_lock = threading.Lock()
        self._on_message_callback = None
        self._connected = False

    @property
    def connected(self) -> bool:
        return self._connected

    def set_socket(self, sock: socket.socket):
        self._socket = sock
        self._connected = True

    def on_message(self, callback):
        self._on_message_callback = callback

    def send(self, message: dict):
        with self._write_lock:
            if not self._socket or not self._connected:
                raise ConnectionError("Bridge not connected")
            encoded = json.dumps(
                message, separators=(",", ":"), ensure_ascii=False
            ).encode("utf-8")
            header = struct.pack("!I", len(encoded))
            try:
                self._socket.sendall(header + encoded)
            except (BrokenPipeError, OSError) as e:
                self._connected = False
                raise ConnectionError(f"Bridge send failed: {e}")

    def read_loop(self):
        buffer = b""
        while self._connected:
            try:
                data = self._socket.recv(4096)
            except (OSError, AttributeError):
                break
            if not data:
                break
            buffer += data

            while len(buffer) >= 4:
                length = struct.unpack("!I", buffer[:4])[0]
                if len(buffer) < 4 + length:
                    break
                raw = buffer[4:4 + length]
                buffer = buffer[4 + length:]

                try:
                    msg = json.loads(raw.decode("utf-8"))
                    if self._on_message_callback:
                        self._on_message_callback(msg)
                except (json.JSONDecodeError, UnicodeDecodeError) as e:
                    log(f"TCP message decode error: {e}")

        self._connected = False
        log("Bridge connection lost")

    def disconnect(self):
        self._connected = False
        if self._socket:
            try:
                self._socket.close()
            except OSError:
                pass


bridge = BridgeConnection()


def run_tcp_server():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", TCP_PORT))
    server.listen(1)
    log(f"TCP server listening on 127.0.0.1:{TCP_PORT}")

    while True:
        conn, addr = server.accept()
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        log(f"Bridge connected from {addr}")
        bridge.disconnect()
        bridge.set_socket(conn)
        read_thread = threading.Thread(
            target=bridge.read_loop, daemon=True
        )
        read_thread.start()


# ======================================================
# テキスト正規化（会話マッチング用）
# ======================================================

def normalize_content(text: str) -> str:
    if not text:
        return ""
    lines = text.splitlines()
    lines = [re.sub(r'[ \t\u3000]+', ' ', line.strip()) for line in lines]
    return "\n".join(lines).strip()


# ======================================================
# メッセージ処理
# ======================================================

def extract_system_prompt(messages: list[dict]) -> Optional[str]:
    """messages 配列から最初の system メッセージの content を取得"""
    for m in messages:
        if m.get("role") == "system":
            return m.get("content", "")
    return None


def extract_user_message(messages: list[dict]) -> Optional[str]:
    """messages 配列から最後の user メッセージの content を取得"""
    for msg in reversed(messages):
        if msg.get("role") == "user":
            return msg.get("content", "")
    return None


def build_prompt_text(
    user_message: str,
    system_prompt: Optional[str],
    is_new_conversation: bool,
) -> str:
    """
    Genspark に送信するプロンプトテキストを構築する。

    新規会話の場合はシステムプロンプトをユーザーメッセージの前に付加する。
    会話継続の場合はユーザーメッセージのみ（system は初回に送済み）。
    """
    if is_new_conversation and system_prompt:
        return (
            f"[System Instructions]\n"
            f"{system_prompt}\n\n"
            f"[User Message]\n"
            f"{user_message}"
        )
    return user_message


# ======================================================
# 会話管理
# ======================================================

@dataclass
class ConversationSession:
    conversation_id: str
    tab_id: Optional[int] = None
    messages_history: list = field(default_factory=list)
    match_key: list = field(default_factory=list)
    last_active: float = field(default_factory=time.time)
    request_count: int = 0

    def update(self, messages: list[dict]):
        self.messages_history = list(messages)
        self.match_key = _build_match_key(messages)
        self.last_active = time.time()
        self.request_count += 1

    def is_expired(self) -> bool:
        return (time.time() - self.last_active) > CONVERSATION_TTL_SEC

    def clear_tab(self):
        log(f"Clearing tab_id for conversation {self.conversation_id}")
        self.tab_id = None


def _build_match_key(messages: list[dict]) -> list[dict]:
    result = []
    for m in messages:
        role = m.get("role", "")
        if role == "system":
            continue
        result.append({
            "role": role,
            "content": normalize_content(m.get("content", "")),
        })
    return result


class ConversationManager:
    def __init__(self):
        self._sessions: dict[str, ConversationSession] = {}
        self._lock = threading.Lock()

    def resolve_conversation(
        self,
        messages: list[dict],
        explicit_conversation_id: Optional[str] = None,
    ) -> tuple[str, Optional[int], bool]:
        """
        Returns: (conversation_id, tab_id or None, is_new_conversation)
        """
        with self._lock:
            self._cleanup_expired()

            input_key = _build_match_key(messages)

            # 1. 明示的な conversation_id
            if explicit_conversation_id:
                if explicit_conversation_id in self._sessions:
                    session = self._sessions[explicit_conversation_id]
                    session.update(messages)
                    return (explicit_conversation_id, session.tab_id, False)
                else:
                    session = ConversationSession(
                        conversation_id=explicit_conversation_id
                    )
                    session.update(messages)
                    self._sessions[explicit_conversation_id] = session
                    return (explicit_conversation_id, None, True)

            # 2. プレフィックスマッチ
            if len(input_key) >= 1 and len(self._sessions) > 0:
                best_match_id = None
                best_match_len = 0

                for conv_id, session in self._sessions.items():
                    if session.is_expired():
                        continue
                    prev_key = session.match_key
                    if not prev_key:
                        continue

                    match_len = self._prefix_match_length(
                        prev_key, input_key
                    )

                    if match_len > 0 and match_len > best_match_len:
                        best_match_len = match_len
                        best_match_id = conv_id

                if best_match_id:
                    session = self._sessions[best_match_id]
                    session.update(messages)
                    log(f"Conversation continued: {best_match_id} "
                        f"(match {best_match_len} msgs, "
                        f"tab_id={session.tab_id})")
                    return (best_match_id, session.tab_id, False)

            # 3. 新規会話
            new_id = f"conv-{uuid.uuid4().hex[:12]}"
            session = ConversationSession(conversation_id=new_id)
            session.update(messages)
            self._sessions[new_id] = session
            log(f"New conversation: {new_id}")
            return (new_id, None, True)

    def _prefix_match_length(
        self,
        prev_key: list[dict],
        current_key: list[dict],
    ) -> int:
        if len(prev_key) > len(current_key):
            return 0
        for i, prev_msg in enumerate(prev_key):
            curr_msg = current_key[i]
            if (prev_msg["role"] != curr_msg["role"] or
                    prev_msg["content"] != curr_msg["content"]):
                return 0
        return len(prev_key)

    def set_tab_id(self, conversation_id: str, tab_id: int):
        with self._lock:
            session = self._sessions.get(conversation_id)
            if session:
                session.tab_id = tab_id

    def clear_tab_id(self, conversation_id: str):
        with self._lock:
            session = self._sessions.get(conversation_id)
            if session:
                session.clear_tab()

    def _cleanup_expired(self):
        expired = [
            cid for cid, s in self._sessions.items() if s.is_expired()
        ]
        for cid in expired:
            del self._sessions[cid]
            log(f"Conversation expired: {cid}")

    @property
    def active_count(self) -> int:
        with self._lock:
            return len(self._sessions)


# ======================================================
# リクエスト管理
# ======================================================

@dataclass
class PendingRequest:
    request_id: str
    conversation_id: str
    queue: asyncio.Queue
    created_at: float = field(default_factory=time.time)
    finished: bool = False


class RequestRegistry:
    def __init__(self):
        self._requests: dict[str, PendingRequest] = {}
        self._lock = threading.Lock()

    def register(
        self, request_id: str, conversation_id: str, queue: asyncio.Queue
    ) -> bool:
        with self._lock:
            self._cleanup_finished()
            if len(self._requests) >= MAX_PENDING_REQUESTS:
                return False
            self._requests[request_id] = PendingRequest(
                request_id=request_id,
                conversation_id=conversation_id,
                queue=queue,
            )
            return True

    def get(self, request_id: str) -> Optional[PendingRequest]:
        with self._lock:
            return self._requests.get(request_id)

    def finish(self, request_id: str):
        with self._lock:
            req = self._requests.get(request_id)
            if req:
                req.finished = True

    def remove(self, request_id: str):
        with self._lock:
            self._requests.pop(request_id, None)

    def _cleanup_finished(self):
        now = time.time()
        expired = [
            rid for rid, req in self._requests.items()
            if req.finished and (now - req.created_at) > QUEUE_CLEANUP_SEC
        ]
        for rid in expired:
            del self._requests[rid]

    @property
    def pending_count(self) -> int:
        with self._lock:
            return sum(1 for r in self._requests.values() if not r.finished)


# ======================================================
# グローバル状態
# ======================================================

conversation_manager = ConversationManager()
request_registry = RequestRegistry()
main_loop: Optional[asyncio.AbstractEventLoop] = None

app = FastAPI(title="Genspark Bridge", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ======================================================
# bridge からのメッセージハンドラ
# ======================================================

def handle_bridge_message(message: dict):
    msg_type = message.get("type")
    request_id = message.get("request_id")
    tab_id = message.get("tab_id")

    if msg_type == "pong":
        log("Pong received")
        return

    if msg_type == "bridge_connected":
        log("Bridge process connected")
        return

    if not request_id:
        return

    pending = request_registry.get(request_id)
    if not pending:
        log(f"Unknown request_id: {request_id}")
        return

    if tab_id is not None:
        conversation_manager.set_tab_id(pending.conversation_id, tab_id)

    if msg_type == "prompt_sent":
        return

    if not main_loop:
        return

    if msg_type == "stream_delta":
        delta = message.get("delta", "")
        full_text = message.get("full_text", "")
        replacement = message.get("replacement", False)
        if delta or replacement:
            asyncio.run_coroutine_threadsafe(
                pending.queue.put({
                    "type": "delta",
                    "delta": delta,
                    "full_text": full_text,
                    "replacement": replacement,
                }),
                main_loop,
            )

    elif msg_type == "stream_end":
        full_text = message.get("full_text", "")
        asyncio.run_coroutine_threadsafe(
            pending.queue.put({
                "type": "end",
                "full_text": full_text,
            }),
            main_loop,
        )

    elif msg_type in ("error", "stream_error"):
        error_msg = message.get("error", "Unknown error")
        if "tab" in error_msg.lower() and (
            "closed" in error_msg.lower() or
            "not found" in error_msg.lower() or
            "no longer exists" in error_msg.lower()
        ):
            conversation_manager.clear_tab_id(pending.conversation_id)

        asyncio.run_coroutine_threadsafe(
            pending.queue.put({
                "type": "error",
                "error": error_msg,
            }),
            main_loop,
        )


# ======================================================
# OpenAI互換 API エンドポイント
# ======================================================

@app.get("/v1/models")
async def list_models():
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


@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "bridge_connected": bridge.connected,
        "pending_requests": request_registry.pending_count,
        "active_conversations": conversation_manager.active_count,
    }


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(
            status_code=400,
            content={
                "error": {
                    "message": "Invalid JSON body",
                    "type": "invalid_request_error",
                }
            },
        )

    messages = body.get("messages", [])
    stream = body.get("stream", False)
    model = body.get("model", "genspark")
    explicit_conv_id = body.get("conversation_id")

    if not messages:
        return JSONResponse(
            status_code=400,
            content={
                "error": {
                    "message": "messages is required",
                    "type": "invalid_request_error",
                }
            },
        )

    user_message = extract_user_message(messages)
    if not user_message:
        return JSONResponse(
            status_code=400,
            content={
                "error": {
                    "message": "No user message found",
                    "type": "invalid_request_error",
                }
            },
        )

    if not bridge.connected:
        return JSONResponse(
            status_code=503,
            content={
                "error": {
                    "message": "Browser extension bridge not connected.",
                    "type": "service_unavailable",
                }
            },
        )

    # --- 会話判別 ---
    conversation_id, tab_id, is_new = (
        conversation_manager.resolve_conversation(
            messages, explicit_conv_id
        )
    )

    # --- システムプロンプト付加 ---
    system_prompt = extract_system_prompt(messages)
    prompt_text = build_prompt_text(user_message, system_prompt, is_new)

    # --- リクエスト登録 ---
    request_id = str(uuid.uuid4())
    queue = asyncio.Queue()

    if not request_registry.register(request_id, conversation_id, queue):
        return JSONResponse(
            status_code=429,
            content={
                "error": {
                    "message": "Too many pending requests",
                    "type": "rate_limit_error",
                }
            },
        )

    log(f"Request {request_id} | conv={conversation_id} | "
        f"tab={tab_id} | new={is_new} | stream={stream} | "
        f"prompt_len={len(prompt_text)}")

    # --- bridge にプロンプト送信 ---
    prompt_message = {
        "type": "send_prompt",
        "text": prompt_text,
        "request_id": request_id,
    }
    if tab_id is not None:
        prompt_message["tab_id"] = tab_id

    try:
        bridge.send(prompt_message)
    except (ConnectionError, OSError) as e:
        request_registry.remove(request_id)
        return JSONResponse(
            status_code=502,
            content={
                "error": {
                    "message": f"Bridge communication failed: {e}",
                    "type": "upstream_error",
                }
            },
        )

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
        return await non_stream_response(request_id, queue, model)


# ======================================================
# ストリーミング / 非ストリーミング レスポンス
# ======================================================

async def stream_response(
    request_id: str, queue: asyncio.Queue, model: str
):
    completion_id = f"chatcmpl-{request_id[:8]}"
    created = int(time.time())
    streamed_text = ""

    def make_chunk(
        delta_content: Optional[str] = None,
        finish_reason: Optional[str] = None,
    ) -> str:
        delta = {}
        if delta_content is not None:
            delta["content"] = delta_content
        chunk = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{
                "index": 0,
                "delta": delta,
                "finish_reason": finish_reason,
            }],
        }
        return f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"

    try:
        role_chunk = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{
                "index": 0,
                "delta": {"role": "assistant", "content": ""},
                "finish_reason": None,
            }],
        }
        yield f"data: {json.dumps(role_chunk, ensure_ascii=False)}\n\n"

        while True:
            try:
                item = await asyncio.wait_for(
                    queue.get(), timeout=RESPONSE_TIMEOUT_SEC
                )
            except asyncio.TimeoutError:
                yield make_chunk(
                    "\n\n[Error: Response timed out]", "stop"
                )
                yield "data: [DONE]\n\n"
                return

            if item["type"] == "delta":
                full_text = item.get("full_text", "")
                replacement = item.get("replacement", False)

                if replacement and full_text:
                    # full_text ベースで差分計算
                    if full_text.startswith(streamed_text):
                        new_part = full_text[len(streamed_text):]
                    else:
                        new_part = full_text
                    if new_part:
                        yield make_chunk(new_part)
                        streamed_text = full_text
                else:
                    delta_text = item.get("delta", "")
                    if delta_text:
                        yield make_chunk(delta_text)
                        streamed_text += delta_text

            elif item["type"] == "end":
                yield make_chunk(finish_reason="stop")
                yield "data: [DONE]\n\n"
                return

            elif item["type"] == "error":
                yield make_chunk(
                    f"\n\n[Error: {item['error']}]", "stop"
                )
                yield "data: [DONE]\n\n"
                return

    finally:
        request_registry.finish(request_id)


async def non_stream_response(
    request_id: str, queue: asyncio.Queue, model: str
):
    completion_id = f"chatcmpl-{request_id[:8]}"
    created = int(time.time())
    full_text = ""

    try:
        while True:
            try:
                item = await asyncio.wait_for(
                    queue.get(), timeout=RESPONSE_TIMEOUT_SEC
                )
            except asyncio.TimeoutError:
                full_text += "\n\n[Error: Response timed out]"
                break

            if item["type"] == "delta":
                # 非ストリームでは full_text を信頼
                if item.get("replacement") and item.get("full_text"):
                    full_text = item["full_text"]
                else:
                    full_text += item.get("delta", "")

            elif item["type"] == "end":
                full_text = item.get("full_text", full_text)
                break

            elif item["type"] == "error":
                return JSONResponse(
                    status_code=502,
                    content={
                        "error": {
                            "message": item["error"],
                            "type": "upstream_error",
                        }
                    },
                )
    finally:
        request_registry.finish(request_id)

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
# メイン
# ======================================================

def main():
    global main_loop

    log(f"HTTP API on http://127.0.0.1:{HTTP_PORT}")
    log(f"TCP bridge on 127.0.0.1:{TCP_PORT}")

    tcp_thread = threading.Thread(target=run_tcp_server, daemon=True)
    tcp_thread.start()

    bridge.on_message(handle_bridge_message)

    main_loop = asyncio.new_event_loop()
    asyncio.set_event_loop(main_loop)

    def run_http():
        config = uvicorn.Config(
            app,
            host="127.0.0.1",
            port=HTTP_PORT,
            log_level="warning",
        )
        server = uvicorn.Server(config)
        server.run()

    http_thread = threading.Thread(target=run_http, daemon=True)
    http_thread.start()

    log("API server ready")

    try:
        main_loop.run_forever()
    except KeyboardInterrupt:
        log("Shutting down...")
    finally:
        main_loop.close()


if __name__ == "__main__":
    main()
