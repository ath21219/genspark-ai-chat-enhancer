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

  function createTocPanel() {
    tocPanel = document.createElement("div");
    tocPanel.id = "gs-enhancer-toc";
    tocPanel.innerHTML = `
      <div class="gs-toc-header">
        <button class="gs-toc-toggle" title="目次の折り畳み (Alt+T)">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M10 12L6 8L10 4" stroke="currentColor" stroke-width="1.5"
                  stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
      <div class="gs-toc-list-wrapper">
        <ul class="gs-toc-list"></ul>
      </div>
    `;

    tocList = tocPanel.querySelector(".gs-toc-list");

    const toggleBtn = tocPanel.querySelector(".gs-toc-toggle");
    toggleBtn.addEventListener("click", toggleToc);

    document.body.appendChild(tocPanel);

    if (currentOptions.tocCollapsed) {
      setTocCollapsed(true);
    }
    if (!currentOptions.tocEnabled) {
      tocPanel.style.display = "none";
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
      const codeEl = statement.querySelector(SELECTORS.userTextContent);
      return codeEl ? codeEl.textContent.trim() : "";
    } else {
      const mdViewer = statement.querySelector(SELECTORS.assistantTextContent);
      if (!mdViewer) return "";
      const firstP = mdViewer.querySelector("p");
      if (firstP) return firstP.textContent.trim();
      return mdViewer.textContent.trim();
    }
  }

  function collectTocEntries() {
    const conversationContent = document.querySelector(
      SELECTORS.conversationContent
    );
    if (!conversationContent) return [];

    const statements = conversationContent.querySelectorAll(
      SELECTORS.statementAll
    );

    const result = [];
    let prevWasAssistant = false;

    for (const statement of statements) {
      const isUser = statement.classList.contains("user");
      const isAssistant = !isUser;

      if (isAssistant && prevWasAssistant) {
        continue;
      }

      prevWasAssistant = isAssistant;
      result.push({ isUser, element: statement });
    }

    return result;
  }

  function buildStructureKey(entries) {
    return entries.map((e) => (e.isUser ? "U" : "A")).join("");
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
        const { isUser, element } = entry;
        const text = extractStatementText(element);
        const displayText = text || TOC_CONFIG.placeholderText;

        const li = document.createElement("li");
        li.className = `gs-toc-item ${isUser ? "user" : "assistant"}`;
        li._tocStatement = element;

        const iconSpan = document.createElement("span");
        iconSpan.className = "gs-toc-icon";
        iconSpan.textContent = isUser ? "👤" : "🤖";

        const textSpan = document.createElement("span");
        textSpan.className = "gs-toc-text";
        textSpan.textContent = truncateText(displayText, TOC_CONFIG.maxChars);

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
      if (li._tocStatement) {
        tocIntersectionObserver.observe(li._tocStatement);
      }
    });
  }

  function applyTocHighlight(visibleStatements) {
    if (!tocList) return;

    const items = tocList.querySelectorAll(".gs-toc-item");
    let firstActiveLi = null;

    items.forEach((li) => {
      const isActive = visibleStatements.has(li._tocStatement);
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
  // 3. 添付ファイル種類バグ修正
  // ======================================================

  // --- Main World インジェクション ---
  // Content Script は isolated world で実行されるため、
  // ページの JavaScript が document.createElement で生成する
  // input[type="file"] のプロトタイプを書き換えても効果がない。
  // main world にスクリプトを注入して対処する。

  let mainWorldScriptInjected = false;

  /**
   * main world で実行されるスクリプトを注入する。
   * これにより、ページ側の JavaScript が createElement('input') で
   * 生成する file input の accept 属性を書き換えられる。
   */
  function injectMainWorldFileInputHook() {
    if (mainWorldScriptInjected) return;
    mainWorldScriptInjected = true;

    const scriptContent = `
(function() {
  'use strict';

  // ページ側で観測された最も広い accept 値を記録
  let __gs_broadest_accept = null;

  function countTypes(accept) {
    if (!accept || accept.trim() === '') return Infinity;
    return accept.split(',').filter(function(s) { return s.trim() !== ''; }).length;
  }

  // --- 方法1: HTMLInputElement.prototype.click のフック ---
  const origClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function() {
    if (this.type === 'file' && __gs_broadest_accept !== null) {
      var cur = this.getAttribute('accept') || '';
      var curCount = countTypes(cur);
      var broadCount = countTypes(__gs_broadest_accept);
      if (broadCount > curCount) {
        this.setAttribute('accept', __gs_broadest_accept);
      }
    }
    return origClick.apply(this, arguments);
  };

  // --- 方法2: accept プロパティの setter フック ---
  // createElement 直後に .accept = '...' で設定されるケースに対応
  var inputProto = HTMLInputElement.prototype;
  var acceptDesc = Object.getOwnPropertyDescriptor(inputProto, 'accept');
  if (acceptDesc && acceptDesc.set) {
    var origSet = acceptDesc.set;
    var origGet = acceptDesc.get;
    Object.defineProperty(inputProto, 'accept', {
      get: function() {
        return origGet ? origGet.call(this) : this.getAttribute('accept');
      },
      set: function(val) {
        // まず本来のセッターを呼ぶ
        if (origSet) origSet.call(this, val);

        // type=file の場合のみ処理
        if (this.type === 'file') {
          var newCount = countTypes(val);
          if (__gs_broadest_accept === null) {
            __gs_broadest_accept = val;
          } else {
            var broadCount = countTypes(__gs_broadest_accept);
            if (newCount > broadCount) {
              __gs_broadest_accept = val;
            } else if (broadCount > newCount && __gs_broadest_accept !== val) {
              // より広い accept に書き換え
              if (origSet) origSet.call(this, __gs_broadest_accept);
            }
          }
        }
      },
      enumerable: acceptDesc.enumerable,
      configurable: true
    });
  }

  // --- 方法3: setAttribute のフック ---
  var origSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    origSetAttribute.call(this, name, value);
    if (
      name === 'accept' &&
      this.tagName === 'INPUT' &&
      this.type === 'file'
    ) {
      var curCount = countTypes(value);
      if (__gs_broadest_accept === null) {
        __gs_broadest_accept = value;
      } else {
        var broadCount = countTypes(__gs_broadest_accept);
        if (curCount > broadCount) {
          __gs_broadest_accept = value;
        } else if (broadCount > curCount) {
          origSetAttribute.call(this, 'accept', __gs_broadest_accept);
        }
      }
    }
  };

  // --- Content Script との通信用 ---
  // Content Script から broadest accept を設定できるようにする
  window.addEventListener('__gs_enhancer_set_broadest_accept', function(e) {
    if (e.detail && typeof e.detail === 'string') {
      __gs_broadest_accept = e.detail;
    }
  });

  // Content Script に準備完了を通知
  window.dispatchEvent(new CustomEvent('__gs_enhancer_main_world_ready'));
})();
`;

    const script = document.createElement('script');
    script.textContent = scriptContent;
    (document.head || document.documentElement).appendChild(script);
    script.remove(); // DOM からは除去するが、実行済みなので効果は残る
  }

  /**
   * ページ上の全 file input を走査して broadest accept を学習する。
   * (Content Script world から DOM を直接読む)
   */
  let knownBroadestAccept = null;
  let fileInputObserver = null;

  function countAcceptTypes(accept) {
    if (!accept || accept.trim() === "") return Infinity;
    return accept.split(",").filter((s) => s.trim() !== "").length;
  }

  function learnAcceptFromDOM() {
    const fileInputs = document.querySelectorAll('input[type="file"]');
    fileInputs.forEach((input) => {
      const accept = input.getAttribute("accept") || "";
      if (knownBroadestAccept === null) {
        knownBroadestAccept = accept;
      } else {
        const curCount = countAcceptTypes(accept);
        const broadCount = countAcceptTypes(knownBroadestAccept);
        if (curCount > broadCount) {
          knownBroadestAccept = accept;
        }
      }
    });
    // main world にも反映
    if (knownBroadestAccept !== null) {
      window.dispatchEvent(
        new CustomEvent("__gs_enhancer_set_broadest_accept", {
          detail: knownBroadestAccept,
        })
      );
    }
  }

  function startFileInputObserver() {
    if (fileInputObserver) return;

    fileInputObserver = new MutationObserver((mutations) => {
      let found = false;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.tagName === "INPUT" && node.type === "file") {
            found = true;
            break;
          }
          if (node.querySelector?.('input[type="file"]')) {
            found = true;
            break;
          }
        }
        if (found) break;
      }
      if (found) {
        learnAcceptFromDOM();
      }
    });

    fileInputObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });

    learnAcceptFromDOM();
  }

  function stopFileInputObserver() {
    if (fileInputObserver) {
      fileInputObserver.disconnect();
      fileInputObserver = null;
    }
  }

  // --------------------------------------------------
  // クリック時インターセプト（フォールバック）
  // --------------------------------------------------
  // file input が click() で開かれる直前に accept を修正する。
  // これは MutationObserver で捕捉しきれないケース
  // （既存 input の accept が変更されずに再利用される場合）への対策。
  let clickInterceptInstalled = false;

  function installClickIntercept() {
    if (clickInterceptInstalled) return;
    clickInterceptInstalled = true;

    document.addEventListener(
      "click",
      (e) => {
        // クリックされた要素、またはその祖先にある
        // アップロードボタン的な要素の近くに file input があるかチェック
        const target = e.target.closest?.(
          '[title*="Upload"], [title*="upload"], .add-entry-btn, .message-editor [title]'
        );
        if (!target) return;

        // 少し遅延を入れて、動的に生成される file input を捕捉
        requestAnimationFrame(() => {
          fixAllFileInputs();
          // さらに少し後にもう一度（非同期生成への対策）
          setTimeout(fixAllFileInputs, 100);
          setTimeout(fixAllFileInputs, 300);
        });
      },
      true // capture phase
    );
  }

  // ======================================================
  // 4. チャット全文エクスポート
  // ======================================================

  function createExportButton() {
    const headerRight = document.querySelector(SELECTORS.headerRightTop);
    if (!headerRight || headerRight.querySelector(".gs-export-btn")) return;

    const btn = document.createElement("div");
    btn.className = "icon gs-export-btn";
    btn.title = "チャットをMarkdownでエクスポート";
    btn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none"
           xmlns="http://www.w3.org/2000/svg">
        <path d="M10 3v10M10 13l-3.5-3.5M10 13l3.5-3.5M4 17h12"
              stroke="currentColor" stroke-width="1.25"
              stroke-linecap="round" stroke-linejoin="round"/>
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

    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${projectName}_${formatDate(new Date())}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /**
   * AI回答のHTML→Markdown変換。
   * 見出しレベルを+2して、エクスポートの構造見出し(h1)との衝突を防ぐ。
   */
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
        // 見出しレベルを+2（h1→h3, h2→h4, ..., h5→h6超はh6で止める）
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
        result +=
          `\`\`\`${lang}\n${code?.textContent || el.textContent}\n\`\`\`\n\n`;
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

  /**
   * p要素内のインライン要素を簡易的にMarkdownに変換。
   * code, strong, em, a に対応。
   */
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

  /**
   * table要素をMarkdownテーブルに変換。
   */
  function convertTableToMarkdown(table) {
    const rows = table.querySelectorAll("tr");
    if (rows.length === 0) return "";

    const lines = [];
    rows.forEach((row, rowIndex) => {
      const cells = row.querySelectorAll("th, td");
      const cellTexts = Array.from(cells).map((c) => c.textContent.trim());
      lines.push("| " + cellTexts.join(" | ") + " |");

      // ヘッダ行の後にセパレータを挿入
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
      if (
        e.altKey &&
        e.key.toLowerCase() === "t" &&
        !e.ctrlKey &&
        !e.shiftKey &&
        !e.metaKey
      ) {
        e.preventDefault();
        if (tocPanel) toggleToc();
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
    uiSetupDone = false;
    startUiSetupPolling();
    setTimeout(() => {
      startWatching();
      startFileInputObserver();
      // main world のフックはプロトタイプ変更なので再注入不要
      // ただし broadest accept はリセットされているので再学習
      learnAcceptFromDOM();
    }, 500);
  }

  // ======================================================
  // 初期化
  // ======================================================

  async function init() {
    await loadOptions();
    applyChatWidth();
    createTocPanel();
    injectMainWorldFileInputHook();
    startWatching();
    startUiSetupPolling();
    startFileInputObserver();
    setupKeyboardShortcuts();
    setupSpaNavigationWatch();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
