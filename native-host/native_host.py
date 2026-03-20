"""
Genspark Bridge – nativeHost + OpenAI互換APIサーバ

アーキテクチャ:
  - Firefox 拡張機能から nativeMessaging (stdin/stdout) で起動される
  - 内部で FastAPI サーバを別スレッドで起動 (デフォルト: port 5000)
  - 外部クライアントは http://localhost:5000/v1/chat/completions に
    OpenAI互換形式でリクエストを送る
  - リクエストを受け取ると、nativeMessaging 経由で拡張機能にプロンプトを送り、
    拡張機能がGensparkに入力して応答をストリーミングで中継する

会話判別:
  - クライアントが送る messages 配列のプレフィックスマッチで同一会話を判別
  - オプション conversation_id が指定されていればそれを優先
"""

import sys
import os
import json
import time
import uuid
import asyncio
import hashlib
import threading
from typing import Optional
from dataclasses import dataclass, field

# stderr をログ出力に使う (stdout は nativeMessaging 用)
def log(msg: str):
    sys.stderr.write(f"[GS NativeHost] {msg}\n")
    sys.stderr.flush()

log("Starting native host...")

try:
    from fastapi import FastAPI, Request
    from fastapi.responses import StreamingResponse, JSONResponse
    from fastapi.middleware.cors import CORSMiddleware
    import uvicorn
except ImportError as e:
    log(f"Import error: {e}")
    log("Please install dependencies: pip install fastapi uvicorn")
    sys.exit(1)

from native_messaging import NativeMessagingIO


# ======================================================
# 設定
# ======================================================

RESPONSE_TIMEOUT_SEC = 120.0      # 個別チャンク間のタイムアウト
QUEUE_CLEANUP_SEC = 600.0         # 完了したキューの保持時間
CONVERSATION_TTL_SEC = 1800.0     # 会話セッションの有効期限（30分）
MAX_PENDING_REQUESTS = 20         # 同時リクエスト上限


# ======================================================
# 会話管理
# ======================================================

def messages_fingerprint(messages: list[dict]) -> str:
    """messages 配列をハッシュ化して指紋を作る"""
    normalized = []
    for m in messages:
        normalized.append({
            "role": m.get("role", ""),
            "content": m.get("content", ""),
        })
    raw = json.dumps(normalized, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


@dataclass
class ConversationSession:
    """
    一つの会話セッションを表す。
    Genspark のブラウザタブ上の 1 つのチャットスレッドに対応。
    """
    conversation_id: str
    messages_history: list[dict] = field(default_factory=list)
    last_active: float = field(default_factory=time.time)
    request_count: int = 0

    def update(self, messages: list[dict]):
        """メッセージ履歴を更新"""
        self.messages_history = messages
        self.last_active = time.time()
        self.request_count += 1

    def is_expired(self) -> bool:
        return (time.time() - self.last_active) > CONVERSATION_TTL_SEC


class ConversationManager:
    """
    複数の会話セッションを管理する。
    リクエストの messages 配列から同一会話の継続を判別し、
    適切な conversation_id を返す。
    """

    def __init__(self):
        self._sessions: dict[str, ConversationSession] = {}
        self._lock = threading.Lock()

    def resolve_conversation(
        self,
        messages: list[dict],
        explicit_conversation_id: Optional[str] = None,
    ) -> str:
        """
        リクエストの会話IDを解決する。

        判別ロジック:
        1. explicit_conversation_id が指定されていればそれを使用
        2. 既存セッションの messages_history が、今回の messages の
           先頭部分と一致するか確認（プレフィックスマッチ）
        3. どれにも該当しなければ新規会話として新IDを発行

        Returns: conversation_id
        """
        with self._lock:
            self._cleanup_expired()

            # 1. 明示的な conversation_id
            if explicit_conversation_id:
                if explicit_conversation_id in self._sessions:
                    session = self._sessions[explicit_conversation_id]
                    session.update(messages)
                    log(f"Conversation (explicit): {explicit_conversation_id}")
                    return explicit_conversation_id
                else:
                    # 新規セッションとして登録
                    session = ConversationSession(
                        conversation_id=explicit_conversation_id
                    )
                    session.update(messages)
                    self._sessions[explicit_conversation_id] = session
                    log(f"New conversation (explicit): {explicit_conversation_id}")
                    return explicit_conversation_id

            # 2. プレフィックスマッチ
            if len(messages) >= 2:
                # 「今回の messages の先頭 N-1 件」が既存セッションの
                # messages_history と一致するか
                best_match_id = None
                best_match_len = 0

                for conv_id, session in self._sessions.items():
                    if session.is_expired():
                        continue
                    prev = session.messages_history
                    if not prev:
                        continue

                    # prev が messages の先頭部分として含まれるか確認
                    match_len = self._prefix_match_length(prev, messages)
                    if match_len > 0 and match_len > best_match_len:
                        best_match_len = match_len
                        best_match_id = conv_id

                if best_match_id:
                    session = self._sessions[best_match_id]
                    session.update(messages)
                    log(
                        f"Conversation continued (prefix match "
                        f"{best_match_len} msgs): {best_match_id}"
                    )
                    return best_match_id

            # 3. 新規会話
            new_id = f"conv-{uuid.uuid4().hex[:12]}"
            session = ConversationSession(conversation_id=new_id)
            session.update(messages)
            self._sessions[new_id] = session
            log(f"New conversation: {new_id}")
            return new_id

    def _prefix_match_length(
        self, prev_messages: list[dict], current_messages: list[dict]
    ) -> int:
        """
        prev_messages の全メッセージが current_messages の先頭に
        含まれている場合、一致した件数を返す。
        含まれていなければ 0。
        """
        if len(prev_messages) > len(current_messages):
            return 0

        for i, prev_msg in enumerate(prev_messages):
            curr_msg = current_messages[i]
            if (prev_msg.get("role") != curr_msg.get("role") or
                    prev_msg.get("content") != curr_msg.get("content")):
                return 0

        return len(prev_messages)

    def _cleanup_expired(self):
        """期限切れセッションを除去"""
        expired = [
            cid for cid, s in self._sessions.items() if s.is_expired()
        ]
        for cid in expired:
            del self._sessions[cid]
            log(f"Conversation expired: {cid}")

    def get_session(self, conversation_id: str) -> Optional[ConversationSession]:
        with self._lock:
            return self._sessions.get(conversation_id)

    @property
    def active_count(self) -> int:
        with self._lock:
            return len(self._sessions)


# ======================================================
# リクエスト管理
# ======================================================

@dataclass
class PendingRequest:
    """処理中の個別リクエスト"""
    request_id: str
    conversation_id: str
    queue: asyncio.Queue
    created_at: float = field(default_factory=time.time)
    finished: bool = False


class RequestRegistry:
    """
    リクエストIDとキューの対応を管理する。
    スレッドセーフ。
    """

    def __init__(self):
        self._requests: dict[str, PendingRequest] = {}
        self._lock = threading.Lock()

    def register(
        self, request_id: str, conversation_id: str, queue: asyncio.Queue
    ) -> bool:
        """リクエストを登録。上限超過の場合は False を返す。"""
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
        """リクエストを完了状態にする"""
        with self._lock:
            req = self._requests.get(request_id)
            if req:
                req.finished = True

    def remove(self, request_id: str):
        with self._lock:
            self._requests.pop(request_id, None)

    def _cleanup_finished(self):
        """完了済みかつ保持時間を超えたリクエストを除去"""
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

native_io = NativeMessagingIO()
conversation_manager = ConversationManager()
request_registry = RequestRegistry()
main_loop: Optional[asyncio.AbstractEventLoop] = None

app = FastAPI(title="Genspark Bridge", version="2.0.0")

# CORS（ローカル開発用）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ======================================================
# nativeMessaging メッセージハンドラ
# ======================================================

def handle_native_message(message: dict):
    """拡張機能から受信したメッセージを処理する"""
    msg_type = message.get("type")
    request_id = message.get("request_id")

    log(f"From extension: type={msg_type}, request_id={request_id}")

    if msg_type == "pong":
        log("Pong received — extension is alive")
        return

    if not request_id:
        log(f"Message without request_id: {msg_type}")
        return

    pending = request_registry.get(request_id)
    if not pending:
        log(f"Unknown or expired request_id: {request_id}")
        return

    if msg_type == "prompt_sent":
        log(f"Prompt sent confirmed: {request_id}")
        # prompt_sent は情報通知のみ、キューには入れない
        return

    if not main_loop:
        log("Event loop not available")
        return

    if msg_type == "stream_delta":
        delta = message.get("delta", "")
        full_text = message.get("full_text", "")
        if delta:
            asyncio.run_coroutine_threadsafe(
                pending.queue.put({
                    "type": "delta",
                    "delta": delta,
                    "full_text": full_text,
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
        error_msg = message.get("error", "Unknown error from extension")
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
    """モデル一覧"""
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
    """ヘルスチェック"""
    return {
        "status": "ok",
        "pending_requests": request_registry.pending_count,
        "active_conversations": conversation_manager.active_count,
    }


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    """
    OpenAI互換 chat completions エンドポイント。

    追加パラメータ（オプション）:
      - conversation_id: 明示的な会話ID。指定しない場合は
        messages のプレフィックスマッチで自動判別。
    """
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
    explicit_conv_id = body.get("conversation_id")  # オプション

    # --- バリデーション ---
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

    # 最後のユーザーメッセージを取得
    user_message = None
    for msg in reversed(messages):
        if msg.get("role") == "user":
            user_message = msg.get("content", "")
            break

    if not user_message:
        return JSONResponse(
            status_code=400,
            content={
                "error": {
                    "message": "No user message found in messages",
                    "type": "invalid_request_error",
                }
            },
        )

    # --- 会話判別 ---
    conversation_id = conversation_manager.resolve_conversation(
        messages, explicit_conv_id
    )

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

    log(
        f"Request {request_id} | conversation={conversation_id} | "
        f"stream={stream} | msg={user_message[:80]}..."
    )

    # --- nativeMessaging で拡張機能にプロンプト送信 ---
    try:
        native_io.send({
            "type": "send_prompt",
            "text": user_message,
            "request_id": request_id,
            "conversation_id": conversation_id,
        })
    except Exception as e:
        request_registry.remove(request_id)
        log(f"Failed to send to extension: {e}")
        return JSONResponse(
            status_code=502,
            content={
                "error": {
                    "message": f"Failed to communicate with browser extension: {e}",
                    "type": "upstream_error",
                }
            },
        )


    # --- レスポンス ---
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
    """SSE ストリーミング応答ジェネレータ"""
    completion_id = f"chatcmpl-{request_id[:8]}"
    created = int(time.time())

    def make_chunk(delta_content: Optional[str] = None,
                   finish_reason: Optional[str] = None) -> str:
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
        # 最初のチャンク: role 通知
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
                log(f"Stream timeout: {request_id}")
                yield make_chunk(
                    "\n\n[Error: Response timed out]", "stop"
                )
                yield "data: [DONE]\n\n"
                return

            if item["type"] == "delta":
                yield make_chunk(item["delta"])

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
    """非ストリーミング応答"""
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
                full_text += item["delta"]

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
# サーバ起動 & メインループ
# ======================================================

def run_api_server(port: int = 5000):
    """別スレッドで FastAPI サーバを起動"""
    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=port,
        log_level="warning",
    )
    server = uvicorn.Server(config)
    server.run()


def main():
    global main_loop

    port = int(os.environ.get("GENSPARK_BRIDGE_PORT", "5000"))
    log(f"API server will listen on http://127.0.0.1:{port}")

    # FastAPI を別スレッドで起動
    api_thread = threading.Thread(
        target=run_api_server, args=(port,), daemon=True
    )
    api_thread.start()

    # asyncio event loop
    main_loop = asyncio.new_event_loop()
    asyncio.set_event_loop(main_loop)

    # nativeMessaging ハンドラ
    native_io.on_message(handle_native_message)

    # 接続確認
    native_io.send({"type": "ping"})

    log("Native host ready. Reading from stdin...")

    # stdin 読み取りループ
    read_thread = threading.Thread(
        target=native_io.read_loop, daemon=True
    )
    read_thread.start()

    # event loop を維持
    try:
        main_loop.run_forever()
    except KeyboardInterrupt:
        log("Shutting down...")
    finally:
        main_loop.close()


if __name__ == "__main__":
    main()
