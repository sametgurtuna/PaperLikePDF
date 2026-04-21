(() => {
  'use strict';

  if (globalThis.__paperlikeContentInitialized) {
    return;
  }
  globalThis.__paperlikeContentInitialized = true;

  const shared = globalThis.PaperLikeShared;
  if (!shared) {
    return;
  }

  const {
    DEFAULT_SETTINGS,
    MESSAGE_ACTIONS,
    STORAGE_KEYS,
    normalizeSettings,
    parseRgbColor,
    getRelativeLuminance,
    isLikelyPdfUrl
  } = shared;

  if (!isLikelyPdfUrl(location.href)) {
    return;
  }

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    overlay: null,
    vignette: null,
    flipbookFrame: null,
    renderQueued: false
  };

  /* ── Create/find overlay elements ── */
  function ensureOverlayElements() {
    if (!state.overlay) {
      state.overlay = document.getElementById('paperlike-overlay');
    }
    if (!state.vignette) {
      state.vignette = document.getElementById('paperlike-vignette');
    }
    if (!state.overlay) {
      state.overlay = document.createElement('div');
      state.overlay.id = 'paperlike-overlay';
      document.documentElement.appendChild(state.overlay);
    }
    if (!state.vignette) {
      state.vignette = document.createElement('div');
      state.vignette.id = 'paperlike-vignette';
      document.documentElement.appendChild(state.vignette);
    }
  }

  /* ── Dark background detection (histogram-based) ──
     Samples multiple elements, bins their luminance (with area-weighting),
     and decides based on weighted majority rather than first-hit.
     Uses hysteresis to avoid flicker when settings re-render.
  */
  let _lastDarkDecision = false;
  function isDarkBackground() {
    const candidates = [
      document.querySelector('embed[type="application/pdf"]'),
      document.querySelector('#viewer'),
      document.querySelector('#viewerContainer'),
      document.querySelector('.textLayer'),
      document.body,
      document.documentElement
    ].filter(Boolean);

    // Luminance bins: [dark, mid, light]. Each sample votes with its area.
    let darkWeight = 0;
    let lightWeight = 0;
    let totalWeight = 0;

    for (const el of candidates) {
      let color;
      try { color = getComputedStyle(el).backgroundColor; } catch (_) { continue; }
      const parsed = parseRgbColor(color);
      if (!parsed || parsed.a === 0) continue;

      let area = 1;
      try {
        const rect = el.getBoundingClientRect();
        area = Math.max(1, rect.width * rect.height);
      } catch (_) {}
      const weight = area * (parsed.a || 1);

      const lum = getRelativeLuminance(parsed);
      if (lum < 0.28) darkWeight += weight;
      else if (lum > 0.55) lightWeight += weight;
      totalWeight += weight;
    }

    if (totalWeight === 0) return _lastDarkDecision;

    const darkRatio = darkWeight / totalWeight;
    const lightRatio = lightWeight / totalWeight;

    // Hysteresis: need stronger signal to flip state
    if (_lastDarkDecision) {
      _lastDarkDecision = darkRatio > 0.35;
    } else {
      _lastDarkDecision = darkRatio > 0.55 && darkRatio > lightRatio;
    }
    return _lastDarkDecision;
  }

  /* ── Flipbook iframe management ── */
  function showFlipbook() {
    if (state.flipbookFrame) return; // Already open

    const iframe = document.createElement('iframe');
    iframe.id = 'paperlike-flipbook-frame';
    iframe.src = chrome.runtime.getURL('flipbook.html');
    iframe.style.cssText = [
      'position:fixed', 'top:0', 'left:0',
      'width:100vw', 'height:100vh',
      'z-index:2147483647', 'border:none',
      'background:#1a140d'
    ].join(';');

    // When iframe loads, fetch PDF and send data to it
    iframe.addEventListener('load', async () => {
      try {
        const url = location.href;
        let buf;
        try {
          const resp = await fetch(url);
          if (!resp.ok) throw new Error('Fetch failed');
          buf = await resp.arrayBuffer();
        } catch (fetchErr) {
          if (url.startsWith('file://')) {
            buf = await new Promise((resolve, reject) => {
              const xhr = new XMLHttpRequest();
              xhr.open('GET', url, true);
              xhr.responseType = 'arraybuffer';
              xhr.onload = () => {
                if (xhr.status === 200 || xhr.status === 0) resolve(xhr.response);
                else reject(new Error('XHR failed'));
              };
              xhr.onerror = () => reject(new Error('XHR error'));
              xhr.send();
            });
          } else {
            throw fetchErr;
          }
        }
        iframe.contentWindow.postMessage(
          { action: 'paperlike-pdf-data', data: buf, url: url },
          '*',
          [buf]  // transfer, not copy (faster)
        );
      } catch (err) {
        // Fallback: send URL and let iframe try itself
        iframe.contentWindow.postMessage(
          { action: 'paperlike-pdf-url', url: location.href },
          '*'
        );
      }
    });

    document.documentElement.appendChild(iframe);
    state.flipbookFrame = iframe;
  }

  function hideFlipbook() {
    if (state.flipbookFrame) {
      state.flipbookFrame.remove();
      state.flipbookFrame = null;
    }
  }

  /* ── Listen for close message from flipbook ── */
  window.addEventListener('message', (e) => {
    if (e.data && e.data.action === 'paperlike-close-flipbook') {
      hideFlipbook();
      // Also update storage so popup reflects the state
      chrome.storage.sync.set({ bookMode: false });
    }
  });

  /* ── Show/hide overlay ── */
  function setOverlayHidden(hidden) {
    state.overlay.classList.toggle('paperlike-hidden', hidden);
    state.vignette.classList.toggle('paperlike-hidden', hidden || !state.settings.vignette);
  }

  /* ── Color mode (sepia / night) applied via CSS filter on PDF viewer ── */
  const COLOR_FILTERS = {
    none: '',
    sepia: 'sepia(0.45) saturate(1.15) hue-rotate(-8deg) brightness(0.97)',
    night: 'invert(0.92) hue-rotate(180deg) brightness(0.95) contrast(0.95)'
  };

  function applyColorMode(mode, active) {
    const filter = active ? (COLOR_FILTERS[mode] || '') : '';
    const targets = [
      document.querySelector('embed[type="application/pdf"]'),
      document.querySelector('#viewer'),
      document.querySelector('#viewerContainer')
    ].filter(Boolean);

    if (targets.length === 0) {
      // Native Chrome PDF viewer: fall back to documentElement
      document.documentElement.style.filter = filter;
    } else {
      document.documentElement.style.filter = '';
      for (const el of targets) el.style.filter = filter;
    }
  }

  /* ── Vintage highlight toggle ── */
  function applyVintageHighlight(on) {
    document.documentElement.classList.toggle('paperlike-vintage-hl', !!on);
  }

  /* ── Main render ── */
  function render() {
    state.renderQueued = false;
    ensureOverlayElements();

    const settings = state.settings;
    const shouldHide = !settings.enabled || (settings.autoDisableDark && isDarkBackground());

    // Paper texture overlay
    state.overlay.className = `texture-${settings.texture}`;
    state.overlay.style.setProperty('--paperlike-opacity', (settings.opacity / 100).toFixed(2));
    state.vignette.style.setProperty(
      '--paperlike-vignette-opacity',
      Math.min((settings.opacity / 100) * 2, 0.5).toFixed(2)
    );
    setOverlayHidden(shouldHide);

    // Color mode (sepia / night) — only active when extension is enabled
    applyColorMode(settings.colorMode, settings.enabled && settings.colorMode !== 'none' && !shouldHide);

    // Vintage search highlight
    applyVintageHighlight(settings.enabled && settings.vintageHighlight);

    // Flipbook (Book Mode)
    if (settings.bookMode && settings.enabled) {
      showFlipbook();
    } else {
      hideFlipbook();
    }
  }

  function queueRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(render);
  }

  function updateSettings(patch) {
    state.settings = normalizeSettings({ ...state.settings, ...patch });
    queueRender();
  }

  function updateSettingsFromStorageChanges(changes, areaName) {
    if (areaName !== 'sync') return;
    const patch = {};
    let hasKnownKey = false;
    for (const key of STORAGE_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(changes, key)) continue;
      const change = changes[key];
      patch[key] = change && Object.prototype.hasOwnProperty.call(change, 'newValue')
        ? change.newValue
        : DEFAULT_SETTINGS[key];
      hasKnownKey = true;
    }
    if (hasKnownKey) updateSettings(patch);
  }

  function handleToggleMessage(sendResponse) {
    const nextEnabled = !state.settings.enabled;
    updateSettings({ enabled: nextEnabled });
    chrome.storage.sync.set({ enabled: nextEnabled }, () => {
      if (chrome.runtime.lastError) { /* optimistic */ }
      sendResponse({ enabled: nextEnabled });
    });
  }

  /* ── Bootstrap ── */
  chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
    updateSettings(stored);
  });

  chrome.storage.onChanged.addListener(updateSettingsFromStorageChanges);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.action !== MESSAGE_ACTIONS.TOGGLE) return false;
    handleToggleMessage(sendResponse);
    return true;
  });
})();
