// chatWidth.js — チャット横幅拡張機能
(function () {
  "use strict";
  const ns = window.__gsEnhancer;

  const CHAT_WIDTH_CLASS = "gs-enhancer-wide-chat";

  function applyChatWidth() {
    const opts = ns.currentOptions;
    const body = document.body;
    if (!opts.chatWidthEnabled) {
      body.classList.remove(CHAT_WIDTH_CLASS);
      document.documentElement.style.removeProperty("--gs-enhancer-chat-width");
      return;
    }
    body.classList.add(CHAT_WIDTH_CLASS);
    let cssValue;
    if (opts.chatWidthUnit === "pixel") {
      cssValue = `${opts.chatWidthPixel}px`;
    } else {
      cssValue = `${opts.chatWidthPercent}%`;
    }
    document.documentElement.style.setProperty("--gs-enhancer-chat-width", cssValue);
  }

  // オプション変更時に再適用
  ns.onOptionChange(() => applyChatWidth());

  // 外部公開（main.js の初期化から呼べるように）
  ns.applyChatWidth = applyChatWidth;
})();
