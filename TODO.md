# ZenTabPalette - TODO / roadmap

Checklist of planned features and known issues. Pick the next thing from here.

## Features

- [ ] **Move folders to a different workspace** - move a whole Zen Folder, not just the
      selected tabs.
- [ ] **Move unpinned tabs to another workspace as unpinned** - keep them unpinned instead
      of auto-pinning on move.
- [ ] **Clear the search query after an operation** (move/close).
- [ ] **Auto-close the dialog when a new tab opens** - e.g. a link directed in from another
      app such as Discord.
- [ ] A folder-colour picker for new folders.
- [ ] **Publish via Sine** (the mod manager). Setup is done and verified by local install:
      `theme.json` (scripts + `style.chrome`), the script skips its own CSS injection when
      fx-autoconfig is absent (Sine loads CSS), `dev/link-to-profile.ps1` supports both loaders,
      and `.gitattributes` keeps dev/docs out of the codeload archive. Remaining: optionally add
      `preferences.json`, then open the Sine marketplace submission issue to publish.

## Fixes / bugs

- [ ] **Not all workspaces' folders appear** in the move-destination dropdown - some
      workspaces' folders are missing from the list.

## Done

- [x] **Native button styling** - dropped the purple accent fill on primary buttons; one
      turquoise accent now drives only active-row / regex-on / focus / badges, buttons are
      neutral to match Zen's UI. (Feedback from Zen's dev: "why are the buttons purple".)
- [x] **Tabler SVG icon set** - replaced text/emoji controls (regex, help, settings, close,
      star, clear) and dropdown glyphs with themed SVGs (`currentColor` -> `context-stroke`).
- [x] **Custom dropdown** - replaced all three native `<select>`s (move destination, recent
      searches, workspace scope) with a styled, icon-bearing, keyboard-accessible dropdown
      that flips up near the dialog's bottom edge.
- [x] **Inline "New Folder" naming** - choosing New Folder / New Tab Group turns the dropdown
      trigger into an inline name editor (Enter creates); the separate name field is gone.
- [x] **Create a folder in another workspace** - each workspace section has a "New folder here"
      action that creates the folder directly in that workspace (no need to switch first).
- [x] **Grouped-tray action rows** - create/move actions sit in a recessed tray per section,
      set apart from the folder rows; workspace sections get a divider; nested folders show
      only their own name (full path in the tooltip).
- [x] **Settings redesign** - grouped cards with toggle **switches** (was checkboxes), a
      stepper for history size, and styled Manage-history / Edit-theme / shortcut controls.
- [x] **Help redesign** - sectioned operators table, regex/tips callouts, kbd-style keys.
- [x] **Motion** - spring-y entrances (dialog, view switches, dropdown pop + row cascade),
      tactile button press, plus a **Settings -> Animations** intensity slider (0-100%,
      `motionScale` pref) that scales speed + distance; 0% disables all motion.
