// content/extractor.js
// Runs in every page (isolated world via manifest).
// Provides DOM reads and DOM-based actions for the agent, plus
// a content extraction helper for chat context.
//
// Message API:
//   { type: 'extractContent' }
//   { type: 'snapshot' }
//   { type: 'click', ref }
//   { type: 'type', ref, text, submit }
//   { type: 'pressKey', key }
//   { type: 'scroll', direction, amount }
//   { type: 'extract', selector, attr, limit }
//   { type: 'getSelection' }

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
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

function assignRefs(root = document) {
  // Clear stale refs
  root.querySelectorAll('[data-bu-ref]').forEach((el) => el.removeAttribute('data-bu-ref'));
  const nodes = Array.from(root.querySelectorAll(INTERACTIVE_SELECTOR)).filter((el) => {
    if (!el.offsetParent && el.tagName !== 'BODY') return false; // hidden
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    return true;
  });
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
  // Flag iframe wrappers explicitly so the agent knows not to click them as if they were buttons.
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
      selector: el.id ? `iframe#${el.id}` : (el.getAttribute('name') ? `iframe[name="${el.getAttribute('name')}"]` : 'iframe'),
      x: Math.round(el.getBoundingClientRect().x),
      y: Math.round(el.getBoundingClientRect().y)
    };
  }
  const text = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().slice(0, 120);
  const attrs = {};
  for (const a of el.attributes) {
    if (['id', 'name', 'type', 'href', 'aria-label', 'role', 'placeholder', 'value', 'title'].includes(a.name)) {
      attrs[a.name] = a.value.slice(0, 200);
    }
  }
  // Simple css path selector (good enough)
  let selector = tag;
  if (el.id) selector += `#${el.id}`;
  else if (attrs.name) selector += `[name="${attrs.name}"]`;
  else if (attrs['aria-label']) selector += `[aria-label="${attrs['aria-label']}"]`;
  return { ref, tag, text, attrs, selector, x: Math.round(el.getBoundingClientRect().x), y: Math.round(el.getBoundingClientRect().y) };
}

function listIframes() {
  const list = [];
  document.querySelectorAll('iframe').forEach((f, idx) => {
    const r = f.getBoundingClientRect();
    list.push({
      index: idx,
      id: f.id || null,
      name: f.getAttribute('name') || null,
      src: (f.getAttribute('src') || '').slice(0, 500),
      title: f.getAttribute('title') || null,
      width: Math.round(r.width),
      height: Math.round(r.height),
      visible: r.width > 0 && r.height > 0
    });
  });
  return list;
}

function getByRef(ref) {
  return document.querySelector(`[data-bu-ref="${ref}"]`);
}

function extractContent() {
  // Readability-lite: clone, strip noise, get text. Limited to ~120k chars.
  const clone = document.cloneNode(true);
  clone.querySelectorAll(
    'script, style, noscript, svg, canvas, video, audio, iframe, [aria-hidden="true"], header nav, footer'
  ).forEach((el) => el.remove());
  const main =
    clone.querySelector('main, article, [role="main"]') ||
    clone.querySelector('#content, .content, #main, .main') ||
    clone.body;
  if (!main) return { title: document.title, url: location.href, content: '' };
  const text = main.innerText.replace(/\n{3,}/g, '\n\n').trim();
  return {
    title: document.title,
    url: location.href,
    content: text.slice(0, 120000)
  };
}

async function clickRef(ref) {
  const el = getByRef(ref);
  if (!el) return { ok: false, error: `No element with ref ${ref}` };
  if (el.tagName === 'IFRAME') {
    return {
      ok: false,
      isFrame: true,
      error: `Ref ${ref} points to an <iframe> wrapper, which cannot be clicked. ` +
             `The content inside an iframe is in a separate document our extension cannot reach. ` +
             `Look for a button that opens the iframe content in a new window/tab, or ask the user to open it manually.`
    };
  }
  try {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus();
    el.click();
    return { ok: true, tag: el.tagName.toLowerCase() };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function typeIntoRef(ref, text, submit) {
  const el = getByRef(ref);
  if (!el) return { ok: false, error: `No element with ref ${ref}` };
  try {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus();
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const proto = el.tagName === 'INPUT'
        ? window.HTMLInputElement.prototype
        : window.HTMLTextAreaElement.prototype;
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

function pressKey(key) {
  const target = document.activeElement || document.body;
  const events = ['keydown', 'keypress', 'keyup'];
  for (const t of events) {
    target.dispatchEvent(new KeyboardEvent(t, { key, bubbles: true, cancelable: true }));
  }
  return { ok: true };
}

function scroll(direction, amount) {
  const a = amount || 600;
  const delta = direction === 'up' ? -a : a;
  window.scrollBy({ top: delta, behavior: 'instant' });
  return { ok: true, scrollY: window.scrollY };
}

function extractBySelector(selector, attr, limit) {
  try {
    const nodes = Array.from(document.querySelectorAll(selector)).slice(0, limit || 20);
    const values = nodes.map((el) => {
      if (!attr) return (el.innerText || '').trim().slice(0, 400);
      // Properties that must be read off the element, not as HTML attribute
      const lower = String(attr).toLowerCase();
      if (lower === 'innerhtml') return (el.innerHTML || '').slice(0, 4000);
      if (lower === 'outerhtml') return (el.outerHTML || '').slice(0, 4000);
      if (lower === 'textcontent') return (el.textContent || '').slice(0, 400);
      if (lower === 'value') {
        if ('value' in el) return String(el.value || '').slice(0, 400);
      }
      return (el.getAttribute(attr) || '').slice(0, 400);
    });
    return { ok: true, count: values.length, values };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function clickByText(text, opts) {
  if (!text) return { ok: false, error: 'text required' };
  const matchExact = !!(opts && opts.exact);
  const tag = (opts && opts.tag) || '';
  const lower = text.toLowerCase();
  const selector = tag ? `a, button, [role="button"], ${tag}` : 'a, button, [role="button"], [role="link"], input[type="submit"], input[type="button"]';
  let candidates = Array.from(document.querySelectorAll(selector));
  // Filter to visible
  candidates = candidates.filter((el) => {
    if (!el.offsetParent && el.tagName !== 'BODY') return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = window.getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    return true;
  });
  // Score by text match
  const scored = candidates.map((el) => {
    const txt = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
    const tlower = txt.toLowerCase();
    let score = -1;
    if (matchExact) {
      if (tlower === lower) score = 100;
    } else {
      if (tlower === lower) score = 100;
      else if (tlower.includes(lower)) score = 80 - (tlower.length - lower.length) / 10;
      // Prefer buttons/links with exact aria-label
      if ((el.getAttribute('aria-label') || '').toLowerCase().includes(lower)) score = Math.max(score, 90);
    }
    return { el, txt, score };
  }).filter((c) => c.score >= 0).sort((a, b) => b.score - a.score);

  if (!scored.length) {
    return { ok: false, error: `No clickable element found with text containing "${text}". Visible candidates: ${candidates.slice(0, 5).map((c) => (c.innerText || c.value || '').trim().slice(0, 40)).join(' | ')}` };
  }
  const top = scored[0];
  const el = top.el;
  try {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus();
    el.click();
    return { ok: true, tag: el.tagName.toLowerCase(), text: top.txt.slice(0, 100), candidates: scored.slice(0, 3).map((s) => s.txt.slice(0, 60)) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'extractContent':
          sendResponse({ ok: true, ...extractContent() });
          break;
        case 'snapshot':
          sendResponse({ ok: true, url: location.href, title: document.title, elements: assignRefs(), iframes: listIframes() });
          break;
        case 'click':
          sendResponse(await clickRef(msg.ref));
          break;
        case 'type':
          sendResponse(await typeIntoRef(msg.ref, msg.text, msg.submit));
          break;
        case 'pressKey':
          sendResponse(pressKey(msg.key));
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

// Optional: a small badge to remind the user the extension is loaded.
// Disabled by default — comment in to enable.
(() => {
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
})();