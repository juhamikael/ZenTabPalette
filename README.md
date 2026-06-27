# Tab Filter for Zen Browser

A keyboard-friendly search & organize dialog for [Zen Browser](https://zen-browser.app)
tabs. Built for heavy tab users (hundreds-thousands of tabs across workspaces) - search
with a rich query language, then bulk-move, bookmark, or close the matches. A userChrome.js
mod (loaded via fx-autoconfig); two files, no build step.

Open it via the **toolbar button**, **Ctrl+Shift+F**, or **right-clicking a tab**.

## Features

### Search
| Feature | Notes |
|---------|-------|
| Smart query (default) | `space` (or `AND`) = AND · `\|` (or `OR`) = OR · `!term` / `-term` = NOT · `"exact phrase"` · `*` `?` wildcards. `AND`/`OR` must be UPPERCASE whole words. e.g. `wow !youtube`, `heroes \| olden`, `wowhead OR juhamikael.space`, `*.juhamikael` |
| Regex mode | Toggle with `.*`; one case-insensitive RegExp, ReDoS-guarded (length cap + nested-quantifier block) |
| Duplicates | Show extra tabs sharing the same URL (ignores `#hash`, trailing `/`) |
| Search in folders | Includes folder contents and matches by folder name |
| Cross-workspace | Setting + an in-dialog picker: search one workspace or **all** of them |
| Saved patterns | Star a query to reuse it later (persisted) |
| Filter history | Recent searches auto-recorded; pick from a dropdown, or manage/clear them on their own page |
| Empty = show all | Empty box lists every tab (toggleable in settings) |

### Results list
| Feature | Notes |
|---------|-------|
| Virtualized | Only visible rows are mounted - smooth with thousands of tabs |
| Row info | Favicon · title · URL · `📁 folder` · `🪟 workspace` (workspace shown when searching all) |
| Persistent selection | Selections survive changing the search within a session |
| Keyboard nav | `↑`/`↓` move · `Space` toggles the highlighted row · `Enter` jumps · `Ctrl+Enter` toggles · `Delete` closes the selection (or the highlighted tab) |

### Actions (on the selection)
| Action | Notes |
|--------|-------|
| Move to destination | New/existing **Zen Folder**, new/existing **Tab Group**, or another **Workspace** (incl. its folders) |
| Bookmark selected / & close | Saves to a new "Saved tabs" folder in the Bookmarks Menu |
| Close selected | With an in-dialog confirmation |
| Multi-select | Hands the selection to Zen's native multi-selection |

### Right-click menus
| Where | Items |
|-------|-------|
| A dialog row | Jump to tab · Filter this domain · Select same domain · Close tab · (with a selection) Bookmark selected / & close |
| A tab in the strip | Filter by domain · Select same domain · Filter tabs… |

### Settings (⚙ in the dialog)
Search across all workspaces · Empty search shows all tabs · Search in folders by default ·
**Keep window open after operation** (stay open after move/close instead of closing each time) ·
**Show filter history** + history dropdown size · **Manage history…** (opens the history page) ·
**Edit theme…** (opens the colour editor) ·
Shortcut (with a **warning** + a direct link to Zen's keyboard settings if it overrides an
existing keybinding). A **? Help** page lists every search operator and keyboard shortcut.

### Quality
Accessible (role=dialog, aria-modal, Tab focus-trap, focus restore, aria-labels) ·
debug logging behind a pref · all Zen/Firefox APIs verified against the browser source.

## Install

Requires **fx-autoconfig** ([MrOtherGuy/fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig)),
which lets Zen run custom JS.

1. **fx-autoconfig** (once). From fx-autoconfig's `program/` folder, copy **`config.js`
   and the whole `defaults/` folder** into the Zen **binary/install directory** - the
   folder that contains `zen.exe` (Windows: e.g. `C:\Program Files\Zen Browser\`; Linux:
   next to the `zen` binary; macOS: `…/Zen.app/Contents/Resources/`). After this you should
   have `…/Zen Browser/config.js` and `…/Zen Browser/defaults/pref/config-prefs.js`.
   - This is a **system** location (needs admin - on Windows `gsudo` works) and is **not
     part of this mod** - it's fx-autoconfig's loader. Zen updates can overwrite it, so
     re-copy if the mod stops loading after an update.
   - Then copy fx-autoconfig's `profile/chrome/utils/` folder into your **profile**
     `chrome/` folder.
2. **This mod:** copy `tab-filter.uc.js` and `tab-filter.css` into your profile
   `chrome/JS/` folder (find the profile via `about:support` → "Open Profile Folder").
3. Restart Zen via `about:support` → **Clear startup cache…** (a plain restart isn't enough -
   fx-autoconfig caches scripts).
4. Open **Customize Toolbar** and drag the **Filter Tabs** button where you want it, or
   just press **Ctrl+Shift+F**.

## Settings & prefs

All under `extensions.uctabfilter.*` in `about:config`:
`searchAllWorkspaces` · `emptyShowsAll` · `defaultSearchInFolders` · `keepOpenAfterAction` ·
`showFilterHistory` · `historySize` · `themeAccent` · `themePrimary` · `shortcut`
(e.g. `Ctrl+Shift+F`) · `patterns` (saved searches) · `history` (recent searches) ·
`debug` (enables `console.debug`).

## Theming

Two ways to recolour the dialog:

- **In-app editor** (no file editing): ⚙ → **Edit theme…**. Pick from preset swatches or a
  colour picker for the **accent** (highlighted row) and **primary** (buttons / regex-on /
  focus) colours, with a live preview. Saved to `extensions.uctabfilter.themeAccent` /
  `themePrimary`; **Reset to defaults** restores them.
  - This is our own editor - Zen's "Edit Theme" (the gradient generator) is bound to
    workspace backgrounds and can't be reused for an arbitrary panel, so we built an
    equivalent that drives the same two CSS variables.
- **CSS** (defaults): the two variables at the top of `tab-filter.css` - `--uc-tf-accent`
  (turquoise by default) and `--uc-tf-primary` (Zen's accent by default). The in-app editor
  overrides these at runtime.

## Development

For live development, symlink the repo's files into your Zen profile instead of copying
them - then edits here are picked up by Zen directly:

```powershell
# Auto-detect your default Zen profile and symlink the files in:
.\dev\link-to-profile.ps1
# …or pass your profile's chrome\JS explicitly (about:support > "Open Profile Folder"):
.\dev\link-to-profile.ps1 -ProfileJS "C:\path\to\zen\Profiles\xxxx\chrome\JS"
# Undo (restore plain copies):
.\dev\link-to-profile.ps1 -Unlink
```

Windows needs **Developer Mode ON** (Settings → System → For developers) or an elevated
shell to create symlinks. After editing, reload Zen (`about:support` → "Clear startup
cache…", or a full restart). See `CLAUDE.md` for architecture and the edit/test protocol.

### TypeScript

There is **no native TypeScript support** - fx-autoconfig only loads `.uc.js`, `.uc.mjs`,
and `.sys.mjs` (and `.uc.css`). This project is plain JS with `// @ts-check`-friendly
JSDoc, so editors type-check it with no build step. fx-autoconfig also ships `.d.ts`
type definitions (its `types/` dir) for its `UC_API`. If you want full TS, you'd write
`.ts` and compile it to `.uc.js` yourself (your own `tsc` step) - fx-autoconfig will not
compile it for you. We chose plain JS + `@ts-check` to keep the "two files, no build"
simplicity.

## TODO / roadmap

- [ ] **Package as a real Zen Mod.** Currently blocked: Zen Mods are CSS + preferences
      only, so a JS mod can't be a native Zen Mod. Track whether Zen adds first-class
      JS-mod support; until then the realistic distribution is this repo + an install
      script (and/or auto-copying the fx-autoconfig program files).
- [ ] Optional: a colour/theme picker in the settings view (currently themed via CSS
      variables); folder-colour picker for new folders.

## Notes / limitations

- Rides on a few Zen DOM-structure points (`zen-folder` elements, the `zen-workspace-id`
  attribute) that Zen itself uses - stable in practice, but a large Zen/Firefox version
  jump could require a small fix.
- The regex guard reduces but does not eliminate catastrophic backtracking (JS has no
  in-thread regex timeout).

See `CLAUDE.md` (next to this file) for architecture and contribution/testing notes.
