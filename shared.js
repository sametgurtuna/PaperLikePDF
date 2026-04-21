(() => {
  'use strict';

  if (globalThis.PaperLikeShared) {
    return;
  }

  const STORAGE_AREA = 'sync';
  const STORAGE_KEYS = Object.freeze([
    'enabled',
    'opacity',
    'texture',
    'vignette',
    'autoDisableDark',
    'bookMode',
    'pageSound',
    'colorMode',
    'vintageHighlight'
  ]);

  const TEXTURES = Object.freeze(['classic', 'warm', 'gray']);
  const COLOR_MODES = Object.freeze(['none', 'sepia', 'night']);
  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    opacity: 15,
    texture: 'classic',
    vignette: true,
    autoDisableDark: true,
    bookMode: false,
    pageSound: false,
    colorMode: 'none',
    vintageHighlight: false
  });

  const MESSAGE_ACTIONS = Object.freeze({
    TOGGLE: 'paperlike/toggle'
  });

  const COMMANDS = Object.freeze({
    TOGGLE: 'toggle-paperlike'
  });

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalizeSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const next = { ...DEFAULT_SETTINGS };

    if (typeof source.enabled === 'boolean') {
      next.enabled = source.enabled;
    }

    if (typeof source.opacity === 'number' && Number.isFinite(source.opacity)) {
      next.opacity = clamp(Math.round(source.opacity), 0, 100);
    }

    if (typeof source.texture === 'string' && TEXTURES.includes(source.texture)) {
      next.texture = source.texture;
    }

    if (typeof source.vignette === 'boolean') {
      next.vignette = source.vignette;
    }

    if (typeof source.autoDisableDark === 'boolean') {
      next.autoDisableDark = source.autoDisableDark;
    }

    if (typeof source.bookMode === 'boolean') {
      next.bookMode = source.bookMode;
    }

    if (typeof source.pageSound === 'boolean') {
      next.pageSound = source.pageSound;
    }

    if (typeof source.colorMode === 'string' && COLOR_MODES.includes(source.colorMode)) {
      next.colorMode = source.colorMode;
    }

    if (typeof source.vintageHighlight === 'boolean') {
      next.vintageHighlight = source.vintageHighlight;
    }

    return next;
  }

  function pickSettingsPatch(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const patch = {};

    for (const key of STORAGE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        patch[key] = source[key];
      }
    }

    return patch;
  }

  function parseRgbColor(input) {
    if (!input || typeof input !== 'string') {
      return null;
    }

    const match = input.match(/rgba?\(([^)]+)\)/i);
    if (!match) {
      return null;
    }

    const parts = match[1].split(',').map((part) => Number.parseFloat(part.trim()));
    if (parts.length < 3 || parts.some((value) => !Number.isFinite(value))) {
      return null;
    }

    return {
      r: clamp(parts[0], 0, 255),
      g: clamp(parts[1], 0, 255),
      b: clamp(parts[2], 0, 255),
      a: Number.isFinite(parts[3]) ? clamp(parts[3], 0, 1) : 1
    };
  }

  function getRelativeLuminance(rgb) {
    if (!rgb) {
      return 1;
    }

    const r = rgb.r / 255;
    const g = rgb.g / 255;
    const b = rgb.b / 255;
    return (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
  }

  function isLikelyPdfUrl(url) {
    if (typeof document !== 'undefined' && document.contentType === 'application/pdf') {
      return true;
    }

    if (!url || typeof url !== 'string') {
      return false;
    }

    try {
      const parsed = new URL(url);
      const lowerPath = parsed.pathname.toLowerCase();
      return lowerPath.endsWith('.pdf');
    } catch (_error) {
      return false;
    }
  }

  function areSettingsEqual(a, b) {
    const left = normalizeSettings(a);
    const right = normalizeSettings(b);

    return STORAGE_KEYS.every((key) => left[key] === right[key]);
  }

  globalThis.PaperLikeShared = Object.freeze({
    STORAGE_AREA,
    STORAGE_KEYS,
    TEXTURES,
    COLOR_MODES,
    DEFAULT_SETTINGS,
    MESSAGE_ACTIONS,
    COMMANDS,
    normalizeSettings,
    pickSettingsPatch,
    parseRgbColor,
    getRelativeLuminance,
    isLikelyPdfUrl,
    areSettingsEqual
  });
})();
