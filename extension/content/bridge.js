// bridge.js — Native Messaging Bridge (content script 側)
//
// ※ このスクリプトは全 Genspark タブに注入されるが、
//    background.js が管理する bridge タブにのみメッセージが送られる。
//    非 bridge タブではこのスクリプトは何もしない（ping 応答のみ）。
//
(function () {
  "use strict";
  const ns = window.__gsEnhancer;
  const SEL = ns.SELECTORS;

  const LOG = "[GS Bridge]";

  // ======================================================
  // Genspark 固有セレクタ
  // ======================================================
  const GS = {
    input: "textarea.j-search-input",
    sendButton: ".enter-icon .enter-icon-wrapper",
    loadingIndicator: ".is_asking",
  };

  // ======================================================
  // タイミング設定
  // ======================================================
  const TIMING = {
    inputToSendMs: 200,
    sendToWatchMs: 800,
    pollMs: 200,
    responseTimeoutMs: 60000,
    finishGraceMs: 500,
    deltaThrottleMs: 100,
    safetyTimeoutMs: 300000,
  };

  // ======================================================
  // 内部状態
  // ======================================================
  let currentRequestId = null;
  let isStreaming = false;
  let lastSentText = "";
  let assistantCountBeforeSend = 0;

  let streamObserver = null;
  let loadingObserver = null;
  let pollTimer = null;
  let safetyTimer = null;
  let deltaThrottleTimer = null;

  // ======================================================
  // background.js への送信
  // ======================================================
  function sendToBg(payload) {
    browser.runtime.sendMessage({
      target: "native_bridge",
      payload: payload,
    });
  }

  // ======================================================
  // DOM ヘルパー
  // ======================================================

  function getAllAssistantStatements() {
    const container = document.querySelector(SEL.conversationContent);
    if (!container) return [];
    return Array.from(
      container.querySelectorAll(".conversation-statement.assistant")
    );
  }

  function getLatestAssistantViewer() {
    const stmts = getAllAssistantStatements();
    if (stmts.length === 0) return null;
    return stmts[stmts.length - 1].querySelector(SEL.assistantTextContent);
  }

  function isPageLoading() {
    return document.querySelector(GS.loadingIndicator) !== null;
  }

  // ======================================================
  // テキスト入力 & 送信
  // ======================================================

  function injectTextAndSend(text) {
    const textarea = document.querySelector(GS.input);
    if (!textarea) {
      console.error(LOG, "Input textarea not found");
      sendToBg({
        type: "error",
        request_id: currentRequestId,
        error: "Chat input textarea not found.",
      });
      return false;
    }

    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set;

    if (nativeSetter) {
      nativeSetter.call(textarea, text);
    } else {
      textarea.value = text;
    }

    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));

    textarea.style.height = "auto";
    textarea.style.height = textarea.scrollHeight + "px";

    console.log(LOG, "Text injected, length:", text.length);

    setTimeout(() => {
      clickSend(textarea);
    }, TIMING.inputToSendMs);

    return true;
  }

  function clickSend(textarea) {
    const sendEl = document.querySelector(GS.sendButton);
    if (sendEl) {
      console.log(LOG, "Clicking send element");
      sendEl.click();
      return;
    }

    console.log(LOG, "Send element not found, pressing Enter");
    textarea.focus();
    const opts = {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    };
    textarea.dispatchEvent(new KeyboardEvent("keydown", opts));
    textarea.dispatchEvent(new KeyboardEvent("keypress", opts));
    textarea.dispatchEvent(new KeyboardEvent("keyup", opts));
  }

  // ======================================================
  // ストリーミング監視
  // ======================================================

  function startStreamWatcher(requestId) {
    cleanup();
    currentRequestId = requestId;
    lastSentText = "";
    isStreaming = true;

    console.log(LOG, "Starting stream watcher:", requestId);

    const pollStart = Date.now();
    pollTimer = setInterval(() => {
      if (Date.now() - pollStart > TIMING.responseTimeoutMs) {
        console.warn(LOG, "Timed out waiting for response");
        sendToBg({
          type: "stream_error",
          request_id: currentRequestId,
          error: "Timed out waiting for assistant response",
        });
        cleanup();
        return;
      }

      const currentCount = getAllAssistantStatements().length;
      const loading = isPageLoading();

      if (currentCount > assistantCountBeforeSend || loading) {
        clearInterval(pollTimer);
        pollTimer = null;

        const viewerPollStart = Date.now();
        const viewerPoll = setInterval(() => {
          const viewer = getLatestAssistantViewer();
          if (viewer) {
            clearInterval(viewerPoll);
            beginObserving(viewer);
            return;
          }
          if (Date.now() - viewerPollStart > 5000) {
            clearInterval(viewerPoll);
            console.warn(LOG, "Viewer not found after response started");
            beginObserving(null);
          }
        }, TIMING.pollMs);
      }
    }, TIMING.pollMs);

    safetyTimer = setTimeout(() => {
      if (isStreaming) {
        console.warn(LOG, "Safety timeout reached");
        finishStream(getLatestAssistantViewer());
      }
    }, TIMING.safetyTimeoutMs);
  }

  function beginObserving(viewer) {
    console.log(LOG, "Begin observing, viewer:", !!viewer);

    if (viewer) {
      sendStreamDelta(viewer);

      streamObserver = new MutationObserver(() => {
        if (!deltaThrottleTimer) {
          deltaThrottleTimer = setTimeout(() => {
            deltaThrottleTimer = null;
            sendStreamDelta(viewer);
          }, TIMING.deltaThrottleMs);
        }
      });

      streamObserver.observe(viewer, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }

    if (!isPageLoading()) {
      console.log(LOG, ".is_asking not present, short-response path");
      setTimeout(() => {
        if (isStreaming) {
          finishStream(viewer || getLatestAssistantViewer());
        }
      }, 2000);
      return;
    }

    loadingObserver = new MutationObserver(() => {
      if (!isPageLoading()) {
        console.log(LOG, ".is_asking disappeared — stream complete");
        setTimeout(() => {
          if (isStreaming) {
            finishStream(viewer || getLatestAssistantViewer());
          }
        }, TIMING.finishGraceMs);
      }
    });

    const observeTarget =
      document.querySelector(SEL.conversationContent) || document.body;

    loadingObserver.observe(observeTarget, {
      childList: true,
      subtree: true,
    });
  }

  // ======================================================
  // 差分送信
  // ======================================================

  function sendStreamDelta(viewer) {
    if (!viewer) return;
    const currentText = viewer.textContent || "";
    if (currentText === lastSentText) return;

    const delta = currentText.substring(lastSentText.length);
    lastSentText = currentText;

    if (delta) {
      sendToBg({
        type: "stream_delta",
        request_id: currentRequestId,
        delta: delta,
        full_text: currentText,
      });
    }
  }

  // ======================================================
  // 完了 & クリーンアップ
  // ======================================================

  function finishStream(viewer) {
    if (!isStreaming) return;
    isStreaming = false;

    const finalViewer = viewer || getLatestAssistantViewer();
    const finalText = finalViewer
      ? finalViewer.textContent || ""
      : lastSentText;

    if (finalText !== lastSentText) {
      const remaining = finalText.substring(lastSentText.length);
      if (remaining) {
        sendToBg({
          type: "stream_delta",
          request_id: currentRequestId,
          delta: remaining,
          full_text: finalText,
        });
      }
    }

    sendToBg({
      type: "stream_end",
      request_id: currentRequestId,
      full_text: finalText,
    });

    console.log(
      LOG,
      "Stream finished:",
      currentRequestId,
      "length:",
      finalText.length
    );

    cleanup();
  }

  function cleanup() {
    isStreaming = false;
    if (streamObserver) {
      streamObserver.disconnect();
      streamObserver = null;
    }
    if (loadingObserver) {
      loadingObserver.disconnect();
      loadingObserver = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (safetyTimer) {
      clearTimeout(safetyTimer);
      safetyTimer = null;
    }
    if (deltaThrottleTimer) {
      clearTimeout(deltaThrottleTimer);
      deltaThrottleTimer = null;
    }
  }

  // ======================================================
  // background.js からのメッセージ受信
  //
  // このリスナーは全 Genspark タブに存在するが、
  // background.js は bridge タブにしかメッセージを送らないため、
  // ユーザーの通常タブでは inject_and_send が呼ばれることはない。
  // ======================================================

  browser.runtime.onMessage.addListener((message, sender) => {
    if (!message || !message.action) return;

    switch (message.action) {
      case "inject_and_send": {
        console.log(
          LOG,
          "Received inject_and_send:",
          message.text?.substring(0, 80)
        );

        if (isStreaming) {
          console.warn(LOG, "Already streaming, rejecting");
          sendToBg({
            type: "error",
            request_id: message.requestId,
            error: "This tab is already processing a request.",
          });
          return;
        }

        currentRequestId = message.requestId;
        assistantCountBeforeSend = getAllAssistantStatements().length;

        const success = injectTextAndSend(message.text);
        if (success) {
          sendToBg({
            type: "prompt_sent",
            request_id: message.requestId,
          });

          setTimeout(() => {
            startStreamWatcher(message.requestId);
          }, TIMING.sendToWatchMs);
        }
        break;
      }

      case "ping":
        return Promise.resolve({ status: "alive" });
    }
  });

  // ======================================================
  // ※ registerSelf() は削除。
  //    bridge タブの管理は background.js が主導する。
  //    全タブに注入されるが、background.js が
  //    tabs.sendMessage で bridge タブにのみ送信するため、
  //    ユーザーの通常タブでは bridge 処理は発生しない。
  // ======================================================

  // ======================================================
  // 外部公開（デバッグ用）
  // ======================================================
  ns.bridge = {
    cleanup,
    get isStreaming() {
      return isStreaming;
    },
    get currentRequestId() {
      return currentRequestId;
    },
  };
})();
