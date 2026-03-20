// ======================================================
// ツールバーアイコン左クリック → AIチャットを開く
// ======================================================

browser.action.onClicked.addListener(async () => {
  const GENSPARK_CHAT_URL = "https://www.genspark.ai/agents?type=ai_chat";

  const tabs = await browser.tabs.query({
    url: "https://www.genspark.ai/agents*",
  });

  const existingTab = tabs.find(
    (tab) => tab.url && tab.url.includes("type=ai_chat")
  );

  if (existingTab) {
    await browser.tabs.update(existingTab.id, { active: true });
    await browser.windows.update(existingTab.windowId, { focused: true });
  } else {
    await browser.tabs.create({ url: GENSPARK_CHAT_URL });
  }
});

// ======================================================
// ツールバーアイコン右クリックメニュー → オプション
// ======================================================

browser.menus.create({
  id: "open-options",
  title: "オプション",
  contexts: ["action"],
});

browser.menus.onClicked.addListener((info) => {
  if (info.menuItemId === "open-options") {
    browser.runtime.openOptionsPage();
  }
});

// ======================================================
// Native Messaging ブリッジ
// ======================================================

const NATIVE_APP_NAME = "genspark_bridge";
let nativePort = null;
let contentTabId = null; // 現在アクティブなcontent scriptのタブID

/**
 * nativeHostへの接続を確立する。
 * 既に接続済みの場合は既存ポートを返す。
 */
function ensureNativePort() {
  if (nativePort) return nativePort;

  console.log("[GS Bridge] Connecting to native host:", NATIVE_APP_NAME);
  nativePort = browser.runtime.connectNative(NATIVE_APP_NAME);

  nativePort.onMessage.addListener((message) => {
    console.log("[GS Bridge] Received from native host:", message);
    handleNativeMessage(message);
  });

  nativePort.onDisconnect.addListener((p) => {
    const error = p.error || browser.runtime.lastError;
    console.warn("[GS Bridge] Native host disconnected:", error?.message || "unknown");
    nativePort = null;
  });

  return nativePort;
}

/**
 * nativeHost からのメッセージを処理する。
 * 主に「ユーザーメッセージをGensparkに入力して送信せよ」というコマンド。
 */
function handleNativeMessage(message) {
  // message の想定形式:
  // { type: "send_prompt", text: "ユーザーの質問テキスト", request_id: "xxx" }
  if (!message || !message.type) {
    console.warn("[GS Bridge] Invalid message from native host:", message);
    return;
  }

  switch (message.type) {
    case "send_prompt":
      forwardToContentScript({
        action: "inject_and_send",
        text: message.text,
        requestId: message.request_id,
      });
      break;

    case "ping":
      sendToNativeHost({ type: "pong" });
      break;

    default:
      console.warn("[GS Bridge] Unknown message type:", message.type);
  }
}

/**
 * content script にメッセージを転送する。
 * Genspark のタブが開いている必要がある。
 */
async function forwardToContentScript(message) {
  // Genspark タブを探す
  const tabs = await browser.tabs.query({
    url: "https://www.genspark.ai/agents*",
  });

  const targetTab = tabs.find(
    (tab) => tab.url && tab.url.includes("type=ai_chat")
  );

  if (!targetTab) {
    console.error("[GS Bridge] No Genspark AI Chat tab found. Opening one...");
    const newTab = await browser.tabs.create({
      url: "https://www.genspark.ai/agents?type=ai_chat",
    });
    contentTabId = newTab.id;
    // タブの読み込み完了を待ってからリトライ
    setTimeout(() => {
      browser.tabs.sendMessage(contentTabId, message).catch((e) => {
        console.error("[GS Bridge] Failed to send to content script:", e);
        sendToNativeHost({
          type: "error",
          request_id: message.requestId,
          error: "Content script not ready. Please retry.",
        });
      });
    }, 5000);
    return;
  }

  contentTabId = targetTab.id;

  try {
    await browser.tabs.sendMessage(contentTabId, message);
  } catch (e) {
    console.error("[GS Bridge] Failed to send to content script:", e);
    sendToNativeHost({
      type: "error",
      request_id: message.requestId,
      error: "Failed to communicate with content script: " + e.message,
    });
  }
}

/**
 * nativeHost にメッセージを送信する。
 */
function sendToNativeHost(message) {
  try {
    const port = ensureNativePort();
    port.postMessage(message);
  } catch (e) {
    console.error("[GS Bridge] Failed to send to native host:", e);
    nativePort = null;
  }
}

// ======================================================
// content script からのメッセージ受信
// ======================================================

browser.runtime.onMessage.addListener((message, sender) => {
  // content script からの応答ストリームデータをnativeHostに中継
  if (message && message.target === "native_bridge") {
    sendToNativeHost(message.payload);
    return;
  }
});
