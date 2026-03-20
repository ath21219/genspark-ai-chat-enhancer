// toc.js — 目次パネル、ターン折り畳み、IntersectionObserver
(function () {
  "use strict";
  const ns = window.__gsEnhancer;
  const SEL = ns.SELECTORS;
  const CFG = ns.TOC_CONFIG;
  const TIMING = ns.TIMING;

  // ======================================================
  // モジュール内部状態
  // ======================================================
  let tocPanel = null;
  let tocList = null;
  let tocCollapsed = false;
  let tocScrollLocked = false;
  let panelMode = "toc"; // "toc" | "search"
  const collapsedEntries = new WeakSet();
  let tocIntersectionObserver = null;
  let prevStructureKey = "";
  let prevTextKey = "";

  // 外部モジュール（search.js）から参照可能にする
  ns.toc = {
    get panel() { return tocPanel; },
    get list() { return tocList; },
    set list(v) { tocList = v; },
    get panelMode() { return panelMode; },
    get collapsedEntries() { return collapsedEntries; },
  };

  // ======================================================
  // パネル生成
  // ======================================================
  function createTocPanel() {
    tocPanel = document.getElementById("gs-enhancer-toc");
    if (tocPanel !== null) tocPanel.remove();

    tocPanel = document.createElement("div");
    tocPanel.id = "gs-enhancer-toc";
    tocPanel.innerHTML = `
      <div class="gs-toc-header">
        <div class="gs-panel-tabs">
          <button class="gs-panel-tab active" data-mode="toc">目次</button>
          <button class="gs-panel-tab" data-mode="search">検索</button>
        </div>
        <button class="gs-toc-toggle" title="折り畳み (Alt+T)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
        </button>
      </div>
      <div class="gs-toc-list-wrapper">
        <ul class="gs-toc-list"></ul>
      </div>
      <div class="gs-search-container">
        <div class="gs-search-input-row">
          <input type="text" class="gs-search-input" placeholder="検索…" />
          <div class="gs-search-options">
            <button class="gs-search-opt-btn" data-opt="regex" title="正規表現">.*</button>
            <button class="gs-search-opt-btn" data-opt="case" title="大小区別">Aa</button>
            <button class="gs-search-opt-btn" data-opt="word" title="単語一致">ab</button>
          </div>
        </div>
        <div class="gs-search-filters">
          <label><input type="checkbox" class="gs-search-filter" value="user" checked /> 👤</label>
          <label><input type="checkbox" class="gs-search-filter" value="assistant" checked /> 🤖</label>
          <span class="gs-search-count"></span>
          <button class="gs-search-nav-btn" data-dir="prev" disabled>▲</button>
          <button class="gs-search-nav-btn" data-dir="next" disabled>▼</button>
        </div>
        <div class="gs-search-results-wrapper">
          <ul class="gs-search-results"></ul>
        </div>
      </div>
    `;

    tocList = tocPanel.querySelector(".gs-toc-list");
    ns.toc.list = tocList; // 外部参照更新

    tocPanel.querySelector(".gs-toc-toggle").addEventListener("click", toggleToc);

    tocPanel.querySelectorAll(".gs-panel-tab").forEach((tab) => {
      tab.addEventListener("click", () => setPanelMode(tab.dataset.mode));
    });

    // search.js が後からイベント設定する
    if (ns.search && ns.search.setupEvents) {
      ns.search.setupEvents();
    }

    document.body.appendChild(tocPanel);

    if (ns.currentOptions.tocCollapsed) setTocCollapsed(true);
    if (!ns.currentOptions.tocEnabled) tocPanel.style.display = "none";
  }

  // ======================================================
  // パネルモード切り替え
  // ======================================================
  function setPanelMode(mode) {
    panelMode = mode;
    const tocListWrapper = tocPanel.querySelector(".gs-toc-list-wrapper");
    const searchContainer = tocPanel.querySelector(".gs-search-container");

    tocPanel.querySelectorAll(".gs-panel-tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.mode === mode);
    });

    if (mode === "search") {
      tocListWrapper.style.display = "none";
      searchContainer.classList.add("visible");
      const input = tocPanel.querySelector(".gs-search-input");
      if (input) setTimeout(() => { input.focus(); input.select(); }, 50);
    } else {
      tocListWrapper.style.display = "";
      searchContainer.classList.remove("visible");
      if (ns.search && ns.search.clearHighlights) {
        ns.search.clearHighlights();
      }
    }
  }

  // ======================================================
  // 折り畳み (パネル自体の折り畳み)
  // ======================================================
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
    if (arrow) arrow.style.transform = collapsed ? "rotate(180deg)" : "";
  }

  // ======================================================
  // TOC 更新
  // ======================================================
  function buildStructureKey(entries) {
    return entries.map((e) => (e.isUser ? "U" : "A") + e.statements.length).join(",");
  }

  function buildTextKey(entries) {
    return entries.map((e) => ns.extractStatementText(e.element)).join("|");
  }

  function updateToc(structureOnly) {
    if (!tocList) return;

    const entries = ns.collectTocEntries();
    const structureKey = buildStructureKey(entries);
    const structureChanged = structureKey !== prevStructureKey;

    let textChanged = false;
    let textKey = prevTextKey;
    if (!structureOnly || structureChanged) {
      textKey = buildTextKey(entries);
      textChanged = textKey !== prevTextKey;
    }
    if (!structureChanged && !textChanged) return;

    if (structureChanged) {
      const newList = document.createElement("ul");
      newList.className = "gs-toc-list";
      const fragment = document.createDocumentFragment();

      entries.forEach((entry) => {
        const { isUser, element, statements: stmts } = entry;
        const text = ns.extractStatementText(element);
        const displayText = text || CFG.placeholderText;

        const li = document.createElement("li");
        li.className = `gs-toc-item ${isUser ? "user" : "assistant"}`;
        li._tocStatement = element;
        li._tocStatements = stmts;

        // 折り畳みトグルボタン
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
        textSpan.textContent = ns.truncateText(displayText, CFG.maxChars);

        li.appendChild(collapseToggle);
        li.appendChild(iconSpan);
        li.appendChild(textSpan);

        li.addEventListener("click", () => {
          tocScrollLocked = true;
          element.scrollIntoView({ behavior: "smooth", block: "start" });
          setTimeout(() => { tocScrollLocked = false; }, TIMING.tocClickScrollLockMs);
        });

        fragment.appendChild(li);
      });

      newList.appendChild(fragment);
      tocList.replaceWith(newList);
      tocList = newList;
      ns.toc.list = tocList;
      setupTocHighlightObserver();
    } else if (textChanged) {
      const items = tocList.querySelectorAll(".gs-toc-item");
      entries.forEach((entry, i) => {
        if (i >= items.length) return;
        const text = ns.extractStatementText(entry.element);
        const displayText = text || CFG.placeholderText;
        const textSpan = items[i].querySelector(".gs-toc-text");
        if (textSpan) {
          const newText = ns.truncateText(displayText, CFG.maxChars);
          if (textSpan.textContent !== newText) textSpan.textContent = newText;
        }
      });
    }

    prevStructureKey = structureKey;
    prevTextKey = textKey;
  }

  // ======================================================
  // ターン折り畳み
  // ======================================================
  function collapseStatementGroup(stmts, previewText, isUser, leadElement) {
    collapsedEntries.add(leadElement);

    let totalChars = 0;
    stmts.forEach((stmt) => { totalChars += ns.getStatementCharCount(stmt); });
    stmts.forEach((stmt) => { stmt.classList.add("gs-collapsed-statement"); });

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

      preview.addEventListener("click", (e) => {
        if (e.target.closest(SEL.viewToolCallResultButton)) return;
        expandStatementGroup(stmts, leadElement);
        syncTocToggle(leadElement, true);
      });

      lead.appendChild(preview);
    }

    const textEl = preview.querySelector(".gs-collapsed-preview-text");
    const displayText = previewText
      ? ns.truncateText(previewText, CFG.maxChars)
      : CFG.placeholderText;
    textEl.textContent = (isUser ? "👤 " : "🤖 ") + displayText;

    const badgeEl = preview.querySelector(".gs-collapsed-preview-badge");
    badgeEl.textContent = totalChars > 0 ? `${totalChars.toLocaleString()}文字` : "";
  }

  function expandStatementGroup(stmts, leadElement) {
    collapsedEntries.delete(leadElement);
    stmts.forEach((stmt) => { stmt.classList.remove("gs-collapsed-statement"); });
  }

  function syncTocToggle(leadElement, expanded) {
    if (!tocList) return;
    for (const li of tocList.querySelectorAll(".gs-toc-item")) {
      if (li._tocStatement === leadElement) {
        const toggle = li.querySelector(".gs-toc-collapse-toggle");
        if (toggle) {
          toggle.classList.toggle("expanded", expanded);
          toggle.title = expanded ? "このターンを折り畳む" : "このターンを展開する";
        }
        break;
      }
    }
  }

  // ======================================================
  // ToolCallボタン保護
  // ======================================================
  function setupToolCallButtonProtection() {
    document.addEventListener("click", (e) => {
      const btn = e.target.closest(SEL.viewToolCallResultButton);
      if (!btn) return;

      const statement = btn.closest(".conversation-statement");
      if (statement && statement.classList.contains("gs-collapsed-statement")) {
        statement.classList.remove("gs-collapsed-statement");
        const leadElement = findLeadElement(statement);
        if (leadElement) {
          expandStatementGroup(findStatementsForLead(leadElement), leadElement);
          syncTocToggle(leadElement, true);
        }
      }
    }, true);
  }

  function findLeadElement(statement) {
    if (!tocList) return null;
    for (const li of tocList.querySelectorAll(".gs-toc-item")) {
      if (li._tocStatements && li._tocStatements.includes(statement)) {
        return li._tocStatement;
      }
    }
    return null;
  }

  function findStatementsForLead(leadElement) {
    if (!tocList) return [leadElement];
    for (const li of tocList.querySelectorAll(".gs-toc-item")) {
      if (li._tocStatement === leadElement && li._tocStatements) {
        return li._tocStatements;
      }
    }
    return [leadElement];
  }

  // ======================================================
  // IntersectionObserver (スクロール追従ハイライト)
  // ======================================================
  function setupTocHighlightObserver() {
    if (tocIntersectionObserver) tocIntersectionObserver.disconnect();

    const visibleStatements = new Set();
    tocIntersectionObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) visibleStatements.add(entry.target);
          else visibleStatements.delete(entry.target);
        });
        applyTocHighlight(visibleStatements);
      },
      { threshold: 0.1 }
    );

    tocList.querySelectorAll(".gs-toc-item").forEach((li) => {
      if (li._tocStatements) {
        li._tocStatements.forEach((stmt) => tocIntersectionObserver.observe(stmt));
      } else if (li._tocStatement) {
        tocIntersectionObserver.observe(li._tocStatement);
      }
    });
  }

  function applyTocHighlight(visibleStatements) {
    if (!tocList) return;
    let firstActiveLi = null;
    tocList.querySelectorAll(".gs-toc-item").forEach((li) => {
      let isActive = li._tocStatements
        ? li._tocStatements.some((stmt) => visibleStatements.has(stmt))
        : visibleStatements.has(li._tocStatement);
      li.classList.toggle("active", isActive);
      if (isActive && !firstActiveLi) firstActiveLi = li;
    });
    if (firstActiveLi && !tocScrollLocked) scrollTocToItem(firstActiveLi);
  }

  function scrollTocToItem(li) {
    const wrapper = tocPanel.querySelector(".gs-toc-list-wrapper");
    if (!wrapper) return;
    const wrapperRect = wrapper.getBoundingClientRect();
    const liRect = li.getBoundingClientRect();
    if (liRect.top < wrapperRect.top || liRect.bottom > wrapperRect.bottom) {
      wrapper.scrollTo({
        top: Math.max(0, li.offsetTop - wrapper.clientHeight / 2 + li.clientHeight / 2),
        behavior: "smooth",
      });
    }
  }

  // ======================================================
  // オプション変更対応
  // ======================================================
  ns.onOptionChange((opts) => {
    if (tocPanel) {
      tocPanel.style.display = opts.tocEnabled ? "" : "none";
    }
  });

  // ======================================================
  // 外部公開
  // ======================================================
  ns.createTocPanel = createTocPanel;
  ns.updateToc = updateToc;
  ns.setPanelMode = setPanelMode;
  ns.setupToolCallButtonProtection = setupToolCallButtonProtection;
  ns.expandStatementGroup = expandStatementGroup;
  ns.syncTocToggle = syncTocToggle;
})();
