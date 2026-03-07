(function () {
  "use strict";

  // ======================================================
  // 定数・設定
  // ======================================================

  const SELECTORS = {
    conversationContent: ".conversation-content",
    statementAll:
      ".conversation-statement.user, .conversation-statement.assistant",
    userTextContent: ".desc .content pre code",
    assistantTextContent: ".desc .content .markdown-viewer",
    mainInner: ".main-inner.j-chat-agent",
    headerRightTop: ".header-right .top",
    projectNameText: ".project-name .text",
  };

  const TOC_CONFIG = {
    maxChars: 50,
    placeholderText: "…",
  };

  const TIMING = {
    phase1PollMs: 2000,
    structureDebounceMs: 1000,
    textPollMs: 3000,
    uiSetupPollMs: 500,
    uiSetupTimeoutMs: 10000,
    tocClickScrollLockMs: 2000,
  };

  const DEFAULT_OPTIONS = {
    chatWidthEnabled: false,
    chatWidthPercent: 90,
    chatWidthUnit: "percent",
    chatWidthPixel: 1200,
    tocEnabled: true,
    tocCollapsed: false,
    searchEnabled: true,
  };

  let currentOptions = { ...DEFAULT_OPTIONS };

  // ======================================================
  // オプション読み込み・監視
  // ======================================================

  async function loadOptions() {
    try {
      const stored = await browser.storage.local.get("options");
      if (stored.options) {
        currentOptions = { ...DEFAULT_OPTIONS, ...stored.options };
      }
    } catch (e) {
      console.warn("[GS Enhancer] Failed to load options:", e);
    }
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.options) {
      currentOptions = { ...DEFAULT_OPTIONS, ...changes.options.newValue };
      applyChatWidth();
      if (tocPanel) {
        tocPanel.style.display = currentOptions.tocEnabled ? "" : "none";
      }
    }
  });

  // ======================================================
  // 1. チャット横幅拡張
  // ======================================================

  const CHAT_WIDTH_CLASS = "gs-enhancer-wide-chat";

  function applyChatWidth() {
    const body = document.body;
    if (!currentOptions.chatWidthEnabled) {
      body.classList.remove(CHAT_WIDTH_CLASS);
      document.documentElement.style.removeProperty("--gs-enhancer-chat-width");
      return;
    }
    body.classList.add(CHAT_WIDTH_CLASS);
    let cssValue;
    if (currentOptions.chatWidthUnit === "pixel") {
      cssValue = `${currentOptions.chatWidthPixel}px`;
    } else {
      cssValue = `${currentOptions.chatWidthPercent}%`;
    }
    document.documentElement.style.setProperty(
      "--gs-enhancer-chat-width",
      cssValue
    );
  }

  // ======================================================
  // 2. チャット目次
  // ======================================================

  let tocPanel = null;
  let tocList = null;
  let tocCollapsed = false;
  let tocScrollLocked = false;

  // --- パネルモード管理 ---
  let panelMode = "toc"; // "toc" | "search"

  // --- 折り畳み状態管理 ---
  // key: 目次エントリの先頭 statement DOM 要素, value: true
  const collapsedEntries = new WeakSet();

  function createTocPanel() {
    tocPanel = document.getElementById("gs-enhancer-toc");
    if (tocPanel !== null) {
      tocPanel.remove();
    }

    tocPanel = document.createElement("div");
    tocPanel.id = "gs-enhancer-toc";
    tocPanel.innerHTML = `
      <div class="gs-toc-header">
        <div class="gs-panel-tabs">
          <button class="gs-panel-tab active" data-mode="toc" title="目次 (Alt+T)">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <rect x="1" y="2" width="3" height="2" rx="0.5"/>
              <rect x="6" y="2" width="9" height="2" rx="0.5"/>
              <rect x="1" y="7" width="3" height="2" rx="0.5"/>
              <rect x="6" y="7" width="9" height="2" rx="0.5"/>
              <rect x="1" y="12" width="3" height="2" rx="0.5"/>
              <rect x="6" y="12" width="9" height="2" rx="0.5"/>
            </svg>
            目次
          </button>
          <button class="gs-panel-tab" data-mode="search" title="検索 (Ctrl+Shift+F)">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <circle cx="6.5" cy="6.5" r="4" stroke="currentColor" stroke-width="1.5" fill="none"/>
              <line x1="9.5" y1="9.5" x2="13" y2="13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            検索
          </button>
        </div>
        <button class="gs-toc-toggle" title="折り畳み (Alt+T)">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M10.5 8L6 11V5l4.5 3z"/>
          </svg>
        </button>
      </div>
      <div class="gs-toc-list-wrapper">
        <ul class="gs-toc-list"></ul>
      </div>
      <div class="gs-search-container">
        <div class="gs-search-input-row">
          <input type="text" class="gs-search-input" placeholder="検索…" spellcheck="false" autocomplete="off">
          <button class="gs-search-opt-btn" data-opt="case" title="大文字小文字を区別 (Aa)">Aa</button>
          <button class="gs-search-opt-btn" data-opt="word" title="単語単位で検索 (W)" style="font-style:italic;">W</button>
          <button class="gs-search-opt-btn" data-opt="regex" title="正規表現 (.*)" style="font-size:10px;">.*</button>
        </div>
        <div class="gs-search-toolbar">
          <label><input type="checkbox" class="gs-search-filter" value="user" checked> 👤</label>
          <label><input type="checkbox" class="gs-search-filter" value="assistant" checked> 🤖</label>
          <span class="gs-search-count"></span>
          <div class="gs-search-nav">
            <button class="gs-search-nav-btn" data-dir="prev" title="前へ (Shift+Enter)" disabled>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 4L3 9h10L8 4z"/></svg>
            </button>
            <button class="gs-search-nav-btn" data-dir="next" title="次へ (Enter)" disabled>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 12l5-5H3l5 5z"/></svg>
            </button>
          </div>
        </div>
        <div class="gs-search-results-wrapper">
          <ul class="gs-search-results"></ul>
        </div>
      </div>
    `;

    tocList = tocPanel.querySelector(".gs-toc-list");

    const toggleBtn = tocPanel.querySelector(".gs-toc-toggle");
    toggleBtn.addEventListener("click", toggleToc);

    // タブ切り替え
    const tabs = tocPanel.querySelectorAll(".gs-panel-tab");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        setPanelMode(tab.dataset.mode);
      });
    });

    setupSearchEvents();

    document.body.appendChild(tocPanel);

    if (currentOptions.tocCollapsed) {
      setTocCollapsed(true);
    }
    if (!currentOptions.tocEnabled) {
      tocPanel.style.display = "none";
    }
  }

  function setPanelMode(mode) {
    panelMode = mode;
    const tocListWrapper = tocPanel.querySelector(".gs-toc-list-wrapper");
    const searchContainer = tocPanel.querySelector(".gs-search-container");

    const tabs = tocPanel.querySelectorAll(".gs-panel-tab");
    tabs.forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.mode === mode);
    });

    if (mode === "search") {
      tocListWrapper.style.display = "none";
      searchContainer.classList.add("visible");
      const input = tocPanel.querySelector(".gs-search-input");
      if (input) {
        setTimeout(() => {
          input.focus();
          input.select();
        }, 50);
      }
    } else {
      tocListWrapper.style.display = "";
      searchContainer.classList.remove("visible");
      clearSearchHighlights();
    }
  }

  function toggleToc() {
    setTocCollapsed(!tocCollapsed);
    browser.storage.local.get("options").then((stored) => {
      const opts = stored.options || {};
      opts.tocCollapsed = tocCollapsed;
      browser.storage.local.set({ options: opts });
    });
  }

  function setTocCollapsed(collapsed) {
    tocCollapsed = collapsed;
    tocPanel.classList.toggle("collapsed", collapsed);
    const arrow = tocPanel.querySelector(".gs-toc-toggle svg");
    if (arrow) {
      arrow.style.transform = collapsed ? "rotate(180deg)" : "";
    }
  }

  function truncateText(text, maxLen) {
    text = text.trim().replace(/\s+/g, " ");
    if (text.length <= maxLen) return text;
    return text.substring(0, maxLen) + "…";
  }

  function extractStatementText(statement) {
    const isUser = statement.classList.contains("user");
    if (isUser) {
      // 1. 従来の pre > code からテキストを取得
      const codeEl = statement.querySelector(SELECTORS.userTextContent);
      if (codeEl) {
        const text = codeEl.textContent.trim();
        if (text) return text;
      }

      // 2. .text-content からテキストを取得（ファイル添付時のテキスト部分）
      const textContentEl = statement.querySelector(".text-content");
      if (textContentEl) {
        const text = textContentEl.textContent.trim();
        if (text) return text;
      }

      // 3. テキストがない場合、添付ファイル名をフォールバックとして使用
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
      const mdViewer = statement.querySelector(
        SELECTORS.assistantTextContent
      );
      if (!mdViewer) return "";
      const firstP = mdViewer.querySelector("p");
      if (firstP) return firstP.textContent.trim();
      return mdViewer.textContent.trim();
    }
  }

  function getSearchTargetElements(statement) {
    const isUser = statement.classList.contains("user");
    if (isUser) {
      const elements = [];

      // ファイル名要素を収集
      const fileNames = statement.querySelectorAll(".file-name");
      fileNames.forEach((el) => elements.push(el));

      // テキスト要素: 従来の pre > code
      const codeEl = statement.querySelector(SELECTORS.userTextContent);
      if (codeEl) {
        elements.push(codeEl);
      } else {
        // ファイル添付時のテキスト部分
        const textContentEl = statement.querySelector(".text-content");
        if (textContentEl) {
          elements.push(textContentEl);
        }
      }

      return elements;
    } else {
      const mdViewer = statement.querySelector(
        SELECTORS.assistantTextContent
      );
      return mdViewer ? [mdViewer] : [];
    }
  }

  function getStatementCharCount(statement) {
    const elements = getSearchTargetElements(statement);
    let count = 0;
    for (const el of elements) {
      count += el.textContent.length;
    }
    return count;
  }

  /**
   * 全 statement を走査し、目次エントリを収集する。
   * 各エントリは先頭の statement と、同一ターンに属する全 statement の配列を持つ。
   *
   * ルール:
   * - user statement は1つで1ターン
   * - assistant statement は連続するものをまとめて1ターン
   *   （ただし目次には最初の assistant のテキストのみ表示）
   */
  function collectTocEntries() {
    const conversationContent = document.querySelector(
      SELECTORS.conversationContent
    );
    if (!conversationContent) return [];

    const statements = Array.from(
      conversationContent.querySelectorAll(SELECTORS.statementAll)
    );
    const result = [];

    let i = 0;
    while (i < statements.length) {
      const statement = statements[i];
      const isUser = statement.classList.contains("user");

      if (isUser) {
        result.push({
          isUser: true,
          element: statement,
          statements: [statement],
        });
        i++;
      } else {
        // assistant: 連続する assistant をまとめる
        const group = [statement];
        let j = i + 1;
        while (j < statements.length && statements[j].classList.contains("assistant")) {
          group.push(statements[j]);
          j++;
        }
        result.push({
          isUser: false,
          element: statement, // 先頭（テキスト抽出・表示用）
          statements: group,  // ターン全体
        });
        i = j;
      }
    }

    return result;
  }

  function buildStructureKey(entries) {
    return entries.map((e) => (e.isUser ? "U" : "A") + e.statements.length).join(",");
  }

  function buildTextKey(entries) {
    return entries.map((e) => extractStatementText(e.element)).join("|");
  }

  let prevStructureKey = "";
  let prevTextKey = "";

  function updateToc(structureOnly) {
    if (!tocList) return;

    const entries = collectTocEntries();
    const structureKey = buildStructureKey(entries);
    const structureChanged = structureKey !== prevStructureKey;

    let textChanged = false;
    let textKey = prevTextKey;

    if (!structureOnly || structureChanged) {
      textKey = buildTextKey(entries);
      textChanged = textKey !== prevTextKey;
    }

    if (!structureChanged && !textChanged) {
      return;
    }

    if (structureChanged) {
      const newList = document.createElement("ul");
      newList.className = "gs-toc-list";

      entries.forEach((entry) => {
        const { isUser, element, statements: stmts } = entry;
        const text = extractStatementText(element);
        const displayText = text || TOC_CONFIG.placeholderText;

        const li = document.createElement("li");
        li.className = `gs-toc-item ${isUser ? "user" : "assistant"}`;
        li._tocStatement = element;
        li._tocStatements = stmts;

        // 折り畳みトグル
        const collapseToggle = document.createElement("button");
        collapseToggle.className = "gs-toc-collapse-toggle expanded";
        collapseToggle.title = "このターンを折り畳む";

        if (collapsedEntries.has(element)) {
          collapseToggle.classList.remove("expanded");
          collapseToggle.title = "このターンを展開する";
        }

        collapseToggle.addEventListener("click", (e) => {
          e.stopPropagation();
          const isExpanded = collapseToggle.classList.contains("expanded");
          if (isExpanded) {
            collapseStatementGroup(stmts, text, isUser, element);
            collapseToggle.classList.remove("expanded");
            collapseToggle.title = "このターンを展開する";
          } else {
            expandStatementGroup(stmts, element);
            collapseToggle.classList.add("expanded");
            collapseToggle.title = "このターンを折り畳む";
          }
        });

        const iconSpan = document.createElement("span");
        iconSpan.className = "gs-toc-icon";
        iconSpan.textContent = isUser ? "👤" : "🤖";

        const textSpan = document.createElement("span");
        textSpan.className = "gs-toc-text";
        textSpan.textContent = truncateText(displayText, TOC_CONFIG.maxChars);

        li.appendChild(collapseToggle);
        li.appendChild(iconSpan);
        li.appendChild(textSpan);

        li.addEventListener("click", () => {
          tocScrollLocked = true;
          element.scrollIntoView({ behavior: "smooth", block: "start" });
          setTimeout(() => {
            tocScrollLocked = false;
          }, TIMING.tocClickScrollLockMs);
        });

        newList.appendChild(li);
      });

      tocList.replaceWith(newList);
      tocList = newList;
      setupTocHighlightObserver();
    } else if (textChanged) {
      const items = tocList.querySelectorAll(".gs-toc-item");
      entries.forEach((entry, i) => {
        if (i >= items.length) return;
        const text = extractStatementText(entry.element);
        const displayText = text || TOC_CONFIG.placeholderText;
        const textSpan = items[i].querySelector(".gs-toc-text");
        if (textSpan) {
          const newText = truncateText(displayText, TOC_CONFIG.maxChars);
          if (textSpan.textContent !== newText) {
            textSpan.textContent = newText;
          }
        }
      });
    }

    prevStructureKey = structureKey;
    prevTextKey = textKey;
  }

  // ======================================================
  // 2c. 会話ターン折り畳み（グループ対応）
  // ======================================================

  /**
   * 複数の statement をまとめて折り畳む。
   * 先頭の statement にプレビューを表示し、全 statement に折り畳みクラスを付与する。
   */
  function collapseStatementGroup(stmts, previewText, isUser, leadElement) {
    collapsedEntries.add(leadElement);

    // 全 statement の合計文字数を算出
    let totalChars = 0;
    stmts.forEach((stmt) => {
      totalChars += getStatementCharCount(stmt);
    });

    // 全 statement に折り畳みクラスを付与
    stmts.forEach((stmt) => {
      stmt.classList.add("gs-collapsed-statement");
    });

    // 先頭の statement にプレビューを表示
    const lead = stmts[0];
    let preview = lead.querySelector(".gs-collapsed-preview");
    if (!preview) {
      preview = document.createElement("div");
      preview.className = "gs-collapsed-preview";

      const icon = document.createElement("span");
      icon.className = "gs-collapsed-preview-icon";
      icon.textContent = "▶";

      const text = document.createElement("span");
      text.className = "gs-collapsed-preview-text";

      const badge = document.createElement("span");
      badge.className = "gs-collapsed-preview-badge";

      preview.appendChild(icon);
      preview.appendChild(text);
      preview.appendChild(badge);

      preview.addEventListener("click", () => {
        expandStatementGroup(stmts, leadElement);
        syncTocToggle(leadElement, true);
      });

      lead.appendChild(preview);
    }

    const textEl = preview.querySelector(".gs-collapsed-preview-text");
    const displayText = previewText
      ? truncateText(previewText, TOC_CONFIG.maxChars)
      : TOC_CONFIG.placeholderText;
    const label = isUser ? "👤 " : "🤖 ";
    textEl.textContent = label + displayText;

    const badgeEl = preview.querySelector(".gs-collapsed-preview-badge");
    if (totalChars > 0) {
      badgeEl.textContent = `${totalChars.toLocaleString()}文字`;
    } else {
      badgeEl.textContent = "";
    }
  }

  /**
   * グループの折り畳みを解除する。
   */
  function expandStatementGroup(stmts, leadElement) {
    collapsedEntries.delete(leadElement);
    stmts.forEach((stmt) => {
      stmt.classList.remove("gs-collapsed-statement");
    });
  }

  function syncTocToggle(leadElement, expanded) {
    if (!tocList) return;
    const items = tocList.querySelectorAll(".gs-toc-item");
    for (const li of items) {
      if (li._tocStatement === leadElement) {
        const toggle = li.querySelector(".gs-toc-collapse-toggle");
        if (toggle) {
          if (expanded) {
            toggle.classList.add("expanded");
            toggle.title = "このターンを折り畳む";
          } else {
            toggle.classList.remove("expanded");
            toggle.title = "このターンを展開する";
          }
        }
        break;
      }
    }
  }

  // IntersectionObserver
  let tocIntersectionObserver = null;

  function setupTocHighlightObserver() {
    if (tocIntersectionObserver) {
      tocIntersectionObserver.disconnect();
    }

    const visibleStatements = new Set();

    tocIntersectionObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            visibleStatements.add(entry.target);
          } else {
            visibleStatements.delete(entry.target);
          }
        });
        applyTocHighlight(visibleStatements);
      },
      { threshold: 0.1 }
    );

    const items = tocList.querySelectorAll(".gs-toc-item");
    items.forEach((li) => {
      // グループ内の全 statement を observe する
      if (li._tocStatements) {
        li._tocStatements.forEach((stmt) => {
          tocIntersectionObserver.observe(stmt);
        });
      } else if (li._tocStatement) {
        tocIntersectionObserver.observe(li._tocStatement);
      }
    });
  }

  function applyTocHighlight(visibleStatements) {
    if (!tocList) return;

    const items = tocList.querySelectorAll(".gs-toc-item");
    let firstActiveLi = null;

    items.forEach((li) => {
      // グループ内のいずれかが見えていればアクティブ
      let isActive = false;
      if (li._tocStatements) {
        isActive = li._tocStatements.some((stmt) => visibleStatements.has(stmt));
      } else {
        isActive = visibleStatements.has(li._tocStatement);
      }
      li.classList.toggle("active", isActive);
      if (isActive && !firstActiveLi) {
        firstActiveLi = li;
      }
    });

    if (firstActiveLi && !tocScrollLocked) {
      scrollTocToItem(firstActiveLi);
    }
  }

  function scrollTocToItem(li) {
    const wrapper = tocPanel.querySelector(".gs-toc-list-wrapper");
    if (!wrapper) return;

    const wrapperRect = wrapper.getBoundingClientRect();
    const liRect = li.getBoundingClientRect();
    const isVisible =
      liRect.top >= wrapperRect.top && liRect.bottom <= wrapperRect.bottom;

    if (!isVisible) {
      const targetScrollTop =
        li.offsetTop - wrapper.clientHeight / 2 + li.clientHeight / 2;
      wrapper.scrollTo({
        top: Math.max(0, targetScrollTop),
        behavior: "smooth",
      });
    }
  }

  // ======================================================
  // 2b. ページ内検索
  // ======================================================

  let searchState = {
    query: "",
    regex: false,
    caseSensitive: false,
    wholeWord: false,
    filterUser: true,
    filterAssistant: true,
    results: [],
    flatMatches: [],
    currentIndex: -1,
  };

  let searchDebounceTimer = null;

  function setupSearchEvents() {
    const input = tocPanel.querySelector(".gs-search-input");
    const optBtns = tocPanel.querySelectorAll(".gs-search-opt-btn");
    const filterChecks = tocPanel.querySelectorAll(".gs-search-filter");
    const navBtns = tocPanel.querySelectorAll(".gs-search-nav-btn");

    input.addEventListener("input", () => {
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        searchState.query = input.value;
        executeSearch();
      }, 200);
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) {
          navigateSearch("prev");
        } else {
          navigateSearch("next");
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPanelMode("toc");
      }
    });

    optBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        const opt = btn.dataset.opt;
        btn.classList.toggle("active");
        if (opt === "regex")
          searchState.regex = btn.classList.contains("active");
        if (opt === "case")
          searchState.caseSensitive = btn.classList.contains("active");
        if (opt === "word")
          searchState.wholeWord = btn.classList.contains("active");
        executeSearch();
      });
    });

    filterChecks.forEach((cb) => {
      cb.addEventListener("change", () => {
        if (cb.value === "user") searchState.filterUser = cb.checked;
        if (cb.value === "assistant") searchState.filterAssistant = cb.checked;
        executeSearch();
      });
    });

    navBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        navigateSearch(btn.dataset.dir);
      });
    });
  }

  function buildSearchRegex(query, opts) {
    if (!query) return null;

    let pattern;
    if (opts.regex) {
      pattern = query;
    } else {
      pattern = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    if (opts.wholeWord) {
      pattern = `\\b${pattern}\\b`;
    }

    const flags = opts.caseSensitive ? "g" : "gi";

    try {
      return new RegExp(pattern, flags);
    } catch {
      return null;
    }
  }

  function executeSearch() {
    clearSearchHighlights();
    searchState.results = [];
    searchState.flatMatches = [];
    searchState.currentIndex = -1;

    const input = tocPanel.querySelector(".gs-search-input");
    const countEl = tocPanel.querySelector(".gs-search-count");
    const resultsList = tocPanel.querySelector(".gs-search-results");
    const navBtns = tocPanel.querySelectorAll(".gs-search-nav-btn");

    input.classList.remove("invalid");
    if (!searchState.query) {
      countEl.textContent = "";
      resultsList.innerHTML = "";
      navBtns.forEach((b) => (b.disabled = true));
      return;
    }

    const re = buildSearchRegex(searchState.query, searchState);
    if (!re) {
      input.classList.add("invalid");
      countEl.textContent = "無効な正規表現";
      resultsList.innerHTML = "";
      navBtns.forEach((b) => (b.disabled = true));
      return;
    }

    const conversationContent = document.querySelector(
      SELECTORS.conversationContent
    );
    if (!conversationContent) return;

    const statements = conversationContent.querySelectorAll(
      SELECTORS.statementAll
    );

    const results = [];

    for (const statement of statements) {
      const isUser = statement.classList.contains("user");
      const isAssistant = !isUser;

      if (isUser && !searchState.filterUser) continue;
      if (isAssistant && !searchState.filterAssistant) continue;

      const targetElements = getSearchTargetElements(statement);
      if (targetElements.length === 0) continue;

      // 各要素についてマッチを探す
      const segments = [];
      for (const targetEl of targetElements) {
        const fullText = targetEl.textContent;
        const matchPositions = [];
        let match;
        re.lastIndex = 0;
        while ((match = re.exec(fullText)) !== null) {
          matchPositions.push({
            index: match.index,
            length: match[0].length,
            text: match[0],
          });
          if (match[0].length === 0) {
            re.lastIndex++;
          }
        }
        if (matchPositions.length > 0) {
          segments.push({ targetEl, matches: matchPositions });
        }
      }

      if (segments.length > 0) {
        results.push({ statement, isUser, segments });
      }
    }

    searchState.results = results;

    for (let rIdx = 0; rIdx < results.length; rIdx++) {
      const r = results[rIdx];
      for (const seg of r.segments) {
        const highlights = highlightMatches(seg.targetEl, seg.matches);
        for (let mIdx = 0; mIdx < highlights.length; mIdx++) {
          searchState.flatMatches.push({
            resultIdx: rIdx,
            element: highlights[mIdx],
            statement: r.statement,
            segTargetEl: seg.targetEl,
            segMatch: seg.matches[mIdx],
          });
        }
      }
    }

    buildSearchResultsList();

    const total = searchState.flatMatches.length;
    countEl.textContent = total > 0 ? `${total}件` : "0件";
    navBtns.forEach((b) => (b.disabled = total === 0));

    if (total > 0) {
      setCurrentSearchIndex(0);
    }
  }

  function highlightMatches(rootEl, matchPositions) {
    if (!matchPositions.length) return [];

    const textNodes = [];
    const walker = document.createTreeWalker(
      rootEl,
      NodeFilter.SHOW_TEXT,
      null
    );
    let node;
    let offset = 0;
    while ((node = walker.nextNode())) {
      textNodes.push({
        node,
        start: offset,
        end: offset + node.textContent.length,
      });
      offset += node.textContent.length;
    }

    const highlights = [];
    const sorted = [...matchPositions].sort((a, b) => b.index - a.index);

    for (const mp of sorted) {
      const mStart = mp.index;
      const mEnd = mp.index + mp.length;

      for (let ti = 0; ti < textNodes.length; ti++) {
        const tn = textNodes[ti];
        if (tn.end <= mStart || tn.start >= mEnd) continue;

        const nodeStart = Math.max(mStart, tn.start) - tn.start;
        const nodeEnd = Math.min(mEnd, tn.end) - tn.start;

        const textNode = tn.node;
        const text = textNode.textContent;

        const before = text.substring(0, nodeStart);
        const matched = text.substring(nodeStart, nodeEnd);
        const after = text.substring(nodeEnd);

        const mark = document.createElement("mark");
        mark.className = "gs-search-highlight";
        mark.textContent = matched;

        const parent = textNode.parentNode;

        if (after) {
          parent.insertBefore(
            document.createTextNode(after),
            textNode.nextSibling
          );
        }
        parent.insertBefore(mark, textNode.nextSibling);
        if (before) {
          textNode.textContent = before;
        } else {
          parent.removeChild(textNode);
        }

        highlights.unshift(mark);
      }
    }

    return highlights;
  }

  function clearSearchHighlights() {
    const marks = document.querySelectorAll("mark.gs-search-highlight");
    marks.forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      const textNode = document.createTextNode(mark.textContent);
      parent.replaceChild(textNode, mark);
      parent.normalize();
    });

    searchState.flatMatches = [];
    searchState.currentIndex = -1;
  }

  function buildSearchResultsList() {
    const resultsList = tocPanel.querySelector(".gs-search-results");
    resultsList.innerHTML = "";

    if (searchState.flatMatches.length === 0 && searchState.query) {
      const emptyDiv = document.createElement("div");
      emptyDiv.className = "gs-search-empty";
      emptyDiv.textContent = "一致する結果がありません";
      resultsList.appendChild(emptyDiv);
      return;
    }

    const CONTEXT_CHARS = 30;

    searchState.flatMatches.forEach((fm, flatIdx) => {
      const li = document.createElement("li");
      li.className = `gs-search-result-item ${searchState.results[fm.resultIdx].isUser ? "user" : "assistant"
        }`;
      li._flatIndex = flatIdx;

      const iconSpan = document.createElement("span");
      iconSpan.className = "gs-search-result-icon";
      iconSpan.textContent = searchState.results[fm.resultIdx].isUser
        ? "👤"
        : "🤖";

      const contextSpan = document.createElement("span");
      contextSpan.className = "gs-search-result-context";

      const fullText = fm.segTargetEl.textContent;
      const mp = fm.segMatch;
      const ctxStart = Math.max(0, mp.index - CONTEXT_CHARS);
      const ctxEnd = Math.min(
        fullText.length,
        mp.index + mp.length + CONTEXT_CHARS
      );

      const prefix = ctxStart > 0 ? "…" : "";
      const suffix = ctxEnd < fullText.length ? "…" : "";

      const beforeText = prefix + fullText.substring(ctxStart, mp.index);
      const matchText = fullText.substring(mp.index, mp.index + mp.length);
      const afterText =
        fullText.substring(mp.index + mp.length, ctxEnd) + suffix;

      contextSpan.appendChild(document.createTextNode(beforeText));
      const mark = document.createElement("mark");
      mark.textContent = matchText;
      contextSpan.appendChild(mark);
      contextSpan.appendChild(document.createTextNode(afterText));

      li.appendChild(iconSpan);
      li.appendChild(contextSpan);

      li.addEventListener("click", () => {
        setCurrentSearchIndex(li._flatIndex);
      });

      resultsList.appendChild(li);
    });
  }

  function setCurrentSearchIndex(index) {
    if (searchState.flatMatches.length === 0) return;

    if (
      searchState.currentIndex >= 0 &&
      searchState.currentIndex < searchState.flatMatches.length
    ) {
      const prev = searchState.flatMatches[searchState.currentIndex];
      if (prev.element) prev.element.classList.remove("current");
    }

    searchState.currentIndex = index;

    const cur = searchState.flatMatches[index];
    if (cur.element) {
      cur.element.classList.add("current");
      cur.element.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    const items = tocPanel.querySelectorAll(".gs-search-result-item");
    items.forEach((item) => {
      item.classList.toggle("current", item._flatIndex === index);
    });

    const currentItem = tocPanel.querySelector(
      ".gs-search-result-item.current"
    );
    if (currentItem) {
      const wrapper = tocPanel.querySelector(".gs-search-results-wrapper");
      if (wrapper) {
        const wrapperRect = wrapper.getBoundingClientRect();
        const itemRect = currentItem.getBoundingClientRect();
        if (
          itemRect.top < wrapperRect.top ||
          itemRect.bottom > wrapperRect.bottom
        ) {
          currentItem.scrollIntoView({ block: "nearest" });
        }
      }
    }

    const resultMarks = tocPanel.querySelectorAll(
      ".gs-search-result-context mark"
    );
    resultMarks.forEach((m, i) => {
      m.classList.toggle("current-mark", i === index);
    });

    const countEl = tocPanel.querySelector(".gs-search-count");
    countEl.textContent = `${index + 1} / ${searchState.flatMatches.length}件`;
  }

  function navigateSearch(dir) {
    const total = searchState.flatMatches.length;
    if (total === 0) return;

    let newIdx;
    if (dir === "next") {
      newIdx = searchState.currentIndex + 1;
      if (newIdx >= total) newIdx = 0;
    } else {
      newIdx = searchState.currentIndex - 1;
      if (newIdx < 0) newIdx = total - 1;
    }

    setCurrentSearchIndex(newIdx);
  }

  // ======================================================
  // 3. チャット全文エクスポート
  // ======================================================

  function createExportButton() {
    const headerRight = document.querySelector(SELECTORS.headerRightTop);
    if (!headerRight || headerRight.querySelector(".gs-export-btn")) return;

    const btn = document.createElement("div");
    btn.className = "icon gs-export-btn";
    btn.title = "チャットをMarkdownでエクスポート";
    btn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
    `;
    btn.style.cursor = "pointer";
    btn.addEventListener("click", exportChat);
    headerRight.insertBefore(btn, headerRight.firstChild);
  }

  function exportChat() {
    const conversationContent = document.querySelector(
      SELECTORS.conversationContent
    );
    if (!conversationContent) return;

    const statements = conversationContent.querySelectorAll(
      SELECTORS.statementAll
    );

    let markdown = "";
    const projectName =
      document.querySelector(SELECTORS.projectNameText)?.textContent || "chat";

    markdown += `# ${projectName}\n\n`;
    markdown += `エクスポート日時: ${new Date().toLocaleString("ja-JP")}\n\n---\n\n`;

    statements.forEach((statement) => {
      const isUser = statement.classList.contains("user");

      if (isUser) {
        markdown += "**👤 ユーザー**\n\n";
        const codeEl = statement.querySelector(SELECTORS.userTextContent);
        const text = codeEl ? codeEl.textContent.trim() : "";
        markdown += text + "\n\n";
      } else {
        markdown += "**🤖 AI**\n\n";
        const mdViewer = statement.querySelector(
          SELECTORS.assistantTextContent
        );
        if (mdViewer) {
          const text = extractMarkdownFromViewer(mdViewer);
          markdown += text + "\n\n";
        }
      }

      markdown += "---\n\n";
    });

    const blob = new Blob([markdown], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${projectName}_${formatDate(new Date())}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function extractMarkdownFromViewer(viewer) {
    let result = "";
    const innerDiv = viewer.querySelector("div");
    const children = innerDiv ? innerDiv.children : viewer.children;

    if (!children || children.length === 0) return viewer.textContent.trim();

    for (const el of children) {
      const tag = el.tagName.toLowerCase();

      if (tag === "p") {
        result += convertInlineMarkdown(el) + "\n\n";
      } else if (/^h[1-6]$/.test(tag)) {
        const originalLevel = parseInt(tag.charAt(1), 10);
        const newLevel = Math.min(originalLevel + 2, 6);
        const prefix = "#".repeat(newLevel);
        result += `${prefix} ${el.textContent.trim()}\n\n`;
      } else if (tag === "ul") {
        for (const li of el.querySelectorAll(":scope > li")) {
          result += `- ${li.textContent.trim()}\n`;
        }
        result += "\n";
      } else if (tag === "ol") {
        let i = 1;
        for (const li of el.querySelectorAll(":scope > li")) {
          result += `${i}. ${li.textContent.trim()}\n`;
          i++;
        }
        result += "\n";
      } else if (tag === "pre") {
        const code = el.querySelector("code");
        const lang = code?.className?.match(/language-(\w+)/)?.[1] || "";
        result += `\`\`\`${lang}\n${code?.textContent || el.textContent}\n\`\`\`\n\n`;
      } else if (tag === "hr") {
        result += "---\n\n";
      } else if (tag === "blockquote") {
        const lines = el.textContent.trim().split("\n");
        result += lines.map((l) => `> ${l}`).join("\n") + "\n\n";
      } else if (tag === "table") {
        result += convertTableToMarkdown(el) + "\n\n";
      } else {
        result += el.textContent.trim() + "\n\n";
      }
    }

    return result.trim();
  }

  function convertInlineMarkdown(el) {
    let result = "";
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        result += node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.toLowerCase();
        if (tag === "code") {
          result += "`" + node.textContent + "`";
        } else if (tag === "strong" || tag === "b") {
          result += "**" + node.textContent + "**";
        } else if (tag === "em" || tag === "i") {
          result += "*" + node.textContent + "*";
        } else if (tag === "a") {
          const href = node.getAttribute("href") || "";
          result += `[${node.textContent}](${href})`;
        } else {
          result += node.textContent;
        }
      }
    }
    return result.trim();
  }

  function convertTableToMarkdown(table) {
    const rows = table.querySelectorAll("tr");
    if (rows.length === 0) return "";

    const lines = [];
    rows.forEach((row, rowIndex) => {
      const cells = row.querySelectorAll("th, td");
      const cellTexts = Array.from(cells).map((c) => c.textContent.trim());
      lines.push("| " + cellTexts.join(" | ") + " |");
      if (rowIndex === 0) {
        lines.push("| " + cellTexts.map(() => "---").join(" | ") + " |");
      }
    });

    return lines.join("\n");
  }

  function formatDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    const h = String(date.getHours()).padStart(2, "0");
    const min = String(date.getMinutes()).padStart(2, "0");
    return `${y}${m}${d}_${h}${min}`;
  }

  // ======================================================
  // フェーズ管理
  // ======================================================

  let phase1Timer = null;
  let structureObserver = null;
  let structureDebounce = null;
  let textPollTimer = null;

  function startPhase1() {
    stopPhase2();
    if (phase1Timer) return;

    phase1Timer = setInterval(() => {
      const el = document.querySelector(SELECTORS.conversationContent);
      if (el) {
        stopPhase1();
        startPhase2(el);
      }
    }, TIMING.phase1PollMs);
  }

  function stopPhase1() {
    if (phase1Timer) {
      clearInterval(phase1Timer);
      phase1Timer = null;
    }
  }

  function startPhase2(conversationContent) {
    updateToc(false);

    structureObserver = new MutationObserver(() => {
      if (structureDebounce) clearTimeout(structureDebounce);
      structureDebounce = setTimeout(() => {
        structureDebounce = null;
        updateToc(true);
      }, TIMING.structureDebounceMs);
    });

    structureObserver.observe(conversationContent, {
      childList: true,
      subtree: false,
    });

    textPollTimer = setInterval(() => {
      updateToc(false);
    }, TIMING.textPollMs);
  }

  function stopPhase2() {
    if (structureObserver) {
      structureObserver.disconnect();
      structureObserver = null;
    }
    if (structureDebounce) {
      clearTimeout(structureDebounce);
      structureDebounce = null;
    }
    if (textPollTimer) {
      clearInterval(textPollTimer);
      textPollTimer = null;
    }
  }

  function startWatching() {
    const el = document.querySelector(SELECTORS.conversationContent);
    if (el) {
      startPhase2(el);
    } else {
      startPhase1();
    }
  }

  function stopWatching() {
    stopPhase1();
    stopPhase2();
  }

  // ======================================================
  // 初回 UI 配置
  // ======================================================

  let uiSetupDone = false;
  let uiSetupTimer = null;

  function trySetupUi() {
    createExportButton();

    if (document.querySelector(SELECTORS.headerRightTop)) {
      uiSetupDone = true;
      if (uiSetupTimer) {
        clearInterval(uiSetupTimer);
        uiSetupTimer = null;
      }
    }
  }

  function startUiSetupPolling() {
    trySetupUi();
    if (!uiSetupDone) {
      uiSetupTimer = setInterval(trySetupUi, TIMING.uiSetupPollMs);
      setTimeout(() => {
        if (uiSetupTimer) {
          clearInterval(uiSetupTimer);
          uiSetupTimer = null;
        }
      }, TIMING.uiSetupTimeoutMs);
    }
  }

  // ======================================================
  // キーボードショートカット
  // ======================================================

  function setupKeyboardShortcuts() {
    document.addEventListener("keydown", (e) => {
      // Alt+T: 目次折り畳み
      if (
        e.altKey &&
        e.key.toLowerCase() === "t" &&
        !e.ctrlKey &&
        !e.shiftKey &&
        !e.metaKey
      ) {
        e.preventDefault();
        if (tocPanel) toggleToc();
        return;
      }

      // Ctrl+Shift+F: 検索パネル開閉
      if (
        currentOptions.searchEnabled &&
        e.ctrlKey &&
        e.shiftKey &&
        !e.altKey &&
        !e.metaKey &&
        e.key.toUpperCase() === "F"
      ) {
        e.preventDefault();
        e.stopPropagation();

        if (!tocPanel) return;

        if (tocCollapsed) {
          setTocCollapsed(false);
        }

        if (panelMode !== "search") {
          setPanelMode("search");
        } else {
          const input = tocPanel.querySelector(".gs-search-input");
          if (input && document.activeElement === input) {
            setPanelMode("toc");
          } else if (input) {
            input.focus();
            input.select();
          }
        }
      }
    });
  }

  // ======================================================
  // SPA対応
  // ======================================================

  function setupSpaNavigationWatch() {
    let lastUrl = location.href;

    function checkUrl() {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        onNavigate();
      }
    }

    window.addEventListener("popstate", checkUrl);

    const origPushState = history.pushState;
    history.pushState = function (...args) {
      origPushState.apply(this, args);
      checkUrl();
    };

    const origReplaceState = history.replaceState;
    history.replaceState = function (...args) {
      origReplaceState.apply(this, args);
      checkUrl();
    };
  }

  function onNavigate() {
    stopWatching();
    stopFileInputObserver();

    prevStructureKey = "";
    prevTextKey = "";
    tocScrollLocked = false;
    knownBroadestAccept = null;

    if (tocIntersectionObserver) {
      tocIntersectionObserver.disconnect();
      tocIntersectionObserver = null;
    }

    if (tocList) {
      tocList.innerHTML = "";
    }

    // 折り畳みプレビューを除去
    document.querySelectorAll(".gs-collapsed-statement").forEach((el) => {
      el.classList.remove("gs-collapsed-statement");
      const preview = el.querySelector(".gs-collapsed-preview");
      if (preview) preview.remove();
    });

    // 検索状態をリセット
    clearSearchHighlights();
    searchState.query = "";
    searchState.results = [];
    searchState.flatMatches = [];
    searchState.currentIndex = -1;
    if (tocPanel) {
      const input = tocPanel.querySelector(".gs-search-input");
      if (input) input.value = "";
      const countEl = tocPanel.querySelector(".gs-search-count");
      if (countEl) countEl.textContent = "";
      const resultsList = tocPanel.querySelector(".gs-search-results");
      if (resultsList) resultsList.innerHTML = "";
    }

    if (panelMode === "search") {
      setPanelMode("toc");
    }

    uiSetupDone = false;
    startUiSetupPolling();

    setTimeout(() => {
      startWatching();
    }, 500);
  }

  // ======================================================
  // 初期化
  // ======================================================

  async function init() {
    await loadOptions();
    applyChatWidth();
    createTocPanel();
    startWatching();
    startUiSetupPolling();
    setupKeyboardShortcuts();
    setupSpaNavigationWatch();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
