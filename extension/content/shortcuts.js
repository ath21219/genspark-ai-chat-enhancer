// shortcuts.js — キーボードショートカット
(function () {
  "use strict";
  const ns = window.__gsEnhancer;

  function setupShortcuts() {
    document.addEventListener("keydown", (e) => {
      // Alt+T: 目次パネルの表示/非表示トグル
      if (e.altKey && e.key === "t") {
        e.preventDefault();
        const tocPanel = ns.toc.panel;
        if (tocPanel) {
          tocPanel.querySelector(".gs-toc-toggle")?.click();
        }
      }

      // Ctrl+Shift+F: 検索パネルを開く
      if (e.ctrlKey && e.shiftKey && e.key === "F") {
        e.preventDefault();
        if (!ns.currentOptions.searchEnabled) return;
        const tocPanel = ns.toc.panel;
        if (!tocPanel) return;
        // パネルが折り畳まれていたら展開
        if (tocPanel.classList.contains("collapsed")) {
          tocPanel.querySelector(".gs-toc-toggle")?.click();
        }
        ns.setPanelMode("search");
      }
    });
  }

  ns.setupShortcuts = setupShortcuts;
})();
