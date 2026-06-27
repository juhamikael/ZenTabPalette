# Tab Filter — Zen Browser userChrome.js mod

A search/organize dialog for Zen Browser tabs. Open via a **toolbar button**
(Customize → "Filter Tabs"), **Ctrl+Shift+F**, or **right-click a tab → "🔍 Tab Filter"**.
Search (smart-query operators or regex), find duplicates, search across workspaces, jump
to a tab, and bulk **move** the selection into a Zen Folder / Tab Group / Workspace,
**bookmark** it, **close** it, or native-**multi-select** it. Per-row right-click menu and
a settings view (⚙). See `README.md` (next to this file) for the full user-facing feature
list and install steps; this file is the architecture/contribution reference.

Reminder: this is loaded by **fx-autoconfig** — it does NOT run in Zen's **Troubleshoot /
Safe Mode** (the log prints `[ZenMods]: Mods disabled by user or in safe mode`). Test in a
normal window.

## Files (both live here, next to each other)

| File | Purpose |
|------|---------|
| `tab-filter.uc.js` | All logic. Loaded automatically by fx-autoconfig (it ends in `.uc.js`). |
| `tab-filter.css` | All styling (class-based). Loaded by the JS via `<link href="chrome://userscripts/content/tab-filter.css">` — the `chrome/JS` dir is mapped to that scheme by fx-autoconfig's `../utils/chrome.manifest`. |

There is **no build step**. Edit the files directly.

## Architecture (`tab-filter.uc.js`)

Single IIFE wrapping ES classes + a few bootstrap functions:

- **`createEl(tag, props, children)`** — tiny hyperscript helper (JSX-without-build).
  `class`, `on*` handlers, a `ref: el => ...` callback, else property/attribute.
  `null`/`false` children are skipped, so `cond ? createEl(...) : null` works.
- **`ZenTabService`** (static) — the ONLY place that touches Zen/Firefox internals
  (`gBrowser`, `gZenWorkspaces`, `gZenFolders`, the tab/folder DOM). Queries
  (`getMatchingTabs`, `getDuplicateTabs`, `getFolders/getGroups/getWorkspaces`,
  `baseDomainOf`, `scopePredicate`) and actions (`createFolder`, `moveToFolder`,
  `moveToGroup`, `moveToWorkspace`, `multiSelect`, `closeTabs`, `jumpToTab`).
- **`PatternStore`** (static) — saved search patterns, persisted in a pref.
- **`Settings`** (static) — typed getters over prefs `extensions.uctabfilter.*`
  (`searchAllWorkspaces`, `emptyShowsAll`, `defaultSearchInFolders`, `shortcut`).
- **`FilterDialog`** — one instance per open (`new FilterDialog().open(initialQuery)`).
  Builds its DOM with `createEl` (refs captured into `#ui`), holds transient state
  in private `#` fields. The results list is **virtualized** (`#filtered` = full data,
  only a window of rows is mounted; geometry constants `ROW_STEP`/`ROW_BUFFER`).
  Selection is a persistent `#selected` Set (survives changing the search within one
  open). A ⚙ gear swaps `#ui.tabsPanel` ↔ `#ui.settingsPanel`.
- **bootstrap** — `registerToolbarButton` (CustomizableUI, app-wide), `initWindow`
  (per window: inject stylesheet, bind shortcut, add the context submenu), run on
  `browser-delayed-startup-finished`.

The list re-render is explicit (`#rebuildList` / `#renderWindow`) — this is plain
chrome JS, **not React**; there is no reactive state.

## Conventions

- **Styling lives in CSS, not JS.** JS only sets `className` (and state classes like
  `uc-tf-row--active`, `uc-tf-rebtn--on`, `uc-tf-search--error`) or `.hidden`. The one
  exception is the virtualized row's `transform: translateY(...)` (mechanical layout).
- **Names are spelled out** (no `el`/`q`/`cb` abbreviations); methods/classes carry JSDoc
  with `@typedef`s. Add `// @ts-check` on line 1 for editor type-checking.
- **Errors aren't swallowed silently** — `catch (e) { debug(e); }`. `debug()` only logs
  when pref `extensions.uctabfilter.debug` is true (off by default).
- **A11y**: dialog has `role="dialog"`/`aria-modal`, a Tab focus-trap, focus restore on
  close, aria-labels on icon-only controls. List rows are NOT in the Tab order (use
  ↑/↓ + Enter; Ctrl+Enter toggles); that's deliberate (hundreds of rows otherwise).
- **Zen APIs are verified from source**, not guessed. The reference is the browser's
  `omni.ja` (`browser/omni.ja` in the install dir → unzip → `chrome/browser/content/
  browser/zen-components/ZenFolders.mjs`, `modules/zen/ZenSpaceManager.mjs`). Verified
  facts: `gZenWorkspaces.moveTabsToWorkspace` is synchronous; tab/folder workspace is
  the `zen-workspace-id` attribute (absent = active workspace); context-menu tab is
  `window.TabContextMenu.contextTab`.

## Editing & testing

1. Run `node --check "tab-filter.uc.js"` for syntax. It does not catch runtime errors, so
   a green check alone is not enough.
2. Scan for accidental find/replace damage:
   `grep -nE "[A-Za-z]createEl\(|Witcreate" tab-filter.uc.js` (should be empty). Avoid
   `replace_all` on short substrings that can appear inside larger tokens, and prefer
   non-emoji anchors when editing (emoji can break exact string matching).
3. Reload the mod: `about:support` → "Clear startup cache…" (a plain restart is not
   enough — fx-autoconfig caches scripts).
4. Smoke-test in the browser: open Browser Console (`Ctrl+Shift+J`), confirm no
   `[tab-filter]` / `TypeError`; open the dialog via the toolbar button, `Ctrl+Shift+F`,
   and the tab right-click; exercise search/regex/duplicates/folders, move/close/
   multi-select, the settings view, and scrolling a large (empty-query) list.

## Settings & prefs (about:config, all `extensions.uctabfilter.*`)

`searchAllWorkspaces` (bool) · `emptyShowsAll` (bool) · `defaultSearchInFolders` (bool)
· `shortcut` (string, e.g. `Ctrl+Shift+F`) · `patterns` (JSON, saved searches) ·
`debug` (bool, enables `console.debug` logging).

## Limitations

- userChrome.js cannot be packaged as a "Zen Mod" (those are CSS+prefs only). To share,
  publish the two files to a repo with fx-autoconfig install instructions.
- The regex guard (length cap + nested-quantifier block) reduces but does not eliminate
  ReDoS — JS has no in-thread regex timeout.
- The install-dir files (`config.js`, `defaults/pref/config-prefs.js` under the Zen
  program folder) are part of fx-autoconfig and may be wiped by a Zen update — re-copy
  them (e.g. via `gsudo`) if the mod stops loading after an update.
