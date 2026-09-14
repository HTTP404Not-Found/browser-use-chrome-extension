// content/extractor.js
// Runs in every frame of every page (isolated world, all_frames: true).
// Provides DOM reads and DOM-based actions for the agent, plus
// a content extraction helper for chat context.
//
// Message API:
//   { type: 'ping' }            -> cheap liveness check for a frame
//   { type: 'probe' }           -> frame identity + how "interesting" this frame is
//   { type: 'extractContent' }
//   { type: 'snapshot' }
//   { type: 'click', ref }
//   { type: 'type', ref, text, submit }
//   { type: 'pressKey', key }
//   { type: 'scroll', direction, amount }
//   { type: 'extract', selector, attr, limit }
//   { type: 'clickByText', text, exact }
//   { type: 'listIframes' }
//   { type: 'getSelection' }

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
  'iframe',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

const CLICKABLE_SELECTOR =
  'a, button, [role="button"], [role="link"], [role="menuitem"], [role="tab"], input[type="submit"], input[type="button"]';

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------
// The old check used `el.offsetParent`, which is null for position:fixed
// elements — that silently hid fixed toolbars, sticky headers and modals from
// every snapshot. checkVisibility() (Chrome 105+, and we require 116) handles
// display:none on ancestors, visibility, opacity and content-visibility.

function isVisible(el) {
  if (!el || el.nodeType !== 1) return false;
  try {
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    } else {
      const cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
  } catch {
    return false;
  }
  const r = el.getBoundingClientRect();
  return r.width > 0 || r.height > 0;
}

function labelOf(el) {
  return (
    el.innerText ||
    el.value ||
    el.getAttribute?.('aria-label') ||
    el.getAttribute?.('title') ||
    el.placeholder ||
    ''
  )
    .toString()
    .trim();
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

function assignRefs(root = document) {
  root.querySelectorAll('[data-bu-ref]').forEach((el) => el.removeAttribute('data-bu-ref'));
  const nodes = Array.from(root.querySelectorAll(INTERACTIVE_SELECTOR)).filter(isVisible);
  const snapshot = [];
  nodes.forEach((el, idx) => {
    const ref = idx + 1;
    el.setAttribute('data-bu-ref', String(ref));
    snapshot.push(describe(el, ref));
  });
  return snapshot;
}

function describe(el, ref) {
  const tag = el.tagName.toLowerCase();
  const rect = el.getBoundingClientRect();
  if (tag === 'iframe') {
    return {
      ref,
      tag,
      isFrame: true,
      text: (el.getAttribute('title') || el.getAttribute('name') || '').trim().slice(0, 120),
      attrs: {
        id: el.id || undefined,
        name: el.getAttribute('name') || undefined,
        src: (el.getAttribute('src') || '').slice(0, 300),
        title: el.getAttribute('title') || undefined
      },
      note:
        'This is an iframe wrapper. Its content lives in a separate frame. ' +
        'Call browser_iframes, then browser_focus_frame(frameId) to act inside it.',
      selector: el.id
        ? `iframe#${el.id}`
        : el.getAttribute('name')
          ? `iframe[name="${el.getAttribute('name')}"]`
          : 'iframe',
      x: Math.round(rect.x),
      y: Math.round(rect.y)
    };
  }
  const text = labelOf(el).slice(0, 120);
  const attrs = {};
  for (const a of el.attributes) {
    if (['id', 'name', 'type', 'href', 'aria-label', 'role', 'placeholder', 'value', 'title'].includes(a.name)) {
      attrs[a.name] = a.value.slice(0, 200);
    }
  }
  let selector = tag;
  if (el.id) selector += `#${CSS.escape(el.id)}`;
  else if (attrs.name) selector += `[name="${attrs.name}"]`;
  else if (attrs['aria-label']) selector += `[aria-label="${attrs['aria-label']}"]`;
  return { ref, tag, text, attrs, selector, x: Math.round(rect.x), y: Math.round(rect.y) };
}

function listIframes() {
  const list = [];
  document.querySelectorAll('iframe').forEach((f, idx) => {
    const r = f.getBoundingClientRect();
    let liveSrc = null;
    try {
      // Frames that start at about:blank and are navigated by JS have a stale
      // src attribute. Same-origin frames will let us read the real URL.
      liveSrc = f.contentWindow?.location?.href || null;
    } catch {
      liveSrc = null; // cross-origin, expected
    }
    list.push({
      index: idx,
      id: f.id || null,
      name: f.getAttribute('name') || null,
      srcAttr: (f.getAttribute('src') || '').slice(0, 500),
      liveSrc: liveSrc ? String(liveSrc).slice(0, 500) : null,
      title: f.getAttribute('title') || null,
      width: Math.round(r.width),
      height: Math.round(r.height),
      visible: isVisible(f)
    });
  });
  return list;
}

// ---------------------------------------------------------------------------
// Frame probe — lets the background decide which frame is worth focusing
// ---------------------------------------------------------------------------

function probeFrame() {
  let interactiveCount = 0;
  try {
    interactiveCount = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR)).filter(isVisible).length;
  } catch {}
  let bodyText = '';
  try {
    bodyText = document.body?.innerText || '';
  } catch {}
  return {
    ok: true,
    url: location.href,
    title: document.title,
    isTop: window.top === window.self,
    interactiveCount,
    iframeCount: document.querySelectorAll('iframe').length,
    textLength: bodyText.length,
    textPreview: bodyText.replace(/\s+/g, ' ').trim().slice(0, 300),
    width: Math.round(document.documentElement?.clientWidth || 0),
    height: Math.round(document.documentElement?.clientHeight || 0)
  };
}

function getByRef(ref) {
  return document.querySelector(`[data-bu-ref="${ref}"]`);
}

// ---------------------------------------------------------------------------
// Readable text
// ---------------------------------------------------------------------------
// Previously this cloned the document and read innerText off the detached
// clone. A detached node has no layout, so innerText degrades to textContent:
// every display:none JS template, hidden dialog and rubric stub got dumped into
// the output as whitespace soup. Read the LIVE DOM instead — innerText there
// already respects rendering and skips script/style/hidden nodes.

function extractContent() {
  const candidates = [
    document.querySelector('main, article, [role="main"]'),
    document.querySelector('#content, .content, #main, .main'),
    document.body
  ].filter(Boolean);

  let best = '';
  for (const node of candidates) {
    let t = '';
    try {
      t = node.innerText || '';
    } catch {
      t = node.textContent || '';
    }
    if (t.trim().length > best.trim().length) best = t;
    if (best.trim().length > 400) break; // first solid hit wins
  }

  const text = best
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    title: document.title,
    url: location.href,
    isTop: window.top === window.self,
    fullLength: text.length,
    content: text.slice(0, 200000)
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function clickRef(ref) {
  const el = getByRef(ref);
  if (!el) return { ok: false, error: `No element with ref ${ref}. Snapshot again — the DOM may have changed.` };
  if (el.tagName === 'IFRAME') {
    return {
      ok: false,
      isFrame: true,
      error:
        `Ref ${ref} is an <iframe> wrapper, not a control. Its content is a separate frame. ` +
        `Call browser_iframes to get its frameId, then browser_focus_frame(frameId) and snapshot again.`
    };
  }
  try {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus({ preventScroll: true });
    el.click();
    return { ok: true, tag: el.tagName.toLowerCase(), text: labelOf(el).slice(0, 100) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function typeIntoRef(ref, text, submit) {
  const el = getByRef(ref);
  if (!el) return { ok: false, error: `No element with ref ${ref}` };
  try {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus({ preventScroll: true });
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const proto = el.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.isContentEditable) {
      el.innerText = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      return { ok: false, error: 'Element is not editable' };
    }
    if (submit) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const form = el.closest('form');
      if (form) {
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
      } else {
        el.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true }));
      }
    }
    return { ok: true, length: text.length };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Legacy apps (term.js, tty.js, CodeMirror 5, many canvas widgets) read
// ev.keyCode / ev.which, which a bare `new KeyboardEvent({key})` leaves at 0 —
// so every synthetic press was silently discarded. Fill in the legacy fields.

const KEYCODES = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
  Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32
};

function keyInfo(key) {
  const k = String(key);
  if (Object.prototype.hasOwnProperty.call(KEYCODES, k)) {
    return { key: k, keyCode: KEYCODES[k], code: k === ' ' ? 'Space' : k, printable: k === ' ' };
  }
  if (k.length === 1) {
    const cc = k.charCodeAt(0);
    const upper = k.toUpperCase();
    let code = '';
    if (/[a-zA-Z]/.test(k)) code = 'Key' + upper;
    else if (/[0-9]/.test(k)) code = 'Digit' + k;
    return { key: k, keyCode: /[a-z]/.test(k) ? upper.charCodeAt(0) : cc, charCode: cc, code, printable: true };
  }
  return { key: k, keyCode: 0, code: k, printable: false };
}

function dispatchKey(key, opts = {}) {
  const info = keyInfo(key);
  const target = document.activeElement && document.activeElement !== document.body
    ? document.activeElement
    : document.body || document.documentElement;
  const base = {
    key: info.key,
    code: info.code,
    keyCode: info.keyCode,
    which: info.keyCode,
    charCode: 0,
    bubbles: true,
    cancelable: true,
    composed: true,
    ctrlKey: !!opts.ctrl,
    shiftKey: !!opts.shift,
    altKey: !!opts.alt,
    metaKey: !!opts.meta
  };
  let defaultPrevented = false;
  const down = new KeyboardEvent('keydown', base);
  defaultPrevented = !target.dispatchEvent(down) || defaultPrevented;
  if (info.printable) {
    const press = new KeyboardEvent('keypress', { ...base, charCode: info.charCode ?? info.keyCode, which: info.charCode ?? info.keyCode });
    target.dispatchEvent(press);
    // Editable targets need the value change + input event as well.
    if (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
      try {
        if ('value' in target) {
          const proto = target.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(target, (target.value || '') + info.key);
        } else {
          target.textContent = (target.textContent || '') + info.key;
        }
        target.dispatchEvent(new InputEvent('input', { bubbles: true, data: info.key, inputType: 'insertText' }));
      } catch {}
    }
  }
  target.dispatchEvent(new KeyboardEvent('keyup', base));
  return { target, defaultPrevented };
}

function pressKey(key, opts) {
  const r = dispatchKey(key, opts || {});
  return {
    ok: true,
    key,
    target: r.target?.tagName?.toLowerCase() || null,
    handledByPage: r.defaultPrevented,
    note: r.defaultPrevented
      ? undefined
      : 'The page did not preventDefault on this key. Synthetic key events are untrusted and many terminals/editors ignore them — use browser_send_keys, which sends real input.'
  };
}

function sendKeys(text, submit) {
  const chars = String(text || '');
  for (const ch of chars) dispatchKey(ch);
  if (submit) dispatchKey('Enter');
  return { ok: true, typed: chars.length, submitted: !!submit, synthetic: true };
}

// The document is often not the thing that scrolls: app shells put the overflow
// on an inner div. Scrolling the window then reports scrollY 0 forever and the
// agent concludes the page is stuck.

function scrollingElements() {
  const out = [document.scrollingElement || document.documentElement];
  const all = document.querySelectorAll('div, main, section, article, [class*="scroll"]');
  for (const el of all) {
    if (el.scrollHeight - el.clientHeight < 40) continue;
    const ov = window.getComputedStyle(el).overflowY;
    if (ov === 'auto' || ov === 'scroll') out.push(el);
  }
  return out;
}

function scroll(direction, amount) {
  const delta = (direction === 'up' ? -1 : 1) * (amount || 600);
  const targets = scrollingElements();
  let used = null;
  let before = 0;
  for (const el of targets) {
    before = el.scrollTop;
    el.scrollTop = before + delta;
    if (el.scrollTop !== before) {
      used = el;
      break;
    }
  }
  if (!used) {
    // Nothing moved. Report the biggest scroller so the agent knows why.
    used = targets.sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || document.documentElement;
    before = used.scrollTop;
  }
  const top = used.scrollTop;
  const max = used.scrollHeight - used.clientHeight;
  return {
    ok: true,
    scrollTop: Math.round(top),
    scrollHeight: Math.round(used.scrollHeight),
    clientHeight: Math.round(used.clientHeight),
    moved: top !== before,
    atTop: top <= 1,
    atBottom: top >= max - 2,
    scrolledElement: used === (document.scrollingElement || document.documentElement)
      ? 'document'
      : used.tagName.toLowerCase() + (used.id ? '#' + used.id : ''),
    note: top === before
      ? 'Nothing scrolled. Either the content already fits, or it scrolls inside an element this heuristic missed. browser_page_text returns the WHOLE document regardless of scroll position — use it with an offset instead of scrolling to read more.'
      : undefined
  };
}

function extractBySelector(selector, attr, limit) {
  let nodes;
  try {
    nodes = Array.from(document.querySelectorAll(selector));
  } catch (e) {
    return {
      ok: false,
      error: `Invalid CSS selector "${selector}": ${e.message}. Standard CSS only — no :contains() or jQuery syntax.`
    };
  }
  const total = nodes.length;
  nodes = nodes.slice(0, limit || 20);
  const rawAttr = attr == null ? '' : String(attr);
  // Dotted property paths ("nextElementSibling.textContent") used to fall
  // through to getAttribute() and silently return "" — indistinguishable from
  // a real empty value. Reject them loudly instead.
  if (rawAttr.includes('.')) {
    return {
      ok: false,
      error: `attr "${rawAttr}" is a JS property path, which is not supported. ` +
        'Use one of: innerText, textContent, innerHTML, outerHTML, value, or a plain HTML attribute name (href, id, src, ...). ' +
        'To read siblings, write a CSS selector that targets them directly (e.g. "#some-id + p", "#some-id ~ *").'
    };
  }
  const lower = rawAttr.toLowerCase();
  const TEXT_PROPS = { innertext: 'innerText', outertext: 'outerText', textcontent: 'textContent' };
  const values = nodes.map((el) => {
    if (!rawAttr) return (el.innerText || el.textContent || '').trim().slice(0, 400);
    if (lower === 'innerhtml') return (el.innerHTML || '').slice(0, 4000);
    if (lower === 'outerhtml') return (el.outerHTML || '').slice(0, 4000);
    if (TEXT_PROPS[lower]) {
      // innerText was previously unsupported and fell through to getAttribute,
      // which always returns null for it -> every value came back as "".
      let v = el[TEXT_PROPS[lower]];
      if ((v == null || v === '') && lower !== 'textcontent') v = el.textContent;
      return String(v || '').slice(0, 4000);
    }
    if (lower === 'value' && 'value' in el) return String(el.value || '').slice(0, 400);
    const got = el.getAttribute(rawAttr);
    return got == null ? null : got.slice(0, 400);
  });
  const missing = rawAttr && values.every((v) => v === null);
  return {
    ok: true,
    count: values.length,
    totalMatched: total,
    values,
    ...(missing
      ? { note: `None of the matched elements have an attribute named "${rawAttr}". null means the attribute is absent (not empty). Did you mean innerText or textContent?` }
      : {})
  };
}

function scoreCandidates(elements, lower, matchExact) {
  return elements
    .map((el) => {
      const txt = labelOf(el);
      const tlower = txt.toLowerCase();
      let score = -1;
      if (matchExact) {
        if (tlower === lower) score = 100;
      } else {
        if (tlower === lower) score = 100;
        else if (tlower.includes(lower)) score = 80 - (tlower.length - lower.length) / 10;
        const al = (el.getAttribute?.('aria-label') || '').toLowerCase();
        if (al.includes(lower)) score = Math.max(score, 90);
      }
      return { el, txt, score };
    })
    .filter((c) => c.score >= 0)
    .sort((a, b) => b.score - a.score);
}

function clickByText(text, opts) {
  if (!text) return { ok: false, error: 'text required' };
  const matchExact = !!(opts && opts.exact);
  const lower = String(text).toLowerCase();

  const all = Array.from(document.querySelectorAll(CLICKABLE_SELECTOR));
  const visible = all.filter(isVisible);
  const scored = scoreCandidates(visible, lower, matchExact);

  if (!scored.length) {
    // The old version only said "no match" and listed the first 5 visible
    // elements — useless when the target exists but is hidden, a very common
    // LMS/SPA pattern. Report hidden matches explicitly so the agent can act.
    const hiddenMatches = scoreCandidates(all.filter((el) => !isVisible(el)), lower, matchExact);
    return {
      ok: false,
      error: `No VISIBLE clickable element matching "${text}".`,
      hiddenMatches: hiddenMatches.slice(0, 3).map((h) => ({
        text: h.txt.slice(0, 80),
        tag: h.el.tagName.toLowerCase(),
        href: h.el.getAttribute?.('href') || null
      })),
      hint: hiddenMatches.length
        ? 'A matching element exists but is hidden in this frame. Pages often hide such a fallback once the real UI has loaded, and the real control then lives inside an iframe. Call browser_iframes and focus the content frame. If the hidden match has an href, browser_navigate to it instead.'
        : 'Nothing matches in this frame. The control is probably inside an iframe: call browser_iframes, then browser_focus_frame.',
      visibleSample: visible.slice(0, 8).map((c) => labelOf(c).slice(0, 40)).filter(Boolean)
    };
  }

  const top = scored[0];
  try {
    top.el.scrollIntoView({ block: 'center', behavior: 'instant' });
    top.el.focus({ preventScroll: true });
    top.el.click();
    return {
      ok: true,
      tag: top.el.tagName.toLowerCase(),
      text: top.txt.slice(0, 100),
      candidates: scored.slice(0, 3).map((s) => s.txt.slice(0, 60))
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}


// ---------------------------------------------------------------------------
// Terminal reading
// ---------------------------------------------------------------------------
// Three cases in the wild:
//   xterm.js DOM renderer  -> .xterm-rows holds one div per line. Readable.
//   xterm.js canvas/WebGL  -> the buffer is PIXELS. Nothing readable in the DOM;
//                             .xterm-screen only contains an injected <style>,
//                             which is what an innerText read returns and why
//                             selector-guessing against it never terminates.
//   term.js / tty.js       -> .terminal divs hold the text directly.

function readTerminal() {
  const rows = document.querySelector('.xterm-rows');
  if (rows && (rows.innerText || '').trim()) {
    return { ok: true, renderer: 'xterm-dom', readable: true, text: rows.innerText };
  }

  const xterm = document.querySelector('.xterm');
  if (xterm) {
    const acc = xterm.querySelector('.xterm-accessibility');
    if (acc && (acc.innerText || '').trim()) {
      return { ok: true, renderer: 'xterm-accessibility', readable: true, text: acc.innerText };
    }
    const hasCanvas = !!xterm.querySelector('canvas');
    return {
      ok: false,
      renderer: hasCanvas ? 'xterm-canvas' : 'xterm-unknown',
      readable: false,
      error: 'This terminal draws its output to a <canvas>. The text is not in the DOM and no CSS selector can reach it.',
      hint:
        'Do not keep trying selectors — none will work. Either redirect the command output to a file and read that file from a terminal you CAN read, ' +
        'or turn on the editor\'s screen-reader accessibility mode, which makes xterm.js mirror the buffer into a .xterm-accessibility DOM node.'
    };
  }

  // term.js / tty.js: prefer the largest .terminal block that has text.
  const cands = Array.from(document.querySelectorAll('.terminal, .terminal-container'))
    .map((el) => ({ el, t: el.innerText || '' }))
    .filter((c) => c.t.trim())
    .sort((a, b) => b.t.length - a.t.length);
  if (cands.length) {
    return { ok: true, renderer: 'termjs', readable: true, text: cands[0].t };
  }

  return { ok: false, readable: false, renderer: 'none', error: 'No terminal found in this frame.' };
}

// What did the keystrokes actually land in? Used to verify typed text before
// the caller commits it with Enter.
function echoProbe() {
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !el.classList.contains('xterm-helper-textarea')) {
    return { ok: true, source: 'field', readable: true, sample: String(el.value || '').slice(-400) };
  }
  if (el && el.isContentEditable) {
    return { ok: true, source: 'contenteditable', readable: true, sample: (el.innerText || '').slice(-400) };
  }
  const term = readTerminal();
  if (term.readable) return { ok: true, source: term.renderer, readable: true, sample: term.text.slice(-400) };
  if (term.renderer && term.renderer !== 'none') {
    return { ok: true, source: term.renderer, readable: false, sample: '', error: term.error, hint: term.hint };
  }
  const body = (document.body?.innerText || '').slice(-400);
  return { ok: true, source: 'body', readable: !!body.trim(), sample: body };
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'ping':
          sendResponse({ ok: true, url: location.href, isTop: window.top === window.self });
          break;
        case 'probe':
          sendResponse(probeFrame());
          break;
        case 'extractContent':
          sendResponse({ ok: true, ...extractContent() });
          break;
        case 'snapshot':
          sendResponse({
            ok: true,
            url: location.href,
            title: document.title,
            isTop: window.top === window.self,
            elements: assignRefs(),
            iframes: listIframes()
          });
          break;
        case 'click':
          sendResponse(await clickRef(msg.ref));
          break;
        case 'type':
          sendResponse(await typeIntoRef(msg.ref, msg.text, msg.submit));
          break;
        case 'pressKey':
          sendResponse(pressKey(msg.key, msg));
          break;
        case 'readTerminal':
          sendResponse(readTerminal());
          break;
        case 'echoProbe':
          sendResponse(echoProbe());
          break;
        case 'sendKeys':
          sendResponse(sendKeys(msg.text, msg.submit));
          break;
        case 'scroll':
          sendResponse(scroll(msg.direction, msg.amount));
          break;
        case 'extract':
          sendResponse(extractBySelector(msg.selector, msg.attr, msg.limit));
          break;
        case 'clickByText':
          sendResponse(clickByText(msg.text, msg));
          break;
        case 'getSelection':
          sendResponse({ ok: true, selection: window.getSelection()?.toString() || '' });
          break;
        case 'listIframes':
          sendResponse({ ok: true, iframes: listIframes() });
          break;
        default:
          sendResponse({ ok: false, error: 'Unknown message type' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // async
});

// ---------------------------------------------------------------------------
// Optional badge. Off by default and top-frame only — it used to paint one "BU"
// chip per frame, which cluttered any page embedding several iframes.
// ---------------------------------------------------------------------------

if (window.top === window.self) {
  chrome.storage?.local?.get(['showBadge'], (r) => {
    if (!r?.showBadge) return;
    if (window.__BU_BADGE__) return;
    window.__BU_BADGE__ = true;
    const b = document.createElement('div');
    b.textContent = 'BU';
    b.title = 'Browser Use is active on this page';
    Object.assign(b.style, {
      position: 'fixed',
      right: '12px',
      bottom: '12px',
      zIndex: '2147483647',
      width: '24px',
      height: '24px',
      lineHeight: '24px',
      textAlign: 'center',
      borderRadius: '6px',
      fontFamily: 'system-ui, sans-serif',
      fontSize: '11px',
      fontWeight: '700',
      color: 'white',
      background: 'rgba(99,102,241,0.85)',
      boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
      pointerEvents: 'none',
      opacity: '0.65'
    });
    document.documentElement.appendChild(b);
  });
}
