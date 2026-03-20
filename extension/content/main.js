// main.js — 初期化・ライフサイクル管理
(function () {
  "use strict";
  const ns = window.__gsEnhancer;
  const SEL = ns.SELECTORS;
  const TIMING = ns.TIMING;

  async function init() {
    console.log("[GS Enhancer] Initializing...");

    // 1. オプション読み込み
    await ns.loadOptions();

    // 2. パフォーマンスCSS注入
    ns.injectPerformanceStyles();

    // 3. チャット横幅を即座に適用
    ns.applyChatWidth();

    // 4. UI要素の出現を待ってからセットアップ
    await waitForElement(SEL.mainInner, TIMING.uiSetupTimeoutMs);

    // 5. TOCパネル生成
    ns.createTocPanel();

    // search.js のイベント設定（パネル生成後に呼ぶ）
    if (ns.search && ns.search.setupEvents) {
      ns.search.setupEvents();
    }

    // 6. エクスポートボタン生成
    ns.createExportButton();

    // 7. ToolCallボタン保護
    ns.setupToolCallButtonProtection();

    // 8. ショートカットキー設定
    ns.setupShortcuts();

    // 9. 会話の変更監視を開始
    startConversationWatcher();

    console.log("[GS Enhancer] Initialization complete.");
  }

  // ======================================================
  // DOM 要素出現待ち
  // ======================================================
  function waitForElement(selector, timeoutMs) {
    return new Promise((resolve) => {
      const el = document.querySelector(selector);
      if (el) { resolve(el); return; }

      const startTime = Date.now();
      const timer = setInterval(() => {
        const el = document.querySelector(selector);
        if (el || Date.now() - startTime > timeoutMs) {
          clearInterval(timer);
          resolve(el || null);
        }
      }, TIMING.uiSetupPollMs);
    });
  }

  // ======================================================
  // 会話変更の監視 (MutationObserver + ポーリング)
  // ======================================================
  function startConversationWatcher() {
    let structureDebounceTimer = null;
    let textPollTimer = null;
    let lastActivityTime = Date.now();

    // Phase 1: conversationContent の出現を待つ（SPAなのでDOMが遅延出現する）
    const phase1Timer = setInterval(() => {
      const conversationContent = document.querySelector(SEL.conversationContent);
      if (!conversationContent) return;

      clearInterval(phase1Timer);

      // 初回TOC更新
      ns.updateToc(false);

      // エクスポートボタン（遅延出現のヘッダーに対して再試行）
      ns.createExportButton();

      // Phase 2: MutationObserver で構造変化を監視
      const structureObserver = new MutationObserver(() => {
        lastActivityTime = Date.now();
        if (structureDebounceTimer) clearTimeout(structureDebounceTimer);
        structureDebounceTimer = setTimeout(() => {
          ns.updateToc(true);
          ns.createExportButton(); // ヘッダー再構築に対応
        }, TIMING.structureDebounceMs);
      });

      structureObserver.observe(conversationContent, {
        childList: true,
        subtree: false,
      });

      // Phase 3: テキスト変化のポーリング（ストリーミング対応）
      function textPoll() {
        ns.updateToc(false);
        const elapsed = Date.now() - lastActivityTime;
        const interval = elapsed > 30000 ? TIMING.textPollIdleMs : TIMING.textPollMs;
        textPollTimer = setTimeout(textPoll, interval);
      }
      textPollTimer = setTimeout(textPoll, TIMING.textPollMs);

    }, TIMING.phase1PollMs);
  }

  // ======================================================
  // 起動
  // ======================================================
  init();
})();
