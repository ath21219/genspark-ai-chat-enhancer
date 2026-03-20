"""
nativeMessaging プロトコル (stdin/stdout) の読み書きモジュール。
Firefox の nativeMessaging は length-prefixed JSON (32bit LE) を使う。
"""

import sys
import json
import struct
import threading


def read_message():
    """stdin から 1メッセージを読み取る (ブロッキング)"""
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length or len(raw_length) < 4:
        return None
    message_length = struct.unpack("@I", raw_length)[0]
    raw_message = sys.stdin.buffer.read(message_length)
    if not raw_message:
        return None
    return json.loads(raw_message.decode("utf-8"))


def send_message(message: dict):
    """stdout に 1メッセージを書き込む"""
    encoded = json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    header = struct.pack("@I", len(encoded))
    sys.stdout.buffer.write(header)
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


class NativeMessagingIO:
    """
    nativeMessaging の読み書きをスレッドセーフに行うラッパー。
    send_message はロック付き (複数スレッドから呼ばれる想定)。
    """

    def __init__(self):
        self._write_lock = threading.Lock()
        self._on_message_callback = None

    def on_message(self, callback):
        """メッセージ受信コールバックを設定"""
        self._on_message_callback = callback

    def send(self, message: dict):
        """メッセージ送信 (スレッドセーフ)"""
        with self._write_lock:
            send_message(message)

    def read_loop(self):
        """stdin からメッセージを読み続ける (ブロッキングループ)"""
        while True:
            try:
                msg = read_message()
                if msg is None:
                    break
                if self._on_message_callback:
                    self._on_message_callback(msg)
            except Exception as e:
                sys.stderr.write(f"[NativeMessaging] Read error: {e}\n")
                sys.stderr.flush()
                break
