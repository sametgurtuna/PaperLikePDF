/**
 * PaperLike Flipbook – 3D Page-Turning PDF Reader
 * Clean, optimized page turn with mouse drag + keyboard support.
 */
'use strict';

const { pdfjsLib } = globalThis;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

/* ── DOM ── */
const $ = (id) => document.getElementById(id);
const dom = {
    loading: $('fb-loading'), error: $('fb-error'), errorMsg: $('fb-error-msg'),
    errorClose: $('fb-error-close'), toolbar: $('fb-toolbar'), viewport: $('fb-viewport'),
    book: $('fb-book'), pageLeft: $('fb-page-left'), pageRight: $('fb-page-right'),
    turn: $('fb-turn'), turnFront: $('fb-turn-front'), turnBack: $('fb-turn-back'),
    under: $('fb-under'), zoneLeft: $('fb-zone-left'), zoneRight: $('fb-zone-right'),
    prev: $('fb-prev'), next: $('fb-next'), close: $('fb-close'),
    fullscreen: $('fb-fullscreen'), pageInfo: $('fb-page-info'),
    colorPicker: $('fb-color-picker'), clearBtn: $('fb-clear-btn'), drawBtn: $('fb-draw-btn'),
    progress: $('fb-progress'), progressBar: $('fb-progress-bar')
};

/* ── State ── */
const state = { pdf: null, total: 0, left: 0, busy: false, pageW: 0, pageH: 0, url: null };
const cache = new Map();
let annotations = {};
let drawMode = false;
let isDrawing = false;
let drawState = null;

/* ── Settings cache (synced from chrome.storage) ── */
const fbSettings = { pageSound: false, colorMode: 'none', texture: 'classic', opacity: 15 };

/* ── Web Audio page-turn sound (procedural, no asset) ── */
let audioCtx = null;
function getAudioCtx() {
    if (!audioCtx) {
        try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
        catch (_) { audioCtx = null; }
    }
    return audioCtx;
}

function playPageTurnSound() {
    if (!fbSettings.pageSound) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (_) {} }

    const now = ctx.currentTime;
    const dur = 0.28;

    // Noise source → bandpass → gain envelope → destination
    const bufSize = Math.floor(ctx.sampleRate * dur);
    const buffer = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufSize; i++) {
        // Slightly pink-ish noise: average two white samples
        data[i] = (Math.random() * 2 - 1) * 0.6 + (Math.random() * 2 - 1) * 0.4;
    }

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(3200, now);
    bp.frequency.exponentialRampToValueAtTime(1400, now + dur);
    bp.Q.value = 0.9;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 600;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.22, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(bp);
    bp.connect(hp);
    hp.connect(gain);
    gain.connect(ctx.destination);

    src.start(now);
    src.stop(now + dur + 0.02);
}

/* ── Drag State ── */
let dragDir = null;   // 'fwd' | 'bwd' | null
let dragStartX = 0;
let dragLastX = 0;
let dragPageW = 0;
let dragging = false;

/* ════════════════════════════════════════════
   INIT — waits for PDF data from content script via postMessage
   ════════════════════════════════════════════ */
async function loadPdf(source) {
    try {
        state.url = source.url || null;
        if (source.data) {
            // ArrayBuffer received from content script
            state.pdf = await pdfjsLib.getDocument({ data: source.data }).promise;
        } else if (source.url) {
            // Fallback: try loading by URL
            try { state.pdf = await pdfjsLib.getDocument(source.url).promise; }
            catch (_) {
                const buf = await (await fetch(source.url)).arrayBuffer();
                state.pdf = await pdfjsLib.getDocument({ data: buf }).promise;
            }
        } else {
            return showError('No PDF data received.');
        }

        state.total = state.pdf.numPages;
        const p1 = await state.pdf.getPage(1);
        const v = p1.getViewport({ scale: 1 });
        state.pageW = v.width; state.pageH = v.height;

        const m = await state.pdf.getMetadata().catch(() => null);
        if (m?.info?.Title) document.title = m.info.Title + ' — PaperLike';

        let savedLeft = 0;
        if (state.url) {
            try {
                const data = await chrome.storage.local.get(['fbNotes', 'fbProgress']);
                if (data.fbNotes && data.fbNotes[state.url]) annotations = data.fbNotes[state.url];
                if (data.fbProgress && data.fbProgress[state.url] !== undefined) savedLeft = data.fbProgress[state.url];
            } catch (e) {}
        }

        sizeBook();
        hide(dom.loading); show(dom.toolbar); show(dom.viewport);
        await showSpread(savedLeft);
        idle(savedLeft === 0 ? 2 : savedLeft + 2, savedLeft === 0 ? 3 : savedLeft + 3);
    } catch (e) { showError('Load failed: ' + e.message); }
}

function init() {
    // Listen for PDF data from content script
    window.addEventListener('message', (e) => {
        if (!e.data || !e.data.action) return;
        if (e.data.action === 'paperlike-pdf-data') {
            loadPdf({ data: e.data.data });
        } else if (e.data.action === 'paperlike-pdf-url') {
            loadPdf({ url: e.data.url });
        }
    });
    bindEvents();
}

/* ════════════════════════════════════════════
   RENDER PAGE
   ════════════════════════════════════════════ */
async function renderPage(n) {
    if (n < 1 || n > state.total) return null;
    if (cache.has(n)) return cache.get(n);
    const pg = await state.pdf.getPage(n);
    const vp = pg.getViewport({ scale: 2 });
    const c = document.createElement('canvas');
    c.width = vp.width; c.height = vp.height;
    const ctx = c.getContext('2d');
    await pg.render({ canvasContext: ctx, viewport: vp }).promise;
    
    if (annotations[n] && annotations[n].length > 0) {
        annotations[n].forEach(path => {
            ctx.beginPath();
            ctx.strokeStyle = path.color;
            ctx.lineWidth = path.width * (c.width / 1000);
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            path.points.forEach((p, i) => {
                const x = p.x * c.width;
                const y = p.y * c.height;
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            });
            ctx.stroke();
        });
    }

    cache.set(n, c);
    return c;
}

function idle(...nums) { nums.forEach(n => { if (n >= 1 && n <= state.total) renderPage(n); }); }

function clone(c) {
    const d = document.createElement('canvas');
    d.width = c.width; d.height = c.height;
    d.getContext('2d').drawImage(c, 0, 0);
    return d;
}

/* ════════════════════════════════════════════
   DISPLAY SPREAD
   ════════════════════════════════════════════ */
async function showSpread(left) {
    state.left = left;

    // Left page
    dom.pageLeft.innerHTML = '';
    dom.pageLeft.classList.remove('fb-empty');
    if (left >= 1) {
        const c = await renderPage(left);
        setPage(dom.pageLeft, c);
    } else {
        dom.pageLeft.classList.add('fb-empty');
    }

    // Right page
    const rn = left === 0 ? 1 : left + 1;
    dom.pageRight.innerHTML = '';
    dom.pageRight.classList.remove('fb-empty');
    if (rn <= state.total) {
        const c = await renderPage(rn);
        setPage(dom.pageRight, c);
    } else {
        dom.pageRight.classList.add('fb-empty');
    }

    updateInfo();
}

function setPage(el, canvas) {
    el.innerHTML = '';
    if (canvas) { el.appendChild(clone(canvas)); el.classList.remove('fb-empty'); }
    else el.classList.add('fb-empty');
}

/* ════════════════════════════════════════════
   NAVIGATION HELPERS
   ════════════════════════════════════════════ */
function canFwd() { return nextLeft() <= state.total; }
function canBwd() { return state.left > 0; }
function nextLeft() { return state.left === 0 ? 2 : state.left + 2; }
function prevLeft() { return state.left === 2 ? 0 : state.left - 2; }

/* ════════════════════════════════════════════
   PREPARE TURN
   
   Forward: Turn sits on RIGHT half, rotates around LEFT edge (spine).
            front = current right page, back = next left page.
            0deg → -180deg
   
   Backward: Turn sits on LEFT half, rotates around RIGHT edge (spine).
             front = current left page, back = prev right page.
             0deg → 180deg  (page swings from left to right)
   ════════════════════════════════════════════ */
async function prepareFwd() {
    const curR = state.left === 0 ? 1 : state.left + 1;
    const nl = nextLeft();

    const [frontC, backC, nrC] = await Promise.all([
        renderPage(curR), renderPage(nl), renderPage(nl + 1)
    ]);

    setPage(dom.turnFront, frontC);
    setPage(dom.turnBack, backC);

    // Under page (next left revealed as page lifts)
    setPage(dom.under, backC);
    dom.under.style.cssText = 'position:absolute;top:0;left:0;width:50%;height:100%;z-index:1;display:block;border-radius:4px 0 0 4px;';

    // Replace right page with next right (visible behind turning page)
    setPage(dom.pageRight, nrC);

    // Position turn element on RIGHT, pivot at LEFT edge
    dom.turn.style.cssText = 'display:block;position:absolute;top:0;right:0;left:auto;width:50%;height:100%;z-index:20;transform-style:preserve-3d;transform-origin:left center;transform:rotateY(0deg);';
}

async function prepareBwd() {
    const cl = state.left;
    const pl = prevLeft();
    const pr = pl === 0 ? 1 : pl + 1;

    const [frontC, backC, plC] = await Promise.all([
        renderPage(cl), renderPage(pr), renderPage(pl)
    ]);

    // Front = current left page (visible at start, facing us)
    // Back = previous right page (revealed as page turns to the right)
    setPage(dom.turnFront, frontC);
    setPage(dom.turnBack, backC);

    // Previous left page revealed under the turn
    setPage(dom.under, plC);
    dom.under.style.cssText = 'position:absolute;top:0;left:0;width:50%;height:100%;z-index:1;display:block;border-radius:4px 0 0 4px;';

    // Position turn on LEFT, pivot at RIGHT edge (spine)
    dom.turn.style.cssText = 'display:block;position:absolute;top:0;left:0;right:auto;width:50%;height:100%;z-index:20;transform-style:preserve-3d;transform-origin:right center;transform:rotateY(0deg);';
}

/* ════════════════════════════════════════════
   COMPLETE / CANCEL TURN
   ════════════════════════════════════════════ */
function finishTurn(dir, ms) {
    ms = ms || 400;
    playPageTurnSound();
    dom.turn.style.transition = `transform ${ms}ms cubic-bezier(0.4, 0, 0.2, 1)`;

    if (dir === 'fwd') dom.turn.style.transform = 'rotateY(-180deg)';
    else dom.turn.style.transform = 'rotateY(180deg)';

    const target = dir === 'fwd' ? nextLeft() : prevLeft();
    setTimeout(() => {
        cleanup();
        state.left = target;
        saveProgress();
        showSpread(target);
        if (dir === 'fwd') idle(target + 2, target + 3);
        else idle(target - 2 > 0 ? target - 2 : 0, target - 1 > 0 ? target - 1 : 1);
    }, ms + 20);
}

function snapBack(ms) {
    ms = ms || 300;
    dom.turn.style.transition = `transform ${ms}ms cubic-bezier(0.4, 0, 0.2, 1)`;
    dom.turn.style.transform = 'rotateY(0deg)';
    setTimeout(() => { cleanup(); showSpread(state.left); }, ms + 20);
}

function cleanup() {
    dom.turn.style.cssText = 'display:none;';
    dom.under.style.display = 'none';
    state.busy = false;
    dragging = false;
    dragDir = null;
}

/* ════════════════════════════════════════════
   MOUSE DRAG
   ════════════════════════════════════════════ */
async function dragStart(cx) {
    if (state.busy) return;
    const rect = dom.book.getBoundingClientRect();
    const rx = cx - rect.left;
    const isRight = rx > rect.width / 2;

    if (isRight && canFwd()) dragDir = 'fwd';
    else if (!isRight && canBwd()) dragDir = 'bwd';
    else return;

    state.busy = true;
    dragging = true;
    dragStartX = cx;
    dragLastX = cx;
    dragPageW = rect.width / 2;

    if (dragDir === 'fwd') await prepareFwd();
    else await prepareBwd();

    dom.turn.style.transition = 'none';
}

function dragMove(cx) {
    if (!dragging) return;
    dragLastX = cx;
    const dx = cx - dragStartX;

    if (dragDir === 'fwd') {
        // Drag LEFT → progress 0..1 → angle 0..-180
        const p = clamp(-dx / dragPageW, 0, 1);
        dom.turn.style.transform = `rotateY(${p * -180}deg)`;
    } else {
        // Drag RIGHT → progress 0..1 → angle 0..180
        const p = clamp(dx / dragPageW, 0, 1);
        dom.turn.style.transform = `rotateY(${p * 180}deg)`;
    }
}

function dragEnd() {
    if (!dragging) return;
    dragging = false;
    const dx = dragLastX - dragStartX;

    let progress;
    if (dragDir === 'fwd') progress = clamp(-dx / dragPageW, 0, 1);
    else progress = clamp(dx / dragPageW, 0, 1);

    if (progress > 0.25) {
        const remain = 1 - progress;
        finishTurn(dragDir, Math.max(120, Math.round(remain * 400)));
    } else {
        snapBack(Math.max(120, Math.round(progress * 300)));
    }
}

/* ════════════════════════════════════════════
   QUICK FLIP (keyboard / buttons)
   ════════════════════════════════════════════ */
async function flipFwd() {
    if (state.busy || !canFwd()) return;
    state.busy = true;
    dragDir = 'fwd';
    await prepareFwd();
    dom.turn.style.transition = 'transform 600ms cubic-bezier(0.4, 0, 0.2, 1)';
    void dom.turn.offsetWidth; // force reflow
    finishTurn('fwd', 600);
}

async function flipBwd() {
    if (state.busy || !canBwd()) return;
    state.busy = true;
    dragDir = 'bwd';
    await prepareBwd();
    dom.turn.style.transition = 'transform 600ms cubic-bezier(0.4, 0, 0.2, 1)';
    void dom.turn.offsetWidth;
    finishTurn('bwd', 600);
}

/* ════════════════════════════════════════════
   DRAWING & SYNC
   ════════════════════════════════════════════ */
async function saveProgress() {
    if (!state.url) return;
    try {
        const { fbProgress = {} } = await chrome.storage.local.get('fbProgress');
        fbProgress[state.url] = state.left;
        await chrome.storage.local.set({ fbProgress });
    } catch (e) {}
}

async function saveAnnotationsAsync() {
    if (!state.url) return;
    try {
        const { fbNotes = {} } = await chrome.storage.local.get('fbNotes');
        fbNotes[state.url] = annotations;
        await chrome.storage.local.set({ fbNotes });
    } catch (e) {}
}

function normalizePoint(cx, cy, canvas) {
    const rect = canvas.getBoundingClientRect();
    const x = clamp((cx - rect.left) / rect.width, 0, 1);
    const y = clamp((cy - rect.top) / rect.height, 0, 1);
    return { x, y };
}

function getDropTarget(cx, cy) {
    const rL = dom.pageLeft.getBoundingClientRect();
    const rR = dom.pageRight.getBoundingClientRect();
    if (cx >= rL.left && cx <= rL.right && cy >= rL.top && cy <= rL.bottom) return { pageNum: state.left, el: dom.pageLeft };
    if (cx >= rR.left && cx <= rR.right && cy >= rR.top && cy <= rR.bottom) return { pageNum: state.left === 0 ? 1 : state.left + 1, el: dom.pageRight };
    return null;
}

function startDraw(cx, cy) {
    const target = getDropTarget(cx, cy);
    if (!target || target.pageNum < 1 || target.pageNum > state.total) return;
    
    drawState = {
        pageNum: target.pageNum,
        canvas: target.el.querySelector('canvas'),
        path: { color: dom.colorPicker.value, width: 3, points: [] }
    };
    
    if (!drawState.canvas) return;
    if (!annotations[target.pageNum]) annotations[target.pageNum] = [];
    annotations[target.pageNum].push(drawState.path);
    isDrawing = true;
    addDrawPoint(cx, cy);
}

function addDrawPoint(cx, cy) {
    if (!isDrawing || !drawState || !drawState.canvas) return;
    const pt = normalizePoint(cx, cy, drawState.canvas);
    drawState.path.points.push(pt);
    
    const ctx = drawState.canvas.getContext('2d');
    const w = drawState.canvas.width;
    const h = drawState.canvas.height;
    const len = drawState.path.points.length;
    if (len > 1) {
        const p1 = drawState.path.points[len - 2];
        const p2 = drawState.path.points[len - 1];
        ctx.beginPath();
        ctx.strokeStyle = drawState.path.color;
        ctx.lineWidth = drawState.path.width * (w / 1000);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.moveTo(p1.x * w, p1.y * h);
        ctx.lineTo(p2.x * w, p2.y * h);
        ctx.stroke();
    }
}

function endDraw() {
    if (!isDrawing || !drawState) return;
    isDrawing = false;
    
    const cachedC = cache.get(drawState.pageNum);
    if (cachedC && cachedC !== drawState.canvas) {
        const ctx = cachedC.getContext('2d');
        const w = cachedC.width;
        const h = cachedC.height;
        ctx.beginPath();
        ctx.strokeStyle = drawState.path.color;
        ctx.lineWidth = drawState.path.width * (w / 1000);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        drawState.path.points.forEach((p, i) => {
            const x = p.x * w;
            const y = p.y * h;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.stroke();
    }
    drawState = null;
    saveAnnotationsAsync();
}

/* ════════════════════════════════════════════
   BOOK SIZING
   ════════════════════════════════════════════ */
function sizeBook() {
    const vh = window.innerHeight - 48 - 40;
    const vw = window.innerWidth - 60;
    const r = state.pageW / state.pageH;
    let pw = vh * r, ph = vh;
    if (pw * 2 > vw) { pw = vw / 2; ph = pw / r; }
    dom.book.style.width = pw * 2 + 'px';
    dom.book.style.height = ph + 'px';
    dom.pageLeft.style.width = pw + 'px'; dom.pageLeft.style.height = ph + 'px';
    dom.pageRight.style.width = pw + 'px'; dom.pageRight.style.height = ph + 'px';
}

/* ════════════════════════════════════════════
   HELPERS
   ════════════════════════════════════════════ */
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function show(el) { el.style.display = ''; }
function hide(el) { el.style.display = 'none'; }

function updateInfo() {
    const l = state.left || 1;
    const r = state.left === 0 ? 1 : Math.min(state.left + 1, state.total);
    dom.pageInfo.textContent = l === r ? `${l} / ${state.total}` : `${l}–${r} / ${state.total}`;

    // Reading progress
    const currentRead = state.left === 0 ? 0 : Math.min(state.left + 1, state.total);
    const pct = state.total > 0 ? (currentRead / state.total) * 100 : 0;
    const remaining = Math.max(0, state.total - currentRead);
    // Assume ~90 seconds per page for average academic PDF reading
    const SECONDS_PER_PAGE = 90;
    const etaSec = remaining * SECONDS_PER_PAGE;
    const etaLabel = formatEta(etaSec);

    if (dom.progress) {
        dom.progress.textContent = `${Math.round(pct)}% · ~${etaLabel} left`;
    }
    if (dom.progressBar) {
        dom.progressBar.style.width = pct.toFixed(1) + '%';
    }
}

function formatEta(sec) {
    if (!isFinite(sec) || sec <= 0) return '0m';
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m < 1) return '<1m';
    return `${m}m`;
}

function showError(msg) {
    hide(dom.loading); show(dom.error); dom.errorMsg.textContent = msg;
}

/* ════════════════════════════════════════════
   EVENTS
   ════════════════════════════════════════════ */
function bindEvents() {
    // ── Toolbar Draw ──
    dom.drawBtn.addEventListener('click', () => {
        drawMode = !drawMode;
        dom.drawBtn.style.background = drawMode ? 'rgba(255, 255, 255, 0.3)' : '';
        dom.zoneLeft.style.pointerEvents = drawMode ? 'none' : 'auto';
        dom.zoneRight.style.pointerEvents = drawMode ? 'none' : 'auto';
        if (drawMode) {
            show(dom.clearBtn); show(dom.colorPicker);
        } else {
            hide(dom.clearBtn); hide(dom.colorPicker);
        }
    });

    dom.clearBtn.addEventListener('click', async () => {
        let changed = false;
        const targets = [];
        if (state.left >= 1) targets.push(state.left);
        const right = state.left === 0 ? 1 : state.left + 1;
        if (right <= state.total) targets.push(right);
        
        targets.forEach(pageNum => {
            if (annotations[pageNum] && annotations[pageNum].length > 0) {
                annotations[pageNum] = [];
                cache.delete(pageNum);
                changed = true;
            }
        });
        
        if (changed) {
            await saveAnnotationsAsync();
            showSpread(state.left);
        }
    });

    // ── Mouse drag ──
    dom.book.addEventListener('mousedown', (e) => {
        if (drawMode) { e.preventDefault(); startDraw(e.clientX, e.clientY); return; }
        e.preventDefault();
        dragStart(e.clientX);
    });
    document.addEventListener('mousemove', (e) => {
        if (drawMode && isDrawing) { e.preventDefault(); addDrawPoint(e.clientX, e.clientY); return; }
        if (dragging) { e.preventDefault(); dragMove(e.clientX); }
    });
    document.addEventListener('mouseup', () => {
        if (drawMode && isDrawing) { endDraw(); return; }
        dragEnd();
    });

    // ── Touch ──
    dom.book.addEventListener('touchstart', (e) => {
        if (drawMode && e.touches.length === 1) { e.preventDefault(); startDraw(e.touches[0].clientX, e.touches[0].clientY); return; }
        if (e.touches.length === 1) { e.preventDefault(); dragStart(e.touches[0].clientX); }
    }, { passive: false });
    document.addEventListener('touchmove', (e) => {
        if (drawMode && isDrawing && e.touches.length === 1) { e.preventDefault(); addDrawPoint(e.touches[0].clientX, e.touches[0].clientY); return; }
        if (dragging && e.touches.length === 1) { e.preventDefault(); dragMove(e.touches[0].clientX); }
    }, { passive: false });
    document.addEventListener('touchend', () => {
        if (drawMode && isDrawing) { endDraw(); return; }
        dragEnd();
    });

    // ── Buttons ──
    dom.next.addEventListener('click', flipFwd);
    dom.prev.addEventListener('click', flipBwd);

    // ── Keyboard ──
    document.addEventListener('keydown', (e) => {
        switch (e.key) {
            case 'ArrowRight': case ' ': e.preventDefault(); flipFwd(); break;
            case 'ArrowLeft': e.preventDefault(); flipBwd(); break;
            case 'Escape': window.parent.postMessage({ action: 'paperlike-close-flipbook' }, '*'); break;
        }
    });

    // ── Close / Fullscreen ──
    dom.close.addEventListener('click', () => window.parent.postMessage({ action: 'paperlike-close-flipbook' }, '*'));
    dom.errorClose.addEventListener('click', () => window.parent.postMessage({ action: 'paperlike-close-flipbook' }, '*'));
    dom.fullscreen.addEventListener('click', () => {
        if (!document.fullscreenElement) document.documentElement.requestFullscreen();
        else document.exitFullscreen();
    });

    window.addEventListener('resize', sizeBook);
}

/* ════════════════════════════════════════════
   SETTINGS SYNC (texture style + opacity from popup)
   ════════════════════════════════════════════ */
const FB_COLOR_FILTERS = {
    none: '',
    sepia: 'sepia(0.45) saturate(1.15) hue-rotate(-8deg) brightness(0.97)',
    night: 'invert(0.92) hue-rotate(180deg) brightness(0.95) contrast(0.95)'
};

function applySettings(s) {
    fbSettings.pageSound = !!s.pageSound;
    fbSettings.colorMode = s.colorMode || 'none';
    fbSettings.texture = s.texture || 'classic';
    fbSettings.opacity = typeof s.opacity === 'number' ? s.opacity : 15;

    // Set texture class on book element
    dom.book.className = 'fb-book texture-' + fbSettings.texture;
    // Set texture opacity via CSS custom property
    dom.book.style.setProperty('--fb-tex-opacity', (fbSettings.opacity / 100).toFixed(2));

    // Color mode filter on the book (pages + turning page all inherit)
    const filter = FB_COLOR_FILTERS[fbSettings.colorMode] || '';
    dom.book.style.filter = filter;
}

function loadSettings() {
    const shared = globalThis.PaperLikeShared;
    if (!shared || !chrome?.storage?.sync) return;

    chrome.storage.sync.get(shared.DEFAULT_SETTINGS, (stored) => {
        applySettings(shared.normalizeSettings(stored));
    });

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        chrome.storage.sync.get(shared.DEFAULT_SETTINGS, (stored) => {
            applySettings(shared.normalizeSettings(stored));
        });
    });
}

/* ── Start ── */
loadSettings();
init();
