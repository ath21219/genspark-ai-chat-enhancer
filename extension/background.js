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
      requestManager.enqueue({
        action: "inject_and_send",
        text: message.text,
        requestId: message.request_id,
        conversationId: message.conversation_id || null,
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
// Bridge 管理タブレジストリ
//
// background.js が native-host リクエストのために
// *自ら作成した* タブだけを管理する。
// ユーザーが手動で開いたタブは一切登録しない。
// ======================================================

/**
 * @typedef {Object} BridgeTab
 * @property {number}        tabId
 * @property {"loading"|"ready"|"idle"|"busy"} status
 * @property {string|null}   activeRequestId
 * @property {string|null}   conversationId  — このタブが担当する会話
 */

/** @type {Map<number, BridgeTab>} */
const bridgeTabs = new Map();

/**
 * bridge 用の新規タブを作成し、レジストリに登録する。
 * @param {string|null} conversationId — 紐付ける会話ID
 * @returns {Promise<number>} tabId
 */
async function createBridgeTab(conversationId) {
  const tab = await browser.tabs.create({
    url: GENSPARK_CHAT_URL,
    active: false, // バックグラウンドで開く
  });

  bridgeTabs.set(tab.id, {
    tabId: tab.id,
    status: "loading",
    activeRequestId: null,
    conversationId: conversationId,
  });

  console.log(
    "[GS Bridge] Created bridge tab:", tab.id,
    "conversation:", conversationId
  );

  return tab.id;
}

/**
 * 指定 conversationId に紐付いた idle な bridge タブを探す。
 * conversationId が null なら、conversationId が null の idle タブを探す。
 */
function findBridgeTabForConversation(conversationId) {
  for (const [tabId, entry] of bridgeTabs) {
    if (entry.conversationId === conversationId && entry.status === "idle") {
      return tabId;
    }
  }
  return null;
}

/**
 * conversationId に関係なく idle なタブを探す（新規会話用のフォールバック）。
 * → 使わない。新規会話は常に新規タブを作成する。
 */

// タブが閉じられたらレジストリから除去
browser.tabs.onRemoved.addListener((tabId) => {
  if (!bridgeTabs.has(tabId)) return;

  const entry = bridgeTabs.get(tabId);
  bridgeTabs.delete(tabId);
  console.log(
    "[GS Bridge] Bridge tab closed:", tabId,
    "remaining:", bridgeTabs.size
  );

  // busy だったタブが閉じられた場合
  if (entry.status === "busy" && entry.activeRequestId) {
    sendToNativeHost({
      type: "error",
      request_id: entry.activeRequestId,
      error: "Bridge tab was closed while processing request.",
    });
  }

  requestManager.dispatchNext();
});

// ======================================================
// タブロード完了の検知
//
// bridge タブが loading → ready にするために、
// tabs.onUpdated で status=complete を監視する。
// ======================================================

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!bridgeTabs.has(tabId)) return;

  if (changeInfo.status === "complete") {
    const entry = bridgeTabs.get(tabId);
    if (entry.status === "loading") {
      // ページロード完了。content script の準備を確認する。
      waitForContentScriptReady(tabId);
    }
  }
});

/**
 * content script が応答可能になるまでリトライ ping する。
 */
async function waitForContentScriptReady(tabId, retries = 15) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await browser.tabs.sendMessage(tabId, {
        action: "ping",
      });
      if (response && response.status === "alive") {
        const entry = bridgeTabs.get(tabId);
        if (entry) {
          entry.status = "idle";
          console.log("[GS Bridge] Bridge tab ready:", tabId);
          requestManager.dispatchNext();
        }
        return;
      }
    } catch {
      // content script 未準備 → 待つ
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  // タイムアウト
  console.error("[GS Bridge] Content script not ready after retries:", tabId);
  const entry = bridgeTabs.get(tabId);
  if (entry) {
    // タブは残すが loading のまま。
    // このタブに紐付いたキューのリクエストがあればエラーを返す。
    // dispatchNext が再度新しいタブを作成する可能性がある。
    entry.status = "idle"; // 一応 idle にして再試行を許可
    requestManager.dispatchNext();
  }
}

// ======================================================
// リクエストマネージャ
//
// native-host からのリクエストをキューに入れ、
// 適切な bridge タブにディスパッチする。
//
// ルール:
//   - conversationId が指定されている場合:
//     → そのIDに紐付いた idle なタブを使う
//     → 無ければキューで待機（タブが busy を終えるのを待つ）
//     → 紐付いたタブ自体が無い場合はエラー（会話が失われた）
//   - conversationId が null（新規会話）の場合:
//     → 新規タブを作成
// ======================================================

const requestManager = {
  /** @type {Array<Object>} */
  queue: [],

  enqueue(message) {
    console.log(
      "[GS Bridge] Enqueue:", message.requestId,
      "conversation:", message.conversationId
    );
    this.queue.push(message);
    this.dispatchNext();
  },

  async dispatchNext() {
    if (this.queue.length === 0) return;

    // キューの先頭を確認（まだ取り出さない）
    const message = this.queue[0];
    const convId = message.conversationId;

    if (convId) {
      // --- 会話継続リクエスト ---
      const tabId = findBridgeTabForConversation(convId);

      if (tabId !== null) {
        // idle なタブあり → ディスパッチ
        this.queue.shift();
        await this._sendToTab(tabId, message);
        return;
      }

      // そのconversationIdのタブが存在するか確認
      let tabExists = false;
      for (const [, entry] of bridgeTabs) {
        if (entry.conversationId === convId) {
          tabExists = true;
          break;
        }
      }

      if (tabExists) {
        // タブはあるが busy → 待機
        console.log(
          "[GS Bridge] Conversation tab busy, waiting:",
          convId
        );
        return;
      }

      // タブが無い（閉じられた等）→ エラー
      this.queue.shift();
      console.error(
        "[GS Bridge] No tab for conversation:", convId
      );
      sendToNativeHost({
        type: "error",
        request_id: message.requestId,
        error: `Bridge tab for conversation ${convId} no longer exists.`,
      });
      // 次のキューを処理
      this.dispatchNext();
      return;
    }

    // --- 新規会話リクエスト (conversationId === null) ---
    this.queue.shift();

    try {
      const newTabId = await createBridgeTab(null);
      // conversationId は native-host からの stream_end 後に
      // 次のリクエストで割り当てられる。
      // タブは loading 状態。ready になったら _sendToTab する。
      // → ロード待ちキューに入れる
      this._waitingForTab.push({ tabId: newTabId, message });
      console.log(
        "[GS Bridge] Waiting for new tab to load:", newTabId
      );
    } catch (e) {
      console.error("[GS Bridge] Failed to create tab:", e);
      sendToNativeHost({
        type: "error",
        request_id: message.requestId,
        error: "Failed to create bridge tab: " + e.message,
      });
      this.dispatchNext();
    }
  },

  /** @type {Array<{tabId: number, message: Object}>} */
  _waitingForTab: [],

  /**
   * タブが ready になったとき、_waitingForTab にそのタブ向けの
   * リクエストがあれば送信する。
   * dispatchNext() から呼ばれる経路で間接的に処理される。
   */
  async checkWaitingForTab() {
    const stillWaiting = [];

    for (const item of this._waitingForTab) {
      const entry = bridgeTabs.get(item.tabId);
      if (!entry) {
        // タブが消えた
        sendToNativeHost({
          type: "error",
          request_id: item.message.requestId,
          error: "Bridge tab closed before becoming ready.",
        });
        continue;
      }

      if (entry.status === "idle") {
        await this._sendToTab(item.tabId, item.message);
      } else {
        stillWaiting.push(item);
      }
    }

    this._waitingForTab = stillWaiting;
  },

  async _sendToTab(tabId, message) {
    const requestId = message.requestId;
    const entry = bridgeTabs.get(tabId);
    if (!entry) {
      sendToNativeHost({
        type: "error",
        request_id: requestId,
        error: "Bridge tab no longer exists.",
      });
      return;
    }

    entry.status = "busy";
    entry.activeRequestId = requestId;

    try {
      await browser.tabs.sendMessage(tabId, message);
      console.log(
        "[GS Bridge] Dispatched to bridge tab:", tabId,
        "request:", requestId
      );
    } catch (e) {
      console.error("[GS Bridge] Send to tab failed:", tabId, e);
      entry.status = "idle";
      entry.activeRequestId = null;
      sendToNativeHost({
        type: "error",
        request_id: requestId,
        error: "Failed to send to content script: " + e.message,
      });
      this.dispatchNext();
    }
  },
};

// dispatchNext をオーバーライドして _waitingForTab も処理
const _originalDispatchNext = requestManager.dispatchNext.bind(requestManager);
requestManager.dispatchNext = async function () {
  await this.checkWaitingForTab();
  await _originalDispatchNext();
};

// ======================================================
// content script からのメッセージ受信
// ======================================================

browser.runtime.onMessage.addListener((message, sender) => {
  if (!message) return;

  const tabId = sender.tab?.id;

  // --- content script → nativeHost 中継 ---
  if (message.target === "native_bridge") {
    // bridge タブからのメッセージのみ中継する
    if (tabId == null || !bridgeTabs.has(tabId)) {
      console.warn(
        "[GS Bridge] Ignoring native_bridge message from non-bridge tab:",
        tabId
      );
      return;
    }

    const payload = message.payload;
    sendToNativeHost(payload);

    // stream_end / error でタブを idle に戻す
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
      requestManager.dispatchNext();
    }
    return;
  }

  // --- bridge_register は無視（自動登録を廃止） ---
  if (message.target === "bridge_register") {
    // 何もしない。bridge タブの管理は background.js が主導。
    return;
  }
});
