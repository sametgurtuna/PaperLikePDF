(() => {
  'use strict';

  const shared = globalThis.PaperLikeShared;
  if (!shared) {
    return;
  }

  const { DEFAULT_SETTINGS, normalizeSettings, STORAGE_KEYS } = shared;

  const elements = {
    enabled: document.getElementById('toggle-enabled'),
    opacity: document.getElementById('opacity-slider'),
    opacityValue: document.getElementById('opacity-value'),
    texture: document.getElementById('texture-select'),
    vignette: document.getElementById('toggle-vignette'),
    autoDisableDark: document.getElementById('toggle-autodark'),
    bookMode: document.getElementById('toggle-bookmode'),
    colorMode: document.getElementById('color-mode-select'),
    pageSound: document.getElementById('toggle-pagesound'),
    vintageHighlight: document.getElementById('toggle-vintage-hl'),
    statusText: document.getElementById('status-text'),
    dependentRows: Array.from(document.querySelectorAll('.dependent-control'))
  };

  const requiredControls = [
    elements.enabled,
    elements.opacity,
    elements.opacityValue,
    elements.texture,
    elements.vignette,
    elements.autoDisableDark,
    elements.bookMode,
    elements.colorMode,
    elements.pageSound,
    elements.vintageHighlight,
    elements.statusText
  ];

  if (requiredControls.some((control) => control === null)) {
    return;
  }

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    writeTimer: null,
    pendingPatch: {}
  };

  function queueWrite(patch, delayMs) {
    state.pendingPatch = { ...state.pendingPatch, ...patch };

    if (state.writeTimer !== null) {
      clearTimeout(state.writeTimer);
      state.writeTimer = null;
    }

    state.writeTimer = setTimeout(() => {
      const payload = state.pendingPatch;
      state.pendingPatch = {};
      state.writeTimer = null;
      chrome.storage.sync.set(payload);
    }, delayMs);
  }

  function writeImmediate(patch) {
    if (state.writeTimer !== null) {
      clearTimeout(state.writeTimer);
      state.writeTimer = null;
    }

    state.pendingPatch = { ...state.pendingPatch, ...patch };
    const payload = state.pendingPatch;
    state.pendingPatch = {};
    chrome.storage.sync.set(payload);
  }

  function render() {
    const settings = state.settings;

    elements.enabled.checked = settings.enabled;
    elements.opacity.value = String(settings.opacity);
    elements.opacityValue.textContent = `${settings.opacity}%`;
    elements.texture.value = settings.texture;
    elements.vignette.checked = settings.vignette;
    elements.autoDisableDark.checked = settings.autoDisableDark;
    if (elements.bookMode) elements.bookMode.checked = settings.bookMode;
    elements.colorMode.value = settings.colorMode;
    elements.pageSound.checked = settings.pageSound;
    elements.vintageHighlight.checked = settings.vintageHighlight;

    elements.statusText.textContent = settings.enabled ? 'Active' : 'Disabled';
    elements.statusText.style.color = settings.enabled ? '#5f8454' : '#9f8f7c';

    for (const row of elements.dependentRows) {
      row.classList.toggle('is-disabled', !settings.enabled);
    }

    const dependentInputs = [
      elements.opacity,
      elements.texture,
      elements.vignette,
      elements.autoDisableDark,
      elements.bookMode,
      elements.colorMode,
      elements.pageSound,
      elements.vintageHighlight
    ].filter(Boolean);
    for (const control of dependentInputs) {
      control.disabled = !settings.enabled;
    }
  }

  function applyPatch(patch, writeMode) {
    state.settings = normalizeSettings({ ...state.settings, ...patch });
    render();

    if (writeMode === 'immediate') {
      writeImmediate(patch);
    } else if (writeMode === 'debounced') {
      queueWrite(patch, 120);
    }
  }

  function onStorageChanged(changes, areaName) {
    if (areaName !== 'sync') {
      return;
    }

    const patch = {};
    let hasKnownKey = false;

    for (const key of STORAGE_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(changes, key)) {
        continue;
      }

      const change = changes[key];
      patch[key] = change && Object.prototype.hasOwnProperty.call(change, 'newValue')
        ? change.newValue
        : DEFAULT_SETTINGS[key];
      hasKnownKey = true;
    }

    if (!hasKnownKey) {
      return;
    }

    state.settings = normalizeSettings({ ...state.settings, ...patch });
    render();
  }

  function bindEvents() {
    elements.enabled.addEventListener('change', () => {
      applyPatch({ enabled: elements.enabled.checked }, 'immediate');
    });

    elements.opacity.addEventListener('input', () => {
      const value = Number.parseInt(elements.opacity.value, 10);
      if (Number.isFinite(value)) {
        applyPatch({ opacity: value }, 'debounced');
      }
    });

    elements.opacity.addEventListener('change', () => {
      const value = Number.parseInt(elements.opacity.value, 10);
      if (Number.isFinite(value)) {
        applyPatch({ opacity: value }, 'immediate');
      }
    });

    elements.texture.addEventListener('change', () => {
      applyPatch({ texture: elements.texture.value }, 'immediate');
    });

    elements.vignette.addEventListener('change', () => {
      applyPatch({ vignette: elements.vignette.checked }, 'immediate');
    });

    elements.autoDisableDark.addEventListener('change', () => {
      applyPatch({ autoDisableDark: elements.autoDisableDark.checked }, 'immediate');
    });

    if (elements.bookMode) {
      elements.bookMode.addEventListener('change', () => {
        applyPatch({ bookMode: elements.bookMode.checked }, 'immediate');
      });
    }

    elements.colorMode.addEventListener('change', () => {
      applyPatch({ colorMode: elements.colorMode.value }, 'immediate');
    });

    elements.pageSound.addEventListener('change', () => {
      applyPatch({ pageSound: elements.pageSound.checked }, 'immediate');
    });

    elements.vintageHighlight.addEventListener('change', () => {
      applyPatch({ vintageHighlight: elements.vintageHighlight.checked }, 'immediate');
    });
  }

  function bootstrap() {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
      state.settings = normalizeSettings(stored);
      render();
    });

    bindEvents();
    chrome.storage.onChanged.addListener(onStorageChanged);
  }

  bootstrap();
})();
