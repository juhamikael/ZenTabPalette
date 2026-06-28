// ==UserScript==
// @name           ZenTabPalette (Tab Filter)
// @description    Toolbar button + Ctrl+Shift+F + right-click to open a dialog that filters tabs and moves matches into a Zen Folder / Tab Group / Workspace, closes or multi-selects them
// @include        main
// @author         juhamikael
// ==/UserScript==
//
// Styles live next to this file in tab-filter.css and are loaded via a <link>
// to chrome://userscripts/content/tab-filter.css (the chrome/JS dir is registered
// to that scheme by fx-autoconfig's chrome.manifest).
//
// Architecture:
//   createEl()     – tiny element-builder helper, lets us build DOM declaratively (JSX-ish)
//   ZenTabService  – stateless wrapper around every Zen/Firefox API this mod uses
//   PatternStore   – persistence of saved search patterns (a browser pref)
//   FilterDialog   – the modal UI; one instance is created per open
//   bootstrap fns  – register the toolbar widget, shortcut, context-menu entry
//
// Note: this is plain chrome JS, not React — there is no reactive state. The
// dynamic part (the results list) is re-rendered explicitly by #rebuildList(),
// which acts as its "render" function. Add `// @ts-check` on line 1 for editor
// type-checking from the JSDoc below.

(function () {
  "use strict";

  /** Tab-group colour names accepted by gBrowser.addTabGroup, cycled for new groups. */
  const GROUP_COLORS = ["blue", "red", "yellow", "green", "pink", "purple", "orange", "cyan", "gray"];
  /** Preset swatches for the theme editor (echoes Zen's color-dot palette). */
  const THEME_SWATCHES = ["#1fc8b4", "#7a7afc", "#67d4a0", "#7aa2f7", "#f7d774", "#f08a5d", "#e0607e", "#b48ef0", "#e8e6d9", "#9aa0a6"];
  /** Theme default (mirrors --uc-tf-accent in tab-filter.css). */
  const THEME_DEFAULT_ACCENT = "#1fc8b4";   // turquoise accent
  /** CustomizableUI widget id (also the CSS selector for the toolbar icon). */
  const WIDGET_ID = "uc-tab-filter-button";
  /** Pref holding the JSON array of saved search patterns. */
  const PATTERNS_PREF = "extensions.uctabfilter.patterns";
  /** Pref holding the JSON array of recent (auto-recorded) searches. */
  const HISTORY_PREF = "extensions.uctabfilter.history";
  /** Hard cap on how many history entries are persisted (the visible count is a separate setting). */
  const HISTORY_MAX = 200;
  /** Pref holding the open-dialog shortcut, e.g. "Ctrl+Shift+F". */
  const SHORTCUT_PREF = "extensions.uctabfilter.shortcut";
  /** chrome:// URL of the sibling stylesheet (chrome/JS is mapped to this scheme). */
  const STYLESHEET_URL = "chrome://userscripts/content/tab-filter.css";
  /** Default favicon shown when a tab has none. */
  const DEFAULT_FAVICON = "chrome://global/skin/icons/defaultFavicon.svg";
  /** Virtualized list geometry: vertical stride per row (must match CSS row height + gap). */
  const ROW_STEP = 40;
  /** Extra rows rendered above and below the viewport so scrolling stays smooth. */
  const ROW_BUFFER = 6;

  /**
   * Build a DOM element declaratively, like JSX without a build step (this is the
   * hyperscript pattern — think React.createElement). Props: `class`, any `on*`
   * handler (camelCase ok), a `ref` callback to capture the element, and anything
   * else is set as a property (when the element has one) or otherwise an
   * attribute. `null`/`false` children/props are skipped, so
   * `cond ? createEl(...) : null` works inline.
   * @param {string} tag
   * @param {Object} [props]
   * @param {(Node|string|number|null|false)[]|Node|string} [children]
   * @returns {HTMLElement}
   */
  function createEl(tag, props = {}, children = []) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null) continue;
      else if (key === "ref") value(element);
      else if (key === "class") element.className = value;
      else if (key.startsWith("on") && typeof value === "function") element[key.toLowerCase()] = value;
      else if (key in element) element[key] = value;   // properties: value, checked, hidden, type, title, src…
      else element.setAttribute(key, value);
    }
    for (const child of Array.isArray(children) ? children : [children]) {
      if (child == null || child === false) continue;
      element.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return element;
  }

  /**
   * Wrap `fn` so it only runs `delayMs` after the last call — used to keep the
   * live search from rebuilding the list on every keystroke.
   * @param {Function} fn
   * @param {number} delayMs
   * @returns {Function} debounced wrapper
   */
  function debounce(fn, delayMs) {
    let timer = 0;
    return function (...args) { clearTimeout(timer); timer = setTimeout(() => fn.apply(this, args), delayMs); };
  }

  /** Debug logging is off by default; flip extensions.uctabfilter.debug to see swallowed errors. */
  const DEBUG = (() => { try { return Services.prefs.getBoolPref("extensions.uctabfilter.debug", false); } catch (e) { debug(e); return false; } })();
  /** Log only when DEBUG is on — used in catch blocks so failures aren't silently swallowed. */
  function debug(...args) { if (DEBUG) console.debug("[ZenTabPalette]", ...args); }

  /**
   * A Zen folder descriptor used by the destination picker.
   * @typedef {Object} FolderInfo
   * @property {Element} element     the <zen-folder> element
   * @property {string}  label       the folder's own name
   * @property {number}  depth       nesting depth (0 = top level)
   * @property {string}  path        full nested path, e.g. "Parent ▸ Child"
   * @property {?string} workspaceId workspace this folder belongs to
   */

  /**
   * A tab-group destination.
   * @typedef {Object} GroupInfo
   * @property {Element} element
   * @property {string}  label
   */

  /**
   * A move-target workspace (other than the active one).
   * @typedef {Object} WorkspaceInfo
   * @property {string} uuid
   * @property {string} name   display name, optionally prefixed with its emoji icon
   */

  /**
   * A built list row, kept so actions can read the checkbox / highlight the row.
   * @typedef {Object} ListRow
   * @property {MozTabbrowserTab} tab
   * @property {HTMLInputElement} checkbox
   * @property {HTMLElement}      element   the row container
   */

  // =====================================================================
  //  ZenTabService
  // =====================================================================
  /**
   * Stateless façade over every Zen / Firefox internal this mod touches
   * (gBrowser, gZenWorkspaces, gZenFolders, the tab/folder DOM). Centralising it
   * here keeps the dialog free of brittle browser-internal calls. All methods are
   * static; nothing is instantiated.
   */
  class ZenTabService {
    /** @returns {boolean} true for pinned tabs and Essentials (never filtered/moved as loose tabs). */
    static isPinned(tab) { return tab.pinned || tab.hasAttribute("zen-essential"); }
    /** @returns {?string} uuid of the active workspace, or null if unavailable. */
    static activeWorkspaceId() { try { return window.gZenWorkspaces?.activeWorkspace; } catch (e) { debug(e); return null; } }
    /** @returns {boolean} true if the tab lives inside a Zen folder. */
    static isInFolder(tab) { try { return !!(tab.group && tab.group.isZenFolder); } catch (e) { debug(e); return false; } }
    /** @returns {string} the name of the folder containing the tab, or "". */
    static folderLabelOfTab(tab) { try { return tab.group?.isZenFolder ? (tab.group.label || "") : ""; } catch (e) { debug(e); return ""; } }
    /** @returns {string} a folder element's display name. */
    static folderName(folderElement) { return folderElement.label || folderElement.getAttribute("label") || "(unnamed folder)"; }
    /** @returns {string} a favicon URL for the tab, or "" if none. */
    static faviconOf(tab) {
      try { return tab.image || (typeof gBrowser.getIcon === "function" ? gBrowser.getIcon(tab) : "") || ""; } catch (e) { debug(e); return ""; }
    }
    /** @returns {string} the tab's current URL, or "". */
    static urlOf(tab) { try { return tab.linkedBrowser?.currentURI?.spec || ""; } catch (e) { debug(e); return ""; } }
    /** @returns {string} the display name of the tab's workspace (with emoji icon), or "" if active/unknown. */
    static workspaceNameOf(tab) {
      try {
        const id = tab.getAttribute("zen-workspace-id");
        if (!id) return "";
        const ws = window.gZenWorkspaces?.getWorkspaceFromId?.(id); // public lookup, no array scan
        if (!ws) return "";
        const icon = ws.icon && !String(ws.icon).endsWith(".svg") ? ws.icon + " " : "";
        return icon + (ws.name || "");
      } catch (e) { debug(e); return ""; }
    }

    /**
     * Compile a query into a `{test(text)->boolean}` matcher, or `{error}`.
     * `test` receives the combined title+URL(+folder) text for a tab.
     *
     * Two modes:
     *  - regex (the `.*` toggle): the whole query is one case-insensitive RegExp.
     *    Run on the main thread against every tab, so we cap length and block
     *    nested quantifiers (e.g. `(a+)+`) which could hang the UI.
     *  - smart (default), Everything-style: space (or `AND`) = AND, `|` (or `OR`)
     *    = OR, `!`/`-` = NOT, `"phrase"` = exact, `*`/`?` = wildcards.
     *    e.g. `docs !archive | "release notes"` or `github OR gitlab`.
     * @param {string} query
     * @param {boolean} regexMode
     * @returns {?{test:(s:string)=>boolean}|{error:string}}
     */
    static makeMatcher(query, regexMode) {
      const trimmed = (query || "").trim();
      if (!trimmed) return null;
      if (regexMode) {
        if (trimmed.length > 200) return { error: "Pattern too long (max 200 chars)" };
        if (/\([^)]*[+*][^)]*\)\s*[*+]/.test(trimmed)) {
          return { error: "Blocked: nested quantifier may hang the UI (e.g. (a+)+)" };
        }
        let regex; try { regex = new RegExp(trimmed, "i"); } catch (e) { return { error: e.message }; }
        return { test: (text) => regex.test(text) };
      }
      const orGroups = this.#parseSmartQuery(trimmed);
      if (!orGroups.length) return { test: () => true };
      return {
        test: (text) => {
          const haystack = text.toLowerCase();
          // Tab matches if ANY OR-group matches; a group matches if every term's
          // presence equals its expectation (positive present / negative absent).
          return orGroups.some((terms) => terms.every((t) => (t.test(haystack) ? !t.neg : t.neg)));
        },
      };
    }

    /**
     * Parse a smart query into OR-groups of AND-terms. OR-separators are a literal
     * `|` or a standalone, uppercase `OR` keyword; a standalone uppercase `AND`
     * keyword is the explicit form of the implicit space-AND (so it is dropped).
     * Both keywords are uppercase-and-whole-word only, so "or"/"and" inside a title
     * or URL stay literal search terms.
     * @returns {Array<Array<{neg:boolean,test:(h:string)=>boolean}>>}
     */
    static #parseSmartQuery(query) {
      const groups = [];
      for (const group of query.split(/\s+OR\s+|\|/)) {
        const terms = [];
        const tokenizer = /([!-])?"([^"]*)"|(\S+)/g; // optional !/- + "quoted", or a bare word
        let match;
        while ((match = tokenizer.exec(group))) {
          if (match[2] !== undefined) terms.push(this.#smartTerm(match[2], match[1] === "!" || match[1] === "-", true));
          else if (match[3] === "AND") continue; // explicit AND keyword == the implicit space-AND
          else terms.push(this.#smartTerm(match[3], false, false));
        }
        if (terms.length) groups.push(terms);
      }
      return groups;
    }

    /** Build one smart-query term: leading !/- negation and `*`/`?` wildcards (else plain substring). */
    static #smartTerm(text, neg, quoted) {
      if (!quoted && (text[0] === "!" || text[0] === "-") && text.length > 1) { neg = true; text = text.slice(1); }
      const lower = text.toLowerCase();
      if (!quoted && /[*?]/.test(text)) {
        const pattern = lower.replace(/[.+^${}()[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
        try { const regex = new RegExp(pattern); return { neg, test: (h) => regex.test(h) }; } catch (e) { debug(e); }
      }
      return { neg, test: (h) => h.includes(lower) };
    }

    /**
     * A predicate testing whether a tab is within the wanted workspace scope.
     * @param {?string} scope undefined/null = active workspace (a tab with no
     *   `zen-workspace-id` counts as active); "all" = any workspace; else a uuid.
     * @returns {(tab:MozTabbrowserTab)=>boolean}
     */
    static scopePredicate(scope) {
      if (scope === "all") return () => true;
      const activeId = this.activeWorkspaceId();
      const wanted = scope || activeId;
      if (!wanted) return () => true;
      return (tab) => {
        const id = tab.getAttribute("zen-workspace-id");
        return id === wanted || (!id && wanted === activeId);
      };
    }

    /**
     * The tab universe to search for a scope. `gBrowser.tabs` only holds the
     * ACTIVE workspace, so cross-workspace scopes use `gZenWorkspaces.allStoredTabs`
     * (it walks every workspace's containers; Zen nulls its cache on any tab change,
     * so it stays fresh). Verified in ZenSpaceManager.mjs / tabs.js.
     * @param {?string} scope
     * @returns {MozTabbrowserTab[]}
     */
    static allTabsForScope(scope) {
      const needsAllWorkspaces = scope === "all" || (scope && scope !== this.activeWorkspaceId());
      if (needsAllWorkspaces) {
        try {
          const stored = window.gZenWorkspaces?.allStoredTabs;
          if (stored && stored.length) return [...stored];
        } catch (e) { debug(e); }
      }
      return [...gBrowser.tabs];
    }

    /** @returns {string} registrable domain (eTLD+1) of the tab's URL, else its host, else "". */
    static baseDomainOf(tab) {
      try {
        const host = tab.linkedBrowser?.currentURI?.host; // throws on about:/file:
        if (!host) return "";
        try { return Services.eTLD.getBaseDomainFromHost(host); } catch (e) { return host; }
      } catch (e) { debug(e); return ""; }
    }

    /** Tabs within `scope` whose registrable domain equals `domain`. */
    static tabsByBaseDomain(domain, scope) {
      if (!domain) return [];
      const inScope = this.scopePredicate(scope);
      return this.allTabsForScope(scope).filter((tab) => !tab.closing && inScope(tab) && this.baseDomainOf(tab) === domain);
    }

    /**
     * Tabs within `scope` matching `query` by title or URL. With `includeFolders`,
     * folder contents are included and a folder whose *name* matches contributes
     * all its tabs. Empty query = all tabs in scope.
     * @param {string} query
     * @param {boolean} regexMode
     * @param {boolean} includeFolders
     * @param {?string} scope see scopePredicate
     * @returns {MozTabbrowserTab[]}
     */
    static getMatchingTabs(query, regexMode, includeFolders, scope) {
      const trimmed = (query || "").trim();
      const matcher = trimmed ? this.makeMatcher(trimmed, regexMode) : { test: () => true };
      if (!matcher || matcher.error) return [];

      // Tabs in a folder whose NAME matches (typing a folder name surfaces its contents).
      const folderNameHits = new Set();
      if (includeFolders) {
        for (const folder of this.getFolders()) {
          if (matcher.test(folder.label)) {
            try { for (const tab of folder.element.tabs || []) folderNameHits.add(tab); } catch (e) { debug(e); }
          }
        }
      }

      const inScope = this.scopePredicate(scope);
      return this.allTabsForScope(scope).filter((tab) => {
        if (tab.closing || !inScope(tab)) return false;
        const isFolderTab = this.isInFolder(tab);
        if (this.isPinned(tab) && !isFolderTab) return false;   // skip essentials / plain pinned
        if (isFolderTab && !includeFolders) return false;        // skip folder contents unless enabled
        if (folderNameHits.has(tab)) return true;
        // Match against the combined text so AND/OR terms can span title + URL (+ folder).
        const folderLabel = includeFolders ? this.folderLabelOfTab(tab) : "";
        const haystack = (tab.label || "") + " " + this.urlOf(tab) + (folderLabel ? " " + folderLabel : "");
        return matcher.test(haystack);
      });
    }

    /**
     * The redundant tabs within `scope`: for each URL (ignoring #hash and trailing
     * /) the first is kept and every later copy is returned.
     * @param {boolean} includeFolders
     * @param {?string} scope see scopePredicate
     * @returns {MozTabbrowserTab[]} the extra copies (safe to close)
     */
    static getDuplicateTabs(includeFolders, scope) {
      const seenUrls = new Set();
      const duplicates = [];
      const inScope = this.scopePredicate(scope);
      for (const tab of this.allTabsForScope(scope)) {
        if (tab.closing || !inScope(tab)) continue;
        const isFolderTab = this.isInFolder(tab);
        if (this.isPinned(tab) && !isFolderTab) continue;
        if (isFolderTab && !includeFolders) continue;
        const url = this.urlOf(tab);
        if (!url || url === "about:blank") continue;
        const normalizedUrl = url.replace(/#.*$/, "").replace(/\/+$/, "");
        if (seenUrls.has(normalizedUrl)) duplicates.push(tab);
        else seenUrls.add(normalizedUrl);
      }
      return duplicates;
    }

    /**
     * Every Zen folder across ALL workspaces, with its nested path and owning
     * workspace — the destination picker uses `workspaceId` to group them.
     * @returns {FolderInfo[]}
     */
    static getFolders() {
      return [...document.querySelectorAll("zen-folder")].map((folderElement) => {
        const pathParts = [];
        // Walk up the ancestor folders to build the path AND inherit the nearest
        // workspace id — a nested folder may not carry its own zen-workspace-id,
        // so without this it could be misfiled under the active workspace.
        let workspaceId = null;
        for (let node = folderElement; node; node = node.parentElement) {
          if (node.localName !== "zen-folder") continue;
          pathParts.unshift(this.folderName(node));
          if (!workspaceId) workspaceId = node.getAttribute("zen-workspace-id");
        }
        return {
          element: folderElement,
          label: this.folderName(folderElement),
          depth: pathParts.length - 1,
          path: pathParts.join(" ▸ "),
          workspaceId,
        };
      });
    }

    /**
     * Plain tab groups (not folders, not split views) in the active workspace.
     * @returns {GroupInfo[]}
     */
    static getGroups() {
      let groupElements = [...document.querySelectorAll("tab-group")].filter(
        (element) => !element.closest("zen-folder") && !element.hasAttribute("split-view-group")
      );
      const workspaceId = this.activeWorkspaceId();
      if (workspaceId) {
        // A group belongs to the active workspace if it has a tab tagged with this
        // workspace OR a tab with no workspace tag at all (Zen omits the attribute
        // for default/active-workspace tabs). This mirrors isInActiveWorkspace's
        // leniency, so existing groups don't silently vanish from the picker.
        groupElements = groupElements.filter((element) =>
          element.querySelector(`tab[zen-workspace-id="${workspaceId}"]`) ||
          [...element.querySelectorAll("tab")].some((tab) => !tab.hasAttribute("zen-workspace-id"))
        );
      }
      return groupElements.map((element) => ({ element, label: element.getAttribute("label") || "(unnamed group)" }));
    }

    /**
     * Other workspaces (excluding the active one) as move targets.
     * @returns {WorkspaceInfo[]}
     */
    static getWorkspaces() {
      try {
        const activeId = this.activeWorkspaceId();
        return (window.gZenWorkspaces?.getWorkspaces?.() || [])
          .filter((workspace) => workspace.uuid !== activeId)
          .map((workspace) => this.#workspaceInfo(workspace));
      } catch (e) { debug(e); return []; }
    }

    /** ALL workspaces (including the active one) — for the cross-workspace picker. */
    static getAllWorkspaces() {
      try {
        return (window.gZenWorkspaces?.getWorkspaces?.() || []).map((workspace) => this.#workspaceInfo(workspace));
      } catch (e) { debug(e); return []; }
    }

    /** @returns {WorkspaceInfo} normalize a Zen workspace object (name + its emoji icon, both combined and separate). */
    static #workspaceInfo(workspace) {
      const emoji = workspace.icon && !String(workspace.icon).endsWith(".svg") ? workspace.icon : "";
      const rawName = workspace.name || "Workspace";
      return { uuid: workspace.uuid, name: (emoji ? emoji + " " : "") + rawName, rawName, emoji };
    }

    /**
     * Find a built-in Zen shortcut (from gZenKeyboardShortcutsManager) that already
     * uses the same key + modifiers, so settings can warn about an override.
     * @param {{ctrl,shift,alt,meta,key:string}} parsed
     * @returns {?object} the conflicting KeyShortcut, or null
     */
    static async findShortcutConflict(parsed) {
      try {
        const manager = window.gZenKeyboardShortcutsManager;
        if (!parsed.key || typeof manager?.checkForConflicts !== "function") return null;
        // Get the nsKeyShortcutModifiers CLASS from an existing shortcut instance. Do NOT
        // importESModule the Zen module — it assigns `window.*` at top level and throws in
        // the system module loader (where `window` is undefined).
        const editable = await manager.getModifiableShortcuts?.();
        const ModifiersClass = editable?.find((ks) => ks.getModifiers?.())?.getModifiers()?.constructor;
        if (!ModifiersClass?.fromObject) return null;
        const mods = ModifiersClass.fromObject({ ctrl: parsed.ctrl, alt: parsed.alt, shift: parsed.shift, meta: parsed.meta });
        // Zen's OWN conflict detector (the one its CKS settings page uses). `id` excludes
        // a shortcut by id; we have none registered, so pass a sentinel.
        const result = manager.checkForConflicts(parsed.key, mods, "uc-tab-filter");
        return result?.hasConflicts ? result.conflictShortcut : null;
      } catch (e) { debug(e); return null; }
    }

    /** A human-readable name for a Zen KeyShortcut (best-effort, async via Fluent). */
    static async shortcutLabel(ks) {
      try {
        const l10nId = ks.getL10NID?.();
        if (l10nId && document.l10n) {
          const value = await document.l10n.formatValue(l10nId).catch(() => null);
          if (value) return value;
        }
        const action = ks.getAction?.();
        if (action) return action.replace(/^cmd_?/i, "").replace(/[-_]/g, " ").trim() || action;
        return ks.toDisplayString?.() || "another shortcut";
      } catch (e) { debug(e); return "another shortcut"; }
    }

    // ---------- Actions ----------
    /**
     * Create a new Zen folder containing `tabs` (folders auto-pin their tabs).
     * If `workspaceUuid` names another workspace, the tabs are moved there first and
     * the folder is created in it (Zen's createFolder honours `workspaceId`), so you
     * can drop a selection straight into a folder in a different workspace without switching to it.
     * @param {MozTabbrowserTab[]} tabs @param {string} name @param {?string} [workspaceUuid]
     */
    static createFolder(tabs, name, workspaceUuid) {
      const activeId = this.activeWorkspaceId();
      if (workspaceUuid && activeId && workspaceUuid !== activeId) {
        this.moveToWorkspace(tabs, workspaceUuid); // synchronous (see moveToFolder note)
      }
      window.gZenFolders.createFolder(tabs, {
        label: name || "New Folder", renameFolder: false,
        ...(workspaceUuid ? { workspaceId: workspaceUuid } : {}),
      });
    }
    /** Create a new tab group containing `tabs`. */
    static createGroup(tabs, name, color) {
      gBrowser.addTabGroup(tabs, { label: name || "New Group", color, insertBefore: tabs[0] });
    }
    /** Move `tabs` into an existing tab group element. */
    static moveToGroup(tabs, groupElement) {
      for (const tab of tabs) gBrowser.moveTabToGroup(tab, groupElement);
    }
    /** Move `tabs` to another workspace by uuid. */
    static moveToWorkspace(tabs, workspaceUuid) {
      window.gZenWorkspaces.moveTabsToWorkspace(tabs, workspaceUuid);
    }
    /**
     * Move `tabs` into a folder. If the folder is in another workspace, move the
     * tabs there first, then pin them and add them to the folder. On failure any
     * tabs we pinned are unpinned again so nothing is left half-moved.
     * @param {MozTabbrowserTab[]} tabs
     * @param {Element} folderElement
     * @param {?string} targetWorkspaceUuid  the folder's workspace, if known
     */
    static moveToFolder(tabs, folderElement, targetWorkspaceUuid) {
      const activeId = this.activeWorkspaceId();
      if (targetWorkspaceUuid && activeId && targetWorkspaceUuid !== activeId) {
        // moveTabsToWorkspace is synchronous (verified in ZenSpaceManager.mjs: it
        // mutates the DOM inline and returns true, not a Promise), so the pin +
        // addTabs below is safe to run immediately afterwards.
        this.moveToWorkspace(tabs, targetWorkspaceUuid);
      }
      const newlyPinned = [];
      try {
        for (const tab of tabs) { if (!tab.pinned) { gBrowser.pinTab(tab); newlyPinned.push(tab); } }
        folderElement.addTabs(tabs);
      } catch (error) {
        for (const tab of newlyPinned) { try { gBrowser.unpinTab(tab); } catch (e) { debug(e); } }
        throw error;
      }
    }
    /** Put `tabs` into the browser's native multi-selection (first becomes active). */
    static multiSelect(tabs) {
      gBrowser.clearMultiSelectedTabs();
      gBrowser.selectedTab = tabs[0];
      for (const tab of tabs) gBrowser.addToMultiSelectedTabs(tab);
    }
    /** Close every tab in `tabs` (each guarded individually). */
    static closeTabs(tabs) {
      for (const tab of tabs) { try { gBrowser.removeTab(tab, { animate: true }); } catch (e) { debug(e); } }
    }
    /**
     * Bookmark `tabs` into a new folder in the Bookmarks Menu (like Firefox's
     * "Bookmark All Tabs"). Only http/https/ftp/file URLs are bookmarkable.
     * @param {MozTabbrowserTab[]} tabs
     * @returns {Promise<number>} how many bookmarks were created
     */
    static async bookmarkTabs(tabs) {
      const children = tabs
        .map((tab) => ({ title: tab.label || this.urlOf(tab), url: this.urlOf(tab) }))
        .filter((b) => /^(https?|ftp|file):/i.test(b.url));
      if (!children.length) return 0;
      let places = window.PlacesUtils;
      if (!places) ({ PlacesUtils: places } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs"));
      await places.bookmarks.insertTree({
        guid: places.bookmarks.menuGuid,
        children: [{
          title: "Saved tabs (" + children.length + ")",
          type: places.bookmarks.TYPE_FOLDER,
          children,
        }],
      });
      return children.length;
    }
    /** Switch to `tab`, expanding its folder first if collapsed. */
    static jumpToTab(tab) {
      try {
        if (tab.group?.isZenFolder && tab.group.collapsed) tab.group.collapsed = false;
        gBrowser.selectedTab = tab;
      } catch (e) { debug(e); }
    }
  }

  // =====================================================================
  //  PatternStore
  // =====================================================================
  /**
   * Persists the user's saved search patterns as a JSON array in a pref so they
   * survive restarts. Each entry is `{ q: string, regex: boolean }`.
   */
  class PatternStore {
    /** @returns {{q:string,regex:boolean}[]} validated list (corrupt prefs → []). */
    static load() {
      try {
        const parsed = JSON.parse(Services.prefs.getStringPref(PATTERNS_PREF, "[]"));
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((pattern) => pattern && typeof pattern.q === "string");
      } catch (e) { debug(e); return []; }
    }
    /** Overwrite the stored list. */
    static save(patterns) { try { Services.prefs.setStringPref(PATTERNS_PREF, JSON.stringify(patterns)); } catch (e) { debug(e); } }
    /** Add a pattern to the front (deduplicated; keeps at most 20). */
    static add(query, regex) {
      const patterns = this.load();
      if (patterns.some((p) => p.q === query && !!p.regex === !!regex)) return;
      patterns.unshift({ q: query, regex: !!regex });
      if (patterns.length > 20) patterns.length = 20;
      this.save(patterns);
    }
    /** Remove the pattern at `index`. */
    static remove(index) {
      const patterns = this.load();
      patterns.splice(index, 1);
      this.save(patterns);
    }
  }

  // =====================================================================
  //  HistoryStore
  // =====================================================================
  /**
   * Auto-recorded recent searches (distinct from PatternStore's manually-starred
   * patterns). Persisted as a JSON array, newest first. Each entry is
   * `{ q: string, regex: boolean, ts: number }`.
   */
  class HistoryStore {
    /** @returns {{q:string,regex:boolean,ts:number}[]} newest-first list (corrupt prefs → []). */
    static load() {
      try {
        const parsed = JSON.parse(Services.prefs.getStringPref(HISTORY_PREF, "[]"));
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((entry) => entry && typeof entry.q === "string");
      } catch (e) { debug(e); return []; }
    }
    /** Overwrite the stored history. */
    static save(history) { try { Services.prefs.setStringPref(HISTORY_PREF, JSON.stringify(history)); } catch (e) { debug(e); } }
    /** Record a search: move it to the front (dedup on query+mode), cap at HISTORY_MAX. */
    static add(query, regex) {
      const trimmed = (query || "").trim();
      if (!trimmed) return;
      const history = this.load().filter((entry) => !(entry.q === trimmed && !!entry.regex === !!regex));
      history.unshift({ q: trimmed, regex: !!regex, ts: Date.now() });
      if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
      this.save(history);
    }
    /** Remove the entry at `index` (index into the newest-first list). */
    static remove(index) {
      const history = this.load();
      history.splice(index, 1);
      this.save(history);
    }
    /** Wipe the entire history. */
    static clear() { this.save([]); }
  }

  // =====================================================================
  //  Settings
  // =====================================================================
  /**
   * User settings, each in its own pref under extensions.uctabfilter.*. Read with
   * the typed getters; the settings view writes through the setters.
   */
  class Settings {
    static #bool(key, dflt) { try { return Services.prefs.getBoolPref("extensions.uctabfilter." + key, dflt); } catch (e) { debug(e); return dflt; } }
    static setBool(key, value) { try { Services.prefs.setBoolPref("extensions.uctabfilter." + key, value); } catch (e) { debug(e); } }
    static #str(key, dflt) { try { return Services.prefs.getStringPref("extensions.uctabfilter." + key, dflt) || dflt; } catch (e) { debug(e); return dflt; } }
    static setStr(key, value) { try { Services.prefs.setStringPref("extensions.uctabfilter." + key, value); } catch (e) { debug(e); } }
    static #int(key, dflt) { try { return Services.prefs.getIntPref("extensions.uctabfilter." + key, dflt); } catch (e) { debug(e); return dflt; } }
    static setInt(key, value) { try { Services.prefs.setIntPref("extensions.uctabfilter." + key, value | 0); } catch (e) { debug(e); } }

    /** Master switch for cross-workspace search (off → active workspace only). */
    static get searchAllWorkspaces() { return this.#bool("searchAllWorkspaces", false); }
    /** Whether an empty query lists every tab (vs. a "type to search" hint). */
    static get emptyShowsAll() { return this.#bool("emptyShowsAll", true); }
    /** Initial state of the dialog's "Search in folders" toggle. */
    static get defaultSearchInFolders() { return this.#bool("defaultSearchInFolders", false); }
    /** Keep the dialog open after a move/close action (vs. closing after each one). */
    static get keepOpenAfterAction() { return this.#bool("keepOpenAfterAction", true); }
    /** Whether the dialog shows the recent-searches (history) dropdown. */
    static get showFilterHistory() { return this.#bool("showFilterHistory", true); }
    /** How many history entries appear in the dropdown (1–50). */
    static get historySize() { return Math.min(50, Math.max(1, this.#int("historySize", 10))); }
    /** Accent colour (active row, toggles, focus) as a hex string. */
    static get themeAccent() { return this.#str("themeAccent", THEME_DEFAULT_ACCENT); }
    /** The open-dialog shortcut, e.g. "Ctrl+Shift+F". */
    static get shortcut() { return this.#str("shortcut", "Ctrl+Shift+F"); }
    /** Animation intensity 0–100 (% of the full motion; 0 = no animations). */
    static get motionScale() { return Math.min(100, Math.max(0, this.#int("motionScale", 100))); }
  }

  // =====================================================================
  //  Dropdown  (custom <select> replacement)
  // =====================================================================
  /**
   * A custom dropdown: a trigger button + a styled popup list with optional per-item
   * icons (an `icon` SVG name from icons/, or an `emoji` string) and group headers.
   * Keyboard accessible (Up/Down/Enter/Esc). Replaces native <select> so the open
   * list can be styled and carry SVG icons.
   * @typedef {Object} DropdownItem
   * @property {string} [header]  a non-selectable group label (renders a divider)
   * @property {*} [value]        the value for a selectable option
   * @property {string} [label]   option text
   * @property {string} [icon]    icons/<icon>.svg name (themed via CSS)
   * @property {string} [emoji]   emoji shown instead of an SVG icon
   * @property {number} [depth]   indent level (for nested folders)
   * @property {*} [action]       arbitrary payload read back by the caller
   */
  class Dropdown {
    #items = [];
    #selected = null;
    #onSelect;
    #onConfirm;
    #placeholder;
    #activeIndex = -1;
    #editing = false;
    #onDocDown;

    constructor({ ariaLabel = "", className = "", placeholder = "", onSelect = () => {}, onConfirm = () => {} }) {
      this.#onSelect = onSelect;
      this.#onConfirm = onConfirm;
      this.#placeholder = placeholder;
      this.label = createEl("span", { class: "uc-tf-dd-label uc-tf-dd-label--placeholder" }, placeholder);
      this.trigger = createEl("button", {
        type: "button", class: "uc-tf-dd-trigger uc-tf-field",
        "aria-label": ariaLabel, "aria-haspopup": "listbox", "aria-expanded": "false",
        onclick: (e) => { e.preventDefault(); this.toggle(); },
        onkeydown: (e) => this.#onKey(e),
      }, [createEl("span", { class: "uc-tf-dd-lead" }), this.label, createEl("span", { class: "uc-tf-dd-caret" })]);
      this.menu = createEl("div", { class: "uc-tf-dd-menu", role: "listbox", hidden: true });

      // Inline editor: shown instead of the trigger when an `editable` item (New
      // Folder / New Tab Group) is selected, so the name is typed right here.
      this.editLead = createEl("span", { class: "uc-tf-dd-lead" });
      this.editInput = createEl("input", {
        type: "text", class: "uc-tf-dd-edit", "aria-label": (ariaLabel ? ariaLabel + " " : "") + "name",
        onkeydown: (e) => this.#onEditKey(e),
      });
      this.editor = createEl("div", { class: "uc-tf-dd-editor uc-tf-field" }, [
        this.editLead, this.editInput,
        createEl("button", {
          type: "button", class: "uc-tf-dd-editcaret", "aria-label": "Change destination",
          onclick: (e) => { e.preventDefault(); e.stopPropagation(); this.open(); },
        }, [createEl("span", { class: "uc-tf-dd-caret" })]),
      ]);

      this.element = createEl("div", { class: "uc-tf-dd" + (className ? " " + className : "") }, [this.trigger, this.editor, this.menu]);
      this.#onDocDown = (e) => { if (!this.element.contains(e.target)) this.close(); };
    }

    get value() { return this.#selected ? this.#selected.value : null; }
    get selectedItem() { return this.#selected; }
    get isOpen() { return !this.menu.hidden; }
    /** The name typed into the inline editor (empty unless an `editable` item is selected). */
    get editValue() { return this.#editing ? this.editInput.value.trim() : ""; }
    get isEditing() { return this.#editing; }

    /** Build the icon element for an item (emoji span, SVG-class span, or null). */
    #iconEl(item) {
      if (item.emoji) return createEl("span", { class: "uc-tf-dd-emoji" }, item.emoji);
      if (item.icon) return createEl("span", { class: "uc-tf-dd-icon uc-tf-dd-icon--" + item.icon });
      return null;
    }

    /** @param {DropdownItem[]} items */
    setItems(items) {
      this.#items = items;
      // Render rows, grouping consecutive `action` items into a recessed "tray"
      // (the grouped-tray treatment that sets create/move actions apart from folders).
      const rows = [];
      let tray = null;
      const flushTray = () => { if (tray) { rows.push(tray); tray = null; } };
      for (const it of items) {
        if (it.header) {
          flushTray();
          rows.push(createEl("div", { class: "uc-tf-dd-header" + (it.divider ? " uc-tf-dd-header--divider" : "") }, it.header));
          continue;
        }
        const row = createEl("div", {
          class: "uc-tf-dd-item" + (it.action ? " uc-tf-dd-item--action" : ""), role: "option", title: it.title || it.label,
          style: it.depth ? "padding-inline-start:" + (10 + it.depth * 14) + "px" : null,
          onclick: () => this.#choose(it),
          onmouseenter: () => { this.#activeIndex = this.#options().indexOf(it); this.#highlight(); },
        }, [this.#iconEl(it), createEl("span", { class: "uc-tf-dd-itemlabel" }, it.label)]);
        it._row = row;
        if (it.action) {
          if (!tray) tray = createEl("div", { class: "uc-tf-dd-tray" });
          tray.appendChild(row);
        } else {
          flushTray();
          rows.push(row);
        }
      }
      flushTray();
      this.menu.replaceChildren(...rows);
      // keep the current selection if its value still exists, else clear the label
      if (this.#selected && !this.#options().some((o) => o.value === this.#selected.value)) this.#setSelected(null);
    }

    #options() { return this.#items.filter((i) => !i.header); }

    /** Select by value programmatically (updates the trigger; does NOT fire onSelect). */
    select(value) { this.#setSelected(this.#options().find((i) => i.value === value) || null); }

    /** Clear the selection back to the placeholder (for action-style dropdowns). */
    reset() { this.#setSelected(null); }

    #setSelected(item) {
      this.#selected = item;
      const lead = this.trigger.querySelector(".uc-tf-dd-lead");
      const icon = item ? this.#iconEl(item) : null;
      lead.replaceChildren(...(icon ? [icon] : []));
      this.label.textContent = item ? item.label : this.#placeholder;
      this.label.classList.toggle("uc-tf-dd-label--placeholder", !item);
      if (item && item.editable) this.#enterEdit(item);
      else this.#exitEdit();
    }

    /** Swap the trigger for the inline name editor (for "create new"-style items). */
    #enterEdit(item) {
      this.#editing = true;
      this.element.classList.add("uc-tf-dd--editing");
      const icon = this.#iconEl(item);
      this.editLead.replaceChildren(...(icon ? [icon] : []));
      this.editInput.placeholder = item.editPlaceholder || "Name";
      this.editInput.value = "";
    }

    /** Restore the normal trigger view. */
    #exitEdit() {
      if (!this.#editing) return;
      this.#editing = false;
      this.element.classList.remove("uc-tf-dd--editing");
      this.editInput.value = "";
    }

    /** Focus the inline name editor (deferred so it wins over the trigger's focus). */
    focusEditor() { if (this.#editing) { this.editInput.focus(); this.editInput.select(); } }

    #choose(item) {
      this.#setSelected(item);
      this.close();
      if (this.#editing) this.focusEditor();
      else this.trigger.focus();
      this.#onSelect(item);
    }

    /** Enter confirms (e.g. runs the move); Escape clears back to the placeholder. */
    #onEditKey(event) {
      if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); this.#onConfirm(); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.reset(); this.trigger.focus(); }
      else if (event.key === "ArrowDown") { event.preventDefault(); this.open(); }
    }

    toggle() { this.isOpen ? this.close() : this.open(); }
    open() {
      this.menu.hidden = false;
      this.trigger.setAttribute("aria-expanded", "true");
      // Flip the menu above the trigger when there isn't room below (e.g. destination
      // dropdown near the dialog's bottom). Anchor to whichever face is visible.
      const rect = (this.#editing ? this.editor : this.trigger).getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const menuHeight = Math.min(this.menu.scrollHeight + 8, 328);
      this.element.classList.toggle("uc-tf-dd--up", spaceBelow < menuHeight && rect.top > spaceBelow);
      document.addEventListener("mousedown", this.#onDocDown, true);
      const opts = this.#options();
      this.#activeIndex = this.#selected ? opts.indexOf(this.#selected) : (opts.length ? 0 : -1);
      this.#highlight(true);
    }
    close() {
      this.menu.hidden = true;
      this.trigger.setAttribute("aria-expanded", "false");
      document.removeEventListener("mousedown", this.#onDocDown, true);
    }

    #highlight(scroll = false) {
      const opts = this.#options();
      opts.forEach((it, i) => it._row && it._row.classList.toggle("uc-tf-dd-item--active", i === this.#activeIndex));
      if (scroll) opts[this.#activeIndex]?._row?.scrollIntoView({ block: "nearest" });
    }

    #onKey(event) {
      const opts = this.#options();
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault(); event.stopPropagation();
          if (!this.isOpen) this.open();
          else { this.#activeIndex = Math.min(opts.length - 1, this.#activeIndex + 1); this.#highlight(true); }
          break;
        case "ArrowUp":
          event.preventDefault(); event.stopPropagation();
          if (this.isOpen) { this.#activeIndex = Math.max(0, this.#activeIndex - 1); this.#highlight(true); }
          break;
        case "Enter":
        case " ":
          event.preventDefault(); event.stopPropagation();
          if (!this.isOpen) this.open();
          else if (opts[this.#activeIndex]) this.#choose(opts[this.#activeIndex]);
          break;
        case "Escape":
          if (this.isOpen) { event.preventDefault(); event.stopPropagation(); this.close(); }
          break;
      }
    }
  }

  // =====================================================================
  //  FilterDialog
  // =====================================================================
  /**
   * The modal filter UI. A fresh instance is created each time the dialog opens
   * (`new FilterDialog().open()`), so all transient state — the built rows, regex
   * toggle, keyboard cursor, and the destination snapshots — lives in instance
   * fields and is discarded on close. The DOM is built declaratively with createEl();
   * all visual styling is in tab-filter.css.
   */
  class FilterDialog {
    /** @type {?FilterDialog} the dialog currently open in this window (at most one) */
    static #current = null;

    /** @type {MozTabbrowserTab[]} the full current filtered result (the list is virtualized; only a window is in the DOM) */
    #filtered = [];
    /** @type {Map<number,ListRow>} index-in-#filtered -> the row currently rendered for it */
    #rendered = new Map();
    /** @type {number} pending requestAnimationFrame id for scroll-driven re-render (0 = none) */
    #scrollRaf = 0;
    /** @type {Set<MozTabbrowserTab>} tabs selected so far — persists across searches within this open session */
    #selected = new Set();
    /** @type {boolean} whether the search box is interpreted as a regex */
    #regexMode = false;
    /** @type {number} keyboard-highlighted row index (-1 = none) */
    #activeIndex = -1;
    /** @type {boolean} true once the user arrow-navigates → Space toggles the row instead of typing */
    #navMode = false;
    /** @type {boolean} true while the shortcut field is capturing a key combo */
    #recording = false;
    /** @type {boolean} whether a combo was committed during the current recording */
    #shortcutCommitted = false;
    /** @type {string} shortcut value before recording started (restored on cancel) */
    #prevShortcut = "";
    /** @type {FolderInfo[]} snapshot taken when the dialog opened */
    #folders = [];
    /** @type {GroupInfo[]} */
    #groups = [];
    /** @type {WorkspaceInfo[]} */
    #workspaces = [];
    /** @type {Object<string,HTMLElement>} captured references to key UI elements */
    #ui = {};
    /** @type {?Element} element focused before the dialog opened, restored on close */
    #previousFocus = null;
    /** @type {?string} workspace scope for search: undefined = active, "all", or a uuid */
    #workspaceScope = undefined;
    /** @type {?HTMLElement} the open per-row right-click menu, if any */
    #rowMenu = null;
    /** @type {?(e:Event)=>void} outside-click dismiss handler for the row menu */
    #rowMenuDismiss = null;

    /**
     * Build the DOM, mount the overlay, wire the Escape handler and focus search.
     * @param {string} [initialQuery] prefilled search (used by "Filter by domain")
     */
    open(initialQuery) {
      // Properly tear down any dialog already open (runs its close(), so its
      // document keydown listener is removed — never leaked on re-open).
      FilterDialog.#current?.close();
      document.getElementById("uc-tf-overlay")?.remove(); // safety net for an untracked stray overlay
      FilterDialog.#current = this;
      this.#previousFocus = document.activeElement; // restore focus here on close (a11y)
      this.#workspaceScope = Settings.searchAllWorkspaces ? "all" : undefined;

      this.#buildDom();
      document.documentElement.appendChild(this.#ui.overlay);
      this.#applyTheme();                                    // apply the saved colours to this dialog
      document.addEventListener("keydown", this.#onDocumentKey);
      this.#fillDestinations();
      this.#renderSavedChips();
      this.#syncSettingsControls();                          // settings checkboxes + workspace picker
      this.#ui.searchFoldersCheckbox.checked = Settings.defaultSearchInFolders;
      if (initialQuery) this.#ui.searchInput.value = initialQuery;
      this.#setRegexMode(false);                             // sets button state + runs rebuild
      this.#ui.searchInput.focus();
    }

    /** Tear down: stop any capture, cancel pending frames, remove handlers/overlay, restore focus. */
    close = () => {
      this.#stopRecordingShortcut();            // else gUCTabFilterRecording can stay true → shortcut dies
      if (this.#scrollRaf) { cancelAnimationFrame(this.#scrollRaf); this.#scrollRaf = 0; }
      this.#closeRowMenu();
      document.removeEventListener("keydown", this.#onDocumentKey);
      this.#ui.overlay?.remove();               // isConnected → false; guards stale debounced #rebuildList
      if (FilterDialog.#current === this) FilterDialog.#current = null;
      try { this.#previousFocus?.focus?.(); } catch (e) { debug(e); }
    };

    /** Document-level Escape handler: close the row menu first, else the dialog. */
    #onDocumentKey = (event) => {
      if (event.key !== "Escape") return;
      if (this.#rowMenu) this.#closeRowMenu();
      else this.close();
    };

    /** A styled action button. @param {string} label @param {boolean} primary @param {() => void} onClick */
    #button(label, primary, onClick) {
      return createEl("button", { class: "uc-tf-btn" + (primary ? " uc-tf-btn--primary" : ""), onclick: onClick }, label);
    }

    /**
     * An icon-only control that's keyboard-accessible (Enter/Space activate it and
     * it's reachable by Tab / a screen reader via aria-label).
     * @param {string} className @param {string} ariaLabel @param {() => void} onActivate
     * @param {string} text @param {Object} [extra] extra props (e.g. ref, hidden)
     */
    #iconButton(className, ariaLabel, onActivate, text, extra = {}) {
      return createEl("span", {
        class: className, role: "button", tabindex: "0", "aria-label": ariaLabel,
        onclick: onActivate,
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onActivate(e); } },
        ...extra,
      }, text);
    }

    /** Keep Tab focus cycling inside the dialog (focus trap). */
    #trapFocus(event) {
      const focusable = [...this.#ui.dialog.querySelectorAll('a, button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((el) => !el.disabled && el.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }

    /** Build the whole dialog tree declaratively, capturing element refs into #ui. */
    #buildDom() {
      const ui = this.#ui;
      const rebuildSoon = debounce(() => this.#rebuildList(), 120);
      const ref = (name) => (el) => { ui[name] = el; };

      ui.overlay = createEl("div", {
        class: "uc-tf-overlay",
        id: "uc-tf-overlay",
        onmousedown: (e) => { if (e.target === ui.overlay) this.close(); },
      }, [
        createEl("div", {
          class: "uc-tf-dialog", ref: ref("dialog"),
          role: "dialog", "aria-modal": "true", "aria-labelledby": "uc-tf-title",
          onkeydown: (e) => this.#onDialogKey(e),
        }, [

          // Title bar
          createEl("div", { class: "uc-tf-title" }, [
            createEl("span", { id: "uc-tf-title" }, "Filter tabs"),
            createEl("span", { class: "uc-tf-title-actions" }, [
              this.#iconButton("uc-tf-help", "Help & operators", () => this.#showView(this.#ui.helpPanel.hidden ? "help" : "tabs"), ""),
              this.#iconButton("uc-tf-gear", "Settings", () => this.#showView(this.#ui.settingsPanel.hidden ? "settings" : "tabs"), ""),
              this.#iconButton("uc-tf-close", "Close dialog", () => this.close(), ""),
            ]),
          ]),

          // ===== Tabs panel (the main view) =====
          createEl("div", { class: "uc-tf-panel", ref: ref("tabsPanel") }, [

          // Search row: [.*] [ input  ✕ ] [★]
          createEl("div", { class: "uc-tf-searchrow" }, [
            createEl("button", {
              class: "uc-tf-rebtn uc-tf-field", title: "Toggle regex mode", "aria-label": "Toggle regex mode", ref: ref("regexBtn"),
              onclick: () => this.#setRegexMode(!this.#regexMode),
            }),
            createEl("div", { class: "uc-tf-inputwrap" }, [
              createEl("input", {
                class: "uc-tf-search uc-tf-field", type: "text", placeholder: "Search tabs (title or URL)...",
                "aria-label": "Search tabs", ref: ref("searchInput"),
                oninput: () => {
                  this.#navMode = false; // typing → Space types again (not row-toggle)
                  if (ui.duplicatesCheckbox.checked) ui.duplicatesCheckbox.checked = false;
                  this.#updateClearButton();
                  rebuildSoon();
                },
              }),
              this.#iconButton("uc-tf-clearx", "Clear search",
                () => { ui.searchInput.value = ""; this.#rebuildList(); ui.searchInput.focus(); },
                "", { hidden: true, ref: ref("clearBtn") }),
            ]),
            createEl("button", {
              class: "uc-tf-savebtn uc-tf-field", title: "Save this pattern", "aria-label": "Save this pattern", ref: ref("saveBtn"),
              onclick: () => {
                const query = ui.searchInput.value.trim();
                if (!query) { ui.statusLine.textContent = "Nothing to save."; return; }
                PatternStore.add(query, this.#regexMode);
                this.#renderSavedChips();
              },
            }),
          ]),

          // Saved-pattern chips (filled by #renderSavedChips)
          createEl("div", { class: "uc-tf-chips", ref: ref("chipsRow") }),

          // Recent searches (history) row — shown only when enabled and non-empty.
          // The dropdown's placeholder already says "Recent searches…", so no row label.
          createEl("div", { class: "uc-tf-histrow", hidden: true, ref: ref("histRow") }, [
            (ui.historyDD = new Dropdown({
              ariaLabel: "Recent searches", placeholder: "Recent searches…", className: "uc-tf-histdd",
              onSelect: (item) => { this.#applyHistoryEntry(item.value); ui.historyDD.reset(); },
            })).element,
          ]),

          // Workspace scope row (shown only when cross-workspace is on). The dropdown
          // shows e.g. "All workspaces", so no separate row label.
          createEl("div", { class: "uc-tf-wsrow", hidden: true, ref: ref("wsRow") }, [
            (ui.workspaceDD = new Dropdown({
              ariaLabel: "Workspace scope", className: "uc-tf-wsdd",
              onSelect: (item) => { this.#workspaceScope = item.value === "all" ? "all" : item.value; this.#rebuildList(); },
            })).element,
          ]),

          // Selection row: count + select-all/clear + Duplicates / Search-in-folders
          createEl("div", { class: "uc-tf-selrow" }, [
            createEl("span", { ref: ref("countLabel") }),
            createEl("a", { class: "uc-tf-link", title: "Select all tabs matching the current search", onclick: () => this.#selectAllShown() }, "Select all"),
            createEl("a", { class: "uc-tf-link", title: "Clear the whole selection", onclick: () => this.#clearSelection() }, "Clear all"),
            createEl("label", { class: "uc-tf-toggle uc-tf-toggle--right" }, [
              createEl("input", {
                type: "checkbox", title: "Show duplicate tabs (extra copies of the same URL)",
                ref: ref("duplicatesCheckbox"), onchange: () => this.#rebuildList(),
              }),
              "Duplicates",
            ]),
            createEl("label", { class: "uc-tf-toggle" }, [
              createEl("input", { type: "checkbox", ref: ref("searchFoldersCheckbox"), onchange: () => this.#rebuildList() }),
              "Search in folders",
            ]),
          ]),

          // Results list — virtualized: the sizer holds the full scroll height,
          // and #renderWindow keeps only the visible rows mounted inside it.
          createEl("div", { class: "uc-tf-list", ref: ref("list"), onscroll: () => this.#onScroll() }, [
            createEl("div", { class: "uc-tf-vsizer", ref: ref("sizer") }),
          ]),

          // Destination row — the dropdown carries its own inline name editor for
          // "New Folder" / "New Tab Group" (no separate field), and Enter there moves.
          createEl("div", { class: "uc-tf-destrow" }, [
            (ui.destDD = new Dropdown({
              ariaLabel: "Move destination", placeholder: "Choose a destination…", className: "uc-tf-destdd",
              onConfirm: () => this.#moveChecked(),
            })).element,
          ]),

          // Status line + action buttons
          createEl("div", { class: "uc-tf-status", ref: ref("statusLine") }),
          createEl("div", { class: "uc-tf-btns" }, [
            this.#button("Cancel", false, () => this.close()),
            this.#button("Close selected", false, () => this.#closeSelected()),
            this.#button("Select in tab bar", false, () => this.#selectInTabBar()),
            this.#button("Move to destination", true, () => this.#moveChecked()),
          ]),
          ]), // end tabs panel

          // ===== Settings panel (hidden until the gear is clicked) =====
          this.#buildSettingsPanel(ref),

          // ===== Help panel (hidden until the ? is clicked) =====
          this.#buildHelpPanel(ref),

          // ===== History panel (hidden until "Manage history…" is clicked) =====
          this.#buildHistoryPanel(ref),

          // ===== Theme panel (hidden until "Edit theme…" is clicked) =====
          this.#buildThemePanel(ref),
        ]),
      ]);
    }

    /** Build the settings view (its controls write through `Settings` on change). */
    #buildSettingsPanel(ref) {
      const ui = this.#ui;
      /** A group: small uppercase label + a rounded card holding the rows. */
      const group = (label, ...rows) =>
        createEl("div", { class: "uc-tf-sgroup" }, [
          createEl("div", { class: "uc-tf-sgroup-h" }, label),
          createEl("div", { class: "uc-tf-scard" }, rows),
        ]);
      /** The title + optional sub-line text block on the left of a row. */
      const text = (title, sub) =>
        createEl("div", { class: "uc-tf-srow-text" }, [
          createEl("div", { class: "uc-tf-srow-title" }, title),
          sub ? createEl("div", { class: "uc-tf-srow-sub" }, sub) : null,
        ]);
      /** A toggle-switch row (a styled checkbox so the existing .checked logic is unchanged). */
      const switchRow = (refName, title, sub, onChange) =>
        createEl("label", { class: "uc-tf-srow" }, [
          text(title, sub),
          createEl("span", { class: "uc-tf-switch" }, [
            createEl("input", { type: "checkbox", class: "uc-tf-switch-input", ref: ref(refName), onchange: onChange }),
            createEl("span", { class: "uc-tf-switch-track" }, [createEl("span", { class: "uc-tf-switch-knob" })]),
          ]),
        ]);

      return createEl("div", { class: "uc-tf-panel uc-tf-settings", hidden: true, ref: ref("settingsPanel") }, [
        createEl("div", { class: "uc-tf-panel-scroll" }, [

          group("Search",
            switchRow("setAllWs", "Search across all workspaces", "Look beyond the active workspace", () => {
              Settings.setBool("searchAllWorkspaces", ui.setAllWs.checked);
              this.#workspaceScope = ui.setAllWs.checked ? "all" : undefined;
              this.#syncSettingsControls();
            }),
            switchRow("setEmptyAll", "Empty search shows all tabs", null,
              () => Settings.setBool("emptyShowsAll", ui.setEmptyAll.checked)),
            switchRow("setDefFolders", "Search in folders by default", "Match folder names too, not just title & URL",
              () => Settings.setBool("defaultSearchInFolders", ui.setDefFolders.checked)),
          ),

          group("Window & history",
            switchRow("setKeepOpen", "Keep window open after operation", null,
              () => Settings.setBool("keepOpenAfterAction", ui.setKeepOpen.checked)),
            switchRow("setShowHistory", "Show filter history", null, () => {
              Settings.setBool("showFilterHistory", ui.setShowHistory.checked);
              this.#syncSettingsControls();
            }),
            createEl("div", { class: "uc-tf-srow uc-tf-srow--static" }, [
              text("History dropdown size", "Recent searches kept in the list"),
              createEl("div", { class: "uc-tf-stepper" }, [
                createEl("button", { class: "uc-tf-step", type: "button", "aria-label": "Fewer", onclick: () => this.#bumpHistorySize(-1) }, "−"),
                createEl("span", { class: "uc-tf-step-val", ref: ref("histSizeVal") }),
                createEl("button", { class: "uc-tf-step", type: "button", "aria-label": "More", onclick: () => this.#bumpHistorySize(1) }, "+"),
              ]),
            ]),
            createEl("div", { class: "uc-tf-srow uc-tf-srow--static" }, [
              text("Saved searches", "Review or remove stored queries"),
              createEl("button", { class: "uc-tf-sbtn", onclick: () => this.#showView("history") }, "Manage history…"),
            ]),
          ),

          group("Appearance",
            createEl("div", { class: "uc-tf-srow uc-tf-srow--static" }, [
              text("Theme & accent colour", "Active row, toggles and focus cues"),
              createEl("button", { class: "uc-tf-sbtn", onclick: () => this.#showView("theme") }, [
                createEl("span", { class: "uc-tf-sbtn-dot" }), "Edit theme…",
              ]),
            ]),
            createEl("div", { class: "uc-tf-srow uc-tf-srow--static" }, [
              text("Animations", "How much motion (0% = off)"),
              createEl("div", { class: "uc-tf-slider" }, [
                createEl("input", {
                  type: "range", min: "0", max: "100", step: "5", class: "uc-tf-range",
                  "aria-label": "Animation intensity (percent)", ref: ref("setMotion"),
                  oninput: () => {
                    Settings.setInt("motionScale", parseInt(ui.setMotion.value, 10) || 0);
                    ui.motionVal.textContent = Settings.motionScale + "%";
                    this.#applyMotion();
                  },
                }),
                createEl("span", { class: "uc-tf-slider-val", ref: ref("motionVal") }),
              ]),
            ]),
          ),

          group("Shortcut",
            createEl("label", { class: "uc-tf-srow uc-tf-srow--static" }, [
              text("Open Filter tabs", "Applies after restart"),
              createEl("input", {
                class: "uc-tf-shortcut-rec", type: "text", readOnly: true,
                placeholder: "Click, then press a combo", "aria-label": "Open shortcut", ref: ref("setShortcut"),
                onfocus: () => this.#startRecordingShortcut(),
                onblur: () => this.#stopRecordingShortcut(),
                onkeydown: (e) => this.#onRecordKey(e),
              }),
            ]),
            // Override warning shown when the chosen combo is already bound in Zen.
            createEl("div", { class: "uc-tf-warn", hidden: true, ref: ref("setShortcutWarn") }),
          ),
        ]),
        createEl("div", { class: "uc-tf-btns uc-tf-btns--end" }, [this.#button("Back", true, () => this.#showView("tabs"))]),
      ]);
    }

    /** Step the history-dropdown size pref within [1,50] and reflect it in the UI. */
    #bumpHistorySize(delta) {
      const next = Math.min(50, Math.max(1, Settings.historySize + delta));
      Settings.setInt("historySize", next);
      if (this.#ui.histSizeVal) this.#ui.histSizeVal.textContent = next;
      this.#fillHistoryPicker();
    }

    /** Build the help view: search operators, keyboard shortcuts, and tips. */
    #buildHelpPanel(ref) {
      /** A section: uppercase label + optional muted tag + a hairline rule, then its body. */
      const section = (label, tag, ...body) =>
        createEl("div", { class: "uc-tf-hsec" }, [
          createEl("div", { class: "uc-tf-hsec-h" }, [
            createEl("span", { class: "uc-tf-hsec-l" }, label),
            tag ? createEl("span", { class: "uc-tf-hsec-tag" }, tag) : null,
            createEl("div", { class: "uc-tf-hrule" }),
          ]),
          ...body,
        ]);
      /** A token/key chip on the left, its meaning on the right (chipClass differs for keys). */
      const pairGrid = (chipClass, pairs) =>
        createEl("div", { class: "uc-tf-hgrid" },
          pairs.flatMap(([token, desc]) => [
            createEl(chipClass === "uc-tf-hkbd" ? "span" : "code", { class: chipClass }, token),
            createEl("span", { class: "uc-tf-hdesc" }, desc),
          ]));

      return createEl("div", { class: "uc-tf-panel uc-tf-help-panel", hidden: true, ref: ref("helpPanel") }, [
        createEl("div", { class: "uc-tf-panel-scroll" }, [

          section("Search operators", "smart mode",
            createEl("div", { class: "uc-tf-hnote" },
              "Terms match the tab title and URL together — plus the folder name when “Search in folders” is on. " +
              "Lowercase and / or count as ordinary words."),
            pairGrid("uc-tf-hcode", [
              ["foo bar", "AND — every term must match (a space joins terms)"],
              ["foo AND bar", "Explicit AND — same as a space (must be UPPERCASE)"],
              ["foo | bar", "OR — either side matches"],
              ["foo OR bar", "Explicit OR keyword (must be UPPERCASE)"],
              ["!term  -term", "NOT — exclude tabs containing the term"],
              ['"exact phrase"', "Match the quoted text literally (spaces included)"],
              ["git*  v?", "Wildcards — * any run of chars, ? exactly one"],
              ["git OR *.dev", "Operators combine: groups split on OR, AND inside each"],
            ]),
          ),

          section("Regex mode", "the .* button",
            createEl("div", { class: "uc-tf-hbox" },
              "Turns the whole box into one case-insensitive regular expression — the smart operators above no longer apply. " +
              "Length-capped and nested-quantifier-guarded to keep the UI responsive."),
          ),

          section("Keyboard", null,
            pairGrid("uc-tf-hkbd", [
              ["↑ / ↓", "Move the highlighted row"],
              ["Space", "Toggle the row's selection (and advance)"],
              ["Enter", "Jump to the highlighted tab"],
              ["Ctrl+Enter", "Toggle the row's selection (stay put)"],
              ["Delete", "Close the selection — or the highlighted tab"],
              ["Tab", "Cycle the dialog's controls"],
              ["Esc", "Close the dialog"],
            ]),
          ),

          section("Tips", null,
            createEl("div", { class: "uc-tf-htip" },
              "Your selection persists as you change the search. “Select all” adds every tab in the current search. " +
              "Right-click a result row for domain actions and bookmarking; right-click a tab in the strip for the Tab Filter submenu."),
          ),
        ]),
        createEl("div", { class: "uc-tf-btns uc-tf-btns--end" }, [this.#button("Back", true, () => this.#showView("tabs"))]),
      ]);
    }

    /** Build the history view: the full recent-search list with per-row delete + clear all. */
    #buildHistoryPanel(ref) {
      return createEl("div", { class: "uc-tf-panel uc-tf-history-panel", hidden: true, ref: ref("historyPanel") }, [
        createEl("div", { class: "uc-tf-settings-title" }, "Filter history"),
        createEl("div", { class: "uc-tf-history-list", ref: ref("historyListContainer") }),
        createEl("div", { class: "uc-tf-btns" }, [
          this.#button("Clear all", false, () => {
            this.#confirmInDialog("Clear the entire filter history?", () => { HistoryStore.clear(); this.#renderHistoryList(); });
          }),
          this.#button("Back", true, () => this.#showView("settings")),
        ]),
      ]);
    }

    /** (Re)render the full history list inside the history view. */
    #renderHistoryList() {
      const container = this.#ui.historyListContainer;
      const entries = HistoryStore.load();
      if (!entries.length) {
        container.replaceChildren(createEl("div", { class: "uc-tf-empty" }, "No history yet."));
        return;
      }
      container.replaceChildren(...entries.map((entry, index) =>
        createEl("div", { class: "uc-tf-history-row" }, [
          createEl("span", {
            class: "uc-tf-history-q", title: "Use this search",
            onclick: () => { this.#applyHistoryEntry(entry); },
          }, (entry.regex ? ".* " : "") + entry.q),
          this.#iconButton("uc-tf-history-x", "Remove from history",
            () => { HistoryStore.remove(index); this.#renderHistoryList(); }, "✕"),
        ])));
    }

    /** Apply a history entry to the search box and return to the tab list. */
    #applyHistoryEntry(entry) {
      this.#ui.searchInput.value = entry.q;
      this.#showView("tabs");
      this.#setRegexMode(!!entry.regex); // also rebuilds
      this.#updateClearButton();
    }

    /** Build the theme editor: preset swatches + a colour input per themable variable, with a live preview. */
    #buildThemePanel(ref) {
      return createEl("div", { class: "uc-tf-panel uc-tf-theme-panel", hidden: true, ref: ref("themePanel") }, [
        createEl("div", { class: "uc-tf-settings-title" }, "Edit theme"),
        createEl("div", { class: "uc-tf-theme-scroll" }, [
          this.#themeColorGroup(ref, "Accent colour (active row, toggles, focus)", "themeAccent", "accentInput", "accentHex"),

          // Live preview - the accent drives these, so they recolour instantly. Buttons are
          // intentionally neutral (native Zen look), shown here for reference.
          createEl("div", { class: "uc-tf-theme-prevwrap" }, [
            createEl("div", { class: "uc-tf-theme-prevlabel" }, "Preview"),
            createEl("div", { class: "uc-tf-row uc-tf-row--active uc-tf-theme-prevrow" }, [
              createEl("span", { class: "uc-tf-theme-prevtext" }, "Highlighted row"),
            ]),
            createEl("div", { class: "uc-tf-theme-prevbtns" }, [
              createEl("button", { class: "uc-tf-rebtn uc-tf-rebtn--on uc-tf-field" }),
              createEl("button", { class: "uc-tf-btn uc-tf-btn--primary" }, "Button"),
            ]),
          ]),
        ]),
        createEl("div", { class: "uc-tf-btns" }, [
          this.#button("Reset to defaults", false, () => {
            Settings.setStr("themeAccent", THEME_DEFAULT_ACCENT);
            this.#applyTheme();
            this.#syncThemeControls();
          }),
          this.#button("Back", true, () => this.#showView("settings")),
        ]),
      ]);
    }

    /** One colour row in the theme editor: a swatch strip + a native colour input + the current hex. */
    #themeColorGroup(ref, labelText, prefKey, inputRef, hexRef) {
      const apply = (hex) => {
        Settings.setStr(prefKey, hex || "");
        this.#applyTheme();
        this.#syncThemeControls();
      };
      return createEl("div", { class: "uc-tf-theme-group" }, [
        createEl("div", { class: "uc-tf-theme-label" }, labelText),
        createEl("div", { class: "uc-tf-swatches" }, THEME_SWATCHES.map((color) => this.#swatch(color, apply))),
        createEl("div", { class: "uc-tf-theme-pickrow" }, [
          createEl("input", {
            type: "color", class: "uc-tf-colorinput", "aria-label": labelText + " custom colour",
            ref: ref(inputRef), oninput: () => apply(this.#ui[inputRef].value),
          }),
          createEl("span", { class: "uc-tf-theme-hex", ref: ref(hexRef) }),
        ]),
      ]);
    }

    /** A single clickable preset colour dot. */
    #swatch(color, onPick) {
      return createEl("span", {
        class: "uc-tf-swatch", role: "button", tabindex: "0", title: "Use " + color, style: "background:" + color,
        onclick: () => onPick(color),
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(color); } },
      });
    }

    /** Reflect the persisted theme onto the colour inputs + hex labels. */
    #syncThemeControls() {
      const ui = this.#ui;
      const accent = Settings.themeAccent || THEME_DEFAULT_ACCENT;
      if (ui.accentInput) ui.accentInput.value = accent;
      if (ui.accentHex) ui.accentHex.textContent = accent;
    }

    /** Apply the persisted theme to the overlay's CSS variable (live for this dialog). */
    #applyTheme() {
      const overlay = this.#ui.overlay;
      if (!overlay) return;
      overlay.style.setProperty("--uc-tf-accent", Settings.themeAccent || THEME_DEFAULT_ACCENT);
      this.#applyMotion();
    }

    /** Push the animation-intensity setting (0–100%) to the overlay as a 0–1 multiplier. */
    #applyMotion() {
      const overlay = this.#ui.overlay;
      if (!overlay) return;
      overlay.style.setProperty("--uc-tf-motion", (Settings.motionScale / 100).toString());
    }

    /** Begin capturing a key combo for the shortcut field. */
    #startRecordingShortcut() {
      if (this.#recording) return;
      this.#recording = true;
      this.#shortcutCommitted = false;
      window.gUCTabFilterRecording = true; // the global shortcut listener bails while this is set
      this.#prevShortcut = this.#ui.setShortcut.value;
      this.#ui.setShortcut.value = "";
      this.#ui.setShortcut.placeholder = "Press a combo…  (Esc cancels)";
      this.#ui.setShortcutWarn.hidden = true;
    }

    /** Stop capturing; restore the previous value if nothing was committed. */
    #stopRecordingShortcut() {
      if (!this.#recording) return;
      this.#recording = false;
      window.gUCTabFilterRecording = false;
      this.#ui.setShortcut.placeholder = "Click, then press a combo";
      if (!this.#shortcutCommitted) this.#ui.setShortcut.value = this.#prevShortcut || Settings.shortcut;
    }

    /** Capture a keydown into a shortcut combo (Esc cancels; a key needs Ctrl/Alt/Meta). */
    #onRecordKey(event) {
      if (!this.#recording) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") { this.#ui.setShortcut.blur(); return; } // onblur restores prev
      if (["Control", "Shift", "Alt", "Meta", "OS", "CapsLock", "Dead"].includes(event.key)) {
        this.#ui.setShortcut.value = this.#comboString(event, ""); // live preview of modifiers
        return;
      }
      if (!(event.ctrlKey || event.altKey || event.metaKey)) {
        this.#ui.setShortcut.value = "Add Ctrl / Alt / ⊞ …";
        return; // refuse a bare or shift-only key (would fire constantly)
      }
      const combo = this.#comboString(event, event.key);
      this.#ui.setShortcut.value = combo;
      this.#shortcutCommitted = true;
      Settings.setStr("shortcut", combo);
      this.#ui.setShortcut.blur();
      this.#checkShortcutConflict();
    }

    /** Format a keydown into "Ctrl+Shift+F"-style text (parseShortcutString reads it back). */
    #comboString(event, key) {
      const parts = [];
      if (event.ctrlKey) parts.push("Ctrl");
      if (event.altKey) parts.push("Alt");
      if (event.shiftKey) parts.push("Shift");
      if (event.metaKey) parts.push("Meta");
      if (key) parts.push(key === " " ? "Space" : (key.length === 1 ? key.toUpperCase() : key));
      return parts.join("+");
    }

    /** Warn if the typed shortcut already has a built-in Zen binding (it would override it). */
    async #checkShortcutConflict() {
      const warn = this.#ui.setShortcutWarn;
      const value = this.#ui.setShortcut.value.trim();
      const parsed = parseShortcutString(value);
      const conflict = value && parsed.key ? await ZenTabService.findShortcutConflict(parsed) : null;
      if (this.#ui.setShortcut.value.trim() !== value) return; // changed during await
      if (!conflict) { warn.hidden = true; warn.replaceChildren(); return; }
      const label = await ZenTabService.shortcutLabel(conflict);
      if (this.#ui.setShortcut.value.trim() !== value) return;
      warn.hidden = false;
      warn.replaceChildren(
        createEl("span", {}, `⚠ This overrides "${label}". `),
        createEl("a", {
          class: "uc-tf-link", href: "about:preferences#zenCKS",
          title: "Open Zen keyboard settings to rebind it",
          onclick: (e) => { e.preventDefault(); this.#openZenKeyboardSettings(); },
        }, "Rebind it in Zen keyboard settings"),
      );
    }

    /** Open Zen's keyboard-shortcuts preferences and close the dialog so it's visible. */
    #openZenKeyboardSettings() {
      try { window.openTrustedLinkIn("about:preferences#zenCKS", "tab"); }
      catch (e) { debug(e); }
      this.close();
    }

    /**
     * Switch the dialog body between its panels.
     * @param {"tabs"|"settings"|"help"|"history"} view
     */
    #showView(view) {
      const ui = this.#ui;
      ui.tabsPanel.hidden = view !== "tabs";
      ui.settingsPanel.hidden = view !== "settings";
      ui.helpPanel.hidden = view !== "help";
      ui.historyPanel.hidden = view !== "history";
      ui.themePanel.hidden = view !== "theme";
      if (view === "settings") { this.#syncSettingsControls(); ui.setAllWs.focus(); }
      else if (view === "help") { ui.helpPanel.querySelector(".uc-tf-btn")?.focus(); }
      else if (view === "history") { this.#renderHistoryList(); ui.historyPanel.querySelector(".uc-tf-btn")?.focus(); }
      else if (view === "theme") { this.#syncThemeControls(); ui.themePanel.querySelector(".uc-tf-btn")?.focus(); }
      else { this.#rebuildList(); ui.searchInput.focus(); }
    }

    /** Reflect current settings onto the settings controls + workspace picker. */
    #syncSettingsControls() {
      const ui = this.#ui;
      if (ui.setAllWs) ui.setAllWs.checked = Settings.searchAllWorkspaces;
      if (ui.setEmptyAll) ui.setEmptyAll.checked = Settings.emptyShowsAll;
      if (ui.setDefFolders) ui.setDefFolders.checked = Settings.defaultSearchInFolders;
      if (ui.setKeepOpen) ui.setKeepOpen.checked = Settings.keepOpenAfterAction;
      if (ui.setShowHistory) ui.setShowHistory.checked = Settings.showFilterHistory;
      if (ui.histSizeVal) ui.histSizeVal.textContent = Settings.historySize;
      if (ui.setMotion) { ui.setMotion.value = Settings.motionScale; ui.motionVal.textContent = Settings.motionScale + "%"; }
      if (ui.setShortcut) { ui.setShortcut.value = Settings.shortcut; this.#checkShortcutConflict(); }
      const showPicker = Settings.searchAllWorkspaces;
      ui.wsRow.hidden = !showPicker;
      if (showPicker) this.#fillWorkspacePicker();
      this.#fillHistoryPicker();
    }

    /** Populate the recent-searches dropdown (shown only when enabled and non-empty). */
    #fillHistoryPicker() {
      const ui = this.#ui;
      if (!ui.historyDD) return;
      if (!Settings.showFilterHistory) { ui.histRow.hidden = true; return; }
      const entries = HistoryStore.load().slice(0, Settings.historySize);
      if (!entries.length) { ui.histRow.hidden = true; return; }
      ui.historyDD.setItems(entries.map((entry) => ({
        value: entry, label: (entry.regex ? ".* " : "") + entry.q, icon: entry.regex ? "regex" : "history",
      })));
      ui.historyDD.reset(); // keep the "Recent searches…" placeholder
      ui.histRow.hidden = false;
    }

    /** Record the current non-empty search into history (called when a search leads to an action). */
    #recordHistory() { HistoryStore.add(this.#ui.searchInput.value, this.#regexMode); }

    /**
     * Run after a move/close action: keep the dialog open (refresh + reset selection)
     * when the setting is on, otherwise close it.
     */
    #afterAction() {
      if (!Settings.keepOpenAfterAction) { this.close(); return; }
      this.#selected.clear();
      this.#rebuildList();        // closed tabs vanish; moved tabs may leave the current scope
      this.#fillHistoryPicker();  // a new history entry may have appeared
      this.#navMode = false;      // return to typing mode
      this.#ui.searchInput.focus();
    }

    /** Populate the workspace scope picker (All + every workspace, current marked). */
    #fillWorkspacePicker() {
      const active = ZenTabService.activeWorkspaceId();
      const items = [{ value: "all", label: "All workspaces", icon: "browser" }];
      for (const ws of ZenTabService.getAllWorkspaces()) {
        items.push({ value: ws.uuid, label: ws.rawName + (ws.uuid === active ? " (current)" : ""), emoji: ws.emoji, icon: ws.emoji ? null : "browser" });
      }
      this.#ui.workspaceDD.setItems(items);
      this.#ui.workspaceDD.select(this.#workspaceScope === undefined ? "all" : this.#workspaceScope);
    }

    /** ↑/↓ move the cursor, Enter jumps to the tab, Ctrl+Enter toggles its checkbox. */
    #onDialogKey(event) {
      if (event.key === "Tab") { this.#trapFocus(event); return; } // keep focus inside the modal
      if (event.target.closest(".uc-tf-dd")) return; // let dropdown trigger / inline name editor keep their keys
      const activeTab = this.#filtered[this.#activeIndex];
      if (event.key === "ArrowDown") { event.preventDefault(); this.#navMode = true; this.#setActiveRow(this.#activeIndex + 1); }
      else if (event.key === "ArrowUp") { event.preventDefault(); this.#navMode = true; this.#setActiveRow(this.#activeIndex - 1); }
      else if (event.key === " " && this.#navMode && activeTab) {
        // In navigation mode, Space toggles the highlighted row (and advances) instead of typing.
        event.preventDefault();
        this.#toggleTab(activeTab);
        this.#setActiveRow(this.#activeIndex + 1);
      } else if (event.key === "Enter" && event.ctrlKey) {
        if (activeTab) { event.preventDefault(); this.#toggleTab(activeTab); }
      } else if (event.key === "Enter") {
        if (activeTab) { event.preventDefault(); this.#jumpTo(activeTab); }
      } else if (event.key === "Delete" && this.#navMode) {
        // Gated behind nav mode (like Space) so forward-delete in the search box still edits text.
        event.preventDefault();
        if (this.#selected.size) this.#closeSelected();
        else if (activeTab) this.#closeSingle(activeTab);
      }
    }

    /** Add/remove a tab from the persistent selection. */
    #setSelected(tab, on) { if (on) this.#selected.add(tab); else this.#selected.delete(tab); }

    /** Flip a tab's selection and sync its checkbox if that row is currently mounted. */
    #toggleTab(tab) {
      const on = !this.#selected.has(tab);
      this.#setSelected(tab, on);
      for (const row of this.#rendered.values()) if (row.tab === tab) row.checkbox.checked = on;
      this.#updateCount();
    }

    /** Add every tab in the current search to the selection (Select all = the current search). */
    #selectAllShown() {
      for (const tab of this.#filtered) this.#selected.add(tab);
      for (const row of this.#rendered.values()) row.checkbox.checked = true;
      this.#updateCount();
    }

    /** Clear all: drop the whole selection AND empty the search box (a full reset). */
    #clearSelection() {
      this.#selected.clear();
      for (const row of this.#rendered.values()) row.checkbox.checked = false;
      this.#ui.searchInput.value = "";
      this.#navMode = false;
      this.#rebuildList();              // also updates the ✕ clear button + count
      this.#ui.searchInput.focus();
    }

    /** Show the inline clear (✕) only when the search box has text. */
    #updateClearButton() { this.#ui.clearBtn.hidden = !this.#ui.searchInput.value; }

    /** Toggle regex mode, reflect it on the `.*` button, and rebuild. */
    #setRegexMode(on) {
      this.#regexMode = on;
      this.#ui.regexBtn.classList.toggle("uc-tf-rebtn--on", on);
      this.#rebuildList();
    }

    /** Render the saved-pattern chips (click to apply, ✕ to delete). */
    #renderSavedChips() {
      const patterns = PatternStore.load();
      this.#ui.chipsRow.replaceChildren(
        ...(patterns.length ? [createEl("span", { class: "uc-tf-saved-label" }, "Saved:")] : []),
        ...patterns.map((pattern, index) =>
          createEl("span", {
            class: "uc-tf-chip",
            onclick: () => { this.#ui.searchInput.value = pattern.q; this.#setRegexMode(!!pattern.regex); this.#ui.searchInput.focus(); },
          }, [
            createEl("span", {}, (pattern.regex ? ".* " : "") + pattern.q),
            createEl("span", {
              class: "uc-tf-chip-x",
              onclick: (e) => { e.stopPropagation(); PatternStore.remove(index); this.#renderSavedChips(); },
            }, "✕"),
          ])
        )
      );
    }

    /** Move the keyboard highlight to row `index` (clamped), scrolling it into view. */
    #setActiveRow(index) {
      const total = this.#filtered.length;
      if (!total) { this.#activeIndex = -1; return; }
      this.#activeIndex = Math.max(0, Math.min(index, total - 1));
      const list = this.#ui.list;
      const top = this.#activeIndex * ROW_STEP;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (top + ROW_STEP > list.scrollTop + list.clientHeight) list.scrollTop = top + ROW_STEP - list.clientHeight;
      this.#renderWindow(); // ensure the active row is mounted, then highlight it
    }

    /** Apply the active-row highlight to whichever rows are currently mounted. */
    #applyActiveHighlight() {
      for (const [i, row] of this.#rendered) row.element.classList.toggle("uc-tf-row--active", i === this.#activeIndex);
    }

    /** Re-render the visible window on scroll (throttled to one rAF). */
    #onScroll() {
      if (this.#scrollRaf) return;
      this.#scrollRaf = requestAnimationFrame(() => { this.#scrollRaf = 0; this.#renderWindow(); });
    }

    /** Switch to `tab` and close the dialog (jumping always closes, even in keep-open mode). */
    #jumpTo(tab) { this.#recordHistory(); ZenTabService.jumpToTab(tab); this.close(); }

    /** One entry in the per-row context menu. */
    #ctxItem(label, action) {
      return createEl("div", { class: "uc-tf-ctxitem", onclick: () => { this.#closeRowMenu(); action(); } }, label);
    }

    /** A divider in the per-row context menu. */
    #ctxSeparator() { return createEl("div", { class: "uc-tf-ctxsep" }); }

    /** Right-click a row → a context menu: per-tab actions, plus selection actions if any. */
    #openRowMenu(event, tab) {
      event.preventDefault();
      event.stopPropagation();
      this.#closeRowMenu();
      const domain = ZenTabService.baseDomainOf(tab);
      const items = [
        this.#ctxItem("Jump to tab", () => this.#jumpTo(tab)),
        domain ? this.#ctxItem(`Filter this domain (${domain})`, () => {
          this.#ui.searchInput.value = domain; this.#setRegexMode(false); this.#ui.searchInput.focus();
        }) : null,
        domain ? this.#ctxItem("Select same domain", () => {
          for (const t of ZenTabService.tabsByBaseDomain(domain, this.#workspaceScope)) this.#selected.add(t);
          this.#renderWindow(); this.#updateCount();
        }) : null,
        this.#ctxItem("Close tab", () => {
          ZenTabService.closeTabs([tab]); this.#selected.delete(tab); this.#rebuildList();
        }),
      ];
      // Selection-wide actions (only when something is selected).
      const selected = this.#checkedTabs();
      if (selected.length) {
        items.push(
          this.#ctxSeparator(),
          this.#ctxItem(`Bookmark selected (${selected.length})`, () => this.#bookmarkSelected(false)),
          this.#ctxItem(`Bookmark selected & close (${selected.length})`, () => this.#bookmarkSelected(true)),
        );
      }
      const menu = createEl("div", { class: "uc-tf-ctxmenu" }, items);
      this.#ui.overlay.appendChild(menu);
      this.#rowMenu = menu;
      // Position at the cursor, clamped to the viewport.
      const x = Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8);
      const y = Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8);
      menu.style.left = Math.max(4, x) + "px";
      menu.style.top = Math.max(4, y) + "px";
      // Dismiss on any outside mousedown (added next tick so this click doesn't close it).
      this.#rowMenuDismiss = (e) => { if (!menu.contains(e.target)) this.#closeRowMenu(); };
      setTimeout(() => document.addEventListener("mousedown", this.#rowMenuDismiss, true), 0);
    }

    /** Close the per-row context menu and detach its dismiss handler. */
    #closeRowMenu() {
      if (this.#rowMenuDismiss) { document.removeEventListener("mousedown", this.#rowMenuDismiss, true); this.#rowMenuDismiss = null; }
      if (this.#rowMenu) { this.#rowMenu.remove(); this.#rowMenu = null; }
    }

    /** Bookmark the current selection (into a new Bookmarks-Menu folder); optionally close them after. */
    async #bookmarkSelected(thenClose) {
      const tabs = this.#checkedTabs();
      if (!tabs.length) return;
      try {
        const count = await ZenTabService.bookmarkTabs(tabs);
        this.#ui.statusLine.textContent = count ? `Bookmarked ${count} tab(s).` : "No bookmarkable tabs.";
        if (thenClose && count) {
          ZenTabService.closeTabs(tabs);
          for (const tab of tabs) this.#selected.delete(tab);
          this.#rebuildList();
        }
      } catch (error) {
        this.#ui.statusLine.textContent = "Bookmark error: " + error.message;
        console.error("[ZenTabPalette] bookmark error", error);
      }
    }

    /** Refresh the count: total selected (across searches) + how many are in the current view. */
    #updateCount() {
      const total = this.#checkedTabs().length;
      const shown = this.#filtered.length;
      let shownSelected = 0;
      for (const tab of this.#filtered) if (this.#selected.has(tab)) shownSelected++;
      const dup = this.#ui.duplicatesCheckbox.checked ? " (duplicates)" : "";
      this.#ui.countLabel.textContent = `Selected ${total}${shown ? ` · ${shownSelected}/${shown} shown` : ""}${dup}`;
    }

    /**
     * Recompute the visible tab list from the current query / toggles and rebuild
     * the rows. This is effectively the "render" for the dynamic part of the UI.
     */
    #rebuildList() {
      const ui = this.#ui;
      if (!ui.overlay?.isConnected) return; // dialog closed before a debounced rebuild fired
      const query = ui.searchInput.value.trim();
      const scope = this.#workspaceScope;
      this.#closeRowMenu();
      this.#updateClearButton();

      // Clear any previous empty/error message (the sizer itself always stays).
      ui.list.querySelectorAll(".uc-tf-empty, .uc-tf-error").forEach((node) => node.remove());

      let tabs;
      let emptyMsg = "No matching tabs.";
      if (ui.duplicatesCheckbox.checked) {
        tabs = ZenTabService.getDuplicateTabs(ui.searchFoldersCheckbox.checked, scope);
        emptyMsg = "No duplicate tabs.";
        ui.searchInput.classList.remove("uc-tf-search--error");
      } else if (!query && !Settings.emptyShowsAll) {
        tabs = [];
        emptyMsg = "Type to search.";
        ui.searchInput.classList.remove("uc-tf-search--error");
      } else {
        const matcher = ZenTabService.makeMatcher(query, this.#regexMode);
        if (matcher && matcher.error) {
          this.#filtered = []; this.#rendered.clear(); this.#activeIndex = -1;
          ui.sizer.replaceChildren(); ui.sizer.style.height = "0px";
          ui.list.appendChild(createEl("div", { class: "uc-tf-error" }, "Invalid regex: " + matcher.error));
          ui.searchInput.classList.add("uc-tf-search--error");
          this.#updateCount();
          return;
        }
        ui.searchInput.classList.remove("uc-tf-search--error");
        tabs = ZenTabService.getMatchingTabs(query, this.#regexMode, ui.searchFoldersCheckbox.checked, scope);
      }

      this.#filtered = tabs;
      this.#activeIndex = tabs.length ? 0 : -1;
      ui.sizer.style.height = (tabs.length * ROW_STEP) + "px";
      ui.list.scrollTop = 0;
      this.#renderWindow();
      if (!tabs.length) ui.list.appendChild(createEl("div", { class: "uc-tf-empty" }, emptyMsg));
      this.#updateCount();
    }

    /**
     * Virtualization: mount only the rows visible in the scroll viewport (plus a
     * small buffer), positioned by absolute transform inside the full-height sizer.
     */
    #renderWindow() {
      const ui = this.#ui;
      const total = this.#filtered.length;
      this.#rendered.clear();
      if (!total) { ui.sizer.replaceChildren(); return; }
      const viewport = ui.list.clientHeight || 400;
      const first = Math.max(0, Math.floor(ui.list.scrollTop / ROW_STEP) - ROW_BUFFER);
      const last = Math.min(total, Math.ceil((ui.list.scrollTop + viewport) / ROW_STEP) + ROW_BUFFER);
      const rowEls = [];
      for (let i = first; i < last; i++) rowEls.push(this.#renderRow(this.#filtered[i], i));
      ui.sizer.replaceChildren(...rowEls);
      this.#applyActiveHighlight();
    }

    /**
     * Build one result row (checkbox + favicon + title/URL + folder badge), place
     * it at its virtualized position, and register it in #rendered. @returns {HTMLElement}
     */
    #renderRow(tab, index) {
      let checkbox;
      const url = ZenTabService.urlOf(tab).replace(/^https?:\/\//, "");
      const folderLabel = ZenTabService.folderLabelOfTab(tab);
      // Which workspace a tab is in only matters when searching across all of them.
      const workspaceName = this.#workspaceScope === "all" ? ZenTabService.workspaceNameOf(tab) : "";
      // The whole row is a selection toggle. Clicking anywhere flips the checkbox;
      // double-click (mouse) or ↑/↓+Enter (keyboard) jumps to the tab instead.
      const rowEl = createEl("div", {
        class: "uc-tf-row",
        onclick: (e) => {
          if (e.target === checkbox) return; // a direct checkbox click toggles itself (fires change)
          checkbox.checked = !checkbox.checked;
          this.#setSelected(tab, checkbox.checked);
          this.#updateCount();
        },
        ondblclick: () => this.#jumpTo(tab),
        oncontextmenu: (e) => this.#openRowMenu(e, tab),
      }, [
        createEl("input", {
          class: "uc-tf-cb", type: "checkbox", checked: this.#selected.has(tab),
          "aria-label": "Select " + (tab.label || "tab"),
          ref: (el) => (checkbox = el),
          onchange: () => { this.#setSelected(tab, checkbox.checked); this.#updateCount(); },
        }),
        createEl("div", { class: "uc-tf-content", title: "Click to select · double-click to open" }, [
          createEl("img", {
            class: "uc-tf-fav", width: 16, height: 16,
            src: ZenTabService.faviconOf(tab) || DEFAULT_FAVICON,
            onerror: (e) => { e.target.onerror = null; e.target.src = DEFAULT_FAVICON; }, // clear handler first so a failing fallback can't loop
          }),
          createEl("div", { class: "uc-tf-col" }, [
            createEl("span", { class: "uc-tf-title-text" }, tab.label || "(no title)"),
            url ? createEl("span", { class: "uc-tf-url" }, url) : null,
          ]),
        ]),
        workspaceName ? createEl("span", { class: "uc-tf-wsbadge" }, "🪟 " + workspaceName) : null,
        folderLabel ? createEl("span", { class: "uc-tf-badge" }, "📁 " + folderLabel) : null,
      ]);
      rowEl.style.transform = `translateY(${index * ROW_STEP}px)`; // virtualized position
      this.#rendered.set(index, { tab, checkbox, element: rowEl });
      return rowEl;
    }

    /**
     * Snapshot folders/groups/workspaces and (re)populate the destination dropdown:
     * Create-new · active-workspace Folders · Tab Groups · then one section per other
     * workspace (root move + that workspace's folders). Each option's `value` IS its
     * action descriptor, read back by #selectedAction.
     */
    #fillDestinations() {
      this.#folders = ZenTabService.getFolders();
      this.#groups = ZenTabService.getGroups();
      this.#workspaces = ZenTabService.getWorkspaces();
      const activeWorkspace = ZenTabService.activeWorkspaceId();

      const folderItem = (folder) => ({
        // Show only the folder's own name; the indentation conveys nesting and the
        // full path stays in the tooltip (title). Logic is unchanged — `value` is the folder.
        value: { type: "folder", folder }, label: folder.label,
        icon: "folder", depth: folder.depth, title: folder.path,
      });
      const activeFolders = this.#folders.filter((f) => !f.workspaceId || f.workspaceId === activeWorkspace);

      const items = [
        { header: "Create new" },
        { value: { type: "newfolder" }, label: "New Folder", icon: "plus", editable: true, editPlaceholder: "New folder name…", action: true },
        { value: { type: "newgroup" }, label: "New Tab Group", icon: "group", editable: true, editPlaceholder: "New group name…", action: true },
      ];
      if (activeFolders.length) items.push({ header: "Folders" }, ...activeFolders.map(folderItem));
      if (this.#groups.length) {
        items.push({ header: "Tab Groups" });
        items.push(...this.#groups.map((group) => ({ value: { type: "group", group }, label: group.label, icon: "group" })));
      }
      for (const workspace of this.#workspaces) {
        // Divider above each workspace section so the per-workspace blocks read apart.
        items.push({ header: (workspace.emoji ? workspace.emoji + " " : "") + workspace.rawName, divider: true });
        items.push({ value: { type: "workspace", workspace }, label: "Move to workspace root", icon: "browser", action: true });
        // Create a new folder directly in THIS workspace (no need to switch to it first).
        items.push({
          value: { type: "newfolder", workspace }, label: "New folder here", icon: "plus",
          editable: true, editPlaceholder: "New folder in " + workspace.rawName + "…", action: true,
        });
        items.push(...this.#folders.filter((f) => f.workspaceId === workspace.uuid).map(folderItem));
      }

      this.#ui.destDD.setItems(items);
      this.#ui.destDD.reset(); // start at the placeholder; the user picks a destination
    }

    /** @returns {?Object} action descriptor for the currently selected destination. */
    #selectedAction() { return this.#ui.destDD.value || null; }

    /** @returns {MozTabbrowserTab[]} the persistent selection, minus any tab since closed. */
    #checkedTabs() { return [...this.#selected].filter((tab) => tab.isConnected && !tab.closing); }

    /** Move the checked tabs to the chosen destination, then close (errors → status). */
    #moveChecked() {
      const ui = this.#ui;
      const tabs = this.#checkedTabs();
      if (!tabs.length) { ui.statusLine.textContent = "Select at least one tab."; return; }
      const action = this.#selectedAction();
      if (!action) { ui.statusLine.textContent = "Choose a destination."; return; }
      try {
        switch (action.type) {
          case "newfolder":
            ZenTabService.createFolder(tabs, ui.destDD.editValue || "New Folder", action.workspace?.uuid);
            break;
          case "newgroup": {
            const color = GROUP_COLORS[(this.#folders.length + this.#groups.length) % GROUP_COLORS.length];
            ZenTabService.createGroup(tabs, ui.destDD.editValue || "New Group", color);
            break;
          }
          case "folder":
            if (!action.folder.element?.isConnected) throw new Error("Folder no longer exists");
            ZenTabService.moveToFolder(tabs, action.folder.element, action.folder.workspaceId);
            break;
          case "group":
            if (!action.group.element?.isConnected) throw new Error("Tab group no longer exists");
            ZenTabService.moveToGroup(tabs, action.group.element);
            break;
          case "workspace":
            ZenTabService.moveToWorkspace(tabs, action.workspace.uuid);
            break;
        }
        this.#recordHistory();
        ui.statusLine.textContent = `Moved ${tabs.length} tab(s).`;
        this.#afterAction();
      } catch (error) {
        ui.statusLine.textContent = "Error: " + error.message;
        console.error("[ZenTabPalette] move error", error);
      }
    }

    /**
     * Hand the checked tabs to Zen's native tab-strip multi-selection (as if you
     * Ctrl-clicked them in the tab bar), then close so you can use native tab tools
     * (drag, native right-click, move to new window, etc.) on the search result.
     */
    #selectInTabBar() {
      const tabs = this.#checkedTabs();
      if (!tabs.length) { this.#ui.statusLine.textContent = "Select at least one tab."; return; }
      try { ZenTabService.multiSelect(tabs); } catch (e) { console.error(e); }
      this.#recordHistory();
      this.close();
    }

    /** Ask for confirmation, then close the checked tabs (honors keep-open). */
    #closeSelected() {
      const tabs = this.#checkedTabs();
      if (!tabs.length) { this.#ui.statusLine.textContent = "Select at least one tab."; return; }
      this.#confirmInDialog(`Close ${tabs.length} tab(s)?`, () => {
        ZenTabService.closeTabs(tabs);
        this.#recordHistory();
        this.#ui.statusLine.textContent = `Closed ${tabs.length} tab(s).`;
        this.#afterAction();
      });
    }

    /** Close a single tab (the keyboard-highlighted one) without a confirm prompt; honors keep-open. */
    #closeSingle(tab) {
      if (!tab?.isConnected) return;
      ZenTabService.closeTabs([tab]);
      this.#selected.delete(tab);
      if (Settings.keepOpenAfterAction) {
        this.#rebuildList();
        this.#navMode = false;          // return to typing mode
        this.#ui.searchInput.focus();
      } else {
        this.close();
      }
    }

    /**
     * Show a small in-dialog confirmation (avoids the ugly native window.confirm).
     * @param {string} message
     * @param {() => void} onConfirm
     */
    #confirmInDialog(message, onConfirm) {
      const dismiss = () => { backdrop.remove(); this.#ui.searchInput.focus(); };
      const cancelBtn = this.#button("Cancel", false, dismiss);
      const confirmBtn = this.#button("Confirm", true, () => { backdrop.remove(); onConfirm(); });
      // Toggle focus between the two buttons (Left/Right/Tab all just flip).
      const toggleFocus = () => (document.activeElement === confirmBtn ? cancelBtn : confirmBtn).focus();
      const backdrop = createEl("div", {
        class: "uc-tf-confirm",
        // Own all keys while open: stopPropagation keeps the list nav (#onDialogKey) and the
        // document Esc handler (which would close the whole dialog) from firing behind it.
        onkeydown: (event) => {
          event.stopPropagation();
          if (event.key === "Escape") { event.preventDefault(); dismiss(); }
          else if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Tab") {
            event.preventDefault(); toggleFocus();
          }
          // Enter/Space activate the focused button natively.
        },
      }, [
        createEl("div", { class: "uc-tf-confirm-box", role: "dialog", "aria-modal": "true" }, [
          createEl("div", { class: "uc-tf-confirm-msg" }, message),
          createEl("div", { class: "uc-tf-confirm-row" }, [cancelBtn, confirmBtn]),
        ]),
      ]);
      this.#ui.dialog.appendChild(backdrop);
      confirmBtn.focus(); // start on the primary action so Enter confirms, ←/→ moves to Cancel
    }
  }

  // =====================================================================
  //  Bootstrap
  // =====================================================================
  /**
   * Parse the shortcut pref into a comparable descriptor.
   * @returns {{ctrl:boolean,shift:boolean,alt:boolean,meta:boolean,key:string}}
   */
  /** Parse a shortcut string like "Ctrl+Shift+F" into a comparable descriptor. */
  function parseShortcutString(raw) {
    const parts = (raw || "").toLowerCase().split("+").map((part) => part.trim()).filter(Boolean);
    return {
      ctrl: parts.includes("ctrl") || parts.includes("control"),
      shift: parts.includes("shift"),
      alt: parts.includes("alt"),
      meta: parts.includes("meta") || parts.includes("cmd") || parts.includes("win"),
      key: parts[parts.length - 1] || "",
    };
  }

  function parseShortcut() {
    let raw = "Ctrl+Shift+F";
    try { raw = Services.prefs.getStringPref(SHORTCUT_PREF, raw) || raw; } catch (e) { debug(e); }
    const parsed = parseShortcutString(raw);
    if (!parsed.key) parsed.key = "f";
    return parsed;
  }

  /**
   * Link the sibling stylesheet into this window once - ONLY under fx-autoconfig.
   * fx-autoconfig exposes UC_API/_ucUtils and registers chrome://userscripts/, so the
   * <link> resolves. Under Sine there is no fx-autoconfig (and no such chrome path);
   * Sine loads tab-filter.css itself from the mod's theme.json "style.chrome", so we
   * skip injecting to avoid a dead/invalid stylesheet link.
   */
  function injectStylesheet() {
    if (document.getElementById("uc-tf-style-link")) return;
    if (!(window.UC_API || window._ucUtils)) return; // not fx-autoconfig (e.g. Sine) -> loader handles CSS
    try {
      document.documentElement.appendChild(
        createEl("link", { id: "uc-tf-style-link", rel: "stylesheet", href: STYLESHEET_URL })
      );
    } catch (e) { debug(e); }
  }

  /**
   * Per-window setup (runs once per browser window): load styles, expose the
   * open function, bind the shortcut, and add the tab context-menu entry.
   */
  function initWindow() {
    if (window.gUCTabFilterInit) return;
    window.gUCTabFilterInit = true;

    injectStylesheet();
    window.gUCTabFilterOpenDialog = (initialQuery) => new FilterDialog().open(initialQuery);

    // Configurable shortcut (about:config -> extensions.uctabfilter.shortcut), default
    // Ctrl+Shift+F (no built-in conflict, so Print etc. stay intact). Capture phase +
    // stopPropagation so that IF a user deliberately picks a combo with a built-in binding
    // (e.g. Ctrl+P = Print) it overrides it cleanly instead of firing both. We only act on
    // the exact configured combo, so every other key passes through untouched.
    const shortcut = parseShortcut();
    window.addEventListener("keydown", (event) => {
      if (window.gUCTabFilterRecording) return; // don't trigger while the settings field is capturing
      const key = (event.key || "").toLowerCase();
      if (event.ctrlKey === shortcut.ctrl && event.shiftKey === shortcut.shift &&
          event.altKey === shortcut.alt && event.metaKey === shortcut.meta && key === shortcut.key) {
        event.preventDefault();
        event.stopPropagation();
        window.gUCTabFilterOpenDialog();
      }
    }, true);

    addTabContextItems();
  }

  /**
   * Add three flat menuitems to the top of the tab right-click menu (XUL, built
   * with createXULElement): Filter by domain, Select same domain, Filter tabs…,
   * plus a separator. Static labels and NO popupshowing listener — adding a second
   * popupshowing handler to tabContextMenu was what broke the native menu; the
   * domain is resolved at click time instead.
   */
  function addTabContextItems() {
    const contextMenu = document.getElementById("tabContextMenu");
    if (!contextMenu || document.getElementById("uc-tf-ctx-domain")) return;

    const contextTab = () => window.TabContextMenu?.contextTab || gBrowser.selectedTab;
    const item = (id, label, onCommand) => {
      const mi = document.createXULElement("menuitem");
      mi.id = id;
      mi.setAttribute("label", label);
      mi.addEventListener("command", onCommand);
      return mi;
    };

    const filterByDomain = item("uc-tf-ctx-domain", "Filter by domain", () => {
      window.gUCTabFilterOpenDialog(ZenTabService.baseDomainOf(contextTab()));
    });
    const selectSameDomain = item("uc-tf-ctx-seldomain", "Select same domain", () => {
      const domain = ZenTabService.baseDomainOf(contextTab());
      const scope = Settings.searchAllWorkspaces ? "all" : undefined;
      const tabs = ZenTabService.tabsByBaseDomain(domain, scope);
      if (tabs.length) try { ZenTabService.multiSelect(tabs); } catch (e) { debug(e); }
    });
    const openDialog = item("uc-tf-ctx-open", "🔍 Filter tabs…", () => window.gUCTabFilterOpenDialog());
    const separator = document.createXULElement("menuseparator");
    separator.id = "uc-tf-ctx-sep";

    // Insert at the very top, in order, followed by a separator.
    contextMenu.insertBefore(separator, contextMenu.firstChild);
    contextMenu.insertBefore(openDialog, separator);
    contextMenu.insertBefore(selectSameDomain, openDialog);
    contextMenu.insertBefore(filterByDomain, selectSameDomain);
    console.log("[ZenTabPalette] tab context items added");
  }

  /**
   * Register the CustomizableUI toolbar button once for the whole app. No
   * defaultArea, so it lands in the Customize palette for the user to place.
   * onCommand resolves the originating window and calls its open function.
   */
  function registerToolbarButton() {
    let customizableUI = window.CustomizableUI;
    if (!customizableUI) {
      try { ({ CustomizableUI: customizableUI } = ChromeUtils.importESModule("resource:///modules/CustomizableUI.sys.mjs")); }
      catch (e) { console.error("[ZenTabPalette] CustomizableUI import failed", e); return; }
    }
    try {
      const existing = customizableUI.getWidget(WIDGET_ID);
      if (existing && existing.provider === customizableUI.PROVIDER_API) return; // already registered
      customizableUI.createWidget({
        id: WIDGET_ID,
        type: "button",
        label: "Filter Tabs",
        tooltiptext: "Filter tabs (Ctrl+Shift+F)",
        removable: true,
        onCommand(event) {
          const win = event?.target?.ownerGlobal || event?.view || event?.target?.ownerDocument?.defaultView ||
            Services.wm.getMostRecentWindow("navigator:browser");
          if (win && typeof win.gUCTabFilterOpenDialog === "function") win.gUCTabFilterOpenDialog();
          else console.error("[ZenTabPalette] button: openDialog not found on window", win);
        },
      });
    } catch (e) { console.error("[ZenTabPalette] createWidget failed", e); }
  }

  /** App-wide widget registration + this window's setup. */
  function start() { registerToolbarButton(); initWindow(); }

  // Run after the browser window has finished its delayed startup.
  if (window.gBrowserInit?.delayedStartupFinished) {
    start();
  } else {
    const onStartupFinished = (subject) => {
      if (subject === window) {
        Services.obs.removeObserver(onStartupFinished, "browser-delayed-startup-finished");
        start();
      }
    };
    Services.obs.addObserver(onStartupFinished, "browser-delayed-startup-finished");
  }
})();
