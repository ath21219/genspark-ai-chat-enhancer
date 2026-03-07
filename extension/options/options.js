(function () {
  const DEFAULT_OPTIONS = {
    chatWidthEnabled: false,
    chatWidthPercent: 90,
    chatWidthUnit: "percent",
    chatWidthPixel: 1200,
    tocEnabled: true,
    tocCollapsed: false,
    searchEnabled: true,
  };

  const chatWidthEnabled = document.getElementById("chatWidthEnabled");
  const chatWidthFieldset = document.getElementById("chatWidthFieldset");
  const chatWidthSlider = document.getElementById("chatWidthPercent");
  const chatWidthPercentValue = document.getElementById("chatWidthPercentValue");
  const chatWidthPixel = document.getElementById("chatWidthPixel");
  const tocEnabled = document.getElementById("tocEnabled");
  const unitRadios = document.querySelectorAll('input[name="chatWidthUnit"]');
  const saveBtn = document.getElementById("saveBtn");
  const saveStatus = document.getElementById("saveStatus");

  const searchEnabled = document.getElementById("searchEnabled");

  chatWidthEnabled.addEventListener("change", () => {
    chatWidthFieldset.disabled = !chatWidthEnabled.checked;
  });

  chatWidthSlider.addEventListener("input", () => {
    chatWidthPercentValue.textContent = chatWidthSlider.value;
  });

  function updateUnitUI() {
    const unit = document.querySelector(
      'input[name="chatWidthUnit"]:checked'
    ).value;
    document.getElementById("percentGroup").style.opacity =
      unit === "percent" ? "1" : "0.4";
    document.getElementById("pixelGroup").style.opacity =
      unit === "pixel" ? "1" : "0.4";
  }

  unitRadios.forEach((r) => r.addEventListener("change", updateUnitUI));

  // 読み込み
  browser.storage.local.get("options").then((stored) => {
    const opts = { ...DEFAULT_OPTIONS, ...(stored.options || {}) };

    chatWidthEnabled.checked = opts.chatWidthEnabled;
    chatWidthFieldset.disabled = !opts.chatWidthEnabled;
    chatWidthSlider.value = opts.chatWidthPercent;
    chatWidthPercentValue.textContent = opts.chatWidthPercent;
    chatWidthPixel.value = opts.chatWidthPixel;
    tocEnabled.checked = opts.tocEnabled;
    document.querySelector(
      `input[name="chatWidthUnit"][value="${opts.chatWidthUnit}"]`
    ).checked = true;
    updateUnitUI();

    searchEnabled.checked = opts.searchEnabled;
  });

  // 保存
  saveBtn.addEventListener("click", () => {
    const unit = document.querySelector(
      'input[name="chatWidthUnit"]:checked'
    ).value;
    const options = {
      chatWidthEnabled: chatWidthEnabled.checked,
      chatWidthPercent: parseInt(chatWidthSlider.value, 10),
      chatWidthUnit: unit,
      chatWidthPixel: parseInt(chatWidthPixel.value, 10),
      tocEnabled: tocEnabled.checked,
      searchEnabled: searchEnabled.checked,
    };

    browser.storage.local.set({ options }).then(() => {
      saveStatus.textContent = "保存しました";
      setTimeout(() => {
        saveStatus.textContent = "";
      }, 2000);
    });
  });
})();
