// export.js — チャット全文エクスポート
(function () {
  "use strict";
  const ns = window.__gsEnhancer;
  const SEL = ns.SELECTORS;

  // ======================================================
  // エクスポートボタン生成
  // ======================================================
  function createExportButton() {
    const headerRight = document.querySelector(SEL.headerRightTop);
    if (!headerRight || headerRight.querySelector(".gs-export-btn")) return;

    const btn = document.createElement("div");
    btn.className = "icon gs-export-btn";
    btn.title = "チャットをMarkdownでエクスポート";
    btn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
    `;
    btn.style.cursor = "pointer";
    btn.addEventListener("click", exportChat);
    headerRight.insertBefore(btn, headerRight.firstChild);
  }

  // ======================================================
  // エクスポート実行
  // ======================================================
  function exportChat() {
    const conversationContent = document.querySelector(SEL.conversationContent);
    if (!conversationContent) return;

    const statements = conversationContent.querySelectorAll(SEL.statementAll);
    const projectName =
      document.querySelector(SEL.projectNameText)?.textContent || "chat";

    let markdown = `# ${projectName}\n\n`;
    markdown += `エクスポート日時: ${new Date().toLocaleString("ja-JP")}\n\n---\n\n`;

    statements.forEach((statement) => {
      const isUser = statement.classList.contains("user");

      if (isUser) {
        markdown += "**👤 ユーザー**\n\n";
        const codeEl = statement.querySelector(SEL.userTextContent);
        if (codeEl) {
          markdown += codeEl.textContent.trim() + "\n\n";
        } else {
          const textContentEl = statement.querySelector(".text-content");
          if (textContentEl) markdown += textContentEl.textContent.trim() + "\n\n";
          const fileNames = statement.querySelectorAll(".file-name");
          if (fileNames.length > 0) {
            const names = Array.from(fileNames).map((el) => el.textContent.trim()).filter(Boolean);
            if (names.length > 0) markdown += `📎 添付ファイル: ${names.join(", ")}\n\n`;
          }
        }
      } else {
        markdown += "**🤖 AI**\n\n";
        const mdViewer = statement.querySelector(SEL.assistantTextContent);
        if (mdViewer) markdown += extractMarkdownFromViewer(mdViewer) + "\n\n";

        const toolCalls = statement.querySelectorAll(SEL.usingToolCall);
        if (toolCalls.length > 0) {
          toolCalls.forEach((toolCall) => {
            const md = extractToolCallMarkdown(toolCall);
            if (md) markdown += md + "\n\n";
          });
        }
      }
      markdown += "---\n\n";
    });

    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${projectName}_${ns.formatDate(new Date())}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ======================================================
  // ToolCall Markdown 抽出
  // ======================================================
  function extractToolCallMarkdown(toolCallEl) {
    const nameEl = toolCallEl.querySelector(".name");
    const toolName = nameEl ? nameEl.textContent.trim() : "ツール";
    const argsEl = toolCallEl.querySelector(".arguments");
    let argsText = "";
    if (argsEl) {
      const link = argsEl.querySelector("a");
      argsText = link
        ? (link.getAttribute("href") || link.textContent.trim())
        : argsEl.textContent.trim();
    }
    const labelEl = toolCallEl.querySelector(".label");
    const labelText = labelEl ? labelEl.textContent.trim() : "ツールを使用する";
    let result = `> **🔧 ${labelText}**: ${toolName}`;
    if (argsText) result += ` — ${argsText}`;
    return result;
  }

  // ======================================================
  // DOM → Markdown 変換
  // ======================================================

  /**
   * markdown-viewer DOM要素からMarkdownテキストを再構築する。
   */
  function extractMarkdownFromViewer(viewer) {
    let result = "";
    const children = getDirectContentChildren(viewer);
    if (!children || children.length === 0) return viewer.textContent.trim();
    for (const el of children) {
      result += convertElementToMarkdown(el);
    }
    return result.trim();
  }

  /**
   * viewer/container から直接のコンテンツ子要素を取得する。
   * markdown-viewer の構造は以下のパターンがありうる:
   *   - viewer > div > (p, table, pre, ...)
   *   - viewer > (p, table, pre, ...)
   *   - viewer > div > div > (p, table, pre, ...)
   */
  function getDirectContentChildren(container) {
    const directChildren = Array.from(container.children);
    if (directChildren.length === 0) return [];

    const hasContentElements = directChildren.some((el) => isContentElement(el));
    if (hasContentElements) return directChildren;

    // 直接の子が div のみの場合、div が1つだけなら中を探る
    const divChildren = directChildren.filter(
      (el) => el.tagName.toLowerCase() === "div"
    );
    if (divChildren.length === 1 && directChildren.length === 1) {
      return getDirectContentChildren(divChildren[0]);
    }

    // 複数の div がある場合はそれらをそのまま返す
    return directChildren;
  }

  /**
   * 要素がコンテンツ要素（段落、テーブル、リスト等）かどうかを判定
   */
  function isContentElement(el) {
    const tag = el.tagName.toLowerCase();
    return /^(p|table|pre|h[1-6]|ul|ol|blockquote|hr|dl|figure|details)$/.test(tag);
  }

  /**
   * 単一のDOM要素をMarkdown文字列に変換する
   */
  function convertElementToMarkdown(el) {
    const tag = el.tagName.toLowerCase();

    // using-tool-call / サイドバー関連はスキップ
    if (
      el.classList.contains("using-tool-call") ||
      el.classList.contains("tool-call-result-sidebar-inner") ||
      el.classList.contains("tool-call-result-sidebar")
    ) {
      return "";
    }

    if (tag === "p") {
      return convertInlineMarkdown(el) + "\n\n";
    }

    if (/^h[1-6]$/.test(tag)) {
      const originalLevel = parseInt(tag.charAt(1), 10);
      const newLevel = Math.min(originalLevel + 2, 6);
      const prefix = "#".repeat(newLevel);
      return `${prefix} ${convertInlineMarkdown(el)}\n\n`;
    }

    if (tag === "ul") return convertListToMarkdown(el, "ul", 0) + "\n";
    if (tag === "ol") return convertListToMarkdown(el, "ol", 0) + "\n";

    if (tag === "pre") {
      const code = el.querySelector("code");
      const lang = code?.className?.match(/language-(\w+)/)?.[1] || "";
      return "```" + lang + "\n" + (code?.textContent || el.textContent) + "\n```\n\n";
    }

    if (tag === "hr") return "---\n\n";
    if (tag === "blockquote") return convertBlockquoteToMarkdown(el) + "\n\n";
    if (tag === "table") return convertTableToMarkdown(el) + "\n\n";

    if (tag === "div") {
      // div の中身を再帰的に処理
      let divResult = "";
      for (const child of el.children) {
        divResult += convertElementToMarkdown(child);
      }
      // 子要素から何も取得できなかった場合、テキストをフォールバック
      if (!divResult.trim()) {
        const text = el.textContent.trim();
        if (text) return text + "\n\n";
      }
      return divResult;
    }

    // その他の要素
    const text = el.textContent.trim();
    if (text) return text + "\n\n";
    return "";
  }

  /**
   * インラインMarkdown変換（再帰対応版）
   */
  function convertInlineMarkdown(el) {
    let result = "";
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        result += node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.toLowerCase();
        const innerContent = convertInlineMarkdown(node);

        if (tag === "code") {
          result += "`" + node.textContent + "`";
        } else if (tag === "strong" || tag === "b") {
          result += "**" + innerContent + "**";
        } else if (tag === "em" || tag === "i") {
          result += "*" + innerContent + "*";
        } else if (tag === "a") {
          const href = node.getAttribute("href") || "";
          result += `[${innerContent}](${href})`;
        } else if (tag === "del" || tag === "s") {
          result += "~~" + innerContent + "~~";
        } else if (tag === "br") {
          result += "\n";
        } else if (tag === "mark") {
          result += innerContent;
        } else {
          result += innerContent;
        }
      }
    }
    return result;
  }

  /**
   * リスト要素を再帰的にMarkdownに変換（ネスト対応）
   */
  function convertListToMarkdown(listEl, listType, indentLevel) {
    let result = "";
    const indent = "  ".repeat(indentLevel);
    let counter = 1;

    for (const li of listEl.querySelectorAll(":scope > li")) {
      const prefix = listType === "ol" ? `${counter}. ` : "- ";

      let textContent = "";
      for (const child of li.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          textContent += child.textContent;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const childTag = child.tagName.toLowerCase();
          if (childTag === "ul" || childTag === "ol") continue;
          textContent += convertInlineMarkdown(child);
        }
      }

      result += `${indent}${prefix}${textContent.trim()}\n`;

      const subUl = li.querySelector(":scope > ul");
      const subOl = li.querySelector(":scope > ol");
      if (subUl) result += convertListToMarkdown(subUl, "ul", indentLevel + 1);
      if (subOl) result += convertListToMarkdown(subOl, "ol", indentLevel + 1);

      counter++;
    }
    return result;
  }

  /**
   * blockquote をMarkdownに変換
   */
  function convertBlockquoteToMarkdown(bqEl) {
    let innerMd = "";
    for (const child of bqEl.children) {
      innerMd += convertElementToMarkdown(child);
    }
    if (!innerMd.trim()) {
      innerMd = bqEl.textContent.trim();
    }
    const lines = innerMd.trim().split("\n");
    return lines.map((l) => `> ${l}`).join("\n");
  }

  /**
   * テーブル要素をMarkdownに変換。
   * thead/tbody の有無にかかわらず動作する。
   */
  function convertTableToMarkdown(table) {
    const allRows = Array.from(table.querySelectorAll("tr"));
    if (allRows.length === 0) return "";

    const lines = [];
    allRows.forEach((row, rowIndex) => {
      const cells = Array.from(row.querySelectorAll("th, td"));
      const cellTexts = cells.map((c) => {
        const text = convertInlineMarkdown(c);
        return text.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
      });
      lines.push("| " + cellTexts.join(" | ") + " |");

      // 最初の行の後にセパレータを挿入
      // th 要素を含むか、最初の行の場合にセパレータを追加
      if (rowIndex === 0) {
        const hasTh = cells.some((c) => c.tagName.toLowerCase() === "th");
        if (hasTh || allRows.length > 1) {
          lines.push("| " + cells.map(() => "---").join(" | ") + " |");
        }
      }
    });

    return lines.join("\n");
  }

  // ======================================================
  // 外部公開
  // ======================================================
  ns.createExportButton = createExportButton;
})();
