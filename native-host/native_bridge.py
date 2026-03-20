"""
native_bridge.py — nativeMessaging ホスト

Firefox が connectNative() で起動するプロセス。
stdin/stdout で Firefox と通信し、TCP で api_server.py と通信する。
このプロセス自体は API サーバを持たない。
"""

import sys
import json
import socket
import struct
import threading
import time

def log(msg: str):
    sys.stderr.write(f"[NativeBridge] {msg}\n")
    sys.stderr.flush()


# ======================================================
# nativeMessaging 読み書き (stdin/stdout)
# ======================================================

write_lock = threading.Lock()

def read_native_message():
    """stdin から 1 メッセージ読み取り"""
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length or len(raw_length) < 4:
        return None
    length = struct.unpack("@I", raw_length)[0]
    if length == 0 or length > 1024 * 1024:
        return None
    raw = sys.stdin.buffer.read(length)
    if not raw or len(raw) < length:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None


def send_native_message(message: dict):
    """stdout に 1 メッセージ書き込み"""
    with write_lock:
        encoded = json.dumps(
            message, separators=(",", ":"), ensure_ascii=False
        ).encode("utf-8")
        sys.stdout.buffer.write(struct.pack("@I", len(encoded)))
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()


# ======================================================
# TCP 接続 (api_server.py と通信)
# ======================================================

API_HOST = "127.0.0.1"
API_PORT = 5001  # api_server.py の内部通信ポート

tcp_socket = None
tcp_lock = threading.Lock()
tcp_buffer = b""


def connect_tcp():
    """api_server.py への TCP 接続を確立"""
    global tcp_socket
    while True:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.connect((API_HOST, API_PORT))
            s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            tcp_socket = s
            log(f"Connected to api_server at {API_HOST}:{API_PORT}")
            return
        except ConnectionRefusedError:
            log("api_server not available, retrying in 2s...")
            time.sleep(2)
        except Exception as e:
            log(f"TCP connect error: {e}, retrying in 2s...")
            time.sleep(2)


def send_tcp_message(message: dict):
    """TCP で api_server にメッセージ送信 (length-prefixed JSON)"""
    global tcp_socket
    with tcp_lock:
        if not tcp_socket:
            connect_tcp()
        encoded = json.dumps(
            message, separators=(",", ":"), ensure_ascii=False
        ).encode("utf-8")
        header = struct.pack("!I", len(encoded))
        try:
            tcp_socket.sendall(header + encoded)
        except (BrokenPipeError, OSError) as e:
            log(f"TCP send error: {e}, reconnecting...")
            tcp_socket = None
            connect_tcp()
            tcp_socket.sendall(header + encoded)


def read_tcp_message():
    """TCP から 1 メッセージ読み取り (ブロッキング)"""
    global tcp_socket, tcp_buffer
    while True:
        # ヘッダ (4 bytes) を待つ
        while len(tcp_buffer) < 4:
            try:
                data = tcp_socket.recv(4096)
            except (OSError, AttributeError):
                return None
            if not data:
                return None
            tcp_buffer += data

        length = struct.unpack("!I", tcp_buffer[:4])[0]
        # ボディを待つ
        while len(tcp_buffer) < 4 + length:
            try:
                data = tcp_socket.recv(4096)
            except (OSError, AttributeError):
                return None
            if not data:
                return None
            tcp_buffer += data

        raw = tcp_buffer[4:4 + length]
        tcp_buffer = tcp_buffer[4 + length:]

        try:
            return json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            log("TCP message decode error")
            return None


# ======================================================
# メインループ
# ======================================================

def native_to_tcp():
    """Firefox → api_server: stdin のメッセージを TCP に転送"""
    while True:
        msg = read_native_message()
        if msg is None:
            log("stdin closed, shutting down")
            break
        log(f"Browser→API: {msg.get('type', '?')}")
        send_tcp_message(msg)
    # stdin が閉じた = ブラウザが切断 → プロセス終了
    sys.exit(0)


def tcp_to_native():
    """api_server → Firefox: TCP のメッセージを stdout に転送"""
    while True:
        msg = read_tcp_message()
        if msg is None:
            log("TCP connection lost, reconnecting...")
            connect_tcp()
            continue
        log(f"API→Browser: {msg.get('type', '?')}")
        try:
            send_native_message(msg)
        except (BrokenPipeError, OSError):
            log("stdout closed, shutting down")
            sys.exit(0)


def main():
    log("Starting native bridge...")

    # TCP 接続
    connect_tcp()

    # api_server に接続通知
    send_tcp_message({"type": "bridge_connected"})

    # 双方向転送スレッド
    t1 = threading.Thread(target=native_to_tcp, daemon=True)
    t2 = threading.Thread(target=tcp_to_native, daemon=True)
    t1.start()
    t2.start()

    # メインスレッドは t1 (stdin読み取り) の終了を待つ
    t1.join()


if __name__ == "__main__":
    main()
