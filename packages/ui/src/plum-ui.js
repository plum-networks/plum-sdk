/*
 * @plumbox/ui — eight framework-free web components in the Plum phone apps'
 * design language (tokens.css). Import once; use as HTML tags:
 *
 *   <script type="module" src="./node_modules/@plumbox/ui/src/plum-ui.js"></script>
 *   <link rel="stylesheet" href="./node_modules/@plumbox/ui/src/tokens.css">
 *
 *   <plum-top-bar title="Downloads" back></plum-top-bar>
 *   <plum-button variant="primary">Add</plum-button>
 *   <plum-field label="Magnet link" placeholder="magnet:?xt=…"></plum-field>
 *   <plum-segmented value="all"><button value="all">All</button><button value="done">Done</button></plum-segmented>
 *   <plum-chip selected>Active</plum-chip>
 *   <plum-list><plum-row title="report.pdf" subtitle="2.1 MB" chevron></plum-row></plum-list>
 *   <plum-sheet open title="Options">…</plum-sheet>
 *   <plum-empty mark="no downloads" title="Nothing yet" subtitle="Paste a link above"></plum-empty>
 *
 * Every element uses shadow DOM with the shared tokens (custom properties
 * inherit through shadow roots), emits plain DOM events (`plum-change`,
 * `plum-back`, `plum-close`, `plum-action`) and mirrors what the SwiftUI /
 * Compose components of the same name do — one design, three surfaces.
 */
const TAG_PREFIX = "plum-";

const base = `
  :host { box-sizing: border-box; font: var(--plum-text-body); color: var(--plum-ink); }
  :host([hidden]) { display: none !important; }
  *, *::before, *::after { box-sizing: inherit; }
  button, input { font: inherit; color: inherit; }
`;

function define(name, cls) {
  const tag = TAG_PREFIX + name;
  if (typeof customElements !== "undefined" && !customElements.get(tag)) customElements.define(tag, cls);
}

function html(strings, ...values) {
  return strings.reduce((out, s, i) => out + s + (i < values.length ? values[i] : ""), "");
}

function emit(el, name, detail) {
  el.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
}

class PlumElement extends HTMLElement {
  constructor(css, markup) {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${base}${css}</style>${markup}`;
  }
  $(sel) { return this.shadowRoot.querySelector(sel); }
}

/* ---------------------------------------------------------------- button */
class PlumButton extends PlumElement {
  static get observedAttributes() { return ["variant", "disabled", "loading", "size"]; }
  constructor() {
    super(html`
      :host { display: inline-block; }
      :host([block]) { display: block; }
      button {
        display: inline-flex; align-items: center; justify-content: center; gap: 8px;
        width: 100%; min-height: var(--plum-button-h); padding: 0 18px;
        border-radius: 12px; border: var(--plum-hairline) solid var(--plum-ink);
        background: var(--plum-primary); color: var(--plum-on-primary);
        font-weight: 600; font-size: 15px; cursor: pointer;
        transition: opacity var(--plum-dur-screen) var(--plum-ease-standard), transform var(--plum-dur-screen) var(--plum-ease-standard);
      }
      :host([size="small"]) button { min-height: var(--plum-segment-h); padding: 0 12px; font-size: 13px; border-radius: 10px; }
      :host([variant="ghost"]) button { background: transparent; color: var(--plum-ink); border-color: var(--plum-line-strong); }
      :host([variant="quiet"]) button { background: var(--plum-surface2); color: var(--plum-ink); border-color: transparent; }
      :host([variant="danger"]) button { background: var(--plum-reject); border-color: var(--plum-reject); color: #fff; }
      button:active { transform: scale(0.985); opacity: 0.92; }
      button:disabled { background: var(--plum-surface2); border-color: var(--plum-line); color: var(--plum-muted); cursor: not-allowed; transform: none; }
      .spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: s 0.8s linear infinite; display: none; }
      :host([loading]) .spin { display: inline-block; }
      @keyframes s { to { transform: rotate(360deg); } }
    `, `<button part="button" type="button"><span class="spin" aria-hidden="true"></span><slot></slot></button>`);
    this.$("button").addEventListener("click", (e) => {
      if (this.hasAttribute("disabled") || this.hasAttribute("loading")) { e.stopPropagation(); return; }
      emit(this, "plum-action", { action: this.getAttribute("action") || "" });
    });
  }
  attributeChangedCallback() {
    const b = this.$("button");
    b.disabled = this.hasAttribute("disabled") || this.hasAttribute("loading");
    b.setAttribute("aria-busy", this.hasAttribute("loading") ? "true" : "false");
  }
}
define("button", PlumButton);

/* -------------------------------------------------------------- top bar */
class PlumTopBar extends PlumElement {
  static get observedAttributes() { return ["title", "subtitle", "back"]; }
  constructor() {
    super(html`
      :host { display: block; position: sticky; top: 0; z-index: 5; background: var(--plum-glass); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); border-bottom: var(--plum-hairline) solid var(--plum-glass-line); }
      .bar { display: flex; align-items: center; min-height: var(--plum-nav-bar-h); padding: 0 8px; gap: 6px; }
      .back { display: none; width: var(--plum-min-tap); height: var(--plum-min-tap); border: 0; background: none; cursor: pointer; border-radius: 50%; align-items: center; justify-content: center; }
      :host([back]) .back { display: inline-flex; }
      .back svg { width: 20px; height: 20px; }
      /* display:contents so an unused leading slot leaves no box — an empty
         wrapper would still take the .bar flex gap and indent the title. */
      .lead { display: contents; }
      ::slotted([slot="leading"]) { display: inline-flex; align-items: center; margin-left: 6px; color: var(--plum-faint); }
      .titles { flex: 1; min-width: 0; padding: 0 8px; text-align: center; }
      :host([back]) .titles, :host([left]) .titles { text-align: left; padding-left: 0; }
      :host([left]) .lead + .titles { padding-left: 8px; }
      .t { font: var(--plum-text-title); font-size: 16.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .s { font: var(--plum-text-mono); color: var(--plum-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .s:empty { display: none; }
      .actions { display: flex; align-items: center; gap: 2px; }
      /* Phone app: the shell's own row already shows the title (it reads
         document.title), so the bar keeps only its buttons — and goes away
         when it has none, instead of a second, empty header. */
      :host([shell]) { background: transparent; backdrop-filter: none; -webkit-backdrop-filter: none; border-bottom-color: transparent; }
      :host([shell]) .titles { visibility: hidden; }
      :host([shell][bare]) { display: none; }
    `, `
      <div class="bar" part="bar">
        <button class="back" part="back" aria-label="Back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>
        <span class="lead" part="leading"><slot name="leading"></slot></span>
        <div class="titles"><div class="t" part="title"></div><div class="s" part="subtitle"></div></div>
        <div class="actions"><slot name="actions"></slot></div>
      </div>`);
    this.$(".back").addEventListener("click", () => emit(this, "plum-back"));
    this.shadowRoot.querySelectorAll("slot").forEach((sl) => sl.addEventListener("slotchange", () => this._bare()));
  }
  connectedCallback() {
    const inShell = typeof document !== "undefined" && !!document.documentElement &&
      document.documentElement.hasAttribute("data-plum-shell");
    this.toggleAttribute("shell", inShell);
    this._bare();
    this._title();
  }
  attributeChangedCallback() {
    this.$(".t").textContent = this.getAttribute("title") || "";
    this.$(".s").textContent = this.getAttribute("subtitle") || "";
    this._bare();
    this._title();
  }
  // Nothing left to show once the title moves to the shell: no back button
  // and nothing slotted.
  _bare() {
    const slotted = Array.from(this.shadowRoot.querySelectorAll("slot")).some((sl) => sl.assignedNodes({ flatten: true }).some((n) => n.nodeType === 1));
    this.toggleAttribute("bare", !this.hasAttribute("back") && !slotted);
  }
  // The shell titles its row from document.title.
  _title() {
    const t = this.getAttribute("title");
    if (this.hasAttribute("shell") && t && typeof document !== "undefined") document.title = t;
  }
}
define("top-bar", PlumTopBar);

/* ------------------------------------------------------- list + row */
class PlumList extends PlumElement {
  constructor() {
    super(html`
      :host { display: block; background: var(--plum-surface); border: var(--plum-hairline) solid var(--plum-line); border-radius: var(--plum-r-card); overflow: hidden; margin: 0 var(--plum-inset-h) var(--plum-group-gap); }
      :host([flush]) { margin: 0; border-radius: 0; border-left: 0; border-right: 0; }
      .h { font: var(--plum-text-small); color: var(--plum-muted); text-transform: uppercase; letter-spacing: 0.04em; padding: 10px var(--plum-card-pad-h) 6px; }
      .h:empty { display: none; }
      ::slotted(plum-row:not(:last-child)) { --plum-row-divider: block; }
    `, `<div class="h" part="header"></div><slot></slot>`);
  }
  static get observedAttributes() { return ["header"]; }
  attributeChangedCallback() { this.$(".h").textContent = this.getAttribute("header") || ""; }
}
define("list", PlumList);

class PlumRow extends PlumElement {
  static get observedAttributes() { return ["title", "subtitle", "value", "chevron", "disabled"]; }
  constructor() {
    super(html`
      :host { display: block; position: relative; }
      .r { display: flex; align-items: center; gap: 12px; min-height: var(--plum-row-min); padding: 8px var(--plum-card-pad-h); cursor: pointer; }
      :host([disabled]) .r { opacity: 0.5; cursor: default; }
      :host(:not([chevron]):not([interactive])) .r { cursor: default; }
      .r:active { background: var(--plum-fill); }
      .lead ::slotted(*) { width: var(--plum-icon-tile); height: var(--plum-icon-tile); border-radius: var(--plum-r-icon-tile); }
      .lead:empty { display: none; }
      .body { flex: 1; min-width: 0; }
      .t { font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .s { font: var(--plum-text-small); color: var(--plum-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .s:empty { display: none; }
      .v { color: var(--plum-muted); font-size: 14px; white-space: nowrap; }
      .v:empty { display: none; }
      .chev { display: none; color: var(--plum-faint); }
      :host([chevron]) .chev { display: block; }
      .chev svg { width: 16px; height: 16px; }
      .div { display: var(--plum-row-divider, none); position: absolute; left: var(--plum-divider-inset); right: 0; bottom: 0; height: var(--plum-hairline); background: var(--plum-line); }
      :host([no-lead]) .div { left: var(--plum-card-pad-h); }
    `, `
      <div class="r" part="row">
        <span class="lead"><slot name="leading"></slot></span>
        <div class="body"><div class="t" part="title"></div><div class="s" part="subtitle"></div><slot></slot></div>
        <span class="v" part="value"></span>
        <slot name="trailing"></slot>
        <span class="chev" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span>
      </div><div class="div"></div>`);
    this.$(".r").addEventListener("click", () => {
      if (this.hasAttribute("disabled")) return;
      emit(this, "plum-action", { action: this.getAttribute("action") || "", value: this.getAttribute("value") || "" });
    });
  }
  attributeChangedCallback() {
    this.$(".t").textContent = this.getAttribute("title") || "";
    this.$(".s").textContent = this.getAttribute("subtitle") || "";
    this.$(".v").textContent = this.getAttribute("value") || "";
  }
}
define("row", PlumRow);

/* ---------------------------------------------------------------- sheet */
class PlumSheet extends PlumElement {
  static get observedAttributes() { return ["open", "title"]; }
  constructor() {
    super(html`
      :host { display: none; position: fixed; inset: 0; z-index: 50; }
      :host([open]) { display: block; }
      .scrim { position: absolute; inset: 0; background: var(--plum-scrim); animation: fade var(--plum-dur-screen) var(--plum-ease-standard); }
      .card { position: absolute; left: 0; right: 0; bottom: 0; max-height: 88vh; overflow: auto; background: var(--plum-surface); border-radius: var(--plum-r-sheet) var(--plum-r-sheet) 0 0; box-shadow: var(--plum-shadow-sheet); padding: 8px var(--plum-inset-h) calc(var(--plum-inset-h) + env(safe-area-inset-bottom, 0px)); animation: up var(--plum-dur-sheet) var(--plum-ease-smooth); }
      .grab { width: 36px; height: 5px; border-radius: 3px; background: var(--plum-ph2); margin: 4px auto 12px; }
      .t { font: var(--plum-text-title); margin: 0 0 12px; }
      .t:empty { display: none; }
      @keyframes fade { from { opacity: 0; } }
      @keyframes up { from { transform: translateY(24px); opacity: 0; } }
      @media (min-width: 640px) { .card { left: 50%; right: auto; width: 480px; transform: translateX(-50%); bottom: 24px; border-radius: var(--plum-r-card-l); } }
    `, `<div class="scrim" part="scrim"></div><div class="card" part="card" role="dialog" aria-modal="true"><div class="grab" aria-hidden="true"></div><h2 class="t" part="title"></h2><slot></slot></div>`);
    this.$(".scrim").addEventListener("click", () => this.close());
    this._onKey = (e) => { if (e.key === "Escape" && this.hasAttribute("open")) this.close(); };
  }
  connectedCallback() { window.addEventListener("keydown", this._onKey); }
  disconnectedCallback() { window.removeEventListener("keydown", this._onKey); }
  attributeChangedCallback(name) {
    if (name === "title") this.$(".t").textContent = this.getAttribute("title") || "";
  }
  open() { this.setAttribute("open", ""); }
  // Idempotent: a consumer that cleans up on `plum-close` and calls close()
  // from its own Cancel button would otherwise re-enter (and the scrim, Esc
  // and Cancel would each fire a second, spurious close).
  close() {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    emit(this, "plum-close");
  }
}
define("sheet", PlumSheet);

/* ------------------------------------------------------------ segmented */
class PlumSegmented extends PlumElement {
  static get observedAttributes() { return ["value"]; }
  constructor() {
    super(html`
      :host { display: inline-flex; padding: 2px; background: var(--plum-surface2); border-radius: 10px; height: var(--plum-segment-h); }
      ::slotted(button) { border: 0; background: transparent; color: var(--plum-muted); border-radius: 8px; padding: 0 12px; font-size: 13px; font-weight: 600; cursor: pointer; }
      ::slotted(button[aria-pressed="true"]) { background: var(--plum-surface); color: var(--plum-ink); box-shadow: var(--plum-shadow-segment); }
    `, `<slot></slot>`);
    this.addEventListener("click", (e) => {
      const b = e.target.closest ? e.target.closest("button") : null;
      if (!b || !this.contains(b)) return;
      const v = b.getAttribute("value") || b.textContent.trim();
      if (v === this.getAttribute("value")) return;
      this.setAttribute("value", v);
      emit(this, "plum-change", { value: v });
    });
  }
  connectedCallback() { this._sync(); }
  attributeChangedCallback() { this._sync(); }
  _sync() {
    const v = this.getAttribute("value");
    this.querySelectorAll("button").forEach((b) => {
      const bv = b.getAttribute("value") || b.textContent.trim();
      b.setAttribute("aria-pressed", bv === v ? "true" : "false");
    });
  }
  get value() { return this.getAttribute("value") || ""; }
  set value(v) { this.setAttribute("value", v); }
}
define("segmented", PlumSegmented);

/* ----------------------------------------------------------------- chip */
class PlumChip extends PlumElement {
  static get observedAttributes() { return ["selected", "disabled"]; }
  constructor() {
    super(html`
      :host { display: inline-block; }
      button { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border-radius: var(--plum-r-pill); border: var(--plum-hairline) solid var(--plum-line-strong); background: var(--plum-surface); color: var(--plum-ink); font-size: 13px; font-weight: 500; cursor: pointer; }
      :host([selected]) button { background: var(--plum-ink); color: var(--plum-bg); border-color: var(--plum-ink); }
      :host([tone="live"]) button { color: var(--plum-live); border-color: transparent; background: color-mix(in srgb, var(--plum-live) 12%, transparent); }
      :host([tone="review"]) button { color: var(--plum-review); border-color: transparent; background: color-mix(in srgb, var(--plum-review) 14%, transparent); }
      :host([tone="reject"]) button { color: var(--plum-reject); border-color: transparent; background: color-mix(in srgb, var(--plum-reject) 12%, transparent); }
      button:disabled { opacity: 0.5; cursor: default; }
    `, `<button part="chip" type="button"><slot></slot></button>`);
    this.$("button").addEventListener("click", () => {
      if (this.hasAttribute("disabled")) return;
      if (this.hasAttribute("toggle")) this.toggleAttribute("selected");
      emit(this, "plum-change", { selected: this.hasAttribute("selected"), value: this.getAttribute("value") || "" });
    });
  }
  attributeChangedCallback() {
    const b = this.$("button");
    b.disabled = this.hasAttribute("disabled");
    b.setAttribute("aria-pressed", this.hasAttribute("selected") ? "true" : "false");
  }
}
define("chip", PlumChip);

/* ---------------------------------------------------------------- field */
class PlumField extends PlumElement {
  static get observedAttributes() { return ["label", "placeholder", "value", "type", "error", "hint", "disabled", "aria-label"]; }
  static get formAssociated() { return true; }
  constructor() {
    super(html`
      :host { display: block; margin: 0 0 14px; }
      label { display: block; font: var(--plum-text-small); color: var(--plum-muted); margin: 0 0 6px; }
      label:empty { display: none; }
      .box { display: flex; align-items: center; gap: 8px; min-height: var(--plum-min-tap); padding: 0 12px; border-radius: 12px; background: var(--plum-surface2); border: var(--plum-hairline) solid transparent; }
      .box:focus-within { border-color: var(--plum-ink); background: var(--plum-surface); }
      :host([error]) .box { border-color: var(--plum-reject); }
      input { flex: 1; min-width: 0; border: 0; background: transparent; outline: none; font-size: 15px; height: 100%; }
      input::placeholder { color: var(--plum-faint); }
      .msg { font: var(--plum-text-small); margin: 6px 0 0; color: var(--plum-muted); }
      .msg:empty { display: none; }
      :host([error]) .msg { color: var(--plum-reject); }
    `, `<label part="label"></label><div class="box" part="box"><slot name="leading"></slot><input part="input"><slot name="trailing"></slot></div><div class="msg" part="message"></div>`);
    const input = this.$("input");
    input.addEventListener("input", () => { this._value = input.value; emit(this, "plum-change", { value: input.value }); });
    input.addEventListener("change", () => emit(this, "plum-commit", { value: input.value }));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") emit(this, "plum-submit", { value: input.value }); });
  }
  attributeChangedCallback(name) {
    const input = this.$("input");
    this.$("label").textContent = this.getAttribute("label") || "";
    input.placeholder = this.getAttribute("placeholder") || "";
    input.type = this.getAttribute("type") || "text";
    input.disabled = this.hasAttribute("disabled");
    if (name === "value") input.value = this.getAttribute("value") || "";
    this.$(".msg").textContent = this.getAttribute("error") || this.getAttribute("hint") || "";
    // The <label> is a sibling of the input and the input lives in the shadow
    // root, so nothing associates the two: without this the control is
    // unnamed to a screen reader even when a visible label is set. An explicit
    // aria-label wins, for the common one-line toolbar field that shows only a
    // placeholder.
    const name_ = this.getAttribute("aria-label") || this.getAttribute("label") || this.getAttribute("placeholder") || "";
    if (name_) input.setAttribute("aria-label", name_);
    else input.removeAttribute("aria-label");
  }
  get value() { return this.$("input").value; }
  set value(v) { this.$("input").value = v == null ? "" : String(v); }
  focus() { this.$("input").focus(); }
}
define("field", PlumField);

/* ----------------------------------------------------------- empty state */
class PlumEmpty extends PlumElement {
  static get observedAttributes() { return ["mark", "title", "subtitle"]; }
  constructor() {
    super(html`
      :host { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 48px var(--plum-inset-h); gap: 6px; }
      .mark { font: var(--plum-text-mono); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--plum-faint); margin-bottom: 8px; }
      .mark:empty { display: none; }
      .t { font: var(--plum-text-title); }
      .s { color: var(--plum-muted); max-width: 320px; }
      .s:empty { display: none; }
      .a { margin-top: 14px; }
    `, `<div class="mark" part="mark"></div><div class="t" part="title"></div><div class="s" part="subtitle"></div><div class="a"><slot></slot></div>`);
  }
  attributeChangedCallback() {
    this.$(".mark").textContent = this.getAttribute("mark") || "";
    this.$(".t").textContent = this.getAttribute("title") || "";
    this.$(".s").textContent = this.getAttribute("subtitle") || "";
  }
}
define("empty", PlumEmpty);

/* ---------------------------------------------------------------- theme */
/**
 * Follow the host's theme when the Plum SDK runtime is present: it keeps
 * document.documentElement.dataset.theme in sync, which tokens.css reads.
 * Without the runtime, tokens.css falls back to prefers-color-scheme.
 */
export function followHostTheme() {
  const plum = typeof window !== "undefined" ? window.plum : undefined;
  if (!plum || !plum.app || typeof plum.app.theme !== "function") return () => {};
  document.documentElement.dataset.theme = plum.app.theme();
  return plum.app.onThemeChange((t) => { document.documentElement.dataset.theme = t; });
}

export const components = ["button", "top-bar", "list", "row", "sheet", "segmented", "chip", "field", "empty"].map((n) => TAG_PREFIX + n);
export { PlumButton, PlumTopBar, PlumList, PlumRow, PlumSheet, PlumSegmented, PlumChip, PlumField, PlumEmpty };
