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
    console.warn("[GS Bridge] Native host disconnected:",
      error?.message || "unknown");
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
      requestManager.enqueue({
        action: "inject_and_send",
        text: message.text,
        requestId: message.request_id,
      });
      break;

    case "ping":
      sendToNativeHost({ type: "pong" });
      break;

    default:
      console.warn("[GS Bridge] Unknown type:", message.type);
  }
}

// ======================================================
// タブレジストリ
//
// 各 Genspark AI Chat タブの状態を管理する。
// content script が起動時に "register" を送り、
// リクエスト完了時に "idle" を報告する。
// ======================================================

/**
 * @typedef {Object} TabEntry
 * @property {number}      tabId
 * @property {"idle"|"busy"} status
 * @property {string|null} activeRequestId  — busy 時に処理中のリクエストID
 */

/** @type {Map<number, TabEntry>} */
const tabRegistry = new Map();

/**
 * タブレジストリに登録する。既に存在する場合は状態を更新。
 */
function registerTab(tabId) {
  if (!tabRegistry.has(tabId)) {
    tabRegistry.set(tabId, {
      tabId,
      status: "idle",
      activeRequestId: null,
    });
    console.log("[GS Bridge] Tab registered:", tabId,
      "total:", tabRegistry.size);
  }
}

/**
 * タブを busy にする。
 */
function markTabBusy(tabId, requestId) {
  const entry = tabRegistry.get(tabId);
  if (entry) {
    entry.status = "busy";
    entry.activeRequestId = requestId;
  }
}

/**
 * タブを idle にする。キューに待機中リクエストがあれば次をディスパッチ。
 */
function markTabIdle(tabId) {
  const entry = tabRegistry.get(tabId);
  if (entry) {
    entry.status = "idle";
    entry.activeRequestId = null;
  }
  // キューに待ちがあれば次を処理
  requestManager.dispatchNext();
}

/**
 * idle 状態のタブIDを1つ返す。無ければ null。
 */
function findIdleTab() {
  for (const [tabId, entry] of tabRegistry) {
    if (entry.status === "idle") return tabId;
  }
  return null;
}

// タブが閉じられたらレジストリから除去
browser.tabs.onRemoved.addListener((tabId) => {
  if (tabRegistry.has(tabId)) {
    const entry = tabRegistry.get(tabId);
    tabRegistry.delete(tabId);
    console.log("[GS Bridge] Tab removed:", tabId,
      "remaining:", tabRegistry.size);

    // busy だったタブが閉じられた場合、そのリクエストにエラーを返す
    if (entry.status === "busy" && entry.activeRequestId) {
      sendToNativeHost({
        type: "error",
        request_id: entry.activeRequestId,
        error: "Tab was closed while processing request.",
      });
    }

    // キューに待ちがあれば他のタブでディスパッチ試行
    requestManager.dispatchNext();
  }
});

// ======================================================
// リクエストマネージャ
//
// nativeHost からのリクエストをキューに入れ、
// idle なタブに順次ディスパッチする。
// ======================================================

const requestManager = {
  /** @type {Array<Object>} 待機中のリクエスト */
  queue: [],

  /**
   * リクエストをキューに追加し、ディスパッチを試みる。
   */
  enqueue(message) {
    console.log("[GS Bridge] Enqueue request:", message.requestId);
    this.queue.push(message);
    this.dispatchNext();
  },

  /**
   * キューの先頭リクエストを idle なタブにディスパッチする。
   */
  async dispatchNext() {
    if (this.queue.length === 0) return;

    const idleTabId = findIdleTab();

    if (idleTabId !== null) {
      // idle タブがある → 即座にディスパッチ
      const message = this.queue.shift();
      await this._sendToTab(idleTabId, message);
      return;
    }

    // idle タブが無い場合:
    // レジストリにタブが1つも無ければ新規タブを開く
    if (tabRegistry.size === 0) {
      console.log("[GS Bridge] No tabs available, opening new tab...");
      try {
        const newTab = await browser.tabs.create({ url: GENSPARK_CHAT_URL });
        // content script の準備完了を待ってからディスパッチ
        // registerTab は content script 側から register メッセージで行われる
        // → dispatchNext は register 受信時に再呼び出しされる
        console.log("[GS Bridge] New tab created:", newTab.id,
          "waiting for content script...");
      } catch (e) {
        console.error("[GS Bridge] Failed to create tab:", e);
        // キューの先頭リクエストにエラーを返す
        const message = this.queue.shift();
        if (message) {
          sendToNativeHost({
            type: "error",
            request_id: message.requestId,
            error: "Failed to open Genspark tab: " + e.message,
          });
        }
      }
      return;
    }

    // タブはあるが全て busy → キューで待機
    console.log("[GS Bridge] All tabs busy, request queued.",
      "queue:", this.queue.length, "tabs:", tabRegistry.size);
  },

  /**
   * 指定タブにメッセージを送信する。
   */
  async _sendToTab(tabId, message) {
    const requestId = message.requestId;
    markTabBusy(tabId, requestId);

    try {
      await browser.tabs.sendMessage(tabId, message);
      console.log("[GS Bridge] Dispatched to tab:", tabId,
        "request:", requestId);
    } catch (e) {
      console.error("[GS Bridge] Send to tab failed:", tabId, e);
      markTabIdle(tabId);
      sendToNativeHost({
        type: "error",
        request_id: requestId,
        error: "Failed to send to content script: " + e.message,
      });
      // 失敗したリクエストは再キューしない（エラー返却済み）
      // 次のキュー待ちをディスパッチ
      this.dispatchNext();
    }
  },
};

// ======================================================
// content script からのメッセージ受信
// ======================================================

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message) return;

  // --- content script → nativeHost 中継 ---
  if (message.target === "native_bridge") {
    const payload = message.payload;
    sendToNativeHost(payload);

    // stream_end / error でタブを idle に戻す
    if (payload.type === "stream_end" || payload.type === "stream_error"
      || payload.type === "error") {
      if (sender.tab?.id) {
        markTabIdle(sender.tab.id);
      }
    }
    return;
  }

  // --- content script の登録 ---
  if (message.target === "bridge_register") {
    if (sender.tab?.id) {
      registerTab(sender.tab.id);
      // 新規登録されたのでキューのディスパッチを試みる
      requestManager.dispatchNext();
    }
    return;
  }
});
