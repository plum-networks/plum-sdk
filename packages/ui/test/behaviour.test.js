// Behaviour of the three things the first real consumer (plum-plu-downloader)
// needed and did not get: a leading slot on the top bar, an accessible name on
// the field's shadow input, and a close() that does not re-enter.
//
// There is no jsdom here (ui.test.js explains why: rendering is a browser
// concern), so this file installs a small DOM stub that is faithful about the
// parts these fixes touch — attributes drive attributeChangedCallback the way
// the browser does, and dispatched events are recorded.
import { describe, expect, it, beforeEach } from 'vitest';

function shadowNode() {
  const attrs = new Map();
  return {
    textContent: '',
    value: '',
    type: '',
    disabled: false,
    placeholder: '',
    attrs,
    addEventListener() {},
    setAttribute: (n, v) => attrs.set(n, String(v)),
    getAttribute: (n) => (attrs.has(n) ? attrs.get(n) : null),
    removeAttribute: (n) => attrs.delete(n),
  };
}

function installDom() {
  globalThis.HTMLElement = class {
    constructor() {
      this._attrs = new Map();
      this._nodes = new Map();
      this.events = [];
    }
    attachShadow() {
      this.shadowRoot = {
        innerHTML: '',
        querySelector: (sel) => {
          if (!this._nodes.has(sel)) this._nodes.set(sel, shadowNode());
          return this._nodes.get(sel);
        },
      };
      return this.shadowRoot;
    }
    // The browser calls attributeChangedCallback for observed attributes; the
    // components rely on that, so the stub does it too.
    _changed(name, old, val) {
      const obs = this.constructor.observedAttributes || [];
      if (obs.includes(name) && typeof this.attributeChangedCallback === 'function') {
        this.attributeChangedCallback(name, old, val);
      }
    }
    setAttribute(n, v) {
      const old = this._attrs.has(n) ? this._attrs.get(n) : null;
      this._attrs.set(n, String(v));
      this._changed(n, old, String(v));
    }
    getAttribute(n) { return this._attrs.has(n) ? this._attrs.get(n) : null; }
    hasAttribute(n) { return this._attrs.has(n); }
    removeAttribute(n) {
      if (!this._attrs.has(n)) return;
      const old = this._attrs.get(n);
      this._attrs.delete(n);
      this._changed(n, old, null);
    }
    addEventListener() {}
    removeEventListener() {}
    dispatchEvent(e) { this.events.push(e); return true; }
  };
  globalThis.customElements = { get: () => undefined, define: () => {} };
  globalThis.window = globalThis;
  globalThis.CustomEvent = class {
    constructor(type, init) { this.type = type; Object.assign(this, init || {}); }
  };
}

let mod;
beforeEach(async () => {
  installDom();
  mod = await import('../src/plum-ui.js');
});

describe('plum-top-bar', () => {
  it('has a leading slot that leaves no box when unused', () => {
    const bar = new mod.PlumTopBar();
    expect(bar.shadowRoot.innerHTML).toContain('<slot name="leading"></slot>');
    // display:contents, so an unused slot does not eat the .bar flex gap and
    // indent the title (an empty wrapper span would).
    expect(bar.shadowRoot.innerHTML).toMatch(/\.lead \{ display: contents; \}/);
    expect(bar.shadowRoot.innerHTML).toContain('part="leading"');
  });
});

describe('plum-field', () => {
  it('names its shadow input from aria-label, else label, else placeholder', () => {
    const f = new mod.PlumField();
    const input = f.shadowRoot.querySelector('input');

    f.setAttribute('placeholder', 'magnet:?xt=…');
    expect(input.getAttribute('aria-label')).toBe('magnet:?xt=…');

    f.setAttribute('label', 'Magnet or URL');
    expect(input.getAttribute('aria-label')).toBe('Magnet or URL');

    f.setAttribute('aria-label', 'Save folder');
    expect(input.getAttribute('aria-label')).toBe('Save folder');

    // and it goes away again rather than going stale
    f.removeAttribute('aria-label');
    f.removeAttribute('label');
    f.removeAttribute('placeholder');
    expect(input.getAttribute('aria-label')).toBe(null);
  });
});

describe('plum-sheet', () => {
  it('close() fires plum-close once and only when it was open', () => {
    const s = new mod.PlumSheet();

    s.close(); // never opened
    expect(s.events).toEqual([]);

    s.open();
    expect(s.hasAttribute('open')).toBe(true);

    s.close();
    s.close(); // e.g. the scrim closed it, then Cancel called close() again
    expect(s.events.map((e) => e.type)).toEqual(['plum-close']);
    expect(s.hasAttribute('open')).toBe(false);
  });
});
