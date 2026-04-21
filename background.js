importScripts('shared.js');

(() => {
  'use strict';

  const {
    DEFAULT_SETTINGS,
    MESSAGE_ACTIONS,
    COMMANDS,
    normalizeSettings,
    areSettingsEqual
  } = globalThis.PaperLikeShared;

  async function readRawSettings() {
    try {
      return await chrome.storage.sync.get(DEFAULT_SETTINGS);
    } catch (_error) {
      return { ...DEFAULT_SETTINGS };
    }
  }

  async function normalizePersistedSettings() {
    const current = await readRawSettings();
    const normalized = normalizeSettings(current);

    if (!areSettingsEqual(current, normalized)) {
      await chrome.storage.sync.set(normalized);
      return normalized;
    }

    return current;
  }

  chrome.runtime.onInstalled.addListener((details) => {
    void (async () => {
      const normalized = await normalizePersistedSettings();
      if (details.reason === 'install') {
        await chrome.storage.sync.set(normalized);
      }
    })();
  });

  chrome.commands.onCommand.addListener((command) => {
    if (command !== COMMANDS.TOGGLE) {
      return;
    }

    void (async () => {
      let tabId = null;

      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0] && typeof tabs[0].id === 'number') {
          tabId = tabs[0].id;
        }
      } catch (_error) {
        return;
      }

      if (tabId === null) {
        return;
      }

      try {
        await chrome.tabs.sendMessage(tabId, { action: MESSAGE_ACTIONS.TOGGLE });
      } catch (_error) {
        // Content script is not available in this tab.
      }
    })();
  });
})();
