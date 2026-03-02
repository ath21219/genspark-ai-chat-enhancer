// ======================================================
// ツールバーアイコン左クリック → AIチャットを開く
// ======================================================

browser.action.onClicked.addListener(async () => {
  const GENSPARK_CHAT_URL = "https://www.genspark.ai/agents?type=ai_chat";

  const tabs = await browser.tabs.query({
    url: "https://www.genspark.ai/agents*",
  });

  const existingTab = tabs.find(
    (tab) => tab.url && tab.url.includes("type=ai_chat")
  );

  if (existingTab) {
    await browser.tabs.update(existingTab.id, { active: true });
    await browser.windows.update(existingTab.windowId, { focused: true });
  } else {
    await browser.tabs.create({ url: GENSPARK_CHAT_URL });
  }
});

// ======================================================
// ツールバーアイコン右クリックメニュー → オプション
// ======================================================

browser.menus.create({
  id: "open-options",
  title: "オプション",
  contexts: ["action"],
});

browser.menus.onClicked.addListener((info) => {
  if (info.menuItemId === "open-options") {
    browser.runtime.openOptionsPage();
  }
});
