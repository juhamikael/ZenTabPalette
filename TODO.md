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
- [ ] **Distribute via Sine** (the mod manager). Native Zen Mods are CSS + preferences only,
      so Sine is the realistic path for a JS mod. Done: `theme.json` (scripts + `style.chrome`),
      the script skips its own CSS injection when fx-autoconfig is absent (Sine loads CSS),
      and `dev/link-to-profile.ps1` supports both loaders. Remaining: install/test via Sine
      end-to-end, optionally add `preferences.json`, then open the Sine marketplace submission
      issue to publish.

## Fixes / bugs

- [ ] **Not all workspaces' folders appear** in the move-destination dropdown - some
      workspaces' folders are missing from the list.

## Done

- [x] **Native button styling** - dropped the purple accent fill on primary buttons; one
      turquoise accent now drives only active-row / regex-on / focus / badges, buttons are
      neutral to match Zen's UI. (Feedback from Zen's dev: "why are the buttons purple".)
