# Tab Filter for Zen Browser

<img width="1920" height="1032" alt="wD4P5IPjnS" src="https://github.com/user-attachments/assets/be23e3e6-3a8e-48bf-9aa9-5ec418db7f85" />

A keyboard-friendly search & organize dialog for [Zen Browser](https://zen-browser.app)
tabs. Built for heavy tab users (hundreds-thousands of tabs across workspaces) - search
with a rich query language, then bulk-move, bookmark, or close the matches. A userChrome.js
mod; two files, no build step. Installs via **Sine** (recommended) or **fx-autoconfig**.

Open it via the **toolbar button**, **Ctrl+Shift+F**, or **right-clicking a tab**.

## Features

### Search
| Feature | Notes |
|---------|-------|
| Smart query (default) | `space` (or `AND`) = AND · `\|` (or `OR`) = OR · `!term` / `-term` = NOT · `"exact phrase"` · `*` `?` wildcards. `AND`/`OR` must be UPPERCASE whole words. e.g. `docs !archive`, `mail \| calendar`, `github OR gitlab`, `*.example.com` |
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
| Select in tab bar | Hands the selection to Zen's native tab-strip multi-selection so you can use native tab tools on it |

### Right-click menus
| Where | Items |
|-------|-------|
| A dialog row | Jump to tab · Filter this domain · Select same domain · Close tab · (with a selection) Bookmark selected / & close |
| A tab in the strip | Filter by domain · Select same domain · Filter tabs… |

### Settings (⚙ in the dialog)

- Search across all workspaces
- Empty search shows all tabs
- Search in folders by default
- **Keep window open after operation** - stay open after move/close instead of closing each time
- **Show filter history** + history dropdown size
- **Manage history…** - opens the history page
- **Edit theme…** - opens the colour editor
- **Shortcut** - with a warning + a direct link to Zen's keyboard settings if it overrides an existing keybinding

A **? Help** page (the `?` button) lists every search operator and keyboard shortcut.

### Quality

- Accessible (role=dialog, aria-modal, Tab focus-trap, focus restore, aria-labels)
- Debug logging behind a pref
- All Zen/Firefox APIs verified against the browser source

## Install

The mod needs a loader that lets Zen run custom JS. Two options:

### Via Sine (recommended)

[Sine](https://github.com/CosmoCreeper/Sine) is a mod manager for Firefox-based browsers
with JS-mod support.

1. Install Sine (its installer sets up the bootloader for your Zen channel).
2. In **Sine's settings → marketplace / add a mod**, add this repo:
   `juhamikael/ZenTabPalette` (or paste the full GitHub URL). Sine reads `theme.json`,
   then loads `tab-filter.uc.js` and `tab-filter.css` (Sine loads the CSS itself via
   `style.chrome`; the script skips its own CSS injection when fx-autoconfig is absent).
3. Restart Zen (`about:profiles` → **Restart normally…**).
4. Open **Customize Toolbar** and drag the **Filter Tabs** button where you want it, or
   press **Ctrl+Shift+F**.

### Via fx-autoconfig (manual / alternative)

> Note: Sine has dropped fx-autoconfig support for security reasons, and its bootloader
> replaces fx-autoconfig's. Use this path only if you are NOT using Sine.

Requires **fx-autoconfig** ([MrOtherGuy/fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig)).

1. **fx-autoconfig** (once). From its `program/` folder, copy **`config.js` and the whole
   `defaults/` folder** into the Zen **binary/install directory** (the folder with
   `zen.exe`; macOS: `…/Zen.app/Contents/Resources/`). This is a **system** location (needs
   admin - on Windows `gsudo` works) and a Zen update can overwrite it, so re-copy if the
   mod stops loading. Then copy fx-autoconfig's `profile/chrome/utils/` folder into your
   profile's `chrome/` folder.
2. **This mod:** copy `tab-filter.uc.js` and `tab-filter.css` into your profile's
   `chrome/JS/` folder (find the profile via `about:support` → "Open Profile Folder").
3. Restart Zen (`about:profiles` → **Restart normally…**); only clear the startup cache
   (`about:support`) if a change is stubborn.
4. Add the **Filter Tabs** toolbar button (Customize Toolbar) or press **Ctrl+Shift+F**.

## Settings & prefs

All under `extensions.uctabfilter.*` in `about:config`:

- `searchAllWorkspaces`
- `emptyShowsAll`
- `defaultSearchInFolders`
- `keepOpenAfterAction`
- `showFilterHistory`
- `historySize`
- `themeAccent`
- `shortcut` (e.g. `Ctrl+Shift+F`)
- `patterns` (saved searches)
- `history` (recent searches)
- `debug` (enables `console.debug`)

## Theming

Buttons are intentionally neutral to match Zen's native UI; a single **accent** colour
(turquoise by default) drives the active row, the regex-on toggle, focus rings, and badges.
Two ways to change it:

- **In-app editor** (no file editing): ⚙ → **Edit theme…**. Pick the accent from preset
  swatches or a colour picker, with a live preview. Saved to
  `extensions.uctabfilter.themeAccent`; **Reset to defaults** restores it.
  - This is our own editor - Zen's "Edit Theme" (the gradient generator) is bound to
    workspace backgrounds and can't be reused for an arbitrary panel.
- **CSS** (default): `--uc-tf-accent` at the top of `tab-filter.css`. The in-app editor
  overrides it at runtime.

## Development

For live development, symlink the repo's files into your Zen profile instead of copying
them - then edits here are picked up by Zen directly. The script auto-detects your loader
(**Sine** → `chrome/sine-mods/<id>/`, **fx-autoconfig** → `chrome/JS/`):

```powershell
# Auto-detect profile + loader and symlink the files in:
.\dev\link-to-profile.ps1
# …or pass your profile's chrome folder / force a loader explicitly:
.\dev\link-to-profile.ps1 -ProfileChrome "C:\path\to\zen\Profiles\xxxx\chrome" -Loader sine
# Undo (restore plain copies):
.\dev\link-to-profile.ps1 -Unlink
```

Under **Sine**, install the mod once via Sine first (so it's registered and its
`chrome/sine-mods/<id>/` folder exists); the script then symlinks the repo files over it.
Windows needs **Developer Mode ON** (Settings → System → For developers) or an elevated
shell. Close Zen before running, then restart it (`about:profiles` → "Restart normally…")
to pick up changes. See `CLAUDE.md` for architecture and the edit/test protocol.

### TypeScript

There is **no native TypeScript support** - fx-autoconfig only loads `.uc.js`, `.uc.mjs`,
and `.sys.mjs` (and `.uc.css`). This project is plain JS with `// @ts-check`-friendly
JSDoc, so editors type-check it with no build step. fx-autoconfig also ships `.d.ts`
type definitions (its `types/` dir) for its `UC_API`. If you want full TS, you'd write
`.ts` and compile it to `.uc.js` yourself (your own `tsc` step) - fx-autoconfig will not
compile it for you. We chose plain JS + `@ts-check` to keep the "two files, no build"
simplicity.

## TODO / roadmap

See [`TODO.md`](TODO.md) for the planned features and known issues.

## Notes / limitations

- Rides on a few Zen DOM-structure points (`zen-folder` elements, the `zen-workspace-id`
  attribute) that Zen itself uses - stable in practice, but a large Zen/Firefox version
  jump could require a small fix.
- The regex guard reduces but does not eliminate catastrophic backtracking (JS has no
  in-thread regex timeout).

## Contributing

Contributions are welcome - fork it, hack on it, send a pull request. A few pointers if
it helps:

- [`TODO.md`](TODO.md) lists planned features and known issues if you want ideas.
- [`CLAUDE.md`](CLAUDE.md) has the architecture and the edit/test protocol. No build step:
  `node --check tab-filter.uc.js` plus a quick in-browser smoke test.
- Keeping styling in CSS, verifying Zen/Firefox APIs against the browser source, and
  matching the existing style all help, but do whatever works.

## License

[MIT](LICENSE) - do what you want with it, but keep the copyright notice and don't pass it
off as your own.
