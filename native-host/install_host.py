"""
Windows 用: nativeMessaging ホストのレジストリ登録 & app manifest 自動生成

管理者権限は不要（HKEY_CURRENT_USER を使用）。
"""

import os
import sys
import json
import winreg

APP_NAME = "genspark_bridge"
EXTENSION_ID = "genspark-ai-chat-enhancer@example.org"

def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    bat_path = os.path.join(script_dir, f"{APP_NAME}.bat")
    manifest_path = os.path.join(script_dir, f"{APP_NAME}.json")

    if not os.path.exists(bat_path):
        print(f"ERROR: {bat_path} が見つかりません。")
        sys.exit(1)

    # app manifest を生成（パスを自動設定）
    manifest = {
        "name": APP_NAME,
        "description": "Genspark AI Chat Bridge - Native Host",
        "path": bat_path,
        "type": "stdio",
        "allowed_extensions": [EXTENSION_ID],
    }

    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)

    print(f"App manifest written: {manifest_path}")

    # レジストリに登録
    reg_key_path = rf"Software\Mozilla\NativeMessagingHosts\{APP_NAME}"

    try:
        key = winreg.CreateKeyEx(
            winreg.HKEY_CURRENT_USER,
            reg_key_path,
            0,
            winreg.KEY_WRITE,
        )
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, manifest_path)
        winreg.CloseKey(key)
        print(f"Registry key set: HKCU\\{reg_key_path}")
        print(f"  Default value: {manifest_path}")
    except Exception as e:
        print(f"ERROR: Registry write failed: {e}")
        sys.exit(1)

    print()
    print("=== Setup Complete ===")
    print(f"Native host app:  {bat_path}")
    print(f"App manifest:     {manifest_path}")
    print(f"Extension ID:     {EXTENSION_ID}")
    print()
    print("次のステップ:")
    print("  1. pip install -r requirements.txt")
    print("  2. Firefoxで拡張機能を再読み込み")
    print("  3. Genspark AI Chat ページを開く")
    print("  4. 外部クライアントから http://localhost:5000/v1/chat/completions へリクエスト")


if __name__ == "__main__":
    if sys.platform != "win32":
        print("このスクリプトは Windows 用です。")
        sys.exit(1)
    main()
