// ======================================================
// ツールバーアイコン左クリック → AIチャットを開く
// ======================================================

browser.action.onClicked.addListener(async () => {
  const GENSPARK_CHAT_URL = "https://www.genspark.ai/agents?type=ai_chat";

  const tabs = await browser.tabs.query({
    url: "https://www.genspark.ai/agents*",
  });

  // bridge タブを除外してユーザーのタブを探す
  const existingTab = tabs.find(
    (tab) =>
      tab.url &&
      tab.url.includes("type=ai_chat") &&
      !bridgeTabs.has(tab.id)
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
// Native Messaging
// ======================================================

const NATIVE_APP_NAME = "genspark_bridge";
const GENSPARK_CHAT_URL = "https://www.genspark.ai/agents?type=ai_chat";

let nativePort = null;

function ensureNativePort() {
  if (nativePort) return nativePort;

  console.log("[GS Bridge] Connecting to native host:", NATIVE_APP_NAME);
  nativePort = browser.runtime.connectNative(NATIVE_APP_NAME);

  nativePort.onMessage.addListener((message) => {
    console.log("[GS Bridge] From native host:", message);
    handleNativeMessage(message);
  });

  nativePort.onDisconnect.addListener((p) => {
    const error = p.error || browser.runtime.lastError;
    console.warn(
      "[GS Bridge] Native host disconnected:",
      error?.message || "unknown"
    );
    nativePort = null;
  });

  return nativePort;
}

function sendToNativeHost(message) {
  try {
    const port = ensureNativePort();
    port.postMessage(message);
  } catch (e) {
    console.error("[GS Bridge] Failed to send to native host:", e);
    nativePort = null;
  }
}

function handleNativeMessage(message) {
  if (!message || !message.type) {
    console.warn("[GS Bridge] Invalid message:", message);
    return;
  }

  switch (message.type) {
    case "send_prompt":
      forwardPrompt(message);
      break;

    case "ping":
      sendToNativeHost({ type: "pong" });
      break;

    case "reset":
      // native-host 再起動時: 全 bridge タブをクリーンアップ
      console.log("[GS Bridge] Reset received, cleaning up bridge tabs");
      cleanupAllBridgeTabs();
      break;

    default:
      console.warn("[GS Bridge] Unknown type:", message.type);
  }
}

// ======================================================
// Bridge 管理タブレジストリ
//
// background.js が native-host リクエストのために
// *自ら作成した* タブだけを管理する。
// ======================================================

/**
 * @typedef {Object} BridgeTab
 * @property {number}            tabId
 * @property {"loading"|"idle"|"busy"} status
 * @property {string|null}       activeRequestId
 */

/** @type {Map<number, BridgeTab>} */
const bridgeTabs = new Map();

/**
 * bridge 用の新規タブを作成し、レジストリに登録する。
 * @returns {Promise<number>} tabId
 */
async function createBridgeTab() {
  const tab = await browser.tabs.create({
    url: GENSPARK_CHAT_URL,
    active: false,
  });

  bridgeTabs.set(tab.id, {
    tabId: tab.id,
    status: "loading",
    activeRequestId: null,
  });

  console.log("[GS Bridge] Created bridge tab:", tab.id);
  return tab.id;
}

/**
 * 全 bridge タブを閉じてレジストリをクリアする。
 */
function cleanupAllBridgeTabs() {
  for (const [tabId, entry] of bridgeTabs) {
    // busy だったリクエストにはエラーを返さない
    // （native-host 側も再起動しているため受け取る先がない）
    try {
      browser.tabs.remove(tabId);
    } catch {
      // 既に閉じている場合
    }
  }
  bridgeTabs.clear();
  console.log("[GS Bridge] All bridge tabs cleaned up");
}

// タブが閉じられたらレジストリから除去
browser.tabs.onRemoved.addListener((tabId) => {
  if (!bridgeTabs.has(tabId)) return;

  const entry = bridgeTabs.get(tabId);
  bridgeTabs.delete(tabId);
  console.log(
    "[GS Bridge] Bridge tab closed:",
    tabId,
    "remaining:",
    bridgeTabs.size
  );

  if (entry.status === "busy" && entry.activeRequestId) {
    sendToNativeHost({
      type: "error",
      request_id: entry.activeRequestId,
      tab_id: tabId,
      error: "Bridge tab was closed while processing request.",
    });
  }
});

// ======================================================
// タブロード完了の検知
// ======================================================

/**
 * タブロード待ちキュー。
 * タブ作成後、content script が ready になったら
 * ここに溜まったメッセージを送信する。
 * @type {Map<number, Object>}  tabId → message
 */
const pendingTabMessages = new Map();

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!bridgeTabs.has(tabId)) return;

  if (changeInfo.status === "complete") {
    const entry = bridgeTabs.get(tabId);
    if (entry.status === "loading") {
      waitForContentScriptReady(tabId);
    }
  }
});

/**
 * content script が応答可能 かつ SPA が初期化完了するまでリトライ。
 */
async function waitForContentScriptReady(tabId, retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await browser.tabs.sendMessage(tabId, {
        action: "ping",
      });
      if (response && response.status === "alive") {
        if (response.spaReady) {
          // content script 応答可能 & SPA 初期化済み
          const entry = bridgeTabs.get(tabId);
          if (entry) {
            entry.status = "idle";
            console.log("[GS Bridge] Bridge tab ready (SPA ready):", tabId);

            if (pendingTabMessages.has(tabId)) {
              const message = pendingTabMessages.get(tabId);
              pendingTabMessages.delete(tabId);
              await sendToTab(tabId, message);
            }
          }
          return;
        }
        // content script は応答するが SPA 未初期化 → 待つ
        console.log(
          "[GS Bridge] Content script alive but SPA not ready, waiting...",
          tabId
        );
      }
    } catch {
      // content script 未準備
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  // タイムアウト — SPA が初期化されなくても、
  // bridge.js 側の waitForSpaReady が独自にリトライするため、
  // ここではメッセージを送信して bridge.js 側に委ねる。
  console.warn(
    "[GS Bridge] SPA not confirmed ready after retries, " +
    "proceeding anyway:",
    tabId
  );
  const entry = bridgeTabs.get(tabId);
  if (entry) {
    entry.status = "idle";

    if (pendingTabMessages.has(tabId)) {
      const message = pendingTabMessages.get(tabId);
      pendingTabMessages.delete(tabId);
      await sendToTab(tabId, message);
    }
  }
}

// ======================================================
// プロンプト転送
//
// native-host から受信した send_prompt を適切なタブに送る。
//
//   tab_id あり → そのタブに送信（存在しなければエラー）
//   tab_id なし → 新規タブを作成して送信
// ======================================================

async function forwardPrompt(nativeMessage) {
  const requestId = nativeMessage.request_id;
  const text = nativeMessage.text;
  const tabId = nativeMessage.tab_id; // number or undefined

  const message = {
    action: "inject_and_send",
    text: text,
    requestId: requestId,
  };

  if (tabId != null) {
    // --- 会話継続: 指定タブに送信 ---
    const entry = bridgeTabs.get(tabId);

    if (!entry) {
      console.error(
        "[GS Bridge] tab_id",
        tabId,
        "not found in bridgeTabs"
      );
      sendToNativeHost({
        type: "error",
        request_id: requestId,
        tab_id: tabId,
        error: `Bridge tab ${tabId} not found (tab may have been closed).`,
      });
      return;
    }

    if (entry.status === "busy") {
      console.error(
        "[GS Bridge] tab_id",
        tabId,
        "is busy with",
        entry.activeRequestId
      );
      sendToNativeHost({
        type: "error",
        request_id: requestId,
        tab_id: tabId,
        error: `Bridge tab ${tabId} is busy with another request.`,
      });
      return;
    }

    if (entry.status === "loading") {
      console.warn(
        "[GS Bridge] tab_id",
        tabId,
        "still loading, queuing message"
      );
      pendingTabMessages.set(tabId, message);
      return;
    }

    // idle → 送信
    await sendToTab(tabId, message);
  } else {
    // --- 新規会話: タブを作成 ---
    try {
      const newTabId = await createBridgeTab();
      pendingTabMessages.set(newTabId, message);
      console.log(
        "[GS Bridge] New tab created:",
        newTabId,
        "request queued for load"
      );
    } catch (e) {
      console.error("[GS Bridge] Failed to create tab:", e);
      sendToNativeHost({
        type: "error",
        request_id: requestId,
        error: "Failed to create bridge tab: " + e.message,
      });
    }
  }
}

async function sendToTab(tabId, message) {
  const entry = bridgeTabs.get(tabId);
  if (!entry) {
    sendToNativeHost({
      type: "error",
      request_id: message.requestId,
      tab_id: tabId,
      error: "Bridge tab no longer exists.",
    });
    return;
  }

  entry.status = "busy";
  entry.activeRequestId = message.requestId;

  try {
    await browser.tabs.sendMessage(tabId, message);
    console.log(
      "[GS Bridge] Dispatched to tab:",
      tabId,
      "request:",
      message.requestId
    );
  } catch (e) {
    console.error("[GS Bridge] Send to tab failed:", tabId, e);
    entry.status = "idle";
    entry.activeRequestId = null;
    sendToNativeHost({
      type: "error",
      request_id: message.requestId,
      tab_id: tabId,
      error: "Failed to send to content script: " + e.message,
    });
  }
}

// ======================================================
// content script からのメッセージ受信
// ======================================================

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message) return;

  const tabId = sender.tab?.id;

  // --- content script → nativeHost 中継 ---
  if (message.target === "native_bridge") {
    if (tabId == null || !bridgeTabs.has(tabId)) {
      console.warn(
        "[GS Bridge] Ignoring native_bridge from non-bridge tab:",
        tabId
      );
      return;
    }

    const payload = message.payload;

    // tab_id を付与して native-host に送信
    payload.tab_id = tabId;

    sendToNativeHost(payload);

    if (
      payload.type === "stream_end" ||
      payload.type === "stream_error" ||
      payload.type === "error"
    ) {
      const entry = bridgeTabs.get(tabId);
      if (entry) {
        entry.status = "idle";
        entry.activeRequestId = null;
      }
    }
    return;
  }

  // --- bridge_register は無視 ---
  if (message.target === "bridge_register") {
    return;
  }
});

// ======================================================
// 起動時に native host へ接続
//
// connectNative() → Firefox が native_bridge.py を起動
// → native_bridge.py が api_server.py に TCP 接続
// ======================================================

(function initNativeConnection() {
  console.log("[GS Bridge] Initializing native host connection...");
  try {
    ensureNativePort();
    // 接続確認
    sendToNativeHost({ type: "ping" });
    console.log("[GS Bridge] Native host connection initiated");
  } catch (e) {
    console.error("[GS Bridge] Failed to connect to native host:", e);
    // 拡張機能ロード時にネイティブホストに接続できない場合、
    // 後で sendToNativeHost が呼ばれた時に再試行される
  }
})();
