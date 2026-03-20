// _shared.js — 全モジュールの共有基盤
(function () {
  "use strict";

  // ======================================================
  // 共有名前空間
  // ======================================================
  const ns = {};
  window.__gsEnhancer = ns;

  // ======================================================
  // 定数
  // ======================================================
  ns.SELECTORS = {
    conversationContent: ".conversation-content",
    statementAll:
      ".conversation-statement.user, .conversation-statement.assistant",
    userTextContent: ".desc .content pre code",
    assistantTextContent: ".desc .content .markdown-viewer",
    mainInner: ".main-inner.j-chat-agent",
    headerRightTop: ".header-right .top",
    projectNameText: ".project-name .text",
    usingToolCall: ".using-tool-call",
    toolCallResultSidebarInner: ".tool-call-result-sidebar-inner",
    viewToolCallResultButton: ".view-tool-call-result-button",
  };

  ns.TOC_CONFIG = {
    maxChars: 50,
    placeholderText: "…",
  };

  ns.TIMING = {
    phase1PollMs: 2000,
    structureDebounceMs: 1000,
    textPollMs: 3000,
    textPollIdleMs: 8000,
    uiSetupPollMs: 500,
    uiSetupTimeoutMs: 10000,
    tocClickScrollLockMs: 2000,
  };

  ns.DEFAULT_OPTIONS = {
    chatWidthEnabled: false,
    chatWidthPercent: 90,
    chatWidthUnit: "percent",
    chatWidthPixel: 1200,
    tocEnabled: true,
    tocCollapsed: false,
    searchEnabled: true,
  };

  // ======================================================
  // オプション管理
  // ======================================================
  ns.currentOptions = { ...ns.DEFAULT_OPTIONS };

  /** オプション変更時のコールバック群 */
  ns._optionChangeListeners = [];

  ns.onOptionChange = function (callback) {
    ns._optionChangeListeners.push(callback);
  };

  ns.loadOptions = async function () {
    try {
      const stored = await browser.storage.local.get("options");
      if (stored.options) {
        ns.currentOptions = { ...ns.DEFAULT_OPTIONS, ...stored.options };
      }
    } catch (e) {
      console.warn("[GS Enhancer] Failed to load options:", e);
    }
  };

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.options) {
      ns.currentOptions = { ...ns.DEFAULT_OPTIONS, ...changes.options.newValue };
      for (const cb of ns._optionChangeListeners) {
        try { cb(ns.currentOptions); } catch (e) { console.error(e); }
      }
    }
  });

  // ======================================================
  // DOM ユーティリティ
  // ======================================================

  /**
   * テキストを指定文字数で切り詰める
   */
  ns.truncateText = function (text, maxLen) {
    text = text.trim().replace(/\s+/g, " ");
    if (text.length <= maxLen) return text;
    return text.substring(0, maxLen) + "…";
  };

  /**
   * 日付を YYYYMMDD_HHmmss 形式にフォーマット
   */
  ns.formatDate = function (date) {
    const y = date.getFullYear();
    const mo = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    const h = String(date.getHours()).padStart(2, "0");
    const mi = String(date.getMinutes()).padStart(2, "0");
    const s = String(date.getSeconds()).padStart(2, "0");
    return `${y}${mo}${d}_${h}${mi}${s}`;
  };

  /**
   * 会話ステートメントからテキストを抽出する。
   * TOC表示・検索・エクスポートなど複数機能で共通利用。
   */
  ns.extractStatementText = function (statement) {
    const isUser = statement.classList.contains("user");
    if (isUser) {
      const codeEl = statement.querySelector(ns.SELECTORS.userTextContent);
      if (codeEl) {
        const text = codeEl.textContent.trim();
        if (text) return text;
      }
      const textContentEl = statement.querySelector(".text-content");
      if (textContentEl) {
        const text = textContentEl.textContent.trim();
        if (text) return text;
      }
      const fileNames = statement.querySelectorAll(".file-name");
      if (fileNames.length > 0) {
        const names = Array.from(fileNames)
          .map((el) => el.textContent.trim())
          .filter(Boolean);
        if (names.length > 0) {
          return "\u{1F4CE} " + names.join(", ");
        }
      }
      return "";
    } else {
      const mdViewer = statement.querySelector(ns.SELECTORS.assistantTextContent);
      if (!mdViewer) return "";
      const firstP = mdViewer.querySelector("p");
      if (firstP) return firstP.textContent.trim();
      return mdViewer.textContent.trim();
    }
  };

  /**
   * 検索対象となるDOM要素群を取得する
   */
  ns.getSearchTargetElements = function (statement) {
    const isUser = statement.classList.contains("user");
    if (isUser) {
      const elements = [];
      const fileNames = statement.querySelectorAll(".file-name");
      fileNames.forEach((el) => elements.push(el));
      const codeEl = statement.querySelector(ns.SELECTORS.userTextContent);
      if (codeEl) {
        elements.push(codeEl);
      } else {
        const textContentEl = statement.querySelector(".text-content");
        if (textContentEl) {
          elements.push(textContentEl);
        }
      }
      return elements;
    } else {
      const elements = [];
      const mdViewer = statement.querySelector(ns.SELECTORS.assistantTextContent);
      if (mdViewer) elements.push(mdViewer);
      const sidebarViewers = statement.querySelectorAll(
        `${ns.SELECTORS.toolCallResultSidebarInner} .markdown-viewer`
      );
      sidebarViewers.forEach((el) => elements.push(el));
      return elements;
    }
  };

  /**
   * ステートメントの文字数を計算する
   */
  ns.getStatementCharCount = function (statement) {
    const elements = ns.getSearchTargetElements(statement);
    let count = 0;
    for (const el of elements) {
      count += el.textContent.length;
    }
    return count;
  };

  /**
   * 会話コンテナからTOCエントリを収集する。
   * user は単独エントリ、assistant は連続するものをグループ化する。
   * 戻り値: Array<{ isUser, element, statements }>
   */
  ns.collectTocEntries = function () {
    const conversationContent = document.querySelector(ns.SELECTORS.conversationContent);
    if (!conversationContent) return [];

    const statements = Array.from(
      conversationContent.querySelectorAll(ns.SELECTORS.statementAll)
    );
    const result = [];
    let i = 0;
    while (i < statements.length) {
      const statement = statements[i];
      const isUser = statement.classList.contains("user");
      if (isUser) {
        result.push({ isUser: true, element: statement, statements: [statement] });
        i++;
      } else {
        const group = [statement];
        let j = i + 1;
        while (j < statements.length && statements[j].classList.contains("assistant")) {
          group.push(statements[j]);
          j++;
        }
        result.push({ isUser: false, element: statement, statements: group });
        i = j;
      }
    }
    return result;
  };
})();
