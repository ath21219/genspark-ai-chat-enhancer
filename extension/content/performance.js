// performance.js — パフォーマンス改善用CSS注入
(function () {
  "use strict";
  const ns = window.__gsEnhancer;

  function injectPerformanceStyles() {
    const styleId = "gs-enhancer-perf-styles";
    if (document.getElementById(styleId)) return;

    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      .conversation-statement.gs-collapsed-statement > .desc {
        display: none !important;
      }
      .conversation-statement.gs-collapsed-statement > .gs-collapsed-preview {
        display: flex !important;
      }
      .conversation-statement.gs-collapsed-statement .using-tool-call .view-tool-call-result-button {
        pointer-events: auto;
      }
      .conversation-statement pre code {
        content-visibility: auto;
        contain-intrinsic-size: auto 100px;
      }
      .conversation-statement img:not([loading]) {
        content-visibility: auto;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  ns.injectPerformanceStyles = injectPerformanceStyles;
})();
