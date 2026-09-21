# @plumbox/ui

The Plum phone apps' design system for `.plu` panels: the same tokens (colors, spacing, radii, type, motion)
as CSS custom properties, and eight framework-free web components. A panel built with it looks like the app
it runs inside, in light and dark, without a build step.

```html
<link rel="stylesheet" href="./vendor/plum-ui/tokens.css">
<script type="module" src="./vendor/plum-ui/plum-ui.js"></script>
<script src="/apps/runtime/plum-sdk.js"></script>

<body class="plum-page">
  <plum-top-bar title="Downloads" subtitle="im.plum.downloader · 0.2.11"></plum-top-bar>
  <plum-field label="Magnet or URL" placeholder="magnet:?xt=…"></plum-field>
  <plum-button variant="primary" block>Add download</plum-button>
  <plum-segmented value="all"><button value="all">All</button><button value="done">Done</button></plum-segmented>
  <plum-list header="Active">
    <plum-row title="ubuntu.iso" subtitle="2.1 GB · 4.2 MB/s" value="63%" chevron></plum-row>
  </plum-list>
  <plum-empty mark="no downloads" title="Nothing yet" subtitle="Paste a link above."></plum-empty>
  <plum-sheet id="opts" title="Options">…</plum-sheet>
</body>
```

Copy `src/tokens.css` and `src/plum-ui.js` into your bundle (a `.plu` is self-contained; there is no CDN on
a box), or install with npm and let your bundler copy them.

## Components

| tag | mirrors (iOS / Android) | attributes | events |
|---|---|---|---|
| `plum-top-bar` | navigation bar / `FrostedTopBar` | `title`, `subtitle`, `back`, `left`; slots `leading`/`actions` | `plum-back` |
| `plum-button` | `PlumButton` / `Buttons.kt` | `variant` = primary (default) · ghost · quiet · danger, `size="small"`, `block`, `disabled`, `loading`, `action` | `plum-action` |
| `plum-field` | `UnderlineField` | `label`, `placeholder`, `value`, `type`, `hint`, `error`, `disabled`, `aria-label`; slots `leading`/`trailing` | `plum-change`, `plum-commit`, `plum-submit` |
| `plum-segmented` | `SegmentedToggle` | `value`; children `<button value=…>` | `plum-change` |
| `plum-chip` | `FillChip` | `selected`, `toggle`, `tone` = live · review · reject, `value`, `disabled` | `plum-change` |
| `plum-list` + `plum-row` | `GroupedList` / `ListRow` | list: `header`, `flush`; row: `title`, `subtitle`, `value`, `chevron`, `action`, `disabled`, `no-lead`; slots `leading`/`trailing` | `plum-action` |
| `plum-sheet` | `PlumBottomSheet` | `open`, `title`; methods `open()` / `close()` (close is idempotent); Esc and scrim close | `plum-close` |
| `plum-empty` | `EditorialEmpty` | `mark`, `title`, `subtitle`; default slot for a button | — |

The input a `plum-field` wraps lives in the shadow root, so it takes its accessible name from
`aria-label`, else `label`, else `placeholder` — set one of the three.

## Theme

`tokens.css` reads `html[data-theme="dark"|"light"]`, which the Plum SDK runtime keeps in sync with the host
(`plum.app.theme()` / `onThemeChange`), and falls back to `prefers-color-scheme`. `followHostTheme()` from
`plum-ui.js` does the same wiring explicitly for a page that loads the SDK late.

## Tokens

`--plum-bg`, `--plum-surface`, `--plum-surface2`, `--plum-ink`, `--plum-ink-soft`, `--plum-muted`, `--plum-faint`,
`--plum-line`, `--plum-line-strong`, `--plum-fill`, `--plum-ph{,2,3}`, `--plum-live`, `--plum-review`, `--plum-reject`,
`--plum-glass`, `--plum-glass-line`, `--plum-scrim`; `--plum-inset-h` 16, `--plum-min-tap` 44, `--plum-button-h` 52,
`--plum-search-pill-h` 38, `--plum-segment-h` 34, radii `--plum-r-card` 14 / `--plum-r-card-l` 18 / `--plum-r-sheet` 22;
motion `--plum-ease-standard`, `--plum-ease-smooth`, `--plum-dur-*`; type `--plum-font`, `--plum-text-*`.
Values are the phone apps' (`PlumColors.swift`, `PlumMetrics.swift`); change them there first.
