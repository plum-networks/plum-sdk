// The component module in a bare Node context: a stub HTMLElement /
// customElements is enough to prove every tag registers, the exports are
// there and the tokens cover light + dark. Rendering is a browser concern.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = new URL('.', import.meta.url).pathname;

describe('@plumbox/ui', () => {
  it('registers the nine elements and exports them', async () => {
    const defined = new Map();
    globalThis.HTMLElement = class {};
    globalThis.customElements = { get: (t) => defined.get(t), define: (t, c) => defined.set(t, c) };
    globalThis.window = globalThis;
    globalThis.CustomEvent = class {};
    const mod = await import('../src/plum-ui.js');
    expect(mod.components).toEqual(['plum-button', 'plum-top-bar', 'plum-list', 'plum-row', 'plum-sheet', 'plum-segmented', 'plum-chip', 'plum-field', 'plum-empty']);
    for (const tag of mod.components) expect(defined.has(tag), tag).toBe(true);
    expect(typeof mod.followHostTheme).toBe('function');
    expect(mod.followHostTheme()()).toBeUndefined(); // no runtime → no-op unsubscribe
  });

  it('tokens cover light and dark with the apps\' values', () => {
    const css = readFileSync(join(here, '..', 'src', 'tokens.css'), 'utf8');
    for (const t of ['--plum-bg', '--plum-surface', '--plum-surface2', '--plum-ink', '--plum-muted', '--plum-line', '--plum-live', '--plum-review', '--plum-reject', '--plum-min-tap', '--plum-button-h', '--plum-r-card', '--plum-ease-standard', '--plum-font']) {
      expect(css.includes(t + ':'), t).toBe(true);
    }
    // PlumColors.swift: ink 0x101012 / 0xF4F4F5, bg 0xFCFCFC / 0x0A0A0B
    expect(css).toMatch(/:root \{[^}]*--plum-ink: #101012/);
    expect(css).toMatch(/html\[data-theme="dark"\] \{[^}]*--plum-ink: #F4F4F5/);
    expect(css).toMatch(/:root \{[^}]*--plum-bg: #FCFCFC/);
    expect(css).toMatch(/html\[data-theme="dark"\] \{[^}]*--plum-bg: #0A0A0B/);
    // PlumMetrics.swift: buttonH 52, minTap 44, segmentH 34
    expect(css).toContain('--plum-button-h: 52px');
    expect(css).toContain('--plum-min-tap: 44px');
    expect(css).toContain('--plum-segment-h: 34px');
  });
});
