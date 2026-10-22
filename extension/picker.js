// The page picker, put into every frame of a tab when the popup's "Pick from
// the page" is pressed (background.js, `pick`).
//
// It only ever names the pick by its token: the worker keeps what İndir
// sends, so nothing the page does here can choose what reaches the app.
//
// A plain script, since that is all `scripting.executeScript` injects. It
// draws in a closed shadow root, out of reach of the page's styles and
// scripts; what the page supplied goes in through textContent, and pictures
// load only from http and https addresses, as in the popup.

(() => {
  if (globalThis.udPicker) return;

  const t = (key) => chrome.i18n.getMessage(key);
  const isTop = window === window.top;

  // Smaller on either side: an icon, a spacer, a tracking pixel.
  const MIN_SIDE = 40;
  // Deep enough to get under the clear layers sites lay over pictures and players.
  const STACK_DEPTH = 12;
  // No more links than the worker keeps (media.js, PICK_LINKS); levels enough
  // to climb out of a feed's nesting to the post.
  const LINKS_MAX = 40;
  const LINK_LEVELS = 25;
  const MIN_SENDING_MS = 300;
  const SENT_CLOSE_MS = 2000;

  const CSS = `
    :host {
      all: initial;
      --surface: #ffffff;
      --fill: rgb(0 0 0 / 0.05);
      --fill-hover: rgb(0 0 0 / 0.08);
      --fill-active: rgb(0 0 0 / 0.11);
      --surface-active: #e6e6e9;
      --border: rgb(0 0 0 / 0.08);
      --text-primary: #1d1d1f;
      --text-secondary: #636366;
      --text-tertiary: #6a6a6f;
      --accent: #ac440b;
      --accent-hover: #933a08;
      --accent-fg: #ffffff;
      --accent-soft: rgb(172 68 11 / 0.12);
      --accent-sheen: rgb(172 68 11 / 0.22);
      --accent-glow: rgb(172 68 11 / 0.45);
      --success: #0e7046;
      --error: #b4271c;
      --ink: rgb(29 29 31 / 0.92);
      --ink-fg: #f5f5f7;
      --font: -apple-system, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
      --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --surface: #2c2c2e;
        --fill: rgb(255 255 255 / 0.08);
        --fill-hover: rgb(255 255 255 / 0.12);
        --fill-active: rgb(255 255 255 / 0.16);
        --surface-active: #3a3a3d;
        --border: rgb(255 255 255 / 0.1);
        --text-primary: #f5f5f7;
        --text-secondary: #b2b2b7;
        --text-tertiary: #9d9da2;
        --accent: #ff8a4c;
        --accent-hover: #ff9d69;
        --accent-fg: #1d0e05;
        --accent-soft: rgb(255 138 76 / 0.16);
        --accent-sheen: rgb(255 138 76 / 0.26);
        --accent-glow: rgb(255 138 76 / 0.55);
        --success: #58cd8e;
        --error: #ff857a;
        --ink: rgb(44 44 46 / 0.94);
      }
    }
    * {
      box-sizing: border-box;
    }
    .layer {
      position: fixed;
      inset: 0;
      pointer-events: none;
      font-family: var(--font);
      font-size: 13px;
      line-height: 1.4;
      color: var(--text-primary);
      -webkit-font-smoothing: antialiased;
    }
    /* The white rim keeps the glow apart from whatever colours the picture has. */
    .box {
      position: fixed;
      border: 2px solid var(--accent);
      border-radius: 6px;
      background: var(--accent-soft);
      box-shadow: 0 0 0 1px rgb(255 255 255 / 0.7), 0 0 14px 3px var(--accent-glow);
      animation: glow 1.1s ease-in-out infinite alternate;
      transition-property: left, top, width, height;
      transition-duration: 60ms;
      transition-timing-function: var(--ease-out);
    }
    .box.held {
      animation: none;
    }
    @keyframes glow {
      to {
        background: var(--accent-sheen);
        box-shadow: 0 0 0 1px rgb(255 255 255 / 0.8), 0 0 28px 8px var(--accent-glow);
      }
    }
    /* Over the hovered element, so the click is the picker's: a native
       player's controls take a press before any listener hears it. */
    .catch {
      position: fixed;
      pointer-events: auto;
      cursor: crosshair;
    }
    .tag {
      position: fixed;
      max-width: 280px;
      padding: 2px 7px;
      border-radius: 6px;
      background: var(--accent);
      color: var(--accent-fg);
      font-size: 11.5px;
      font-weight: 600;
      line-height: 17px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-variant-numeric: tabular-nums;
    }
    .hint {
      position: fixed;
      top: 12px;
      left: 50%;
      transform: translateX(-50%);
      max-width: calc(100vw - 24px);
      padding: 7px 14px;
      border-radius: 999px;
      background: var(--ink);
      color: var(--ink-fg);
      font-size: 12.5px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      box-shadow: 0 6px 24px rgb(0 0 0 / 0.25);
    }
    .card {
      pointer-events: auto;
      position: fixed;
      top: 12px;
      right: 12px;
      width: 300px;
      max-width: calc(100vw - 24px);
      display: grid;
      gap: 10px;
      padding: 12px;
      border-radius: 14px;
      background: var(--surface);
      border: 1px solid var(--border);
      box-shadow: 0 18px 50px -12px rgb(0 0 0 / 0.35), 0 2px 8px rgb(0 0 0 / 0.08);
      user-select: none;
      cursor: default;
      animation: settle 260ms var(--ease-out) both;
    }
    @keyframes settle {
      from {
        opacity: 0;
        transform: translateY(-4px);
      }
    }
    .poster {
      position: relative;
      width: 100%;
      aspect-ratio: 16 / 9;
      border-radius: 10px;
      overflow: hidden;
      background: var(--fill);
      color: var(--text-tertiary);
      display: grid;
      place-items: center;
    }
    .poster svg {
      width: 20px;
      height: 20px;
    }
    .poster img {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      opacity: 0;
      transition: opacity 260ms var(--ease-out);
    }
    .poster img.loaded {
      opacity: 1;
    }
    .text {
      position: relative;
      min-width: 0;
      padding: 0 2px;
    }
    .title {
      margin: 0;
      padding-right: 22px;
      font-size: 14px;
      font-weight: 600;
      line-height: 19px;
      letter-spacing: -0.005em;
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow-wrap: anywhere;
    }
    .meta,
    .notice {
      margin: 3px 0 0;
      font-size: 12.5px;
      line-height: 17px;
      color: var(--text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-variant-numeric: tabular-nums;
    }
    .notice {
      margin: 0;
      padding: 0 2px;
      color: var(--error);
      white-space: normal;
    }
    .meta.pending {
      position: relative;
      color: transparent;
    }
    .meta.pending::after {
      content: "";
      position: absolute;
      left: 0;
      top: 50%;
      width: min(140px, 80%);
      height: 9px;
      margin-top: -4.5px;
      border-radius: 5px;
      background: var(--surface-active);
      animation: pulse 1.4s ease-in-out infinite;
    }
    @keyframes pulse {
      50% {
        opacity: 0.5;
      }
    }
    button {
      font: inherit;
      color: inherit;
      margin: 0;
    }
    button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .get {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      width: 100%;
      height: 34px;
      padding: 0 12px;
      border: 0;
      border-radius: 10px;
      background: var(--accent);
      color: var(--accent-fg);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: transform 150ms var(--ease-out), background-color 150ms var(--ease-out);
    }
    .get:hover:not(:disabled) {
      background: var(--accent-hover);
    }
    .get:active:not(:disabled) {
      transform: scale(0.98);
    }
    .get:disabled {
      opacity: 0.45;
      cursor: default;
    }
    .get[data-state="sending"] {
      opacity: 1;
      color: transparent;
    }
    .get[data-state="sending"]::after {
      content: "";
      position: absolute;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      border: 1.5px solid var(--accent-fg);
      border-right-color: transparent;
      animation: spin 700ms linear infinite;
    }
    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
    .get[data-state="sent"] {
      opacity: 1;
      background: none;
      color: var(--success);
    }
    .get svg {
      width: 15px;
      height: 15px;
    }
    .actions {
      display: flex;
      gap: 8px;
    }
    .actions .get {
      flex: 1;
      width: auto;
    }
    /* The app's secondary button. */
    .again {
      flex: 1;
      height: 34px;
      padding: 0 12px;
      border: 0;
      border-radius: 10px;
      background: var(--fill);
      color: var(--text-primary);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: transform 150ms var(--ease-out), background-color 150ms var(--ease-out);
    }
    .again:hover:not(:disabled) {
      background: var(--fill-hover);
    }
    .again:active:not(:disabled) {
      background: var(--fill-active);
      transform: scale(0.98);
    }
    .again:disabled {
      opacity: 0.45;
      cursor: default;
    }
    .close {
      position: absolute;
      top: -3px;
      right: -6px;
      width: 24px;
      height: 24px;
      padding: 0;
      border: 0;
      border-radius: 6px;
      background: none;
      color: var(--text-secondary);
      display: grid;
      place-items: center;
      cursor: pointer;
    }
    .close:hover {
      background: var(--fill);
      color: var(--text-primary);
    }
    .close svg {
      width: 12px;
      height: 12px;
    }
    @media (prefers-reduced-motion: reduce) {
      *,
      *::before,
      *::after {
        animation: none !important;
        transition: none !important;
      }
    }
  `;

  // A click meant to pick must not select text.
  const PAGE_CSS = '* { cursor: crosshair !important; user-select: none !important; }';

  const SVG = 'http://www.w3.org/2000/svg';

  let token = null;
  let picking = false;
  // What was clicked, outlined until the card is closed.
  let held = null;
  let point = null;
  let frame = 0;
  let host = null;
  let parts = null;
  let pageSheet = null;
  let closeTimer = 0;

  function glyph(d, attrs = {}) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    for (const [name, value] of Object.entries(attrs)) path.setAttribute(name, value);
    svg.append(path);
    return svg;
  }

  const stroke = { fill: 'none', stroke: 'currentColor', 'stroke-width': '2.25', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  const playGlyph = () => glyph('M8 5.5v13l10.5-6.5z', { fill: 'currentColor' });
  const checkGlyph = () => glyph('m5 12.5 4.5 4.5L19 7.5', stroke);
  const closeGlyph = () => glyph('M6 6l12 12M18 6 6 18', stroke);

  function node(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function layer() {
    if (host?.isConnected) return parts;
    host = document.createElement('ud-picker');
    for (const [name, value] of [['position', 'fixed'], ['inset', '0'], ['z-index', '2147483647'], ['pointer-events', 'none'], ['display', 'block']]) {
      host.style.setProperty(name, value, 'important');
    }
    const shadow = host.attachShadow({ mode: 'closed' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      // Firefox can refuse a content script's constructed sheet.
      shadow.append(node('style', '', CSS));
    }
    const root = node('div', 'layer');
    const box = node('div', 'box');
    const tag = node('div', 'tag');
    const catcher = node('div', 'catch');
    box.hidden = true;
    tag.hidden = true;
    catcher.hidden = true;
    catcher.addEventListener('wheel', onWheel, { passive: false });
    root.append(catcher, box, tag);
    shadow.append(root);
    document.documentElement.append(host);
    parts = { root, box, tag, catcher, hint: null, card: null };
    return parts;
  }

  function pageCursor(on) {
    try {
      if (on && !pageSheet) {
        pageSheet = new CSSStyleSheet();
        pageSheet.replaceSync(PAGE_CSS);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, pageSheet];
      } else if (!on && pageSheet) {
        const sheet = pageSheet;
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((each) => each !== sheet);
        pageSheet = null;
      }
    } catch {
      // Only the cursor is lost; picking still works.
    }
  }

  function parentOf(element) {
    if (element.parentElement) return element.parentElement;
    const parent = element.parentNode;
    return parent && parent.nodeType === Node.DOCUMENT_FRAGMENT_NODE && parent.host ? parent.host : null;
  }

  // Into open shadow roots too: a player's video is often inside one.
  function stackAt(root, x, y, depth = 0, out = []) {
    for (const element of root.elementsFromPoint(x, y)) {
      if (out.length >= STACK_DEPTH) break;
      if (element === host || out.includes(element)) continue;
      if (element.shadowRoot && depth < 4) stackAt(element.shadowRoot, x, y, depth + 1, out);
      if (!out.includes(element)) out.push(element);
    }
    return out;
  }

  function backgroundOf(element) {
    const value = getComputedStyle(element).backgroundImage;
    const found = /url\(\s*(["']?)(.*?)\1\s*\)/.exec(value ?? '');
    return found ? found[2] : '';
  }

  function mediaOf(element) {
    const name = element.localName;
    let kind = null;
    let src = '';
    if (name === 'video' || name === 'audio') kind = name;
    else if (name === 'img') kind = 'image';
    else if (name === 'picture') {
      const img = element.querySelector('img');
      return img ? mediaOf(img) : null;
    } else if (name !== 'html' && name !== 'body') {
      src = backgroundOf(element);
      if (src) kind = 'image';
    }
    if (!kind) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width < MIN_SIDE || rect.height < MIN_SIDE) return null;
    return { element, kind, src };
  }

  function mediaAt(x, y) {
    for (const element of stackAt(document, x, y)) {
      const found = mediaOf(element);
      if (found) return found;
    }
    return null;
  }

  function sizeOf(found) {
    const { element, kind } = found;
    if (kind === 'video' && element.videoWidth) return `${element.videoWidth}×${element.videoHeight}`;
    if (kind === 'image' && !found.src && element.naturalWidth) return `${element.naturalWidth}×${element.naturalHeight}`;
    return '';
  }

  const KIND_WORDS = { video: 'kindVideo', audio: 'kindAudio', image: 'kindImage' };

  function draw() {
    frame = 0;
    if (!parts) return;
    const found = held ?? (picking && point ? mediaAt(point.x, point.y) : null);
    const rect = found?.element.isConnected ? found.element.getBoundingClientRect() : null;
    const { box, tag, catcher } = parts;
    if (!rect || rect.width === 0 || rect.height === 0) {
      box.hidden = true;
      tag.hidden = true;
      catcher.hidden = true;
      return;
    }
    for (const each of [box, catcher]) {
      each.style.left = `${rect.left}px`;
      each.style.top = `${rect.top}px`;
      each.style.width = `${rect.width}px`;
      each.style.height = `${rect.height}px`;
    }
    box.hidden = false;
    box.classList.toggle('held', held !== null);
    catcher.hidden = !picking || held !== null;
    tag.hidden = false;
    tag.textContent = [t(KIND_WORDS[found.kind]), sizeOf(found)].filter(Boolean).join(' · ');
    const above = rect.top - 23;
    tag.style.left = `${Math.max(4, Math.min(rect.left, innerWidth - 284))}px`;
    tag.style.top = `${above >= 4 ? above : Math.max(4, rect.top + 4)}px`;
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(draw);
  }

  // A srcset's candidates, read as the HTML standard reads them: an address
  // runs to the first space, so the commas inside one (`w_400,c_fill`) are
  // part of it, and its descriptors run to the next comma.
  function srcsetOf(srcset) {
    const out = [];
    let at = 0;
    while (at < srcset.length) {
      while (at < srcset.length && /[\s,]/.test(srcset[at])) at += 1;
      if (at >= srcset.length) break;
      let end = at;
      while (end < srcset.length && !/\s/.test(srcset[end])) end += 1;
      let raw = srcset.slice(at, end);
      let descriptor = '';
      at = end;
      if (raw.endsWith(',')) {
        raw = raw.replace(/,+$/, '');
      } else {
        const comma = srcset.indexOf(',', at);
        const stop = comma === -1 ? srcset.length : comma;
        descriptor = srcset.slice(at, stop).trim().split(/\s+/)[0] ?? '';
        at = stop + 1;
      }
      if (raw) out.push([raw, descriptor]);
    }
    return out;
  }

  // The widest candidate on offer: the one on screen is often a thumbnail.
  function largest(img) {
    const candidates = [];
    const read = (srcset) => {
      for (const [raw, descriptor] of srcsetOf(srcset)) {
        let url = '';
        try {
          url = new URL(raw, document.baseURI).href;
        } catch {
          continue;
        }
        const w = /^(\d+)w$/.exec(descriptor);
        const x = /^(\d+(?:\.\d+)?)x$/.exec(descriptor);
        candidates.push({ url, w: w ? Number(w[1]) : 0, x: x ? Number(x[1]) : 1 });
      }
    };
    if (img.srcset) read(img.srcset);
    const picture = img.parentElement?.localName === 'picture' ? img.parentElement : null;
    if (picture) for (const source of picture.querySelectorAll('source[srcset]')) read(source.srcset);

    const current = img.currentSrc || img.src;
    let best = null;
    for (const candidate of candidates) {
      if (!best || candidate.w > best.w || (candidate.w === best.w && candidate.x > best.x)) best = candidate;
    }
    if (!best || best.url === current || (best.w === 0 && best.x <= 1)) {
      return { src: current, width: img.naturalWidth, height: img.naturalHeight };
    }
    const ratio = img.naturalWidth ? img.naturalHeight / img.naturalWidth : 0;
    return { src: best.url, width: best.w, height: best.w && ratio ? Math.round(best.w * ratio) : 0 };
  }

  const isWeb = (value) => typeof value === 'string' && /^https?:/i.test(value);

  function linkOf(element) {
    for (let at = element; at; at = parentOf(at)) {
      if (at.localName === 'a' && isWeb(at.href)) return at.href;
    }
    return '';
  }

  // Nearest first: the worker takes the first that is a post (media.js, `postOf`).
  function linksAround(element) {
    const out = [];
    let at = parentOf(element);
    for (let level = 0; at && level < LINK_LEVELS && out.length < LINKS_MAX; level += 1) {
      for (const anchor of at.querySelectorAll('a[href]')) {
        if (isWeb(anchor.href) && !out.includes(anchor.href)) out.push(anchor.href);
        if (out.length >= LINKS_MAX) break;
      }
      if (at.localName === 'article' || at.getAttribute('role') === 'article') break;
      at = parentOf(at);
    }
    return out;
  }

  // Checked again by the worker (media.js, `normalisePick`); this only gathers.
  function report(found) {
    const { element, kind } = found;
    const out = { tag: kind, href: location.href, link: linkOf(element), links: linksAround(element) };
    if (kind === 'image') {
      Object.assign(out, found.src ? { src: found.src } : largest(element));
      return out;
    }
    out.src = element.currentSrc || element.src || '';
    out.duration = Number.isFinite(element.duration) ? element.duration : 0;
    out.drm = element.mediaKeys != null;
    if (kind === 'video') {
      out.poster = element.poster || '';
      out.width = element.videoWidth || 0;
      out.height = element.videoHeight || 0;
    }
    return out;
  }

  async function send(message) {
    try {
      return await chrome.runtime.sendMessage({ ...message, token });
    } catch {
      // The extension was reloaded or removed under the page.
      return null;
    }
  }

  function onMove(event) {
    point = { x: event.clientX, y: event.clientY };
    schedule();
  }

  // The catch layer takes the wheel from the page; this is what should have had it.
  function scrollerOf(element) {
    for (let at = parentOf(element); at; at = parentOf(at)) {
      const { overflowY, overflowX } = getComputedStyle(at);
      const scrolls = (value) => value === 'auto' || value === 'scroll' || value === 'overlay';
      if ((scrolls(overflowY) && at.scrollHeight > at.clientHeight) || (scrolls(overflowX) && at.scrollWidth > at.clientWidth)) {
        return at;
      }
    }
    return document.scrollingElement ?? document.documentElement;
  }

  function onWheel(event) {
    const found = point ? mediaAt(point.x, point.y) : null;
    if (!found) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1;
    scrollerOf(found.element).scrollBy({ left: event.deltaX * unit, top: event.deltaY * unit });
  }

  // Into a frame, whose own picker takes over, or out of the window.
  function onOut(event) {
    const into = event.relatedTarget;
    if (!into || into.localName === 'iframe' || into.localName === 'frame') {
      point = null;
      schedule();
    }
  }

  // So the page's link does not open nor its player start. Touches are left
  // alone so a finger can still scroll; a tap's click is caught all the same.
  function swallow(event) {
    if (!picking) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onClick(event) {
    if (!picking) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.isTrusted || event.button !== 0) return;
    const found = mediaAt(event.clientX, event.clientY);
    if (found) void choose(found);
  }

  function onKey(event) {
    if (event.key !== 'Escape' || !event.isTrusted) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void finish();
  }

  const PRESSES = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'auxclick'];

  function listen(on) {
    const method = on ? addEventListener : removeEventListener;
    method('pointermove', onMove, { capture: true, passive: true });
    method('click', onClick, true);
    for (const type of PRESSES) method(type, swallow, { capture: true, passive: false });
    document[on ? 'addEventListener' : 'removeEventListener']('pointerout', onOut, true);
  }

  function follow(on) {
    const method = on ? addEventListener : removeEventListener;
    method('scroll', schedule, { capture: true, passive: true });
    method('resize', schedule, { passive: true });
    method('keydown', onKey, true);
  }

  function stopPicking() {
    if (picking) listen(false);
    picking = false;
    pageCursor(false);
    parts?.hint?.remove();
    if (parts) parts.hint = null;
    schedule();
  }

  function end() {
    stopPicking();
    follow(false);
    clearTimeout(closeTimer);
    held = null;
    point = null;
    token = null;
    host?.remove();
    host = null;
    parts = null;
  }

  // Closed from this frame: every other frame is told by the worker.
  async function finish() {
    const ending = token;
    if (!ending) return;
    end();
    try {
      await chrome.runtime.sendMessage({ action: 'pickEnd', token: ending });
    } catch {
      // No worker to tell: the extension was reloaded or removed.
    }
  }

  async function choose(found) {
    held = found;
    stopPicking();
    const reply = await send({ action: 'picked', pick: report(found) });
    // The worker no longer holds this pick: another started on this tab, or it
    // already ended.
    if (!reply?.ok) end();
  }

  function showPicture(box, src) {
    if (!isWeb(src) || box.dataset.src === src) return;
    box.dataset.src = src;
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('load', () => {
      if (box.dataset.src !== src) {
        img.remove();
        return;
      }
      img.classList.add('loaded');
      for (const old of box.querySelectorAll('img')) if (old !== img) old.remove();
    });
    img.addEventListener('error', () => img.remove());
    img.src = src;
    box.append(img);
  }

  async function press(button, notice) {
    button.disabled = true;
    button.dataset.state = 'sending';
    notice.hidden = true;
    const started = Date.now();
    const reply = await send({ action: 'pickGet' });
    const wait = MIN_SENDING_MS - (Date.now() - started);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    if (!button.isConnected) return;
    if (reply?.sent) {
      button.dataset.state = 'sent';
      const label = node('span', '', t('btnSent'));
      button.replaceChildren(checkGlyph(), label);
      closeTimer = setTimeout(() => void finish(), SENT_CLOSE_MS);
      return;
    }
    delete button.dataset.state;
    button.disabled = false;
    notice.textContent = reply?.notice || t('noticeUnreachable');
    notice.hidden = false;
  }

  async function showCard(card) {
    const { root } = layer();
    parts.card?.remove();
    follow(true);

    const box = node('div', 'card');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-labelledby', 'ud-pick-title');
    const poster = node('div', 'poster');
    poster.append(playGlyph());
    showPicture(poster, card.thumbnail);

    const text = node('div', 'text');
    const title = node('p', 'title', card.title ?? '');
    title.id = 'ud-pick-title';
    const meta = node('p', 'meta', card.meta ?? '');
    const close = node('button', 'close');
    close.type = 'button';
    close.title = t('pickClose');
    close.setAttribute('aria-label', t('pickClose'));
    close.append(closeGlyph());
    close.addEventListener('click', (event) => {
      if (event.isTrusted) void finish();
    });
    text.append(title, meta, close);

    const notice = node('p', 'notice');
    notice.setAttribute('role', 'alert');
    notice.hidden = true;
    box.append(poster, text, notice);

    const actions = node('div', 'actions');
    const again = node('button', 'again', t('btnPickAgain'));
    again.type = 'button';
    again.addEventListener('click', (event) => {
      if (event.isTrusted && !again.disabled) void pickAgain(again, notice);
    });
    actions.append(again);
    let button = null;
    if (card.canGet) {
      button = node('button', 'get', t('btnDownload'));
      button.type = 'button';
      button.setAttribute('aria-describedby', 'ud-pick-title');
      button.addEventListener('click', (event) => {
        if (event.isTrusted && !button.dataset.state) void press(button, notice);
      });
      actions.append(button);
    }
    box.append(actions);
    root.append(box);
    parts.card = box;
    (button ?? close).focus({ preventScroll: true });

    if (!card.probe) return;
    meta.classList.add('pending');
    const answer = await send({ action: 'pickProbe' });
    if (!box.isConnected) return;
    meta.classList.remove('pending');
    if (answer?.title) title.textContent = answer.title;
    if (answer?.thumbnail) showPicture(poster, answer.thumbnail);
    if (answer?.meta) meta.textContent = answer.meta;
    if (answer?.canGet === false) button?.remove();
  }

  // On success the new pick's start clears this card.
  async function pickAgain(button, notice) {
    button.disabled = true;
    notice.hidden = true;
    const reply = await send({ action: 'pickAgain' });
    if (reply?.ok || !button.isConnected) return;
    button.disabled = false;
    notice.textContent = t('pickFailed');
    notice.hidden = false;
  }

  function start(next) {
    if (token && token !== next) end();
    token = next;
    held = null;
    const { root } = layer();
    if (!picking) listen(true);
    picking = true;
    follow(true);
    pageCursor(true);
    if (isTop && !parts.hint) {
      parts.hint = node('div', 'hint', t('pickHint'));
      root.append(parts.hint);
    }
    return true;
  }

  // Answered so the worker can tell a frame with a picker from one without
  // (background.js, `tellFrames`).
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || !message || !token || message.token !== token) return false;
    respond(true);
    // Sent to every frame once one is clicked; the one holding the pick, or
    // the card, stays.
    if (message.udPick === 'stop') {
      stopPicking();
      if (!held && !parts?.card) {
        follow(false);
        host?.remove();
        host = null;
        parts = null;
      }
    } else if (message.udPick === 'end') {
      end();
    } else if (message.udPick === 'card' && message.card && typeof message.card === 'object') {
      void showCard(message.card);
    }
    return false;
  });

  globalThis.udPicker = { start };
})();
