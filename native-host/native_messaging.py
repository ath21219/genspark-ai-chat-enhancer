"""
nativeMessaging プロトコル (stdin/stdout) の読み書きモジュール。
Firefox の nativeMessaging は length-prefixed JSON (32bit LE) を使う。

エラーハンドリング:
  - 読み取り失敗時はコールバックに error メッセージを通知
  - 書き込み失敗時は stderr にログを出力し、例外を再送出
  - 1MB の受信サイズ制限を設ける
"""

import sys
import json
import struct
import threading

MAX_MESSAGE_SIZE = 1024 * 1024  # 1 MB (Firefox の制限)


def _log(msg: str):
    sys.stderr.write(f"[NativeMessaging] {msg}\n")
    sys.stderr.flush()


def read_message():
    """stdin から 1メッセージを読み取る (ブロッキング)"""
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length:
        return None
    if len(raw_length) < 4:
        _log(f"Incomplete length header: {len(raw_length)} bytes")
        return None

    message_length = struct.unpack("@I", raw_length)[0]

    if message_length == 0:
        _log("Zero-length message received")
        return None

    if message_length > MAX_MESSAGE_SIZE:
        _log(f"Message too large: {message_length} bytes (max {MAX_MESSAGE_SIZE})")
        # 読み捨てる
        remaining = message_length
        while remaining > 0:
            chunk_size = min(remaining, 65536)
            data = sys.stdin.buffer.read(chunk_size)
            if not data:
                break
            remaining -= len(data)
        return None

    raw_message = sys.stdin.buffer.read(message_length)
    if not raw_message or len(raw_message) < message_length:
        _log(
            f"Incomplete message: expected {message_length}, "
            f"got {len(raw_message) if raw_message else 0}"
        )
        return None

    try:
        return json.loads(raw_message.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        _log(f"Message decode error: {e}")
        return None


def send_message(message: dict):
    """stdout に 1メッセージを書き込む"""
    try:
        encoded = json.dumps(
            message, separators=(",", ":"), ensure_ascii=False
        ).encode("utf-8")
        header = struct.pack("@I", len(encoded))
        sys.stdout.buffer.write(header)
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()
    except (BrokenPipeError, OSError) as e:
        _log(f"Send error (pipe closed?): {e}")
        raise
    except Exception as e:
        _log(f"Send error: {e}")
        raise


class NativeMessagingIO:
    """
    nativeMessaging の読み書きをスレッドセーフに行うラッパー。
    """

    def __init__(self):
        self._write_lock = threading.Lock()
        self._on_message_callback = None
        self._on_disconnect_callback = None
        self._running = False

    def on_message(self, callback):
        """メッセージ受信コールバックを設定"""
        self._on_message_callback = callback

    def on_disconnect(self, callback):
        """切断コールバックを設定"""
        self._on_disconnect_callback = callback

    def send(self, message: dict):
        """メッセージ送信 (スレッドセーフ)"""
        with self._write_lock:
            send_message(message)

    def read_loop(self):
        """
        stdin からメッセージを読み続ける (ブロッキングループ)。
        EOF または致命的エラーで終了し、on_disconnect を呼ぶ。
        """
        self._running = True
        try:
            while self._running:
                try:
                    msg = read_message()
                    if msg is None:
                        # EOF: ブラウザが接続を閉じた
                        _log("stdin EOF — browser disconnected")
                        break
                    if self._on_message_callback:
                        try:
                            self._on_message_callback(msg)
                        except Exception as e:
                            _log(f"Callback error: {e}")
                except Exception as e:
                    _log(f"Read error: {e}")
                    break
        finally:
            self._running = False
            if self._on_disconnect_callback:
                try:
                    self._on_disconnect_callback()
                except Exception as e:
                    _log(f"Disconnect callback error: {e}")

    def stop(self):
        """ループを停止フラグで止める（次のread_messageでブロック中の場合は即時停止しない）"""
        self._running = False
