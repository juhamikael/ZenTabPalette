# ZenTabPalette - Zen Browser userChrome.js mod

Guidance for an AI assistant (Claude Code) working in this repo: how to work here, the
architecture, and the conventions. `README.md` is the user-facing documentation; this file
is the contributor/agent reference.

**What it is:** a search/organize "palette" for Zen Browser tabs. Opens via a toolbar
button (Customize -> "Filter Tabs"), **Ctrl+Shift+F**, or right-click a tab -> "Tab Filter".
Smart-query or regex search, duplicates, cross-workspace search, jump to a tab, and bulk
**move** the selection into a Zen Folder / Tab Group / Workspace, **bookmark**, **close**, or
native **multi-select**. Also a filter history and **settings / help / theme-editor** views.

The shipped files are named `tab-filter.*` (the project was later named ZenTabPalette; the
filenames and the `uctabfilter` / `uc-tf-` prefixes were kept to avoid a churny rename).

## How to work in this repo (read first)

- **You can't drive Zen.** You cannot restart the browser, reload the mod, or click the UI.
  After changes, **ask the user to reload and smoke-test**, and to paste the Browser Console
  output back. `node --check` is the most you can verify on your own.
- **Develop in this repo.** The user's Zen profile **symlinks** these files (via
  `dev/link-to-profile.ps1`), so edits here go live on the next Zen restart - no copying.
- **Commits: never add a `Co-Authored-By: Claude ...` trailer** (or any AI attribution) -
  the user has explicitly rejected it. Write plain commit messages.
- **Verify Zen/Firefox APIs from source, never guess** (see Conventions).
- **Docs use plain hyphens, not em dashes.**
- **Two loaders are supported** (see `theme.json`): **Sine** (the mod manager - its bootloader
  loads our `.uc.js` via `loadSubScript` with the browser window as target, and loads the CSS
  itself from `theme.json` `style.chrome`) and **fx-autoconfig** (manual - the script injects
  its own CSS from `chrome://userscripts/...`). `injectStylesheet` only runs under
  fx-autoconfig (gated on `window.UC_API`/`_ucUtils`) so it doesn't fight Sine. Sine has
  dropped fx-autoconfig support, and its bootloader replaces fx-autoconfig's `config.js`, so a
  given profile uses one or the other.
- It does NOT run in Zen's **Troubleshoot / Safe Mode** - have the user test in a normal window.

## Files

| File | Purpose |
|------|---------|
| `tab-filter.uc.js` | All logic. An IIFE `.uc.js`; loaded by fx-autoconfig OR Sine. |
| `tab-filter.css` | All styling (class-based). Under fx-autoconfig the JS injects it via `chrome://userscripts/content/tab-filter.css`; under Sine it is loaded from `theme.json` `style.chrome`. |
| `theme.json` | Sine manifest (`scripts` + `style.chrome` + metadata) so the mod installs via Sine. |
| `dev/link-to-profile.ps1` | Symlinks the files into the profile for live dev; auto-detects Sine vs fx-autoconfig. |

There is **no build step**. Edit the files directly; `dev/link-to-profile.ps1` symlinks them
into the profile for live development.

## Architecture (`tab-filter.uc.js`)

Single IIFE wrapping ES classes + a few bootstrap functions:

- **`createEl(tag, props, children)`** - tiny hyperscript helper (JSX-without-build).
  `class`, `on*` handlers, a `ref: el => ...` callback, else property/attribute.
  `null`/`false` children are skipped, so `cond ? createEl(...) : null` works.
- **`ZenTabService`** (static) - the ONLY place that touches Zen/Firefox internals
  (`gBrowser`, `gZenWorkspaces`, `gZenFolders`, the tab/folder DOM). Queries
  (`getMatchingTabs`, `getDuplicateTabs`, `getFolders/getGroups/getWorkspaces`,
  `baseDomainOf`, `scopePredicate`, `makeMatcher`) and actions (`createFolder`,
  `moveToFolder`, `moveToGroup`, `moveToWorkspace`, `multiSelect`, `closeTabs`,
  `bookmarkTabs`, `jumpToTab`, `findShortcutConflict`).
- **`PatternStore`** (static) - saved (starred) search patterns, persisted in a pref.
- **`HistoryStore`** (static) - auto-recorded recent searches, persisted in
  `extensions.uctabfilter.history` (newest first, deduped, capped). Distinct from
  PatternStore's manual stars.
- **`Settings`** (static) - typed getters over prefs `extensions.uctabfilter.*`:
  `searchAllWorkspaces`, `emptyShowsAll`, `defaultSearchInFolders`, `keepOpenAfterAction`,
  `showFilterHistory`, `historySize`, `themeAccent`, `shortcut`.
- **`FilterDialog`** - one instance per open (`new FilterDialog().open(initialQuery)`).
  Builds its DOM with `createEl` (refs captured into `#ui`), holds transient state in
  private `#` fields. The results list is **virtualized** (`#filtered` = full data, only a
  window of rows is mounted; geometry constants `ROW_STEP`/`ROW_BUFFER`). Selection is a
  persistent `#selected` Set (survives changing the search within one open). The title bar
  has **? help**, **gear settings**, and **close**; `#showView(view)` swaps the body between
  five panels: `tabs`, `settings`, `help`, `history`, `theme`. The single accent colour
  `--uc-tf-accent` is applied to the overlay in `#applyTheme` (buttons stay neutral).
- **bootstrap** - `registerToolbarButton` (CustomizableUI, app-wide), `initWindow`
  (per window: inject stylesheet, bind the global shortcut, add the context submenu), run on
  `browser-delayed-startup-finished`.

The list re-render is explicit (`#rebuildList` / `#renderWindow`) - this is plain chrome JS,
**not React**; there is no reactive state.

## Conventions

- **Styling lives in CSS, not JS.** JS only sets `className` (and state classes like
  `uc-tf-row--active`, `uc-tf-rebtn--on`, `uc-tf-search--error`) or `.hidden`. The one
  exception is the virtualized row's `transform: translateY(...)` (mechanical layout).
- **Names are spelled out** (no `el`/`q`/`cb` abbreviations); methods/classes carry JSDoc
  with `@typedef`s.
- **Errors aren't swallowed silently** - `catch (e) { debug(e); }`. `debug()` only logs when
  pref `extensions.uctabfilter.debug` is true (off by default).
- **A11y**: dialog has `role="dialog"`/`aria-modal`, a Tab focus-trap, focus restore on
  close, aria-labels on icon-only controls. List rows are NOT in the Tab order (use
  arrows + Enter; Ctrl+Enter toggles); that's deliberate (hundreds of rows otherwise).
- **Zen APIs are verified from source**, not guessed. The reference is the browser's
  `omni.ja` (`browser/omni.ja` in the Zen install dir -> unzip -> `chrome/browser/content/
  browser/zen-components/ZenFolders.mjs`, `modules/zen/ZenSpaceManager.mjs`). Re-verify when
  touching them, as Zen's internals shift between versions. Known facts: tab/folder
  workspace is the `zen-workspace-id` attribute (absent = active workspace); the
  context-menu tab is `window.TabContextMenu.contextTab`; never `importESModule` a Zen
  window-module (`chrome://browser/content/zen-components/*`) - they assign `window.*` at
  top level and throw in the system loader, so pull classes off live instances instead.

## Editing & testing

1. **(you)** Run `node --check "tab-filter.uc.js"` for syntax. It does NOT catch runtime
   errors, so a green check alone is not enough.
2. **(you)** Scan for accidental find/replace damage:
   `grep -nE "[A-Za-z]createEl\(|Witcreate" tab-filter.uc.js` (should be empty). Avoid
   `replace_all` on short substrings that can appear inside larger tokens, and prefer
   non-emoji anchors when editing (emoji can break exact string matching).
3. **(ask the user)** Reload: restart Zen (`about:profiles` -> "Restart normally...", or
   fully quit and reopen) - fx-autoconfig reads scripts fresh on each start. Only suggest
   clearing the startup cache (`about:support` -> "Clear startup cache...") if a change is
   stubborn, or after adding/renaming a file or changing the loader/manifest.
4. **(ask the user)** Smoke-test, since you can't: have them open the Browser Console
   (`Ctrl+Shift+J`), confirm no `[tab-filter]` / `TypeError`, then exercise the dialog
   (toolbar button, `Ctrl+Shift+F`, tab right-click; search/regex/duplicates/folders,
   move/close/multi-select, the settings/help/history/theme views, scrolling a large
   empty-query list). Pasting the console output back is ideal.

## Settings & prefs (about:config, all `extensions.uctabfilter.*`)

`searchAllWorkspaces` (bool) - `emptyShowsAll` (bool) - `defaultSearchInFolders` (bool) -
`keepOpenAfterAction` (bool) - `showFilterHistory` (bool) - `historySize` (int) -
`themeAccent` (string hex) -
`shortcut` (string, e.g. `Ctrl+Shift+F`) - `patterns` (JSON, saved searches) -
`history` (JSON, recent searches) - `debug` (bool, enables `console.debug` logging).

## Limitations

- userChrome.js cannot be packaged as a "Zen Mod" (those are CSS+prefs only). To share,
  publish the files to a repo with fx-autoconfig install instructions (see `README.md`).
- The regex guard (length cap + nested-quantifier block) reduces but does not eliminate
  ReDoS - JS has no in-thread regex timeout.
- The install-dir files (`config.js`, `defaults/pref/config-prefs.js` under the Zen program
  folder) are part of fx-autoconfig and may be wiped by a Zen update - re-copy them
  (e.g. via `gsudo`) if the mod stops loading after an update.
