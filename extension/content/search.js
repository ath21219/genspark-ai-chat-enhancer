// search.js — ページ内検索機能
(function () {
  "use strict";
  const ns = window.__gsEnhancer;
  const SEL = ns.SELECTORS;

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

  // ======================================================
  // イベント設定
  // ======================================================
  function setupSearchEvents() {
    const panel = ns.toc.panel;
    if (!panel) return;

    const input = panel.querySelector(".gs-search-input");
    const optBtns = panel.querySelectorAll(".gs-search-opt-btn");
    const filterChecks = panel.querySelectorAll(".gs-search-filter");
    const navBtns = panel.querySelectorAll(".gs-search-nav-btn");

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
        navigateSearch(e.shiftKey ? "prev" : "next");
      }
      if (e.key === "Escape") {
        e.preventDefault();
        ns.setPanelMode("toc");
      }
    });

    optBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        const opt = btn.dataset.opt;
        btn.classList.toggle("active");
        if (opt === "regex") searchState.regex = btn.classList.contains("active");
        if (opt === "case") searchState.caseSensitive = btn.classList.contains("active");
        if (opt === "word") searchState.wholeWord = btn.classList.contains("active");
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
      btn.addEventListener("click", () => navigateSearch(btn.dataset.dir));
    });
  }

  // ======================================================
  // 検索実行
  // ======================================================
  function buildSearchRegex(query, opts) {
    if (!query) return null;
    let pattern = opts.regex
      ? query
      : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (opts.wholeWord) pattern = `\\b${pattern}\\b`;
    try {
      return new RegExp(pattern, opts.caseSensitive ? "g" : "gi");
    } catch { return null; }
  }

  function executeSearch() {
    clearHighlights();
    searchState.results = [];
    searchState.flatMatches = [];
    searchState.currentIndex = -1;

    const panel = ns.toc.panel;
    const input = panel.querySelector(".gs-search-input");
    const countEl = panel.querySelector(".gs-search-count");
    const resultsList = panel.querySelector(".gs-search-results");
    const navBtns = panel.querySelectorAll(".gs-search-nav-btn");

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

    const conversationContent = document.querySelector(SEL.conversationContent);
    if (!conversationContent) return;

    const statements = conversationContent.querySelectorAll(SEL.statementAll);
    const results = [];

    for (const statement of statements) {
      const isUser = statement.classList.contains("user");
      if (isUser && !searchState.filterUser) continue;
      if (!isUser && !searchState.filterAssistant) continue;

      const targetElements = ns.getSearchTargetElements(statement);
      if (targetElements.length === 0) continue;

      const segments = [];
      for (const targetEl of targetElements) {
        const fullText = targetEl.textContent;
        const matchPositions = [];
        let match;
        re.lastIndex = 0;
        while ((match = re.exec(fullText)) !== null) {
          matchPositions.push({ index: match.index, length: match[0].length, text: match[0] });
          if (match[0].length === 0) re.lastIndex++;
        }
        if (matchPositions.length > 0) segments.push({ targetEl, matches: matchPositions });
      }
      if (segments.length > 0) results.push({ statement, isUser, segments });
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

    buildResultsList();

    const total = searchState.flatMatches.length;
    countEl.textContent = total > 0 ? `${total}件` : "0件";
    navBtns.forEach((b) => (b.disabled = total === 0));
    if (total > 0) setCurrentIndex(0);
  }

  // ======================================================
  // ハイライト
  // ======================================================
  function highlightMatches(rootEl, matchPositions) {
    if (!matchPositions.length) return [];

    const textNodes = [];
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null);
    let node, offset = 0;
    while ((node = walker.nextNode())) {
      textNodes.push({ node, start: offset, end: offset + node.textContent.length });
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

        const mark = document.createElement("mark");
        mark.className = "gs-search-highlight";
        mark.textContent = text.substring(nodeStart, nodeEnd);

        const parent = textNode.parentNode;
        const after = text.substring(nodeEnd);
        if (after) parent.insertBefore(document.createTextNode(after), textNode.nextSibling);
        parent.insertBefore(mark, textNode.nextSibling);
        const before = text.substring(0, nodeStart);
        if (before) textNode.textContent = before;
        else parent.removeChild(textNode);
        highlights.unshift(mark);
      }
    }
    return highlights;
  }

  function clearHighlights() {
    document.querySelectorAll("mark.gs-search-highlight").forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize();
    });
    searchState.flatMatches = [];
    searchState.currentIndex = -1;
  }

  // ======================================================
  // 結果リスト構築
  // ======================================================
  function buildResultsList() {
    const panel = ns.toc.panel;
    const resultsList = panel.querySelector(".gs-search-results");
    resultsList.innerHTML = "";

    if (searchState.flatMatches.length === 0 && searchState.query) {
      const emptyDiv = document.createElement("div");
      emptyDiv.className = "gs-search-empty";
      emptyDiv.textContent = "一致する結果がありません";
      resultsList.appendChild(emptyDiv);
      return;
    }

    const CONTEXT_CHARS = 30;
    const fragment = document.createDocumentFragment();

    searchState.flatMatches.forEach((fm, flatIdx) => {
      const li = document.createElement("li");
      li.className = `gs-search-result-item ${searchState.results[fm.resultIdx].isUser ? "user" : "assistant"}`;
      li._flatIndex = flatIdx;

      const iconSpan = document.createElement("span");
      iconSpan.className = "gs-search-result-icon";
      iconSpan.textContent = searchState.results[fm.resultIdx].isUser ? "👤" : "🤖";

      const contextSpan = document.createElement("span");
      contextSpan.className = "gs-search-result-context";

      const fullText = fm.segTargetEl.textContent;
      const mp = fm.segMatch;
      const ctxStart = Math.max(0, mp.index - CONTEXT_CHARS);
      const ctxEnd = Math.min(fullText.length, mp.index + mp.length + CONTEXT_CHARS);

      contextSpan.appendChild(document.createTextNode(
        (ctxStart > 0 ? "…" : "") + fullText.substring(ctxStart, mp.index)
      ));
      const mark = document.createElement("mark");
      mark.textContent = fullText.substring(mp.index, mp.index + mp.length);
      contextSpan.appendChild(mark);
      contextSpan.appendChild(document.createTextNode(
        fullText.substring(mp.index + mp.length, ctxEnd) + (ctxEnd < fullText.length ? "…" : "")
      ));

      li.appendChild(iconSpan);
      li.appendChild(contextSpan);
      li.addEventListener("click", () => setCurrentIndex(li._flatIndex));
      fragment.appendChild(li);
    });

    resultsList.appendChild(fragment);
  }

  // ======================================================
  // ナビゲーション
  // ======================================================
  function setCurrentIndex(index) {
    const panel = ns.toc.panel;
    if (searchState.flatMatches.length === 0) return;

    if (searchState.currentIndex >= 0 && searchState.currentIndex < searchState.flatMatches.length) {
      const prev = searchState.flatMatches[searchState.currentIndex];
      if (prev.element) prev.element.classList.remove("current");
    }

    searchState.currentIndex = index;
    const cur = searchState.flatMatches[index];
    if (cur.element) {
      cur.element.classList.add("current");
      cur.element.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    panel.querySelectorAll(".gs-search-result-item").forEach((item) => {
      item.classList.toggle("current", item._flatIndex === index);
    });

    const currentItem = panel.querySelector(".gs-search-result-item.current");
    if (currentItem) {
      const wrapper = panel.querySelector(".gs-search-results-wrapper");
      if (wrapper) {
        const wr = wrapper.getBoundingClientRect();
        const ir = currentItem.getBoundingClientRect();
        if (ir.top < wr.top || ir.bottom > wr.bottom) {
          currentItem.scrollIntoView({ block: "nearest" });
        }
      }
    }

    panel.querySelectorAll(".gs-search-result-context mark").forEach((m, i) => {
      m.classList.toggle("current-mark", i === index);
    });

    panel.querySelector(".gs-search-count").textContent =
      `${index + 1} / ${searchState.flatMatches.length}件`;
  }

  function navigateSearch(dir) {
    const total = searchState.flatMatches.length;
    if (total === 0) return;
    let newIdx = searchState.currentIndex + (dir === "next" ? 1 : -1);
    if (newIdx >= total) newIdx = 0;
    if (newIdx < 0) newIdx = total - 1;
    setCurrentIndex(newIdx);
  }

  // ======================================================
  // 外部公開
  // ======================================================
  ns.search = {
    setupEvents: setupSearchEvents,
    clearHighlights: clearHighlights,
    execute: executeSearch,
  };
})();
