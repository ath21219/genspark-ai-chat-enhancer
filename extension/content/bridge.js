// bridge.js — Native Messaging Bridge (content script 側)
//
// ストリーミング戦略:
//   Genspark のストリーミングは途中でテキストが何度も置換されるため、
//   .is_asking が消滅する（=完了）まで一切テキストを送信しない。
//   完了後に最終テキストを一括で送信する。
//
(function () {
  "use strict";
  const ns = window.__gsEnhancer;
  const SEL = ns.SELECTORS;

  const LOG = "[GS Bridge]";

  const GS = {
    input: "textarea.j-search-input",
    sendButton: ".enter-icon .enter-icon-wrapper",
    loadingIndicator: ".is_asking",
  };

  const TIMING = {
    inputToSendMs: 200,
    sendToWatchMs: 800,
    pollMs: 300,
    responseTimeoutMs: 60000,
    finishGraceMs: 800,
    safetyTimeoutMs: 300000,
    spaReadyPollMs: 300,
    spaReadyTimeoutMs: 30000,
  };

  // ======================================================
  // 内部状態
  // ======================================================
  let currentRequestId = null;
  let isStreaming = false;
  let assistantCountBeforeSend = 0;
  let lastAssistantViewerBeforeSend = null;

  let loadingObserver = null;
  let pollTimer = null;
  let safetyTimer = null;

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
  // SPA 準備完了チェック
  // ======================================================
  function waitForSpaReady() {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const el = document.querySelector(GS.input);
      if (el) { resolve(el); return; }
      const timer = setInterval(() => {
        const el = document.querySelector(GS.input);
        if (el) { clearInterval(timer); resolve(el); return; }
        if (Date.now() - start > TIMING.spaReadyTimeoutMs) {
          clearInterval(timer);
          reject(new Error(`SPA not ready: ${GS.input} not found`));
        }
      }, TIMING.spaReadyPollMs);
    });
  }

  function isSpaReady() {
    return document.querySelector(GS.input) !== null;
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

  function getNewAssistantViewer() {
    const stmts = getAllAssistantStatements();
    if (stmts.length <= assistantCountBeforeSend) return null;
    const newStmt = stmts[stmts.length - 1];
    const viewer = newStmt.querySelector(SEL.assistantTextContent);
    if (viewer && viewer === lastAssistantViewerBeforeSend) return null;
    return viewer;
  }

  function isPageLoading() {
    return document.querySelector(GS.loadingIndicator) !== null;
  }

  // ======================================================
  // テキスト入力 & 送信
  // ======================================================
  function injectTextAndSend(textarea, text) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype, "value"
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
    setTimeout(() => clickSend(textarea), TIMING.inputToSendMs);
    return true;
  }

  function clickSend(textarea) {
    const sendEl = document.querySelector(GS.sendButton);
    if (sendEl) { sendEl.click(); return; }
    textarea.focus();
    const opts = {
      key: "Enter", code: "Enter", keyCode: 13, which: 13,
      bubbles: true, cancelable: true,
    };
    textarea.dispatchEvent(new KeyboardEvent("keydown", opts));
    textarea.dispatchEvent(new KeyboardEvent("keypress", opts));
    textarea.dispatchEvent(new KeyboardEvent("keyup", opts));
  }

  // ======================================================
  // ストリーミング監視
  //
  // Phase 1: 新しいアシスタント発言の出現を待つ
  // Phase 2: .is_asking の消滅を待つ
  // Phase 3: 完了 → 最終テキストを一括送信
  // ======================================================
  function startStreamWatcher(requestId) {
    cleanup();
    currentRequestId = requestId;
    isStreaming = true;

    console.log(LOG, "Starting stream watcher:", requestId,
      "assistant count before:", assistantCountBeforeSend);

    // Phase 1: 新しいアシスタント発言を待つ
    const pollStart = Date.now();
    pollTimer = setInterval(() => {
      if (Date.now() - pollStart > TIMING.responseTimeoutMs) {
        console.warn(LOG, "Timed out waiting for new assistant statement");
        sendToBg({
          type: "stream_error",
          request_id: currentRequestId,
          error: "Timed out waiting for assistant response",
        });
        cleanup();
        return;
      }

      // 新しい発言が見つかったら Phase 2 へ
      const newViewer = getNewAssistantViewer();
      if (newViewer) {
        clearInterval(pollTimer);
        pollTimer = null;
        console.log(LOG, "New assistant statement detected");
        waitForLoadingEnd(newViewer);
      }
    }, TIMING.pollMs);

    safetyTimer = setTimeout(() => {
      if (isStreaming) {
        console.warn(LOG, "Safety timeout reached");
        sendFinalText();
      }
    }, TIMING.safetyTimeoutMs);
  }

  // Phase 2: .is_asking の消滅を待つ
  function waitForLoadingEnd(viewer) {
    if (!isPageLoading()) {
      // 既に .is_asking が無い（超高速レスポンス）
      console.log(LOG, ".is_asking already gone");
      setTimeout(() => {
        if (isStreaming) sendFinalText();
      }, TIMING.finishGraceMs);
      return;
    }

    console.log(LOG, "Waiting for .is_asking to disappear...");

    loadingObserver = new MutationObserver(() => {
      if (!isPageLoading()) {
        console.log(LOG, ".is_asking disappeared — stream complete");
        loadingObserver.disconnect();
        loadingObserver = null;

        // 少し待ってからテキスト取得（DOM 最終レンダリング待ち）
        setTimeout(() => {
          if (isStreaming) sendFinalText();
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

  // Phase 3: 最終テキストを取得して一括送信
  function sendFinalText() {
    if (!isStreaming) return;
    isStreaming = false;

    const viewer = getNewAssistantViewer() || getLatestAssistantViewer();
    const finalText = viewer ? (viewer.textContent || "") : "";

    console.log(
      LOG, "Sending final text:", currentRequestId,
      "length:", finalText.length,
      "preview:", finalText.substring(0, 80)
    );

    if (finalText) {
      sendToBg({
        type: "stream_delta",
        request_id: currentRequestId,
        delta: finalText,
        full_text: finalText,
        replacement: false,
      });
    }

    sendToBg({
      type: "stream_end",
      request_id: currentRequestId,
      full_text: finalText,
    });

    cleanup();
  }

  // ======================================================
  // クリーンアップ
  // ======================================================
  function cleanup() {
    isStreaming = false;
    lastAssistantViewerBeforeSend = null;
    if (loadingObserver) { loadingObserver.disconnect(); loadingObserver = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
  }

  // ======================================================
  // background.js からのメッセージ受信
  // ======================================================
  browser.runtime.onMessage.addListener((message, sender) => {
    if (!message || !message.action) return;

    switch (message.action) {
      case "inject_and_send": {
        console.log(
          LOG, "Received inject_and_send:",
          message.text?.substring(0, 80)
        );
        if (isStreaming) {
          sendToBg({
            type: "error",
            request_id: message.requestId,
            error: "This tab is already processing a request.",
          });
          return;
        }
        currentRequestId = message.requestId;

        waitForSpaReady()
          .then((textarea) => {
            const stmts = getAllAssistantStatements();
            assistantCountBeforeSend = stmts.length;
            if (stmts.length > 0) {
              lastAssistantViewerBeforeSend =
                stmts[stmts.length - 1].querySelector(
                  SEL.assistantTextContent
                );
            } else {
              lastAssistantViewerBeforeSend = null;
            }

            console.log(
              LOG, "Before send: assistantCount=",
              assistantCountBeforeSend
            );

            const success = injectTextAndSend(textarea, message.text);
            if (success) {
              sendToBg({
                type: "prompt_sent",
                request_id: message.requestId,
              });
              setTimeout(() => {
                startStreamWatcher(message.requestId);
              }, TIMING.sendToWatchMs);
            }
          })
          .catch((err) => {
            console.error(LOG, "SPA ready timeout:", err.message);
            sendToBg({
              type: "error",
              request_id: message.requestId,
              error: err.message,
            });
          });
        return;
      }
      case "ping":
        return Promise.resolve({
          status: "alive",
          spaReady: isSpaReady(),
        });
    }
  });

  ns.bridge = {
    cleanup,
    get isStreaming() { return isStreaming; },
    get currentRequestId() { return currentRequestId; },
    get spaReady() { return isSpaReady(); },
  };
})();
