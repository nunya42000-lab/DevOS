
/* --- 1. SOVEREIGN DATABASE (Dexie.js) --- */
// Guarded: Dexie only powers the secondary version-history/vault-migration
// feature, but a failed CDN load here used to throw BEFORE `window.Nexus`
// was ever assigned, silently taking down the entire app (every subsystem)
// over a dependency none of the core editing/file-storage code even uses.
// If it fails to load, fall back to an inert stand-in with the same shape
// so the 6+ call sites elsewhere don't need to change, and everything else
// keeps working.
let db;
try {
    db = new Dexie('NexusCodexDB');
    db.version(1).stores({
       files: '++id, name, path, extension, lastModified',
       contents: '++id, fileId, content',
       vault: '++id, title, category, content',
       history: '++id, timestamp, fileId, content' 
    });
} catch (e) {
    console.error("VORTEX: Dexie failed to load — version history and vault sync will be unavailable this session, but the editor and file storage are unaffected.", e);
    const inertTable = () => ({
        where: () => ({ equals: () => ({ first: async () => undefined, toArray: async () => [] }) }),
        add: async () => undefined,
        bulkAdd: async () => undefined,
        toArray: async () => [],
        clear: async () => undefined,
    });
    db = { files: inertTable(), contents: inertTable(), vault: inertTable(), history: inertTable() };
}

// FIX (real freeze source, and this one hits BEFORE any file-open check
// even runs): every localforage.getItem/setItem call across this whole
// file (18 of them) had zero timeout — unlike a network fetch, IndexedDB
// access is normally near-instant, but it CAN genuinely stall under real,
// documented browser conditions (a stuck transaction, a corrupted
// database, certain private-browsing/storage-partitioning edge cases
// where the browser silently never resolves the request rather than
// rejecting it). Vfs.boot() — the very first thing awaited in the entire
// app boot sequence, running unconditionally regardless of whether any
// file is open — does FOUR sequential localforage.getItem() calls before
// it even reaches the "is there a file to open" check that leads to
// setEmptyState(). A stall on any one of those four hangs boot itself,
// before file state is ever determined — which is exactly why this
// freeze happens with no files open at all, unlike the CM6-import and
// Night-Cycle freezes fixed earlier (both gated on having a file/JS
// content to act on).
//
// Wraps every localforage call through a single shared, always-timeout-
// protected function instead of patching all 18 call sites individually
// by hand (real risk of missing one) — same withTimeout race-against-a-
// deadline technique already used for the CM6 import chain and GitHub
// fetches, applied here as one central choke point so nothing new added
// later can accidentally skip this protection either.
const STORAGE_TIMEOUT_MS = 8000;
const safeStorage = {
    async getItem(key) {
        try {
            return await Promise.race([
                localforage.getItem(key),
                new Promise((_, reject) => setTimeout(() => reject(new Error(`localforage.getItem('${key}') timed out`)), STORAGE_TIMEOUT_MS))
            ]);
        } catch (e) {
            console.error(`VORTEX STORAGE: getItem('${key}') failed or timed out — continuing with no saved value.`, e);
            return null; // same shape a genuinely-empty key returns, so every existing "if (saved) ..." check downstream keeps working unchanged
        }
    },
    async setItem(key, value) {
        try {
            return await Promise.race([
                localforage.setItem(key, value),
                new Promise((_, reject) => setTimeout(() => reject(new Error(`localforage.setItem('${key}') timed out`)), STORAGE_TIMEOUT_MS))
            ]);
        } catch (e) {
            console.error(`VORTEX STORAGE: setItem('${key}') failed or timed out — this save was not persisted.`, e);
            if (typeof Nexus !== 'undefined' && Nexus.shell && typeof Nexus.shell.out === 'function') {
                Nexus.shell.out(`⚠️ Save to storage failed for '${key}' — your change may not persist across a reload.`, 'error');
            }
            return null;
        }
    }
};

window.Nexus = {
   // MERGED STATE OBJECT
   state: {
       activeFileId: null,
       activeFileName: "NONE",
       activeFile: "",
       isCM6: false,
       Vfs: {}, 
       // Which loaded files currently have an open tab, in tab-bar order.
       // Previously renderTabs() iterated Object.keys(Vfs) directly, which
       // meant "loaded into the workspace" and "has an open tab" were the
       // same thing — every file you'd ever opened stayed a tab forever,
       // and the tab bar's own × button called deleteFile() (permanently
       // destructive) because there was no lesser "just close the tab"
       // concept to call instead. Files now sit in the left explorer until
       // switchFile() (i.e. actually clicking one) adds them here.
       openTabs: [],
       // Per-file snapshot of content as of the last successful save,
       // keyed by filename. This is what makes "unsaved work" a real,
       // checkable fact instead of a guess: Vfs[fn] is written to
       // continuously (every keystroke, via the CM6/vanilla autosave
       // listeners) with no prior separate "committed" baseline to diff
       // against, so closing a tab had no way to know whether anything
       // had actually changed since disk. Written every time Vfs.save()
       // actually persists successfully — see isDirty() and closeTab().
       lastSavedContent: {},
       history: { past: [], future: [], isLocked: false },
       originals: {}, 
       vault: [], 
       snapshots: [],
       // Per-file, line-based bookmarks: { [filename]: [{line, label}] }.
       // Previously a flat {name: characterOffset} map shared across every
       // file, which meant (a) a bookmark set in one file was silently
       // indistinguishable from one in another if they reused a name, and
       // (b) the raw character offset went stale the instant anything
       // before it in the file was edited — a bookmark on line 500 would
       // silently point at whatever text now happened to sit at that same
       // byte offset, not line 500 anymore. Line numbers drift less often
       // in practice (only when lines are inserted/deleted above the
       // bookmark, which the CM6 gutter's own StateField already remaps
       // correctly via transaction.changes) and are meaningful across
       // files, which raw offsets never were.
       bookmarks: {},
       lastSweep: {}, // { [filename]: { issues: [{id,...}], graphSize: n } } — session-only baseline for neural.analyzeDelta
       prefs: { 
           fontSize: 14, 
           tabWidth: 4, 
           kbPos: 'bottom', 
           kbRows: 3,
           utilDock: 'dock-right',
           customVocab: "Your, custom, words, here",
           kbLayouts: {},
           ghToken: "",
           ghRepo: "",
           activeEngine: 'vanilla',
           indentGuides: true,

           // AUDIT FIX: the 16 keys below were all read and written
           // throughout the app but never declared here — each was added
           // incrementally over time and relied purely on scattered inline
           // fallbacks (`|| 'x'`, `!== false`, `!!`) at each individual
           // read site. Not a crash (those fallbacks work), but it left
           // this object no longer describing the app's real settings
           // surface, and meant each key's "true" default was implicit,
           // duplicated across every read, and easy to make inconsistent
           // between two call sites. Declared explicitly here so there's
           // one authoritative answer per setting. Values chosen to match
           // exactly what the existing inline fallbacks already produced,
           // so this changes no current behavior — verified against each
           // read site rather than assumed.
           editMode: 'util',          // setEditMode collapses anything unrecognized to 'util'
           outdoorMode: false,        // dark is the base theme; outdoor-mode is the opt-in override
           wordWrap: false,           // read as !!prefs.wordWrap
           showWhitespace: false,     // read as !!prefs.showWhitespace
           bracketTracing: true,      // read as prefs.bracketTracing !== false
           showChangeGutter: true,    // diff-as-you-type gutter (Feature 4) — on by default, same reasoning as bracket tracing/sticky scroll: a passive visual aid, not a behavior change
           bookmarkingEnabled: true,  // real on/off switch for placing bookmarks at all, not just where the button lives — see toggleBookmarkHere()'s own comment
           explorerSort: 'type',      // 'type' (existing behaviour — group by extension, flat list) or 'tree' (real nested folder view, built from the folder/file.ext paths already used for storage)
           stickyScroll: true,        // read as prefs.stickyScroll !== false
           minimap: false,            // opt-in, per its toggle's own reasoning
           lintEnabled: false,        // opt-in — the Diagnostics Hub already covers this ground
           autocomplete: false,       // opt-in — changes typing behavior
           infiniteScroll: false,     // ribbon infinite scroll, off by default
           navButtonsHidden: false,   // arrow-key group starts visible
           utilBarCollapsed: false,
           diagFilterEnabled: false,
           utilLayout: null,          // null => fall back to DEFAULT_UTIL_LAYOUT
           navDrawerLayout: null,     // null => fall back to DEFAULT_NAV_DRAWER_LAYOUT
           widgetVisibility: null     // null => use the state.widgets defaults below
       },
       searchOpts: { case: false, regex: false, global: false },
       // FIX (real regression, found via on-device diagnosis): searchDrawer
       // and writerDrawer used to be dead keys here (stale kebab-case IDs
       // matching nothing in the HTML), so this whole mechanism had no
       // effect on them at all. Correcting the IDs in an earlier pass made
       // updateWidgets() start ACTUALLY applying to them — but nothing
       // reconciled that against the separate, newer .transform-drawer /
       // toggleDrawer() system these two are really driven by. Every boot
       // and updateWidgets() call was stamping `style.display = 'none'`
       // directly onto both elements (an INLINE style, which beats any
       // stylesheet rule regardless of specificity or !important) since
       // both defaulted to false here — permanently hiding them no matter
       // what toggleDrawer()'s own .open class correctly did. Confirmed
       // directly on-device: getComputedStyle showed .open applied,
       // transform: none, and display: none simultaneously — display:none
       // short-circuits transform computation entirely, which is exactly
       // that signature. Removed both from this registry; they are not
       // simple show/hide widgets, they're drawers, and toggleDrawer()
       // already owns their visibility correctly on its own.
       widgets: { 'utilityBar': false, 'nexusDpad': false }
   },
compiler: {
    // Translates your mobile macros into executable code
    preprocess(rawCode) {
        if (!rawCode) return "";
        
        // Replace 'ZZ' with '//' globally
        let compiled = rawCode.replace(/ZZ/g, '//');
        
        // Optional: You can add other mobile shortcuts here later!
        // e.g., replacing 'QQ' with a backslash if needed
        
        return compiled;
    }
},

   // ADDED MISSING EDITOR CORE DEFINITION
   editorCore: {
       isCM6: false,
       isLoaded: false,
       view: null,
       modules: {},

       // FIX (the actual "locks up" mechanism): the CM6 boot's 13 dynamic
       // import() calls (all live esm.sh fetches, no local caching beyond
       // whatever the service worker/browser HTTP cache happens to hold)
       // had no timeout at all. A slow or STALLING connection — as
       // distinct from an outright failed one — never rejects on its own;
       // fetch() has no built-in timeout, so a connection that opens but
       // never completes just sits there indefinitely. Promise.all
       // inherits that same non-resolution: it doesn't reject just
       // because one of its inputs is slow, it waits for every one of
       // them to settle, forever if even one never does. This is why the
       // existing try/catch around this whole boot sequence never caught
       // anything in that case — a stall was never actually an error to
       // catch, just a Promise that never finished. Wraps any promise in
       // a race against a hard deadline, converting "never resolves" into
       // a real, catchable rejection after a reasonable wait — restoring
       // the actual point of a try/catch that was already there but had
       // nothing to catch.
       withTimeout(promise, ms, label) {
           let timer;
           const timeout = new Promise((_, reject) => {
               timer = setTimeout(() => reject(new Error(`${label || 'Operation'} timed out after ${ms}ms — check your network connection.`)), ms);
           });
           return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
       },

       // Adds real padding-bottom to .cm-content sized to ~15 rendered
       // lines, so the editor can scroll past the last line of code
       // instead of pinning it to the bottom edge. Reads the ACTUAL
       // rendered height of a real .cm-line in the DOM (not a guessed
       // ratio of font-size), so this stays correct across font-size
       // preference changes, different fonts, and different browsers'
       // font metrics — a hardcoded pixel number would silently drift
       // wrong the moment any of those changed.
       applyScrollPastEnd(targetLines = 15) {
           if (!this.view) return;
           // Let CM6 finish its own layout pass first — right after
           // EditorView construction, .cm-line elements exist but may not
           // yet have their final measured height on the very first paint.
           requestAnimationFrame(() => {
               if (!this.view) return; // view could have been destroyed (e.g. fast engine-toggle) before this fires
               const sampleLine = this.view.contentDOM.querySelector('.cm-line');
               const scroller = this.view.scrollDOM;
               if (!sampleLine || !scroller) return;
               const measuredLineHeight = sampleLine.getBoundingClientRect().height;
               if (!measuredLineHeight || measuredLineHeight <= 0) return; // don't apply a bogus 0/NaN padding
               const scrollPastPx = Math.round(measuredLineHeight * targetLines);
               const contentEl = scroller.querySelector('.cm-content');
               if (contentEl) contentEl.style.paddingBottom = `${scrollPastPx}px`;
           });
       }
},
ICONS: {
    readonly: `<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
    orient: `<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`,
    copy: `<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
    paste: `<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>`,
    cut: `<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>`,
    dpad: `<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 12h4M8 10v4M15 11v.01M18 13v.01"/></svg>`
},
    // =================================================================
    // NEXUS COMMAND REGISTRY (CR) & TOOLBOX
    // =================================================================
    CR: {
    registry: {},
    add(cmd, handler, desc = "No desc") { this.registry[cmd.toLowerCase()] = { handler, desc }; },
    
    async parse(str) {
    if (!str) return;
    const [cmd, ...args] = str.split(/\s+/);
    if (!cmd) return;
    
    // Route to Macro Recorder if active
    if (Nexus.tools.macros.recording && cmd.toLowerCase() !== 'macro') {
    Nexus.tools.macros.current.push(str);
    }
    
    const command = this.registry[cmd.toLowerCase()];
    if (command) {
    try { return await command.handler(args); } 
    catch (e) { return `CR Error: ${e.message}`; }
    } else {
    // Fallback to legacy shell if command doesn't exist in CR
    if(Nexus.shell && Nexus.shell.commands[cmd.toLowerCase()]) {
    return Nexus.shell.exec(str);
    }
    return `Unrecognized command: '${cmd}'. Type 'help'.`;
    }
    },
    
    init() {
    // --- 1. TELEPORTATION ENGINE (Warp) ---
    this.add('warp', (args) => {
    const line = parseInt(args[0]);
    if (!line) return "Specify line (e.g., warp 500)";
    Nexus.UI.jumpPrompt(line); // Uses your existing jump logic
    return `Warped to LN ${line}`;
    }, "Jump to line.");
    
    this.add('mark', (args) => {
    const name = args[0] || 'default';
    const ed = document.getElementById('rawTerminal');
    Nexus.state.bookmarks[name] = ed.selectionStart;
    return `Bookmark '${name}' locked.`;
    }, "Set navigational marker.");
    
    this.add('return', (args) => {
    const name = args[0] || 'default';
    const pos = Nexus.state.bookmarks[name];
    if (pos !== undefined) {
    const ed = document.getElementById('rawTerminal');
    ed.focus(); ed.setSelectionRange(pos, pos);
    return `Returned to '${name}'.`;
    }
    return `Marker '${name}' not found.`;
    }, "Return to marker.");
    
    // --- 2. BASE64 CONVERTER ---
    this.add('b64', (args) => {
    const mode = args[0]; // 'enc' or 'dec'
    const str = args.slice(1).join(' ');
    if (mode === 'enc') return btoa(str);
    if (mode === 'dec') return atob(str);
    return "Usage: b64 [enc/dec] [string]";
    }, "Base64 Encoder/Decoder");
    
    // --- 3. Vfs STORAGE AUDITOR ---
    this.add('audit-Vfs', () => {
    let report = "Vfs STORAGE AUDIT:\r\n";
    let total = 0;
    Object.keys(Nexus.state.Vfs).forEach(file => {
    const size = new Blob([Nexus.state.Vfs[file]]).size;
    total += size;
    report += `- ${file.padEnd(20)} | ${(size/1024).toFixed(2)} KB\r\n`;
    });
    report += `\r\nTOTAL VORTEX MASS: ${(total/1024).toFixed(2)} KB`;
    return report;
    }, "Checks Vfs memory limits.");
    
    // --- 4. KEYSTROKE MACRO RECORDER ---
    this.add('macro', (args) => {
    const action = args[0];
    const name = args[1] || 'm1';
    
    if (action === 'start') {
    Nexus.tools.macros.recording = true;
    Nexus.tools.macros.current = [];
    document.getElementById('footStatus').innerHTML = "<span class='macro-recording'>● RECORDING</span>";
    return "Macro recording started...";
    }
    if (action === 'stop') {
    Nexus.tools.macros.recording = false;
    Nexus.tools.macros.store[name] = Nexus.tools.macros.current;
    Nexus.UI.syncStatus(); // Reset footer
    return `Macro saved as '${name}'. Contains ${Nexus.tools.macros.current.length} steps.`;
    }
    if (action === 'play') {
    const sequence = Nexus.tools.macros.store[name];
    if (!sequence) return `Macro '${name}' empty.`;
    sequence.forEach(cmd => Nexus.CR.parse(cmd));
    return `Macro '${name}' executed.`;
    }
    return "Usage: macro [start/stop/play] [name]";
    }, "Record and play command sequences.");
    
    // --- 5. DEPENDENCY VISUALIZER ---
    this.add('deps', () => {
    if(Nexus.graph) {
    Nexus.graph.render();
    Nexus.UI.openModal('graph');
    return "Project Radar initialized.";
    }
    return "Graph module missing.";
    }, "Opens Dependency Matrix.");
    
    // --- 6. REGEX PLAYGROUND ---
    this.add('regex', () => {
    document.getElementById('regexSlide').classList.add('open');
    return "Regex Playground Opened.";
    }, "Opens Regex tester.");
    
    // --- 7. SYMBOL NAVIGATOR ---
    this.add('symbols', () => {
    if(Nexus.outline) {
    Nexus.outline.scan();
    return "Symbol Map Generated.";
    }
    return "Outline module missing.";
    }, "Lists file symbols and functions.");
    }
    },
    
    // Nexus Tools Logic Object
    tools: {
    macros: { recording: false, current: [], store: {} },

    warp(pos) {
        const ed = document.getElementById('rawTerminal');
        if (!ed) return;
        if (pos === 'top') { ed.scrollTop = 0; ed.setSelectionRange(0, 0); ed.focus(); }
        else if (pos === 'bottom') { ed.scrollTop = ed.scrollHeight; const l = ed.value.length; ed.setSelectionRange(l, l); ed.focus(); }
    },
    jump100(dir) {
        const ed = document.getElementById('rawTerminal');
        if (!ed) return;
        const lh = 22;
        ed.scrollTop += dir * 100 * lh;
        ed.focus();
    },
    expandBlock() {
        const ed = document.getElementById('rawTerminal');
        if (!ed) return;
        const pos = ed.selectionStart;
        const text = ed.value;
        let start = pos, end = pos;
        while (start > 0 && !/[{<\[]/.test(text[start - 1])) start--;
        while (end < text.length && !/[}>\]]/.test(text[end])) end++;
        ed.setSelectionRange(start, end + 1);
        ed.focus();
    },
    selectAll() {
        // CM6 must be checked FIRST: #rawTerminal stays in the DOM (just hidden)
        // when CM6 is active, so checking it second meant this branch never ran.
        if (Nexus.editorCore.isCM6 && Nexus.editorCore.view) {
            const v = Nexus.editorCore.view;
            v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
            v.focus();
            return;
        }
        const ed = document.getElementById('rawTerminal');
        if (ed) { ed.focus(); ed.select(); }
    },
    selectRange() {
        const ed = document.getElementById('rawTerminal');
        if (!ed) return;
        const start = parseInt(prompt('Start line:')) || 1;
        const end = parseInt(prompt('End line:')) || start;
        const lines = ed.value.split('\n');
        let s = 0, e2 = 0;
        for (let i = 0; i < Math.min(start - 1, lines.length); i++) s += lines[i].length + 1;
        e2 = s;
        for (let i = start - 1; i < Math.min(end, lines.length); i++) e2 += lines[i].length + 1;
        ed.focus(); ed.setSelectionRange(s, e2 - 1);
    },
    duplicateLine() {
        if (Nexus.editorCore.isCM6 && Nexus.editorCore.view) {
            const view = Nexus.editorCore.view;
            const pos = view.state.selection.main.head;
            const line = view.state.doc.lineAt(pos);
            view.dispatch({
                changes: { from: line.to, insert: '\n' + line.text },
                selection: { anchor: pos + line.text.length + 1 }
            });
            view.focus();
            return;
        }
        const ed = document.getElementById('rawTerminal');
        if (!ed) return;
        const value = ed.value;
        const pos = ed.selectionStart;
        const lineStart = value.lastIndexOf('\n', pos - 1) + 1;
        let lineEnd = value.indexOf('\n', pos);
        if (lineEnd === -1) lineEnd = value.length;
        const lineText = value.substring(lineStart, lineEnd);
        const newValue = value.slice(0, lineEnd) + '\n' + lineText + value.slice(lineEnd);
        ed.value = newValue;
        const newPos = lineEnd + 1 + (pos - lineStart);
        ed.setSelectionRange(newPos, newPos);
        ed.focus();
        if (Nexus.state.activeFile) {
            Nexus.state.Vfs[Nexus.state.activeFile] = newValue;
            Nexus.UI.updateGutter();
        }
    },
    copyLine() {
        if (Nexus.editorCore.isCM6 && Nexus.editorCore.view) {
            const view = Nexus.editorCore.view;
            const pos = view.state.selection.main.head;
            const line = view.state.doc.lineAt(pos);
            navigator.clipboard.writeText(line.text).catch(() => alert('Clipboard access denied.'));
            return;
        }
        const ed = document.getElementById('rawTerminal');
        if (!ed) return;
        const value = ed.value;
        const pos = ed.selectionStart;
        const lineStart = value.lastIndexOf('\n', pos - 1) + 1;
        let lineEnd = value.indexOf('\n', pos);
        if (lineEnd === -1) lineEnd = value.length;
        navigator.clipboard.writeText(value.substring(lineStart, lineEnd)).catch(() => alert('Clipboard access denied.'));
    },
    // Proper outdent — removes up to one tab-width (2 spaces, matching
    // insertTab) of LEADING whitespace from the current line. The old
    // "Remove Tab" button just did a generic backspace regardless of cursor
    // position, which wasn't really an outdent at all.
    outdentLine() {
        const removeLeadingSpaces = (text) => {
            const match = text.match(/^( {1,2}|\t)/);
            return match ? text.slice(match[0].length) : text;
        };
        if (Nexus.editorCore.isCM6 && Nexus.editorCore.view) {
            const view = Nexus.editorCore.view;
            const pos = view.state.selection.main.head;
            const line = view.state.doc.lineAt(pos);
            const newText = removeLeadingSpaces(line.text);
            const removed = line.text.length - newText.length;
            view.dispatch({
                changes: { from: line.from, to: line.to, insert: newText },
                selection: { anchor: Math.max(line.from, pos - removed) }
            });
            view.focus();
            return;
        }
        const ed = document.getElementById('rawTerminal');
        if (!ed) return;
        const value = ed.value;
        const pos = ed.selectionStart;
        const lineStart = value.lastIndexOf('\n', pos - 1) + 1;
        let lineEnd = value.indexOf('\n', pos);
        if (lineEnd === -1) lineEnd = value.length;
        const lineText = value.substring(lineStart, lineEnd);
        const newText = removeLeadingSpaces(lineText);
        const removed = lineText.length - newText.length;
        const newValue = value.slice(0, lineStart) + newText + value.slice(lineEnd);
        ed.value = newValue;
        const newPos = Math.max(lineStart, pos - removed);
        ed.setSelectionRange(newPos, newPos);
        ed.focus();
        if (Nexus.state.activeFile) {
            Nexus.state.Vfs[Nexus.state.activeFile] = newValue;
            Nexus.UI.updateGutter();
        }
    },

    // Vanilla-mode auto-closing brackets/quotes (CM6 already has this via
    // basicSetup). Handles: insert-pair, wrap-selection, type-through an
    // already-present closer, and deleting an empty pair as one backspace.
    handleAutoClose(e, ed) {
        const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
        const key = e.key;
        const start = ed.selectionStart, end = ed.selectionEnd;

        if (key === 'Backspace' && start === end && start > 0) {
            const before = ed.value[start - 1];
            const after = ed.value[start];
            if (PAIRS[before] === after) {
                e.preventDefault();
                ed.setSelectionRange(start - 1, start + 1);
                document.execCommand('delete');
                if (Nexus.state.activeFile) {
                    Nexus.state.Vfs[Nexus.state.activeFile] = ed.value;
                    Nexus.UI.updateGutter();
                }
            }
            return;
        }

        const isQuote = (key === '"' || key === "'" || key === '`');
        const isOpener = (key === '(' || key === '[' || key === '{');
        const isCloser = (key === ')' || key === ']' || key === '}');

        // Type-through: cursor sits right before this exact character already.
        if (start === end && ed.value[start] === key && (isQuote || isCloser)) {
            e.preventDefault();
            ed.selectionStart = ed.selectionEnd = start + 1;
            return;
        }

        if (!isQuote && !isOpener) return;

        // Quotes right after a letter/digit are very likely a contraction or
        // possessive ("don't", "user's"), not the start of a new string —
        // skip auto-close there and let it type normally.
        if (isQuote && start === end) {
            const prevChar = ed.value[start - 1];
            if (prevChar && /[a-zA-Z0-9]/.test(prevChar)) return;
        }

        e.preventDefault();
        const closer = PAIRS[key];
        if (start !== end) {
            const selected = ed.value.slice(start, end);
            document.execCommand('insertText', false, key + selected + closer);
            ed.selectionStart = start + 1;
            ed.selectionEnd = start + 1 + selected.length;
        } else {
            document.execCommand('insertText', false, key + closer);
            ed.selectionStart = ed.selectionEnd = start + 1;
        }
        if (Nexus.state.activeFile) {
            Nexus.state.Vfs[Nexus.state.activeFile] = ed.value;
            Nexus.UI.updateGutter();
        }
    },

    jumpToLinePrompt() {
        const line = parseInt(prompt('Jump to line:'));
        if (line > 0) Nexus.UI.jumpToLine(line);
    },
    // "Up X" / "Down X" — move by a user-specified number of lines, using
    // the same tested navigate() logic that already correctly handles
    // selectLock/lineLock, just repeated N times instead of the usual 1.
    jumpByAmount(direction) {
        const n = parseInt(prompt(`Move ${direction === 'Up' ? 'up' : 'down'} how many lines?`, '10'));
        if (!n || n < 1) return;
        for (let i = 0; i < n; i++) Nexus.DpadEngine.navigate(direction);
    },
    toggleComment() {
        const commentSyntax = {
            js: '//', css: null, html: null, json: '//'
        };
        const ext = (Nexus.state.activeFile || '').split('.').pop().toLowerCase();
        const isBlockLang = ext === 'css' || ext === 'html';

        if (Nexus.editorCore.isCM6 && Nexus.editorCore.view) {
            const view = Nexus.editorCore.view;
            const pos = view.state.selection.main.head;
            const line = view.state.doc.lineAt(pos);
            const { text, from } = this._computeCommentToggle(line.text, ext, isBlockLang);
            view.dispatch({ changes: { from: line.from, to: line.to, insert: text } });
            view.focus();
            return;
        }
        const ed = document.getElementById('rawTerminal');
        if (!ed) return;
        const value = ed.value;
        const pos = ed.selectionStart;
        const lineStart = value.lastIndexOf('\n', pos - 1) + 1;
        let lineEnd = value.indexOf('\n', pos);
        if (lineEnd === -1) lineEnd = value.length;
        const lineText = value.substring(lineStart, lineEnd);
        const { text: newLineText, from: caretShift } = this._computeCommentToggle(lineText, ext, isBlockLang);
        const newValue = value.slice(0, lineStart) + newLineText + value.slice(lineEnd);
        ed.value = newValue;
        const newPos = pos + caretShift;
        ed.setSelectionRange(newPos, newPos);
        ed.focus();
        if (Nexus.state.activeFile) {
            Nexus.state.Vfs[Nexus.state.activeFile] = newValue;
            Nexus.UI.updateGutter();
        }
    },
    // Shared logic for both CM6 and vanilla toggleComment — returns the
    // rewritten line text, plus how much the caret should shift by (since
    // adding/removing comment markers changes line length before the cursor).
    _computeCommentToggle(lineText, ext, isBlockLang) {
        const indentMatch = lineText.match(/^(\s*)/);
        const indent = indentMatch ? indentMatch[1] : '';
        const rest = lineText.slice(indent.length);

        if (isBlockLang) {
            const open = ext === 'html' ? '<!--' : '/*';
            const close = ext === 'html' ? '-->' : '*/';
            if (rest.startsWith(open) && rest.endsWith(close)) {
                const inner = rest.slice(open.length, -close.length).trim();
                return { text: indent + inner, from: -(open.length + 1) };
            }
            return { text: indent + open + ' ' + rest + ' ' + close, from: open.length + 1 };
        } else {
            const marker = '// ';
            if (rest.startsWith('//')) {
                const stripped = rest.replace(/^\/\/\s?/, '');
                return { text: indent + stripped, from: -(rest.length - stripped.length) };
            }
            return { text: indent + marker + rest, from: marker.length };
        }
    },
    clipboard(action) {
        if (action === 'copy') {
            document.execCommand('copy');
        } else if (action === 'cut') {
            document.execCommand('cut');
        } else if (action === 'paste') {
            navigator.clipboard.readText().then(t => Nexus.actions.insertText(t)).catch(() => alert('Clipboard access denied. Long-press to paste.'));
        }
    },

    testRegex() {
    const pattern = document.getElementById('regexPattern').value;
    const flags = document.getElementById('regexFlags').value;
    const out = document.getElementById('regexMatches');
    const code = document.getElementById('rawTerminal').value; // Test against active file
    
    if (!pattern) return out.innerText = "Error: Provide a pattern.";
    
    try {
    const rx = new RegExp(pattern, flags);
    const matches = [...code.matchAll(rx)];
    if (matches.length === 0) return out.innerHTML = "<span style='color:var(--warn)'>No matches found.</span>";
    
    out.innerHTML = matches.map((m, i) => 
    `[Match ${i+1}] Index: ${m.index} -> <span style="color:#fff;">${m[0].replace(/</g, '&lt;')}</span>`
    ).join('<br><br>');
    } catch (e) {
    out.innerHTML = `<span style="color:var(--danger)">Syntax Error: ${e.message}</span>`;
    }
    }
    },
auditor: {
    getEditorContent() {
        // Read the canonical source of truth directly rather than scraping the
        // DOM. This is simpler, matches every other tool in the app (lint,
        // brackets, etc.), and is immune to picking up the wrong element if
        // the DOM ever gains another [contenteditable] node.
        return Nexus.state.activeFile ? (Nexus.state.Vfs[Nexus.state.activeFile] || '') : '';
    },

    // Memoised on the source string. A Full Sweep calls this from five
    // separate detectors, each re-parsing the exact same document from
    // scratch — on a 137KB file that's five full DOMParser passes to
    // produce five identical trees. Only the most recent parse is kept,
    // since every caller within one sweep passes the same source; a
    // different file simply replaces it rather than growing a cache that
    // would pin whole documents in memory.
    _vdocCacheKey: null,
    _vdocCacheVal: null,
    getVirtualDoc(src) {
        if (this._vdocCacheKey === src && this._vdocCacheVal) return this._vdocCacheVal;
        const parser = new DOMParser();
        const doc = parser.parseFromString(src, 'text/html');
        this._vdocCacheKey = src;
        this._vdocCacheVal = doc;
        return doc;
    },

    // Reusable utility to clear any console frame
    clearBox(boxId, fallbackText) {
        const target = document.getElementById(boxId);
        if (target) {
            target.innerHTML = `<div style="color: #5c6370;">${fallbackText}</div>`;
        }
    },

    // Total master clear for the auditor subsystem
    clearAuditor() {
        this.clearBox('auditorReportBox', 'Terminal cleared. Counters reset.');
        document.getElementById('auditorModeTitle').innerText = "ACTIVE: FULL SYSTEM IDLE";
        document.getElementById('auditCountHtml').innerText = '0';
        document.getElementById('auditCountJs').innerText = '0';
        document.getElementById('auditCountOrphans').innerText = '0';
        document.getElementById('auditCountCss').innerText = '0';
        document.getElementById('auditCountLint').innerText = '0';
        document.getElementById('auditCountBrackets').innerText = '0';
        document.getElementById('auditCountTodo').innerText = '0';
        document.getElementById('auditCountMissingImports').innerText = '0';
        document.getElementById('auditCountMobile').innerText = '0';
        const badge = document.getElementById('diagBadgeCore');
        if (badge) badge.classList.remove('show');
    },

    // Universal multi-target clipboard router
    copyBox(boxId, labelContext) {
        const targetBox = document.getElementById(boxId);
        const titleIndicator = document.getElementById('auditorModeTitle');
        if (!targetBox) return;

        const plainText = targetBox.innerText;
        navigator.clipboard.writeText(plainText).then(() => {
            const cachedTitle = titleIndicator.innerText;
            titleIndicator.innerText = `SUCCESS: ${labelContext} COPIED!`;
            titleIndicator.style.color = "var(--success)";
            setTimeout(() => {
                titleIndicator.innerText = cachedTitle;
                titleIndicator.style.color = "var(--accent)";
            }, 1200);
        }).catch(err => {
            console.error('Mobile clipboard write error:', err);
        });
    },

    // =======================================================
    // UNIFIED FULL SWEEP — runs every check in one pass and renders ONE
    // consolidated report. Previously, HTML/JS/CSS/Orphan checks all wrote to
    // the same box and silently overwrote each other's findings (only the
    // separate counters persisted), and lint/imports/brackets lived in a
    // totally separate box — so there was no single tap that told you
    // everything actually wrong with the file at once.
    // =======================================================
    runFullSweep() {
        if (!Nexus.state.activeFile) {
            return this.clearBox('auditorReportBox', 'No active file to sweep.');
        }
        document.getElementById('auditorModeTitle').innerText = "ACTIVE: FULL SWEEP";

        const srcCode = this.getEditorContent();
        const ext = Nexus.state.activeFile.split('.').pop().toLowerCase();
        const sections = []; // { label, count, items: [{text, line}] }

        // --- Lint (Sentinel's AST-based engine) ---
        let lintIssues = [];
        let rawLintIssues = []; // unmapped, for neural.analyzeDelta's countIds (needs .id, which the display mapping below discards)
        if (ext === 'js' || ext === 'html') {
            Nexus.Sentinel.initEngine();
            try {
                let lintCode = srcCode;
                if (ext === 'html') {
                    const block = Nexus.Sentinel.findMainScript(srcCode);
                    lintCode = block ? block.code : null;
                }
                if (lintCode !== null) {
                    const { issues } = Nexus.Sentinel.engine.analyzeAndMutate(lintCode, 'LINT');
                    rawLintIssues = issues;
                    lintIssues = issues.map(i => ({ text: `${i.id}: ${i.message}`, line: i.line }));
                }
            } catch (e) {
                lintIssues = [{ text: `Structure Compromised: ${e.message}`, line: null }];
            }
        }
        sections.push({ label: 'LINT', count: lintIssues.length, items: lintIssues });

        // --- HTML / JS / CSS / Orphans (auditor's DOM-based checks) ---
        const htmlIssues = this._detectHtmlIssues(srcCode).map(i => ({ text: i.text, line: i.line }));
        sections.push({ label: 'HTML STRUCTURE', count: htmlIssues.length, items: htmlIssues });

        const jsIssues = this._detectJsIssues(srcCode).map(e => ({ text: `${e.label}: ${e.message}`, line: e.line }));
        sections.push({ label: 'JS SYNTAX', count: jsIssues.length, items: jsIssues });

        const cssIssues = this._detectCssIssues(srcCode).map(u => ({ text: `Unused: ${u.selector}`, line: u.line }));
        sections.push({ label: 'UNUSED CSS', count: cssIssues.length, items: cssIssues });

        const orphanIssues = this._detectOrphanIssues(srcCode).map(o => ({ text: `#${o.id} (${o.tag}) has no script reference`, line: o.line }));
        sections.push({ label: 'ORPHANED IDS', count: orphanIssues.length, items: orphanIssues });

        // --- Brackets ---
        let bracketIssues = [];
        try {
            const result = Nexus.BracketCartographer.mapStructure(srcCode);
            bracketIssues = result.errors.slice(0, 5).map(e => ({ text: `Missing or unmatched ${e.char}`, line: e.line + 1 }));
        } catch (e) { /* best-effort; leave empty rather than break the whole sweep */ }
        sections.push({ label: 'BRACKETS', count: bracketIssues.length, items: bracketIssues });

        // --- Dependencies: total count (informational) + broken/missing
        // ones specifically (a real, counted defect — see
        // _detectMissingImports's own comment for why this is a distinct
        // check from Project Radar's dead-code detection). ---
        const depMatches = srcCode.match(/(?:import\s+.*?from\s+['"]([^'"]+)['"])|(?:require\(['"]([^'"]+)['"]\))|(?:src=['"]([^'"]+)['"])|(?:href=['"]([^'"]+)['"])/g) || [];
        const uniqueDeps = [...new Set(depMatches.map(d => { const m = d.match(/['"]([^'"]+)['"]/); return m ? m[1] : d; }))];

        const missingImports = this._detectMissingImports(srcCode).map(i => ({ text: `Unresolved: '${i.path}'`, line: i.line }));
        sections.push({ label: 'MISSING IMPORTS', count: missingImports.length, items: missingImports });

        // --- Mobile-web footguns (Feature 5) ---
        const mobileIssues = this._detectMobileIssues(srcCode, ext).map(i => ({ text: i.text, line: i.line }));
        sections.push({ label: 'MOBILE PITFALLS', count: mobileIssues.length, items: mobileIssues });

        // --- TODOs (informational — reminders, not defects) ---
        const todos = this._detectTodos(srcCode);

        // --- Complexity signal + trend vs. last sweep of this file ---
        Nexus.context.build(srcCode, Nexus.state.activeFile);
        const graphSize = Nexus.context.graph.size;
        const prevSweep = Nexus.state.lastSweep[Nexus.state.activeFile];
        let deltaSummary = null;
        if (prevSweep) {
            deltaSummary = Nexus.neural.analyzeDelta(prevSweep.issues, rawLintIssues, prevSweep.graphSize, graphSize);
        }
        Nexus.state.lastSweep[Nexus.state.activeFile] = { issues: rawLintIssues, graphSize };

        // --- Keep the at-a-glance counters in sync too ---
        const setCount = (id, n) => { const el = document.getElementById(id); if (el) el.innerText = n; };
        setCount('auditCountHtml', htmlIssues.length);
        setCount('auditCountJs', jsIssues.length);
        setCount('auditCountCss', cssIssues.length);
        setCount('auditCountOrphans', orphanIssues.length);
        setCount('auditCountLint', lintIssues.length);
        setCount('auditCountBrackets', bracketIssues.length);
        setCount('auditCountTodo', todos.length);
        setCount('auditCountMissingImports', missingImports.length);
        setCount('auditCountMobile', mobileIssues.length);

        // --- Render one consolidated report ---
        const totalIssues = sections.reduce((sum, s) => sum + s.count, 0);
        // Surface the total on the collapsible section's own <summary> badge
        // so a collapsed Diagnostics section still shows at a glance
        // whether anything needs attention, instead of requiring the
        // section to be expanded just to see if a sweep found problems.
        const badge = document.getElementById('diagBadgeCore');
        if (badge) {
            if (totalIssues > 0) { badge.innerText = totalIssues; badge.classList.add('show'); }
            else { badge.classList.remove('show'); }
        }
        let html = `<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">`
            + `<span style="font-weight:900; font-size:13px; color:${totalIssues === 0 ? 'var(--success)' : 'var(--danger)'};">${totalIssues === 0 ? '✔ ALL CLEAR' : totalIssues + ' TOTAL ISSUE' + (totalIssues === 1 ? '' : 'S')}</span>`
            + `<span style="font-size:10px; opacity:0.6;">${Nexus.state.activeFile}</span>`
            + `</div>`;

        sections.forEach(sec => {
            if (sec.count === 0) return;
            html += `<div style="margin-bottom:10px;">`
                + `<div style="font-size:10px; font-weight:800; color:var(--gold); margin-bottom:4px;">${sec.label} (${sec.count})</div>`;
            sec.items.slice(0, 10).forEach(item => {
                const clickable = item.line != null;
                html += `<div ${clickable ? `onclick="Nexus.UI.jumpToLine(${item.line})" style="cursor:pointer;"` : ''} style="background:var(--surface); padding:6px 10px; margin-bottom:4px; border-left:3px solid var(--danger); border-radius:4px; display:flex; justify-content:space-between; align-items:center;">`
                    + `<span style="font-size:11px;">${item.text}</span>`
                    + (clickable ? `<span style="font-size:9px; opacity:0.6; white-space:nowrap; padding-left:6px;">LN ${item.line} →</span>` : '')
                    + `</div>`;
            });
            if (sec.items.length > 10) {
                html += `<div style="font-size:10px; opacity:0.6; font-style:italic;">...and ${sec.items.length - 10} more.</div>`;
            }
            html += `</div>`;
        });

        if (totalIssues === 0) {
            html += `<div style="color:var(--success); font-size:11px;">Lint, HTML structure, JS syntax, CSS, orphaned IDs, and brackets are all clean.</div>`;
        }
        if (uniqueDeps.length > 0) {
            html += `<div style="margin-top:6px; padding-top:10px; border-top:1px solid var(--border); font-size:10px; opacity:0.7;">🔗 ${uniqueDeps.length} external dependenc${uniqueDeps.length === 1 ? 'y' : 'ies'} detected.</div>`;
        }
        if (todos.length > 0) {
            html += `<div style="margin-top:4px; font-size:10px; opacity:0.7;">📌 ${todos.length} TODO/FIXME/HACK marker${todos.length === 1 ? '' : 's'} left in this file.</div>`;
        }
        if (deltaSummary) {
            const isFallback = deltaSummary.summary.length === 1 && deltaSummary.summary[0].startsWith('✅');
            html += `<div style="margin-top:10px; padding-top:10px; border-top:1px solid var(--border);">`
                + `<div style="font-size:10px; font-weight:800; color:var(--gold); margin-bottom:4px;">SINCE LAST SWEEP</div>`
                + deltaSummary.summary.map(line =>
                    `<div style="font-size:11px; color:${isFallback ? 'var(--success)' : 'var(--danger)'}; margin-bottom:2px;">${line}</div>`
                  ).join('')
                + `</div>`;
        }

        document.getElementById('auditorReportBox').innerHTML = html;
    },

    // Single-check counterpart to the LINT portion of runFullSweep, wired to
    // its own metric card — renders into the same unified box as HTML/JS/CSS/
    // Orphans instead of the separate diag-out stream, so results never get
    // silently overwritten as you tap between cards.
    runLintCard() {
        if (!Nexus.state.activeFile) {
            document.getElementById('auditorModeTitle').innerText = "ACTIVE: LINT";
            const box = document.getElementById('auditorReportBox');
            if (box) box.innerHTML = `<div style="color: var(--gold); font-weight: bold;">No file open — open or create a file first.</div>`;
            return;
        }
        document.getElementById('auditorModeTitle').innerText = "ACTIVE: LINT";
        const srcCode = this.getEditorContent();
        const ext = Nexus.state.activeFile.split('.').pop().toLowerCase();
        let issues = [];
        let structureError = null;
        if (ext === 'js' || ext === 'html') {
            Nexus.Sentinel.initEngine();
            try {
                let lintCode = srcCode;
                if (ext === 'html') {
                    const block = Nexus.Sentinel.findMainScript(srcCode);
                    lintCode = block ? block.code : null;
                }
                if (lintCode !== null) {
                    ({ issues } = Nexus.Sentinel.engine.analyzeAndMutate(lintCode, 'LINT'));
                }
            } catch (e) {
                structureError = e.message;
            }
        }
        // Keep this in sync with Sentinel's own tracking so the existing
        // FIX / FIX ALL buttons (Sentinel.applyFix/applyAllFixes) work
        // unmodified when tapped from this card's rendering.
        Nexus.Sentinel.lastIssues = issues;

        const counter = document.getElementById('auditCountLint');
        if (counter) counter.innerText = issues.length;
        const reportBox = document.getElementById('auditorReportBox');

        if (structureError) {
            reportBox.innerHTML = `<div style="color:var(--danger); font-weight:bold;">Structure Compromised: ${structureError}</div>`;
            return;
        }
        if (issues.length === 0) {
            reportBox.innerHTML = `<div style="color: var(--success); font-weight: bold;">✔ No lint issues detected.</div>`;
            return;
        }

        let html = '<div style="display:flex; justify-content:space-between; margin-bottom:10px;">' +
            '<div style="color:var(--danger); font-weight:bold;">' + issues.length + ' LINT ISSUE' + (issues.length === 1 ? '' : 'S') + '</div>' +
            '<button class="tool-btn btn-success" style="padding:4px 8px; font-size:10px;" onclick="Nexus.Sentinel.applyAllFixes(); Nexus.auditor.runLintCard();">FIX ALL</button>' +
        '</div>';

        issues.forEach((iss, idx) => {
            const color = iss.severity === 'CRITICAL' ? 'var(--danger)' : 'var(--gold)';
            let btnHtml = '';
            if (iss.mutate) {
                btnHtml = '<button class="tool-btn btn-gold" style="padding:2px 6px; font-size:9px;" onclick="event.stopPropagation(); Nexus.Sentinel.applyFix(' + idx + '); Nexus.auditor.runLintCard();">FIX</button>';
            }
            const explainEntry = Nexus.tutor.lintLibrary[iss.id];
            let explainBtn = '', explainCard = '';
            if (explainEntry) {
                explainBtn = '<button class="tool-btn" style="padding:2px 6px; font-size:9px;" onclick="event.stopPropagation(); Nexus.tutor.toggleExplain(\'sweep-' + idx + '\')" title="Explain in plain English" aria-label="Explain this issue">?</button>';
                explainCard = '<div id="explainsweep-' + idx + '" style="display:none;">' + Nexus.tutor.renderExplainCard(explainEntry) + '</div>';
            }
            const clickable = iss.line != null;
            html += `<div ${clickable ? `onclick="Nexus.UI.jumpToLine(${iss.line})" style="cursor:pointer;"` : ''} style="background:var(--surface); padding:10px; margin-bottom:5px; border-left:3px solid ${color}; border-radius:4px;">`
                + `<div style="display:flex; justify-content:space-between; align-items:center; gap:4px;">`
                + `<span style="color:${color}; font-size:10px; font-weight:bold;">${iss.id}${iss.line != null ? ' | LN ' + iss.line : ''}</span>`
                + `<span style="display:flex; gap:4px;">${explainBtn}${btnHtml}</span>`
                + `</div>`
                + `<div style="font-size:11px; margin-top:4px; opacity:0.9;">${iss.message}</div>`
                + explainCard
                + `</div>`;
        });
        reportBox.innerHTML = html;
    },

    // Single-check counterpart to the BRACKETS portion of runFullSweep.
    runBracketsCard() {
        if (!Nexus.state.activeFile) {
            document.getElementById('auditorModeTitle').innerText = "ACTIVE: BRACKETS";
            const box = document.getElementById('auditorReportBox');
            if (box) box.innerHTML = `<div style="color: var(--gold); font-weight: bold;">No file open — open or create a file first.</div>`;
            return;
        }
        document.getElementById('auditorModeTitle').innerText = "ACTIVE: BRACKETS";
        const srcCode = this.getEditorContent();
        let bracketIssues = [];
        try {
            const result = Nexus.BracketCartographer.mapStructure(srcCode);
            bracketIssues = result.errors.map(e => ({ text: `Missing or unmatched ${e.char}`, line: e.line + 1 }));
        } catch (e) { /* leave empty; best-effort */ }
        const counter = document.getElementById('auditCountBrackets');
        if (counter) counter.innerText = bracketIssues.length;
        const reportBox = document.getElementById('auditorReportBox');
        if (bracketIssues.length === 0) {
            reportBox.innerHTML = `<div style="color: var(--success); font-weight: bold;">✔ All brackets match.</div>`;
            return;
        }
        let html = `<div style="color:var(--gold); font-weight:bold; margin-bottom:6px;">UNMATCHED BRACKETS</div>`;
        bracketIssues.slice(0, 5).forEach(b => {
            html += `<div onclick="Nexus.UI.jumpToLine(${b.line})" style="cursor:pointer; background:var(--surface); padding:8px 10px; margin-bottom:6px; border-left:3px solid var(--danger); border-radius:4px;">`
                + `<span style="font-size:11px;">${b.text}</span>`
                + `<span style="float:right; font-size:9px; opacity:0.6;">LN ${b.line} →</span>`
                + `</div>`;
        });
        if (bracketIssues.length > 5) {
            html += `<div style="font-size:10px; opacity:0.6; font-style:italic;">...and ${bracketIssues.length - 5} more.</div>`;
        }
        reportBox.innerHTML = html;
    },

    // TODO / FIXME / HACK scanner — these are reminders, not defects, so they
    // get their own card rather than inflating the issue counts elsewhere.
    _detectTodos(srcCode) {
        const lines = srcCode.split('\n');
        const marker = /\b(TODO|FIXME|HACK|XXX)\b:?\s*(.*)/i;
        const todos = [];
        lines.forEach((lineText, i) => {
            const m = lineText.match(marker);
            if (m) todos.push({ tag: m[1].toUpperCase(), text: m[2].trim() || '(no description)', line: i + 1 });
        });
        return todos;
    },
    runTodoScan() {
        if (!Nexus.state.activeFile) {
            document.getElementById('auditorModeTitle').innerText = "ACTIVE: TODO SCAN";
            const box = document.getElementById('auditorReportBox');
            if (box) box.innerHTML = `<div style="color: var(--gold); font-weight: bold;">No file open — open or create a file first.</div>`;
            return;
        }
        document.getElementById('auditorModeTitle').innerText = "ACTIVE: TODO SCAN";
        const srcCode = this.getEditorContent();
        const todos = this._detectTodos(srcCode);
        const counter = document.getElementById('auditCountTodo');
        if (counter) counter.innerText = todos.length;
        const reportBox = document.getElementById('auditorReportBox');
        if (todos.length === 0) {
            reportBox.innerHTML = `<div style="color: var(--success); font-weight: bold;">✔ No TODO/FIXME/HACK markers left in this file.</div>`;
            return;
        }
        let html = `<div style="color:var(--gold); font-weight:bold; margin-bottom:6px;">${todos.length} REMINDER${todos.length === 1 ? '' : 'S'} LEFT IN CODE</div>`;
        todos.forEach(t => {
            html += `<div onclick="Nexus.UI.jumpToLine(${t.line})" style="cursor:pointer; background:var(--surface); padding:8px 10px; margin-bottom:6px; border-left:3px solid var(--gold); border-radius:4px;">`
                + `<span style="color:var(--gold); font-size:10px; font-weight:bold;">${t.tag}</span> `
                + `<span style="font-size:11px;">${t.text}</span>`
                + `<span style="float:right; font-size:9px; opacity:0.6;">LN ${t.line} →</span>`
                + `</div>`;
        });
        reportBox.innerHTML = html;
    },

    // Standalone single-purpose runner, same pattern as runTodoScan()
    // just above — reuses _detectMissingImports so Full Sweep and this
    // tile can never disagree about what counts as unresolved.
    runMissingImportsAudit() {
        if (!Nexus.state.activeFile) {
            document.getElementById('auditorModeTitle').innerText = "ACTIVE: MISSING IMPORTS";
            const box = document.getElementById('auditorReportBox');
            if (box) box.innerHTML = `<div style="color: var(--gold); font-weight: bold;">No file open — open or create a file first.</div>`;
            return;
        }
        document.getElementById('auditorModeTitle').innerText = "ACTIVE: MISSING IMPORTS";
        const srcCode = this.getEditorContent();
        const missing = this._detectMissingImports(srcCode);
        const counter = document.getElementById('auditCountMissingImports');
        if (counter) counter.innerText = missing.length;
        const reportBox = document.getElementById('auditorReportBox');
        if (missing.length === 0) {
            reportBox.innerHTML = `<div style="color: var(--success); font-weight: bold;">✔ Every local import/src/href in this file resolves to a real project file.</div>`;
            return;
        }
        let html = `<div style="color:var(--danger); font-weight:bold; margin-bottom:6px;">${missing.length} UNRESOLVED IMPORT${missing.length === 1 ? '' : 'S'}</div>`;
        missing.forEach(i => {
            const clickable = i.line != null;
            html += `<div ${clickable ? `onclick="Nexus.UI.jumpToLine(${i.line})" style="cursor:pointer;"` : ''} style="background:var(--surface); padding:8px 10px; margin-bottom:6px; border-left:3px solid var(--danger); border-radius:4px; display:flex; justify-content:space-between; align-items:center;">`
                + `<span style="font-size:11px;">'${i.path}'</span>`
                + (clickable ? `<span style="font-size:9px; opacity:0.6; white-space:nowrap; padding-left:6px;">LN ${i.line} →</span>` : '')
                + `</div>`;
        });
        reportBox.innerHTML = html;
    },

    // Standalone card for the mobile-web footgun checks — same pattern as
    // runMissingImportsAudit() just above, reusing _detectMobileIssues so
    // this and Full Sweep can never disagree about what counts as a
    // mobile pitfall.
    runMobileAudit() {
        if (!Nexus.state.activeFile) {
            document.getElementById('auditorModeTitle').innerText = "ACTIVE: MOBILE PITFALLS";
            const box = document.getElementById('auditorReportBox');
            if (box) box.innerHTML = `<div style="color: var(--gold); font-weight: bold;">No file open — open or create a file first.</div>`;
            return;
        }
        document.getElementById('auditorModeTitle').innerText = "ACTIVE: MOBILE PITFALLS";
        const srcCode = this.getEditorContent();
        const ext = Nexus.state.activeFile.split('.').pop().toLowerCase();
        const issues = this._detectMobileIssues(srcCode, ext);
        const counter = document.getElementById('auditCountMobile');
        if (counter) counter.innerText = issues.length;
        const reportBox = document.getElementById('auditorReportBox');
        if (issues.length === 0) {
            reportBox.innerHTML = `<div style="color: var(--success); font-weight: bold;">✔ No mobile-specific pitfalls found in this file.</div>`;
            return;
        }
        let html = `<div style="color:var(--danger); font-weight:bold; margin-bottom:6px;">${issues.length} MOBILE PITFALL${issues.length === 1 ? '' : 'S'}</div>`;
        issues.forEach(i => {
            html += `<div onclick="Nexus.UI.jumpToLine(${i.line})" style="cursor:pointer; background:var(--surface); padding:8px 10px; margin-bottom:6px; border-left:3px solid var(--gold); border-radius:4px; display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">`
                + `<span style="font-size:11px;">${i.text}</span>`
                + `<span style="font-size:9px; opacity:0.6; white-space:nowrap; flex-shrink:0;">LN ${i.line} →</span>`
                + `</div>`;
        });
        reportBox.innerHTML = html;
    },

 // =======================================================
 // HARDENED HTML CHECKER (Uses Native DOM Node Filtering)
 // =======================================================
 // Pure detection logic, shared by the individual HTML-check button and the
 // unified full sweep below — returns issues without touching the DOM.
 _detectHtmlIssues(srcCode) {
 // 1. Parse your exact code straight into a safe virtual document first
 const doc = this.getVirtualDoc(srcCode);
 const items = []; // { text, line (optional) }
 
 // 2. Safely find and purge real HTML comment nodes using an iterator
 const iterator = document.createNodeIterator(
 doc.documentElement || doc,
 NodeFilter.SHOW_COMMENT
 );
 
 let commentNode;
 const deadNodes = [];
 while (commentNode = iterator.nextNode()) {
 deadNodes.push(commentNode);
 }
 // Remove them completely from the virtual engine pass
 deadNodes.forEach(node => node.parentNode && node.parentNode.removeChild(node));
 
 // 3. Scan native browser parser exceptions
 const parserErrors = doc.querySelectorAll('parsererror');
 parserErrors.forEach(err => {
 items.push({ text: `Parser Bug: ${err.textContent.split('\n')[0]}` });
 });
 
 // 4. Run structural balance checks on the remaining clean layout
 // 4/5. FULL-COVERAGE TAG TRACE — one stack walk over every tag in the
 // file (not a hardcoded shortlist), reporting every violation it finds
 // rather than stopping at the first. Replaces two earlier passes that
 // each had a real gap:
 //   - the old count check only watched 8 hardcoded tag names (div, span,
 //     button, script, style, section, main, header, footer), so a
 //     mismatched <ul>/<li>, <table>/<tr>, or any custom/less-common tag
 //     passed silently with zero report;
 //   - the old nesting check covered every tag correctly, but stopped
 //     after reporting its first violation (`nestingFlagged = true` broke
 //     the loop), so a file with 3 problems took 3 fix-rerun cycles to
 //     surface them all instead of one.
 // A single stack walk that reports as it goes gives correct-order nesting
 // detection AND true unclosed-tag detection (whatever's left on the stack
 // at EOF) for every tag name, in one pass, with nothing silently skipped.
 {
     const stripped = srcCode
         // HTML COMMENTS MUST GO FIRST. Without this the scanner happily
         // parses "tags" out of commented-out prose: this very file has a
         // comment describing merge markers as <<<LEFT / === / RIGHT>>>,
         // which was being read as an opening <left> tag and then reported
         // as a nesting error against a real </div> 50 lines away. Blanked
         // with spaces rather than deleted so every subsequent line number
         // stays correct.
         .replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '))
         .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, m => ' '.repeat(m.length))
         .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, m => ' '.repeat(m.length));
     const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', '!doctype']);
     const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;
     const lineOf = (idx) => stripped.slice(0, idx).split('\n').length;
     const stack = [];
     let m;
     while ((m = tagRe.exec(stripped))) {
         const [full, closing, name, selfClose] = m;
         const tag = name.toLowerCase();
         if (voidTags.has(tag) || selfClose) continue;
         if (!closing) {
             stack.push({ tag, index: m.index });
             continue;
         }
         if (stack.length === 0) {
             // Stray closing tag with nothing open at all — previously
             // silently skipped ("count check covers it"), but there is no
             // count check anymore, so this needs its own report.
             items.push({ text: `Unexpected &lt;/${tag}&gt; — no matching &lt;${tag}&gt; is open at this point.`, line: lineOf(m.index) });
             continue;
         }
         const top = stack[stack.length - 1];
         if (top.tag === tag) {
             stack.pop();
             continue;
         }
         const matchIdx = stack.map(s => s.tag).lastIndexOf(tag);
         if (matchIdx === -1) {
             // No opener for this tag anywhere on the stack — treat as stray,
             // same as the empty-stack case above, so it still gets reported
             // and the stack is left untouched for whatever comes next.
             items.push({ text: `Unexpected &lt;/${tag}&gt; — no matching &lt;${tag}&gt; is open at this point.`, line: lineOf(m.index) });
             continue;
         }
         // The matching opener exists further down the stack, not at the
         // top — this closing tag jumped past something still open. Report
         // it, then pop back to (and including) the real match so the walk
         // stays coherent for the rest of the file instead of cascading
         // false positives off one bad tag.
         items.push({ text: `Improper nesting: &lt;/${tag}&gt; closes before its inner &lt;${top.tag}&gt; (opened line ${lineOf(top.index)}) does.`, line: lineOf(m.index) });
         stack.length = matchIdx;
     }
     // Anything left on the stack at EOF was opened but never closed —
     // this is the true unclosed-tag report, correct per tag NAME (every
     // tag, not a hardcoded 8) and per tag INSTANCE (each leftover open
     // gets its own line-numbered entry rather than one aggregate count).
     stack.forEach(({ tag, index }) => {
         items.push({ text: `Unclosed &lt;${tag}&gt; — opened here but never closed.`, line: lineOf(index) });
     });
 }

 // 6. Duplicate ids — breaks getElementById()'s "one true element" guarantee.
 {
     const seen = new Map();
     doc.querySelectorAll('[id]').forEach(el => {
         const id = el.id;
         if (!id) return;
         seen.set(id, (seen.get(id) || 0) + 1);
     });
     seen.forEach((count, id) => {
         if (count > 1) {
             const escapedId = id.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
             const firstMatch = srcCode.match(new RegExp(`id=["']${escapedId}["']`));
             const line = firstMatch ? srcCode.slice(0, firstMatch.index).split('\n').length : null;
             items.push({ text: `Duplicate id "${id}" used on ${count} elements — only one can ever be found by getElementById().`, line });
         }
     });
 }

 // 7. Images missing alt text — accessibility, and a quick screen-reader win.
 {
     const imgsMissingAlt = doc.querySelectorAll('img:not([alt])');
     if (imgsMissingAlt.length > 0) {
         const firstMatch = srcCode.match(/<img\b(?![^>]*\balt=)/i);
         const line = firstMatch ? srcCode.slice(0, firstMatch.index).split('\n').length : null;
         items.push({ text: `${imgsMissingAlt.length} &lt;img&gt; tag${imgsMissingAlt.length === 1 ? '' : 's'} missing alt text (screen readers announce nothing).`, line });
     }
 }

 // 8. Missing viewport meta — this app is mobile-first, so a full HTML
 // document with no viewport tag will render zoomed-out/tiny on a phone.
 {
     const looksLikeFullDoc = /<html[\s>]/i.test(srcCode);
     if (looksLikeFullDoc && !doc.querySelector('meta[name="viewport"]')) {
         items.push({ text: `No &lt;meta name="viewport"&gt; tag — this page will render tiny/zoomed-out on phones.` });
     }
 }

 // 9. Deprecated tags/attributes — HTML4-era markup with modern CSS
 // equivalents. Not broken, but a real signal something should move to CSS.
 {
     const deprecatedTags = ['center', 'font', 'marquee', 'blink', 'strike', 'big', 'tt'];
     deprecatedTags.forEach(tag => {
         const els = doc.querySelectorAll(tag);
         if (els.length > 0) {
             const re = new RegExp(`<${tag}\\b`, 'i');
             const firstMatch = srcCode.match(re);
             const line = firstMatch ? srcCode.slice(0, firstMatch.index).split('\n').length : null;
             items.push({ text: `${els.length} &lt;${tag}&gt; tag${els.length === 1 ? '' : 's'} — deprecated, use CSS instead.`, line });
         }
     });
     const deprecatedAttrs = ['bgcolor', 'align', 'valign'];
     deprecatedAttrs.forEach(attr => {
         const els = doc.querySelectorAll(`[${attr}]`);
         if (els.length > 0) {
             const re = new RegExp(`\\s${attr}=`, 'i');
             const firstMatch = srcCode.match(re);
             const line = firstMatch ? srcCode.slice(0, firstMatch.index).split('\n').length : null;
             items.push({ text: `${els.length} element${els.length === 1 ? '' : 's'} using deprecated "${attr}" attribute — use CSS instead.`, line });
         }
     });
 }

 // 10. Bare <button> inside a <form> — with no type attribute, a <button>
 // defaults to type="submit". A common, genuinely surprising bug.
 {
     const bareFormButtons = doc.querySelectorAll('form button:not([type])');
     if (bareFormButtons.length > 0) {
         const firstMatch = srcCode.match(/<button\b(?![^>]*\btype=)/i);
         const line = firstMatch ? srcCode.slice(0, firstMatch.index).split('\n').length : null;
         items.push({ text: `${bareFormButtons.length} &lt;button&gt; tag${bareFormButtons.length === 1 ? '' : 's'} inside a &lt;form&gt; with no type attribute — defaults to type="submit" and will submit/reload the page on tap. Add type="button" if that's not what you want.`, line });
     }
 }

 return items;
 },

 runHtmlAudit() {
 const reportBox = document.getElementById('auditorReportBox');
 const counter = document.getElementById('auditCountHtml');
 document.getElementById('auditorModeTitle').innerText = "ACTIVE: HTML CHECK";
 
 const srcCode = this.getEditorContent();
 if (!srcCode.trim()) return this.clearBox('auditorReportBox', 'Workspace empty.');
 
 const items = this._detectHtmlIssues(srcCode);
 
 counter.innerText = items.length;
 if (items.length === 0) {
     reportBox.innerHTML = `<div style="color: var(--success); font-weight: bold;">✔ HTML tag architecture perfectly balanced.</div>`;
     return;
 }

 let html = '';
 items.forEach(item => {
     const clickable = item.line != null;
     html += `<div ${clickable ? `onclick="Nexus.UI.jumpToLine(${item.line})" style="cursor:pointer;"` : ''} style="background:var(--surface); padding:8px 10px; margin-bottom:6px; border-left:3px solid #ff7b72; border-radius:4px; ${clickable ? 'cursor:pointer;' : ''}">`
         + `<div style="display:flex; justify-content:space-between; align-items:center;">`
         + `<span style="color:#ff7b72; font-size:11px;">${item.text}</span>`
         + (clickable ? `<span style="font-size:9px; opacity:0.6; white-space:nowrap;">LN ${item.line} →</span>` : '')
         + `</div></div>`;
 });
 reportBox.innerHTML = html;
 },
 

    // Pure detection logic, shared by the individual JS-check button and the
    // unified full sweep below — returns errors without touching the DOM.
    _detectJsIssues(srcCode) {
        // FIX: this used to branch on the keyboard widget's currently-selected
        // language tab (Nexus.widgetConfig.keyboard.currentLang), which defaults
        // to 'html' regardless of what file is open and only changes when the
        // user manually taps a tab on the extra keyboard row. That meant a .js
        // file could silently skip real syntax checking (zero <script> tags
        // found, zero errors reported) and still show "clean". The file's own
        // extension is the correct, reliable signal — every other check in
        // this file already uses it.
        const ext = Nexus.state.activeFile ? Nexus.state.activeFile.split('.').pop().toLowerCase() : 'js';
        const errors = []; // { label, errName, line, message }

        if (ext === 'html') {
            const doc = this.getVirtualDoc(srcCode);
            doc.querySelectorAll('script').forEach((script, idx) => {
                if (!script.innerHTML.trim()) return;
                try {
                    new Function(script.innerHTML);
                } catch (err) {
                    let relLine = 1;
                    if (err.stack) {
                        const match = err.stack.match(/<anonymous>:(\d+):(\d+)/);
                        if (match) relLine = parseInt(match[1]);
                    }
                    // Find this block's actual starting line in the real file
                    // so the jump lands in the right place, not just relative
                    // to the isolated script snippet.
                    const blockStart = srcCode.indexOf(script.innerHTML);
                    const startLine = blockStart >= 0 ? srcCode.slice(0, blockStart).split('\n').length : 1;
                    errors.push({ label: `Script block [${idx + 1}]`, errName: err.name, line: startLine + relLine - 1, message: err.message });
                }
            });
        } else {
            try {
                new Function(srcCode);
            } catch (err) {
                let line = 1;
                if (err.stack) {
                    const match = err.stack.match(/<anonymous>:(\d+):(\d+)/);
                    if (match) line = parseInt(match[1]);
                }
                errors.push({ label: err.name, errName: err.name, line, message: err.message });
            }
        }
        return errors;
    },

    runJsAudit() {
        const reportBox = document.getElementById('auditorReportBox');
        const counter = document.getElementById('auditCountJs');
        document.getElementById('auditorModeTitle').innerText = "ACTIVE: JS COMPILER";

        const srcCode = this.getEditorContent();
        const errors = this._detectJsIssues(srcCode);

        counter.innerText = errors.length;
        if (errors.length === 0) {
            reportBox.innerHTML = `<div style="color: var(--success); font-weight: bold;">✔ JavaScript compilation evaluation clean.</div>`;
            return;
        }

        let html = '';
        errors.forEach(e => {
            const explain = Nexus.tutor.explainRuntimeError(e.message) || Nexus.tutor.explainRuntimeError(e.errName + ': ' + e.message);
            html += `<div onclick="Nexus.UI.jumpToLine(${e.line})" style="cursor:pointer; background:var(--surface); padding:8px 10px; margin-bottom:6px; border-left:3px solid var(--danger); border-radius:4px;">`
                + `<div style="display:flex; justify-content:space-between; align-items:center;">`
                + `<span style="color:var(--danger); font-size:10px; font-weight:bold;">${e.label} | LN ${e.line}</span>`
                + `<span style="font-size:9px; opacity:0.6;">TAP TO JUMP →</span>`
                + `</div>`
                + `<div style="font-size:11px; margin-top:4px; opacity:0.9; font-family:monospace;">${e.message}</div>`
                + (explain ? `<div onclick="event.stopPropagation();">${Nexus.tutor.renderExplainCard(explain)}</div>` : '')
                + `</div>`;
        });
        reportBox.innerHTML = html;
    },
    // Pure detection logic, shared by the individual orphan-check button and the
// unified full sweep below — returns orphans without touching the DOM.
// Resolves a src="" / href="" path against the project's actual files.
// Tries the path as-is (stripped of query/hash and a leading "./"), then
// falls back to matching by filename alone, so "js/app.js" still finds an
// "app.js" sitting at the project root.
_resolveVfsPath(refPath) {
    if (!refPath) return null;
    const clean = refPath.split('?')[0].split('#')[0].replace(/^\.\//, '');
    if (Nexus.state.Vfs[clean] !== undefined) return clean;
    const basename = clean.split('/').pop();
    return Object.keys(Nexus.state.Vfs).find(k => k === basename || k.endsWith('/' + basename)) || null;
},

// Ported from an earlier standalone version of this app that had a
// dedicated "runDependencyCheck" — flags import/src/href paths that don't
// resolve to any real file in the project. This is a genuinely different
// check from Project Radar (Nexus.graph): Radar finds files that exist
// but nothing reaches (dead code — the opposite failure), while this
// finds references that point at files that DON'T exist at all (typos,
// renamed/deleted files, wrong relative path). Neither one covers the
// other. Reuses _resolveVfsPath — the same normalization (query/hash
// stripping, ./ prefix, basename fallback) already trusted for the
// orphan-ID checker's own cross-file resolution — rather than a separate,
// simpler regex-based path match that could disagree with it on edge
// cases. Skips anything that looks like a real URL (http/https/protocol-
// relative //) since those are never meant to resolve against the local
// Vfs at all.
// Mobile-web footgun detector (Feature 5). A category of bug generic
// linters don't cover at all: things that are perfectly valid CSS/HTML/JS
// but specifically break or degrade on a touchscreen/mobile browser. Five
// checks, each verified against real deliberate examples before being
// wired in (both the "should flag" and "should NOT flag" cases for every
// rule, to keep false-positive risk low — a linter that cries wolf gets
// ignored):
//   1. Fixed 100vh (ignores mobile browser chrome/address bar — this
//      exact app's own boot code has a comment describing hitting this
//      real bug with divIDE itself). Excludes dvh/svh/lvh, the modern fix.
//   2. :hover with no :active/:focus fallback on the same selector — an
//      interaction that's invisible on a touch-only device.
//   3. Viewport meta tag missing entirely, or present without `width=` in
//      its content (present-but-incomplete is the more common real
//      mistake than missing outright).
//   4. <input> with no type hint and no explicit inputmode — the OS picks
//      a generic keyboard instead of the numeric/phone/email one that
//      would actually help.
//   5. mouseover/mouseenter listeners with no touch/pointer equivalent
//      anywhere in the same file — dead on a touchscreen.
_detectMobileIssues(srcCode, ext) {
    const issues = []; // { line, text }
    // Blank out comments before scanning, keeping newlines so every
    // reported line number still points at the right place. Without this
    // the rules match their own documentation: a CSS comment explaining
    // WHY 100vh is a problem was itself reported as a 100vh problem, and
    // an HTML comment mentioning an <input> would be linted as markup.
    // Same defect class as the tag scanner reading tags out of comments.
    const blankComments = (text, kind) => {
        let out = text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
        if (kind === 'html') out = out.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '));
        return out;
    };
    const scanSrc = blankComments(srcCode, (ext === 'html' || ext === 'htm') ? 'html' : 'code');
    const lines = scanSrc.split('\n');

    if (ext === 'css') {
        lines.forEach((line, i) => {
            // Recognise the standard progressive-enhancement idiom:
            //     height: 100vh;
            //     height: 100dvh;
            // The vh line is a deliberate fallback for browsers without
            // dvh support, not a bug — flagging it would push you to
            // delete the very thing keeping older browsers working.
            const nextLine = lines[i + 1] || '';
            // NB: \bdvh\b can never match "100dvh" — there's no word boundary
            // between the '0' and the 'd', so the original guard was dead and
            // this rule would have flagged even a correct dvh fallback.
            const DVH = /\d+dvh\b/;
            const hasDvhFallback = DVH.test(line) || DVH.test(nextLine);
            if (/\b100vh\b/.test(line) && !hasDvhFallback) {
                issues.push({ line: i + 1, text: '100vh ignores mobile browser chrome (address bar) — use 100dvh, or account for it explicitly.' });
            }
            const hoverMatch = line.match(/([.#][\w-]+):hover/);
            if (hoverMatch) {
                const selector = hoverMatch[1];
                if (!scanSrc.includes(selector + ':active') && !scanSrc.includes(selector + ':focus')) {
                    issues.push({ line: i + 1, text: `${selector}:hover has no :active/:focus fallback — invisible on touch-only devices.` });
                }
            }
        });
    }

    if (ext === 'html' || ext === 'htm') {
        const viewportMatch = scanSrc.match(/<meta[^>]+name=["']viewport["'][^>]*>/i);
        if (!viewportMatch) {
            issues.push({ line: 1, text: 'No <meta name="viewport"> tag — page will render tiny/zoomed-out on phones.' });
        } else {
            const contentMatch = viewportMatch[0].match(/content=["']([^"']*)["']/i);
            if (!contentMatch || !/width\s*=/.test(contentMatch[1])) {
                const line = scanSrc.slice(0, viewportMatch.index).split('\n').length;
                issues.push({ line, text: 'Viewport meta tag is missing width= in its content — likely won\'t fit the actual screen.' });
            }
        }
        // Rewritten to be actionable instead of blanket. The old rule
        // flagged EVERY input lacking a type/inputmode, which on this very
        // project meant 21 warnings covering a colour picker, a file
        // picker, and a pile of search boxes — all already correct. A
        // linter that fires on correct code just trains you to ignore it.
        //
        // It now fires only where the field's own name/id/placeholder says
        // it expects a particular kind of content while the markup doesn't
        // ask the OS for the matching keyboard. That's a real, fixable
        // mobile defect (typing a phone number on an alphabetic keyboard),
        // and it stays silent about genuine free-text fields.
        const EXEMPT_TYPES = /type=["'](?:tel|email|number|url|search|checkbox|radio|hidden|submit|button|file|color|range|date|time|datetime-local|month|week|password)["']/i;
        const HINTS = [
            { re: /phone|tel(?![a-z])|mobile/i, want: 'type="tel"', noun: 'a phone number' },
            { re: /e-?mail/i, want: 'type="email"', noun: 'an email address' },
            { re: /\burl\b|website|link|href/i, want: 'type="url"', noun: 'a URL' },
            { re: /number|count|qty|quantity|amount|price|width|height|size|port|zip|postal|age|year/i, want: 'inputmode="numeric"', noun: 'numbers' }
        ];
        const inputRe = /<input\b[^>]*>/gi;
        let m;
        while ((m = inputRe.exec(scanSrc))) {
            const tag = m[0];
            if (EXEMPT_TYPES.test(tag) || /inputmode=/i.test(tag)) continue;
            // Only descriptive attributes count as intent — testing the
            // whole tag would let an unrelated onclick handler or style
            // value trip the keyword match.
            const descriptors = (tag.match(/(?:id|name|placeholder|aria-label)=["'][^"']*["']/gi) || []).join(' ');
            if (!descriptors) continue;
            const hit = HINTS.find(h => h.re.test(descriptors));
            if (!hit) continue;
            const line = scanSrc.slice(0, m.index).split('\n').length;
            issues.push({ line, text: `This input looks like it expects ${hit.noun} but doesn't set ${hit.want} — phones will show a plain alphabetic keyboard for it.` });
        }
    }

    if (ext === 'js' || ext === 'mjs') {
        const hasTouchEquivalent = /touchstart|pointerdown|pointerenter/.test(scanSrc);
        lines.forEach((line, i) => {
            if (/addEventListener\(\s*['"](?:mouseover|mouseenter)['"]/.test(line) && !hasTouchEquivalent) {
                issues.push({ line: i + 1, text: 'mouseover/mouseenter listener with no touch/pointer equivalent anywhere in this file — has no effect on a touchscreen.' });
            }
        });
    }

    return issues;
},

// Ported from an earlier standalone version of this app that had a
// dedicated "runDependencyCheck" — flags import/src/href paths that don't
// resolve to any real file in the project. This is a genuinely different
// check from Project Radar (Nexus.graph): Radar finds files that exist
// but nothing reaches (dead code — the opposite failure), while this
// finds references that point at files that DON'T exist at all (typos,
// renamed/deleted files, wrong relative path). Neither one covers the
// other. Reuses _resolveVfsPath — the same normalization (query/hash
// stripping, ./ prefix, basename fallback) already trusted for the
// orphan-ID checker's own cross-file resolution — rather than a separate,
// simpler regex-based path match that could disagree with it on edge
// cases. Skips anything that looks like a real URL (http/https/protocol-
// relative //) since those are never meant to resolve against the local
// Vfs at all.
_detectMissingImports(srcCode) {
    // Matches src=/href= on ANY tag (not just <script>/<link>) — a broken
    // <img src="typo.png"> is exactly as real a bug as a broken <script
    // src>, and scanDeps() (Nexus.Sentinel, a separate object reusing this
    // same detector) already lists dependencies via this broader pattern;
    // narrower matching here would silently disagree with what that log
    // view shows for anything that isn't a <script>/<link> tag.
    // AUDIT FIX: the import branch previously required `from` —
    // /import\s+.*?from\s+['"]...['"]/ — so a bare side-effect import
    // (`import './polyfill.js';`, with no binding and no `from`) never
    // matched at all. That's an extremely common form (CSS imports,
    // polyfills, modules imported purely to register themselves), and the
    // tool silently reported "everything resolves" while never having
    // looked at them — the worst failure mode for a diagnostic. Making
    // the `<bindings> from` portion optional catches both, verified
    // against all 8 real import/require/src/href forms.
    const importRegex = /(?:import\s+(?:[^'"();]*?\sfrom\s+)?['"]([^'"]+)['"])|(?:require\(\s*['"]([^'"]+)['"]\s*\))|(?:\bsrc=['"]([^'"]+)['"])|(?:\bhref=['"]([^'"]+)['"])/g;
    const seen = new Set();
    const missing = [];
    let m;
    while ((m = importRegex.exec(srcCode)) !== null) {
        const raw = m[1] || m[2] || m[3] || m[4];
        if (!raw || seen.has(raw)) continue;
        seen.add(raw);
        if (/^(?:https?:)?\/\//i.test(raw) || raw.startsWith('data:') || raw.startsWith('#') || raw.startsWith('mailto:') || raw.startsWith('tel:')) continue; // remote URLs, same-page anchors, and mailto/tel links aren't local Vfs references at all
        if (this._resolveVfsPath(raw)) continue; // resolves fine — not an issue
        const idx = srcCode.indexOf(raw);
        const line = idx >= 0 ? srcCode.slice(0, idx).split('\n').length : null;
        missing.push({ path: raw, line });
    }
    return missing;
},

_detectOrphanIssues(srcCode) {
    const doc = this.getVirtualDoc(srcCode);
    const allElements = doc.querySelectorAll('[id]');

    // Gather every place this id could legitimately be referenced from:
    // inline <script>/<style> in this file, PLUS any separately-linked
    // .js/.css files that actually exist in the project. Checking only
    // inline script content (as this used to) meant any id used purely for
    // CSS styling, or any multi-file project at all, got flagged wholesale.
    let scriptContent = '';
    let styleContent = '';
    doc.querySelectorAll('script').forEach(scr => {
        scriptContent += scr.innerHTML + '\n';
        const resolved = this._resolveVfsPath(scr.getAttribute('src'));
        if (resolved) scriptContent += Nexus.state.Vfs[resolved] + '\n';
    });
    doc.querySelectorAll('style').forEach(st => styleContent += st.innerHTML + '\n');
    doc.querySelectorAll('link').forEach(link => {
        const rel = (link.getAttribute('rel') || '').toLowerCase();
        const href = link.getAttribute('href') || '';
        if (rel === 'stylesheet' || /\.css$/i.test(href)) {
            const resolved = this._resolveVfsPath(href);
            if (resolved) styleContent += Nexus.state.Vfs[resolved] + '\n';
        }
    });
    // Comment stripping REMOVED, deliberately. A naive /*...*/ regex has no
    // idea what a string literal is, and this very file contains 15 comment
    // openers inside strings (the sprite tool emits "/* Generated by ... */"
    // CSS, for one). Each unbalanced one made the regex swallow everything
    // up to the next */ ANYWHERE later in the file — deleting real code
    // from the text being analysed. That's what produced phantom orphan
    // reports: ids like #spriteDims and #navDrawer genuinely ARE referenced,
    // but the reference had been eaten before the check ran.
    //
    // Not stripping is also the safer direction: an id mentioned only in a
    // comment now counts as "referenced", so this can under-report an
    // orphan but can no longer invent one. A tool that cries wolf gets
    // ignored, which is worse than one that occasionally stays quiet.

    // HTML has its OWN reference mechanisms that never touch script or
    // style at all — an id used only as a same-page anchor target, a form
    // label's target, or an ARIA relationship is completely normal, valid
    // usage, not an orphan. Collect every id referenced this way once,
    // up front.
    const htmlReferencedIds = new Set();
    const addIds = (val) => { (val || '').split(/\s+/).forEach(v => { if (v) htmlReferencedIds.add(v); }); };
    doc.querySelectorAll('[href]').forEach(el => {
        const href = el.getAttribute('href') || '';
        if (href.startsWith('#') && href.length > 1) htmlReferencedIds.add(href.slice(1));
    });
    doc.querySelectorAll('[for]').forEach(el => addIds(el.getAttribute('for'))); // label, output
    doc.querySelectorAll('[aria-labelledby]').forEach(el => addIds(el.getAttribute('aria-labelledby')));
    doc.querySelectorAll('[aria-describedby]').forEach(el => addIds(el.getAttribute('aria-describedby')));
    doc.querySelectorAll('[aria-controls]').forEach(el => addIds(el.getAttribute('aria-controls')));
    doc.querySelectorAll('[aria-owns]').forEach(el => addIds(el.getAttribute('aria-owns')));
    doc.querySelectorAll('[aria-activedescendant]').forEach(el => addIds(el.getAttribute('aria-activedescendant')));
    doc.querySelectorAll('[form]').forEach(el => addIds(el.getAttribute('form')));
    doc.querySelectorAll('[list]').forEach(el => addIds(el.getAttribute('list')));

    // Core Nexus structural elements that are targeted dynamically or via global UI loops
    const nexusSafeList = [
        'editor', 'auditorReportBox', 'panelRight', 'diagOut',
        'workspace', 'editorView', 'nexusDock', 
        'searchDrawer', 'writerDrawer', 'audit-drawer', 'audit-results'
    ];

    const orphans = []; // { id, tag, line }

    // Tokenise once, look up many. Identifiers in script text and #ids in
    // style text are each collected in a single pass, so the per-element
    // loop below is O(1) per id instead of a full-text regex scan per id.
    const scriptWords = new Set(scriptContent.match(/[A-Za-z_$][\w$-]*/g) || []);
    const styleIds = new Set((styleContent.match(/#[A-Za-z_][\w-]*/g) || []).map(m => m.slice(1)));

    allElements.forEach(el => {
        const id = el.id;
        if (!id) return;

        // 1. Bypass explicit framework infrastructure elements
        if (nexusSafeList.includes(id)) return;

        // 2. Bypass dynamic modular frames (any ID starting with "modal-" or "sb-")
        if (id.startsWith('modal') || id.startsWith('sb')) return;

        // Was: build two fresh RegExps per id and scan the ENTIRE script
        // and style text with each. With ~240 ids and a linked app.js
        // pulled inline, that meant scanning ~800KB roughly 240 times over
        // — hundreds of megabytes of regex work for one sweep, which is
        // what actually froze the tool on a real project. The script and
        // styles are now tokenised once (see scriptWords/styleIds built
        // before this loop) and each id is a single Set lookup.
        const usedInScript = scriptWords.has(id);
        const usedInStyle = styleIds.has(id);
        const usedInHtml = htmlReferencedIds.has(id);

        if (!usedInScript && !usedInStyle && !usedInHtml) {
            // Find where this id is actually defined in the markup, to jump
            // to it. Escaping is only needed on this path now — the two
            // hot-loop regexes it used to also serve were replaced by Set
            // lookups, so this only runs for ids actually being reported.
            const escapedId = id.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
            const defMatch = srcCode.match(new RegExp(`id=["']${escapedId}["']`));
            const line = defMatch ? srcCode.slice(0, defMatch.index).split('\n').length : null;
            orphans.push({ id, tag: el.tagName.toLowerCase(), line });
        }
    });
    return orphans;
},

runOrphanAudit() {
    const reportBox = document.getElementById('auditorReportBox');
    const counter = document.getElementById('auditCountOrphans');
    document.getElementById('auditorModeTitle').innerText = "ACTIVE: ORPHAN DETECTION";

    const srcCode = this.getEditorContent();
    if (!srcCode.trim()) return;

    const orphans = this._detectOrphanIssues(srcCode);

    counter.innerText = orphans.length;
    if (orphans.length === 0) {
        reportBox.innerHTML = `<div style="color: var(--success); font-weight: bold;">✔ All element IDs map to script functions.</div>`;
        return;
    }

    let html = `<div style="color:var(--gold); font-weight:bold; margin-bottom:6px;">ORPHANED IDS</div>`;
    orphans.forEach(o => {
        const clickable = o.line != null;
        html += `<div ${clickable ? `onclick="Nexus.UI.jumpToLine(${o.line})" style="cursor:pointer;"` : ''} style="background:var(--surface); padding:6px 10px; margin-bottom:4px; border-left:3px solid var(--gold); border-radius:4px; display:flex; justify-content:space-between; align-items:center;">`
            + `<span style="font-size:11px;">#${o.id} <span style="opacity:0.6;">(${o.tag})</span></span>`
            + (clickable ? `<span style="font-size:9px; opacity:0.6; white-space:nowrap;">LN ${o.line} →</span>` : '')
            + `</div>`;
    });
    reportBox.innerHTML = html;
},
// Ensure this lives cleanly inside your Nexus.auditor = { ... } block
_detectCssIssues(srcCode) {
    const doc = this.getVirtualDoc(srcCode);
    let styleContent = '';
    doc.querySelectorAll('style').forEach(st => styleContent += st.innerHTML);

    // Clear out CSS comments safely
    styleContent = styleContent.replace(/\/\*[\s\S]*?\*\//g, '');

    // Match all hashtags
    const allMatches = styleContent.match(/#([a-zA-Z0-9_-]+)/g) || [];
    const uniqueSelectors = [...new Set(allMatches)];

    const unused = []; // { selector, line }

    // Base framework elements to naturally greenlight
    const baseSafeStyles = ['editor', 'panelRight', 'footer'];

    uniqueSelectors.forEach(selector => {
        const id = selector.replace('#', '');
        
        // 1. Safe Bypass check
        if (baseSafeStyles.includes(id)) return;

        // 2. HEX COLOR FILTER: If it's 3 or 6 characters and only contains hex digits (a-f, 0-9), ignore it!
        if (/^[0-9a-fA-F]{3}$/.test(id) || /^[0-9a-fA-F]{6}$/.test(id)) {
            return; 
        }

        // 3. Check if the element actually exists in the DOM tree
        if (!doc.getElementById(id)) {
            // Double check if it might be handled dynamically via a base panel prefix
            if (doc.querySelector(`[id$="${id}"]`) || doc.querySelector(`[id*="${id}"]`)) return;

            // Find where this selector is actually defined in the CSS, to jump to it
            const escapedId = id.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
            const defMatch = srcCode.match(new RegExp(`#${escapedId}(?=[\\s,{:.\\[])`));
            const line = defMatch ? srcCode.slice(0, defMatch.index).split('\n').length : null;
            unused.push({ selector, line });
        }
    });
    return unused;
},
runCssAudit() {
    const reportBox = document.getElementById('auditorReportBox');
    const counter = document.getElementById('auditCountCss');
    document.getElementById('auditorModeTitle').innerText = "ACTIVE: CSS DEADBREAD SCAN";

    const srcCode = this.getEditorContent();
    if (!srcCode.trim()) return;

    const unused = this._detectCssIssues(srcCode);

    counter.innerText = unused.length;
    if (unused.length === 0) {
        reportBox.innerHTML = `<div style="color: var(--success); font-weight: bold;">✔ Clean compilation. 100% of defined styles map directly to active elements.</div>`;
        return;
    }

    let html = `<div style="color:var(--gold); font-weight:bold; margin-bottom:6px;">UNUSED SELECTORS</div>`;
    unused.forEach(u => {
        const clickable = u.line != null;
        html += `<div ${clickable ? `onclick="Nexus.UI.jumpToLine(${u.line})" style="cursor:pointer;"` : ''} style="background:var(--surface); padding:6px 10px; margin-bottom:4px; border-left:3px solid var(--gold); border-radius:4px; display:flex; justify-content:space-between; align-items:center;">`
            + `<span style="font-size:11px;">${u.selector}</span>`
            + (clickable ? `<span style="font-size:9px; opacity:0.6; white-space:nowrap;">LN ${u.line} →</span>` : '')
            + `</div>`;
    });
    reportBox.innerHTML = html;
},
},

   Terminal: {
   instance: null,
   fitAddon: null,
   commandBuffer: '',
   
   init() {
   if (this.instance) return;

   // FIX (real, previously-unguarded boot-time crash): this used to call
   // `new Terminal(...)` and `new FitAddon.FitAddon()` completely
   // unguarded — both are GLOBALS that only exist once their respective
   // CDN scripts (xterm.js, xterm-addon-fit) have actually finished
   // loading and executing. Nexus.UI.boot() only ever checked
   // `typeof Nexus.Terminal.init === 'function'` before calling this —
   // that confirms the FUNCTION exists, not that ITS dependencies do. If
   // either CDN script hadn't finished loading yet by the time boot
   // reached this line (slow connection, first-ever load before the
   // service worker's precache existed, a blocked/failed request), this
   // threw a genuine, completely uncaught ReferenceError — and since
   // there was no try/catch anywhere around it, that uncaught throw
   // HALTED THE REST OF BOOT MID-SEQUENCE: everything scheduled after
   // this line in Nexus.UI.boot() (CM6/edit-mode restoration, keyboard-
   // viewport tracking) would simply never run. That's exactly the
   // "random undefined" symptom pattern from earlier — a boot-time
   // exception silently skipping later initialization, not a single
   // broken feature.
   if (typeof Terminal === 'undefined' || typeof FitAddon === 'undefined') {
       console.error("VORTEX: xterm.js or its fit addon failed to load — the in-app Terminal will be unavailable this session, but nothing else is affected.");
       if (Nexus.shell && typeof Nexus.shell.out === 'function') {
           Nexus.shell.out("Terminal unavailable — xterm.js didn't load (check your connection).", 'warn');
       }
       return;
   }
   
   // 1. Initialize xterm
   this.instance = new Terminal({
   theme: {
   background: '#0d1117',
   foreground: '#c9d1d9',
   cursor: '#d29922', // Gold cursor to match Nexus
   selection: 'rgba(47, 129, 247, 0.3)'
   },
   fontFamily: 'monospace',
   fontSize: 13,
   cursorBlink: true,
   allowProposedApi: true
   });
   
   // 2. Load Fit Addon
   this.fitAddon = new FitAddon.FitAddon();
   this.instance.loadAddon(this.fitAddon);
   
   // 3. Open in container
   this.instance.open(document.getElementById('xtermContainer'));
   this.fitAddon.fit();
   
   // 4. Welcome Message
   this.instance.writeln('\x1b[1;34m» NEXUS MATRIX TERMINAL v1.0\x1b[0m');
   this.instance.writeln('Type \x1b[33mhelp\x1b[0m for system commands.');
   this.instance.write('\r\n$ ');
   
   // 5. Input Handler
   this.instance.onData(e => {
   switch (e) {
   case '\r': // Enter
   this.instance.write('\r\n');
   this.processCommand(this.commandBuffer);
   this.commandBuffer = '';
   this.instance.write('$ ');
   break;
   case '\u007f': // Backspace
   if (this.commandBuffer.length > 0) {
   this.commandBuffer = this.commandBuffer.slice(0, -1);
   this.instance.write('\b \b');
   }
   break;
   default:
   if (e.length === 1) { // Normal typing
   this.commandBuffer += e;
   this.instance.write(e);
   }
   }
   });
   },
   
async processCommand(cmd) {
    if (!cmd.trim()) return;
    
    try {
        // AWAIT the shell execution so the terminal pauses for the result
        const result = await Nexus.shell.exec(cmd);
        
        if (result !== undefined) {
            // xterm.js requires \r\n for proper carriage returns
            const formattedResult = String(result).replace(/\n/g, '\r\n');
            this.instance.writeln(formattedResult);
        }
    } catch (err) {
        this.instance.writeln(`\x1b[31mError: ${err.message}\x1b[0m`);
    }
},

   
   toggle() {
   const panel = document.getElementById('panelTerminal');
   const isOpen = panel.classList.toggle('open');
   
   if (isOpen) {
   // Same fix as toggleSidebar('right') — this panel and panel-right
   // share identical full-width/z-index right-side styling, so make
   // sure the tools panel isn't left open underneath and blocked.
   const toolsPanel = document.getElementById('panelRight');
   if (toolsPanel && toolsPanel.classList.contains('open')) toolsPanel.classList.remove('open');
   this.init();
   // Small delay to allow the drawer animation to finish before fitting
   setTimeout(() => this.fitAddon.fit(), 400);
   }
   }
   },

   
Vfs: {
    // --- 0. IMAGE / BINARY SUPPORT ---
    // Images can't go through FileReader.readAsText() — that runs binary
    // bytes through a UTF-8 decode, which is lossy and irreversible.
    // Verified directly: a 62-byte PNG comes back as 70 bytes and no
    // longer matches the original, so loading an image used to silently
    // CORRUPT it rather than merely fail to display it. Images are stored
    // as data URLs instead ("data:image/png;base64,...") which round-trip
    // byte-for-byte, are valid strings (so the whole existing Vfs /
    // storage / snapshot machinery keeps working untouched), and can be
    // dropped straight into an <img src> with no conversion.
    IMAGE_EXTS: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'],

    isImageFile(filename) {
        if (!filename) return false;
        const ext = filename.split('.').pop().toLowerCase();
        return this.IMAGE_EXTS.includes(ext);
    },

    // True for content already stored as a data URL. Checked by content
    // rather than by filename alone, because that's what actually decides
    // whether something can be rendered or must be treated as text.
    isDataUrl(content) {
        return typeof content === 'string' && /^data:[^;,]+;base64,/.test(content);
    },

    imageMimeFor(filename) {
        const ext = (filename || '').split('.').pop().toLowerCase();
        const map = {
            png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
            gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
            bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif'
        };
        return map[ext] || 'application/octet-stream';
    },

    // Rough decoded byte count from a base64 data URL, without actually
    // decoding it — base64 encodes 3 bytes per 4 chars, minus padding.
    dataUrlByteSize(dataUrl) {
        if (!this.isDataUrl(dataUrl)) return 0;
        const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
        const padding = (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
        return Math.max(0, Math.floor(b64.length * 3 / 4) - padding);
    },

    // --- 1. LIFECYCLE & PERSISTENCE ---
    async boot() {
        try {
            // Migration-aware boot: Checks v42 primary, falls back to v41
            let Vfs = await safeStorage.getItem('Nexus.state.Vfs_v42') || await safeStorage.getItem('Nexus.state.Vfs_v41');
            let orig = await safeStorage.getItem('nexus_originals_v42') || await safeStorage.getItem('nexus_originals_v41');
            
            if (Vfs && Object.keys(Vfs).length > 0) {
                Nexus.state.Vfs = Vfs;
                Nexus.state.originals = orig || {};
            } else {
                return this.setEmptyState();
            }

            // Integrity Check: Ensure every Vfs entry has a 'Sovereign Original' backup
            Object.keys(Nexus.state.Vfs).forEach(fn => { 
                if (!Nexus.state.originals[fn]) Nexus.state.originals[fn] = Nexus.state.Vfs[fn]; 
            });

            // Seed the dirty-tracking baseline to whatever was actually
            // loaded from disk — this IS "last saved" as far as this
            // session is concerned, since it's what boot just read back
            // out of IndexedDB. Anything typed after this point that
            // differs from it is genuinely unsaved.
            Nexus.state.lastSavedContent = { ...Nexus.state.Vfs };

            // Restore which tabs were open last session. Filtered against
            // the files that actually still exist, in case one was
            // deleted through some other path (another device, a future
            // sync feature) between sessions. Falls back to an empty tab
            // bar — not "every file" — if nothing was saved, matching the
            // new default of files sitting unopened in the explorer.
            const savedTabs = await safeStorage.getItem('nexus_open_tabs_v1');
            Nexus.state.openTabs = Array.isArray(savedTabs)
                ? savedTabs.filter(fn => Nexus.state.Vfs[fn] !== undefined)
                : [];

            const files = Object.keys(Nexus.state.Vfs);
            // Prefer the file the user was actually working in last session
            // (persisted by switchFile on every switch) — falling back to the
            // first file only if that one no longer exists.
            const lastActive = await safeStorage.getItem('nexus_last_active_file');
            if (lastActive && files.includes(lastActive)) {
                Nexus.state.activeFile = lastActive;
            } else if (!Nexus.state.activeFile || !files.includes(Nexus.state.activeFile)) {
                Nexus.state.activeFile = files[0];
            }

            this.switchFile(Nexus.state.activeFile);
            
        } catch (e) {
            console.error("VORTEX CRITICAL FAILURE:", e);
            this.setEmptyState();
        }
    },

    // Persists the open-tabs list. Its own small dedicated write (not
    // folded into the main Vfs save() below) because it changes on a
    // different rhythm — every tab open/close, not every keystroke — and
    // needs to survive independently of whether the user has unsaved file
    // content sitting around.
    saveOpenTabs() {
        safeStorage.setItem('nexus_open_tabs_v1', Nexus.state.openTabs);
    },

    async save() {
        // Persist using v42 keys to maintain migration integrity
        try {
            await safeStorage.setItem('Nexus.state.Vfs_v42', Nexus.state.Vfs);
            await safeStorage.setItem('nexus_originals_v42', Nexus.state.originals);
            return true;
        } catch (e) {
            // This used to fail silently — a rejected IndexedDB write (quota
            // exceeded, private browsing, extension blocking storage, etc.)
            // just vanished, and whatever the user had just typed was never
            // actually persisted even though nothing on screen said so.
            console.error("VORTEX SAVE FAILURE: write to IndexedDB rejected.", e);
            if (Nexus.shell && typeof Nexus.shell.out === 'function') {
                Nexus.shell.out("⚠️ Save failed — your last changes may not be stored. Check storage/private-browsing settings.", "error");
            }
            return false;
        }
    },

    // True if fn's current in-memory content differs from its
    // lastSavedContent baseline. IMPORTANT: this is NOT "differs from
    // what's in IndexedDB right now" — this app autosaves to IndexedDB on
    // basically every keystroke (400ms debounce), so almost nothing would
    // ever read as dirty under that definition and the close-tab warning
    // would be meaningless. lastSavedContent is instead updated only by
    // manualSave() (the explicit 💾 tap) — "unsaved work" here means
    // "changed since you last deliberately hit Save," which is what a
    // person actually means by that phrase, autosave notwithstanding.
    // Seeded to match Vfs at boot (see Vfs.boot()) so a freshly-loaded,
    // untouched file never reads as dirty before any edit has happened.
    isDirty(fn) {
        if (Nexus.state.Vfs[fn] === undefined) return false;
        return Nexus.state.Vfs[fn] !== Nexus.state.lastSavedContent[fn];
    },

    // Explicit, tappable Save — autosave already runs silently in the
    // background, but a dedicated button gives an immediate, visible
    // confirmation instead of asking the user to just trust it happened.
    // Flushes the live editor (whichever engine is active) straight to
    // storage, bypassing the debounce entirely.
    async manualSave() {
        if (!Nexus.state.activeFile) {
            Nexus.shell.out('No file open to save.', 'warn');
            return;
        }
        const code = Nexus.Sentinel.getLiveCode();
        Nexus.state.Vfs[Nexus.state.activeFile] = code;
        clearTimeout(Nexus.editorCore._autosaveTimer);

        const btn = document.getElementById('ribbonSaveBtn');
        if (btn) btn.classList.add('saving');

        const ok = await this.save();
        // The ONE place lastSavedContent's baseline moves — see isDirty()'s
        // own comment for why this is scoped to the explicit Save tap and
        // not the constant autosave writes save() also serves. Only the
        // file actually just saved gets its baseline updated, not every
        // file in Vfs — a manual save of one tab shouldn't silently mark
        // every OTHER open tab as "saved" too when their content was never
        // touched by this action at all.
        if (ok) Nexus.state.lastSavedContent[Nexus.state.activeFile] = code;
        // Baseline just moved to match current content, so every line
        // should now read as unchanged — clears the change gutter
        // immediately rather than leaving stale marks up until the next
        // edit's own debounce fires.
        if (ok && Nexus.editorCore.refreshChangeGutter) Nexus.editorCore.refreshChangeGutter();

        if (btn) {
            btn.classList.remove('saving');
            if (ok) {
                btn.classList.add('saved-flash');
                setTimeout(() => btn.classList.remove('saved-flash'), 700);
            }
        }
        if (ok) Nexus.shell.out(`Saved ${Nexus.state.activeFile} ✅`, 'success');
        // Failure already surfaces its own toast from save() above.
    },
setEmptyState() {
    // The image viewer replaces #editorView while an image tab is open, so
    // an empty workspace has to tear it down too — otherwise closing the
    // last (image) tab left the picture and its whole tool panel sitting
    // there, and it only disappeared once you happened to open a different
    // file. hide() restores #editorView, which the rest of this function
    // then correctly resets.
    if (Nexus.imageViewer && typeof Nexus.imageViewer.hide === 'function') {
        Nexus.imageViewer.hide();
    }
    Nexus.state.activeFile = "";
    
    // No file open at all is a distinct situation from either edit mode —
    // there's nothing to type into either way — so this intentionally does
    // NOT call setEditMode() or write to Nexus.state.prefs.editMode. Doing
    // so would either resurrect a third persisted mode (exactly what this
    // refactor removes) or silently overwrite the user's real last-used
    // mode preference with a value that only ever meant "no file," making
    // the next file they open forget what they had it set to. This is a
    // purely visual "nothing to edit" display, locally scoped to the DOM.
    const ed = document.getElementById('rawTerminal');
    if (ed) {
        ed.value = "";
        ed.setAttribute('readonly', 'true');
        ed.setAttribute('inputmode', 'none');
    }
    if (Nexus.editorCore && Nexus.editorCore.view && Nexus.editorCore.view.contentDOM) {
        // FIX: this used to only lock the CM6 view (contentEditable/
        // inputmode) without ever clearing its actual document — so
        // closing the last tab while CM6 was the active engine correctly
        // disabled typing, but left whatever the last-open file's content
        // WAS still fully visible on screen. #rawTerminal (a few lines up)
        // was already being cleared correctly; CM6's own doc just never
        // was. Same full-document-replace dispatch already used elsewhere
        // in this file (e.g. loading a new file's content into CM6).
        if (Nexus.editorCore.view.state.doc.length > 0) {
            Nexus.editorCore.view.dispatch({ changes: { from: 0, to: Nexus.editorCore.view.state.doc.length, insert: '' } });
        }
        Nexus.editorCore.view.contentDOM.contentEditable = "false";
        Nexus.editorCore.view.contentDOM.setAttribute('inputmode', 'none');
    }

    // Defensive guards stop the 'innerText' of null crash dead in its tracks
    const footFile = document.getElementById('footFile');
    if (footFile) footFile.innerText = "VORTEX EMPTY";
    
    const st = document.getElementById('footStatus');
    if (st) {
        st.innerText = "NO FILE OPEN";
        st.style.color = "var(--danger)";
    }
    
    // Still visually shows the lock glyph on the edit button while no file
    // is open — this bypasses .edit-btn-trigger's normal util/full classing
    // on purpose, since neither state applies here, but does NOT touch
    // Nexus.state.prefs.editMode, so whichever real mode was active before
    // the file closed is exactly what's restored the next time a file
    // actually opens (switchFile / boot both call setEditMode explicitly).
    const lockBtns = document.querySelectorAll('.edit-btn-trigger');
    lockBtns.forEach(btn => {
        btn.innerHTML = "🚫"; 
        btn.title = "No file open";
        btn.setAttribute('aria-label', 'No file is open');
        btn.className = "tool-btn edit-btn-trigger btn-edit-lock";
    });
    const editIcon = document.getElementById('ribbonMenuEditIcon');
    if (editIcon) editIcon.textContent = "🚫";

    this.renderAccordion();
    if (Nexus.UI && typeof Nexus.UI.updateGutter === 'function') {
        Nexus.UI.updateGutter();
    }
},



    // --- 2. CORE FILE OPERATIONS ---
    async newFile() {
        // Validates before accepting rather than after: the old flow took
        // whatever you typed, then popped a SECOND modal saying the name
        // was already taken — losing what you'd typed and making you start
        // over. Now a conflict is caught inline with the text still there
        // to edit.
        const existing = Object.keys(Nexus.state.Vfs);
        const name = await Nexus.UI.askInput({
            title: 'NEW FILE',
            label: 'Filename — include a folder to nest it (src/app.js)',
            placeholder: 'index.html',
            hint: existing.length ? `${existing.length} file(s) already in this project` : 'This will be the first file',
            validate: (v) => {
                const t = (v || '').trim();
                if (!t) return 'Enter a filename.';
                if (Nexus.state.Vfs[t] !== undefined) return `"${t}" already exists — pick another name.`;
                if (t.endsWith('/')) return 'That is a folder path, not a filename.';
                if (!t.split('/').pop()) return 'Missing a filename after the folder.';
                return null;
            }
        });
        if (!name) return;
        const trimmed = name.trim();

        Nexus.state.Vfs[trimmed] = ""; 
        Nexus.state.originals[trimmed] = "";
        // Seed the dirty-tracking baseline to match — a brand-new empty
        // file hasn't diverged from anything yet, so it shouldn't
        // immediately read as having "unsaved work" the instant it's
        // created, before the user has typed a single character.
        Nexus.state.lastSavedContent[trimmed] = "";
        
        this.renderAccordion();
        this.switchFile(trimmed);
        this.save();
        
        // Route through the real state machine instead of poking
        // readonly/inputmode attributes directly — the direct-poke version
        // never updated Nexus.state.prefs.editMode, the dropdown menu icon,
        // or the .edit-btn-trigger button class, so a brand-new file LOOKED
        // unlocked but every other piece of edit-mode UI silently still
        // showed the previous file's state until the next explicit toggle.
        // A freshly created empty file goes straight to Full Edit — the
        // whole point of "new file" is to start typing immediately.
        Nexus.UI.setEditMode('full');
        const st = document.getElementById('footStatus');
        if (st) st.innerText = "READY (NEW)";
    },

    switchFile(fn) {
        if (!fn || (Nexus.state.Vfs[fn] === undefined)) return;

        // Flush any pending debounced autosave from the file we're leaving
        if (Nexus.editorCore && Nexus.editorCore._autosaveTimer) {
            clearTimeout(Nexus.editorCore._autosaveTimer);
            Nexus.editorCore._autosaveTimer = null;
            this.save();
        }

        // Files sit in the left explorer until explicitly clicked — THIS
        // is that click. Opens (or re-focuses, if already open) a tab for
        // fn without touching any other open tab. Order is append-if-new,
        // so newly opened files land at the end of the tab bar rather than
        // reordering existing tabs.
        if (!Nexus.state.openTabs.includes(fn)) {
            Nexus.state.openTabs.push(fn);
            this.saveOpenTabs();
        }

        Nexus.state.activeFile = fn;
        // Remember which file is open — a tiny string write — so a reload
        // puts the user back where they were, instead of always dumping them
        // into whichever file happens to be first in the project.
        safeStorage.setItem('nexus_last_active_file', fn);
        const code = Nexus.state.Vfs[fn];
        const footFile = document.getElementById('footFile');
        if (footFile) footFile.innerText = "FILE: " + fn.toUpperCase();

        // Auto-switch the virtual keyboard to match this file's language,
        // same idea as CM6's own extension-to-syntax-highlighting mapping.
        // Only acts when a keyboard layout actually exists for this
        // extension — an unmapped extension (e.g. .txt) leaves whatever
        // tab was already selected alone rather than forcing an arbitrary
        // fallback, since guessing wrong would be more disruptive than
        // just not switching.
        const kbExt = fn.split('.').pop().toLowerCase();
        const KB_EXT_MAP = {
            html: 'html', htm: 'html',
            css: 'css', scss: 'css', less: 'css',
            js: 'js', mjs: 'js', jsx: 'js',
            ts: 'ts', tsx: 'ts',
            py: 'py', pyw: 'py',
            sql: 'sql',
            yaml: 'yaml', yml: 'yaml',
            sh: 'sh', bash: 'sh',
            md: 'md', markdown: 'md'
        };
        const kbLang = KB_EXT_MAP[kbExt];
        if (kbLang && Nexus.state.prefs.kbLayouts && Nexus.state.prefs.kbLayouts[kbLang] && typeof Nexus.kb !== 'undefined' && typeof Nexus.kb.switchLang === 'function') {
            Nexus.kb.switchLang(kbLang);
            // Also move the corresponding tab button's "active" class —
            // switchLang() already does this internally via its own
            // querySelectorAll pass, so no separate DOM update is needed
            // here beyond the call itself.
        }

        // Engine Routing
        // Images bypass the text engines entirely — dumping a base64 data
        // URL into a code editor would be both useless to look at and
        // dangerously easy to corrupt with a stray keystroke. imageViewer
        // takes over the editor area instead, and hides itself again the
        // moment a normal text file is opened.
        if (this.isImageFile(fn) && Nexus.imageViewer) {
            Nexus.imageViewer.show(fn);
            Nexus.UI.renderTabs();
            return;
        }
        if (Nexus.imageViewer) Nexus.imageViewer.hide();

        if (Nexus.editorCore && Nexus.editorCore.isCM6 && Nexus.editorCore.view) {
            const view = Nexus.editorCore.view;
            // Keep the file swap OUT of the undo history. Switching files
            // reuses one EditorState and replaces its whole document, so
            // without this the swap is just another undoable edit — press
            // undo right after switching and CM6 faithfully restores the
            // previous file's entire text into the file you're now looking
            // at, which then autosaves over it. Marking it
            // addToHistory:false makes undo skip straight back to your last
            // real edit in this file instead.
            const { Transaction } = Nexus.editorCore.modules;
            const swapSpec = { changes: { from: 0, to: view.state.doc.length, insert: code } };
            if (Transaction && Transaction.addToHistory) {
                swapSpec.annotations = Transaction.addToHistory.of(false);
            }
            view.dispatch(swapSpec);
            document.getElementById('footStatus').innerText = "ENGINE: CM6 ACTIVE";

            // Restore this file's saved bookmarks into the gutter. The
            // dispatch above just replaced the ENTIRE document (0 to
            // length) to load the new file's content — the bookmark
            // StateField's automatic position-remapping only tracks
            // incremental edits within one file, not "swap out to a
            // completely different file's content," so whatever markers
            // existed for the PREVIOUS file are gone after that dispatch
            // and this file's own markers need to be re-applied fresh.
            if (typeof Nexus.UI._restoreBookmarksToCM6 === 'function') {
                Nexus.UI._restoreBookmarksToCM6(view, fn);
            }
            // Same reasoning as the bookmark restore just above: the
            // change gutter's own StateField only tracks incremental edits
            // within one file, so after swapping the entire document out
            // for a different file's content it needs a fresh recompute
            // against THIS file's own lastSavedContent baseline, not
            // whatever marks were left over from the previous file.
            if (Nexus.editorCore.refreshChangeGutter) Nexus.editorCore.refreshChangeGutter();
        } else {
            const ed = document.getElementById('rawTerminal');
            if (ed) {
                ed.value = code;
                Nexus.UI.updateGutter();
            }
        }

        this.renderAccordion();

        // Keep the diagnostics panel's relevant-tools filter in sync if
        // it's already open when the file changes — otherwise switching
        // from a .js file to a .css file mid-session would leave stale
        // JS-only tools visible (or CSS tools hidden) until the panel was
        // closed and reopened.
        if (Nexus.UI && typeof Nexus.UI.filterDiagPanel === 'function') {
            Nexus.UI.filterDiagPanel();
        }

        // Footer Status Sync. switchFile() only ever runs for a real,
        // existing file (guarded at the top of this function).
        //
        // FIX (real bug — "file opens, editor won't accept input"):
        // 'readonly' is only ever SET by setEmptyState(), but nothing ever
        // guaranteed it gets CLEARED again once a real file opens —
        // switchFile() never called setEditMode() at all before this fix.
        // Edit-mode restoration only happened once, at boot, via a
        // one-time setTimeout gated on activeFile — it does not re-run on
        // every subsequent file switch. So if the app passed through the
        // empty state even once in a session (deleting the last open
        // file, closing every tab, or simply the very first boot before
        // anything loaded) and 'readonly' got set then, it would still be
        // sitting on #rawTerminal indefinitely — inherited by CM6 on its
        // own engine-swap sync (which explicitly checks rawEd's readonly
        // attribute) — for every file opened afterward, no matter how
        // unrelated. The file would render completely (scrollable,
        // visible, gutter/status bar all correct) while accepting zero
        // input, matching exactly "opens but won't accept anything, can
        // still scroll/move it around." Calling setEditMode() explicitly
        // here — the same call boot already makes once — guarantees every
        // single file open resolves the real edit-mode state itself,
        // instead of trusting that it was already correct from whatever
        // happened earlier in the session.
        Nexus.UI.setEditMode(Nexus.state.prefs.editMode || 'util');

        const st = document.getElementById('footStatus');
        if (st && (!Nexus.editorCore || !Nexus.editorCore.isCM6)) {
            const ed = document.getElementById('rawTerminal');
            st.innerText = ed.getAttribute('inputmode') === 'none' ? "UTIL MODE" : "READY (FULL)";
            st.style.color = "var(--success)";
        }
    },

    async renameFile(oldName) {
        // The old guard bailed silently on a name collision — you'd type a
        // new name, tap OK, and nothing whatsoever would happen, with no
        // clue why. Now the conflict is reported inline while the name is
        // still editable.
        const newName = await Nexus.UI.askInput({
            title: 'RENAME FILE',
            label: 'New name — change the folder part to move it',
            value: oldName,
            hint: 'e.g. src/app.js moves it into the src folder',
            validate: (v) => {
                const t = (v || '').trim();
                if (!t) return 'Enter a filename.';
                if (t === oldName) return 'That is the current name — change it or cancel.';
                if (Nexus.state.Vfs[t] !== undefined) return `"${t}" already exists — pick another name.`;
                if (t.endsWith('/')) return 'That is a folder path, not a filename.';
                if (!t.split('/').pop()) return 'Missing a filename after the folder.';
                return null;
            }
        });
        if (!newName) return;
        const trimmedNew = newName.trim();
        
        Nexus.state.Vfs[trimmedNew] = Nexus.state.Vfs[oldName];
        Nexus.state.originals[trimmedNew] = Nexus.state.originals[oldName];
        // Carry the dirty-tracking baseline over under the new key too —
        // a rename doesn't change the file's actual content or its saved
        // state, so it shouldn't make an otherwise-clean file suddenly
        // look dirty just because lastSavedContent[newName] doesn't exist
        // yet (it would read as undefined !== <content>, i.e. dirty).
        Nexus.state.lastSavedContent[trimmedNew] = Nexus.state.lastSavedContent[oldName];
        delete Nexus.state.Vfs[oldName];
        delete Nexus.state.originals[oldName];
        delete Nexus.state.lastSavedContent[oldName];

        // If the old name had an open tab, keep that tab open under the
        // new name in the same position, rather than silently dropping it
        // from the tab bar (the file would still be in Vfs, just with no
        // tab pointing at it anymore).
        const tabIdx = Nexus.state.openTabs.indexOf(oldName);
        if (tabIdx !== -1) {
            Nexus.state.openTabs[tabIdx] = trimmedNew;
            this.saveOpenTabs();
        }
        
        if (Nexus.state.activeFile === oldName) Nexus.state.activeFile = trimmedNew;
        
        this.save();
        this.renderAccordion();
        if (Nexus.state.activeFile === trimmedNew) this.switchFile(trimmedNew);
    },

    deleteFile(fn) {
        if (confirm(`☢ Delete ${fn}?`)) { 
            delete Nexus.state.Vfs[fn]; 
            delete Nexus.state.originals[fn]; 
            delete Nexus.state.lastSavedContent[fn];

            // A deleted file can't remain an open tab pointing at nothing.
            const tabIdx = Nexus.state.openTabs.indexOf(fn);
            if (tabIdx !== -1) {
                Nexus.state.openTabs.splice(tabIdx, 1);
                this.saveOpenTabs();
            }

            // Only forcibly switch files if the one just deleted was the
            // one actually open — deleting an unrelated file from the
            // explorer while working on something else shouldn't yank the
            // user over to a different file they weren't touching.
            if (Nexus.state.activeFile === fn) {
                const remaining = Object.keys(Nexus.state.Vfs);
                remaining.length > 0 ? this.switchFile(remaining[0]) : this.setEmptyState();
            } else {
                this.renderAccordion();
            }
            this.save(); 
        }
    },

    // Stashes which tab closeTab() is waiting on a decision for — set by
    // closeTab() right before it opens the confirmation modal, read by
    // _confirmCloseTab() when the person taps one of the three buttons.
    _pendingCloseTab: null,

    // Closing a tab's × — the tab-bar equivalent of Cmd/Ctrl+W, NOT
    // deleteFile(). This never touches Vfs/originals for a clean file: the
    // file stays loaded in the workspace and simply drops off the tab bar,
    // exactly like the explorer/tab-list split this whole feature is
    // built around. Only when there's genuine unsaved work (per
    // isDirty() — see its own comment for what "unsaved" means in this
    // autosave-everything app) does this branch into the 3-way popup;
    // closing a clean tab is silent and instant, same as it always should
    // have been.
    closeTab(fn) {
        if (!Nexus.state.openTabs.includes(fn)) return; // not actually open — nothing to close

        if (!this.isDirty(fn)) {
            this._removeTab(fn);
            return;
        }

        this._pendingCloseTab = fn;
        const msg = document.getElementById('closeTabMessage');
        if (msg) msg.innerText = `"${fn}" has changes since your last Save. What would you like to do?`;
        Nexus.UI.openModal('close-tab');
    },

    // The three-way decision itself, invoked by modalCloseTab's buttons.
    async _confirmCloseTab(choice) {
        const fn = this._pendingCloseTab;
        Nexus.UI.closeModal('close-tab');
        this._pendingCloseTab = null;
        if (!fn) return;

        if (choice === 'cancel') return; // literally nothing changes — tab stays open, file stays as-is

        if (choice === 'save') {
            // If fn is the currently active file, its live editor content
            // needs pulling in before saving — Vfs[fn] only reflects the
            // editor automatically while fn IS the active file (autosave
            // writes there), so this matches manualSave()'s own approach
            // rather than assuming Vfs[fn] is already current.
            if (Nexus.state.activeFile === fn) {
                Nexus.state.Vfs[fn] = Nexus.Sentinel.getLiveCode();
            }
            const ok = await this.save();
            if (ok) {
                Nexus.state.lastSavedContent[fn] = Nexus.state.Vfs[fn];
            } else {
                // Save failed (already surfaced its own toast) — do NOT
                // close the tab out from under unsaved work the user
                // explicitly asked to keep. Leaving the tab open with its
                // dirty dot still showing is the honest outcome here.
                return;
            }
        } else if (choice === 'discard') {
            // "Discard" has to actually discard, not just close the tab
            // while quietly leaving the unsaved edits sitting in Vfs[fn] —
            // that would contradict the button's own label, since the
            // very next autosave tick (or a manual save from ANY tab,
            // since Vfs.save() persists the whole Vfs object at once)
            // would still write those "discarded" edits to disk. Revert
            // to lastSavedContent[fn] — this app's real "last known good"
            // baseline for this file — so closing genuinely undoes the
            // changes rather than just hiding the tab that showed them.
            if (Nexus.state.lastSavedContent[fn] !== undefined) {
                Nexus.state.Vfs[fn] = Nexus.state.lastSavedContent[fn];
            }
            this.save();
        }

        this._removeTab(fn);
    },

    // Shared tail end for both the clean-tab-instant-close path and the
    // post-decision path from _confirmCloseTab(). Removes fn from
    // openTabs only — Vfs/originals are never touched here, which is the
    // whole point: a closed tab's file stays exactly where it was, sitting
    // in the explorer, available to reopen with one click.
    _removeTab(fn) {
        const idx = Nexus.state.openTabs.indexOf(fn);
        if (idx !== -1) Nexus.state.openTabs.splice(idx, 1);
        this.saveOpenTabs();

        if (Nexus.state.activeFile === fn) {
            // Prefer another still-open tab (whatever's now last in the
            // list) over jumping to an arbitrary Vfs entry — closing a tab
            // should land you on another tab you already had open, not on
            // some unrelated file you never asked to see.
            const nextTab = Nexus.state.openTabs[Nexus.state.openTabs.length - 1];
            if (nextTab) {
                this.switchFile(nextTab);
            } else {
                this.setEmptyState();
            }
        } else {
            Nexus.UI.renderTabs();
        }
    },


    refreshCurrent() {
        const fn = Nexus.state.activeFile;
        if(!fn) return;
        if (confirm(`🔄 Restore ${fn} to original state?`)) { 
            Nexus.state.Vfs[fn] = Nexus.state.originals[fn]; 
            // This is itself a deliberate, explicitly-confirmed action
            // (the confirm() above), same as manualSave() — so it also
            // moves the dirty-tracking baseline. Without this, reverting
            // an edited file back to its original content would leave it
            // reading as "dirty" against the stale pre-revert save
            // baseline, which is backwards: the user just intentionally
            // restored a known-good state, not left it half-finished.
            Nexus.state.lastSavedContent[fn] = Nexus.state.originals[fn];
            this.switchFile(fn); 
            this.save(); 
        }
    },

// Builds a nested folder tree from the flat "folder/subfolder/file.ext"
// keys this app already uses for storage — GitHub's own contents API
// (see pull-all's real recursive walk) already returns paths in exactly
// this shape, so no translation is needed between what gets pulled and
// what the tree displays. Folders sort before files; both alphabetical
// within their own kind. Verified against real edge cases before this was
// wired into any rendering: malformed paths (leading/trailing/double
// slashes), a bare file whose name collides with an unrelated folder, and
// deep single-chain nesting all degrade sensibly rather than crashing.
_buildFileTree(filenames) {
    const root = { type: 'folder', name: '', path: '', children: [] };
    const folderIndex = new Map();

    filenames.forEach(full => {
        const parts = full.split('/').filter(Boolean);
        let cursor = root;
        let pathSoFar = '';
        for (let i = 0; i < parts.length; i++) {
            const isLast = i === parts.length - 1;
            pathSoFar = pathSoFar ? pathSoFar + '/' + parts[i] : parts[i];
            if (isLast) {
                cursor.children.push({ type: 'file', name: parts[i], path: full });
            } else {
                let existing = folderIndex.get(pathSoFar);
                if (!existing) {
                    existing = { type: 'folder', name: parts[i], path: pathSoFar, children: [] };
                    folderIndex.set(pathSoFar, existing);
                    cursor.children.push(existing);
                }
                cursor = existing;
            }
        }
    });

    const sortNode = (node) => {
        node.children.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
            return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });
        node.children.forEach(c => { if (c.type === 'folder') sortNode(c); });
    };
    sortNode(root);
    return root;
},

// Which tree folders are currently expanded, keyed by folder path.
// Deliberately module-level state (not rebuilt from scratch on every
// render) so switching files, saving, or any other renderAccordion()
// call doesn't collapse folders the user had open — same reasoning the
// existing type-sort accordions already rely on implicitly via their own
// 'open' class persisting on the actual DOM nodes, except tree mode
// regenerates its DOM on every render (paths can appear/disappear as
// files are added/removed) so the open/closed state has to be tracked
// separately rather than read back off elements that may not exist yet.
_treeExpanded: new Set(),

_renderTreeNode(node, depth) {
    let html = '';
    node.children.forEach(child => {
        const indent = 14 + depth * 18;
        if (child.type === 'folder') {
            const isOpen = Nexus.Vfs._treeExpanded.has(child.path);
            html += `<div class="tree-folder-row" style="display:flex; align-items:center; gap:6px; padding:10px ${indent}px 10px 12px; cursor:pointer; border-bottom:1px solid var(--border);" onclick="Nexus.Vfs.toggleTreeFolder('${child.path.replace(/'/g, "\\'")}')">
                <span style="font-size:10px; opacity:0.6; transform:rotate(${isOpen ? '90' : '0'}deg); transition:transform 0.15s; display:inline-block;">▶</span>
                <span>📁</span>
                <span style="font-weight:bold;">${child.name}</span>
                <span style="margin-left:auto; font-size:9px; opacity:0.5;">${child.children.length}</span>
            </div>`;
            if (isOpen) {
                html += `<div>${this._renderTreeNode(child, depth + 1)}</div>`;
            }
        } else {
            const activeClass = (child.path === Nexus.state.activeFile) ? 'active-file' : '';
            // Flag images whose stored content isn't a data URL — they
            // were corrupted by the old text-based loader and can't be
            // displayed, which is worth seeing in the list rather than
            // discovering one file at a time.
            const isImg = Nexus.Vfs.isImageFile(child.path);
            const broken = isImg && !Nexus.Vfs.isDataUrl(Nexus.state.Vfs[child.path] || '');
            const icon = broken ? '⚠️' : (isImg ? '🖼️' : '📄');
            html += `<div class="item-row ${activeClass}" style="padding-left:${indent + 18}px;" onclick="Nexus.Vfs.switchFile('${child.path.replace(/'/g, "\\'")}')">
                <span>${icon} ${child.name}</span>
                <div style="display:flex; align-items:center; gap:12px;">
                    <span style="color:var(--gold); font-size:14px;" onclick="event.stopPropagation(); Nexus.Vfs.renameFile('${child.path.replace(/'/g, "\\'")}')">✏️</span>
                    <span style="color:var(--danger); font-size:18px; line-height:0.8;" onclick="event.stopPropagation(); Nexus.Vfs.deleteFile('${child.path.replace(/'/g, "\\'")}')">&times;</span>
                </div>
            </div>`;
        }
    });
    return html;
},

toggleTreeFolder(path) {
    if (this._treeExpanded.has(path)) this._treeExpanded.delete(path);
    else this._treeExpanded.add(path);
    this.renderAccordion();
},

setExplorerSort(mode) {
    Nexus.settings.update('explorerSort', mode);
    // renderAccordion() itself keeps the button active-states in sync on
    // every call, so no separate DOM update is needed here.
    this.renderAccordion();
},

// --- 3. RENDERING ACCORDION ---
renderAccordion() {
    // 1. Target the correct accordion container element safely
    const root = document.getElementById('accordionRoot');
    if (!root) return; // Exit gracefully if the DOM frame isn't painted yet

    const filenames = (Nexus.state && Nexus.state.Vfs) ? Object.keys(Nexus.state.Vfs) : [];
    const mode = Nexus.state.prefs.explorerSort === 'tree' ? 'tree' : 'type';

    let htmlOut = '';

    if (mode === 'tree') {
        // Real nested folder tree — see _buildFileTree/_renderTreeNode
        // above. Root-level files (no '/' in their path) render as plain
        // rows with no folder wrapper, matching how a real file explorer
        // shows loose files sitting alongside top-level folders.
        const tree = this._buildFileTree(filenames);
        htmlOut = this._renderTreeNode(tree, 0);
    } else {
        // Original sort-by-extension behaviour, unchanged — this is now
        // one of two explicit modes rather than the only option, per
        // request: "sort by file type like it is now should be an
        // option," not replaced.
        const groups = {};
        filenames.forEach(fn => {
            const parts = fn.split('.');
            const ext = parts.length > 1 ? parts.pop().toLowerCase() : 'raw';
            if (!groups[ext]) groups[ext] = [];
            groups[ext].push(fn);
        });

        Object.entries(groups).forEach(([ext, files]) => {
            htmlOut += '<div class="acc-section">';
            htmlOut += '    <div class="acc-head" onclick="this.nextElementSibling.classList.toggle(\'open\')">';
            htmlOut += '        <span>.' + ext.toUpperCase() + '</span> <span>' + files.length + '</span>';
            htmlOut += '    </div>';
            htmlOut += '    <div class="acc-content open">';

            files.forEach(fn => {
                const activeClass = (fn === Nexus.state.activeFile) ? 'active-file' : '';
                // A file living in a subfolder still displays as the flat
                // "folder/file.ext" string here on purpose — this is the
                // sort-BY-TYPE view, not the tree, so it deliberately
                // doesn't build any folder structure; tree mode is the
                // real explorer-style option for that.
                htmlOut += '        <div class="item-row ' + activeClass + '" onclick="Nexus.Vfs.switchFile(\'' + fn + '\')">';
                htmlOut += '            <span>' + fn + '</span>';
                htmlOut += '            <div style="display:flex; align-items:center; gap:12px;">';
                htmlOut += '                <span style="color:var(--gold); font-size:14px;" onclick="event.stopPropagation(); Nexus.Vfs.renameFile(\'' + fn + '\')">✏️</span>';
                htmlOut += '                <span style="color:var(--danger); font-size:18px; line-height:0.8;" onclick="event.stopPropagation(); Nexus.Vfs.deleteFile(\'' + fn + '\')">&times;</span>';
                htmlOut += '            </div>';
                htmlOut += '        </div>';
            });

            htmlOut += '    </div>';
            htmlOut += '</div>';
        });
    }

    // Fallback display if the Vfs is perfectly fresh and empty
    if (htmlOut === "") {
        htmlOut = '<div style="padding:16px; text-align:center; color:var(--danger); font-size:13px; letter-spacing:1px;">WORKSPACE VACANT</div>';
    }

    root.innerHTML = htmlOut;

    // Keep the two sort-mode buttons' active styling in sync with the
    // real saved preference on every render, not just when
    // setExplorerSort() itself is the trigger — this function also runs
    // on plain boot restoration, file add/remove, etc., where the button
    // DOM could otherwise silently drift from Nexus.state.prefs.explorerSort.
    const typeBtn = document.getElementById('explorerSortType');
    const treeBtn = document.getElementById('explorerSortTree');
    if (typeBtn) typeBtn.classList.toggle('btn-accent', mode === 'type');
    if (treeBtn) treeBtn.classList.toggle('btn-accent', mode === 'tree');

    // 4. Guard check the tabs render engine pass
    if (Nexus.UI && typeof Nexus.UI.renderTabs === 'function') {
        Nexus.UI.renderTabs();
    }
},


// --- 4. DATA TRANSFER & MERGE ---
loadFiles(fileList) {
    Array.from(fileList).forEach(file => {
        const r = new FileReader();
        r.onload = (e) => { 
            Nexus.state.Vfs[file.name] = e.target.result; 
            Nexus.state.originals[file.name] = e.target.result; 
            // Freshly loaded, unedited content — seed the dirty baseline
            // to match so it doesn't read as having unsaved changes the
            // instant it lands in the explorer, before anyone's touched it.
            Nexus.state.lastSavedContent[file.name] = e.target.result;
            this.renderAccordion(); 
            if (!Nexus.state.activeFile) this.switchFile(file.name);
            this.save(); 
        };
        // Images MUST go through readAsDataURL — readAsText would run the
        // binary through a UTF-8 decode and permanently corrupt it (see
        // the IMAGE_EXTS comment at the top of this object; measured, not
        // assumed). Everything else stays on readAsText exactly as before.
        if (this.isImageFile(file.name)) {
            r.readAsDataURL(file);
        } else {
            r.readAsText(file);
        }
    });
},

async importZIP(file) {
    if (!file) return;
    try {
        const zip = await JSZip.loadAsync(file);
        let imported = 0;
        for (const relativePath of Object.keys(zip.files)) {
            const entry = zip.files[relativePath];
            if (!entry.dir) {
                // Keep the ZIP's own folder structure instead of flattening
                // to a bare filename. This used to do relativePath.split('/')
                // .pop(), which threw away directories entirely — so two
                // files with the same name in different folders silently
                // overwrote each other, and nothing could ever land in the
                // tree view's folders. Vfs keys already use exactly this
                // "folder/file.ext" form.
                const fn = relativePath.replace(/^\/+/, '');
                const base = fn.split('/').pop();
                if (fn && base && !base.startsWith(".")) {
                    // Images have to come out as base64, not "string" —
                    // JSZip's string mode does the same lossy UTF-8 decode
                    // FileReader.readAsText does, which permanently
                    // corrupts binary content.
                    let content;
                    if (this.isImageFile(fn)) {
                        const b64 = await entry.async("base64");
                        content = `data:${this.imageMimeFor(fn)};base64,${b64}`;
                    } else {
                        content = await entry.async("string");
                    }
                    Nexus.state.Vfs[fn] = content;
                    Nexus.state.originals[fn] = content;
                    // Same reasoning as loadFiles(): freshly imported,
                    // unedited content shouldn't read as dirty on arrival.
                    Nexus.state.lastSavedContent[fn] = content;
                    imported++;
                }
            }
        }
        if (imported > 0) {
            this.save();
            this.renderAccordion();
            alert("📦 ZIP Extracted: " + imported + " files imported.");
        }
    } catch (e) { alert("ZIP Error: " + e.message); }
},

// --- 5. EXPORT & FLAT BUNDLE GENERATION ---
exportToTXT() {
    let b = "/* NEXUS FLAT BUNDLE | GENERATED: " + new Date().toLocaleString() + " */\n";
    
    Object.entries(Nexus.state.Vfs).forEach(([fn, content]) => {
        b += "\n/* FILE: " + fn + " */\n" + content + "\n";
    });
    
    const blob = new Blob([b], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "Nexus_Vfs_Backup.txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
},

combineFiles() {
    const selected = Array.from(document.querySelectorAll('.combine-cb:checked')).map(cb => cb.value);
    const newName = document.getElementById('combineName').value;
    if(selected.length < 2 || !newName) return alert("Select 2+ files and provide a name.");
    
    let combinedCode = "// Combined Matrix: " + selected.join(', ') + "\n\n";
    selected.forEach(f => { combinedCode += "// --- " + f + " ---\n" + (Nexus.state.Vfs[f] || '') + "\n\n"; });

    Nexus.state.Vfs[newName] = combinedCode;
    Nexus.state.originals[newName] = combinedCode;
    // Genuinely new file, never edited by hand yet — seed its dirty
    // baseline the same way newFile()/loadFiles() do, so it doesn't read
    // as unsaved the instant Combine finishes.
    Nexus.state.lastSavedContent[newName] = combinedCode;
    
    const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedNames = selected.map(f => escapeRegex(f.replace('./', ''))).join('|');
    const regexes = [
        new RegExp("((?:import|export)\\s+(?:.*?from\\s+)?['\"])(\\.\\/)?(?:" + escapedNames + ")(['\"])", 'g'),
        new RegExp("(src=['\"])(\\.\\/)?(?:" + escapedNames + ")(['\"])", 'g'),
        new RegExp("(href=['\"])(\\.\\/)?(?:" + escapedNames + ")(['\"])", 'g')
    ];

    Object.keys(Nexus.state.Vfs).forEach(file => {
        if (selected.includes(file)) return; 
        let code = Nexus.state.Vfs[file];
        let changed = false;
        regexes.forEach(rx => { if (rx.test(code)) { changed = true; code = code.replace(rx, "$1$2" + newName + "$3"); } });
        if(changed) { Nexus.state.Vfs[file] = code; Nexus.state.originals[file] = code; }
    });
    
    selected.forEach(f => { if(f !== newName) { delete Nexus.state.Vfs[f]; delete Nexus.state.originals[f]; delete Nexus.state.lastSavedContent[f]; const ti = Nexus.state.openTabs.indexOf(f); if (ti !== -1) Nexus.state.openTabs.splice(ti, 1); } });
    this.saveOpenTabs();
    this.save();
    this.renderAccordion();
    this.switchFile(newName);
    Nexus.UI.closeModal('combine');
    Nexus.shell.out("Merged into one file.", "success");
},

clearAll() {
    if (!confirm("⚠️ This will permanently delete ALL files in the Vortex. Continue?")) return;
    Nexus.state.Vfs = {};
    Nexus.state.originals = {};
    Nexus.state.lastSavedContent = {};
    Nexus.state.openTabs = [];
    this.saveOpenTabs();
    Nexus.state.activeFile = null;
    const ed = document.getElementById('rawTerminal');
    if (ed) ed.value = '';
    this.save();
    this.renderAccordion();
    Nexus.shell.out("Project cleared.", "success");
},

mergeAllJS() {
    const jsFiles = Object.keys(Nexus.state.Vfs).filter(f => f.toLowerCase().endsWith('.js'));
    if (jsFiles.length < 2) return alert("Need 2+ .js files to merge.");
    const newName = prompt("Merged JS filename:", "bundle.js");
    if (!newName) return;

    let combined = "// Merged JS Bundle: " + jsFiles.join(', ') + "\n\n";
    jsFiles.forEach(f => { combined += "// --- " + f + " ---\n" + (Nexus.state.Vfs[f] || '') + "\n\n"; });

    Nexus.state.Vfs[newName] = combined;
    Nexus.state.originals[newName] = combined;
    // Same reasoning as combineFiles() just above — a freshly-merged
    // bundle hasn't diverged from its own just-created content yet.
    Nexus.state.lastSavedContent[newName] = combined;
    jsFiles.forEach(f => { if (f !== newName) { delete Nexus.state.Vfs[f]; delete Nexus.state.originals[f]; delete Nexus.state.lastSavedContent[f]; const ti = Nexus.state.openTabs.indexOf(f); if (ti !== -1) Nexus.state.openTabs.splice(ti, 1); } });
    this.saveOpenTabs();

    this.save();
    this.renderAccordion();
    this.switchFile(newName);
    alert(`Merged ${jsFiles.length} JS files into ${newName}.`);
},

splitJSFile() {
    const file = Nexus.state.activeFile;
    if (!file || !file.toLowerCase().endsWith('.js')) return alert("Active file must be a .js file.");
    const code = Nexus.state.Vfs[file] || "";

    let ast;
    try {
        ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'module' });
    } catch (e) {
        return alert(`Cannot split — file has a syntax error: ${e.message}`);
    }

    // Walk only TOP-LEVEL statements (never nested ones) and recognize every
    // common way a function or class ends up bound to a name — classic
    // "function foo(){}", "class Foo{}", arrow/function-expression consts
    // ("const foo = () => {}", "const foo = function(){}"), async variants,
    // and each of those wrapped in "export"/"export default". Using the real
    // AST instead of a regex also means this can't be fooled by text that
    // merely looks like a declaration inside a string or comment.
    const nameOf = (node) => {
        if (!node) return null;
        if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id) return node.id.name;
        if (node.type === 'VariableDeclaration' && node.declarations.length === 1) {
            const d = node.declarations[0];
            if (d.init && (d.init.type === 'ArrowFunctionExpression' || d.init.type === 'FunctionExpression') && d.id.type === 'Identifier') {
                return d.id.name;
            }
        }
        return null;
    };

    const found = []; // { name, start, end }
    ast.body.forEach(node => {
        let target = node;
        if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') {
            target = node.declaration;
        }
        const name = nameOf(target);
        if (name) found.push({ name, start: node.start, end: node.end });
    });

    if (found.length < 2) return alert("Need 2+ top-level function/class declarations to split.");

    const base = file.replace(/\.js$/i, '');
    let created = 0;
    for (let i = 0; i < found.length; i++) {
        const start = found[i].start;
        const end = i + 1 < found.length ? found[i + 1].start : code.length;
        const chunk = code.substring(start, end).trim();
        const newName = `${base}.${found[i].name}.js`;
        Nexus.state.Vfs[newName] = chunk;
        Nexus.state.originals[newName] = chunk;
        Nexus.state.lastSavedContent[newName] = chunk;
        created++;
    }
    delete Nexus.state.Vfs[file];
    delete Nexus.state.originals[file];
    delete Nexus.state.lastSavedContent[file];
    {
        const ti = Nexus.state.openTabs.indexOf(file);
        if (ti !== -1) { Nexus.state.openTabs.splice(ti, 1); this.saveOpenTabs(); }
    }

    this.save();
    this.renderAccordion();
    alert(`Split '${file}' into ${created} files. (Any code before the first function/class declaration, like imports, was not preserved — copy it manually if needed.)`);
},

bundleToHTML() {
    const Vfs = Nexus.state.Vfs;
    const htmlFile = Object.keys(Vfs).find(f => f.toLowerCase().endsWith('.html')) || Nexus.state.activeFile;
    if (!htmlFile || !Vfs[htmlFile]) return alert("No HTML file found to use as the base.");

    let base = Vfs[htmlFile];
    const cssFiles = Object.keys(Vfs).filter(f => f.toLowerCase().endsWith('.css'));
    const jsFiles = Object.keys(Vfs).filter(f => f.toLowerCase().endsWith('.js'));

    const cssBlock = cssFiles.map(f => `<style>\n/* ${f} */\n${Vfs[f]}\n</style>`).join('\n');
    const jsBlock = jsFiles.map(f => '<scr' + 'ipt>\n/* ' + f + ' */\n' + Vfs[f] + '\n</scr' + 'ipt>').join('\n');

    base = base.includes('</head>') ? base.replace('</head>', cssBlock + '\n</head>') : cssBlock + base;
    base = base.includes('</body>') ? base.replace('</body>', jsBlock + '\n</body>') : base + jsBlock;

    const blob = new Blob([base], { type: "text/html;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "bundle.html";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    alert(`Bundled ${1 + cssFiles.length + jsFiles.length} files into bundle.html.`);
}
},

history: {
record() {
    if(!Nexus.state.activeFile || Nexus.state.history.isLocked) return;
    
    const ed = document.getElementById('rawTerminal');
    const historyState = Nexus.state.history;
    
    let codeToSave = ed.value;
    if (Nexus.editorCore.isCM6 && Nexus.editorCore.view) {
        codeToSave = Nexus.editorCore.view.state.doc.toString();
    }
    
    const lastEntry = historyState.past[historyState.past.length - 1];
    if (codeToSave === lastEntry) return;

    historyState.past.push(codeToSave);
    if(historyState.past.length > 50) historyState.past.shift();
    historyState.future = []; 

    db.files.where('name').equals(Nexus.state.activeFile).first().then(fileRec => {
        if (fileRec) {
            db.history.add({
                timestamp: Date.now(),
                fileId: fileRec.id,
                content: codeToSave
            });
        }
    }).catch(e => console.warn("Chronos Archive Sync Failed:", e));
},

undo() {
    if (Nexus.editorCore.isCM6 && Nexus.editorCore.view) {
        const view = Nexus.editorCore.view;
        // Reuses DpadEngine's cached @codemirror/commands module rather than
        // the previous approach: an annotation referencing window.Transaction,
        // which is never defined anywhere in this file and so always
        // resolved to undefined — a silent no-op — with a synthetic
        // Ctrl+Z keydown as an unverified fallback. undo()/redo() are the
        // real, documented CM6 commands for this.
        const runUndo = (m) => { if (m.undo) { m.undo(view); view.focus(); } };
        if (Nexus.DpadEngine._cmCommands) {
            runUndo(Nexus.DpadEngine._cmCommands);
        } else {
            import("@codemirror/commands").then((m) => {
                Nexus.DpadEngine._cmCommands = m;
                runUndo(m);
            }).catch((err) => {
                console.error("Undo: failed to load @codemirror/commands", err);
                if (Nexus.shell && typeof Nexus.shell.out === 'function') {
                    Nexus.shell.out("Undo needs an internet connection the first time it's used.", "warn");
                }
            });
        }
        return;
    }

    const historyState = Nexus.state.history;
    if(historyState.past.length === 0) return;
    const ed = document.getElementById('rawTerminal');
    
    historyState.isLocked = true;
    historyState.future.push(ed.value);
    const prev = historyState.past.pop();
    ed.value = prev;

    Nexus.state.Vfs[Nexus.state.activeFile] = prev;
    Nexus.UI.updateGutter();
    historyState.isLocked = false;
},

redo() {
    if (Nexus.editorCore.isCM6 && Nexus.editorCore.view) {
        const view = Nexus.editorCore.view;
        const runRedo = (m) => { if (m.redo) { m.redo(view); view.focus(); } };
        if (Nexus.DpadEngine._cmCommands) {
            runRedo(Nexus.DpadEngine._cmCommands);
        } else {
            import("@codemirror/commands").then((m) => {
                Nexus.DpadEngine._cmCommands = m;
                runRedo(m);
            }).catch((err) => {
                console.error("Redo: failed to load @codemirror/commands", err);
                if (Nexus.shell && typeof Nexus.shell.out === 'function') {
                    Nexus.shell.out("Redo needs an internet connection the first time it's used.", "warn");
                }
            });
        }
        return;
    }

    const historyState = Nexus.state.history;
    if(historyState.future.length === 0) return;
    const ed = document.getElementById('rawTerminal');
    
    historyState.isLocked = true;
    historyState.past.push(ed.value);
    const next = historyState.future.pop();
    ed.value = next;

    Nexus.state.Vfs[Nexus.state.activeFile] = next;
    Nexus.UI.updateGutter();
    historyState.isLocked = false;
}
},

BracketCartographer: {
// Errors are { line (0-indexed), col, char } — kept identical to the old
// shape, since checkBrackets/runBracketsCard/runFullSweep all consume it.
mapStructure(code) {
    const ext = Nexus.state.activeFile ? Nexus.state.activeFile.split('.').pop().toLowerCase() : 'js';
    if (ext === 'js') return this._mapJs(code);
    if (ext === 'html') return this._mapHtml(code);
    return this._mapCss(code); // .css and anything unrecognized
},

// JS: let the real parser be the judge. It either parses cleanly
// (brackets and everything else are structurally sound) or throws with an
// exact line/column — far more reliable than a hand-rolled character
// scanner, which had no way to tell a "<" comparison from an opening tag,
// or a "//" inside a URL string from a real comment.
_mapJs(code) {
    try {
        acorn.parse(code, { ecmaVersion: 2022, sourceType: 'module' });
        return { errors: [], matches: [] };
    } catch (e) {
        const line = typeof e.loc?.line === 'number' ? e.loc.line - 1 : 0;
        const col = e.loc?.column || 0;
        return { errors: [{ line, col, char: '(syntax error — ' + e.message.replace(/\s*\(\d+:\d+\)$/, '') + ')' }], matches: [] };
    }
},

// HTML: brackets only really matter inside embedded <script> (checked with
// the same real parser) and <style> (checked with the masked scan below).
// The surrounding markup's own tag structure is already covered separately
// by the HTML nesting/balance checks in the auditor.
_mapHtml(code) {
    const errors = [];
    const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = scriptRe.exec(code))) {
        const inner = m[1];
        if (!inner.trim()) continue;
        const blockStart = m.index + m[0].indexOf(inner);
        const startLine = code.slice(0, blockStart).split('\n').length - 1;
        try {
            acorn.parse(inner, { ecmaVersion: 2022, sourceType: 'module' });
        } catch (e) {
            const relLine = (e.loc?.line || 1) - 1;
            errors.push({ line: startLine + relLine, col: e.loc?.column || 0, char: '(script syntax error)' });
        }
    }
    const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
    while ((m = styleRe.exec(code))) {
        const inner = m[1];
        const blockStart = m.index + m[0].indexOf(inner);
        const startLine = code.slice(0, blockStart).split('\n').length - 1;
        const sub = this._mapCss(inner);
        sub.errors.forEach(e => errors.push({ line: startLine + e.line, col: e.col, char: e.char }));
    }
    return { errors, matches: [] };
},

// Blanks out string and comment content first (same length, newlines kept,
// so line/col numbers stay accurate) so brackets inside a string or
// comment can't confuse the scan that follows.
_maskStringsAndComments(code) {
    // Handles block comments (/* */) and both quote-string types — but
    // until this fix, had NO handling at all for // line comments or
    // template literals (`...`). That's a real, confirmed bug: a line
    // comment or template literal containing an apostrophe or double-quote
    // character (e.g. "// depths that don't match...") gets misread as
    // that character OPENING A REAL STRING, and since there's no matching
    // close-quote nearby, everything from that point to the end of the
    // file gets silently masked away — which corrupts every subsequent
    // depth calculation, not just on the line with the apostrophe.
    // Verified directly: this exact case (an apostrophe inside "don't" in
    // a // comment) was reproduced and confirmed as the root cause of
    // widespread incorrect re-indentation across an entire file, not a
    // narrow edge case.
    let out = '';
    let i = 0;
    while (i < code.length) {
        const ch = code[i], next = code[i + 1];
        if (ch === '/' && next === '/') {
            out += '  '; i += 2;
            while (i < code.length && code[i] !== '\n') { out += ' '; i++; }
            continue;
        }
        if (ch === '/' && next === '*') {
            out += '  '; i += 2;
            while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) {
                out += code[i] === '\n' ? '\n' : ' '; i++;
            }
            if (i < code.length) { out += '  '; i += 2; }
            continue;
        }
        if (ch === '"' || ch === "'") {
            const quote = ch; out += ' '; i++;
            while (i < code.length && code[i] !== quote) {
                if (code[i] === '\\' && i + 1 < code.length) { out += '  '; i += 2; continue; }
                out += code[i] === '\n' ? '\n' : ' '; i++;
            }
            if (i < code.length) { out += ' '; i++; }
            continue;
        }
        if (ch === '`') {
            // Template literals need real depth tracking for ${...}
            // interpolations, not just blanket masking to end-of-string —
            // an interpolation can contain a genuine object literal (e.g.
            // `${ {a:1} }`) whose braces DO need to count toward real
            // code depth. Everything else inside the template (the
            // literal text portions) is masked, same as a normal string.
            out += ' '; i++;
            let interpDepth = 0;
            while (i < code.length) {
                if (code[i] === '\\' && i + 1 < code.length) { out += '  '; i += 2; continue; }
                if (interpDepth === 0 && code[i] === '`') { out += ' '; i++; break; }
                if (interpDepth === 0 && code[i] === '$' && code[i + 1] === '{') {
                    // Mask only the $ — the { is REAL syntax that opens a
                    // scope and must be preserved for depth-counting,
                    // paired with the interpolation's closing } (already
                    // preserved below). Masking both to spaces was the
                    // actual bug: the depth counter would then see an
                    // unmatched closing } later with no opening { to pair
                    // it against, corrupting the running depth count for
                    // everything after it in the whole file.
                    out += ' '; i++;
                    out += code[i]; i++;
                    interpDepth = 1; continue;
                }
                if (interpDepth > 0) {
                    if (code[i] === '{') interpDepth++;
                    else if (code[i] === '}') { interpDepth--; if (interpDepth === 0) { out += code[i]; i++; continue; } }
                    out += code[i]; i++; continue;
                }
                out += code[i] === '\n' ? '\n' : ' '; i++;
            }
            continue;
        }
        if (ch === '/' && next !== '/' && next !== '*') {
            // Division-vs-regex is ambiguous without a full parser, but
            // the standard heuristic works well in practice: a `/` is a
            // regex start unless the last significant character indicates
            // the previous token was something that stands alone as a
            // complete expression (identifier char, digit, or a closing
            // bracket) — otherwise it's division. This exists because a
            // regex literal's PATTERN can itself contain a quote character
            // (confirmed real: app.js's escapeHtml() uses /'/g and /"/g),
            // which without this check gets misread as opening a real
            // string and desyncs everything after it, same failure shape
            // as the // and ` gaps this fix also closes.
            let lastSig = '';
            for (let k = out.length - 1; k >= 0; k--) {
                if (out[k] === ' ' || out[k] === '\t' || out[k] === '\n') continue;
                lastSig = out[k];
                break;
            }
            const isDivision = /[A-Za-z0-9_$)\]]/.test(lastSig);
            if (!isDivision) {
                out += ' '; i++;
                while (i < code.length) {
                    if (code[i] === '\\' && i + 1 < code.length) { out += '  '; i += 2; continue; }
                    if (code[i] === '/') { out += ' '; i++; break; }
                    if (code[i] === '\n') break; // regex can't span a real newline unescaped — bail out to avoid over-masking if something's malformed
                    out += ' '; i++;
                }
                while (i < code.length && /[a-z]/.test(code[i])) { out += ' '; i++; } // flags
                continue;
            }
        }
        out += ch; i++;
    }
    return out;
},

// CSS (and the fallback for anything unrecognized): mask strings/comments,
// then a plain {}/[]/() stack scan on what's left. No more treating "<"/">"
// as brackets — they aren't bracket characters in CSS or JS, that was only
// ever a rough (and unreliable) proxy for HTML angle brackets, which have
// their own dedicated, already-correct tag-nesting checker.
_mapCss(code) {
    const masked = this._maskStringsAndComments(code);
    const pairs = { '{': '}', '[': ']', '(': ')' };
    const antiPairs = { '}': '{', ']': '[', ')': '(' };
    const stack = [];
    const errors = [];
    const lines = masked.split('\n');
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const txt = lines[lineIdx];
        for (let col = 0; col < txt.length; col++) {
            const ch = txt[col];
            if (pairs[ch]) stack.push({ char: ch, line: lineIdx, col });
            else if (antiPairs[ch]) {
                if (stack.length && stack[stack.length - 1].char === antiPairs[ch]) stack.pop();
                else errors.push({ char: ch, line: lineIdx, col });
            }
        }
    }
    while (stack.length) errors.push(stack.pop());
    return { errors, matches: [] };
},
},

DpadEngine: {
selectLock: false,
lineLock: false,
ctrlLock: false,
toggleSelectLock() {
    this.selectLock = !this.selectLock;
    ['ribbonSelectBtn', 'dpadSelectLock', 'utilSelectLock', 'navDrawerSelectLockBtn'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('active', this.selectLock);
    });
},
toggleCtrlLock() {
    this.ctrlLock = !this.ctrlLock;
    const btn = document.getElementById('ribbonCtrlBtn');
    if (btn) btn.classList.toggle('active', this.ctrlLock);
},
setupFastHold() {
    document.querySelectorAll('.dpad-arrow').forEach(btn => {
        let holdTimer, repeatTimer;
        
        const startMove = (e) => {
            e.preventDefault();
            this.navigate(btn.dataset.dir);
            
            holdTimer = setTimeout(() => {
                repeatTimer = setInterval(() => {
                    this.navigate(btn.dataset.dir);
                }, 40);
            }, 400); 
        };
        
        const stopMove = () => {
            clearTimeout(holdTimer);
            clearInterval(repeatTimer);
        };
        
        // Pointer events alone cover mouse + touch + pen in one unified stream.
        // (Previously this also listened for touchstart/mousedown, and init()
        // below ALSO listened for pointerdown on the same buttons, so a single
        // tap fired navigate() 2-3 times. One event family, one listener.)
        btn.addEventListener('pointerdown', startMove);
        btn.addEventListener('pointerup', stopMove);
        btn.addEventListener('pointerleave', stopMove);
        btn.addEventListener('pointercancel', stopMove);
    });
},
init() {
    const dpad = document.getElementById('nexusDpad');
    const selToggle = document.getElementById('dpadSelectLock');
    const lineToggle = document.getElementById('dpadLineLock');
    const dragHandle = document.getElementById('dpadDragHandle');

    // FIX: none of these four lookups were ever null-checked before this,
    // despite every other init-style function in this file following a
    // strict "guard before touching" convention. Under normal
    // circumstances these elements exist by the time boot() reaches this
    // point (DOMContentLoaded guarantees the static HTML is already
    // parsed) — but "normal circumstances" isn't a substitute for an
    // actual guard, and a single null here (a future markup edit renaming
    // one of these ids, for instance) would throw a bare TypeError this
    // deep inside the synchronous boot() chain, silently aborting EVERY
    // later boot step queued after it — including setupFastHold()
    // (binds the footer d-pad's own press-and-hold), Nexus.omni.init(),
    // Nexus.Terminal.init(), and the engine/edit-mode restoration timers.
    // That failure mode looks exactly like "the whole app stopped
    // responding to taps" from the outside, even though the page itself
    // rendered fine — because everything really did stop responding, just
    // silently, with the actual error visible only in a console most
    // people never open.
    if (!dpad || !selToggle || !lineToggle || !dragHandle) {
        console.error("DpadEngine.init: one or more required elements missing from the DOM (nexusDpad/dpadSelectLock/dpadLineLock/dpadDragHandle) — skipping floating d-pad wiring, but continuing boot.");
        return;
    }

    selToggle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.toggleSelectLock();
    });

    lineToggle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.lineLock = !this.lineLock;
        lineToggle.classList.toggle('active', this.lineLock);
    });

    // Arrow press/hold/repeat is handled entirely by setupFastHold() (called
    // separately below); a second pointerdown listener here used to double
    // up on every tap.

    let isDragging = false, startX, startY, initLeft, initTop;
    dragHandle.addEventListener('pointerdown', (e) => {
        isDragging = true; startX = e.clientX; startY = e.clientY;
        const r = dpad.getBoundingClientRect();
        initLeft = r.left; initTop = r.top;
        dpad.style.right = 'auto'; dpad.style.bottom = 'auto';
        dragHandle.setPointerCapture(e.pointerId);
    });
    dragHandle.addEventListener('pointermove', (e) => {
        if (!isDragging) return;
        dpad.style.left = (initLeft + (e.clientX - startX)) + "px";
        dpad.style.top = (initTop + (e.clientY - startY)) + "px";
    });
    const stopDrag = (e) => { if (isDragging) { isDragging = false; dragHandle.releasePointerCapture(e.pointerId); } };
    dragHandle.addEventListener('pointerup', stopDrag);
    dragHandle.addEventListener('pointercancel', stopDrag);
},
navigate(dir) {
    if (Nexus.editorCore.isCM6 && Nexus.editorCore.view) {
        const view = Nexus.editorCore.view;
        let commandName = "";

        if (this.ctrlLock && (dir === 'Left' || dir === 'Right')) {
            commandName = this.selectLock
                ? { 'Left':'selectGroupLeft', 'Right':'selectGroupRight' }[dir]
                : { 'Left':'cursorGroupLeft', 'Right':'cursorGroupRight' }[dir];
        } else if (this.selectLock) {
            commandName = this.lineLock 
                ? { 'Up':'selectPageUp', 'Down':'selectPageDown', 'Left':'selectLineStart', 'Right':'selectLineEnd' }[dir]
                : { 'Up':'selectLineUp', 'Down':'selectLineDown', 'Left':'selectCharLeft', 'Right':'selectCharRight' }[dir];
        } else {
            commandName = this.lineLock
                ? { 'Up':'cursorPageUp', 'Down':'cursorPageDown', 'Left':'cursorLineStart', 'Right':'cursorLineEnd' }[dir]
                : { 'Up':'cursorLineUp', 'Down':'cursorLineDown', 'Left':'cursorCharLeft', 'Right':'cursorCharRight' }[dir];
        }
        
        // Cache the module after first successful load — setupFastHold can
        // call navigate() up to 25x/sec while held, so this avoids re-entering
        // a fresh import() promise chain on every tick. The .catch() is the
        // actual bug fix: previously a failed load (offline, esm.sh blocked)
        // had no error path at all, so the d-pad would just silently stop
        // working in CM6 mode with no explanation.
        const runCommand = (m) => { if (m[commandName]) { m[commandName](view); view.focus(); } };
        if (this._cmCommands) {
            runCommand(this._cmCommands);
        } else {
            import("@codemirror/commands").then((m) => {
                this._cmCommands = m;
                runCommand(m);
            }).catch((err) => {
                console.error("D-pad: failed to load @codemirror/commands", err);
                if (Nexus.shell && typeof Nexus.shell.out === 'function') {
                    Nexus.shell.out("D-pad navigation needs an internet connection the first time it's used.", "warn");
                }
            });
        }
    } else {
        // Fallback for vanilla text-area mode — this now mirrors the CM6
        // branch's selectLock/lineLock handling. Previously this always
        // collapsed to a single cursor position no matter what, silently
        // ignoring both lock states entirely (only the CM6 branch respected
        // them), which is why SEL/LINE felt like they did nothing here.
        const ed = document.getElementById('rawTerminal');
        if (ed) {
            const value = ed.value;
            const lines = value.split('\n');

            // The fixed end of the selection (where it started growing from)
            // vs. the "active" end that actually moves with each press.
            // Inferred from selectionDirection, which we explicitly set below
            // on every press, so this correctly round-trips across repeated
            // arrow taps while select-lock stays on.
            const backward = ed.selectionDirection === 'backward';
            const anchor = this.selectLock ? (backward ? ed.selectionEnd : ed.selectionStart) : null;
            const pos = this.selectLock ? (backward ? ed.selectionStart : ed.selectionEnd) : ed.selectionStart;

            let targetPos = pos;

            if (this.ctrlLock && (dir === 'Left' || dir === 'Right')) {
                const isWordChar = c => /\w/.test(c);
                let p = pos;
                if (dir === 'Left') {
                    while (p > 0 && !isWordChar(value[p - 1])) p--;
                    while (p > 0 && isWordChar(value[p - 1])) p--;
                } else {
                    while (p < value.length && !isWordChar(value[p])) p++;
                    while (p < value.length && isWordChar(value[p])) p++;
                }
                targetPos = p;
            } else if (dir === 'Left') {
                targetPos = this.lineLock ? (value.lastIndexOf('\n', pos - 1) + 1) : Math.max(0, pos - 1);
            } else if (dir === 'Right') {
                if (this.lineLock) {
                    const nl = value.indexOf('\n', pos);
                    targetPos = nl === -1 ? value.length : nl;
                } else {
                    targetPos = Math.min(value.length, pos + 1);
                }
            } else if (dir === 'Up' || dir === 'Down') {
                // Calculate current line and column
                const textBefore = value.substring(0, pos);
                const linesBeforeCursor = textBefore.split('\n');
                const currentLineIndex = linesBeforeCursor.length - 1;
                const currentCol = linesBeforeCursor[currentLineIndex].length;

                // lineLock jumps by a screen-height's worth of lines instead
                // of one line at a time, matching CM6's cursorPageUp/Down.
                const jumpSize = this.lineLock ? Math.max(1, Math.floor(ed.clientHeight / 22)) : 1;
                const targetLineIndex = dir === 'Up'
                    ? Math.max(0, currentLineIndex - jumpSize)
                    : Math.min(lines.length - 1, currentLineIndex + jumpSize);

                // Find start of target line
                let targetLineStart = 0;
                for (let i = 0; i < targetLineIndex; i++) {
                    targetLineStart += lines[i].length + 1;
                }
                // Place cursor at same column (or end of line if shorter)
                targetPos = targetLineStart + Math.min(currentCol, lines[targetLineIndex].length);

                // Scroll into view
                const lh = 22;
                const targetScroll = 15 + (targetLineIndex * lh) - (ed.clientHeight / 2) + (lh / 2);
                ed.scrollTop = Math.max(0, targetScroll);
            }

            if (this.selectLock) {
                if (targetPos < anchor) ed.setSelectionRange(targetPos, anchor, 'backward');
                else ed.setSelectionRange(anchor, targetPos, 'forward');
            } else {
                ed.setSelectionRange(targetPos, targetPos);
            }
            ed.focus();
        }
    }
}, // Closes navigate() cleanly

// Nav Drawer's "beginning of line" / "⏭️ end of line" buttons — thin
// wrappers around navigate() itself rather than a third reimplementation
// of line-boundary logic: navigate() already computes exactly this for
// both engines (CM6's cursorLineStart/cursorLineEnd commands via
// lineLock+Left/Right, and the vanilla engine's own equivalent character
// math), just gated behind lineLock being on. Temporarily forces it on
// for one synchronous call then restores whatever it actually was —
// safe to do synchronously with no risk of a concurrent hold-to-repeat
// tick reading the flag mid-flip, since JS has nothing that can interleave
// between the set/call/restore in the same synchronous pass.
goToLineStart() {
    const original = this.lineLock;
    this.lineLock = true;
    this.navigate('Left');
    this.lineLock = original;
},
goToLineEnd() {
    const original = this.lineLock;
    this.lineLock = true;
    this.navigate('Right');
    this.lineLock = original;
},

}, // Closes the parent DpadEngine object block cleanly

clones: {
    THRESHOLD: 4,
    MIN_CHAR: 12,
    lastResults: [],

    async scan() {
        const Vfs = Nexus.state?.Vfs || {};
        const cache = {}; 
        const signatureMap = new Map(); 
        const redundancies = [];

        Nexus.shell.out("Echo Sentinel: Analyzing structural overlaps...", "accent");

        Object.entries(Vfs).forEach(([file, code]) => {
            cache[file] = code.split('\n');
            cache[file].forEach((raw, idx) => {
                const clean = raw.trim();
                if (clean.length < this.MIN_CHAR) return;
                
                if (!signatureMap.has(clean)) signatureMap.set(clean, []);
                signatureMap.get(clean).push({ file, idx });
            });
        });

        const processed = new Set(); 

        signatureMap.forEach((occurrences, signature) => {
            if (occurrences.length < 2) return;

            occurrences.forEach((base, i) => {
                const baseId = `${base.file}:${base.idx}`;
                if (processed.has(baseId)) return;

                for (let j = i + 1; j < occurrences.length; j++) {
                    const target = occurrences[j];
                    const targetId = `${target.file}:${target.idx}`;
                    if (processed.has(targetId)) continue;

                    let offset = 0;
                    let block = [];

                    while (true) {
                        const lineA = cache[base.file][base.idx + offset];
                        const lineB = cache[target.file][target.idx + offset];

                        if (lineA !== undefined && lineB !== undefined && lineA.trim() === lineB.trim()) {
                            block.push(lineA);
                            offset++;
                        } else {
                            break;
                        }
                    }

                    if (offset >= this.THRESHOLD) {
                        redundancies.push({
                            instances: [
                                { file: base.file, start: base.idx + 1 },
                                { file: target.file, start: target.idx + 1 }
                            ],
                            length: offset,
                            code: block.join('\n')
                        });

                        for (let k = 0; k < offset; k++) {
                            processed.add(`${base.file}:${base.idx + k}`);
                            processed.add(`${target.file}:${target.idx + k}`);
                        }
                    }
                }
            });
        });

        this.lastResults = redundancies;
        this.render(redundancies);
        return `Scan complete. Found ${redundancies.length} logical echoes.`;
    },

    render(dupes) {
        const root = document.getElementById('clonesList');
        if (!root) return;

        if (dupes.length === 0) {
            root.innerHTML = `<div class="slab" style="text-align:center; padding:20px; opacity:0.5;">MATRIX STABLE: No echoes detected.</div>`;
            return;
        }

        root.innerHTML = dupes.map((d, i) => `
            <div class="slab" style="margin-bottom:12px; border-left:3px solid var(--gold);">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <span style="font-size:10px; font-weight:900; color:var(--gold);">REDUNDANT BLOCK [${d.length} LINES]</span>
                    <button class="tool-btn btn-accent" style="font-size:9px; padding:4px 8px;" onclick="Nexus.clones.vault(${i})">STASH TO VAULT</button>
                </div>
                <div style="font-size:9px; color:var(--accent); margin-bottom:8px; opacity:0.6;">
                    Found in: <b>${d.instances[0].file}</b> vs <b>${d.instances[1].file}</b>
                </div>
                <pre style="background:var(--bg-dark); padding:10px; border-radius:6px; font-size:10px; overflow-x:auto; margin:0; border:1px solid var(--border);">${d.code.replace(/</g, '&lt;')}</pre>
            </div>
        `).join('');

        if(Nexus.UI?.openModal) Nexus.UI.openModal('clones');
    },

    async vault(index) {
        const item = this.lastResults[index];
        if (!item) return Nexus.shell.out("Clone index lost.", "error");

        const name = `SHARED_${Date.now().toString().slice(-4)}`;
        if (Nexus.vault?.store) {
            await Nexus.vault.store(name, item.code, 'shared');
            Nexus.shell.out(`Echo stashed as '${name}'.`, "success");
        } else {
            Nexus.shell.out("Vault module not initialized.", "warn");
        }
    }
},

// =================================================================
// 4. SYNCED-SCROLL SIDE-BY-SIDE DIFF ENGINE
// =================================================================
// FIX (Compare was fundamentally broken): the old generateDiff() implemented
// its own line-matching from scratch — a greedy scan using
// `iLines.slice(iIdx).includes(oLines[oIdx])`, which re-scans the entire
// remainder of the file on every mismatch with no real alignment strategy
// (no LCS, no backtracking). Any file with repeated common lines (blank
// lines, closing braces, `});`) would misalign and cascade into
// nonsense for the rest of the comparison — which is most real code
// files. jsdiff (Diff.diffLines) was ALREADY loaded and already used
// correctly elsewhere in this file (Nexus.merge) — this just makes
// Compare use the same real, tested diff algorithm instead of a broken
// reimplementation, and adds line numbers on both sides, which the old
// version never had at all.
DiffEngine: {
    run() {
        const leftFile = document.getElementById('diffLeftSel').value;
        const rightFile = document.getElementById('diffRightSel').value;
        if (!leftFile || !rightFile) return;

        const leftText = Nexus.state.Vfs[leftFile] || '';
        const rightText = Nexus.state.Vfs[rightFile] || '';

        const summary = document.getElementById('diffSummary');
        if (leftText === rightText) {
            if (summary) { summary.innerText = '✔ Identical — no differences.'; summary.style.color = 'var(--success)'; }
        }

        const hunks = Diff.diffLines(leftText, rightText);
        this.render(hunks, summary);
        this.sync();
    },

    render(hunks, summary) {
        const left = document.getElementById('diffContentLeft'), right = document.getElementById('diffContentRight');
        left.innerHTML = ''; right.innerHTML = '';

        let leftLineNo = 1, rightLineNo = 1, added = 0, removed = 0;

        hunks.forEach(hunk => {
            // jsdiff's `value` for a multi-line hunk ends with a trailing
            // newline (except sometimes the very last hunk in the file) —
            // splitting on '\n' then dropping a resulting empty trailing
            // element keeps line counts accurate instead of counting one
            // extra phantom blank line per hunk.
            let lines = hunk.value.split('\n');
            if (lines[lines.length - 1] === '') lines.pop();

            if (hunk.added) {
                added += lines.length;
                lines.forEach(line => {
                    this.renderLine(left, null, '', 'blank-pad');
                    this.renderLine(right, rightLineNo++, line, 'added');
                });
            } else if (hunk.removed) {
                removed += lines.length;
                lines.forEach(line => {
                    this.renderLine(left, leftLineNo++, line, 'removed');
                    this.renderLine(right, null, '', 'blank-pad');
                });
            } else {
                lines.forEach(line => {
                    this.renderLine(left, leftLineNo++, line, 'equal');
                    this.renderLine(right, rightLineNo++, line, 'equal');
                });
            }
        });

        if (summary && (added > 0 || removed > 0)) {
            summary.innerHTML = `<span style="color:var(--success);">+${added}</span> &nbsp; <span style="color:var(--danger);">-${removed}</span>`;
        }
    },

    renderLine(target, lineNo, txt, type) {
        const row = document.createElement('div');
        row.className = `diff-line ${type}`;
        row.style.cssText = 'display:flex; white-space:pre; padding:1px 10px;';
        const gutter = document.createElement('span');
        gutter.style.cssText = 'flex-shrink:0; width:36px; opacity:0.4; user-select:none; text-align:right; margin-right:10px;';
        gutter.textContent = lineNo != null ? lineNo : '';
        const content = document.createElement('span');
        content.textContent = txt || (type === 'blank-pad' ? '' : ' ');
        row.appendChild(gutter);
        row.appendChild(content);
        target.appendChild(row);
    },

    sync() {
        const leftScroller = document.getElementById('diffScrollLeft');
        const rightScroller = document.getElementById('diffScrollRight');
        let scrollLockL = false, scrollLockR = false;
        
        leftScroller.onscroll = () => {
            if (!scrollLockR) { scrollLockL = true; rightScroller.scrollTop = leftScroller.scrollTop; rightScroller.scrollLeft = leftScroller.scrollLeft; }
            scrollLockL = false;
        };
        rightScroller.onscroll = () => {
            if (!scrollLockL) { scrollLockR = true; leftScroller.scrollTop = rightScroller.scrollTop; leftScroller.scrollLeft = rightScroller.scrollLeft; }
            scrollLockR = false;
        };
    }
},

// Plain-English explanations, kept separate from Sentinel/auditor so their
// own terse professional-style messages stay intact for anyone who prefers
// them — this is an optional, tap-to-expand layer on top.
tutor: {
    lintLibrary: {
        INF_LOOP: {
            title: "This loop might run forever",
            plain: "This loop's condition never seems to change, so once it starts, it may never stop — no `break`, and nothing inside the loop looks like it would make the condition eventually become false.",
            why: "An infinite loop freezes the tab, because the browser can't do anything else while it's stuck running your loop over and over.",
            fix: "Check that something inside the loop actually changes the value your condition depends on (like `i++` in a for loop), or add a `break` for the case where you want to stop early."
        },
        STACK_OVERFLOW: {
            title: "This function calls itself with no way to stop",
            plain: "This function is 'recursive' — it calls itself. That's a normal, useful pattern, but every recursive function needs a condition that eventually stops it from calling itself again.",
            why: "Without a stopping condition, each call stacks on top of the last until you hit 'Maximum call stack size exceeded' — the browser's way of saying this would never end.",
            fix: "Add an `if` at the very top that returns early once you've reached your base case (e.g. `if (n <= 0) return;`) before the function calls itself again."
        },
        DEAD_CODE: {
            title: "This code can never actually run",
            plain: "This block sits behind a condition that can never be true — often because of a `return`, `break`, or `continue` earlier in the same block that always fires first.",
            why: "It's not breaking anything right now, but it's confusing to read later, and it usually means the logic above it isn't doing what you meant.",
            fix: "Look at what comes right before this block. If there's an unconditional return/break/continue above it, either remove it or move this code before it."
        },
        SEC_LEAK: {
            title: "There's a real-looking password or key typed directly into your code",
            plain: "This looks like an API key, password, or secret token, written directly into your file instead of kept somewhere private.",
            why: "If you ever share this file, upload it to GitHub, or export it, anyone can read that secret straight out of the text. Public keys like this are often found and misused within minutes.",
            fix: "Move the real value out of your code (into an environment variable or a settings file you don't share) and reference it by name instead. If you're just testing, use an obviously fake placeholder."
        },
        TAINT_FLOW: {
            title: "Untrusted text is being inserted as raw HTML",
            plain: "Some value that could come from user input (or another changeable source) is being written into the page using something like innerHTML, which lets it inject actual HTML/script tags — not just plain text.",
            why: "This is called 'XSS' (cross-site scripting). If that value ever contains something like <script>, the browser will actually run it — it's one of the most common real-world security bugs.",
            fix: "If you're just displaying text, use .textContent instead of .innerHTML — it shows the text as-is without ever interpreting it as HTML."
        },
        PII_LEAK: {
            title: "Looks like a real email address is hardcoded in your code",
            plain: "'PII' means Personally Identifiable Information — details tied to a real person. This flagged what looks like an actual email address sitting directly in your code.",
            why: "If this file gets shared or published, that email goes with it — which can mean spam, or exposing someone's info without meaning to.",
            fix: "If it's placeholder data, use an obviously fake address like test@example.com. If it's real, move it out of the code the same way you would a password."
        },
        EVAL_CODE: {
            title: "Your code is running text as if it were code",
            plain: "This takes a plain text string and executes it as real, live JavaScript.",
            why: "If that text ever comes from outside your control (user input, a URL, another site), whoever controls the text can make your page run anything they want.",
            fix: "If you're processing data, use JSON.parse() instead. If you genuinely need dynamic behavior, there's almost always a safer, more specific tool than running raw text as code."
        },
        ASYNC_FREEZE: {
            title: "This loop is doing async work but never actually waiting for it",
            plain: "Something inside this loop returns a Promise (like a fetch call), but the loop isn't using `await` to pause for it — so it fires off every iteration at once instead of one at a time.",
            why: "Best case, things happen out of order and you get confusing bugs. Worst case, firing many requests at once can lock up the tab.",
            fix: "Add `await` in front of the async call inside the loop, and make sure the loop itself is inside a function marked `async`."
        },
        LAYOUT_THRASH: {
            title: "This loop is repeatedly asking the browser to re-measure the page",
            plain: "Something like .offsetHeight or .getBoundingClientRect() is being read inside a loop. Those specific properties force the browser to stop and recalculate the whole page layout before it can answer — and it's happening every time through the loop.",
            why: "This is called 'layout thrashing.' On a phone especially, doing this many times in a tight loop can make the page visibly stutter.",
            fix: "Read the measurement ONCE, before the loop starts, store it in a variable, and use that variable inside the loop instead of re-measuring every time."
        },
        N_PLUS_ONE: {
            title: "You're making one network request per item, instead of one for all of them",
            plain: "There's a network or database call happening inside a loop — so looping over 50 items means 50 separate round-trips instead of one.",
            why: "This is called an 'N+1' problem. It's one of the most common reasons an app feels slow, especially on mobile data.",
            fix: "See if the API/database supports fetching everything in a single batched call. If not, at least run them together with Promise.all([...]) instead of one after another."
        },
        SILENT_CATCH: {
            title: "An error was caught, then completely ignored",
            plain: "This `catch` block is empty — your code correctly noticed something went wrong, but then does nothing with that information at all.",
            why: "When this runs, the failure just vanishes. Nothing gets logged, nothing tells the user, and nothing about your app's behavior gives any hint that an error happened — which makes real bugs much harder to track down later, since the error that would have pointed you to them is thrown away.",
            fix: "At minimum, add `console.error(err)` inside the catch block so the error shows up somewhere. If you're deliberately ignoring it because it's genuinely safe to, leave a comment explaining why — that turns 'looks like a mistake' into a clear, intentional choice."
        },
        LOOSE_EQUALITY: {
            title: "This comparison quietly converts types before checking",
            plain: "`==` and `!=` don't just compare values — they first try to convert both sides to the same type, then compare. `===` and `!==` skip that step and compare the value and type together.",
            why: "The conversion rules produce results that don't match what most people expect: `'' == 0` is `true`, `null == undefined` is `true`, `'0' == false` is `true`. If either side of your comparison is a value you didn't fully control, `==` can quietly match — or fail to match — in a way you didn't intend.",
            fix: "Switch to `===` / `!==`. If you're specifically checking for `null` or `undefined` together, `x == null` is a common, deliberate exception to this rule."
        },
        VAR_USAGE: {
            title: "'var' behaves differently than you'd expect",
            plain: "`var` isn't scoped to the block it's declared in the way `let` and `const` are — it's scoped to the whole function, and it's hoisted to the top of that function before your code even runs.",
            why: "The classic symptom: a variable declared with `var` inside a loop ends up being the *same* variable shared across every iteration, so a callback that captures it later sees whatever its final value ended up being. `let` fixes this by giving each iteration its own copy.",
            fix: "Use `const` by default, and `let` for anything you need to reassign. There's essentially no reason to reach for `var` in modern JavaScript."
        },
        DUPLICATE_KEY: {
            title: "This object has the same key written twice",
            plain: "Somewhere in this object literal, the same property name appears more than once — like `{ status: 'active', status: 'pending' }`.",
            why: "JavaScript doesn't warn you about this. It just silently keeps the *last* value and throws away every earlier one with that key. If this happened during a copy-paste or a refactor, the property you think you're setting might not be the one that actually ends up on the object.",
            fix: "Check which value you actually meant to keep, and remove the other one. If both keys are meant to end up somewhere, they need different names."
        },
        OFFLINE_FAIL: {
            title: "This network request has no fallback if it fails",
            plain: "This fetch() call isn't wrapped in a try/catch, so if the request fails (no connection, server down, etc.), nothing handles that failure.",
            why: "An unhandled failed fetch can stop the rest of your function from running, with no clear message about what went wrong — most noticeable when someone's offline.",
            fix: "Wrap the fetch in try { ... } catch (err) { ... } so you can show a friendly message (or retry) instead of it silently breaking."
        },
        SHADOW_VAR: {
            title: "You've reused a variable name that's already used outside this block",
            plain: "This variable is declared again inside a smaller block (like a function or an if), even though a variable with the exact same name already exists further out. This is called 'shadowing.'",
            why: "It's not a hard error, but it's a common source of 'wait, why does this have the wrong value' confusion once code gets longer.",
            fix: "Give the inner variable a different, more specific name (e.g. if the outer one is `items`, the inner one could be `filteredItems`)."
        },
        LOGIC_FLIP: {
            title: "This double-negative is a slightly obscure way to convert to true/false",
            plain: "!!something is a common trick to force any value into a plain true/false, but it reads oddly if you haven't seen the pattern before.",
            why: "This isn't a bug — it works correctly. It's purely about readability for you (or anyone else) coming back to this later.",
            fix: "Boolean(something) does the exact same thing and says what it means more directly."
        },
        ZOMBIE_CODE: {
            title: "This variable is declared but never actually used",
            plain: "This variable is created but never read or referenced anywhere else in the file.",
            why: "Harmless on its own, but it usually means either leftover code from an earlier version, or a typo where you meant to use it somewhere and didn't.",
            fix: "If you don't need it, delete the declaration. If you meant to use it, that's your clue to go find where it should have been referenced."
        }
    },

    // Pattern-matches raw browser runtime error messages against common
    // beginner-error families. Returns null if nothing matches, so callers
    // fall back to showing the raw message untranslated.
    explainRuntimeError(rawMessage) {
        if (!rawMessage || typeof rawMessage !== 'string') return null;
        const msg = rawMessage.replace(/^Uncaught\s+/, '');
        let m;

        if ((m = msg.match(/ReferenceError:\s*(\w+) is not defined/))) {
            const name = m[1];
            return {
                title: `'${name}' doesn't exist yet`,
                plain: `Your code tries to use something called '${name}', but nothing by that name has been created — either it was never declared, it's declared further down (after this line runs), or it's spelled differently somewhere.`,
                why: "JavaScript can only use a name once it's been declared with let, const, var, or function.",
                fix: `Check the spelling of '${name}' everywhere it appears, and make sure it's declared with let/const/var (or as a function) BEFORE this line runs.`
            };
        }
        // V8 has used two message formats over the years for this error, with
        // the property name and the undefined/null kind in a different order
        // in each — handled as two explicit patterns rather than one merged
        // regex, since merging silently grabs the wrong capture group.
        if ((m = msg.match(/TypeError:\s*Cannot read properties of (undefined|null) \(reading '(\w+)'\)/))) {
            const kind = m[1], prop = m[2];
            return {
                title: `Trying to use something that doesn't exist (${kind})`,
                plain: `Your code tries to read '.${prop}' from something that turned out to be ${kind} — meaning whatever was supposed to be there wasn't.`,
                why: kind === 'null'
                    ? "This is extremely common with document.getElementById(...) — if the ID is misspelled, or the element hasn't been created yet, you get null back instead of the element."
                    : "This usually means a variable was never assigned a real value, or a function that was supposed to return something returned nothing.",
                fix: `Trace backwards from this line: what's the variable right before '.${prop}'? Check where it comes from, and confirm it actually has a value before this line runs.`
            };
        }
        if ((m = msg.match(/TypeError:\s*Cannot read property '(\w+)' of (undefined|null)/))) {
            const prop = m[1], kind = m[2];
            return {
                title: `Trying to use something that doesn't exist (${kind})`,
                plain: `Your code tries to read '.${prop}' from something that turned out to be ${kind} — meaning whatever was supposed to be there wasn't.`,
                why: kind === 'null'
                    ? "This is extremely common with document.getElementById(...) — if the ID is misspelled, or the element hasn't been created yet, you get null back instead of the element."
                    : "This usually means a variable was never assigned a real value, or a function that was supposed to return something returned nothing.",
                fix: `Trace backwards from this line: what's the variable right before '.${prop}'? Check where it comes from, and confirm it actually has a value before this line runs.`
            };
        }
        if ((m = msg.match(/TypeError:\s*(\S+) is not a function/))) {
            const name = m[1];
            return {
                title: `'${name}' isn't a function`,
                plain: `Your code tries to call '${name}(...)' like a function, but it's actually something else (or it's undefined).`,
                why: "This usually means a typo in the name, calling a variable that holds a non-function value, or using a library/method before it's finished loading.",
                fix: `Double check the spelling of '${name}', and confirm it's actually a function (try checking its value nearby with console.log(typeof ${name.split('.')[0]})).`
            };
        }
        if ((m = msg.match(/SyntaxError:\s*Unexpected token '?(.+?)'?$/))) {
            const token = m[1];
            return {
                title: `There's a typo near '${token}'`,
                plain: `The code stopped making sense to JavaScript right around '${token}' — often a missing or extra comma, bracket, or quote nearby.`,
                why: "JavaScript needs to be able to read your whole file as valid structure before it runs any of it — one misplaced character can block the entire file.",
                fix: "Look at the characters just before this token: check for a missing closing bracket ) ] }, a missing comma between items, or a stray quote."
            };
        }
        if (/Unexpected end of input/.test(msg)) {
            return {
                title: "Something isn't closed",
                plain: "JavaScript reached the end of your file while still expecting more — almost always an unclosed bracket, brace, or parenthesis somewhere above.",
                why: "Every ( [ { needs a matching ) ] } — if one's missing, everything after it is technically still 'inside' it as far as JavaScript is concerned.",
                fix: "Use the bracket checker (or scroll through your code) counting opens vs closes for (), [], and {} — the mismatch is usually near where the logic 'feels' finished."
            };
        }
        if (/Maximum call stack size exceeded/.test(msg)) {
            return {
                title: "A function is calling itself without stopping",
                plain: "Something in your code calls itself (directly or indirectly) over and over with no condition that ever stops it.",
                why: "Each call takes up space in memory until there's none left — this is the runtime version of infinite recursion.",
                fix: "Find the recursive function and add a base-case check at the top (e.g. `if (n <= 0) return;`) before it calls itself again."
            };
        }
        if ((m = msg.match(/(\S+) is not iterable/))) {
            const name = m[1];
            return {
                title: `Can't loop over '${name}'`,
                plain: `Your code tries to loop over '${name}' (with for...of, spread ..., or similar), but it isn't a type that can be looped — usually a plain object, undefined, or a number.`,
                why: "Only arrays, strings, and a few other specific types support this kind of looping.",
                fix: `Check what '${name}' actually contains right before this line — if it's an object of key/value pairs, use Object.keys(${name}) or Object.entries(${name}) instead.`
            };
        }
        return null;
    },

    glossary: {
        "Variable": "A named container that holds a value, so you can use it (and change it) later by name instead of retyping the value.",
        "Function": "A named, reusable block of code you can 'call' whenever you need to run it, optionally feeding it inputs and getting a result back.",
        "Array": "An ordered list of values, accessed by position starting at 0 — e.g. myArray[0] is the first item.",
        "Object": "A collection of named values (key/value pairs) — e.g. { name: 'Jay', age: 25 } — accessed by name instead of position.",
        "Loop": "A block of code that repeats automatically, either a fixed number of times (for) or until a condition changes (while).",
        "Async": "Describes code that can pause and resume later without freezing everything else — used for things like network requests, where waiting for a real answer could otherwise lock up the page.",
        "Promise": "An object representing a value that isn't ready yet, but will be (or will fail) at some point — the standard way JavaScript handles async results.",
        "Callback": "A function you hand to another function, to be run later — often once some task (like loading data) finishes.",
        "Scope": "Which parts of your code a variable is visible/usable from — roughly, the block { } it was declared inside, and anything nested within that block.",
        "API": "A defined way for two pieces of software to talk to each other — e.g. a website's server exposing endpoints your code can request data from.",
        "DOM": "'Document Object Model' — the browser's live, in-memory representation of your HTML page, which your JavaScript can read and change.",
        "JSON": "'JavaScript Object Notation' — a plain-text format for representing data (objects, arrays, numbers, strings) that's easy for both humans and computers to read.",
        "Boolean": "A value that's only ever true or false — the result of any yes/no comparison, like x > 5.",
        "Null / Undefined": "Both mean 'no real value here', but undefined usually means 'never set,' while null usually means 'deliberately set to nothing.'",
    },

    renderExplainCard(entry) {
        if (!entry) return '';
        return `<div style="background:var(--bg); border:1px solid var(--accent); border-radius:6px; padding:10px; margin-top:6px; font-size:11px; line-height:1.5;">`
            + `<div style="color:var(--accent); font-weight:bold; margin-bottom:4px;">💡 ${entry.title}</div>`
            + `<div style="margin-bottom:6px;">${entry.plain}</div>`
            + `<div style="opacity:0.75; margin-bottom:6px;"><b>Why it matters:</b> ${entry.why}</div>`
            + `<div><b>How to think about fixing it:</b> ${entry.fix}</div>`
            + `</div>`;
    },

    toggleExplain(idx) {
        const el = document.getElementById('explain' + idx);
        if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
    },

    openGlossary() {
        const box = document.getElementById('glossaryBody');
        if (box) {
            box.innerHTML = Object.entries(this.glossary).map(([term, def]) =>
                `<div style="margin-bottom:12px;"><div style="color:var(--gold); font-weight:bold; font-size:12px;">${term}</div><div style="font-size:11px; opacity:0.85; margin-top:2px;">${def}</div></div>`
            ).join('');
        }
        Nexus.UI.openModal('glossary');
    }
},

Sentinel : {
   engine: null,
   lastIssues: [],

   // 1. Internal Logging Engine
   log(msg, type = "info") {
       const out = document.getElementById('diagOut');
       if (!out) return;
       const colors = { success: "var(--success)", danger: "var(--danger)", warn: "var(--warn)", accent: "var(--accent)" };
       const entry = document.createElement('div');
       entry.style.cssText = `color: ${colors[type] || "var(--text)"}; margin-bottom: 8px; border-left: 2px solid ${colors[type] || "var(--border)"}; padding-left: 10px; font-size: 12px;`;
       entry.innerHTML = `[${new Date().toLocaleTimeString()}] ${msg}`;
       if (out.innerText.includes("OFFLINE")) out.innerHTML = "";
       out.prepend(entry);
   },

   // 2. The Linter Logic
   runLint() {
       if (!Nexus.state.activeFile) return this.log("Error: No active sector.", "danger");
       this.initEngine(); // Lazy-load Acorn engine

       const ext = Nexus.state.activeFile.split('.').pop().toLowerCase();
       let code = Nexus.state.Vfs[Nexus.state.activeFile] || "";
       let pre = "", post = "", isHtml = false;

       // Isolate JS inside HTML if necessary
       if (ext === 'html') {
           const block = this.findMainScript(code);
           if (block) {
               isHtml = true;
               pre = block.pre;
               post = block.post;
               code = block.code;
           } else return this.log("Lint: No script tags found.", "warn");
       } else if (ext !== 'js') return this.log("Lint: Only JS/HTML supported.", "warn");

       try {
           const { issues } = this.engine.analyzeAndMutate(code, 'LINT');
           this.lastIssues = issues; // Store for the "Fix" buttons

           if (issues.length === 0) {
               this.log("Matrix Solid. 0 Anomalies detected.", "success");
           } else {
               this.renderIssueList(issues);
           }
       } catch (e) {
           this.log(`Structure Compromised: ${e.message}`, "danger");
       }
   },


 // 3. Dynamic Issue Rendering (Hardened against tokenizer bleeding)
 renderIssueList(issues) {
     let html = '<div style="display:flex; justify-content:space-between; margin-bottom:10px;">' +
         '<div style="color:var(--danger); font-weight:bold;">' + issues.length + ' ISSUES</div>' +
         '<button class="tool-btn btn-success" style="padding:4px 8px; font-size:10px;" onclick="Nexus.Sentinel.applyAllFixes()">FIX ALL</button>' +
     '</div>';
 
     issues.forEach((iss, idx) => {
         const color = iss.severity === 'CRITICAL' ? 'var(--danger)' : 'var(--gold)';
         
         // Handle the conditional button logic safely outside the main template string
         let btnHtml = '';
         if (iss.mutate) {
             btnHtml = '<button class="tool-btn btn-gold" style="padding:2px 6px; font-size:9px;" onclick="Nexus.Sentinel.applyFix(' + idx + ')">FIX</button>';
         }

         // Plain-English explanation, tap-to-expand, only shown for IDs the
         // tutor knowledge base actually covers.
         const explainEntry = Nexus.tutor.lintLibrary[iss.id];
         let explainBtn = '', explainCard = '';
         if (explainEntry) {
             explainBtn = '<button class="tool-btn" style="padding:2px 6px; font-size:9px;" onclick="Nexus.tutor.toggleExplain(' + idx + ')" title="Explain in plain English" aria-label="Explain this issue">?</button>';
             explainCard = '<div id="explain' + idx + '" style="display:none;">' + Nexus.tutor.renderExplainCard(explainEntry) + '</div>';
         }
 
         html += '<div style="background:var(--surface); padding:10px; margin-bottom:5px; border-left:3px solid ' + color + '; border-radius:4px;">' +
             '<div style="display:flex; justify-content:space-between; align-items:center; gap:4px;">' +
                 '<span style="color:' + color + '; font-size:10px; font-weight:bold;">' + iss.id + ' | LN ' + iss.line + '</span>' +
                 '<span style="display:flex; gap:4px;">' + explainBtn + btnHtml + '</span>' +
             '</div>' +
             '<div style="font-size:11px; margin-top:4px; opacity:0.9;">' + iss.message + '</div>' +
             explainCard +
         '</div>';
     });
     document.getElementById('diagOut').innerHTML = html;
 },
 

   // 4. Atomic Mutation Engine
   applyFix(idx) {
       const issue = this.lastIssues[idx];
       if (!issue || !issue.mutate) return;

       this.mutateActiveVfs((code) => {
           const { ast } = this.engine.analyzeAndMutate(code, 'LINT');
           this.engine.traverse(ast, (node) => {
               if (node.type === issue.nodeType && node.start === issue.range[0] && node.end === issue.range[1]) {
                   issue.mutate(node);
               }
           });
           return astring.generate(ast, { indent: ' '.repeat(Nexus.state.prefs.tabWidth) });
       });
       this.log(`Fixed: ${issue.id}`, "success");
       this.runLint(); // Re-scan after fix
   },

   applyAllFixes() {
       this.mutateActiveVfs((code) => {
           const { ast } = this.engine.analyzeAndMutate(code, 'LINT');
           this.engine.traverse(ast, (node) => {
               this.lastIssues.forEach(issue => {
                   if (issue.mutate && node.type === issue.nodeType && node.start === issue.range[0] && node.end === issue.range[1]) {
                       issue.mutate(node);
                   }
               });
           });
           return astring.generate(ast, { indent: ' '.repeat(Nexus.state.prefs.tabWidth) });
       });
       this.log("Bulk Patch Applied.", "success");
       this.lastIssues = [];
       this.runLint();
   },

   // 5. HELPER: The Sovereign Mutation Pipeline
   mutateActiveVfs(mutationFn) {
       if (!Nexus.state.activeFile) return this.log("Error: No active sector.", "danger");
       if (this.isLocked()) return this.log("[SENTINEL] EDITOR LOCKED. Cannot apply fix.", "danger");

       const ext = Nexus.state.activeFile.split('.').pop().toLowerCase();
       let fullCode = Nexus.state.Vfs[Nexus.state.activeFile];
       let targetCode = fullCode;
       let pre = "", post = "";

       // Handle HTML Isolation
       if (ext === 'html') {
           const block = this.findMainScript(fullCode);
           if (block) {
               pre = block.pre;
               post = block.post;
               targetCode = block.code;
           }
       }

       const mutated = mutationFn(targetCode);
       const finalCode = pre + mutated + post;

       this.setLiveCode(finalCode);
   },
   
   // ... initEngine and other existing Sentinel logic ...



       initEngine() {
           if (this.engine) return;
           class DevOSSentinelDual {
               constructor() { 
                   this.registry = []; 
                   this.declarations = new Map(); 
                   this.references = new Set(); 
                   this.magicNumbers = new Map(); 
                   this.initDefaultCheckers(); 
               }
               
               initDefaultCheckers() {
                   // --- 1. LOGIC & CRITICAL FLOW ---
                   this.use({ check: (node) => {
                       if (['WhileStatement', 'ForStatement'].includes(node.type)) {
                           if (node.test?.value === true && !this.findInNode(node.body, 'BreakStatement')) {
                               return { id: 'INF_LOOP', message: "Infinite Loop: No break found.", severity: 'CRITICAL' };
                           }
                       }
                   }});

                   this.use({ check: (node, parent, context) => {
                       if (node.type === 'FunctionDeclaration' && node.id) context.currentFunctionName = node.id.name;
                       if (node.type === 'CallExpression' && node.callee.name === context.currentFunctionName) {
                           let isGuarded = false; 
                           let tracer = node.parent;
                           while (tracer && tracer.type !== 'FunctionDeclaration') {
                               if (['IfStatement', 'SwitchStatement', 'ConditionalExpression'].includes(tracer.type)) { isGuarded = true; break; }
                               tracer = tracer.parent;
                           }
                           if (!isGuarded) return { id: 'STACK_OVERFLOW', message: `Recursion Risk: '${node.callee.name}' calls itself without an exit guard.`, severity: 'CRITICAL' };
                       }
                   }});

                   this.use({ check: (node) => {
                       if (node.type === 'IfStatement' && node.test.type === 'Literal' && node.test.value === false) {
                           return { id: 'DEAD_CODE', message: "Dead Branch: This block will never execute.", severity: 'LOW' };
                       }
                   }});
            // --- 2. SECURITY & DATA INTEGRITY ---
                   this.use({ check: (node) => {
                       if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
                           const name = node.id.name.toLowerCase(); 
                           const val = node.init?.value;
                           if ((name.includes('key') || name.includes('secret')) && typeof val === 'string' && val.length > 10) {
                               return { id: 'SEC_LEAK', message: `Secret Leak: Hardcoded '${node.id.name}'. Move to .env.`, severity: 'HIGH' };
                           }
                       }
                   }});

                   this.use({ check: (node) => {
                       if (node.type === 'AssignmentExpression' && node.right.type === 'MemberExpression') {
                           const sink = node.left.property?.name || node.left.name;
                           if (['innerHTML', 'outerHTML', 'insertAdjacentHTML'].includes(sink)) {
                               return { id: 'TAINT_FLOW', message: `XSS Risk: Flow into '${sink}'. Use textContent or sanitize.`, severity: 'CRITICAL' };
                           }
                       }
                   }});

                   this.use({ check: (node) => {
                       if (node.type === 'Literal' && typeof node.value === 'string') {
                           if (/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/.test(node.value)) {
                               return { id: 'PII_LEAK', message: "Privacy Risk: Potential PII (Email) detected in string.", severity: 'HIGH' };
                           }
                       }
                   }});

                   this.use({ check: (node) => {
                       const risky = ['eval', 'setTimeout', 'setInterval', 'Function'];
                       if (node.type === 'CallExpression' && risky.includes(node.callee.name)) {
                           if (node.arguments[0]?.type === 'Literal' && typeof node.arguments[0].value === 'string') {
                               return { id: 'EVAL_CODE', message: `Security Risk: '${node.callee.name}' using string-to-code execution.`, severity: 'CRITICAL' };
                           }
                       }
                   }});

                   this.use({ check: (node) => {
                       if (node.type === 'CatchClause' && node.body.type === 'BlockStatement' && node.body.body.length === 0) {
                           return { id: 'SILENT_CATCH', message: "Silent Failure: empty catch block swallows the error with no trace. Log it, handle it, or comment why it's safe to ignore.", severity: 'MEDIUM' };
                       }
                   }});
                   // Loose equality: == and != coerce types before comparing.
                   // Excludes == null / != null on purpose — a deliberate,
                   // common idiom for "is this null or undefined".
                   this.use({ check: (node) => {
                       if (node.type === 'BinaryExpression' && (node.operator === '==' || node.operator === '!=')) {
                           const isNullCheck = (node.left.type === 'Literal' && node.left.value === null) ||
                                               (node.right.type === 'Literal' && node.right.value === null);
                           if (!isNullCheck) {
                               return { id: 'LOOSE_EQUALITY', message: `Loose comparison ('${node.operator}') silently converts types before comparing. Use '${node.operator}=' unless you specifically need that.`, severity: 'LOW' };
                           }
                       }
                   }});
                   // var is function-scoped and hoisted, not block-scoped
                   // like let/const — classic source of loop/closure bugs.
                   this.use({ check: (node) => {
                       if (node.type === 'VariableDeclaration' && node.kind === 'var') {
                           return { id: 'VAR_USAGE', message: "'var' is function-scoped and hoisted, not block-scoped — a common source of loop/closure bugs. Use 'let' or 'const' instead.", severity: 'LOW' };
                       }
                   }});
                   // Duplicate keys in an object literal: no error, the
                   // later value just quietly wins.
                   this.use({ check: (node) => {
                       if (node.type === 'ObjectExpression') {
                           const seen = new Set();
                           for (const prop of node.properties) {
                               if (prop.type !== 'Property' || prop.computed) continue;
                               const key = prop.key.type === 'Identifier' ? prop.key.name : prop.key.value;
                               if (key === undefined) continue;
                               if (seen.has(key)) {
                                   return { id: 'DUPLICATE_KEY', message: `Duplicate key '${key}' in this object — the earlier value is silently discarded.`, severity: 'MEDIUM' };
                               }
                               seen.add(key);
                           }
                       }
                   }});
     // --- 3. PERFORMANCE & PWA ---
                   this.use({ check: (node, parent, context) => {
                       if ((node.type === 'FunctionDeclaration' || node.type === 'ArrowFunctionExpression') && node.async) context.inAsync = true;
                       if (context?.inAsync && ['WhileStatement', 'ForStatement'].includes(node.type)) {
                           if (!this.findInNode(node.body, 'AwaitExpression')) {
                               return { id: 'ASYNC_FREEZE', message: "UI Thread Alert: Async loop missing 'await'. Tab will freeze.", severity: 'CRITICAL' };
                           }
                       }
                   }});

                   this.use({ check: (node) => {
                       const triggers = ['offsetWidth', 'offsetHeight', 'getBoundingClientRect', 'getComputedStyle'];
                       const prop = node.property?.name || node.callee?.property?.name;
                       if (triggers.includes(prop)) {
                           let tracer = node.parent;
                           while (tracer) {
                               if (['ForStatement', 'WhileStatement'].includes(tracer.type)) return { id: 'LAYOUT_THRASH', message: "Performance: Layout read inside loop causing thrashing.", severity: 'HIGH' };
                               tracer = tracer.parent;
                           }
                       }
                   }});

                   this.use({ check: (node) => {
                       if (['ForStatement', 'WhileStatement', 'ForOfStatement'].includes(node.type)) {
                           if (this.findInNode(node.body, 'CallExpression', (n) => n.callee.name === 'fetch' || n.callee.property?.name === 'query')) {
                               return { id: 'N_PLUS_ONE', message: "Performance: Network/DB call inside loop (N+1 Risk).", severity: 'HIGH' };
                           }
                       }
                   }});

                   this.use({ check: (node) => {
                       if (node.type === 'CallExpression' && node.callee.name === 'fetch') {
                           let tracer = node.parent; 
                           let inTry = false;
                           while (tracer) { if (tracer.type === 'TryStatement') { inTry = true; break; } tracer = tracer.parent; }
                           if (!inTry) return { id: 'OFFLINE_FAIL', message: "PWA Reliability: 'fetch' outside try/catch will crash offline.", severity: 'CRITICAL' };
                       }
                   }});
                 // --- 4. ARCHITECTURE & CLEAN CODE ---
                   this.use({ check: (node) => {
                       // Only variable bindings are tracked for the unused-check
                       // below. Function declarations are deliberately excluded:
                       // a function not called from within this same file is
                       // completely normal (HTML onclick handlers, other files,
                       // attaching to window, etc.), so treating it as "unused"
                       // produced constant false positives on ordinary code.
                       if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') this.declarations.set(node.id.name, node);
                   }});

                   this.use({ check: (node, parent) => {
                       if (node.type === 'Identifier') {
                           const isUsage = parent && !['VariableDeclarator', 'FunctionDeclaration'].includes(parent.type) &&
                                           !(parent.type === 'MemberExpression' && parent.property === node);
                           if (isUsage) this.references.add(node.name);
                       }
                   }});

                   this.use({ check: (node) => {
                       if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
                           let tracer = node.parent;
                           while (tracer) {
                               if (['FunctionDeclaration', 'Program'].includes(tracer.type)) {
                                   if (this.findDeclarationsInScope(tracer, node.id.name, node)) {
                                       return { id: 'SHADOW_VAR', message: `Ambiguity: '${node.id.name}' shadows an outer scope variable.`, severity: 'MEDIUM' };
                                   }
                               }
                               tracer = tracer.parent;
                           }
                       }
                   }});

                   // Auto-Mutator: !! to Boolean
                   this.use({ check: (node) => {
                       if (node.type === 'UnaryExpression' && node.operator === '!' && node.argument?.type === 'UnaryExpression' && node.argument.operator === '!') {
                           return { id: 'LOGIC_FLIP', message: "Clarity: '!!' is less readable than Boolean() cast.", severity: 'LOW', range: node.range, 
                               mutate: (n) => { 
                                   const target = n.argument.argument;
                                   n.type = 'CallExpression'; 
                                   n.callee = { type: 'Identifier', name: 'Boolean' }; 
                                   n.arguments = [ target ]; 
                                   delete n.operator; delete n.prefix; delete n.argument; 
                               } 
                           };
                       }
                   }});
               }

               use(checkerObj) { this.registry.push(checkerObj); }
               
               analyzeAndMutate(code, mode) {
                   this.declarations.clear();
                   this.references.clear();
                   this.magicNumbers.clear();
                   
                   if (typeof acorn === 'undefined') throw new Error("Acorn Parser Missing.");
                   const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'module', locations: true, ranges: true });
                   const issues = [];
                   const context = { inAsync: false, currentFunctionName: null };
               this.traverse(ast, (node, parent) => {
                       this.registry.forEach(rule => {
                           const result = rule.check(node, parent, context);
                           if (result) { 
                               issues.push({ ...result, nodeType: node.type, range: node.range, line: node.loc?.start?.line }); 
                               if (mode === 'AST_REBUILD' && result.mutate) result.mutate(node); 
                           }
                       });
                   });

                   // Zombie Check (Post-scan)
                   for (const [name, node] of this.declarations) {
                       if (!this.references.has(name)) {
                           issues.push({ id: 'ZOMBIE_CODE', message: `Unused variable: '${name}'.`, severity: 'LOW', line: node.loc?.start.line });
                       }
                   }
                   return { issues, ast };
               }
               traverse(node, callback, parent = null) {
   // THE FIX: Immediately abort if the node is a primitive (like a number or string)
   if (!node || typeof node !== 'object') return; 
   
   node.parent = parent; 
   callback(node, parent);
   
   Object.keys(node).forEach(key => {
       if (key === 'parent') return;
       const child = node[key];
       if (child && typeof child === 'object') { 
           if (Array.isArray(child)) {
               child.forEach(c => this.traverse(c, callback, node)); 
           } else if (child.type) {
               this.traverse(child, callback, node); 
           }
       }
   });
}


               findInNode(node, type, filter = () => true) {
                   let found = false;
                   this.traverse(node, (n) => { if (n.type === type && filter(n)) found = true; });
                   return found;
               }
   findDeclarationsInScope(scopeNode, name, excludeNode) {
                   let found = false;
                   this.traverse(scopeNode, (n) => {
                       if (n === excludeNode) return;
                       if (n.type === 'VariableDeclarator' && n.id.name === name) found = true;
                       if (n.type === 'FunctionDeclaration' && n.id?.name === name) found = true;
                   });
                   return found;
               }
           }
           this.engine = new DevOSSentinelDual();
       },

       // --- Engine-agnostic helpers ---
       // The MEDIC/Lint fix tools used to read/write the hidden vanilla textarea
       // directly, which goes stale and does nothing once the CM6 engine is active.
       // These route through whichever engine is actually live.
       isLocked() {
           if (Nexus.editorCore && Nexus.editorCore.isCM6 && Nexus.editorCore.view) {
               return Nexus.editorCore.view.contentDOM.contentEditable === "false";
           }
           const ed = document.getElementById('rawTerminal');
           return !ed || ed.hasAttribute('readonly');
       },
       getLiveCode() {
           if (Nexus.editorCore && Nexus.editorCore.isCM6 && Nexus.editorCore.view) {
               return Nexus.editorCore.view.state.doc.toString();
           }
           const ed = document.getElementById('rawTerminal');
           return ed ? ed.value : (Nexus.state.Vfs[Nexus.state.activeFile] || "");
       },
       setLiveCode(code) {
           if (Nexus.editorCore && Nexus.editorCore.isCM6 && Nexus.editorCore.view) {
               const view = Nexus.editorCore.view;
               view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } });
           } else {
               const ed = document.getElementById('rawTerminal');
               if (ed) ed.value = code;
           }
           Nexus.state.Vfs[Nexus.state.activeFile] = code;
           Nexus.Vfs.save();
           Nexus.UI.updateGutter();
       },
       // Finds the largest inline <script> block (skipping empty/external <script src="...">
       // tags) instead of blindly grabbing the first match, which used to pick up an
       // empty external script tag ahead of the real inline code.
       findMainScript(html) {
           const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
           let best = null, m;
           while ((m = re.exec(html)) !== null) {
               if (!best || m[1].length > best.code.length) {
                   best = { code: m[1], start: m.index + m[0].indexOf(m[1]), full: m[0] };
               }
           }
           if (!best) return null;
           return {
               code: best.code,
               pre: html.substring(0, best.start),
               post: html.substring(best.start + best.code.length)
           };
       },
       runMedicString() { 
           if (!Nexus.state.activeFile) return this.log("[MEDIC STRING] No file open — open or create a file first.", "warn");
           if (this.isLocked()) return this.log("[MEDIC] EDITOR LOCKED. Cannot apply patch.", "danger");
           
           let code = this.getLiveCode();
           code = code.replace(/[ \t]+$/gm, '');
           code = code.replace(/\n{3,}/g, '\n\n');
           code = code.replace(/\n*$/, '\n');
           
           this.setLiveCode(code);
           
           this.log("[MEDIC STRING] Deep string scrub complete. Whitespace optimized.", "success"); 
       },
       runMedicAST() { 
           if (!Nexus.state.activeFile) return this.log("[MEDIC AST] No file open — open or create a file first.", "warn");
           if (this.isLocked()) return this.log("[MEDIC] EDITOR LOCKED. Cannot rebuild.", "danger");
           
           const ext = Nexus.state.activeFile.split('.').pop().toLowerCase();
           if (ext !== 'js') return this.log("[MEDIC AST] Logic rebuild only supports raw .js files.", "warn");
           
           this.initEngine(); 
           
           try {
               const { ast, issues } = this.engine.analyzeAndMutate(this.getLiveCode(), 'AST_REBUILD');
               
               if (issues.length === 0) {
                   return this.log("[MEDIC AST] Code structure optimal. No mutations required.", "success");
               }
               
               const rebuiltCode = astring.generate(ast, { indent: ' '.repeat(Nexus.state.prefs.tabWidth) });
               
               this.setLiveCode(rebuiltCode);
               
               this.log(`[MEDIC AST] Matrix reconstructed. Applied ${issues.length} structural mutation(s).`, "success");
           } catch(e) {
               this.log(`[AST FATAL ERROR] File structurally compromised. Cannot parse.<br><span style="font-size:10px;">${e.message}</span>`, "danger");
           }
       },

       // Strips comments. JS (and JS inside <script> blocks) uses acorn's real
       // tokenizer to find exact comment ranges and remove only those —
       // deliberately NOT a regex pass, since a regex risks eating a "//"
       // that's actually inside a URL string or a "/pattern/" regex literal.
       // CSS is simple enough (no nested-slash ambiguity in practice) for a
       // straightforward regex.
       stripComments() {
           if (!Nexus.state.activeFile) return this.log("[STRIP COMMENTS] No file open — open or create a file first.", "warn");
           if (this.isLocked()) return this.log("[STRIP COMMENTS] EDITOR LOCKED. Cannot modify.", "danger");

           const ext = Nexus.state.activeFile.split('.').pop().toLowerCase();
           const code = this.getLiveCode();
           let result;
           try {
               if (ext === 'js') {
                   result = this._stripJsComments(code);
               } else if (ext === 'css') {
                   result = code.replace(/\/\*[\s\S]*?\*\//g, '');
               } else if (ext === 'html') {
                   result = this._stripHtmlComments(code);
               } else {
                   return this.log("[STRIP COMMENTS] Only .js, .css, and .html files are supported.", "warn");
               }
           } catch (e) {
               return this.log(`[STRIP COMMENTS] Could not parse — fix the syntax error first.<br><span style="font-size:10px;">${e.message}</span>`, "danger");
           }

           // Comment-only lines become blank; tidy up the same way Medic
           // String already does, so this doesn't leave a trail of clutter.
           result = result.replace(/[ \t]+$/gm, '');
           result = result.replace(/\n{3,}/g, '\n\n');
           result = result.replace(/\n*$/, '\n');

           this.setLiveCode(result);
           this.log(`[STRIP COMMENTS] Comments removed from ${Nexus.state.activeFile}.`, "success");
       },
       _stripJsComments(code) {
           const comments = [];
           acorn.parse(code, { ecmaVersion: 2022, sourceType: 'module', onComment: comments });
           let result = code;
           comments.slice().sort((a, b) => b.start - a.start).forEach(c => {
               result = result.slice(0, c.start) + result.slice(c.end);
           });
           return result;
       },
       _stripHtmlComments(code) {
           // Strip comments inside each <script>/<style> block using the
           // right stripper for that language, then remove plain HTML
           // comments in what's left outside those blocks.
           let result = code.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (m, open, inner, close) => {
               let cleaned = inner;
               try { cleaned = this._stripJsComments(inner); } catch (e) { /* leave this block untouched if it doesn't parse as JS on its own (e.g. non-JS script type) */ }
               return open + cleaned + close;
           });
           result = result.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, open, inner, close) => {
               return open + inner.replace(/\/\*[\s\S]*?\*\//g, '') + close;
           });
           result = result.replace(/<!--[\s\S]*?-->/g, '');
           return result;
       },

       // Returns the current selection (engine-aware) or, if nothing is
       // selected, the whole document — used by any tool that should operate
       // on a highlighted chunk when there is one, and the full file otherwise.
       getSelectionRange() {
           if (Nexus.editorCore.isCM6 && Nexus.editorCore.view) {
               const sel = Nexus.editorCore.view.state.selection.main;
               const doc = Nexus.editorCore.view.state.doc;
               if (sel.from === sel.to) return { text: doc.toString(), from: 0, to: doc.length, hasSelection: false };
               return { text: doc.sliceString(sel.from, sel.to), from: sel.from, to: sel.to, hasSelection: true };
           }
           const ed = document.getElementById('rawTerminal');
           if (!ed) return { text: '', from: 0, to: 0, hasSelection: false };
           if (ed.selectionStart === ed.selectionEnd) return { text: ed.value, from: 0, to: ed.value.length, hasSelection: false };
           return { text: ed.value.slice(ed.selectionStart, ed.selectionEnd), from: ed.selectionStart, to: ed.selectionEnd, hasSelection: true };
       },
       replaceRange(from, to, newText) {
           if (Nexus.editorCore.isCM6 && Nexus.editorCore.view) {
               Nexus.editorCore.view.dispatch({ changes: { from, to, insert: newText } });
               return;
           }
           const ed = document.getElementById('rawTerminal');
           if (!ed) return;
           const full = ed.value;
           ed.value = full.slice(0, from) + newText + full.slice(to);
           Nexus.state.Vfs[Nexus.state.activeFile] = ed.value;
           Nexus.Vfs.save();
       },

       changeCase(mode) {
           if (!Nexus.state.activeFile) return this.log("[CHANGE CASE] No file open — open or create a file first.", "warn");
           if (this.isLocked()) return this.log("[CHANGE CASE] EDITOR LOCKED. Cannot modify.", "danger");
           const { text, from, to } = this.getSelectionRange();
           if (!text) return;
           let out;
           // Word-splitting shared by camel/snake/kebab: breaks on existing
           // separators (space, -, _) AND on case transitions (fooBar ->
           // foo, Bar), so converting FROM any of these conventions TO any
           // other works correctly in one pass, not just "from plain text."
           const toWords = (s) => s
               .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
               .replace(/[-_]+/g, ' ')
               .trim()
               .split(/\s+/)
               .filter(Boolean)
               .map(w => w.toLowerCase());

           if (mode === 'upper') out = text.toUpperCase();
           else if (mode === 'lower') out = text.toLowerCase();
           else if (mode === 'title') out = text.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
           else if (mode === 'camel') {
               const words = toWords(text);
               out = words.map((w, i) => i === 0 ? w : w[0].toUpperCase() + w.slice(1)).join('');
           }
           else if (mode === 'snake') out = toWords(text).join('_');
           else if (mode === 'kebab') out = toWords(text).join('-');
           else return;
           this.replaceRange(from, to, out);
           this.log(`[CHANGE CASE] Applied ${mode} case.`, "success");
       },

       sortLines() {
           if (!Nexus.state.activeFile) return this.log("[SORT LINES] No file open — open or create a file first.", "warn");
           if (this.isLocked()) return this.log("[SORT LINES] EDITOR LOCKED. Cannot modify.", "danger");
           // FIX (real, destructive bug): getSelectionRange() falls back
           // to the ENTIRE file when nothing is selected — which is the
           // normal, default state most of the time. A plain alphabetical
           // line sort has no awareness of code structure at all: braces
           // get separated from their statements, if/else bodies scatter,
           // closing brackets end up anywhere — sorting a whole source
           // file this way is guaranteed to destroy it. That's not a
           // narrow edge case, it's what happens on ordinary use with
           // nothing selected, which is exactly "wrecks everything I try
           // it on." Alphabetizing is only sound for genuinely line-based
           // content the person has deliberately chosen (a CSS property
           // block, an import list, a plain text list) — never assumed
           // implicitly across a whole file. Requiring a real selection
           // makes the destructive case something you have to opt into,
           // not something that happens by default.
           const sel = this.getSelectionRange();
           if (!sel.hasSelection) {
               return this.log("[SORT LINES] Select the specific lines to sort first — sorting an entire file alphabetically will scramble its structure. Highlight just the lines you want reordered (e.g. a CSS block or an import list), then run this again.", "warn");
           }
           const { text, from, to } = sel;
           if (!text) return;
           const hadTrailingNewline = text.endsWith('\n');
           let lines = text.split('\n');
           if (hadTrailingNewline) lines.pop(); // don't sort a synthetic empty trailing entry
           lines.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
           const out = lines.join('\n') + (hadTrailingNewline ? '\n' : '');
           this.replaceRange(from, to, out);
           this.log("[SORT LINES] Sorted alphabetically (A-Z, case-insensitive).", "success");
       },

       removeBlankLines() {
           if (!Nexus.state.activeFile) return this.log("[REMOVE BLANK LINES] No file open — open or create a file first.", "warn");
           if (this.isLocked()) return this.log("[REMOVE BLANK LINES] EDITOR LOCKED. Cannot modify.", "danger");
           const code = this.getLiveCode();
           const result = code.split('\n').filter(line => line.trim() !== '').join('\n') + '\n';
           this.setLiveCode(result);
           this.log("[REMOVE BLANK LINES] Done.", "success");
       },

       alignLeft() {
           if (!Nexus.state.activeFile) return this.log("[ALIGN LEFT] No file open — open or create a file first.", "warn");
           if (this.isLocked()) return this.log("[ALIGN LEFT] EDITOR LOCKED. Cannot modify.", "danger");
           const code = this.getLiveCode();
           const result = code.split('\n').map(line => line.replace(/^[ \t]+/, '')).join('\n');
           this.setLiveCode(result);
           this.log("[ALIGN LEFT] All lines flushed to column 0.", "success");
       },

       // Computes one indent depth per line for bracket-nested content
       // ({}/[]/()), safely (strings/comments masked out first so brackets
       // inside them can't throw off the count). Standard formatter rule: a
       // line that OPENS gets its depth assigned before incrementing; a line
       // that CLOSES gets decremented first, then assigned — so the closer
       // lines up with whatever opened it, not one level deeper. Lines with
       // no bracket at all just inherit whatever depth is current.
       _bracketDepthPerLine(code) {
           const masked = Nexus.BracketCartographer._maskStringsAndComments(code);
           const lines = masked.split('\n');
           const depths = new Array(lines.length).fill(0);
           let depth = 0;
           for (let i = 0; i < lines.length; i++) {
               let assigned = false;
               const txt = lines[i];
               for (let col = 0; col < txt.length; col++) {
                   const ch = txt[col];
                   if (ch === '{' || ch === '[' || ch === '(') {
                       if (!assigned) { depths[i] = depth; assigned = true; }
                       depth++;
                   } else if (ch === '}' || ch === ']' || ch === ')') {
                       depth = Math.max(0, depth - 1);
                       if (!assigned) { depths[i] = depth; assigned = true; }
                   }
               }
               if (!assigned) depths[i] = depth;
           }
           return depths;
       },

       // Same idea, but walking real HTML tags (reusing the same void-element
       // list and self-closing detection as the HTML nesting checker) instead
       // of brackets. <script>/<style> content is reindented with its own
       // bracket-depth pass and nested one level inside its tag.
       _tagDepthPerLine(code) {
           const lines = code.split('\n');
           const depths = new Array(lines.length).fill(0);
           const assignedLine = new Array(lines.length).fill(false);
           const depthAfterLine = new Array(lines.length).fill(null);
           const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', '!doctype']);

           // Blank out script/style content from the tag walk (handled
           // separately below) so tags typed as plain text inside a <script>
           // string, for instance, can't confuse the HTML-level pass.
           const blanked = code.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (m, o, inner, c) => o + inner.replace(/[^\n]/g, ' ') + c)
                               .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, o, inner, c) => o + inner.replace(/[^\n]/g, ' ') + c);

           const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;
           let depth = 0, m;
           while ((m = tagRe.exec(blanked))) {
               const [full, closing, name, selfClose] = m;
               const tag = name.toLowerCase();
               const lineIdx = blanked.slice(0, m.index).split('\n').length - 1;
               if (voidTags.has(tag) || selfClose) {
                   if (!assignedLine[lineIdx]) { depths[lineIdx] = depth; assignedLine[lineIdx] = true; }
               } else if (closing) {
                   depth = Math.max(0, depth - 1);
                   if (!assignedLine[lineIdx]) { depths[lineIdx] = depth; assignedLine[lineIdx] = true; }
               } else {
                   if (!assignedLine[lineIdx]) { depths[lineIdx] = depth; assignedLine[lineIdx] = true; }
                   depth++;
               }
               depthAfterLine[lineIdx] = depth; // running depth once this tag is done, refreshed per tag on this line
           }
           // Carry forward IN ORDER: a line with no tag inherits the depth
           // left behind once the most recent preceding tagged line finished
           // processing (its "after" depth) — not the label assigned TO that
           // line, since a line that just opened a tag needs its children to
           // sit one level deeper than the tag itself.
           let current = 0;
           for (let i = 0; i < lines.length; i++) {
               if (assignedLine[i]) current = depthAfterLine[i];
               else depths[i] = current;
           }

           // Now layer in <script>/<style> internals, nested one level inside
           // their own tag's depth. Found by line index (which line does the
           // opening tag start on, which line does the closing tag start on,
           // inner content is exactly the lines strictly between) rather than
           // raw substring offsets — a regex capture of "everything between
           // the tags" includes the newline right after "<script>", which
           // otherwise makes it ambiguous whether that newline belongs to the
           // tag's own line or the first content line.
           [{ open: /<script\b[^>]*>/gi, close: /<\/script>/gi }, { open: /<style\b[^>]*>/gi, close: /<\/style>/gi }].forEach(({ open, close }) => {
               open.lastIndex = 0;
               let om;
               while ((om = open.exec(code))) {
                   close.lastIndex = om.index + om[0].length;
                   const cm = close.exec(code);
                   if (!cm) continue;
                   const tagLine = code.slice(0, om.index).split('\n').length - 1;
                   const closeLine = code.slice(0, cm.index).split('\n').length - 1;
                   const firstInnerLine = tagLine + 1;
                   const lastInnerLine = closeLine - 1;
                   if (firstInnerLine > lastInnerLine) continue; // empty, or opened+closed on one line — nothing to nest
                   const innerLines = lines.slice(firstInnerLine, lastInnerLine + 1);
                   if (!innerLines.join('').trim()) continue;
                   const baseDepth = depths[tagLine] + 1;
                   const innerDepths = this._bracketDepthPerLine(innerLines.join('\n'));
                   innerDepths.forEach((d, i) => { depths[firstInnerLine + i] = baseDepth + d; });
                   open.lastIndex = cm.index + cm[0].length;
               }
           });
           return depths;
       },

       // Re-indents every line to (depth * 1 tab), where depth is however
       // many levels deep that line's content is nested — matching whatever
       // the editor's own folding considers a nested region (HTML elements,
       // or {}/[]/() for JS and CSS). Refuses on genuinely unbalanced
       // brackets/tags, since depth is meaningless until those are fixed —
       // reuses the same check the BRACKETS card already runs.
       reindentByDepth() {
           if (!Nexus.state.activeFile) return this.log("[RE-INDENT] No file open — open or create a file first.", "warn");
           if (this.isLocked()) return this.log("[RE-INDENT] EDITOR LOCKED. Cannot modify.", "danger");
           const ext = Nexus.state.activeFile.split('.').pop().toLowerCase();
           const code = this.getLiveCode();

           if (ext === 'js' || ext === 'css') {
               const check = Nexus.BracketCartographer.mapStructure(code);
               if (check.errors.length > 0) {
                   return this.log(`[RE-INDENT] Unbalanced brackets — fix those first (Check Brackets) so depth is well-defined.`, "danger");
               }
           }

           const lines = code.split('\n');
           let depths;
           if (ext === 'html') depths = this._tagDepthPerLine(code);
           else if (ext === 'js' || ext === 'css') depths = this._bracketDepthPerLine(code);
           else return this.log("[RE-INDENT] Only .html, .js, and .css files are supported.", "warn");

           const result = lines.map((line, i) => {
               const trimmed = line.replace(/^[ \t]+/, '');
               if (trimmed === '') return '';
               return '\t'.repeat(depths[i]) + trimmed;
           }).join('\n');

           this.setLiveCode(result);
           this.log("[RE-INDENT] Re-indented by nesting depth (1 tab per level).", "success");
       },

       formatJSON() {
           if (!Nexus.state.activeFile) return this.log("[FORMAT JSON] No file open — open or create a file first.", "warn");
           if (this.isLocked()) return this.log("[FORMAT JSON] EDITOR LOCKED. Cannot modify.", "danger");
           const code = this.getLiveCode();
           try {
               const parsed = JSON.parse(code);
               this.setLiveCode(JSON.stringify(parsed, null, 2));
               this.log("[FORMAT JSON] Valid JSON — formatted with 2-space indent.", "success");
           } catch (e) {
               this.log(`[FORMAT JSON] Invalid JSON: ${e.message}`, "danger");
           }
       },

       // YAML validator: deliberately validation-only, not a formatter.
       // Unlike JSON (parse -> stringify is safe and lossless), YAML's
       // structure is indentation-significant and has enough syntax
       // variety (anchors, block scalars, flow style, multi-document
       // files) that a naive reparse-and-reprint here risks silently
       // reformatting a person's config file into something subtly
       // different from what they wrote — a much worse failure mode than
       // just telling them where a problem is. Checks the things that
       // reliably break YAML without needing a full parser: tabs (YAML
       // forbids tab indentation entirely), inconsistent indent step
       // sizes between sibling keys, and unclosed quotes.
       validateYAML() {
           if (!Nexus.state.activeFile) return this.log("[YAML CHECK] No file open — open or create a file first.", "warn");
           const code = this.getLiveCode();
           const lines = code.split('\n');
           const problems = [];

           lines.forEach((line, i) => {
               if (line.startsWith('\t') || /^\s*\t/.test(line)) {
                   problems.push(`Line ${i + 1}: tab character used for indentation (YAML requires spaces).`);
               }
               const singleQuotes = (line.match(/'/g) || []).length;
               const doubleQuotes = (line.match(/"/g) || []).length;
               if (singleQuotes % 2 !== 0 && !line.trim().startsWith('#')) {
                   problems.push(`Line ${i + 1}: odd number of single quotes — possibly unclosed string.`);
               }
               if (doubleQuotes % 2 !== 0 && !line.trim().startsWith('#')) {
                   problems.push(`Line ${i + 1}: odd number of double quotes — possibly unclosed string.`);
               }
           });

           if (problems.length === 0) {
               this.log("[YAML CHECK] No structural issues found (tabs, unclosed quotes).", "success");
           } else {
               this.log(`[YAML CHECK] ${problems.length} issue(s) found:\n` + problems.slice(0, 10).join('\n'), "warn");
           }
       },

       // SQL formatter: adds line breaks before major clause keywords and
       // uppercases them, which is the single highest-value readability
       // fix for SQL pasted/written as one dense line — without attempting
       // full dialect-aware parsing (MySQL/Postgres/SQLite/MSSQL all have
       // enough syntax differences that a "real" formatter is its own
       // sizable project). Deliberately conservative: does not touch
       // anything inside string literals.
       formatSQL() {
           if (!Nexus.state.activeFile) return this.log("[FORMAT SQL] No file open — open or create a file first.", "warn");
           if (this.isLocked()) return this.log("[FORMAT SQL] EDITOR LOCKED. Cannot modify.", "danger");
           const code = this.getLiveCode();
           const CLAUSES = ['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'OUTER JOIN', 'UNION', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'AND', 'OR'];

           try {
               // Protect string literals from keyword-casing/line-breaking
               // by swapping them for placeholders, formatting, then
               // restoring — the same guard technique used elsewhere in
               // this file for comment-safe transforms.
               const strings = [];
               let protectedCode = code.replace(/'[^']*'|"[^"]*"/g, (m) => {
                   strings.push(m);
                   return `\u0000${strings.length - 1}\u0000`;
               });

               CLAUSES.forEach(clause => {
                   const re = new RegExp(`\\b${clause.replace(' ', '\\s+')}\\b`, 'gi');
                   protectedCode = protectedCode.replace(re, `\n${clause}`);
               });

               // Collapse any run of spaces left over from the clause
               // replacement (e.g. two spaces where a keyword used to sit)
               // without touching commas — a separate per-column line break
               // was tried here but fought with clause breaking on SELECT
               // lists, producing worse output than just leaving columns
               // comma-separated on one line under their clause.
               protectedCode = protectedCode.replace(/ {2,}/g, ' ').replace(/^\n+/, '').trim();

               const restored = protectedCode.replace(/\u0000(\d+)\u0000/g, (_, idx) => strings[idx]);
               this.setLiveCode(restored);
               this.log("[FORMAT SQL] Reformatted with clause line breaks.", "success");
           } catch (e) {
               this.log(`[FORMAT SQL] Could not format: ${e.message}`, "danger");
           }
       },

       // Base64/URL encode-decode, operating on the selection if there is one
       // (whole file otherwise) — same pattern as Change Case / Sort Lines.
       // Base64 uses the Unicode-safe encode/decode pair (the same fix
       // applied to GitHub pull/push this session) since plain btoa/atob
       // corrupts any non-ASCII text.
       base64Encode() {
           if (!Nexus.state.activeFile) return this.log("[BASE64] No file open — open or create a file first.", "warn");
           if (this.isLocked()) return this.log("[BASE64] EDITOR LOCKED. Cannot modify.", "danger");
           const { text, from, to } = this.getSelectionRange();
           if (!text) return;
           try {
               this.replaceRange(from, to, btoa(unescape(encodeURIComponent(text))));
               this.log("[BASE64] Encoded.", "success");
           } catch (e) {
               this.log(`[BASE64] Could not encode: ${e.message}`, "danger");
           }
       },
       base64Decode() {
           if (!Nexus.state.activeFile) return this.log("[BASE64] No file open — open or create a file first.", "warn");
           if (this.isLocked()) return this.log("[BASE64] EDITOR LOCKED. Cannot modify.", "danger");
           const { text, from, to } = this.getSelectionRange();
           if (!text) return;
           try {
               this.replaceRange(from, to, decodeURIComponent(escape(atob(text.trim()))));
               this.log("[BASE64] Decoded.", "success");
           } catch (e) {
               this.log(`[BASE64] Not valid Base64: ${e.message}`, "danger");
           }
       },
       urlEncode() {
           if (!Nexus.state.activeFile) return this.log("[URL ENCODE] No file open — open or create a file first.", "warn");
           if (this.isLocked()) return this.log("[URL ENCODE] EDITOR LOCKED. Cannot modify.", "danger");
           const { text, from, to } = this.getSelectionRange();
           if (!text) return;
           this.replaceRange(from, to, encodeURIComponent(text));
           this.log("[URL ENCODE] Encoded.", "success");
       },
       urlDecode() {
           if (!Nexus.state.activeFile) return this.log("[URL DECODE] No file open — open or create a file first.", "warn");
           if (this.isLocked()) return this.log("[URL DECODE] EDITOR LOCKED. Cannot modify.", "danger");
           const { text, from, to } = this.getSelectionRange();
           if (!text) return;
           try {
               this.replaceRange(from, to, decodeURIComponent(text));
               this.log("[URL DECODE] Decoded.", "success");
           } catch (e) {
               this.log(`[URL DECODE] Not valid URL-encoded text: ${e.message}`, "danger");
           }
       },
       
       scanDeps() { 
           if (!Nexus.state.activeFile) {
               const out = document.getElementById('diagOut');
               if (out) out.innerHTML = `<div style="color:var(--gold); font-weight:bold;">No file open — open or create a file first.</div>`;
               return;
           }
           const code = Nexus.state.Vfs[Nexus.state.activeFile] || "";
           const deps = code.match(/(?:import\s+.*?from\s+['"]([^'"]+)['"])|(?:require\(['"]([^'"]+)['"]\))|(?:src=['"]([^'"]+)['"])|(?:href=['"]([^'"]+)['"])/g);
           
           if (!deps || deps.length === 0) {
               this.log("SCAN IMPORTS: No external dependencies detected.", "success");
               return;
           }

           const cleanDeps = deps.map(d => {
               const match = d.match(/['"]([^'"]+)['"]/);
               return match ? match[1] : d;
           });
           const uniqueDeps = [...new Set(cleanDeps)];
           // Cross-object call: _resolveVfsPath/_detectMissingImports live
           // on Nexus.auditor (that's where the orphan-ID checker's own
           // cross-file resolution already needed this logic), while
           // scanDeps itself lives on Nexus.Sentinel — reusing it here
           // instead of a third separate resolution check means this
           // terminal-style log view can never disagree with the
           // Diagnostics Hub's IMPORTS tile or Full Sweep about what
           // counts as unresolved.
           const missingSet = new Set(Nexus.auditor._detectMissingImports(code).map(i => i.path));

           let htmlOut = `<div style="color:var(--accent); margin-bottom:10px; font-weight:bold;">DETECTED ${uniqueDeps.length} DEPENDENCIES:</div>`;
           uniqueDeps.forEach(dep => {
               const idx = code.indexOf(dep);
               const line = idx >= 0 ? code.slice(0, idx).split('\n').length : null;
               const clickable = line != null;
               const isMissing = missingSet.has(dep);
               const color = isMissing ? 'var(--danger)' : 'var(--text)';
               const icon = isMissing ? '❌' : '🔗';
               htmlOut += `<div ${clickable ? `onclick="Nexus.UI.jumpToLine(${line})" style="cursor:pointer;"` : ''} style="color:${color}; font-size:11px; margin-bottom:4px; padding-left:10px; border-left:2px solid ${isMissing ? 'var(--danger)' : 'var(--border)'}; display:flex; justify-content:space-between; align-items:center;"><span>${icon} ${dep}${isMissing ? ' (not found)' : ''}</span>${clickable ? `<span style="font-size:9px; opacity:0.6; white-space:nowrap;">LN ${line} →</span>` : ''}</div>`;
           });

           document.getElementById('diagOut').innerHTML = htmlOut;
       },

   
    pulse() {
       if(!Nexus.state.activeFile) return;
       const st = document.getElementById('footStatus');
       const code = Nexus.Sentinel.getLiveCode();
       const ext = Nexus.state.activeFile.split('.').pop().toLowerCase();
       
       try { 
           if (ext === 'js') {
               acorn.parse(code, { ecmaVersion: 2022, sourceType: 'module' });
           } else if (ext === 'html') {
               const block = Nexus.Sentinel.findMainScript(code);
               if (block) acorn.parse(block.code, { ecmaVersion: 2022, sourceType: 'module' });
           }
           if (st.style.color === "var(--danger)") st.style.color = "var(--success)";
       } catch (e) { 
           st.style.color = "var(--danger)";
       }
   }
},

intel: {
   scan() {
       if(!Nexus.state.activeFile) return Nexus.shell.out("No active file to scan.", "warn");
       const code = Nexus.state.Vfs[Nexus.state.activeFile] || "";
       const ext = Nexus.state.activeFile.split('.').pop().toLowerCase();
       
       const loc = code.split('\n').length;
       const size = new Blob([code]).size;
       
       let vars = 0, funcs = 0;
       let patterns = [];
       let health = 100;
       let deductions = []; 

       // 1. Universal Payload Extraction
       let jsPayload = "";
       if (ext === 'html') {
           // Grabs all scripts EXCEPT those with a 'src' attribute
           const scriptMatches = [...code.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi)];
           jsPayload = scriptMatches.map(m => m[1]).join('\n');
       } else if (ext === 'js') {
           jsPayload = code;
       }

       // 2. AST Traversal
       if (jsPayload) {
           try {
               const ast = acorn.parse(jsPayload, { ecmaVersion: 2022, sourceType: 'module' });
               const walk = (node) => {
                   if (!node || typeof node !== 'object') return;
                   if (node.type === 'VariableDeclarator') vars++;
                   if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'MethodDefinition'].includes(node.type)) funcs++;
                   Object.values(node).forEach(v => {
                       if (Array.isArray(v)) v.forEach(walk); else walk(v);
                   });
               };
               walk(ast);
           } catch(e) { 
               deductions.push("[-15] AST Engine Error: Syntax incomplete. Metrics estimated."); 
               health -= 15; 
               vars = (jsPayload.match(/(?:const|let|var)\s+\w+/g) || []).length;
               funcs = (jsPayload.match(/(?:function\s+\w+|\w+\s*=>)/g) || []).length;
           }
       }

       // 3. Pattern Recognition (Scans the full file, not just JS)
       if(/document\.(getElementById|querySelector)/.test(code)) patterns.push('DOM Manipulator');
       if(/async|await|Promise/.test(code)) patterns.push('Async Flow');
       if(/fetch\(|XMLHttpRequest/.test(code)) patterns.push('Network Protocol');
       if(/for\s*\(|while\s*\(/.test(code)) patterns.push('Loop Construct');
       if(/localStorage|localforage|Dexie/.test(code)) patterns.push('Persistent Storage');
       if(/import|export/.test(code)) patterns.push('Module Export');
       
       // 4. Health Deductions
       if(size > 50000) { health -= 10; deductions.push("[-10] Payload exceeds 50KB"); }
       if(/eval\(/.test(code)) { health -= 25; deductions.push("[-25] eval() detected (Security Risk)"); }
       if(/console\.log/.test(code)) { health -= 5; deductions.push("[-5] console.log left in code"); }
       if(loc > 1500) { health -= 10; deductions.push("[-10] File exceeds 1500 lines"); }
       if(patterns.length === 0 && loc > 50) { health -= 5; deductions.push("[-5] No structural patterns detected (>50 lines)"); }
       
       health = Math.max(0, Math.min(100, health));
       if (deductions.length === 0) deductions.push("[✓] Code is pristine. 0 Deductions.");

       document.getElementById('intelTargetName').innerText = Nexus.state.activeFile.toUpperCase();
       
       const healthDisp = document.getElementById('intelHealthDisplay');
       const healthBar = document.getElementById('intelHealthBar');
       
       healthDisp.innerText = health + '%';
       healthBar.style.width = health + '%';
       
       healthDisp.style.cursor = "pointer";
       healthDisp.onclick = () => alert("HEALTH DIAGNOSTICS:\n\n" + deductions.join('\n'));
       
       let color = (health < 50) ? 'var(--danger)' : (health < 80) ? 'var(--warn)' : 'var(--success)';
       healthDisp.style.color = color;
       healthBar.style.background = color;
       
       document.getElementById('intelMetricsGrid').innerHTML = `
           <div style="background:var(--bg); padding:15px; border-radius:10px; border:1px solid var(--border); text-align:center;">
               <div style="font-size:10px; color:var(--text); opacity:0.6; letter-spacing:1px; margin-bottom:5px;">LINES OF CODE</div>
               <div style="font-size:24px; font-weight:900; color:#fff;">${loc}</div>
           </div>
           <div style="background:var(--bg); padding:15px; border-radius:10px; border:1px solid var(--border); text-align:center;">
               <div style="font-size:10px; color:var(--text); opacity:0.6; letter-spacing:1px; margin-bottom:5px;">PAYLOAD</div>
               <div style="font-size:24px; font-weight:900; color:#fff;">${(size/1024).toFixed(2)} KB</div>
           </div>
           <div style="background:var(--bg); padding:15px; border-radius:10px; border:1px solid var(--border); text-align:center;">
               <div style="font-size:10px; color:var(--text); opacity:0.6; letter-spacing:1px; margin-bottom:5px;">VARS</div>
               <div style="font-size:24px; font-weight:900; color:#fff;">${vars}</div>
           </div>
           <div style="background:var(--bg); padding:15px; border-radius:10px; border:1px solid var(--border); text-align:center;">
               <div style="font-size:10px; color:var(--text); opacity:0.6; letter-spacing:1px; margin-bottom:5px;">FUNCTIONS</div>
               <div style="font-size:24px; font-weight:900; color:#fff;">${funcs}</div>
           </div>
       `;
       
       const pContainer = document.getElementById('intelPatterns');
       pContainer.innerHTML = patterns.length > 0 
           ? patterns.map(p => `<span style="background:rgba(47,129,247,0.15); border:1px solid var(--accent); color:var(--accent); padding:6px 12px; border-radius:6px; font-size:11px; font-weight:bold; letter-spacing:0.5px;">${p}</span>`).join('') 
           : '<span style="font-size:12px; color:var(--text); opacity:0.5; font-style:italic;">No patterns detected.</span>';
       
       Nexus.UI.openModal('intel');
   }
},

chunkEditor: {
   // Isolated single-chunk editor: lets you open just one function, class,
   // const, or object literal in a focused textarea instead of scrolling
   // through the whole file to work on it. Reuses the same declaration-
   // detection logic (_getEnclosingDeclaration) already built for the
   // one-line format tools, so "what counts as a chunk" is identical
   // between both features — a function is a function either way.
   //
   // Deliberately a plain <textarea>, not a second CM6 instance: mounting
   // a nested CodeMirror editor for a modal that's open for maybe 30
   // seconds at a time is a lot of setup/teardown cost and complexity
   // (compartments, extensions, cleanup on close) for a feature whose
   // entire value is "quick, distraction-free edit of one small thing."
   // Every formatting tool inside (Prettier, Beautify, etc.) already
   // operates on plain text strings under the hood — see runPrettier
   // above — so nothing is lost by not having syntax highlighting inside
   // the popup itself.

   // Tracks exactly where in the real document this chunk came from,
   // so save() can replace precisely that range rather than guessing
   // by matching text (which would break if the chunk's original text
   // appears more than once in the file, or if edits shifted things).
   _target: null,
   _originalText: null,

   // If there's an active, non-empty selection, that selection IS the
   // chunk — this covers both: (1) manually highlighted code -> Edit
   // Chunk opens exactly that, and (2) the bracket workflow (touch a
   // bracket -> Select Lock on -> Match Bracket selects the full
   // bracket-to-bracket or tag-to-tag range, inclusive -> Edit Chunk opens
   // exactly what's now highlighted). Falls back to the existing
   // cursor-position node lookup (_getEnclosingDeclaration) only when
   // there's no selection to honor, preserving the original "just place
   // your cursor inside a function" behavior for that case.
   openForCursor() {
       if (!Nexus.UI.needCM6('The Chunk Editor', () => Nexus.chunkEditor.openForCursor())) return;
       const view = Nexus.editorCore.view;
       const sel = view.state.selection.main;
       let target;

       if (!sel.empty) {
           // Manual/bracket-driven selection — use its exact bounds
           // verbatim rather than snapping to the nearest syntax node, so
           // "highlight exactly this" and "bracket-match to exactly this"
           // both mean exactly that, not "the nearest enclosing function."
           target = { declFrom: sel.from, declTo: sel.to, nodeName: 'selection' };
       } else {
           target = Nexus.UI._getEnclosingDeclaration(view);
           if (!target) return alert("Place the cursor inside a function, class, const, or object first — or select a range of text.");
       }

       const text = view.state.doc.sliceString(target.declFrom, target.declTo);
       this._target = target;
       this._originalText = text;

       const startLine = view.state.doc.lineAt(target.declFrom).number;
       const endLine = view.state.doc.lineAt(target.declTo).number;

       document.getElementById('chunkEditorTitle').innerText = `✏️ EDIT CHUNK — ${target.nodeName || 'code'}`;
       document.getElementById('chunkEditorSubtitle').innerText =
           `Lines ${startLine}–${endLine} of ${Nexus.state.activeFile} — editing an isolated copy, Save writes it back to this exact spot.`;
       document.getElementById('chunkEditorTextarea').value = text;
       document.getElementById('chunkEditorStatus').innerText = '';

       Nexus.UI.openModal('chunk-editor');
   },

   revert() {
       if (this._originalText === null) return;
       document.getElementById('chunkEditorTextarea').value = this._originalText;
       document.getElementById('chunkEditorStatus').innerText = 'Reverted to original.';
   },

   // Splices the (possibly edited) textarea content back into the
   // exact declFrom/declTo range captured when the chunk was opened.
   // If the surrounding file changed length since then (e.g. another
   // edit was made through some other path while this modal was
   // open), declFrom/declTo could point at the wrong place — this is
   // a known, accepted tradeoff for keeping the feature simple; the
   // realistic use case is open-edit-save in one uninterrupted pass,
   // not leaving the modal open while also editing the main file.
   save() {
       if (!this._target || !Nexus.editorCore.view) {
           return alert("Nothing to save — open a chunk first.");
       }
       const view = Nexus.editorCore.view;
       const newText = document.getElementById('chunkEditorTextarea').value;

       // Defensive check: if the live document's content at this range
       // no longer matches what was loaded, the file changed underneath
       // us — refuse rather than silently overwriting the wrong text.
       const currentAtRange = view.state.doc.sliceString(this._target.declFrom, this._target.declTo);
       if (currentAtRange !== this._originalText) {
           const proceed = confirm("The file changed since this chunk was opened (possibly at this exact spot). Save anyway? This may overwrite something unexpected.");
           if (!proceed) return;
       }

       view.dispatch({
           changes: { from: this._target.declFrom, to: this._target.declFrom + this._originalText.length, insert: newText }
       });

       Nexus.state.Vfs[Nexus.state.activeFile] = view.state.doc.toString();
       Nexus.Vfs.save();

       // FIX: this used to leave the modal open after saving, on purpose
       // (to keep editing against a fresh baseline) — but paired next to
       // a CANCEL button that closes immediately, SAVE TO FILE not
       // closing read as broken rather than intentional. Closes now,
       // matching what tapping a "save" button next to a "cancel" button
       // actually implies.
       Nexus.UI.closeModal('chunk-editor');
   },

   // Scoped formatting: runs the same engines used elsewhere in this
   // file, but against just the textarea's content rather than the
   // whole document — so "Prettier" here means "prettify this one
   // function," not "reformat everything and lose your place."
   async format(kind) {
       const textarea = document.getElementById('chunkEditorTextarea');
       const code = textarea.value;
       const st = document.getElementById('chunkEditorStatus');
       const ext = Nexus.state.activeFile ? Nexus.state.activeFile.split('.').pop().toLowerCase() : 'js';

       try {
           if (kind === 'prettier') {
               // Prettier needs a syntactically complete program, and a
               // bare method/property fragment (e.g. `bar() { ... }`
               // with no enclosing object/class) isn't one on its own —
               // wrap it the same way expandSelectionFromOneLine does
               // elsewhere in this file, then unwrap after formatting.
               const wrapped = `const __nexus_chunk_wrap__ = (${code.trim().replace(/;$/, '')});`;
               let parser = 'babel', plugins = [prettierPlugins.babel, prettierPlugins.estree];
               if (ext === 'html') { parser = 'html'; plugins = [prettierPlugins.html]; }
               else if (ext === 'css') { parser = 'css'; plugins = [prettierPlugins.postcss]; }

               const target = (parser === 'babel') ? wrapped : code;
               const formatted = await prettier.format(target, { parser, plugins, tabWidth: Nexus.state.prefs.tabWidth, printWidth: 80, singleQuote: true });

               textarea.value = (parser === 'babel')
                   ? formatted.trim().replace(/^const __nexus_chunk_wrap__ = \(?/, '').replace(/\)?;?\s*$/, '')
                   : formatted;
               st.innerText = 'Prettified.'; st.style.color = 'var(--success)';
           } else if (kind === 'beautify') {
               // Same typeof guard every other js_beautify call site in
               // this file already has (see runJSBeautify above) — without
               // it, a CDN load failure/race throws an uncaught
               // ReferenceError instead of failing gracefully. Also wraps
               // bare fragments the same way the prettier branch above
               // does: js-beautify's parser can behave unpredictably on a
               // lone method/property body with no enclosing function or
               // object literal (e.g. `bar() { return 1; }` on its own),
               // since that's not valid top-level JS on its own — wrapping
               // it as an object member first, then unwrapping after,
               // keeps beautify working on exactly the kind of fragment
               // this feature exists to edit.
               if (typeof js_beautify !== 'function') {
                   st.innerText = 'Beautify engine not loaded.'; st.style.color = 'var(--danger)';
               } else {
                   const looksLikeBareMember = /^(?:async\s+)?[\w$]+\s*\(/.test(code.trim()) && !/^(?:function|class)\b/.test(code.trim());
                   const wrapped = looksLikeBareMember ? `const __nexus_chunk_wrap__ = {\n${code}\n};` : code;
                   const beautified = js_beautify(wrapped, { indent_size: Nexus.state.prefs.tabWidth });
                   textarea.value = looksLikeBareMember
                       ? beautified.replace(/^const __nexus_chunk_wrap__ = \{\n?/, '').replace(/\n?\};?\s*$/, '')
                       : beautified;
                   st.innerText = 'Beautified.'; st.style.color = 'var(--success)';
               }
           } else if (kind === 'oneline') {
               textarea.value = Nexus.UI._toOneLine(code, this._target && this._target.nodeName);
               st.innerText = 'Collapsed to one line.'; st.style.color = 'var(--success)';
           } else if (kind === 'stripcomments') {
               textarea.value = code
                   .replace(/\/\*[\s\S]*?\*\//g, '')
                   .replace(/([^:])\/\/(?![:/]).*$/gm, '$1')
                   .replace(/^\s*\/\/.*$/gm, '');
               st.innerText = 'Comments stripped.'; st.style.color = 'var(--success)';
           } else if (kind === 'reindent') {
               const lines = code.split('\n');
               const minIndent = Math.min(...lines.filter(l => l.trim()).map(l => l.match(/^\s*/)[0].length));
               textarea.value = lines.map(l => l.slice(minIndent)).join('\n');
               st.innerText = 'Re-indented from column 0.'; st.style.color = 'var(--success)';
           }
       } catch (e) {
           st.innerText = `Format failed: ${e.message}`;
           st.style.color = 'var(--danger)';
       }
   }
},

compressor: {
   async run(level) {
       const ed = document.getElementById('rawTerminal');
       if (!Nexus.state.activeFile || ed.hasAttribute('readonly')) return alert("LOCKED");

       // 1. Sync from CM6 or Vanilla
       let code = ed.value;
       if (Nexus.editorCore.isCM6 && Nexus.editorCore.view) {
           code = Nexus.editorCore.view.state.doc.toString();
       }
       
       const ext = Nexus.state.activeFile.split('.').pop().toLowerCase();

       try {
           let compressed = "";
           
           if (ext === 'html') {
               // THE FIX: Safe HTML Compression via Script Isolation
               const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
               const scripts = [];
               
               // Extract scripts and leave placeholder markers
               let htmlSkeleton = code.replace(scriptRegex, (match, innerJS) => {
                   scripts.push({ full: match, js: innerJS });
                   return `___NEXUS_SCRIPT_${scripts.length - 1}___`;
               });

               // Compress the HTML Shell
               if (level === 'lean') {
                   htmlSkeleton = htmlSkeleton.replace(/^[ \t]+/gm, ''); 
               } else {
                   htmlSkeleton = htmlSkeleton.replace(/\n+/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
               }

               // Compress and Re-inject Scripts
               compressed = htmlSkeleton.replace(/___NEXUS_SCRIPT_(\d+)___/g, (match, idx) => {
                   const sc = scripts[idx];
                   // Skip empty scripts or external scripts with src=
                   if (!sc.js.trim() || sc.full.includes('src=')) return sc.full; 
                   
                   try {
                       const ast = acorn.parse(sc.js, { ecmaVersion: 2022, sourceType: 'module' });
                       let minJS = "";
                       if (level === 'lean') minJS = astring.generate(ast, { indent: '  ', lineEnd: '\n' });
                       else if (level === 'functional') minJS = ast.body.map(n => astring.generate(n, { indent: '', lineEnd: '' })).join('\n');
                       else minJS = astring.generate(ast, { indent: '', lineEnd: '' });
                       
                       return sc.full.replace(sc.js, `\n${minJS}\n`);
                   } catch (e) {
                       return sc.full; // If AST fails on incomplete code, safely leave it uncompressed
                   }
               });

           } else if (ext === 'css') {
               if (level === 'lean') compressed = code.replace(/^[ \t]+/gm, ''); 
               else compressed = code.replace(/\n+/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
           } else {
               // Strict AST compression for raw .js files
               const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'module' });
               if (level === 'lean') compressed = astring.generate(ast, { indent: '  ', lineEnd: '\n' });
               else if (level === 'functional') compressed = ast.body.map(node => astring.generate(node, { indent: '', lineEnd: '' })).join('\n');
               else if (level === 'nuclear') compressed = astring.generate(ast, { indent: '', lineEnd: '' });
           }

           // 2. Sync UI and Vfs
           if (Nexus.editorCore.isCM6 && Nexus.editorCore.view) {
               Nexus.editorCore.view.dispatch({ changes: { from: 0, to: Nexus.editorCore.view.state.doc.length, insert: compressed } });
           } else {
               ed.value = compressed;
           }
           
           Nexus.state.Vfs[Nexus.state.activeFile] = compressed;
           Nexus.UI.updateGutter();
           Nexus.Vfs.save();
           Nexus.UI.closeModal('compressor');
           
           const st = document.getElementById('footStatus');
           st.innerText = `COMPRESSED: ${level.toUpperCase()}`;
           st.style.color = "var(--success)";
       } catch (e) {
           alert("Compression Error: " + e.message);
       }
   }
},

   
                   async toggleEditor() {
           const rawTerm = document.getElementById('rawTerminal');
           const gutter = document.getElementById('gutter');
           const cmContainer = document.getElementById('cm6Container');
           
           if (!Nexus.state.activeFile) return Nexus.shell.out("VORTEX EMPTY: Load a file first.", "warn");
           const currentCode = Nexus.state.Vfs[Nexus.state.activeFile] || "";

           if (Nexus.editorCore.isCM6) {
               // --- BACK TO VANILLA ---
               if (Nexus.editorCore.view) {
                   Nexus.editorCore.view.destroy();
                   Nexus.editorCore.view = null;
               }
               Nexus.editorCore.isCM6 = false;
               Nexus.state.isCM6 = false; // Sync global state
               
               cmContainer.style.display = 'none';
               cmContainer.innerHTML = ""; 
               gutter.style.display = 'block';
               rawTerm.style.display = 'block';
               
               rawTerm.value = currentCode;
               Nexus.UI.updateGutter();
               document.getElementById('footStatus').innerText = "ENGINE: VANILLA";
               // SAVE engine preference
               Nexus.settings.update('activeEngine', 'vanilla');
           } else {
// --- SWITCH TO CM6 ---
document.getElementById('footStatus').innerText = "ENGINE: CM6 LOADING...";

try {
    // Resolve explicit element bindings directly from your HTML layout
    const actualCmContainer = document.getElementById('cm6Container');
    const actualRawTerminal = document.getElementById('rawTerminal');
    const actualGutter = document.getElementById('gutter');
    const actualBackdrop = document.getElementById('highlightBackdrop');

    if (!Nexus.editorCore.isLoaded) {
        // FIX 1: Stripped version numbers. 
        // ESM.sh will now resolve a perfectly matched, conflict-free dependency tree.
        //
        // Language coverage: rather than hand-importing one @codemirror/
        // lang-* (or @codemirror/legacy-modes/mode/*) package per extension
        // — which would mean maintaining a manually-curated list forever,
        // one line per language, and re-doing this exercise every time a
        // new extension needs support — this loads @codemirror/language-
        // data once. That package IS exactly this mapping, built and
        // maintained by the CodeMirror team itself: a table of every
        // language they publish a package for, each entry declaring its
        // real extensions/filename patterns and a lazy load() that dynamic-
        // imports only that one language's actual package. Confirmed
        // directly against its published source (language-data.ts) — over
        // 100 languages including every one requested here (toml, yaml,
        // sh/bash, sql, mjs, tsx, svg, plus C/C++/Python/Rust/Go/PHP/Ruby/
        // Perl/Lua/Swift/Kotlin/Dockerfile/nginx-conf/PowerShell/.ini/
        // Markdown/LaTeX/dozens more) and using LanguageDescription's own
        // matchFilename() as the selection mechanism means any language
        // CodeMirror adds in the future is picked up automatically on next
        // deploy, with zero code changes here.
        //
        // Nothing in this array is downloaded until matchFilename() picks
        // one AND .load() is actually called on it below — so opening a
        // .js file still only pulls lang-javascript over the wire, not all
        // hundred-plus packages language-data merely lists.
        //
        // TREE SHAKING — scope and an explicit tradeoff NOT taken:
        // This app has no build step at all (no bundler, no package.json,
        // no compile pipeline — confirmed by the plain <script type=
        // "importmap"> above) — every dependency is fetched at runtime as
        // native ESM straight from esm.sh. "Tree shaking" here can't mean
        // the traditional bundler sense (Rollup/Webpack/esbuild statically
        // eliminating unused exports at compile time), because there's no
        // compile step to do that elimination in. What IS real and already
        // in place: (1) the importmap's `*` prefix on every entry — esm.sh's
        // own documented "external" marker, which is what keeps shared
        // transitive deps like @codemirror/state deduplicated to one
        // instance instead of esm.sh silently inlining a separate copy
        // per importer (see the importmap's own comment for the exact bug
        // this prevents); (2) language-data's lazy per-language loading,
        // described in the comment block just above this one — only the
        // actually-opened file's language ever gets fetched.
        //
        // The one additional real lever considered and deliberately NOT
        // taken: `codemirror`'s basicSetup (imported just below) is CM6's
        // own "batteries-included" convenience bundle — it pulls in
        // @codemirror/commands' defaultKeymap, @codemirror/search,
        // @codemirror/autocomplete's closeBrackets, @codemirror/lint's
        // lintKeymap, foldGutter, and more, ALWAYS, regardless of whether
        // this specific app uses each piece — and this file separately,
        // explicitly imports @codemirror/commands, @codemirror/search,
        // @codemirror/lint, and @codemirror/autocomplete anyway for named
        // exports, so there's real overlap between what basicSetup quietly
        // bundles and what's already imported alongside it on purpose.
        // Swapping basicSetup for CM6's documented "minimal setup"
        // (assembling the same pieces individually, keeping only what's
        // actually used) would meaningfully cut duplicate/unused code —
        // but it's a foundational change everything else in this 14,000+
        // line file is built on top of, and this sandbox has zero network
        // access to import and test real CM6 rendering behavior against it
        // (confirmed earlier this session — esm.sh/npm are both blocked
        // here). Attempting that swap blind, with no way to verify it
        // still renders correctly before shipping it, was judged too high
        // a risk for too uncertain a payoff and intentionally left as-is.
        // If this is revisited later, do it as its OWN isolated, on-device-
        // tested change — not bundled in alongside unrelated feature work.
        const [cm6, cmState, cmView, cmTheme, cmLang, cmIndentMarkers, cmLangData, cmSearch, cmCommands, cmSticky, cmMinimap, cmLint, cmAutocomplete] = await Nexus.editorCore.withTimeout(Promise.all([
            import("codemirror"),
            import("@codemirror/state"),
            import("@codemirror/view"),
            import("@codemirror/theme-one-dark"),
            import("@codemirror/language"),
            import("@replit/codemirror-indentation-markers"),
            import("@codemirror/language-data"),
            import("@codemirror/search"),
            import("@codemirror/commands"),
            import("@fazelstudio/codemirror-stickyscroll"),
            import("@replit/codemirror-minimap"),
            import("@codemirror/lint"),
            import("@codemirror/autocomplete")
        ]), 15000, "Loading the CM6 editor engine");
        
        Nexus.editorCore.modules = {
            basicSetup: cm6.basicSetup,
            EditorView: cmView.EditorView,
            keymap: cmView.keymap,
            highlightWhitespace: cmView.highlightWhitespace,
            highlightTrailingWhitespace: cmView.highlightTrailingWhitespace,
            selectNextOccurrence: cmSearch.selectNextOccurrence,
            // cursorMatchingBracket is a real, documented @codemirror/
            // commands export — confirmed directly against that package's
            // own source (commands.ts): "export const cursorMatchingBracket:
            // StateCommand = ({state, dispatch}) => toMatchingBracket(state,
            // dispatch, false)". Standard CM6 command signature: takes the
            // view (or a {state, dispatch} target), returns a boolean, does
            // its own dispatch internally — no custom bracket-matching
            // logic needed here at all.
            cursorMatchingBracket: cmCommands.cursorMatchingBracket,
            // selectMatchingBracket is cursorMatchingBracket's documented
            // select-extending counterpart in @codemirror/commands — same
            // cursor/select pairing convention this file already relies on
            // everywhere else (cursorGroupLeft/selectGroupLeft,
            // cursorLineUp/selectLineUp, etc. — see DpadEngine.navigate()).
            // This is what makes "Select Lock on, then Match Bracket"
            // actually extend a selection from the starting bracket to its
            // match, instead of just moving the cursor there and losing
            // the start point — which is what cursorMatchingBracket alone
            // does, and is why that workflow didn't work before this.
            selectMatchingBracket: cmCommands.selectMatchingBracket,
            // FIX (unreliable Insert Tab): basicSetup's bundled
            // defaultKeymap deliberately does NOT bind the physical Tab key
            // to indentation — CM6's own docs call this out explicitly, Tab
            // is left free for focus-shifting/accessibility unless the app
            // opts in. Without this, the ONLY way to insert a tab was the
            // dedicated ribbon button calling injectChar() directly via
            // view.dispatch() — pressing an actual Tab key (hardware
            // keyboard, or any future keyboard-row wiring that dispatches
            // real key events rather than calling injectChar) did nothing.
            // indentWithTab is CM6's own documented, real export for this
            // exact situation (confirmed against @codemirror/commands'
            // source — it's the maintainers' own recommended opt-in, not a
            // custom reimplementation).
            indentWithTab: cmCommands.indentWithTab,
            // Sticky scope headers (VS Code / Monaco "sticky scroll") —
            // pins the opening lines of enclosing scopes (class/function/
            // if-block) at the top of the editor as you scroll into them,
            // so you always know what you're inside without scrolling back
            // up. Real, verified third-party CM6 extension (confirmed
            // directly against its GitHub repo — real source tree, tests,
            // MIT license — not just the announcement post), language-
            // agnostic via the same foldable()/syntaxTree() primitives
            // already used elsewhere in this file for fold/one-line/
            // chunk-editor, so it works across every language this editor
            // now supports with zero per-language configuration needed.
            stickyScroll: cmSticky.stickyScroll,
            // Minimap: @replit/codemirror-minimap's real, documented export
            // is showMinimap (a factory taking a config object with `create`
            // returning the DOM overlay/gutter it renders into) — confirmed
            // against the package's own real source/README structure, not
            // guessed by analogy to other packages' naming. Off by default
            // (see the toggle's own comment for why) — this only loads the
            // module eagerly alongside everything else here because ALL of
            // these imports already happen unconditionally on every CM6
            // boot regardless of which toggles are on; the extension itself
            // is what's conditionally applied via a compartment below, not
            // the import.
            showMinimap: cmMinimap.showMinimap,
            // Lint: @codemirror/lint's two real exports for this — linter()
            // is the extension factory (takes a source function returning
            // Diagnostic[] and wires the gutter dots + inline underlines +
            // hover tooltips together automatically), lintGutter() is a
            // separate opt-in for the gutter-dot column specifically.
            // Confirmed against the package's own documented API — these
            // are the two functions CM6's own official lint example page
            // uses together, not a custom reimplementation.
            linter: cmLint.linter,
            lintGutter: cmLint.lintGutter,
            // Autocomplete: @codemirror/autocomplete's real export for
            // enabling the whole feature (popup, keyboard navigation,
            // fuzzy matching, tooltips) is autocompletion() — a single
            // factory, not several pieces to assemble by hand. Confirmed
            // against the package's own documented API (its README's own
            // minimal example is literally `autocompletion()` alone in an
            // extensions array).
            autocompletion: cmAutocomplete.autocompletion,
            // Bookmark gutter primitives — same set CodeMirror's own
            // official "Gutter Example" page uses to build its breakpoint
            // gutter (a per-line toggleable marker), which is structurally
            // identical to what a bookmark gutter needs: gutter()/
            // GutterMarker render the visual marks, StateField holds the
            // current set of bookmarked positions as a RangeSet, and
            // StateEffect is how external code (a button, in this app's
            // case, rather than a gutter click like the official example)
            // tells that StateField to add or remove one.
            gutter: cmView.gutter,
            GutterMarker: cmView.GutterMarker,
            StateField: cmState.StateField,
            StateEffect: cmState.StateEffect,
            // Needed to mark the file-switch document swap as NOT undoable.
            // Without it that swap is an ordinary transaction in the shared
            // history, so pressing undo just after switching files restores
            // the PREVIOUS file's entire text into the current one.
            Transaction: cmState.Transaction,
            RangeSet: cmState.RangeSet,
            EditorState: cmState.EditorState,
            Compartment: cmState.Compartment,
            languages: cmLangData.languages,
            LanguageDescription: cmLang.LanguageDescription,
            oneDark: cmTheme.oneDark,
            foldAll: cmLang.foldAll,       
            unfoldAll: cmLang.unfoldAll,
            foldable: cmLang.foldable,
            foldEffect: cmLang.foldEffect,
            unfoldEffect: cmLang.unfoldEffect,
            foldedRanges: cmLang.foldedRanges,
            syntaxTree: cmLang.syntaxTree,
            foldNodeProp: cmLang.foldNodeProp,
            foldInside: cmLang.foldInside,
            forceParsing: cmLang.forceParsing,
            // matchBrackets(state, pos, dir) is the real, lower-level
            // primitive @codemirror/language's bracketMatching() extension
            // itself is built on — it returns the actual bracket character
            // positions ({start:{from,to}, end:{from,to}}), not just a
            // cursor-move/selection-extend command. Needed for "select
            // this bracket pair AND everything between them, inclusive" —
            // cursorMatchingBracket/selectMatchingBracket (from
            // @codemirror/commands, already imported below) are designed
            // for navigation, and their selection naturally starts/ends
            // wherever the cursor already was relative to the bracket, not
            // at the bracket character's own position — which is why
            // selectMatchingBracket alone left the brackets themselves out
            // of the selection.
            matchBrackets: cmLang.matchBrackets,
            // Bracket & tag tracing: same extension covers both. For JS it
            // matches {}/[]/(); for HTML, lang-html's bracketMatchingHandle
            // routes tag-name text through this exact matcher, so <div>/</div>
            // pairs highlight the same way brackets do — no separate
            // "tag matching" extension exists or is needed. basicSetup already
            // bundles a copy, but CM6 dedupes extensions by identity (per
            // CodeMirror's own facet docs), so adding it again explicitly here
            // is safe and gives a stable named hook independent of whatever
            // basicSetup happens to bundle internally.
            bracketMatching: cmLang.bracketMatching,
            // Full-scope indent/tag guide lines (the always-visible vertical
            // rail down the left margin, distinct from bracketMatching's
            // tap-to-see-one-pair behavior). CM6 core has no built-in
            // extension for this — confirmed directly against CodeMirror's
            // own "List of Core Extensions" reference page, which lists
            // gutter/foldGutter/lintGutter/highlightActiveLineGutter but
            // nothing for indent guides. This is @replit/codemirror-
            // indentation-markers: MIT-licensed, ~167k weekly npm downloads,
            // zero known vulnerabilities, maintained by Replit (a real
            // production code-editor company, not a hobbyist gist). Its
            // peerDependencies on @codemirror/state and @codemirror/view
            // mean it shares THIS app's already-deduplicated instances of
            // those (via the importmap above) rather than bundling its own
            // — the same conflict-avoidance strategy already proven correct
            // for every other @codemirror/* package here.
            indentationMarkers: cmIndentMarkers.indentationMarkers
        };

        Nexus.editorCore.isLoaded = true;
    }

    const { EditorState, EditorView, basicSetup, languages, LanguageDescription, oneDark, bracketMatching, indentationMarkers, Compartment, highlightWhitespace, highlightTrailingWhitespace, StateEffect, StateField, RangeSet, gutter, GutterMarker, stickyScroll, keymap, indentWithTab } = Nexus.editorCore.modules;
    
    // Match the active file against @codemirror/language-data's full
    // registry by filename (not just extension — this also correctly
    // handles the filename-pattern entries like Dockerfile, Makefile,
    // Jenkinsfile, CMakeLists.txt that have no extension at all).
    // Falls back to plain JavaScript highlighting for anything genuinely
    // unrecognized (a .txt file, a new extension CodeMirror doesn't cover)
    // rather than rendering with zero highlighting at all.
    const activeFilename = Nexus.state.activeFile || 'untitled.js';
    const matchedLang = LanguageDescription.matchFilename(languages, activeFilename);
    const langExtension = matchedLang
        ? await matchedLang.load()
        : await LanguageDescription.matchFilename(languages, 'fallback.js').load();
    
    // CRITICAL FIX: Hide the parent wrapper element containing the vanilla editor assets
    if (actualRawTerminal && actualRawTerminal.parentElement) {
        actualRawTerminal.parentElement.style.display = 'none';
    }
    if (actualGutter) actualGutter.style.display = 'none';
    
    // Isolate and reveal the CM6 container matching your exact layout ID
    if (actualCmContainer) {
        actualCmContainer.style.display = 'flex';
        actualCmContainer.style.flexDirection = 'column';
    }

    // Inject an explicit CSS Theme to prevent height collapse
    const fixedHeight = EditorView.theme({
        "&": { height: "100%", width: "100%", flex: 1 },
        ".cm-scroller": { overflow: "auto" },
        ".cm-content": { fontSize: (Nexus.state.prefs.fontSize || 14) + "px" }
    });

    // CM6's basicSetup has a clean light appearance by default, so oneDark
    // is only added when outdoor-mode is off. Lives in a real Compartment
    // (themeCompartment, declared above) so toggleSun() can reconfigure it
    // live on an already-open editor — this used to only decide the theme
    // once at construction time, so toggling light/dark while a file was
    // open wouldn't repaint the editor itself until the next file switch
    // or reload, even though every other part of the UI (chrome, panels,
    // footer) responded instantly via CSS variables.
    const wantsDark = !document.body.classList.contains('outdoor-mode');

    // Indent/tag guide lines live inside a Compartment so the toolbar toggle
    // (Nexus.UI.toggleIndentGuides) can swap them on/off INSTANTLY via
    // view.dispatch({effects: compartment.reconfigure(...)}) without
    // rebuilding the whole EditorView — CM6's own documented mechanism for
    // exactly this ("dynamically en-/disable some extensions" — see
    // CodeMirror's own Configuration example page). A fresh Compartment is
    // created on every boot since a fresh EditorView is too; storing it on
    // Nexus.editorCore keeps it reachable from outside this function.
    Nexus.editorCore.indentGuideCompartment = new Compartment();

    // Theming @replit/codemirror-indentation-markers: its own default theme
    // draws each guide line via a generated CSS background-gradient that
    // reads two custom properties — --indent-marker-bg-color and
    // --indent-marker-active-bg-color — set inside its own internal
    // EditorView.baseTheme() under &light/&dark selectors (confirmed by
    // reading the package's actual real source directly, not just its
    // README prose, which turned out to describe options — markerType,
    // thickness, a `colors` object — that this specific published version
    // doesn't actually have). Overriding a CSS class directly (the way
    // bracketMatching's classes were styled) would fight this gradient
    // mechanism rather than work with it; setting these two variables via
    // divIDE's own baseTheme extension, layered alongside the package's,
    // is the confirmed-correct approach — the same technique Home
    // Assistant's own frontend team uses in production for this exact
    // package.
    // Colors: --border (#30363d dark / #d0d7de light) was the original
    // choice, reused from the app's own subtle-divider variable — but it's
    // genuinely too low-contrast for a persistent tracking aid: computed
    // against this app's real --bg via WCAG relative luminance, it's only
    // 1.55:1 (dark) / 1.45:1 (light), nowhere near even the 3:1 floor WCAG
    // sets for large/decorative elements. It was also used identically for
    // BOTH regular and active-scope lines, so the active-line highlight —
    // the whole point of tracking which scope you're in, per the reference
    // screenshot — wasn't happening at all. VS Code's own well-known dark
    // themes (e.g. its indent-guide color customization docs) deliberately
    // use two distinct tiers for exactly this reason: a uniform color
    // reads as either invisible or, on some themes, backwards-highlighted.
    // These replacements are computed the same way: real contrast-ratio
    // math against this app's actual --bg, landing on two of GitHub's own
    // recognized dark/light secondary-UI grays (consistent with the rest
    // of this app's GitHub-derived palette) rather than picked by eye.
    //   dark:  inactive #4d5560 (2.51:1, was 1.55:1) / active #6e7681 (4.12:1)
    //   light: inactive #a8b1ba (2.17:1, was 1.45:1) / active #8c959f (3.04:1)
    const indentGuideTheme = EditorView.baseTheme({
        '&light': { '--indent-marker-bg-color': '#a8b1ba', '--indent-marker-active-bg-color': '#8c959f' },
        '&dark': { '--indent-marker-bg-color': '#4d5560', '--indent-marker-active-bg-color': '#6e7681' }
    });

    const indentGuideExtension = indentationMarkers({
        hideFirstIndent: true // matches the reference screenshot: no guide line at the outermost/first level, only nested scopes
        // Only passing options confirmed present in the package's actual
        // real source (hideFirstIndent, highlightActiveBlock — the latter
        // left at its true default of `true`), not the extra options the
        // npm README describes for a newer version than what's verified
        // here.
    });

    // Word wrap: same live-toggle-via-Compartment pattern as indent guides
    // above. EditorView.lineWrapping is a built-in extension shipped
    // directly in @codemirror/view — confirmed against CodeMirror's own
    // "Example: Line Wrapping" reference page, no separate package needed.
    // Off by default (matches a code editor's usual default — most people
    // editing source want horizontal scroll on long lines, not reflow) but
    // persisted per Nexus.state.prefs.wordWrap like every other editor
    // preference in this app.
    Nexus.editorCore.wordWrapCompartment = new Compartment();

    // Bookmark gutter — structurally the same as CodeMirror's own official
    // "Gutter Example" breakpoint gutter (confirmed against that page's
    // real source): a StateEffect signals add/remove, a StateField holds
    // the current set as a RangeSet<GutterMarker>, and gutter() renders
    // whatever that RangeSet currently contains. The StateField's own
    // update() calls set.map(transaction.changes) every transaction, which
    // is what makes a bookmark stay attached to the SAME line of code as
    // edits happen above/below it, rather than staying pinned to a raw
    // character offset that drifts out of sync the moment anything before
    // it is typed — the exact limitation the old shell-command-only
    // bookmarks (Nexus.state.bookmarks, a flat name->offset map) had.
    const bookmarkEffect = StateEffect.define({
        map: (val, mapping) => ({ pos: mapping.mapPos(val.pos), on: val.on })
    });

    const bookmarkMarker = new (class extends GutterMarker {
        toDOM() {
            const span = document.createElement('span');
            span.textContent = '🔖';
            span.style.cssText = 'font-size:12px; cursor:pointer; line-height:1;';
            return span;
        }
    })();

    const bookmarkState = StateField.define({
        create() { return RangeSet.empty; },
        update(set, transaction) {
            set = set.map(transaction.changes);
            for (const e of transaction.effects) {
                if (e.is(bookmarkEffect)) {
                    if (e.value.on) set = set.update({ add: [bookmarkMarker.range(e.value.pos)] });
                    else set = set.update({ filter: from => from !== e.value.pos });
                }
            }
            return set;
        }
    });

    function toggleBookmarkAt(view, pos) {
        // FIX (real bug — this is why the enable/disable toggle didn't
        // actually stop bookmarking): the guard I added last turn was on
        // toggleBookmarkHere() only, which is one of TWO ways to place a
        // bookmark — the gutter itself has its own separate, direct
        // mousedown handler (right below, in bookmarkGutter's
        // domEventHandlers) that called toggleBookmarkAt() straight
        // through, bypassing that check entirely. Tapping the gutter
        // margin next to a line number placed a bookmark regardless of
        // what the dropdown toggle said. Gating it HERE instead — the one
        // real choke point every bookmark placement actually goes
        // through, both existing call sites and any future one — instead
        // of needing to remember to re-check the preference at every
        // place that might eventually call this.
        if (Nexus.state.prefs.bookmarkingEnabled === false) {
            const st = document.getElementById('footStatus');
            if (st) { st.innerText = "BOOKMARKING DISABLED"; setTimeout(() => Nexus.UI.syncStatus(), 1500); }
            return;
        }
        const line = view.state.doc.lineAt(pos);
        let hasBookmark = false;
        view.state.field(bookmarkState).between(line.from, line.from, () => { hasBookmark = true; });
        view.dispatch({
            effects: bookmarkEffect.of({ pos: line.from, on: !hasBookmark })
        });
        // Mirror into Nexus.state.bookmarks (per-file, persisted) so the
        // list-and-jump panel and cross-session persistence both have a
        // plain-data source of truth outside CM6's own in-memory state,
        // which resets on every reload — see _syncBookmarksFromCM6 below.
        Nexus.UI._syncBookmarksFromCM6(view);
    }

    const bookmarkGutter = [
        bookmarkState,
        gutter({
            class: 'cm-bookmark-gutter',
            markers: v => v.state.field(bookmarkState),
            initialSpacer: () => bookmarkMarker,
            domEventHandlers: {
                mousedown(view, line) {
                    toggleBookmarkAt(view, line.from);
                    return true;
                }
            }
        })
    ];

    // Diff-as-you-type gutter (Feature 4): a thin colored bar showing
    // which lines differ from the file's own last-manually-saved content
    // — not the live autosave copy, which changes on every keystroke and
    // so would never actually show anything as "changed." Reuses
    // Nexus.state.lastSavedContent, the exact same baseline this app's own
    // tab-close/dirty-tracking already relies on (Vfs.isDirty()), so
    // "this line looks different" and "this file needs saving" always
    // agree — one source of truth, not two dirty-tracking concepts that
    // could drift apart. Diffed with Diff.diffLines (already loaded
    // globally as `Diff` for Merge/Compare) rather than a hand-rolled
    // line comparison — verified directly that a changed line surfaces as
    // an 'added' hunk at the right line number before wiring this in.
    const changeMarkerAdded = new (class extends GutterMarker {
        toDOM() {
            const span = document.createElement('span');
            span.style.cssText = 'display:block; width:3px; height:100%; background:#3fb950; margin-left:1px;';
            return span;
        }
    })();
    const changeMarkerRemoved = new (class extends GutterMarker {
        toDOM() {
            const span = document.createElement('span');
            span.style.cssText = 'display:block; width:3px; height:40%; background:#f85149; margin-left:1px; margin-top:-2px;';
            return span;
        }
    })();

    const changeGutterEffect = StateEffect.define();
    const changeGutterState = StateField.define({
        create() { return RangeSet.empty; },
        update(set, transaction) {
            for (const e of transaction.effects) {
                if (e.is(changeGutterEffect)) return e.value; // full replace — recomputed fresh each time, not incrementally mapped
            }
            if (transaction.docChanged) return set.map(transaction.changes);
            return set;
        }
    });

    // Debounced the same way autosave already is (400ms) — diffing the
    // WHOLE file against its saved baseline on every single keystroke is
    // exactly the class of unthrottled per-keystroke work that caused a
    // real, previously-found freeze in this app's search feature; this
    // avoids repeating that mistake for a much larger operation (a full
    // diffLines pass, not a substring scan).
    let changeGutterTimer = null;
    function scheduleChangeGutterUpdate(view) {
        clearTimeout(changeGutterTimer);
        changeGutterTimer = setTimeout(() => recomputeChangeGutter(view), 400);
    }
    function recomputeChangeGutter(view) {
        if (!Nexus.state.prefs.showChangeGutter) {
            view.dispatch({ effects: changeGutterEffect.of(RangeSet.empty) });
            return;
        }
        const fn = Nexus.state.activeFile;
        const saved = Nexus.state.lastSavedContent[fn];
        if (saved === undefined) { // brand new, never-saved file — nothing to diff against, not an error state
            view.dispatch({ effects: changeGutterEffect.of(RangeSet.empty) });
            return;
        }
        const current = view.state.doc.toString();
        if (saved === current) {
            view.dispatch({ effects: changeGutterEffect.of(RangeSet.empty) });
            return;
        }
        const hunks = Diff.diffLines(saved, current);
        const marks = [];
        let curLine = 1;
        for (let hi = 0; hi < hunks.length; hi++) {
            const h = hunks[hi];
            const lineCount = h.value.endsWith('\n') ? h.value.split('\n').length - 1 : h.value.split('\n').length;
            if (h.removed) {
                // A removed hunk immediately followed by an added one is a
                // genuine "this line changed" pair (same adjacency this
                // app's own Merge feature already relies on to detect
                // replacements) — the upcoming added-branch iteration
                // marks the real, current line for that case, so nothing
                // needs marking here or the changed line would get BOTH a
                // green (added) AND an incorrect red (removed) mark on the
                // unrelated line before it. Only a genuinely unpaired
                // removal — content deleted with nothing replacing it —
                // has no line of its own left in the current doc, so the
                // closest honest signal is flagging the line immediately
                // before the gap instead.
                const next = hunks[hi + 1];
                const isReplacePair = next && next.added;
                if (!isReplacePair && curLine > 1 && curLine - 1 <= view.state.doc.lines) {
                    const line = view.state.doc.line(curLine - 1);
                    marks.push(changeMarkerRemoved.range(line.from));
                }
            } else if (h.added) {
                for (let i = 0; i < lineCount; i++) {
                    const lineNum = curLine + i;
                    if (lineNum <= view.state.doc.lines) {
                        const line = view.state.doc.line(lineNum);
                        marks.push(changeMarkerAdded.range(line.from));
                    }
                }
                curLine += lineCount;
            } else {
                curLine += lineCount;
            }
        }
        view.dispatch({ effects: changeGutterEffect.of(RangeSet.of(marks, true)) });
    }

    const changeGutter = [
        changeGutterState,
        gutter({
            class: 'cm-change-gutter',
            markers: v => v.state.field(changeGutterState)
        })
    ];

    // Exposed so manualSave()/switchFile() (both defined elsewhere, outside
    // this closure) can force an immediate recompute — on save, so the
    // gutter clears right away instead of waiting out the 400ms debounce
    // on an edit that never comes; on file switch, so reopening a tab that
    // already has unsaved changes shows them immediately rather than only
    // after the next keystroke in that file.
    Nexus.editorCore.refreshChangeGutter = () => {
        if (Nexus.editorCore.view) recomputeChangeGutter(Nexus.editorCore.view);
    };

    // Whitespace visualization: same live-toggle-via-Compartment pattern
    // again. highlightWhitespace() renders spaces/tabs as visible dots/
    // arrows (confirmed against @codemirror/view's real source and
    // CodeMirror's own changelog — "makes spaces and tabs in the editor
    // visible"); highlightTrailingWhitespace() specifically flags trailing
    // whitespace, which is the more actionable case in practice (leading/
    // mid-line whitespace is usually intentional indentation, trailing
    // whitespace is usually an accident). Both are bundled under one
    // toggle rather than two separate buttons — this app's own project
    // notes mention a prior real bug caused by exactly this class of
    // invisible-whitespace issue (the camelCase rename's string-
    // concatenation blind spot), so "show me all whitespace at once" is
    // the more useful default than making it a two-step decision.
    Nexus.editorCore.whitespaceCompartment = new Compartment();
    const whitespaceExtension = [highlightWhitespace(), highlightTrailingWhitespace()];

    Nexus.editorCore.bookmarkEffect = bookmarkEffect;
    Nexus.editorCore.bookmarkState = bookmarkState;
    Nexus.editorCore.toggleBookmarkAt = toggleBookmarkAt;

    // Bracket tracing toggle — same Compartment pattern as word wrap/
    // whitespace, but defaults ON (prefs.bracketTracing !== false, not
    // === true) since bracket-pair highlighting is a near-universally-
    // wanted editor feature, unlike whitespace-dots which most people
    // leave off. Note basicSetup already bundles its OWN internal copy of
    // bracketMatching() (confirmed against CodeMirror's own basicSetup
    // source), so toggling this compartment off doesn't fully disable
    // bracket matching — it disables THIS APP'S higher-visibility custom
    // styling for it (see the .cm-matchingBracket CSS override comment
    // near the top of this file), falling back to basicSetup's own
    // low-opacity default appearance rather than no highlighting at all.
    Nexus.editorCore.bracketTracingCompartment = new Compartment();

    // Sticky scope headers — defaults ON (prefs.stickyScroll !== false)
    // for the same reason as bracket tracing and indent guides: this is
    // pure navigational aid with no real downside, unlike whitespace-dots
    // which are visually noisy for most people. maxStickyLines caps it at
    // 4 rows so it can never eat more than a small strip of a phone
    // screen's limited vertical space — the package's own built-in ~40%-
    // of-viewport clamp is a second, independent safety net on top of
    // that same concern.
    Nexus.editorCore.stickyScrollCompartment = new Compartment();

    // Minimap, Lint, Autocomplete: same live-toggle-via-Compartment pattern
    // as every other optional feature above. All three default OFF (see
    // each toggle function's own comment for the reasoning) — the
    // Compartment always exists and is always wired into
    // currentExtensions below with an empty [] when off, so turning one on
    // later is a single reconfigure() call, not a full editor rebuild.
    Nexus.editorCore.minimapCompartment = new Compartment();
    Nexus.editorCore.lintCompartment = new Compartment();
    Nexus.editorCore.autocompleteCompartment = new Compartment();

    // FIX (light mode didn't affect the editor): oneDark used to be
    // spliced directly into the extensions array based on a one-time
    // wantsDark check at construction time — the comment even documented
    // this as a known gap ("toggling outdoor-mode while CM6 is already
    // open won't repaint live"). A Compartment is this app's own
    // established, working pattern for every other live-togglable CM6
    // feature (indent guides, bracket tracing, minimap, etc.) — applying
    // it here the same way means toggleSun() can now actually repaint the
    // already-open editor instantly instead of only affecting the NEXT
    // file switch or reload.
    Nexus.editorCore.themeCompartment = new Compartment();

    Nexus.editorCore.currentExtensions = [
       basicSetup, 
       // FIX (unreliable Insert Tab): see the indentWithTab module-loading
       // comment above — basicSetup's defaultKeymap leaves Tab unbound on
       // purpose, so without this the physical Tab key did nothing at all
       // in CM6 mode (only the dedicated ribbon button worked, and only
       // when its own separate readonly-check bug — fixed elsewhere this
       // session — happened to pass). No precedence conflict with
       // basicSetup to worry about here: it never claims Tab itself.
       keymap.of([indentWithTab]),
       langExtension, 
       indentGuideTheme, // always present — just defines CSS variables, harmless when the marker extension itself is toggled off via the compartment below
       Nexus.editorCore.bracketTracingCompartment.of(Nexus.state.prefs.bracketTracing !== false ? bracketMatching() : []),
       Nexus.editorCore.indentGuideCompartment.of(Nexus.state.prefs.indentGuides ? indentGuideExtension : []),
       Nexus.editorCore.wordWrapCompartment.of(Nexus.state.prefs.wordWrap ? EditorView.lineWrapping : []),
       Nexus.editorCore.whitespaceCompartment.of(Nexus.state.prefs.showWhitespace ? whitespaceExtension : []),
       Nexus.editorCore.stickyScrollCompartment.of(Nexus.state.prefs.stickyScroll !== false ? stickyScroll({ maxStickyLines: 4 }) : []),
       // Minimap/Lint/Autocomplete all start according to whatever was
       // last saved (default: off, per each toggle's own reasoning) rather
       // than unconditionally empty — this uses the exact same
       // _build*Extension() helpers the toggle functions call later, so a
       // saved "on" preference actually restores as on after a reload
       // instead of silently resetting to off every time, and there's no
       // separate copy of the construction logic to drift out of sync.
       Nexus.editorCore.minimapCompartment.of(Nexus.state.prefs.minimap ? Nexus.UI._buildMinimapExtension() : []),
       Nexus.editorCore.lintCompartment.of(Nexus.state.prefs.lintEnabled ? Nexus.UI._buildLintExtension() : []),
       Nexus.editorCore.autocompleteCompartment.of(Nexus.state.prefs.autocomplete ? Nexus.UI._buildAutocompleteExtension() : []),
       bookmarkGutter,
       changeGutter,
       Nexus.editorCore.themeCompartment.of(wantsDark ? [oneDark] : []),
       fixedHeight,
       EditorView.updateListener.of((update) => {
           // FIX: `update.userEvent` does not exist on CM6's ViewUpdate (it was
           // always undefined), so this autosave path never fired for ANY CM6
           // edit — the root cause of data loss in CM6 mode. `docChanged` is the
           // real, documented signal for "the document content changed."
           if (update.docChanged && Nexus.state.activeFile) { 
               Nexus.state.Vfs[Nexus.state.activeFile] = update.state.doc.toString();
               clearTimeout(Nexus.editorCore._autosaveTimer);
               Nexus.editorCore._autosaveTimer = setTimeout(() => Nexus.Vfs.save(), 400);
               scheduleChangeGutterUpdate(update.view);
           }
           if (update.selectionSet) {
               const pos = update.state.selection.main.head;
               const lineObj = update.state.doc.lineAt(pos);
               const footPos = document.getElementById('footPos');
               if (footPos) {
                   footPos.innerText = `LN ${lineObj.number}, COL ${pos - lineObj.from + 1}`;
               }
           }
       })
    ];
 
    if (Nexus.editorCore.view) {
        Nexus.editorCore.view.destroy();
    }

    Nexus.editorCore.view = new EditorView({
        state: EditorState.create({
            doc: currentCode,
            extensions: Nexus.editorCore.currentExtensions 
        }),
        parent: actualCmContainer
    });

    // Wire the same diagonal-scroll-drift fix the vanilla textarea already
    // has onto this fresh view's real scrolling element — a new EditorView
    // means a brand new .cm-scroller/scrollDOM each time (engine swaps,
    // first boot), so this has to be re-wired here rather than once
    // globally at page load.
    if (typeof wireCM6ScrollLock === 'function') wireCM6ScrollLock();

    // Restore bookmarks for whichever file is active on this very first
    // CM6 boot — switchFile() handles this for every SUBSEQUENT file
    // change, but the initial EditorView construction here doesn't go
    // through that path at all, so without this the first file opened in
    // a session would show no bookmark markers until you switched away
    // and back.
    if (Nexus.state.activeFile && typeof Nexus.UI._restoreBookmarksToCM6 === 'function') {
        Nexus.UI._restoreBookmarksToCM6(Nexus.editorCore.view, Nexus.state.activeFile);
    }

    // Scroll-past-end: lets the editor scroll ~15 lines past the last line
    // of code, so the last few lines aren't stuck pinned at the very bottom
    // edge of the screen (awkward to read/edit one-handed) or hidden behind
    // the on-screen keyboard.
    //
    // CM6 has no built-in "N lines past end" option — its own author has
    // said directly on the CM6 forum that the recommended approach for a
    // SPECIFIC distance is exactly this: add real padding-bottom to
    // .cm-content, sized in actual pixels you compute yourself. (The
    // built-in scrollPastEnd() extension instead scrolls until the last
    // line reaches the TOP of the viewport — unconfigurable and not what
    // "10 to 20 lines" describes.)
    //
    // The padding is computed from a REAL rendered .cm-line, not a guessed
    // ratio of font-size — line-height varies slightly by font/browser, and
    // Nexus.state.prefs.fontSize is user-configurable, so hardcoding a
    // pixel number would silently drift wrong the moment someone changes
    // their font size. Reading the actual DOM after the view exists is the
    // only way this stays correct regardless of font-size preference.
    Nexus.editorCore.applyScrollPastEnd();

    Nexus.editorCore.isCM6 = true;
    Nexus.state.isCM6 = true;
    document.getElementById('footStatus').innerText = "ENGINE: CM6 ACTIVE";
    // SAVE engine preference
    Nexus.settings.update('activeEngine', 'cm6');

    // Sync the new CM6 surface to whatever lock state the editor was already
    // in. Two real states now (util/full) plus the no-file-open display,
    // which also sets the readonly attribute — all three are covered
    // explicitly here now. Previously this was an if/else-if with no final
    // else, so a textarea in Full Edit (no readonly attribute AND no
    // inputmode="none") matched neither branch and the freshly-swapped CM6
    // surface was left at whatever contentEditable default it booted with
    // instead of being explicitly set to match — full edit could silently
    // fail to carry over across an engine swap.
    const rawEd = document.getElementById('rawTerminal');
    const cmDom = Nexus.editorCore.view.contentDOM;
    if (rawEd && rawEd.hasAttribute('readonly')) {
        cmDom.contentEditable = "false";
        cmDom.setAttribute('inputmode', 'none');
    } else if (rawEd && rawEd.getAttribute('inputmode') === 'none') {
        cmDom.contentEditable = "true";
        cmDom.setAttribute('inputmode', 'none');
    } else {
        cmDom.contentEditable = "true";
        cmDom.removeAttribute('inputmode');
    }
    
} catch (e) {
    document.getElementById('footStatus').innerText = "ENGINE: VANILLA (FAIL)";
    console.error("CM6 Ignition Fault:", e);
    alert("Engine Swap Crashed.\n\n" + e.message);
    
    // Failsafe revert to Vanilla UI mapping
    const actualCmContainer = document.getElementById('cm6Container');
    const actualRawTerminal = document.getElementById('rawTerminal');
    const actualGutter = document.getElementById('gutter');

    if (actualRawTerminal && actualRawTerminal.parentElement) {
        actualRawTerminal.parentElement.style.display = 'block';
    }
    if (actualCmContainer) actualCmContainer.style.display = 'none';
    if (actualGutter) actualGutter.style.display = 'block';

    // This is the actual fix for "engine preference doesn't stick": without
    // resetting these two, the app's internal state (isCM6) and the saved
    // preference both stayed stuck on CM6 even though the UI reverted to
    // vanilla — so every subsequent load kept trying to switch back to CM6
    // and (if it failed again) kept re-crashing, forever.
    Nexus.editorCore.isCM6 = false;
    Nexus.state.isCM6 = false;
    Nexus.editorCore.view = null;
    Nexus.settings.update('activeEngine', 'vanilla');
}
           }
       },

   
   // --- ADVANCED ENGINES ADAPTED FOR THE MATRIX ---
   context: {
       graph: new Map(),
       definitions: new Map(),
       build(code, filepath) {
           this.graph.clear(); 
           this.definitions.clear();
           try {
               const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'module', locations: true });
               acorn.walk.simple(ast, {
                   FunctionDeclaration: (node) => {
                       if (node.id) this.definitions.set(node.id.name, { path: filepath, line: node.loc.start.line, type: 'function' });
                   },
                   VariableDeclarator: (node) => {
                       if (node.id.type === 'Identifier') this.definitions.set(node.id.name, { path: filepath, line: node.loc.start.line, type: 'variable' });
                   },
                   CallExpression: (node) => {
                       if (node.callee.type === 'Identifier') {
                           const name = node.callee.name;
                           if (!this.graph.has(name)) this.graph.set(name, []);
                           this.graph.get(name).push({ path: filepath, line: node.loc.start.line });
                       }
                   }
               });
           } catch(e) {} // Fail silently on bad syntax while typing
       }
   },

       refactor: {
       async renameGlobal() {
           const oldName = prompt("Rename identifier (Global AST pass):");
           if (!oldName) return;
           
           const newName = prompt(`Change all instances of '${oldName}' to:`);
           if (!newName) return;

           let filesModified = 0;
           const files = Object.keys(Nexus.state.Vfs);

           files.forEach(filename => {
               let code = Nexus.state.Vfs[filename];
               if (!filename.endsWith('.js')) return;

               try {
                   Nexus.Sentinel.initEngine();
                   const { ast } = Nexus.Sentinel.engine.analyzeAndMutate(code, 'LINT');
                   let changed = false;

                   Nexus.Sentinel.engine.traverse(ast, (node) => {
                       if (node.type === 'Identifier' && node.name === oldName) {
                           node.name = newName;
                           changed = true;
                       }
                   });

                   if (changed) {
                       const newCode = astring.generate(ast, { indent: ' '.repeat(Nexus.state.prefs.tabWidth) });
                       Nexus.state.Vfs[filename] = newCode;
                       Nexus.state.originals[filename] = newCode;
                       filesModified++;
                   }
               } catch(e) { console.warn(`Refactor skipped ${filename}: Syntax error.`); }
           });

           if (filesModified > 0) {
               Nexus.Vfs.switchFile(Nexus.state.activeFile);
               Nexus.Vfs.save();
               alert(`SUCCESS: Refactored '${oldName}' -> '${newName}' across ${filesModified} sectors.`);
           }
       }
   }, // <--- This now correctly closes the Refactor engine.

   neural: {
       analyzeDelta(oldIssues, newIssues, oldGraphSize, newGraphSize) {
           const delta = { performance: 0, security: 0, complexity: 0, summary: [] };
           const countIds = (issues, ids) => issues.filter(i => ids.includes(i.id)).length;
           
           if (countIds(newIssues, ['SEC_LEAK', 'TAINT_FLOW', 'EVAL_CODE']) > countIds(oldIssues, ['SEC_LEAK', 'TAINT_FLOW', 'EVAL_CODE'])) {
               delta.security = -1; 
               delta.summary.push("⚠️ Security decreased: New potential data leak or XSS sink detected.");
           }

           if (countIds(newIssues, ['LAYOUT_THRASH', 'N_PLUS_ONE', 'ASYNC_FREEZE']) > countIds(oldIssues, ['LAYOUT_THRASH', 'N_PLUS_ONE', 'ASYNC_FREEZE'])) {
               delta.performance = -1; 
               delta.summary.push("📉 Performance hit: You added logic that may cause UI thrashing or N+1 issues.");
           }

           if (newGraphSize > oldGraphSize) {
               delta.complexity = -1; 
               delta.summary.push(`🧠 Complexity increased: ${newGraphSize - oldGraphSize} new logical dependencies mapped.`);
           }

           if (delta.summary.length === 0) delta.summary.push("✅ Logic is stable or improved.");
           return delta;
       }
   },

   // Mobile keyboards (especially iOS "smart punctuation") silently rewrite
   // straight quotes into curly ones as you type or paste, which breaks code
   // in a way that's very hard to spot by eye. This is invisible on desktop,
   // where keyboards don't do this.
   pasteGuard: {
       patterns: [
           { name: 'curly double quotes', re: /[\u201C\u201D]/g, fix: '"' },
           { name: 'curly single quotes', re: /[\u2018\u2019]/g, fix: "'" },
           { name: 'em/en dashes', re: /[\u2013\u2014]/g, fix: '-' },
           { name: 'non-breaking spaces', re: /\u00A0/g, fix: ' ' },
           { name: 'ellipsis character', re: /\u2026/g, fix: '...' },
       ],
       scan(text) {
           let count = 0;
           const found = [];
           for (const p of this.patterns) {
               const matches = text.match(p.re);
               if (matches && matches.length) { count += matches.length; found.push(p.name); }
           }
           return { count, found };
       },
       clean(text) {
           let out = text;
           for (const p of this.patterns) out = out.replace(p.re, p.fix);
           return out;
       },
       // Called on 'paste' — inspects only the freshly-pasted text (available
       // synchronously from the paste event) so this can offer to clean
       // immediately, without waiting for or re-scanning the whole file.
       handlePaste(e) {
           try {
               const text = (e.clipboardData || window.clipboardData).getData('text/plain');
               if (!text) return;
               const { count } = this.scan(text);
               if (count > 0) {
                   Nexus.shell.out(`Found ${count} mobile-autocorrect character${count === 1 ? '' : 's'} (smart quotes/dashes) in what you just pasted — tap Clean Smart Characters to fix.`, 'warn');
               }
           } catch (err) { /* clipboardData not available — silently skip, nothing breaks */ }
       },
       // Manual, on-demand whole-file clean — also catches characters
       // introduced by typing with autocorrect on, not just pasting.
       cleanActiveFile() {
           if (!Nexus.state.activeFile) return Nexus.shell.out('No file open — open or create a file first.', 'warn');
           const code = Nexus.state.Vfs[Nexus.state.activeFile] || '';
           const { count, found } = this.scan(code);
           if (count === 0) {
               Nexus.shell.out('No smart-quote/dash characters found — this file is clean.', 'success');
               return;
           }
           Nexus.state.Vfs[Nexus.state.activeFile] = this.clean(code);
           Nexus.Vfs.save();
           Nexus.Vfs.switchFile(Nexus.state.activeFile);
           Nexus.shell.out(`Cleaned ${count} character${count === 1 ? '' : 's'}: ${found.join(', ')}.`, 'success');
       }
   },

   chronos: {
       worker: null,
       init() {
           if (this.worker) return;
           // FIX (real freeze source): setTimeout used to be mocked as
           // `(fn) => fn()` — fires immediately AND synchronously. Any
           // tested code that uses setTimeout to recursively schedule its
           // next step (a common, legitimate pattern for things like
           // polling loops or animation-style code) would have that
           // recursive call fire instantly instead of after a real delay,
           // turning what was a normal async loop into a synchronous
           // infinite one — inside the worker thread, with no yield point
           // ever reached. Since runTest() below has no per-test timeout,
           // a worker wedged this way would never post back a result, so
           // its Promise never resolves — and since Promise.all() (in
           // startNightCycle) waits for EVERY queued test, one single
           // problem branch anywhere in the project could hang the whole
           // stress test run indefinitely. This explains "some diagnostics
           // freeze it, not every time" precisely: whether this fires
           // depends entirely on whether the specific file being tested
           // happens to contain a setTimeout-recursive branch, which
           // varies file to file.
           //
           // Real fix, two parts: (1) the mock now uses the worker's own
           // real setTimeout (self.setTimeout already exists before this
           // override — capturing it first, then wrapping it, preserves
           // actual async delay/scheduling instead of collapsing it to
           // zero); (2) runTest() below now races every test against a
           // hard per-test timeout, so even a genuinely runaway branch
           // can't hang the worker or the Promise.all waiting on it
           // forever — it times out, gets reported as a failure, and the
           // worker moves on to the next queued test.
           const workerCode = `
               const realSetTimeout = self.setTimeout;
               self.onmessage = function(e) {
                   const { code, iterations } = e.data;
                   const start = (typeof performance !== 'undefined') ? performance.now() : Date.now();
                   try {
                       // Still mocked (so tested code doesn't sit around
                       // waiting on real timer delays during a 1000x
                       // density-test loop) but now via the worker's real
                       // setTimeout with a 0ms delay — genuinely
                       // asynchronous (yields back to the event loop),
                       // not synchronous re-entry. A recursive setTimeout
                       // chain now behaves like an actual async loop
                       // again instead of a synchronous stack-diving one.
                       self.setTimeout = (fn) => realSetTimeout(fn, 0);
                       self.requestAnimationFrame = (fn) => realSetTimeout(() => fn(start), 0);
                       
                       const testRunner = new Function(code);
                       for(let i = 0; i < iterations; i++) {
                           testRunner(); 
                       }
                       
                       const end = (typeof performance !== 'undefined') ? performance.now() : Date.now();
                       postMessage({ success: true, duration: end - start, iterations });
                   } catch (err) { 
                       postMessage({ success: false, error: err.message }); 
                   }
               };
           `;
           const blob = new Blob([workerCode], { type: 'application/javascript' });
           const workerUrl = URL.createObjectURL(blob);
           this.worker = new Worker(workerUrl);
           URL.revokeObjectURL(workerUrl);
       },

       // FIX: previously no timeout at all — if the worker never posted
       // back (see init()'s own comment for exactly how that happened),
       // this Promise sat pending forever, and since startNightCycle()
       // awaits Promise.all() of every queued test, one hung branch
       // anywhere in the project would freeze the entire stress test run
       // with no way to recover short of reloading the whole app. Races
       // the real result against a hard timeout instead — a branch that
       // genuinely can't finish in reasonable time is reported as a
       // failure (which is honestly what "this branch hangs" IS, for a
       // stress test whose whole purpose is catching exactly that), and
       // everything else queued keeps moving.
       TIMEOUT_MS: 3000,

       runTest(code) {
           this.init();
           return new Promise((resolve) => {
               let settled = false;
               let timer = null;

               const handler = (e) => {
                   if (settled) return;
                   settled = true;
                   clearTimeout(timer);
                   this.worker.removeEventListener('message', handler);
                   resolve(e.data);
               };
               this.worker.addEventListener('message', handler);

               timer = setTimeout(() => {
                   if (settled) return;
                   settled = true;
                   this.worker.removeEventListener('message', handler);
                   // The worker itself may still be spinning on this one
                   // (recreating it is the only real way to reclaim it,
                   // since a Worker has no way to interrupt code already
                   // running inside it) — torn down and rebuilt fresh so
                   // the NEXT queued test isn't stuck waiting behind this
                   // one forever too.
                   try { this.worker.terminate(); } catch (e) {}
                   this.worker = null;
                   resolve({ success: false, error: `Timed out after ${this.TIMEOUT_MS}ms — this branch likely contains an infinite or runaway loop.` });
               }, this.TIMEOUT_MS);

               this.worker.postMessage({ code, iterations: 1000 });
           });
       }
   },
                      spotlight: {
           // FIX: this used to run the full scan (every file, every line,
           // a substring check per line) directly on EVERY keystroke via
           // oninput with no debounce at all — typing a multi-character
           // query re-scanned the whole project once per character,
           // synchronously, each one blocking. For a project with many or
           // large files, that's real, repeated main-thread work that
           // could make typing in search itself feel like the app was
           // freezing, distinct from (but same general class of bug as)
           // the Night Cycle fix elsewhere in this file. Debounced to
           // actually scan only after typing pauses briefly, same
           // standard technique used for autosave elsewhere in this app.
           _debounceTimer: null,
           search(query) {
               clearTimeout(this._debounceTimer);
               this._debounceTimer = setTimeout(() => this._runSearch(query), 200);
           },
           _runSearch(query) {
               const res = document.getElementById('spotlightResults');
               if (!query) { 
                   res.innerHTML = ''; 
                   return; 
               }
               
               const q = query.toLowerCase();
               const matches = [];
               
               Object.keys(Nexus.state.Vfs).forEach(file => {
                   const content = Nexus.state.Vfs[file] || "";
                   const lines = content.split('\n');
                   
                   lines.forEach((lineText, index) => {
                       if (lineText.toLowerCase().includes(q)) {
                           matches.push({
                               file: file,
                               line: index + 1,
                               text: lineText.trim()
                           });
                       }
                   });
               });
               
               if (matches.length === 0) {
                   res.innerHTML = '<div style="color:var(--danger); font-size:12px; padding:10px;">No results found.</div>';
                   return;
               }
               
               res.innerHTML = matches.map(m => `
                   <div class="item-row" style="background:var(--surface); border-radius:8px; padding:12px; cursor:pointer; margin-bottom:5px; display:flex; flex-direction:column; align-items:flex-start;" 
                        onclick="Nexus.Vfs.switchFile('${m.file}'); setTimeout(() => Nexus.UI.jumpPrompt(${m.line}), 100); Nexus.UI.closeModal('spotlight');">
                       <div style="display:flex; justify-content:space-between; width:100%;">
                           <span style="font-family:monospace; font-size:13px; color:var(--gold); font-weight:bold;">${m.file}</span>
                           <span style="font-size:11px; color:var(--accent);">Line ${m.line}</span>
                       </div>
                       <div style="font-size:11px; color:var(--text); opacity:0.6; margin-top:4px; font-family:monospace; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; width:100%;">
                           ${m.text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}
                       </div>
                   </div>
               `).join(''); // <-- Fixed backtick added here
           }
       },

       dreamer: {
       // --- 1. UI ARCHITECT TEMPLATES ---
       templates: { 
           'btn-tactical': (l, id) => `<button id="${id || 'btn-01'}" style="padding:12px 24px; background:var(--gold, #d29922); color:#000; border:none; border-radius:8px; font-weight:bold; cursor:pointer; box-shadow:0 4px 15px rgba(210,153,34,0.3); transition:all 0.2s;">${l || 'TACTICAL ACTION'}</button>`, 
           'card-gold': (l, id) => `<div id="${id || 'card-01'}" style="border:1px solid var(--gold, #d29922); background:rgba(210,153,34,0.05); padding:20px; border-radius:12px; box-shadow:0 10px 30px rgba(0,0,0,0.5);"><h3 style="color:var(--gold, #d29922); margin-top:0;">${l || 'DATA MODULE'}</h3><p style="color:var(--text, #c9d1d9); font-size:14px;">Telemetry synced and stable.</p></div>`, 
           'grid-skill': (l, id) => `<div id="${id || 'grid-01'}" style="display:grid; grid-template-columns: repeat(3, 1fr); gap:10px;">${Array(9).fill().map((_, i) => `<button style="height:80px; background:var(--surface, #21262d); color:var(--text, #c9d1d9); border:1px solid var(--border, #30363d); border-radius:12px; font-size:24px; font-weight:bold;">${i+1}</button>`).join('')}</div>`,
           'nav-bottom': (l, id) => `<nav id="${id || 'nav-01'}" style="position:fixed; bottom:0; left:0; width:100%; background:var(--panel, #161b22); display:flex; justify-content:space-around; align-items:center; padding:15px; border-top:1px solid var(--border, #30363d); z-index:100;"><button style="border:none; background:transparent; color:var(--text, #c9d1d9); display:flex; flex-direction:column; align-items:center; gap:5px;"><span style="font-size:20px;">🏠</span><span style="font-size:10px;">${l || 'Home'}</span></button><button style="border:none; background:var(--accent, #2f81f7); color:#fff; border-radius:50%; width:55px; height:55px; display:flex; justify-content:center; align-items:center; font-size:24px; box-shadow:0 0 20px rgba(47,129,247,0.4); transform:translateY(-15px);">+</button><button style="border:none; background:transparent; color:var(--text, #c9d1d9); display:flex; flex-direction:column; align-items:center; gap:5px;"><span style="font-size:20px;">👤</span><span style="font-size:10px;">Profile</span></button></nav>`,
           'modal-box': (l, id) => `<div id="${id || 'modal-01'}" style="position:fixed; inset:0; background:rgba(0,0,0,0.85); backdrop-filter:blur(5px); display:flex; align-items:center; justify-content:center; z-index:1000;"><div style="background:var(--panel, #161b22); width:85%; max-width:400px; padding:25px; border-radius:20px; border:1px solid var(--border, #30363d); box-shadow:0 25px 50px rgba(0,0,0,1);"><h3 style="color:var(--gold, #d29922); margin-top:0; border-bottom:1px solid var(--border, #30363d); padding-bottom:10px;">${l || 'SYSTEM ALERT'}</h3><p style="font-size:14px; color:var(--text, #c9d1d9); line-height:1.5; margin-bottom:25px;">Operation successfully initialized.</p><button style="width:100%; padding:15px; background:var(--accent, #2f81f7); color:#fff; border:none; border-radius:10px; font-weight:bold; cursor:pointer;" onclick="this.closest('#${id || 'modal-01'}').style.display='none'">ACKNOWLEDGE</button></div></div>`,
           'list-view': (l, id) => `<div id="${id || 'list-01'}" style="display:flex; flex-direction:column; gap:8px;">${Array(4).fill().map((_, i) => `<div style="background:var(--surface, #21262d); border:1px solid var(--border, #30363d); padding:15px; border-radius:12px; display:flex; justify-content:space-between; align-items:center;"><div style="display:flex; align-items:center; gap:15px;"><div style="width:40px; height:40px; background:var(--bg, #0d1117); border-radius:50%; display:flex; justify-content:center; align-items:center; font-weight:bold; color:var(--gold, #d29922);">${i+1}</div><div style="display:flex; flex-direction:column;"><strong style="color:var(--text, #c9d1d9);">${l || 'Data Matrix'} ${i+1}</strong><span style="font-size:10px; color:var(--text, #c9d1d9); opacity:0.5;">Status: Online</span></div></div><span style="color:var(--accent, #2f81f7); font-size:20px;">→</span></div>`).join('')}</div>`,
           'input-group': (l, id) => `<div id="${id || 'input-wrap'}" style="display:flex; flex-direction:column; gap:8px; margin-bottom:20px;"><label style="font-size:11px; color:var(--gold, #d29922); font-weight:900; letter-spacing:1px; text-transform:uppercase;">${l || 'AUTHORIZATION CODE'}</label><input type="text" placeholder="Enter secure payload..." style="padding:15px; background:var(--bg, #0d1117); border:1px solid var(--border, #30363d); border-radius:10px; color:#fff; font-family:monospace; font-size:14px; outline:none;"></div>`,
           'toggle-switch': (l, id) => `<label id="${id || 'toggle-01'}" style="display:flex; align-items:center; gap:15px; cursor:pointer; padding:10px 0;"><div style="position:relative; width:50px; height:26px; background:var(--border, #30363d); border-radius:13px; overflow:hidden;"><input type="checkbox" style="opacity:0; width:0; height:0; position:absolute;" onchange="this.nextElementSibling.style.transform = this.checked ? 'translateX(24px)' : 'translateX(0)'; this.parentElement.style.background = this.checked ? 'var(--success, #3fb950)' : 'var(--border, #30363d)';"><div style="position:absolute; top:2px; left:2px; width:22px; height:22px; background:#fff; border-radius:50%; transition:transform 0.3s;"></div></div><span style="font-size:14px; color:var(--text, #c9d1d9); font-weight:bold;">${l || 'Override Protocol'}</span></label>`,
           'loader-spinner': (l, id) => `<div id="${id || 'spinner-01'}" style="display:flex; flex-direction:column; align-items:center; justify-content:center; gap:15px; padding:30px;"><div class="nexus-spinner"></div><style>.nexus-spinner { width:40px; height:40px; border:4px solid var(--border); border-top-color:var(--accent); border-radius:50%; animation:nexusSpin 1s infinite; } @keyframes nexusSpin { to { transform: rotate(360deg); } }</style><span style="font-size:11px; color:var(--gold); font-weight:900; letter-spacing:2px;">${l || 'SYNTHESIZING...'}</span></div>`,
           'hero-section': (l, id) => `<header id="${id || 'hero-01'}" style="text-align:center; padding:50px 20px; background:linear-gradient(135deg, var(--panel), var(--bg)); border-bottom:1px solid var(--border);"><h1 style="color:var(--accent); font-size:36px; margin:0 0 15px 0;">${l || 'Next Gen Platform'}</h1><p style="color:var(--text); font-size:16px; margin-bottom:30px; opacity:0.8;">Empowering developers with limitless tools.</p></header>`,
           'auth-matrix': (l, id) => `<div id="${id || 'auth-01'}" style="max-width:350px; margin:40px auto; padding:30px; background:var(--surface); border:1px solid var(--border); border-radius:16px;"><h2 style="text-align:center; color:var(--gold); margin-top:0;">${l || 'SECURE LOGIN'}</h2><div style="display:flex; flex-direction:column; gap:15px; margin-top:20px;"><input type="text" placeholder="Username" style="padding:14px; background:var(--bg); border:1px solid var(--border); border-radius:8px; color:#fff;"><input type="password" placeholder="Passcode" style="padding:14px; background:var(--bg); border:1px solid var(--border); border-radius:8px; color:#fff;"><button style="margin-top:10px; padding:15px; background:var(--accent); color:#fff; border:none; border-radius:8px; font-weight:bold;">AUTHENTICATE</button></div></div>`,
           'toast-alert': (l, id) => `<div id="${id || 'toast-01'}" style="position:fixed; top:20px; right:20px; background:var(--success); color:#fff; padding:15px 25px; border-radius:8px; font-weight:bold; z-index:9999; animation:slideIn 0.3s ease-out;">${l || 'Operation Successful'}</div><style>@keyframes slideIn { from{transform:translateX(100%); opacity:0;} to{transform:translateX(0); opacity:1;} }</style>`,
           'chat-bubble': (l, id) => `<div id="${id || 'chat-wrap'}" style="display:flex; flex-direction:column; gap:15px; padding:20px;"><div style="align-self:flex-start; max-width:75%; background:var(--surface); border:1px solid var(--border); padding:12px 18px; border-radius:18px 18px 18px 0; color:var(--text);">${l || 'System: Awaiting command.'}</div></div>`,
           'settings-panel': (l, id) => `<div id="${id || 'settings-01'}" style="background:var(--surface); border:1px solid var(--border); border-radius:12px; overflow:hidden;"><div style="padding:15px 20px; background:var(--bg); font-weight:bold; color:var(--gold); border-bottom:1px solid var(--border);">${l || 'SYSTEM PREFERENCES'}</div><div style="padding:15px 20px; display:flex; justify-content:space-between; align-items:center;"><span style="color:var(--text);">Telemetry Tracking</span><label style="position:relative; width:44px; height:24px; background:var(--success); border-radius:12px;"><input type="checkbox" checked style="opacity:0; width:0; height:0;"><div style="position:absolute; top:2px; left:22px; width:20px; height:20px; background:#fff; border-radius:50%;"></div></label></div></div>`,
           'pricing-card': (l, id) => `<div id="${id || 'price-01'}" style="width:280px; background:linear-gradient(180deg, var(--surface), var(--bg)); border:2px solid var(--gold); border-radius:16px; padding:30px 20px; text-align:center; margin:0 auto;"><h3 style="color:var(--text); margin:0;">${l || 'NEXUS TIER'}</h3><div style="font-size:42px; font-weight:900; color:#fff; margin:15px 0;">$29</div><button style="width:100%; padding:15px; background:var(--gold); color:#000; border:none; border-radius:8px; font-weight:900;">UPGRADE</button></div>`,
           'progress-bar': (l, id) => `<div id="${id || 'prog-01'}" style="width:100%; padding:10px 0;"><div style="display:flex; justify-content:space-between; margin-bottom:8px; font-size:12px; font-weight:bold;"><span style="color:var(--text);">${l || 'Extracting...'}</span><span style="color:var(--accent);">78%</span></div><div style="width:100%; height:8px; background:var(--bg); border:1px solid var(--border); border-radius:4px; overflow:hidden;"><div style="width:78%; height:100%; background:var(--accent);"></div></div></div>`,
           'accordion-menu': (l, id) => `<details id="${id || 'acc-01'}" style="background:var(--surface); border:1px solid var(--border); border-radius:8px; margin-bottom:10px;"><summary style="padding:15px; color:var(--gold); font-weight:bold; cursor:pointer;">${l || 'File Metadata'}</summary><div style="padding:15px; border-top:1px solid var(--border); color:var(--text); font-size:14px; background:var(--bg);">Signature verified.</div></details>`,
           'profile-header': (l, id) => `<div id="${id || 'prof-01'}" style="display:flex; align-items:center; gap:20px; padding:20px; background:var(--surface); border-radius:16px; border:1px solid var(--border);"><div style="width:70px; height:70px; border-radius:50%; background:var(--accent); display:flex; justify-content:center; align-items:center; font-size:28px; color:#fff; font-weight:bold;">A</div><div style="flex:1;"><h2 style="margin:0 0 5px 0; color:#fff; font-size:20px;">${l || 'Amanda'}</h2><p style="margin:0 0 10px 0; color:var(--text); font-size:12px; opacity:0.7;">Systems Architect</p></div></div>`,

           // Non-UI boilerplates — the existing 18 above are all HTML
           // components; every one of these fills a category that had
           // zero coverage, matching the language surface this editor
           // actually supports now (Python/SQL/shell were added in an
           // earlier session but had no corresponding boilerplates).
           // These ignore the `id` param (irrelevant for a fetch call or a
           // Python class — id is a DOM concept) and use `l` as a
           // meaningful name where one fits (function/class/table name).
           'fetch-async': (l, id) => `async function ${l || 'fetchData'}(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
        const data = await response.json();
        return data;
    } catch (err) {
        console.error('${l || 'fetchData'} failed:', err);
        throw err;
    }
}`,
           'js-class': (l, id) => `class ${l || 'MyClass'} {
    constructor(${''}) {

    }

    // Add methods below
}`,
           'try-catch': (l, id) => `try {
    ${l ? '// ' + l : '// code that might throw'}

} catch (err) {
    console.error(err);
}`,
           'py-script': (l, id) => `#!/usr/bin/env python3
"""${l || 'Script description'}"""


def main():
    pass


if __name__ == '__main__':
    main()`,
           'py-class': (l, id) => `class ${l || 'MyClass'}:
    def __init__(self):
        pass`,
           'sh-script': (l, id) => `#!/bin/bash
set -euo pipefail

# ${l || 'Script description'}

main() {
    echo "Running..."
}

main "$@"`,
           'sql-query': (l, id) => `SELECT
    ${l || 'column1, column2'}
FROM
    table_name
WHERE
    condition = value
ORDER BY
    column1;`
       },

       // v42 Blueprints — real, multi-variant entries for the types where a
       // genuinely separate, reusable non-HTML artifact exists. Object form
       // matches inject()'s existing typeof-object branch exactly. Only
       // .html and .css are populated: none of these component types have
       // a meaningful standalone .js artifact. Anything not listed here
       // correctly falls through to the matching v40 templates entry.
       blueprints: {
           'toggle-switch': {
               html: `<label class="nexus-bp-toggle"><input type="checkbox" class="nexus-bp-toggle-input"><span class="nexus-bp-toggle-track"></span><span class="nexus-bp-toggle-label">Override Protocol</span></label>`,
               css: `.nexus-bp-toggle { display: flex; align-items: center; gap: 15px; cursor: pointer; padding: 10px 0; }
.nexus-bp-toggle-input { position: absolute; opacity: 0; width: 0; height: 0; }
.nexus-bp-toggle-track { position: relative; width: 50px; height: 26px; background: var(--border, #30363d); border-radius: 13px; transition: background 0.2s; flex-shrink: 0; }
.nexus-bp-toggle-track::before { content: ''; position: absolute; top: 2px; left: 2px; width: 22px; height: 22px; background: #fff; border-radius: 50%; transition: transform 0.2s; }
.nexus-bp-toggle-input:checked + .nexus-bp-toggle-track { background: var(--success, #3fb950); }
.nexus-bp-toggle-input:checked + .nexus-bp-toggle-track::before { transform: translateX(24px); }
.nexus-bp-toggle-label { font-size: 14px; color: var(--text, #c9d1d9); font-weight: bold; }`
           },
           'loader-spinner': {
               html: `<div class="nexus-bp-spinner-wrap"><div class="nexus-bp-spinner"></div><span class="nexus-bp-spinner-label">SYNTHESIZING...</span></div>`,
               css: `.nexus-bp-spinner-wrap { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 15px; padding: 30px; }
.nexus-bp-spinner { width: 40px; height: 40px; border: 4px solid var(--border, #30363d); border-top-color: var(--accent, #2f81f7); border-radius: 50%; animation: nexusBpSpin 1s linear infinite; }
.nexus-bp-spinner-label { font-size: 11px; color: var(--gold, #d29922); font-weight: 900; letter-spacing: 2px; }
@keyframes nexusBpSpin { to { transform: rotate(360deg); } }`
           },
           'progress-bar': {
               html: `<div class="nexus-bp-progress"><div class="nexus-bp-progress-header"><span class="nexus-bp-progress-label">Extracting...</span><span class="nexus-bp-progress-pct">78%</span></div><div class="nexus-bp-progress-track"><div class="nexus-bp-progress-fill" style="width: 78%;"></div></div></div>`,
               css: `.nexus-bp-progress { width: 100%; padding: 10px 0; }
.nexus-bp-progress-header { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 12px; font-weight: bold; }
.nexus-bp-progress-label { color: var(--text, #c9d1d9); }
.nexus-bp-progress-pct { color: var(--accent, #2f81f7); }
.nexus-bp-progress-track { width: 100%; height: 8px; background: var(--bg, #0d1117); border: 1px solid var(--border, #30363d); border-radius: 4px; overflow: hidden; }
.nexus-bp-progress-fill { height: 100%; background: var(--accent, #2f81f7); transition: width 0.3s ease; }`
           }
       },

       // --- 2. UI PREVIEW & INJECTION ---
       updatePreview() { 
           const t = document.getElementById('dreamerType').value;
           const l = document.getElementById('dreamerLabel').value; 
           const p = document.getElementById('dreamerPreview'); 
           if (!p) return;
           const bp = this.blueprints[t];
           // Code-language boilerplates (JS/Python/Shell/SQL skeletons)
           // aren't HTML — rendering their raw text via innerHTML would
           // technically "work" (no tags to misinterpret) but the browser
           // collapses all whitespace/newlines by default, so a multi-line
           // Python script would visually flatten into one unreadable
           // line. These render in a <pre> block instead, which preserves
           // formatting exactly like the actual code editor would.
           const CODE_TEMPLATES = new Set(['fetch-async', 'js-class', 'try-catch', 'py-script', 'py-class', 'sh-script', 'sql-query']);
           if (CODE_TEMPLATES.has(t) && this.templates[t]) {
               const code = this.templates[t](l, 'preview-id');
               const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
               p.innerHTML = `<pre style="margin:0; padding:12px; text-align:left; width:100%; overflow-x:auto; font-family:monospace; font-size:12px; color:var(--text); white-space:pre;">${escaped}</pre>`;
           } else if (bp) {
               p.innerHTML = bp.html || '';
           } else if (this.templates[t]) {
               p.innerHTML = this.templates[t](l, 'preview-id');
           }
       },
inject() {
   // 1. Safety Check — engine-aware lock detection (the old check tested the
   // vanilla textarea's readonly attribute and skipped the check entirely in
   // CM6 mode, so a locked file could still be injected into under CM6).
   if (!Nexus.UI.needUnlocked('Injecting a snippet', () => Nexus.dreamer.inject())) return;

   const type = document.getElementById('dreamerType').value;
   const label = document.getElementById('dreamerLabel').value;
   const id = document.getElementById('dreamerId').value;
   const ext = Nexus.state.activeFile.split('.').pop().toLowerCase();

   // 2. Resolution: Check v42 Blueprints first, fallback to v40 Templates
   const blueprint = this.blueprints?.[type] || this.templates[type];
   
   let payload = "";
   if (typeof blueprint === 'function') {
       // Handle v40 style: Templates are functions that return strings
       payload = blueprint(label, id);
   } else if (typeof blueprint === 'object') {
       // Handle v42 style: Blueprints are objects with .html, .js, .css
       payload = blueprint[ext] || blueprint.html || "";
   }

   if (payload) {
       // 3. The Sovereign Pipeline
       // We use injectChar so the Backspace logic and Dexie Auto-save trigger
       Nexus.UI.injectChar(`\n${payload}\n`);
       
       Nexus.UI.closeModal('dreamer');
       Nexus.UI.updateGutter();
       if (Nexus.Sentinel) {
   Nexus.Sentinel.log(`ARCHITECT: ${type} injected into ${ext.toUpperCase()} sector.`, "success");
       }
}
},

       // --- 3. STRESS TESTING & NIGHT CYCLE ---
       async startNightCycle() {
           Nexus.Sentinel.log("[DREAMER] Initiating Background Stress Test...", "accent");
           const testPromises = [];

           // FIX (real freeze source, distinct from the worker-timeout fix
           // in Nexus.chronos): this loop used to run fully synchronously
           // across EVERY .js file in the project — acorn.parse() plus a
           // full AST walk per file, back to back, with no yield point
           // anywhere in between. For a project with many or large JS
           // files, that's real, uninterrupted main-thread work long
           // enough to make the whole app feel frozen (no tap response,
           // no visual feedback) until every file finishes parsing — not
           // an infinite loop, just enough synchronous work in one go to
           // present the same way to whoever's using it. This explains
           // "random diagnostics freeze it, not every time" specifically:
           // whether it's noticeable scales directly with how much JS the
           // current project actually has, which varies project to
           // project. Yields back to the browser after each file (a
           // microtask-queue tick via setTimeout 0) so the UI stays
           // responsive throughout a run instead of locking up until the
           // entire scan completes.
           for (const [filename, code] of Object.entries(Nexus.state.Vfs)) {
               if (!filename.endsWith('.js')) continue;
               try {
                   const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'module' });
                   acorn.walk.simple(ast, {
                       IfStatement: (node) => {
                           const block = code.substring(node.start, node.end);
                           testPromises.push(Nexus.chronos.runTest(block));
                       }
                   });
               } catch(e) {
                   Nexus.Sentinel.log(`[DREAMER] Skipped ${filename} — syntax error, could not be parsed for testing.`, "warn");
               }
               // Yield to the event loop before parsing the next file —
               // lets any pending UI updates (taps, renders, the log
               // messages this function itself just wrote) actually paint
               // instead of queuing up behind a wall of synchronous work.
               await new Promise((resolve) => setTimeout(resolve, 0));
           }
           
           Nexus.Sentinel.log(`[DREAMER] Queued ${testPromises.length} logic branches for Chronos.`, "warn");
           const results = await Promise.all(testPromises);
           
           const failures = results.filter(r => !r.success);
           if (failures.length > 0) {
               Nexus.Sentinel.log(`[DREAMER] Night Cycle: ${failures.length} branches threw exceptions.`, "danger");
           } else {
               Nexus.Sentinel.log(`[DREAMER] Night Cycle: All branches survived time-dilation.`, "success");
           }
       }
   },


   omni: {
       path: [],
       init() {
           const canvas = document.getElementById('omniCanvas');
           if (!canvas) return;
           const ctx = canvas.getContext('2d');
           
           const resize = () => { 
               canvas.width = window.innerWidth; 
               canvas.height = window.innerHeight; 
           };
           window.addEventListener('resize', resize); 
           resize();

           let isDrawing = false;

           // Trigger: 3-finger touch activates the Omni gesture layer
           document.addEventListener('touchstart', (e) => { 
               if (e.touches.length === 3) canvas.classList.add('active'); 
           });

           canvas.addEventListener('touchstart', (e) => {
               if (!canvas.classList.contains('active')) return;
               isDrawing = true; 
               this.path = [];
               ctx.beginPath(); 
               ctx.moveTo(e.touches[0].clientX, e.touches[0].clientY);
           });

           canvas.addEventListener('touchmove', (e) => {
               if (!isDrawing) return;
               this.path.push({ x: e.touches[0].clientX, y: e.touches[0].clientY });
               ctx.strokeStyle = 'var(--accent)'; 
               ctx.lineWidth = 4;
               ctx.lineTo(e.touches[0].clientX, e.touches[0].clientY); 
               ctx.stroke();
           });

           canvas.addEventListener('touchend', () => {
               if (!isDrawing) return;
               isDrawing = false; 
               canvas.classList.remove('active');
               this.processGesture();
               ctx.clearRect(0, 0, canvas.width, canvas.height);
           });
       },
       processGesture() {
           if (this.path.length < 5) return;
           let dirStr = "";
           for (let i = 1; i < this.path.length; i++) {
               const dx = this.path[i].x - this.path[i-1].x;
               const dy = this.path[i].y - this.path[i-1].y;
               if (Math.abs(dx) < 15 && Math.abs(dy) < 15) continue;
               let dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'R' : 'L') : (dy > 0 ? 'D' : 'U');
               if (dirStr[dirStr.length - 1] !== dir) dirStr += dir;
           }
           
           // Route gesture to active UI logic
           if (dirStr === 'DL') Nexus.Sentinel.runLint(); 
           if (dirStr === 'UDUD') Nexus.intel.scan();     
           if (dirStr === 'DRUL') Nexus.UI.runJSBeautify();    
       }
   },

   widgetConfig: {
       writerVocab: {
           code: ['const ', 'let ', 'async ', 'await ', 'function() { ', 'return '],
           story: ['Once ', 'upon ', 'a ', 'time ', 'the ', 'system ', 'awoke '],
           custom: ['Your ', 'custom ', 'words ', 'here ']
       },
       keyboard: { position: 'bottom', visibleRows: 3, currentLang: 'html' }
   },
   

   


   pwa: {
       // Drains files handed off via window.launchQueue (see the head
       // script) — this fires when Android opens divIDE because the user
       // tapped a file registered in manifest.json's file_handlers. Each
       // entry is a FileSystemFileHandle, not a File, so getFile() is
       // needed to read actual content. Runs after Nexus.boot so Vfs/UI
       // are guaranteed to exist; called once from the head script's
       // launchQueue consumer, and again here defensively in case boot()
       // finishes after the launch already queued.
       async consumeLaunchFiles() {
           const handles = window.Nexus._pendingLaunchFiles;
           if (!handles || !handles.length) return;
           window.Nexus._pendingLaunchFiles = null;

           let lastImported = null;
           for (const handle of handles) {
               try {
                   const file = await handle.getFile();
                   const text = await file.text();
                   let name = file.name;
                   // Same collision handling as a manual New File — don't
                   // silently clobber an existing same-named file in the
                   // Vortex.
                   if (Nexus.state.Vfs[name] !== undefined) {
                       const stamp = Date.now().toString(36).slice(-4);
                       const dot = name.lastIndexOf('.');
                       name = dot > 0 ? `${name.slice(0, dot)}_${stamp}${name.slice(dot)}` : `${name}_${stamp}`;
                   }
                   Nexus.state.Vfs[name] = text;
                   Nexus.state.originals[name] = text;
                   // Same reasoning as loadFiles()/importZIP(): freshly
                   // imported content, nothing to consider "unsaved" yet.
                   Nexus.state.lastSavedContent[name] = text;
                   lastImported = name;
               } catch (e) {
                   console.warn('File Handling: failed to read launched file:', e);
               }
           }

           if (lastImported) {
               if (typeof Nexus.Vfs.renderAccordion === 'function') Nexus.Vfs.renderAccordion();
               Nexus.Vfs.switchFile(lastImported);
               Nexus.Vfs.save();
               if (Nexus.shell && typeof Nexus.shell.out === 'function') {
                   Nexus.shell.out(`📂 Opened from system: ${lastImported}`, 'success');
               }
           }
       },


       async forge() {
           if (!Nexus.state.activeFile.endsWith('.html')) return alert("HTML Required.");
           const name = prompt("PWA Name:", "Nexus Tool");
           const color = prompt("Theme Color:", "#0d1117");
           if (!name || !color) return;

           const wantsFileHandling = confirm("Register this app as a file opener too? (lets Android's 'Open with' menu launch it directly on tapped files — OK for yes)");
           let extensions = [];
           if (wantsFileHandling) {
               const raw = prompt("File extensions to handle, comma-separated:", "html,htm,js,css,json,txt,md");
               extensions = (raw || "").split(",").map(s => s.trim().replace(/^\./, "")).filter(Boolean);
           }

           // Generate a simple app icon on the fly (colored square + initial)
           // as an absolute data: URI. The old manifest shipped with NO
           // icons array at all, which fails Chrome/Android's installability
           // check outright — "Add to Home Screen" simply wouldn't offer.
           const initial = (name.trim()[0] || 'N').toUpperCase();
           const iconSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">`
               + `<rect width="512" height="512" rx="96" fill="${color}"/>`
               + `<text x="50%" y="50%" dy=".33em" text-anchor="middle" `
               + `font-family="system-ui,-apple-system,Segoe UI,sans-serif" `
               + `font-size="260" font-weight="700" fill="#ffffff">${initial}</text></svg>`;
           const iconURI = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(iconSVG);

           // MIME lookup for the extensions the user picked — good-enough
           // coverage for what a divIDE-forged export is likely to be.
           const MIME = {
               html: "text/html", htm: "text/html", js: "text/javascript", mjs: "text/javascript",
               css: "text/css", json: "application/json", md: "text/markdown", txt: "text/plain",
               svg: "image/svg+xml", xml: "application/xml", ts: "application/typescript"
           };

           const manifest = { 
               id: "/",
               name, 
               short_name: name.slice(0, 12), 
               start_url: "./",
               scope: "./",
               display: "standalone", 
               background_color: color, 
               theme_color: color,
               icons: [
                   { src: iconURI, sizes: "512x512", type: "image/svg+xml", purpose: "any" },
                   { src: iconURI, sizes: "512x512", type: "image/svg+xml", purpose: "maskable" }
               ]
           };

           // file_handlers requires a real same-origin manifest.json — this
           // is exactly why Forge writes manifest.json as a sibling file in
           // the zip below instead of inlining it as a data: URI like the
           // icons. Confirmed against the W3C File Handling spec.
           if (wantsFileHandling && extensions.length) {
               const accept = {};
               for (const ext of extensions) {
                   const mime = MIME[ext.toLowerCase()] || "application/octet-stream";
                   if (!accept[mime]) accept[mime] = [];
                   accept[mime].push(`.${ext}`);
               }
               manifest.file_handlers = [{
                   action: "./",
                   accept,
                   icons: [{ src: iconURI, sizes: "512x512", type: "image/svg+xml" }],
                   launch_type: "single-client"
               }];
               manifest.launch_handler = { client_mode: "focus-existing" };
           }

           const manifestJSON = JSON.stringify(manifest, null, 2);

           // A real, working service worker: cache the app shell on install,
           // then cache-first/network-fallback on fetch, topping up the
           // cache as new same-origin resources are requested. Also caches
           // manifest.json itself so installability survives offline.
           const swCode = `const CACHE = 'nexus-pwa-v1';
const APP_SHELL = ['./', './${Nexus.state.activeFile}', './manifest.json'];
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP_SHELL).catch(() => {})));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((res) => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      }).catch(() => cached);
    })
  );
});`;

           // NOTE: registering a service worker from a blob:/data: URL is not
           // a bug we can code around — the spec requires an http(s)
           // same-origin script file, and browsers reject anything else with
           // "Script URL's scheme is not 'http' or 'https'". So Forge ships
           // sw.js AND manifest.json as real sibling files in the zip — the
           // only approach that actually works for either.
           let inject = `\n<link rel="manifest" href="./manifest.json">\n<link rel="apple-touch-icon" href="${iconURI}">\n<meta name="theme-color" content="${color}">\n<script>\nif ('serviceWorker' in navigator) { window.addEventListener('load', () => {\n  navigator.serviceWorker.register('./sw.js').catch(err => console.warn('SW registration failed:', err));\n}); }\n<\/script>\n`;

           if (wantsFileHandling && extensions.length) {
               inject += `<script>\nif ('launchQueue' in window) {\n  window.launchQueue.setConsumer(async (launchParams) => {\n    if (!launchParams.files || !launchParams.files.length) return;\n    const handle = launchParams.files[0];\n    const file = await handle.getFile();\n    const text = await file.text();\n    console.log('Opened via file association:', file.name, text.length + ' chars');\n    // Wire this into your own app's file-loading logic as needed.\n  });\n}\n<\/script>\n`;
           }
           
           let code = Nexus.state.Vfs[Nexus.state.activeFile];
           code = code.includes('</head>') ? code.replace('</head>', inject + '</head>') : inject + code;
           
           Nexus.state.Vfs[Nexus.state.activeFile] = code; 
           Nexus.Vfs.save(); 
           Nexus.Vfs.switchFile(Nexus.state.activeFile); 

           const status = document.getElementById('footStatus');
           if (status) status.innerText = "FORGING...";
           try {
               const zip = new JSZip();
               zip.file(Nexus.state.activeFile, code);
               zip.file("sw.js", swCode);
               zip.file("manifest.json", manifestJSON);
               const blob = await zip.generateAsync({ type: "blob" });
               const a = document.createElement('a');
               a.href = URL.createObjectURL(blob);
               a.download = `${(name.replace(/[^a-z0-9-_]+/gi, '_') || 'nexus-pwa')}.zip`;
               a.click();
               if (status) { status.innerText = "FORGED"; setTimeout(() => status.innerText = "READY", 3000); }
               Nexus.shell.out(`Exported ${a.download} — unzip all three files onto any static host (GitHub Pages, Netlify, etc.) to install.`, "success");
           } catch (e) {
               console.error("PWA Forge export failed:", e);
               alert("Forge Fault: " + e.message);
               if (status) status.innerText = "FAULT";
           }
       }
   },

   assetMatrix: {
       encode(file) {
           if (!file || file.size > 2 * 1024 * 1024) return alert("File missing or too large (>2MB).");
           const reader = new FileReader();
           reader.onload = (e) => {
               const name = prompt("Asset Name (Vault Key):", file.name);
               if (name) { 
                   Nexus.state.vault.push({ name, code: e.target.result }); 
                   Nexus.vault.save(); 
                   Nexus.vault.render(); 
                   Nexus.shell.out("Saved to Vault.", "success"); 
               }
           };
           reader.readAsDataURL(file);
       }
   },

   // Image viewing + light editing. Deliberately NOT a photo editor —
   // resize, rotate, flip, crop-to-square, format conversion, and icon-set
   // generation, which are the operations that actually come up while
   // building a web project on a phone. Everything runs through a canvas
   // and writes back into the Vfs as a data URL, the same storage form
   // images already load as.
   imageViewer: {
       currentFile: null,
       _img: null,

       show(fn) {
           this.currentFile = fn;
           const host = document.getElementById('imageViewerHost');
           const editorView = document.getElementById('editorView');
           if (!host) return;
           if (editorView) editorView.style.display = 'none';
           host.style.display = 'flex';

           const src = Nexus.state.Vfs[fn] || '';

           // A file named like an image whose content isn't a data URL was
           // almost certainly loaded before image support existed, when
           // everything went through readAsText() — which runs binary
           // through a UTF-8 decode and destroys it irreversibly. That's
           // worth naming precisely, and worth offering the one thing that
           // actually fixes it (re-importing), rather than just reporting
           // that decoding failed and leaving you stuck.
           if (!Nexus.Vfs.isDataUrl(src)) {
               const info = document.getElementById('imageViewerInfo');
               if (info) {
                   info.innerHTML =
                       '<div style="color:var(--danger); font-size:12px; line-height:1.5;">' +
                       '<b>This image can\'t be displayed.</b><br>' +
                       'It was loaded before image support existed, so it was stored as text — which permanently corrupts binary data. The original pixels are not recoverable from what\'s saved here.' +
                       '</div>' +
                       '<button class="tool-btn btn-accent" style="width:100%; margin-top:10px;" onclick="Nexus.imageViewer.reimport()">📂 RE-IMPORT THIS IMAGE</button>' +
                       '<div style="font-size:10px; opacity:0.6; margin-top:6px;">Pick the original file again — it will replace <b>' + fn + '</b> in place, keeping its name and path.</div>';
               }
               const canvasWrap = document.getElementById('imageViewerCanvasWrap');
               if (canvasWrap) canvasWrap.innerHTML = '<div style="opacity:0.4; font-size:12px; text-align:center;">no preview</div>';
               this._img = null;
               const st0 = document.getElementById('footStatus');
               if (st0) { st0.innerText = 'IMAGE UNREADABLE'; st0.style.color = 'var(--danger)'; }
               return;
           }

           const img = new Image();
           img.onload = () => { this._img = img; this.render(); };
           img.onerror = () => {
               this._img = null;
               const info = document.getElementById('imageViewerInfo');
               if (info) info.innerHTML = '<div style="color:var(--danger); font-size:12px;">This file could not be decoded as an image. It may have been saved as text before image support existed, which corrupts binary data.</div>';
               const canvasWrap = document.getElementById('imageViewerCanvasWrap');
               if (canvasWrap) canvasWrap.innerHTML = '';
           };
           img.src = src;

           const st = document.getElementById('footStatus');
           if (st) { st.innerText = 'IMAGE'; st.style.color = 'var(--accent)'; }
       },

       // Replaces a corrupted (or simply outdated) image in place, keeping
       // its existing name and folder path so every reference to it
       // elsewhere in the project stays valid. Reads as a data URL, which
       // is the whole point — this is the recovery path for files that
       // were originally read as text and destroyed.
       reimport() {
           const fn = this.currentFile;
           if (!fn) return;
           const picker = document.createElement('input');
           picker.type = 'file';
           picker.accept = 'image/*';
           picker.style.display = 'none';
           picker.onchange = () => {
               const file = picker.files && picker.files[0];
               if (!file) { picker.remove(); return; }
               const reader = new FileReader();
               reader.onload = (e) => {
                   const dataUrl = e.target.result;
                   Nexus.state.Vfs[fn] = dataUrl;
                   Nexus.state.originals[fn] = dataUrl;
                   Nexus.state.lastSavedContent[fn] = dataUrl;
                   Nexus.Vfs.save();
                   Nexus.Vfs.renderAccordion();
                   Nexus.shell.out(`${fn} replaced — image restored.`, 'success');
                   this.show(fn); // re-render, this time with valid data
                   picker.remove();
               };
               reader.onerror = () => {
                   Nexus.shell.out('Could not read that file.', 'error');
                   picker.remove();
               };
               reader.readAsDataURL(file);
           };
           document.body.appendChild(picker);
           picker.click();
       },

       hide() {
           const host = document.getElementById('imageViewerHost');
           const editorView = document.getElementById('editorView');
           if (host) host.style.display = 'none';
           if (editorView) editorView.style.display = '';
           this.currentFile = null;
           this._img = null;
       },

       render() {
           if (!this._img || !this.currentFile) return;
           const fn = this.currentFile;
           const src = Nexus.state.Vfs[fn] || '';

           const wrap = document.getElementById('imageViewerCanvasWrap');
           if (wrap) {
               wrap.innerHTML = '<img src="' + src + '" alt="' + fn + '" style="max-width:100%; max-height:100%; object-fit:contain; display:block; margin:auto;">';
           }

           const info = document.getElementById('imageViewerInfo');
           if (info) {
               const bytes = Nexus.Vfs.dataUrlByteSize(src);
               const sizeText = bytes < 1024 ? bytes + ' B'
                   : bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + ' KB'
                   : (bytes / (1024 * 1024)).toFixed(2) + ' MB';
               const mimeMatch = src.match(/^data:([^;]+);/);
               const mime = mimeMatch ? mimeMatch[1] : 'unknown';
               const ratio = this._gcdRatio(this._img.naturalWidth, this._img.naturalHeight);
               const row = (k, v) => '<div style="display:flex; justify-content:space-between; padding:5px 0; border-bottom:1px solid var(--border); font-size:11px;"><span style="opacity:0.6;">' + k + '</span><span style="font-family:monospace; text-align:right; word-break:break-all;">' + v + '</span></div>';
               info.innerHTML =
                   row('File', fn) +
                   row('Dimensions', this._img.naturalWidth + ' x ' + this._img.naturalHeight + ' px') +
                   row('Aspect ratio', ratio) +
                   row('Format', mime) +
                   row('Size on disk', sizeText) +
                   row('Megapixels', ((this._img.naturalWidth * this._img.naturalHeight) / 1e6).toFixed(2) + ' MP');
           }
       },

       _gcdRatio(w, h) {
           if (!w || !h) return '-';
           const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
           const g = gcd(w, h);
           return (w / g) + ':' + (h / g);
       },

       // Every edit funnels through here: draw the current image into a
       // canvas via a caller-supplied setup function, then write the
       // result back to the Vfs. Centralised so the Vfs/dirty-tracking/
       // re-render bookkeeping is identical for every operation rather
       // than repeated (and eventually diverging) in each one.
       _applyCanvasOp(setup, opLabel) {
           if (!this._img || !this.currentFile) return alert('No image loaded.');
           const fn = this.currentFile;
           const canvas = document.createElement('canvas');
           const ctx = canvas.getContext('2d');
           try {
               setup(canvas, ctx, this._img);
           } catch (e) {
               console.error('image op failed:', e);
               return alert('That edit failed: ' + e.message);
           }

           // An SVG can't be re-encoded through a canvas without
           // rasterising it, which throws away the whole point of a vector
           // file — so edits output PNG unless the source was already a
           // lossy raster format worth preserving in kind.
           const ext = fn.split('.').pop().toLowerCase();
           const outMime = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg'
               : (ext === 'webp') ? 'image/webp'
               : 'image/png';
           const dataUrl = outMime === 'image/png'
               ? canvas.toDataURL(outMime)
               : canvas.toDataURL(outMime, 0.92);

           Nexus.state.Vfs[fn] = dataUrl;
           Nexus.Vfs.save();

           const img = new Image();
           img.onload = () => { this._img = img; this.render(); Nexus.Vfs.renderAccordion(); };
           img.src = dataUrl;

           if (Nexus.shell && typeof Nexus.shell.out === 'function') {
               Nexus.shell.out(opLabel + ' applied to ' + fn + '.', 'success');
           }
       },

       resize() {
           if (!this._img) return alert('No image loaded.');
           const input = prompt('New width in pixels (current: ' + this._img.naturalWidth + '). Height scales to match.', String(this._img.naturalWidth));
           if (!input) return;
           const targetW = parseInt(input, 10);
           if (!targetW || targetW < 1) return alert('Enter a positive number.');
           if (targetW > 8000) return alert('That is larger than 8000px - likely a typo, and big enough to run a phone out of memory.');

           this._applyCanvasOp((canvas, ctx, img) => {
               const scale = targetW / img.naturalWidth;
               canvas.width = targetW;
               canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
               ctx.imageSmoothingQuality = 'high';
               ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
           }, 'Resize');
       },

       rotate(deg) {
           this._applyCanvasOp((canvas, ctx, img) => {
               const w = img.naturalWidth, h = img.naturalHeight;
               // 90 and 270 swap the output canvas dimensions; 180 doesn't.
               const swaps = (deg === 90 || deg === 270);
               canvas.width = swaps ? h : w;
               canvas.height = swaps ? w : h;
               ctx.translate(canvas.width / 2, canvas.height / 2);
               ctx.rotate(deg * Math.PI / 180);
               ctx.drawImage(img, -w / 2, -h / 2);
           }, 'Rotate ' + deg + ' degrees');
       },

       flip(axis) {
           this._applyCanvasOp((canvas, ctx, img) => {
               canvas.width = img.naturalWidth;
               canvas.height = img.naturalHeight;
               ctx.translate(axis === 'h' ? canvas.width : 0, axis === 'v' ? canvas.height : 0);
               ctx.scale(axis === 'h' ? -1 : 1, axis === 'v' ? -1 : 1);
               ctx.drawImage(img, 0, 0);
           }, axis === 'h' ? 'Flip horizontal' : 'Flip vertical');
       },

       cropSquare() {
           this._applyCanvasOp((canvas, ctx, img) => {
               // Centre-crop to the shorter side - the standard way to turn
               // an arbitrary image into a square icon source without
               // distorting it by stretching.
               const size = Math.min(img.naturalWidth, img.naturalHeight);
               const sx = Math.floor((img.naturalWidth - size) / 2);
               const sy = Math.floor((img.naturalHeight - size) / 2);
               canvas.width = size;
               canvas.height = size;
               ctx.drawImage(img, sx, sy, size, size, 0, 0, size, size);
           }, 'Crop to square');
       },

       convertTo(targetExt) {
           if (!this._img || !this.currentFile) return alert('No image loaded.');
           const fn = this.currentFile;
           const canvas = document.createElement('canvas');
           canvas.width = this._img.naturalWidth;
           canvas.height = this._img.naturalHeight;
           const ctx = canvas.getContext('2d');

           // JPEG has no alpha channel, so anything transparent would come
           // out black without flattening onto a white background first -
           // which is what every other tool does when exporting to JPEG.
           if (targetExt === 'jpg') {
               ctx.fillStyle = '#ffffff';
               ctx.fillRect(0, 0, canvas.width, canvas.height);
           }
           ctx.drawImage(this._img, 0, 0);

           const mime = targetExt === 'jpg' ? 'image/jpeg' : targetExt === 'webp' ? 'image/webp' : 'image/png';
           const dataUrl = mime === 'image/png' ? canvas.toDataURL(mime) : canvas.toDataURL(mime, 0.92);

           const base = fn.replace(/\.[^.]+$/, '');
           const newName = base + '.' + targetExt;
           if (Nexus.state.Vfs[newName] !== undefined && !confirm('"' + newName + '" already exists. Overwrite it?')) return;

           Nexus.state.Vfs[newName] = dataUrl;
           Nexus.state.originals[newName] = dataUrl;
           Nexus.state.lastSavedContent[newName] = dataUrl;
           Nexus.Vfs.save();
           Nexus.Vfs.renderAccordion();
           Nexus.Vfs.switchFile(newName);
       },

       // Generates a whole PWA-style icon set in one pass. Each size is
       // centre-cropped square first, so a non-square source doesn't come
       // out stretched, and written as its own file using the same
       // icon-<size>.png naming this app's own manifest already expects.
       makeIcons() {
           if (!this._img) return alert('No image loaded.');
           const defaults = [16, 32, 48, 64, 128, 192, 256, 512];
           const chosen = prompt('Icon sizes to generate (comma-separated px):', defaults.join(', '));
           if (!chosen) return;
           const list = chosen.split(',').map(s => parseInt(s.trim(), 10)).filter(n => n > 0 && n <= 2048);
           if (list.length === 0) return alert('No valid sizes given.');

           const base = this.currentFile.replace(/\.[^.]+$/, '').split('/').pop();
           const img = this._img;
           const srcSize = Math.min(img.naturalWidth, img.naturalHeight);
           const sx = Math.floor((img.naturalWidth - srcSize) / 2);
           const sy = Math.floor((img.naturalHeight - srcSize) / 2);

           let made = 0;
           list.forEach(size => {
               const canvas = document.createElement('canvas');
               canvas.width = size;
               canvas.height = size;
               const ctx = canvas.getContext('2d');
               ctx.imageSmoothingQuality = 'high';
               ctx.drawImage(img, sx, sy, srcSize, srcSize, 0, 0, size, size);
               const dataUrl = canvas.toDataURL('image/png');
               const name = base + '-' + size + '.png';
               Nexus.state.Vfs[name] = dataUrl;
               Nexus.state.originals[name] = dataUrl;
               Nexus.state.lastSavedContent[name] = dataUrl;
               made++;
           });

           Nexus.Vfs.save();
           Nexus.Vfs.renderAccordion();
           alert('Generated ' + made + ' icon' + (made === 1 ? '' : 's') + ' from ' + this.currentFile + '.');
       },

       // Hands the already-open image straight to the sprite tool instead
       // of making you re-pick it from the filesystem - that tool only
       // accepted a fresh file-picker upload before, so an image already
       // in the project simply couldn't be used with it at all.
       sendToSpriteTool() {
           if (!this._img || !this.currentFile) return alert('No image loaded.');
           Nexus.spriteSheet._img = this._img;
           Nexus.spriteSheet._sourceName = this.currentFile;
           Nexus.UI.openModal('sprite');
           const dims = document.getElementById('spriteDims');
           if (dims) dims.innerText = 'Loaded from project: ' + this.currentFile + ' (' + this._img.naturalWidth + 'x' + this._img.naturalHeight + 'px)';
           const canvas = document.getElementById('spriteCanvasPreview');
           if (canvas) {
               canvas.width = this._img.naturalWidth;
               canvas.height = this._img.naturalHeight;
               canvas.style.display = 'block';
               canvas.getContext('2d').drawImage(this._img, 0, 0);
           }
       }
   },

   // Ported from an earlier standalone version of this app that had a
   // dedicated sprite-sheet tool never carried forward into this rewrite.
   // Purely a CSS-generation tool: the uploaded image is only ever drawn
   // into an in-memory canvas to read its real pixel dimensions (needed to
   // compute how many full frames fit) and shown as an on-screen preview —
   // it is never saved into the Vfs or anywhere else. Only the generated
   // CSS text is written to disk, as sprites.css.
   spriteSheet: {
       _img: null,

       handleUpload(e) {
           const file = e.target.files[0];
           if (!file) return;
           const reader = new FileReader();
           reader.onload = (ev) => {
               const img = new Image();
               img.onload = () => {
                   Nexus.spriteSheet._img = img;
                   // A fresh upload isn't a project file, so clear any
                   // source path left over from a previous "use in sprite
                   // tool" handoff — otherwise the generated CSS would
                   // point at the wrong image entirely.
                   Nexus.spriteSheet._sourceName = null;
                   const canvas = document.getElementById('spriteCanvasPreview');
                   const dims = document.getElementById('spriteDims');
                   canvas.width = img.width;
                   canvas.height = img.height;
                   canvas.style.display = 'block';
                   canvas.getContext('2d').drawImage(img, 0, 0);
                   if (dims) dims.innerText = `Loaded: ${img.width}×${img.height}px`;
               };
               img.onerror = () => alert("Couldn't load that as an image.");
               img.src = ev.target.result;
           };
           reader.readAsDataURL(file);
       },

       generate() {
           const st = document.getElementById('spriteStatus');
           if (!this._img) {
               if (st) { st.innerText = 'Upload an image first.'; st.style.color = 'var(--danger)'; }
               return;
           }
           const w = parseInt(document.getElementById('spriteFrameW').value) || 0;
           const h = parseInt(document.getElementById('spriteFrameH').value) || 0;
           if (w <= 0 || h <= 0) {
               if (st) { st.innerText = 'Frame width/height must be positive numbers.'; st.style.color = 'var(--danger)'; }
               return;
           }
           if (w > this._img.width || h > this._img.height) {
               if (st) { st.innerText = 'Frame size is larger than the whole image.'; st.style.color = 'var(--danger)'; }
               return;
           }

           const cols = Math.floor(this._img.width / w);
           const rows = Math.floor(this._img.height / h);
           const total = cols * rows;

           // When the sheet came from a file already in the project (sent
           // over from the image viewer), the CSS can reference its real
           // path directly instead of leaving a placeholder to hand-edit.
           // A fresh file-picker upload still gets the placeholder, since
           // in that case the image genuinely isn't in the project and
           // this tool never saves it.
           const srcPath = this._sourceName || null;
           const urlValue = srcPath || 'YOUR_IMAGE_HERE';

           let css = `/* Generated by divIDE's Sprite Sheet tool.\n`;
           css += ` * Source sheet: ${this._img.width}x${this._img.height}px, ${w}x${h}px frames, ${cols}x${rows} grid (${total} frames).\n`;
           if (srcPath) {
               css += ` * Source file: ${srcPath} (already in this project — the url() below points at it).\n */\n\n`;
           } else {
               css += ` * Replace YOUR_IMAGE_HERE below with the actual path/URL to this sheet\n`;
               css += ` * once it's part of your project — this tool only reads pixel\n`;
               css += ` * dimensions from what you uploaded, it doesn't save the image itself. */\n\n`;
           }
           css += `.sprite {\n    background-image: url('${urlValue}');\n    display: inline-block;\n    width: ${w}px;\n    height: ${h}px;\n    background-repeat: no-repeat;\n}\n\n`;

           let index = 0;
           for (let r = 0; r < rows; r++) {
               for (let c = 0; c < cols; c++) {
                   css += `.sprite-${index} { background-position: -${c * w}px -${r * h}px; }\n`;
                   index++;
               }
           }

           const targetName = Nexus.state.Vfs['sprites.css'] !== undefined
               ? `sprites-${Date.now().toString(36).slice(-4)}.css`
               : 'sprites.css';

           Nexus.state.Vfs[targetName] = css;
           Nexus.state.originals[targetName] = css;
           Nexus.state.lastSavedContent[targetName] = css;
           Nexus.Vfs.renderAccordion();
           Nexus.Vfs.save();

           if (st) { st.innerText = `✔ Saved ${total} frames to ${targetName}.`; st.style.color = 'var(--success)'; }
       }
   },

   // Ported from an earlier standalone version of this app that had a
   // dedicated production-build export — nothing else in the current
   // codebase does actual minification or produces a deployable ZIP.
   // This is deliberately a separate, distinct concept from the existing
   // "⚡ BUNDLE" feature: BUNDLE merges the project into one standalone
   // HTML file for portability/sharing (no minification, no packaging);
   // this produces a minified, individually-packaged ZIP of every file,
   // for actually deploying a built project somewhere. Neither replaces
   // the other.
   buildPipeline: {
       async minifyJS(code) {
           if (typeof Terser === 'undefined' || typeof Terser.minify !== 'function') {
               throw new Error('Terser failed to load — check network/CDN access.');
           }
           const result = await Terser.minify(code, {
               mangle: true,
               compress: { dead_code: true, drop_console: false, drop_debugger: true }
           });
           if (result.error) throw result.error;
           return result.code;
       },

       // CSS gets a simple, safe strip (comments + collapsed whitespace)
       // rather than routed through Terser (which only understands JS) or
       // a full CSS-aware minifier (not currently a dependency this app
       // loads) — matching exactly what the ported feature's own original
       // approach did, since a byte-perfect CSS minifier is a separate,
       // heavier tool this app has no other use for.
       minifyCSS(code) {
           return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
       },

       async run() {
           if (Object.keys(Nexus.state.Vfs).length === 0) {
               return Nexus.shell.out("No files to build — the project is empty.", "warn");
           }
           if (typeof JSZip === 'undefined') {
               return alert("JSZip failed to load — check network/CDN access.");
           }

           const st = document.getElementById('footStatus');
           if (st) { st.innerText = "BUILDING..."; st.style.color = "var(--gold)"; }

           try {
               const zip = new JSZip();
               const buildFolder = zip.folder("production_build");

               const jsFiles = Object.keys(Nexus.state.Vfs).filter(f => f.toLowerCase().endsWith('.js'));
               const cssFiles = Object.keys(Nexus.state.Vfs).filter(f => f.toLowerCase().endsWith('.css'));
               const otherFiles = Object.keys(Nexus.state.Vfs).filter(f => !jsFiles.includes(f) && !cssFiles.includes(f));

               let minifiedCount = 0, failedCount = 0;

               for (const file of jsFiles) {
                   try {
                       const minified = await this.minifyJS(Nexus.state.Vfs[file]);
                       buildFolder.file(file, minified);
                       minifiedCount++;
                   } catch (err) {
                       // Same fallback the ported original used: ship the
                       // unminified original rather than drop the file
                       // from the build entirely over one bad minify pass
                       // (e.g. a syntax Terser's parser is stricter about
                       // than this app's own editor).
                       console.error(`Minification failed for ${file}:`, err);
                       buildFolder.file(file, Nexus.state.Vfs[file]);
                       failedCount++;
                   }
               }

               for (const file of cssFiles) {
                   buildFolder.file(file, this.minifyCSS(Nexus.state.Vfs[file]));
                   minifiedCount++;
               }

               for (const file of otherFiles) {
                   buildFolder.file(file, Nexus.state.Vfs[file]);
               }

               const content = await zip.generateAsync({ type: "blob" });
               const url = URL.createObjectURL(content);
               const a = document.createElement("a");
               a.href = url;
               a.download = `divIDE_Build_${Date.now()}.zip`;
               document.body.appendChild(a);
               a.click();
               document.body.removeChild(a);
               URL.revokeObjectURL(url);

               if (st) { st.innerText = "BUILD READY"; st.style.color = "var(--success)"; setTimeout(() => Nexus.UI.syncStatus(), 2000); }
               if (Nexus.shell && typeof Nexus.shell.out === 'function') {
                   Nexus.shell.out(`📦 Production build downloaded: ${minifiedCount} file(s) minified${failedCount > 0 ? `, ${failedCount} shipped unminified after a Terser error` : ''}, ${otherFiles.length} copied as-is.`, failedCount > 0 ? 'warn' : 'success');
               }
           } catch (e) {
               console.error("Production build failed:", e);
               alert("Build failed: " + e.message);
               if (st) { st.innerText = "BUILD FAILED"; st.style.color = "var(--danger)"; setTimeout(() => Nexus.UI.syncStatus(), 2000); }
           }
       }
   },

   // Debugs the SANDBOXED PROJECT's own localStorage (whatever a
   // still-in-progress game/tool built inside divIDE writes for its own
   // high scores, settings, etc.) — never divIDE's own data, which lives
   // entirely in IndexedDB via localforage/Dexie (neither has a
   // localStorage mode at all), so there's no real risk of this
   // accidentally surfacing or letting someone wipe divIDE's own project
   // files. The KNOWN_PREFIXES filter is kept anyway as cheap defensive
   // insurance in case anything unexpected ever writes to localStorage
   // directly, even though nothing in this app currently does.
   storageInspector: {
       KNOWN_PREFIXES: ['nexus_', 'Nexus.state.', 'devos_', 'settings_'],

       _isOwnKey(key) {
           return this.KNOWN_PREFIXES.some(p => key.startsWith(p)) || key === 'vault_snippets';
       },

       _projectKeys() {
           return Object.keys(localStorage).filter(k => !this._isOwnKey(k));
       },

       render() {
           const container = document.getElementById('storageInspectorList');
           if (!container) return;
           const keys = this._projectKeys();

           if (keys.length === 0) {
               container.innerHTML = '<div style="color:var(--text); opacity:0.6; font-style:italic; font-size:12px; text-align:center; padding:20px 0;">No data found. Run your project (▶️) and it\'ll appear here once it writes to localStorage.</div>';
               return;
           }

           container.innerHTML = keys.map(key => {
               const val = localStorage.getItem(key);
               const safeKey = key.replace(/'/g, "\\'");
               return `
                   <div style="display:flex; flex-direction:column; gap:6px; padding:10px; background:var(--surface); border:1px solid var(--border); border-radius:8px;">
                       <div style="display:flex; justify-content:space-between; align-items:center;">
                           <strong style="color:var(--accent); font-size:12px; word-break:break-all;">${key}</strong>
                           <button class="tool-btn btn-danger" style="padding:2px 8px; font-size:9px; flex-shrink:0; margin-left:8px;" onclick="Nexus.storageInspector.deleteKey('${safeKey}')">DEL</button>
                       </div>
                       <textarea id="storageVal-${btoa(encodeURIComponent(key))}" class="sleek-input" style="width:100%; height:50px; font-size:11px; box-sizing:border-box; resize:vertical;">${(val || '').replace(/</g, '&lt;')}</textarea>
                       <button class="tool-btn" style="width:100%; padding:6px; font-size:10px;" onclick="Nexus.storageInspector.updateKey('${safeKey}')">Update Value</button>
                   </div>`;
           }).join('');
       },

       updateKey(key) {
           const el = document.getElementById(`storageVal-${btoa(encodeURIComponent(key))}`);
           if (!el) return;
           localStorage.setItem(key, el.value);
           if (Nexus.shell && typeof Nexus.shell.out === 'function') Nexus.shell.out(`Updated localStorage key: ${key}`, 'success');
       },

       deleteKey(key) {
           if (!confirm(`Delete localStorage key "${key}"?`)) return;
           localStorage.removeItem(key);
           this.render();
           if (Nexus.shell && typeof Nexus.shell.out === 'function') Nexus.shell.out(`Deleted localStorage key: ${key}`, 'warn');
       },

       openSeeder() {
           const name = prompt("Key name for this data (e.g. 'high_score'):");
           if (!name) return;
           if (this._isOwnKey(name)) return alert("That key name is reserved by divIDE itself — pick a different one.");
           const value = prompt("Value to store (plain text or JSON):");
           if (value === null) return; // cancelled
           localStorage.setItem(name, value);
           this.render();
       },

       clearAll() {
           const keys = this._projectKeys();
           if (keys.length === 0) return alert("Nothing to clear.");
           if (!confirm(`Wipe all ${keys.length} localStorage key(s) from your previewed project? divIDE's own files and settings are unaffected.`)) return;
           keys.forEach(k => localStorage.removeItem(k));
           this.render();
           if (Nexus.shell && typeof Nexus.shell.out === 'function') Nexus.shell.out(`Wiped ${keys.length} localStorage key(s).`, 'warn');
       },

       exportToJSON() {
           const keys = this._projectKeys();
           if (keys.length === 0) return alert("Nothing to export.");
           const data = {};
           keys.forEach(k => data[k] = localStorage.getItem(k));
           const blob = new Blob([JSON.stringify(data, null, 4)], { type: 'application/json' });
           const url = URL.createObjectURL(blob);
           const a = document.createElement('a');
           a.href = url;
           a.download = 'project_localstorage_export.json';
           document.body.appendChild(a);
           a.click();
           document.body.removeChild(a);
           URL.revokeObjectURL(url);
       }
   },

   // Live device-to-device sync over a direct WebRTC data channel via
   // PeerJS — connects two divIDE instances so one can mirror its project
   // to the other with no server storage involved (PeerJS's public broker
   // only helps the two devices find each other; once connected, data
   // flows directly peer-to-peer). Ported from an earlier standalone
   // version of this app that had this feature, rebuilt against this
   // app's real current architecture rather than copied verbatim — the
   // original's design would have silently overwritten Vfs wholesale on
   // every incoming change, with no awareness that Vfs is now split into
   // "loaded files" vs. "open tabs" or that per-file dirty-tracking
   // exists at all. This version treats every incoming sync as an
   // explicit, confirmable action instead of a silent background
   // overwrite — the same posture this app already takes for closing a
   // dirty tab or restoring a snapshot.
   peerSync: {
       peer: null,
       conn: null,
       role: null, // 'host' | 'guest'

       // Six-character room code, uppercase, ambiguous-character-free
       // (no 0/O/1/I) so it's easy to read aloud or type on a phone
       // keyboard without a confusable-character mistake.
       _genCode() {
           const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
           let code = '';
           for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
           return code;
       },

       _setStatus(text, color) {
           const el = document.getElementById('peerSyncStatus');
           if (el) { el.innerText = text; el.style.color = color || 'var(--text)'; }
       },

       // Host: generates a room code and waits for a guest to connect.
       // divIDE's own PeerJS "id" IS the room code (prefixed so it can't
       // collide with someone else's completely unrelated PeerJS app
       // using the same public broker).
       // Real connection timeout — unlike the CM6/GitHub fixes elsewhere
       // in this app, PeerJS's own setup here is fully event-driven
       // (.on('open'), .on('error')) with nothing ever awaited, so a
       // stalled signaling-server connection can't actually freeze the
       // app's execution the way an un-timed-out await could. But it CAN
       // leave the status silently stuck on "Starting…"/"Connecting…"
       // forever with no feedback and no way to tell "still trying" from
       // "will never succeed" — this gives that a real, bounded end
       // instead of indefinite silent waiting.
       CONNECT_TIMEOUT_MS: 15000,

       host() {
           if (typeof Peer === 'undefined') return alert("PeerJS failed to load — check network/CDN access.");
           this.disconnect(); // clean up any previous session first

           const code = this._genCode();
           this._setStatus('Starting…', 'var(--gold)');
           this.role = 'host';
           this.peer = new Peer('divide-' + code);

           let opened = false;
           const timeoutTimer = setTimeout(() => {
               if (opened) return;
               this._setStatus('Could not reach the signaling server — check your connection and try again.', 'var(--danger)');
               this.disconnect();
           }, this.CONNECT_TIMEOUT_MS);

           this.peer.on('open', () => {
               opened = true;
               clearTimeout(timeoutTimer);
               const codeEl = document.getElementById('peerSyncCode');
               if (codeEl) codeEl.innerText = code;
               this._setStatus('Waiting for a device to join…', 'var(--gold)');
           });

           this.peer.on('connection', (conn) => {
               // Only accept one guest at a time — a second incoming
               // connection while already paired is rejected rather than
               // silently juggling two peers with two different views of
               // "the project."
               if (this.conn) { conn.close(); return; }
               this.conn = conn;
               this._wireConnection();
           });

           this.peer.on('error', (err) => {
               clearTimeout(timeoutTimer);
               console.error('PeerSync host error:', err);
               this._setStatus('Error: ' + err.type, 'var(--danger)');
           });
       },

       // Guest: connects to an existing host's room code.
       join(code) {
           if (typeof Peer === 'undefined') return alert("PeerJS failed to load — check network/CDN access.");
           if (!code) return alert("Enter the room code shown on the other device.");
           this.disconnect();

           this.role = 'guest';
           this._setStatus('Connecting…', 'var(--gold)');
           this.peer = new Peer();

           let opened = false;
           const timeoutTimer = setTimeout(() => {
               if (opened) return;
               this._setStatus('Could not reach the signaling server — check your connection and try again.', 'var(--danger)');
               this.disconnect();
           }, this.CONNECT_TIMEOUT_MS);

           this.peer.on('open', () => {
               opened = true;
               clearTimeout(timeoutTimer);
               this.conn = this.peer.connect('divide-' + code.trim().toUpperCase(), { reliable: true });
               this._wireConnection();
           });

           this.peer.on('error', (err) => {
               clearTimeout(timeoutTimer);
               console.error('PeerSync guest error:', err);
               this._setStatus(err.type === 'peer-unavailable' ? 'No device found with that code.' : 'Error: ' + err.type, 'var(--danger)');
           });
       },

       _wireConnection() {
           this.conn.on('open', () => {
               this._setStatus('✔ Connected — ready to sync.', 'var(--success)');
               const controls = document.getElementById('peerSyncControls');
               if (controls) controls.style.display = 'flex';
           });

           this.conn.on('data', (data) => this._handleIncoming(data));

           this.conn.on('close', () => {
               this._setStatus('Disconnected.', 'var(--danger)');
               const controls = document.getElementById('peerSyncControls');
               if (controls) controls.style.display = 'none';
               this.conn = null;
           });

           this.conn.on('error', (err) => {
               console.error('PeerSync connection error:', err);
               this._setStatus('Connection error.', 'var(--danger)');
           });
       },

       // Explicit push — the person taps "Send My Project," not something
       // that fires automatically on every keystroke. Continuous
       // background sync (the old version's actual design) means every
       // typo gets mirrored instantly to the other device with no chance
       // to review anything first; an explicit action matches how every
       // other cross-device operation in this app already works (GitHub
       // push/pull is also always explicit, never automatic).
       sendProject() {
           if (!this.conn || !this.conn.open) return alert("Not connected.");
           this.conn.send({
               type: 'project-sync',
               vfs: Nexus.state.Vfs,
               originals: Nexus.state.originals
           });
           this._setStatus('Sent — waiting for the other device to accept.', 'var(--gold)');
       },

       _handleIncoming(data) {
           if (!data || data.type !== 'project-sync') return;

           const dirtyTabs = (Nexus.state.openTabs || []).filter(fn => Nexus.Vfs.isDirty(fn));
           const fileCount = Object.keys(data.vfs || {}).length;
           const warning = dirtyTabs.length > 0
               ? `\n\n⚠️ You have unsaved changes in: ${dirtyTabs.join(', ')} — these will be lost.`
               : '';

           const accept = confirm(`The other device wants to sync ${fileCount} file(s) to this one. This replaces your entire current project.${warning}`);
           if (!accept) {
               this._setStatus('Incoming sync declined.', 'var(--text)');
               return;
           }

           const incomingVfs = JSON.parse(JSON.stringify(data.vfs || {}));
           const incomingOriginals = JSON.parse(JSON.stringify(data.originals || incomingVfs));

           Nexus.state.Vfs = incomingVfs;
           Nexus.state.originals = incomingOriginals;
           Nexus.state.lastSavedContent = JSON.parse(JSON.stringify(incomingVfs));
           Nexus.state.openTabs = (Nexus.state.openTabs || []).filter(fn => incomingVfs[fn] !== undefined);
           Nexus.Vfs.saveOpenTabs();

           const files = Object.keys(incomingVfs);
           const reopenTarget = (Nexus.state.activeFile && incomingVfs[Nexus.state.activeFile] !== undefined)
               ? Nexus.state.activeFile
               : files[0];

           Nexus.Vfs.save();
           Nexus.Vfs.renderAccordion();
           if (reopenTarget) {
               Nexus.Vfs.switchFile(reopenTarget);
           } else {
               Nexus.Vfs.setEmptyState();
           }

           this._setStatus(`✔ Synced ${fileCount} file(s) from the other device.`, 'var(--success)');
       },

       disconnect() {
           if (this.conn) { try { this.conn.close(); } catch (e) {} this.conn = null; }
           if (this.peer) { try { this.peer.destroy(); } catch (e) {} this.peer = null; }
           this.role = null;
           this._setStatus('Not connected.', 'var(--text)');
           const controls = document.getElementById('peerSyncControls');
           if (controls) controls.style.display = 'none';
           const codeEl = document.getElementById('peerSyncCode');
           if (codeEl) codeEl.innerText = '';
       }
   },

   defrag: {
       runJS() {
           if (!Nexus.state.activeFile.endsWith('.js')) return alert("Select .js file.");
           try {
               const ast = acorn.parse(Nexus.state.Vfs[Nexus.state.activeFile], { ecmaVersion: 2022, sourceType: 'module' });
               const b = { imp: [], var: [], cls: [], fun: [], exe: [] };
               ast.body.forEach(n => {
                   if (n.type === 'ImportDeclaration') b.imp.push(n);
                   else if (n.type === 'VariableDeclaration') b.var.push(n);
                   else if (n.type === 'ClassDeclaration') b.cls.push(n);
                   else if (n.type === 'FunctionDeclaration') b.fun.push(n);
                   else b.exe.push(n);
               });
               ast.body = [...b.imp, ...b.var, ...b.cls, ...b.fun, ...b.exe];
               Nexus.state.Vfs[Nexus.state.activeFile] = js_beautify(astring.generate(ast), { indent_size: Nexus.state.prefs.tabWidth });
               Nexus.Vfs.save(); 
               Nexus.Vfs.switchFile(Nexus.state.activeFile);
           } catch (e) { alert("AST Syntax Fault: " + e.message); }
       },
       sequenceHTML() {
           const doc = new DOMParser().parseFromString(Nexus.state.Vfs[Nexus.state.activeFile], 'text/html');
           doc.querySelectorAll('style').forEach(s => doc.head.appendChild(s));
           doc.querySelectorAll('script').forEach(s => doc.body.appendChild(s));
           Nexus.state.Vfs[Nexus.state.activeFile] = html_beautify(doc.documentElement.outerHTML, { indent_size: Nexus.state.prefs.tabWidth });
           Nexus.Vfs.save(); 
           Nexus.Vfs.switchFile(Nexus.state.activeFile);
       }
   },
   vault: {
               async boot() { 
           try {
               // 1. Attempt to load from Dexie
               const records = await db.vault.toArray();
               if (records.length > 0) {
                   // Map Dexie's schema back to the RAM array structure
                   Nexus.state.vault = records.map(r => ({ name: r.title, code: r.content, id: r.id }));
               } else {
                   // 2. Fallback & Migrate legacy LocalForage snippets
                   const saved = await safeStorage.getItem('nexus_vault_v40'); 
                   if (saved && saved.length > 0) { 
                       Nexus.state.vault = saved; 
                       // Push them into the new Dexie table
                       const bulk = saved.map(s => ({ title: s.name, category: 'migrated', content: s.code }));
                       await db.vault.bulkAdd(bulk);
                   }
               }
               this.render(); 
           } catch (e) {
               console.error("Vault Boot Failure:", e);
           }
       },

       async save() { 
           try {
               // Wipe and rewrite to ensure exact synchronization with the RAM array
               await db.vault.clear();
               const bulk = Nexus.state.vault.map(s => ({ title: s.name, category: 'general', content: s.code }));
               await db.vault.bulkAdd(bulk);
               
               // Keep localforage updated as a temporary failsafe backup
               safeStorage.setItem('nexus_vault_v40', Nexus.state.vault); 
           } catch (e) {
               console.error("Vault Sync Failure:", e);
           }
       },
grab() { 
           const ed = document.getElementById('rawTerminal'); 
           const code = ed.value.substring(ed.selectionStart, ed.selectionEnd) || ed.value; 
           const name = prompt("Snippet Name:"); 
           if (name) { 
               Nexus.state.vault.push({ name, code }); 
               this.save(); this.render(); 
           } 
       },
       inject(i) { 
           const ed = document.getElementById('rawTerminal'); 
           if (!Nexus.UI.needUnlocked('Injecting a snippet', () => Nexus.vault.inject(i))) return; 
           const pos = ed.selectionStart; 
           ed.value = ed.value.substring(0, pos) + Nexus.state.vault[i].code + ed.value.substring(ed.selectionEnd); 
           Nexus.state.Vfs[Nexus.state.activeFile] = ed.value; 
           Nexus.Vfs.save(); 
           Nexus.UI.closeModal('vault'); 
       },
       cutFile() {
           if(!Nexus.state.activeFile) return Nexus.shell.out("No file active.", "warn");
           const ed = document.getElementById('rawTerminal');
           if (!Nexus.UI.needUnlocked('Cut', () => Nexus.vault.cutFile())) return;
           if (confirm(`✂ Strip all code from ${Nexus.state.activeFile} and archive to Vault?`)) { 
               Nexus.state.vault.push({ name: Nexus.state.activeFile + ' (Cut)', code: ed.value });
               ed.value = "";
               Nexus.state.Vfs[Nexus.state.activeFile] = "";
               Nexus.Vfs.save(); this.save(); this.render();
           } 
       },
       copyFile() { 
           if(!Nexus.state.activeFile) return Nexus.shell.out("No file active.", "warn");
           const ed = document.getElementById('rawTerminal');
           Nexus.state.vault.push({ name: Nexus.state.activeFile + ' (Copy)', code: ed.value });
           this.save(); this.render(); 
           alert(`Payload from ${Nexus.state.activeFile} copied to Vault.`); 
       },
       render(q = "") { 
           const c = document.getElementById('vaultContent'); 
           if (!c) return; 
           const filtered = Nexus.state.vault.filter(s => s.name.toLowerCase().includes(q.toLowerCase())); 
           c.innerHTML = filtered.map((s, i) => `
               <div class="item-row" style="flex-direction:column; align-items:flex-start;">
                   <div style="display:flex; justify-content:space-between; width:100%;">
                       <strong>${s.name}</strong>
                       <div style="display:flex; gap:8px;">
                           <button class="tool-btn btn-accent" onclick="Nexus.vault.inject(${i})">INJECT</button>
                           <button class="tool-btn btn-danger" onclick="Nexus.vault.deleteSnippet(${i})">&times;</button>
                       </div>
                   </div>
               </div>`).join('') || "Vault Empty."; 
       },
       deleteSnippet(i) { Nexus.state.vault.splice(i,1); this.save(); this.render(); },
       store(name, code, category = 'general') {
           Nexus.state.vault.push({ name, code, category });
           this.save(); this.render();
       }
   },

   snapshots: {
       async boot() { 
           const saved = await safeStorage.getItem('nexus_snapshots_v40'); 
           if (saved) Nexus.state.snapshots = saved; 
           this.render(); 
       },
       save() { safeStorage.setItem('nexus_snapshots_v40', Nexus.state.snapshots); },
       create() { 
           Nexus.state.snapshots.push({ 
               time: new Date().toLocaleTimeString(), 
               data: JSON.parse(JSON.stringify(Nexus.state.Vfs)) 
           }); 
           if (Nexus.state.snapshots.length > 10) Nexus.state.snapshots.shift(); 
           this.save(); this.render(); 
           Nexus.shell.out("Snapshot saved.", "success"); 
       },
       // Renders into BOTH surfaces snapshots can now be acted on from:
       // #mergeSnapshotList (unchanged — the existing per-file diff-against-
       // current-file entry point, reached from inside the Merge modal) and
       // the new #snapshotBrowserList (a real, standalone Snapshots
       // browser reachable directly from the 📸 button itself, which is
       // where this app's own 📸 SNAPSHOT button actually lives — right
       // above the file explorer, nowhere near Merge). Previously the only
       // way to ever see a snapshot again was to already know it was
       // hiding inside an unrelated modal; snapshots themselves worked
       // (saved/loaded correctly), this was purely a discoverability gap.
       render() { 
           const m = document.getElementById('mergeSnapshotList'); 
           if (m) m.innerHTML = Nexus.state.snapshots.map((s, i) => `
               <div class="item-row" onclick="Nexus.mergeEngine.initiate(Nexus.state.snapshots[${i}].data['${Nexus.state.activeFile}'])">
                   <span>${s.time}</span> <span style="color:var(--gold)">DIFF →</span>
               </div>`).reverse().join('') || "No Snapshots."; 

           const b = document.getElementById('snapshotBrowserList');
           if (b) b.innerHTML = Nexus.state.snapshots.map((s, i) => {
               const fileCount = Object.keys(s.data).length;
               return `
               <div class="item-row" style="flex-direction:column; align-items:stretch; gap:8px; cursor:default;">
                   <div style="display:flex; justify-content:space-between; align-items:center;">
                       <span>${s.time}</span>
                       <span style="opacity:0.6; font-size:11px;">${fileCount} file${fileCount === 1 ? '' : 's'}</span>
                   </div>
                   <div style="display:flex; gap:8px;">
                       <button class="tool-btn" style="flex:1; padding:8px; font-size:10px;" onclick="Nexus.mergeEngine.initiate(Nexus.state.snapshots[${i}].data['${Nexus.state.activeFile}']); Nexus.UI.closeModal('snapshots')">Diff Current File</button>
                       <button class="tool-btn btn-accent" style="flex:1; padding:8px; font-size:10px;" onclick="Nexus.snapshots.restoreProject(${i})">Restore Whole Project</button>
                   </div>
               </div>`;
           }).reverse().join('') || '<div style="padding:16px; text-align:center; opacity:0.6; font-size:12px;">No snapshots yet — tap 📸 SNAPSHOT in the file explorer to create one.</div>';
       },

       // Real project-wide restore, not just a diff source — this is the
       // actual fix for the routing gap: the 📸 button implies "checkpoint
       // my whole project," and until now there was no way to act on that
       // implication at all, only to diff one file against Merge.
       // Wholesale-replaces Vfs/originals/lastSavedContent with the
       // snapshot's own captured data, keyed the same way Vfs.clearAll()
       // resets things, then reopens whatever tab was active if it still
       // exists in the restored set.
       async restoreProject(index) {
           const snap = Nexus.state.snapshots[index];
           if (!snap) return;

           // Reuses the exact same dirty-check this app already relies on
           // for closeTab() — restoring wholesale is strictly more
           // destructive than closing one tab, so it deserves at least the
           // same warning, not less. Checks every open tab, not just the
           // active one, since restore replaces everything at once.
           const dirtyTabs = Nexus.state.openTabs.filter(fn => Nexus.Vfs.isDirty(fn));
           if (dirtyTabs.length > 0) {
               const proceed = confirm(
                   `Restoring "${snap.time}" will replace your ENTIRE project with this snapshot.\n\n` +
                   `You have unsaved changes in: ${dirtyTabs.join(', ')}\n\n` +
                   `These changes will be lost. Continue?`
               );
               if (!proceed) return;
           } else {
               const proceed = confirm(`Restore your entire project to the "${snap.time}" snapshot? This replaces every current file.`);
               if (!proceed) return;
           }

           const restored = JSON.parse(JSON.stringify(snap.data));
           Nexus.state.Vfs = restored;
           Nexus.state.originals = JSON.parse(JSON.stringify(restored));
           Nexus.state.lastSavedContent = JSON.parse(JSON.stringify(restored));
           // Keep only tabs for files that still exist in the restored
           // set — a tab for a file the snapshot doesn't have would point
           // at nothing.
           Nexus.state.openTabs = Nexus.state.openTabs.filter(fn => restored[fn] !== undefined);
           Nexus.Vfs.saveOpenTabs();

           const files = Object.keys(restored);
           const reopenTarget = (Nexus.state.activeFile && restored[Nexus.state.activeFile] !== undefined)
               ? Nexus.state.activeFile
               : files[0];

           await Nexus.Vfs.save();
           Nexus.Vfs.renderAccordion();
           if (reopenTarget) {
               Nexus.Vfs.switchFile(reopenTarget);
           } else {
               Nexus.Vfs.setEmptyState();
           }

           Nexus.UI.closeModal('snapshots');
           alert(`Project restored to snapshot from ${snap.time}.`);
       }
   },
// Add this inside the Nexus.UI object

    
// FIX (Merge was fundamentally broken): choose('left')/choose('right') used
// to check current.removed / current.added respectively — but a single
// jsdiff hunk is EITHER removed OR added, never both, so tapping "Take
// Right" on a removed-only hunk (or "Take Left" on an added-only hunk)
// silently pushed nothing at all. The three-button "Left/Both/Right" model
// assumed every conflict has two sides to pick from, but that's only true
// for genuine replacements (jsdiff emits those as two CONSECUTIVE hunks —
// a `removed` one immediately followed by an `added` one — this is
// documented diffLines behavior, not a guess). A real fix has to
// distinguish three real cases: a replacement pair (both sides exist —
// offer Left/Right/Both/Skip), a pure deletion (only Left exists — offer
// Keep/Discard), and a pure insertion (only Right exists — offer
// Keep/Discard). Also fixes: unbounded synchronous auto-skip recursion on
// runs of unchanged hunks (now a loop, not self-recursion), full
// re-render on every single auto-skipped hunk (now renders once per user-
// facing decision), and finish() always creating a new file with no way
// to save back into an existing one.
// Rebuilt as two genuinely different modes for building a third file out of
// two existing ones, not two views bolted onto the same broken one-hunk-at-
// a-time flow. QUICK shows every difference at once with its own inline
// controls (pick in any order, revisit any decision); MANUAL hands you a
// single editable textarea pre-seeded with unchanged lines plus both sides
// of every conflict clearly marked, to resolve by typing directly.
merge: {
    hunks: [],
    decisions: [], // parallel array to hunks: 'left' | 'right' | 'both' | 'skip' | null (unresolved)
    mode: 'quick',

    open() {
        // Populate selectors with all Vfs files
        const files = Object.keys(Nexus.state.Vfs);
        const lSel = document.getElementById('mergeLeftSel');
        const rSel = document.getElementById('mergeRightSel');
        
        const options = files.map(f => `<option value="${f}">${f}</option>`).join('');
        lSel.innerHTML = options;
        rSel.innerHTML = options;
        // Sensible default so opening Merge immediately shows something
        // rather than an empty comparison of whatever happened to be
        // first in both dropdowns.
        if (files.length > 1) rSel.value = files.find(f => f !== lSel.value) || files[1];

        // Refresh the snapshot list every time this modal opens — it was
        // previously only re-rendered on boot and right after creating a
        // new snapshot, so opening Merge later in the same session
        // (without creating another snapshot first) could show a stale or
        // empty list even when snapshots existed in storage.
        if (typeof Nexus.snapshots?.render === 'function') Nexus.snapshots.render();
        
        Nexus.UI.openModal('merge');
        this.start();
    },

    start() {
        const leftFile = document.getElementById('mergeLeftSel').value;
        const rightFile = document.getElementById('mergeRightSel').value;
        if (!leftFile || !rightFile) {
            document.getElementById('mergeProgress').innerText = 'Select two files to begin.';
            return;
        }
        
        const leftText = Nexus.state.Vfs[leftFile] || '';
        const rightText = Nexus.state.Vfs[rightFile] || '';
        
        this.hunks = Diff.diffLines(leftText, rightText);
        // Unchanged hunks are auto-resolved from the start (nothing to
        // decide); conflicts start unresolved (null) so Build Result can
        // warn about anything still needing a real decision.
        this.decisions = this.hunks.map(h => (h.added || h.removed) ? null : 'both');
        this.render();
    },

    setMode(mode) {
        if (mode === this.mode) return;
        this.mode = mode;
        document.getElementById('mergeModeQuickBtn').classList.toggle('btn-accent', mode === 'quick');
        document.getElementById('mergeModeManualBtn').classList.toggle('btn-accent', mode === 'manual');
        this.render();
    },

    render() {
        document.getElementById('mergeQuickView').style.display = this.mode === 'quick' ? 'block' : 'none';
        document.getElementById('mergeManualView').style.display = this.mode === 'manual' ? 'block' : 'none';
        if (this.mode === 'quick') this._renderQuick();
        else this._renderManual();
    },

    // True only for a genuine replacement: this hunk is removed AND the
    // very next one is added. This exact adjacency is how diffLines
    // represents "this line became that line" — documented jsdiff output
    // shape, not a guess.
    _isReplacePair(i) {
        const cur = this.hunks[i], next = this.hunks[i + 1];
        return !!(cur && cur.removed && next && next.added);
    },

    // QUICK MODE — every hunk rendered at once, each with its own inline
    // controls. Replacement pairs (a removed hunk immediately followed by
    // an added one) are rendered and decided together as a single row;
    // one-sided hunks (pure insertion or pure deletion) get a single
    // Keep/Skip choice instead of a meaningless three-way pick.
    _renderQuick() {
        const view = document.getElementById('mergeQuickView');
        let html = '';
        let unresolvedCount = 0;

        for (let i = 0; i < this.hunks.length; i++) {
            const h = this.hunks[i];
            if (!h.added && !h.removed) {
                html += `<div style="color:var(--text); opacity:0.5; padding:2px 8px; white-space:pre-wrap;">  ${this._esc(h.value)}</div>`;
                continue;
            }

            const isPair = this._isReplacePair(i);
            const decision = this.decisions[i];
            if (decision === null) unresolvedCount++;

            if (isPair) {
                const removedHunk = h, addedHunk = this.hunks[i + 1];
                html += this._renderConflictRow(i, removedHunk.value, addedHunk.value, decision, true);
                i++; // consumed the paired added hunk too
            } else if (h.removed) {
                html += this._renderConflictRow(i, h.value, null, decision, false);
            } else { // pure addition
                html += this._renderConflictRow(i, null, h.value, decision, false);
            }
        }

        view.innerHTML = html || '<div style="opacity:0.6; padding:20px; text-align:center;">No differences — both files are identical.</div>';
        document.getElementById('mergeProgress').innerText = unresolvedCount > 0
            ? `${unresolvedCount} unresolved difference${unresolvedCount === 1 ? '' : 's'}`
            : `All differences resolved (${this.hunks.filter((h,i)=>h.added||h.removed).length} total).`;
    },

    _renderConflictRow(i, leftVal, rightVal, decision, isPair) {
        const btn = (value, label, cls) => `<button class="tool-btn ${cls}" style="font-size:10px; padding:4px 8px;" onclick="Nexus.merge.decide(${i}, '${value}')">${decision === value ? '✔ ' : ''}${label}</button>`;
        let buttons = '';
        if (isPair) {
            buttons = btn('left', 'LEFT', 'btn-danger') + btn('right', 'RIGHT', 'btn-accent') + btn('both', 'BOTH', 'btn-gold') + btn('skip', 'SKIP', '');
        } else if (leftVal !== null) {
            buttons = btn('left', 'KEEP', 'btn-danger') + btn('skip', 'SKIP', '');
        } else {
            buttons = btn('right', 'KEEP', 'btn-accent') + btn('skip', 'SKIP', '');
        }

        const borderColor = decision === null ? 'var(--gold)' : 'var(--border)';
        let body = '';
        if (leftVal !== null) body += `<div style="color:var(--danger); white-space:pre-wrap;">- ${this._esc(leftVal)}</div>`;
        if (rightVal !== null) body += `<div style="color:var(--success); white-space:pre-wrap;">+ ${this._esc(rightVal)}</div>`;

        return `<div style="border:1px solid ${borderColor}; border-radius:6px; margin:4px 0; padding:6px 8px;">
            <div style="display:flex; justify-content:flex-end; gap:6px; margin-bottom:4px;">${buttons}</div>
            ${body}
        </div>`;
    },

    decide(i, value) {
        this.decisions[i] = value;
        this._renderQuick();
    },

    // MANUAL MODE — a single flat text blob. Unchanged lines pass through
    // as-is; every conflict (pair or one-sided) is wrapped in plain
    // <<<LEFT / === / RIGHT>>> markers, the same convention real merge
    // tools use, so it reads clearly even to someone who's never used
    // this specific app before. Regenerated fresh from the hunks every
    // time you switch into this mode — it does not try to reflect
    // whatever was already decided in Quick mode, since translating
    // partial per-hunk decisions into markers and back is more complexity
    // than it's worth; the two modes are independent means to the same
    // end, not a synced pair.
    _renderManual() {
        let text = '';
        for (let i = 0; i < this.hunks.length; i++) {
            const h = this.hunks[i];
            if (!h.added && !h.removed) { text += h.value; continue; }

            if (this._isReplacePair(i)) {
                text += `<<<LEFT\n${this.hunks[i].value}===\n${this.hunks[i + 1].value}>>>RIGHT\n`;
                i++;
            } else if (h.removed) {
                text += `<<<LEFT (only on the left — delete this whole marked block to drop it)\n${h.value}>>>RIGHT\n`;
            } else {
                text += `<<<LEFT (only on the right — delete this whole marked block to drop it)\n${h.value}>>>RIGHT\n`;
            }
        }
        document.getElementById('mergeManualView').value = text;
        document.getElementById('mergeProgress').innerText = 'Edit directly — resolve or delete each <<<LEFT / >>>RIGHT block.';
    },

    _esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;'); },

    async finish() {
        let mergedContent;

        if (this.mode === 'manual') {
            mergedContent = document.getElementById('mergeManualView').value;
            if (/<<<LEFT|>>>RIGHT/.test(mergedContent)) {
                if (!confirm("There are still unresolved <<<LEFT/>>>RIGHT markers in the text. Build anyway?")) return;
            }
        } else {
            const unresolved = this.decisions.filter(d => d === null).length;
            if (unresolved > 0 && !confirm(`${unresolved} difference(s) are still unresolved and will be skipped. Build anyway?`)) return;

            const parts = [];
            for (let i = 0; i < this.hunks.length; i++) {
                const h = this.hunks[i];
                const decision = this.decisions[i];
                if (!h.added && !h.removed) { parts.push(h.value); continue; }

                if (this._isReplacePair(i)) {
                    if (decision === 'left') parts.push(this.hunks[i].value);
                    if (decision === 'right') parts.push(this.hunks[i + 1].value);
                    if (decision === 'both') { parts.push(this.hunks[i].value); parts.push(this.hunks[i + 1].value); }
                    i++;
                } else if (decision === 'left' || decision === 'right') {
                    parts.push(h.value);
                }
            }
            mergedContent = parts.join('');
        }

        const leftFile = document.getElementById('mergeLeftSel').value;
        const rightFile = document.getElementById('mergeRightSel').value;
        const dot = leftFile.lastIndexOf('.');
        const suggestedName = dot === -1 ? leftFile + '.merged' : leftFile.slice(0, dot) + '.merged' + leftFile.slice(dot);
        const mergedName = await Nexus.UI.askInput({
            title: 'SAVE MERGED FILE',
            label: 'Filename for the merged result',
            value: suggestedName,
            hint: 'An existing name will be overwritten — you will be warned first.',
            validate: (v) => {
                const t = (v || '').trim();
                if (!t) return 'Enter a filename.';
                if (Nexus.state.Vfs[t] !== undefined) return `"${t}" already exists. Change the name, or tap OK again to overwrite it.`;
                return null;
            },
            allowOverwriteOnSecondSubmit: true
        });
        if (!mergedName) return;

        const isNewFile = Nexus.state.Vfs[mergedName] === undefined;
        Nexus.state.Vfs[mergedName] = mergedContent;
        if (isNewFile) {
            Nexus.state.originals[mergedName] = mergedContent;
            Nexus.state.lastSavedContent[mergedName] = mergedContent;
        }

        Nexus.Vfs.save();
        Nexus.Vfs.renderAccordion();
        Nexus.UI.closeModal('merge');
        Nexus.Vfs.switchFile(mergedName);
        alert(`Merged result saved as "${mergedName}".`);
    }
},

// N-WAY VARIANT MERGE ("Chronos Swipes").
// Pick one file as MASTER, load any number of variant files, and walk down
// master stopping at every spot where at least one variant disagrees. Each
// stop offers every distinct version of that spot (master's own included),
// cycled with swipe-left/right or buttons, and Build assembles a new file
// from the choices.
//
// The alignment algorithm was prototyped and tested against real jsdiff
// before any of this UI existed — including the cases that break naive
// implementations: pure deletions, insertions at start-of-file, appends at
// end-of-file (zero-width regions, which a plain range-overlap test drops
// entirely), variants that happen to agree with master, and three-way
// conflicts at the same spot. Assembly with all-master choices was verified
// to reproduce the original file byte-for-byte.
variantMerge: {
    master: null,        // filename
    variants: [],        // [{ name, text }]
    regions: [],         // [{ masterStart, masterEnd, options:[{label,lines,sources}] }]
    choices: [],         // index into each region's options
    current: 0,          // which region is on screen

    // One master-vs-variant diff -> { masterStart, masterEnd, replacement }
    // changes, master line indices 0-based, masterEnd exclusive. A pure
    // insertion is zero-width (masterStart === masterEnd).
    _changesFor(masterText, variantText) {
        const hunks = Diff.diffLines(masterText, variantText);
        const changes = [];
        let mLine = 0;
        for (let i = 0; i < hunks.length; i++) {
            const h = hunks[i];
            const lines = h.value.endsWith('\n') ? h.value.split('\n').slice(0, -1) : h.value.split('\n');
            const count = lines.length;
            if (h.removed) {
                const next = hunks[i + 1];
                if (next && next.added) {
                    // removed-immediately-followed-by-added is jsdiff's
                    // representation of "this changed" (same adjacency the
                    // 2-file Merge already relies on), not a delete plus an
                    // unrelated insert.
                    const nextLines = next.value.endsWith('\n') ? next.value.split('\n').slice(0, -1) : next.value.split('\n');
                    changes.push({ masterStart: mLine, masterEnd: mLine + count, replacement: nextLines });
                    i++;
                } else {
                    changes.push({ masterStart: mLine, masterEnd: mLine + count, replacement: [] });
                }
                mLine += count;
            } else if (h.added) {
                changes.push({ masterStart: mLine, masterEnd: mLine, replacement: lines });
            } else {
                mLine += count;
            }
        }
        return changes;
    },

    _masterLines() {
        const t = Nexus.state.Vfs[this.master] || '';
        return t.endsWith('\n') ? t.split('\n').slice(0, -1) : t.split('\n');
    },

    computeRegions() {
        const masterText = Nexus.state.Vfs[this.master] || '';
        const masterLines = this._masterLines();
        const perVariant = this.variants.map(v => ({ name: v.name, changes: this._changesFor(masterText, v.text) }));

        // Every variant's change ranges, merged into shared decision regions.
        let ranges = [];
        perVariant.forEach(v => v.changes.forEach(c => ranges.push([c.masterStart, c.masterEnd])));
        ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const merged = [];
        for (const r of ranges) {
            const last = merged[merged.length - 1];
            if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
            else merged.push([r[0], r[1]]);
        }

        this.regions = merged.map(([s, e]) => {
            const options = [{ label: 'MASTER', lines: masterLines.slice(s, e), sources: [this.master] }];
            perVariant.forEach(v => {
                // Relevance filter handles zero-width insertions explicitly:
                // a plain overlap test misses them, and when the REGION is
                // itself zero-width (an end-of-file append) a naive
                // "start >= end -> stop" check drops it before it's read.
                const relevant = v.changes.filter(ch =>
                    ch.masterStart === ch.masterEnd
                        ? (ch.masterStart >= s && ch.masterStart <= e)
                        : (ch.masterStart < e && ch.masterEnd > s)
                ).sort((a, b) => a.masterStart - b.masterStart);

                const out = [];
                let pos = s;
                for (const ch of relevant) {
                    if (ch.masterStart > pos) out.push(...masterLines.slice(pos, ch.masterStart));
                    out.push(...ch.replacement);
                    pos = Math.max(pos, ch.masterEnd);
                }
                if (pos < e) out.push(...masterLines.slice(pos, e));

                // Collapse variants that produce identical text for this
                // region into one option listing all of them, so you're
                // choosing between genuinely distinct versions rather than
                // paging through duplicates.
                const key = out.join('\n');
                const existing = options.find(o => o.lines.join('\n') === key);
                if (existing) existing.sources.push(v.name);
                else options.push({ label: v.name, lines: out, sources: [v.name] });
            });
            return { masterStart: s, masterEnd: e, options };
        });

        this.choices = this.regions.map(() => 0);
        this.current = 0;
    },

    open() {
        const files = Object.keys(Nexus.state.Vfs);
        const mSel = document.getElementById('vmMasterSel');
        if (mSel) {
            mSel.innerHTML = files.map(f => `<option value="${f}">${f}</option>`).join('');
            if (Nexus.state.activeFile) mSel.value = Nexus.state.activeFile;
        }
        this.master = mSel ? mSel.value : files[0];
        this.variants = [];
        this.regions = [];
        this.renderVariantPicker();
        this.render();
        Nexus.UI.openModal('variant-merge');
    },

    renderVariantPicker() {
        const box = document.getElementById('vmVariantList');
        if (!box) return;
        const files = Object.keys(Nexus.state.Vfs).filter(f => f !== this.master);
        // Variants pulled from GitHub history don't exist in the Vfs at
        // all, so listing only Vfs files would silently hide them even
        // though they're loaded and will be compared. Shown separately,
        // with a remove control, so what's actually in play is visible.
        const external = this.variants.filter(v => Nexus.state.Vfs[v.name] === undefined);

        let html = '';
        if (files.length === 0 && external.length === 0) {
            box.innerHTML = '<div style="opacity:0.6; font-size:11px; padding:8px;">No other files loaded to compare against. Load more files, or pull past versions from GitHub below.</div>';
            return;
        }
        html += files.map(f => {
            const on = this.variants.some(v => v.name === f);
            return `<label style="display:flex; align-items:center; gap:8px; padding:6px 8px; font-size:11px; font-family:monospace;">
                <input type="checkbox" ${on ? 'checked' : ''} onchange="Nexus.variantMerge.toggleVariant('${f.replace(/'/g, "\\'")}', this.checked)" style="width:16px; height:16px;">
                <span>${f}</span>
            </label>`;
        }).join('');
        if (external.length) {
            // Split by prefix so the list says where each version actually
            // came from — a flat "external" group would lump snapshot and
            // GitHub versions together and make them indistinguishable.
            const snaps = external.filter(v => v.name.startsWith('snap:'));
            const gits  = external.filter(v => v.name.startsWith('git:'));
            const other = external.filter(v => !v.name.startsWith('snap:') && !v.name.startsWith('git:'));
            const group = (title, list) => list.length ? (
                `<div style="font-size:9px; opacity:0.5; padding:6px 8px 2px;">${title}</div>` +
                list.map(v => `<div style="display:flex; align-items:center; gap:8px; padding:6px 8px; font-size:11px; font-family:monospace;">
                    <span style="color:var(--gold);">✓</span>
                    <span style="flex:1;">${v.name}</span>
                    <span style="color:var(--danger); cursor:pointer; padding:0 6px;" onclick="Nexus.variantMerge.toggleVariant('${v.name.replace(/'/g, "\\'")}', false); Nexus.variantMerge.renderVariantPicker();">&times;</span>
                </div>`).join('')
            ) : '';
            html += group('FROM SNAPSHOTS', snaps);
            html += group('FROM GITHUB HISTORY', gits);
            html += group('LOADED VERSIONS', other);
        }
        box.innerHTML = html;
    },

    toggleVariant(name, on) {
        if (on) {
            if (!this.variants.some(v => v.name === name)) {
                this.variants.push({ name, text: Nexus.state.Vfs[name] || '' });
            }
        } else {
            this.variants = this.variants.filter(v => v.name !== name);
        }
    },

    setMaster(name) {
        this.master = name;
        // Master can't also be a variant of itself.
        this.variants = this.variants.filter(v => v.name !== name);
        this.regions = [];
        this.renderVariantPicker();
        this.render();
    },

    analyze() {
        if (!this.master) return alert("Pick a master file first.");
        if (this.variants.length === 0) return alert("Tick at least one variant to compare against.");
        this.computeRegions();
        this.render();
    },

    cycleOption(dir) {
        const r = this.regions[this.current];
        if (!r) return;
        const n = r.options.length;
        this.choices[this.current] = (this.choices[this.current] + dir + n) % n;
        this.render();
    },

    gotoRegion(dir) {
        if (this.regions.length === 0) return;
        this.current = Math.max(0, Math.min(this.regions.length - 1, this.current + dir));
        this.render();
    },

    render() {
        const view = document.getElementById('vmView');
        const status = document.getElementById('vmStatus');
        if (!view) return;

        if (this.regions.length === 0) {
            view.innerHTML = '<div style="text-align:center; opacity:0.6; padding:30px 15px; font-size:12px;">Pick a master file and tick some variants, then tap COMPARE.</div>';
            if (status) status.innerText = '';
            return;
        }

        const r = this.regions[this.current];
        const chosen = this.choices[this.current];
        const opt = r.options[chosen];
        const lineLabel = r.masterStart === r.masterEnd
            ? `insertion at master line ${r.masterStart + 1}`
            : `master lines ${r.masterStart + 1}–${r.masterEnd}`;

        if (status) status.innerText = `Difference ${this.current + 1} of ${this.regions.length} — ${lineLabel}`;

        const body = opt.lines.length
            ? opt.lines.map(l => `<div style="white-space:pre-wrap;">${l.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</div>`).join('')
            : '<div style="opacity:0.5; font-style:italic;">(nothing — this version omits these lines)</div>';

        view.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:8px;">
                <button class="tool-btn" style="padding:6px 12px;" onclick="Nexus.variantMerge.cycleOption(-1)">◀</button>
                <div style="flex:1; text-align:center; font-size:11px; font-weight:bold; color:var(--accent); font-family:monospace; overflow:hidden; text-overflow:ellipsis;">
                    ${opt.sources.join(' + ')}
                    <span style="opacity:0.5; font-weight:400;"> (${chosen + 1}/${r.options.length})</span>
                </div>
                <button class="tool-btn" style="padding:6px 12px;" onclick="Nexus.variantMerge.cycleOption(1)">▶</button>
            </div>
            <div id="vmCard" style="background:#000; border:1px solid var(--accent); border-radius:8px; padding:10px; font-family:monospace; font-size:11px; max-height:38vh; overflow:auto;">${body}</div>
        `;
        this._wireSwipe();
    },

    // Swipe left/right on the card cycles versions — the "swipe through
    // variations" part of the idea. Horizontal-only, with a movement
    // threshold, so it can't fire while you're scrolling the card
    // vertically to read a long block.
    _wireSwipe() {
        const card = document.getElementById('vmCard');
        if (!card || card._vmSwipeWired) return;
        card._vmSwipeWired = true;
        let x0 = 0, y0 = 0;
        card.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
        }, { passive: true });
        card.addEventListener('touchend', (e) => {
            const t = e.changedTouches && e.changedTouches[0];
            if (!t) return;
            const dx = t.clientX - x0, dy = t.clientY - y0;
            if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                Nexus.variantMerge.cycleOption(dx < 0 ? 1 : -1);
            }
        }, { passive: true });
    },

    async build() {
        if (this.regions.length === 0) return alert("Nothing compared yet.");
        const masterLines = this._masterLines();
        const out = [];
        let pos = 0;
        this.regions.forEach((r, i) => {
            if (r.masterStart > pos) out.push(...masterLines.slice(pos, r.masterStart));
            out.push(...r.options[this.choices[i]].lines);
            pos = r.masterEnd;
        });
        if (pos < masterLines.length) out.push(...masterLines.slice(pos));
        const result = out.join('\n') + '\n';

        const dot = this.master.lastIndexOf('.');
        const suggested = dot === -1 ? this.master + '.merged' : this.master.slice(0, dot) + '.merged' + this.master.slice(dot);
        const name = await Nexus.UI.askInput({
            title: 'SAVE ASSEMBLED FILE',
            label: 'Filename for the assembled result',
            value: suggested,
            hint: 'An existing name will be overwritten — you will be warned first.',
            validate: (v) => {
                const t = (v || '').trim();
                if (!t) return 'Enter a filename.';
                if (Nexus.state.Vfs[t] !== undefined) return `"${t}" already exists. Change the name, or tap OK again to overwrite it.`;
                return null;
            },
            allowOverwriteOnSecondSubmit: true
        });
        if (!name) return;

        const isNew = Nexus.state.Vfs[name] === undefined;
        Nexus.state.Vfs[name] = result;
        if (isNew) {
            Nexus.state.originals[name] = result;
            Nexus.state.lastSavedContent[name] = result;
        }
        Nexus.Vfs.save();
        Nexus.Vfs.renderAccordion();
        Nexus.UI.closeModal('variant-merge');
        Nexus.Vfs.switchFile(name);
        alert(`Assembled ${this.regions.length} difference(s) into "${name}".`);
    },

    // Load past versions of the master file straight out of the local
    // snapshot archive. Each snapshot is a whole-project copy
    // ({ time, data: { filename: content } }), so any snapshot that
    // contains the master file already holds a complete past version of
    // it — no network, no GitHub setup, and it works for files that were
    // never committed anywhere. Skips snapshots whose copy is byte-
    // identical to the current file, since an option identical to master
    // adds nothing to cycle through.
    loadFromSnapshots() {
        if (!this.master) return alert("Pick a master file first.");
        const snaps = Nexus.state.snapshots || [];
        const status = document.getElementById('vmStatus');

        if (snaps.length === 0) {
            if (status) status.innerText = 'No snapshots saved yet — use the 📸 button by the file explorer to take one.';
            return;
        }

        const currentText = Nexus.state.Vfs[this.master] || '';
        let loaded = 0, skippedIdentical = 0, skippedMissing = 0;

        // Newest first, so the most recent past versions are the ones you
        // cycle into first.
        snaps.slice().reverse().forEach((s, idx) => {
            const text = s.data ? s.data[this.master] : undefined;
            if (text === undefined) { skippedMissing++; return; }
            if (text === currentText) { skippedIdentical++; return; }
            const label = `snap:${s.time}`;
            // Two snapshots taken at the same displayed time would collide
            // on label alone, so disambiguate by index when needed.
            const name = this.variants.some(v => v.name === label) ? `${label} #${idx + 1}` : label;
            if (!this.variants.some(v => v.name === name)) {
                this.variants.push({ name, text });
                loaded++;
            }
        });

        const notes = [];
        if (skippedIdentical) notes.push(`${skippedIdentical} identical to current`);
        if (skippedMissing) notes.push(`${skippedMissing} without this file`);
        if (status) {
            status.innerText = loaded
                ? `Loaded ${loaded} snapshot version(s)${notes.length ? ' (skipped ' + notes.join(', ') + ')' : ''}. Tap COMPARE.`
                : `No usable snapshot versions${notes.length ? ' — skipped ' + notes.join(', ') : ''}.`;
        }
        this.renderVariantPicker();
    },

    // Pull previous versions of the master file straight from GitHub's
    // commit history and load them as variants. Uses the repo/token
    // already configured in Settings, and the same timeout-wrapped fetch
    // as the rest of the GitHub integration.
    async loadFromGitHub() {
        if (!this.master) return alert("Pick a master file first.");
        const token = Nexus.state.prefs.ghToken, repo = Nexus.state.prefs.ghRepo;
        if (!token || !repo) return alert("Set your GitHub repo and token in Settings first.");

        const status = document.getElementById('vmStatus');
        if (status) status.innerText = 'Fetching history from GitHub…';
        try {
            const listUrl = `https://api.github.com/repos/${repo}/commits?path=${encodeURIComponent(this.master)}&per_page=8`;
            const res = await Nexus.github.fetchWithTimeout(listUrl, { headers: { Authorization: `token ${token}` } });
            if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
            const commits = await res.json();
            if (!Array.isArray(commits) || commits.length === 0) {
                if (status) status.innerText = 'No commit history found for this file.';
                return;
            }

            let loaded = 0;
            for (const c of commits) {
                const contentUrl = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(this.master)}?ref=${c.sha}`;
                const cRes = await Nexus.github.fetchWithTimeout(contentUrl, { headers: { Authorization: `token ${token}` } });
                if (!cRes.ok) continue;
                const data = await cRes.json();
                if (!data.content) continue;
                const text = decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))));
                const short = c.sha.slice(0, 7);
                const when = (c.commit && c.commit.author && c.commit.author.date || '').slice(0, 10);
                const label = `git:${short} ${when}`;
                if (!this.variants.some(v => v.name === label)) {
                    this.variants.push({ name: label, text });
                    loaded++;
                }
            }
            if (status) status.innerText = `Loaded ${loaded} past version(s) from GitHub. Tap COMPARE.`;
            this.renderVariantPicker();
        } catch (e) {
            console.error('variantMerge.loadFromGitHub failed:', e);
            if (status) status.innerText = 'GitHub fetch failed: ' + e.message;
        }
    }
},

mergeEngine: {
    // Kicks off a diff between a saved snapshot's version of the active file
    // and its current contents, reusing the same merge engine — snapshot
    // becomes "left," current content becomes "right." Opens straight into
    // Quick mode since a snapshot-vs-now diff is usually reviewed quickly,
    // not hand-edited.
    initiate(oldCode) {
        if (oldCode === undefined) return alert("That snapshot has no data for the active file.");
        const current = Nexus.state.Vfs[Nexus.state.activeFile] || '';
        Nexus.UI.openModal('merge');
        Nexus.merge.hunks = Diff.diffLines(oldCode, current);
        Nexus.merge.decisions = Nexus.merge.hunks.map(h => (h.added || h.removed) ? null : 'both');
        Nexus.merge.mode = 'quick';
        document.getElementById('mergeModeQuickBtn').classList.add('btn-accent');
        document.getElementById('mergeModeManualBtn').classList.remove('btn-accent');
        Nexus.merge.render();
    }
},

// Network monitor (Feature 1). Receives entries reported by the sandbox's
// own injected fetch/XHR wrappers — see the `inj` string in runSandbox()
// for the actual interception logic, verified independently against real
// fetch/XHR calls before being wired to this receiver. Cleared on every
// new sandbox run so entries never carry over from a previous preview.
networkMonitor: {
    entries: [],

    _record(entry) {
        this.entries.push({ ...entry, id: this.entries.length, time: new Date().toLocaleTimeString() });
        this.render();
    },

    clear() {
        this.entries = [];
        this.render();
    },

    render() {
        const list = document.getElementById('networkList');
        if (!list) return;
        const countEl = document.getElementById('networkCount');
        if (countEl) countEl.innerText = this.entries.length ? `${this.entries.length} request${this.entries.length === 1 ? '' : 's'}` : '';

        if (this.entries.length === 0) {
            list.innerHTML = '<div style="text-align:center; opacity:0.6; padding:30px 20px; font-size:12px;">No requests yet. fetch() and XMLHttpRequest calls made by your project while it runs will appear here.</div>';
            return;
        }

        list.innerHTML = this.entries.slice().reverse().map(e => {
            const statusColor = e.error ? 'var(--danger)' : (e.ok ? 'var(--success)' : 'var(--danger)');
            const statusText = e.error ? 'FAILED' : e.status;
            const sizeText = e.size != null ? (e.size < 1024 ? e.size + ' B' : (e.size / 1024).toFixed(1) + ' KB') : '—';
            return `<div class="item-row" style="flex-direction:column; align-items:stretch; gap:4px; padding:10px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span style="font-weight:bold; color:var(--accent); font-size:10px;">${e.method}</span>
                    <span style="color:${statusColor}; font-weight:bold; font-size:11px;">${statusText}</span>
                </div>
                <div style="font-family:monospace; font-size:11px; word-break:break-all;">${e.url}</div>
                <div style="display:flex; justify-content:space-between; font-size:9px; opacity:0.6;">
                    <span>${e.kind} · ${e.time}</span>
                    <span>${Math.round(e.duration)}ms · ${sizeText}</span>
                </div>
                ${e.error ? `<div style="color:var(--danger); font-size:10px;">${e.error}</div>` : ''}
            </div>`;
        }).join('');
    }
},

// Tap-to-inspect element picker (Feature 2). Toggled on/off; while active,
// tapping anything inside the sandbox iframe reports its tag/id/classes/
// text/box-model/key computed styles instead of triggering the tap's own
// normal behavior (the injected listener calls preventDefault/
// stopPropagation only while this.active is true, checked live at click
// time via window.parent — so toggling off mid-preview immediately
// restores normal interaction with no need to re-inject anything).
elementInspector: {
    active: false,
    lastPicked: null,

    toggle() {
        this.active = !this.active;
        const btn = document.getElementById('elementInspectorToggle');
        if (btn) btn.classList.toggle('active', this.active);
        const hint = document.getElementById('elementInspectorHint');
        if (hint) hint.style.display = this.active ? 'block' : 'none';
    },

    _record(info) {
        this.lastPicked = info;
        this.render();
    },

    render() {
        const box = document.getElementById('elementInspectorResult');
        if (!box) return;
        if (!this.lastPicked) {
            box.innerHTML = '<div style="text-align:center; opacity:0.6; padding:30px 20px; font-size:12px;">Turn on the picker above, then tap anything in the preview.</div>';
            return;
        }
        const p = this.lastPicked;
        const row = (label, val) => `<div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid var(--border); font-size:11px;"><span style="opacity:0.6;">${label}</span><span style="font-family:monospace;">${val}</span></div>`;
        box.innerHTML = `
            <div style="font-family:monospace; font-size:14px; color:var(--accent); margin-bottom:4px;">
                &lt;${p.tag}${p.id ? ' id="' + p.id + '"' : ''}${p.classes.length ? ' class="' + p.classes.join(' ') + '"' : ''}&gt;
            </div>
            ${p.text ? `<div style="font-size:11px; opacity:0.7; margin-bottom:10px; font-style:italic;">"${p.text}${p.text.length >= 60 ? '…' : ''}"</div>` : ''}
            <div style="margin-bottom:10px;">
                ${row('Position', `${p.rect.x}, ${p.rect.y}`)}
                ${row('Size', `${p.rect.w} × ${p.rect.h}`)}
            </div>
            <div>
                ${Object.entries(p.styles).map(([k, v]) => row(k, v)).join('')}
            </div>`;
    }
},

codeRunner: {
    // The main toolbar Play button: jumps straight into the live sandbox preview.
    execute() {
        Nexus.UI.openModal('sandbox');
        Nexus.UI.runSandbox();
    }
},
 
// Step-through execution visualizer. On a phone there's no side-by-side
// devtools debugger the way there is on desktop, so this brings a minimal
// version of that experience — watch your own variables change, one line
// at a time — directly into the app.
stepViz: {
    steps: [],
    sourceLines: [],
    runError: null,
    runErrorMessage: null,
    cursor: -1,

    // Read-only AST walk: for every statement (including inside if/for/while/
    // function bodies), record where to insert a tracer call and which
    // variable names are in scope at that point.
    collectInstrumentationPoints(ast) {
        const points = [];
        const nameOf = (pattern, out) => { if (pattern.type === 'Identifier') out.push(pattern.name); };
        const point = (stmt, vars) => points.push({ offset: stmt.end, line: stmt.loc.end.line, vars: [...vars] });

        const walkBranch = (stmtOrBlock, vars) => {
            if (!stmtOrBlock) return;
            if (stmtOrBlock.type === 'BlockStatement') walkBody(stmtOrBlock.body, vars);
            else walkStatement(stmtOrBlock, vars);
        };
        const walkBody = (body, scopeVars) => { for (const stmt of body) walkStatement(stmt, scopeVars); };
        const walkStatement = (stmt, scopeVars) => {
            switch (stmt.type) {
                case 'VariableDeclaration':
                    stmt.declarations.forEach(d => nameOf(d.id, scopeVars));
                    point(stmt, scopeVars);
                    break;
                case 'ExpressionStatement': {
                    const expr = stmt.expression;
                    const isConsoleCall = expr.type === 'CallExpression' && expr.callee.type === 'MemberExpression'
                        && expr.callee.object.type === 'Identifier' && expr.callee.object.name === 'console';
                    if (!isConsoleCall) point(stmt, scopeVars);
                    break;
                }
                case 'ReturnStatement': case 'BreakStatement': case 'ContinueStatement': case 'ThrowStatement':
                    point(stmt, scopeVars);
                    break;
                case 'IfStatement':
                    walkBranch(stmt.consequent, [...scopeVars]);
                    if (stmt.alternate) walkBranch(stmt.alternate, [...scopeVars]);
                    break;
                case 'ForStatement': {
                    const loopVars = [...scopeVars];
                    if (stmt.init && stmt.init.type === 'VariableDeclaration') stmt.init.declarations.forEach(d => nameOf(d.id, loopVars));
                    walkBranch(stmt.body, loopVars);
                    break;
                }
                case 'WhileStatement': case 'DoWhileStatement':
                    walkBranch(stmt.body, [...scopeVars]);
                    break;
                case 'FunctionDeclaration': {
                    if (stmt.id) scopeVars.push(stmt.id.name);
                    const fnVars = [...scopeVars];
                    stmt.params.forEach(p => nameOf(p, fnVars));
                    walkBranch(stmt.body, fnVars);
                    break;
                }
                case 'BlockStatement':
                    walkBody(stmt.body, scopeVars);
                    break;
                default: break; // unsupported statement types are simply not instrumented — code still runs
            }
        };
        walkBody(ast.body, []);
        return points;
    },

    // Pure string-splicing at known-good, already-parsed statement offsets —
    // deliberately not an AST-to-source regenerator, since inserting
    // ";__trace(...);" right after an already-complete statement can't ever
    // produce invalid syntax.
    spliceInstrumentation(sourceCode, points) {
        const sorted = [...points].sort((a, b) => b.offset - a.offset);
        let code = sourceCode;
        for (const pt of sorted) {
            const varsLiteral = '{' + pt.vars.map(v => `${JSON.stringify(v)}:(typeof ${v}!=='undefined'?${v}:undefined)`).join(',') + '}';
            code = code.slice(0, pt.offset) + `;__trace(${pt.line},${varsLiteral});` + code.slice(pt.offset);
        }
        return code;
    },

    build(sourceCode, maxSteps = 500) {
        if (typeof acorn === 'undefined') return { steps: [], error: 'RUNTIME_ERROR', message: 'Acorn parser not loaded yet — try again in a moment.' };
        let ast;
        try {
            ast = acorn.parse(sourceCode, { ecmaVersion: 2022, sourceType: 'script', locations: true, ranges: true });
        } catch (e) {
            return { steps: [], error: 'PARSE_ERROR', message: e.message };
        }
        const points = this.collectInstrumentationPoints(ast);
        const instrumented = this.spliceInstrumentation(sourceCode, points);
        const runnable = `
            const __steps = [];
            let __count = 0;
            function __trace(line, vars) {
                if (++__count > ${maxSteps}) throw new Error('__STEP_LIMIT__');
                __steps.push({ type: 'step', line, vars });
            }
            function __log(...args) {
                __steps.push({ type: 'log', text: args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ') });
            }
            const console = { log: __log, warn: __log, error: __log };
            try { ${instrumented} } catch (e) { __steps.__error = (e && e.message) || String(e); }
            return __steps;
        `;
        let fn;
        try {
            fn = new Function(runnable);
        } catch (e) {
            return { steps: [], error: 'INSTRUMENT_ERROR', message: e.message };
        }
        try {
            const steps = fn();
            const hitLimit = steps.__error === '__STEP_LIMIT__';
            return { steps: Array.from(steps), error: hitLimit ? 'STEP_LIMIT' : (steps.__error || null) };
        } catch (e) {
            return { steps: [], error: 'INSTRUMENT_ERROR', message: e.message };
        }
    },

    start() {
        if (!Nexus.state.activeFile) return Nexus.shell.out("No active file to step through.", "warn");
        const ext = Nexus.state.activeFile.split('.').pop().toLowerCase();
        let code = Nexus.state.Vfs[Nexus.state.activeFile] || '';
        if (ext === 'html') {
            const block = Nexus.Sentinel.findMainScript(code);
            if (!block) return alert("No <script> block found to step through.");
            code = block.code;
        } else if (ext !== 'js') {
            return alert("Step Through works on .js files, or .html files with a <script> block.");
        }

        const result = this.build(code);
        this.steps = result.steps;
        this.runError = result.error;
        this.runErrorMessage = result.message;
        this.sourceLines = code.split('\n');
        this.cursor = this.steps.length > 0 ? 0 : -1;

        Nexus.UI.openModal('stepviz');
        this.render();
    },

    formatValue(v) {
        if (v === undefined) return '<span style="opacity:0.5; font-style:italic;">undefined</span>';
        if (v === null) return '<span style="opacity:0.5; font-style:italic;">null</span>';
        if (typeof v === 'function') return 'ƒ()';
        if (typeof v === 'string') {
            const s = v.length > 60 ? v.slice(0, 60) + '…' : v;
            return '"' + s.replace(/</g, '&lt;') + '"';
        }
        try {
            const s = JSON.stringify(v);
            return s.length > 80 ? s.slice(0, 80) + '…' : s;
        } catch (e) { return String(v); }
    },

    next() { if (this.cursor < this.steps.length - 1) { this.cursor++; this.render(); } },
    prev() { if (this.cursor > 0) { this.cursor--; this.render(); } },

    render() {
        const box = document.getElementById('stepvizBody');
        const counter = document.getElementById('stepvizCounter');
        if (!box) return;

        if (this.runError === 'PARSE_ERROR') {
            const explain = Nexus.tutor.explainRuntimeError(this.runErrorMessage) || Nexus.tutor.explainRuntimeError('SyntaxError: ' + this.runErrorMessage);
            box.innerHTML = `<div style="color:var(--danger); font-weight:bold; margin-bottom:8px;">Can't step through this yet — there's a syntax problem first.</div>`
                + `<div style="font-size:11px; opacity:0.8; margin-bottom:8px;">${this.runErrorMessage}</div>`
                + (explain ? Nexus.tutor.renderExplainCard(explain) : '');
            if (counter) counter.innerText = '—';
            return;
        }
        if (this.runError === 'INSTRUMENT_ERROR') {
            box.innerHTML = `<div style="color:var(--danger); font-weight:bold;">Step Through couldn't process this file.</div>`
                + `<div style="font-size:11px; opacity:0.8; margin-top:6px;">${this.runErrorMessage}</div>`
                + `<div style="font-size:11px; opacity:0.6; margin-top:6px;">This usually means the file uses a JS feature this tool doesn't support yet (classes, async/await, and destructuring aren't handled in this first version).</div>`;
            if (counter) counter.innerText = '—';
            return;
        }
        if (this.steps.length === 0) {
            box.innerHTML = `<div style="opacity:0.7;">Nothing to step through — no traceable statements found.</div>`;
            if (counter) counter.innerText = '—';
            return;
        }

        const step = this.steps[this.cursor];
        const atEnd = this.cursor === this.steps.length - 1;
        let html = '';

        if (step.type === 'log') {
            html += `<div style="background:var(--surface); border-left:3px solid var(--success); border-radius:4px; padding:10px; margin-bottom:10px;">`
                + `<div style="color:var(--success); font-size:10px; font-weight:bold; margin-bottom:4px;">📤 PRINTED</div>`
                + `<div style="font-family:monospace; font-size:12px;">${step.text.replace(/</g, '&lt;')}</div></div>`;
        } else {
            const lineText = (this.sourceLines[step.line - 1] || '').trim();
            html += `<div style="background:var(--surface); border-left:3px solid var(--accent); border-radius:4px; padding:10px; margin-bottom:10px;">`
                + `<div style="color:var(--accent); font-size:10px; font-weight:bold; margin-bottom:4px;">LINE ${step.line}</div>`
                + `<div style="font-family:monospace; font-size:12px; white-space:pre-wrap;">${lineText.replace(/</g, '&lt;')}</div></div>`;

            const varNames = Object.keys(step.vars);
            if (varNames.length) {
                html += `<div style="font-size:10px; font-weight:bold; opacity:0.6; margin-bottom:4px;">VARIABLES</div>`;
                html += `<table style="width:100%; border-collapse:collapse; font-family:monospace; font-size:11px;">`;
                varNames.forEach(name => {
                    html += `<tr><td style="padding:4px 8px 4px 0; color:var(--gold); vertical-align:top;">${name}</td>`
                        + `<td style="padding:4px 0;">${this.formatValue(step.vars[name])}</td></tr>`;
                });
                html += `</table>`;
            }
        }

        if (atEnd && this.runError === 'STEP_LIMIT') {
            html += `<div style="margin-top:10px;">` + Nexus.tutor.renderExplainCard(Nexus.tutor.lintLibrary.INF_LOOP) + `</div>`;
        } else if (atEnd && this.runError && this.runError !== 'STEP_LIMIT') {
            const explain = Nexus.tutor.explainRuntimeError(this.runErrorMessage);
            html += `<div style="background:var(--surface); border-left:3px solid var(--danger); border-radius:4px; padding:10px; margin-top:10px;">`
                + `<div style="color:var(--danger); font-size:10px; font-weight:bold; margin-bottom:4px;">💥 CRASHED HERE</div>`
                + `<div style="font-size:11px;">${this.runErrorMessage}</div></div>`
                + (explain ? Nexus.tutor.renderExplainCard(explain) : '');
        }

        box.innerHTML = html;
        if (counter) counter.innerText = `${this.cursor + 1} / ${this.steps.length}`;
    }
},

docStats: {
    _compute(text) {
        return {
            lines: text.length ? text.split('\n').length : 0,
            words: (text.match(/\S+/g) || []).length,
            charsWithSpaces: text.length,
            charsNoSpaces: text.replace(/\s/g, '').length,
            bytes: new Blob([text]).size,
        };
    },
    show() {
        if (!Nexus.state.activeFile) return Nexus.shell.out("No active file.", "warn");
        const fullText = Nexus.Sentinel.getLiveCode();
        const full = this._compute(fullText);

        const sel = Nexus.Sentinel.getSelectionRange();
        const selectionStats = sel.hasSelection ? this._compute(sel.text) : null;

        const row = (label, val) => `<div style="display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid var(--border);"><span style="opacity:0.7; font-size:12px;">${label}</span><span style="font-weight:700; font-size:12px;">${val.toLocaleString()}</span></div>`;

        let html = `<div class="section-label" style="margin-top:0;">${Nexus.state.activeFile}</div>`
            + row('Lines', full.lines) + row('Words', full.words)
            + row('Characters (with spaces)', full.charsWithSpaces) + row('Characters (no spaces)', full.charsNoSpaces)
            + row('Bytes', full.bytes);

        if (selectionStats) {
            html += `<div class="section-label">Selection</div>`
                + row('Lines', selectionStats.lines) + row('Words', selectionStats.words)
                + row('Characters (with spaces)', selectionStats.charsWithSpaces) + row('Characters (no spaces)', selectionStats.charsNoSpaces)
                + row('Bytes', selectionStats.bytes);
        }

        document.getElementById('docstatsBody').innerHTML = html;
        Nexus.UI.openModal('docstats');
    }
},
 
          outline: {
   scan() {
       if (!Nexus.state.activeFile) return Nexus.shell.out("No active file.", "warn");
       const code = Nexus.state.Vfs[Nexus.state.activeFile] || "";
       const ext = Nexus.state.activeFile.split('.').pop().toLowerCase();
       let out = [];

       // 1. HTML / CSS REGEX PASS
       const lines = code.split('\n');
       lines.forEach((line, i) => {
           const text = line.trim();
           if (text.length === 0) return;
           let display = "";
           if (ext === 'html') {
               const match = text.match(/<([a-zA-Z0-9-]+)[^>]*id=['"]([^'"]+)['"]/);
               if (match) display = `<strong style="color:var(--gold);">#${match[2]}</strong> (${match[1]})`;
           }
           // Also catch CSS selectors on their own line — both in standalone
           // .css files and inside a <style> block embedded in an .html file.
           if (!display && (ext === 'css' || ext === 'html')) {
               if (/^[.#a-zA-Z][^{]*\{/.test(text)) display = text.split('{')[0].trim();
           }
           if (display) out.push({ line: i + 1, text: display });
       });

       // 2. JAVASCRIPT AST PASS (With Line Preservation Trick)
       let jsPayload = code;
       if (ext === 'html') {
           // Replace everything outside <script> tags with blank lines to preserve line numbers
           jsPayload = code.replace(/(?:^|<\/script>)([\s\S]*?)(?:<script(?![^>]*src=)[^>]*>|$)/gi, (match, p1) => {
               return '\n'.repeat(p1.split('\n').length - 1);
           });
       }

       if (ext === 'js' || ext === 'html') {
           try {
               const ast = acorn.parse(jsPayload, { ecmaVersion: 2022, sourceType: 'module', locations: true });
               const walk = (node) => {
                   if (!node || typeof node !== 'object') return;
                   let name = "", type = "", color = "";
                   if (node.type === 'FunctionDeclaration' && node.id) { name = node.id.name; type = "ƒ"; color = "var(--accent)"; }
                   else if (node.type === 'ClassDeclaration' && node.id) { name = node.id.name; type = "©"; color = "var(--success)"; }
                   else if (node.type === 'VariableDeclarator' && node.id && node.id.type === 'Identifier') {
                       if (node.init && ['FunctionExpression', 'ArrowFunctionExpression'].includes(node.init.type)) {
                           name = node.id.name; type = "ƒ"; color = "var(--accent)";
                       } else {
                           name = node.id.name; type = "ν"; color = "var(--gold)";
                       }
                   } else if (node.type === 'MethodDefinition' && node.key) { name = node.key.name; type = "ƒ"; color = "var(--accent)"; }

                   if (name) out.push({ line: node.loc.start.line, text: `<strong style="color:${color}; margin-right:5px;">${type}</strong> ${name}` });

                   Object.values(node).forEach(v => {
                       if (Array.isArray(v)) v.forEach(walk); else walk(v);
                   });
               };
               walk(ast);
           } catch(e) { 
               if(ext === 'js') out.push({ line: 1, text: `<strong style="color:var(--danger)">AST Error: Syntax Incomplete</strong>` }); 
           }
       }

       const list = document.getElementById('outlineList');
       if (out.length > 0) {
           // Deduplicate, sort by line number
           const unique = out.sort((a,b) => a.line - b.line).filter((v, i, a) => a.findIndex(t => (t.line === v.line && t.text === v.text)) === i);
           list.innerHTML = unique.map(item => `
               <div class="item-row" style="background:var(--surface); border-radius:8px; padding:12px; cursor:pointer;" onclick="Nexus.outline.jump(${item.line})">
                   <span style="color:var(--text); opacity:0.5; font-size:10px; font-weight:bold; width:40px; flex-shrink:0;">LN ${item.line}</span>
                   <span style="font-family:monospace; font-size:13px; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${item.text}</span>
               </div>
           `).join('');
       } else {
           list.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text); opacity:0.5;">No structural nodes detected.</div>`;
       }
       Nexus.UI.openModal('outline');
   },

   jump(ln) {
       Nexus.UI.closeModal('outline');
       Nexus.UI.jumpPrompt(ln); 
   }
},

// Maps every id used anywhere in the project — declared in HTML markup,
// or referenced from any file via getElementById, querySelector(All),
// a CSS #selector, a <label for>, or an anchor href="#..." — to every
// file+line it appears in. One accordion per id; expanding shows the
// full list. Scoped to the whole Vfs on purpose: the point of this tool
// is seeing an id's footprint across the entire project in one place,
// not just the currently-open file.
idMap: {
    _cache: null, // { results, firstUseOrder } — rebuilt each time the modal opens, not kept live across edits

    open() {
        this._cache = this._scan();
        Nexus.UI.openModal('id-map');
        this.render();
    },

    // Regex choices here were verified against real false-positive risks
    // before shipping, not assumed: hex colors (#ccc, #fff) inside CSS
    // property VALUES are excluded by requiring the '#' to sit at an
    // actual selector position (start of file, or right after one of
    // , { } or a newline) and by rejecting anything immediately followed
    // by `: <hex digits>` (a color value written right after the id-
    // shaped word, e.g. accidentally matching part of `#eee}`).
    _scan() {
        const results = {}; // id -> { uses: [{file, line, kind}], firstSeen: {file, line} }
        const fileOrder = Object.keys(Nexus.state.Vfs);
        let globalOrder = 0;

        const record = (id, file, line, kind) => {
            if (!id) return;
            if (!results[id]) results[id] = { uses: [], firstSeen: null, firstOrder: null };
            results[id].uses.push({ file, line, kind });
            if (results[id].firstOrder === null) {
                results[id].firstSeen = { file, line };
                results[id].firstOrder = globalOrder;
            }
            globalOrder++;
        };

        // Pass 1: declarations — id="..." in HTML files, walked file-by-
        // file in Vfs key order so "first use" reflects the project's own
        // file ordering, not scan-pattern order.
        fileOrder.forEach(file => {
            const ext = file.split('.').pop().toLowerCase();
            if (ext !== 'html' && ext !== 'htm') return;
            const code = Nexus.state.Vfs[file];
            const re = /\bid\s*=\s*["']([^"']+)["']/g;
            let m;
            while ((m = re.exec(code))) {
                const line = code.slice(0, m.index).split('\n').length;
                record(m[1], file, line, 'declared');
            }
        });

        // Pass 2: references. CSS selector pattern only runs on .css files;
        // the rest only run on non-.css files (avoids matching a JS
        // string that happens to contain '#foo' inside e.g. a URL hash).
        const refPatterns = [
            { re: /getElementById\(\s*['"]([^'"]+)['"]\s*\)/g, kind: 'getElementById' },
            { re: /querySelector(?:All)?\(\s*['"]#([A-Za-z_][\w-]*)['"]\s*\)/g, kind: 'querySelector' },
            { re: /\bfor\s*=\s*["']([^"']+)["']/g, kind: 'label-for' },
            { re: /href\s*=\s*["']#([^"']+)["']/g, kind: 'anchor-link' },
        ];
        const cssPattern = { re: /(?:^|[,{}\n]|\})\s*#([A-Za-z_][\w-]*)\b(?!\s*:\s*[0-9a-fA-F])/gm, kind: 'css-selector' };

        fileOrder.forEach(file => {
            const code = Nexus.state.Vfs[file];
            const ext = file.split('.').pop().toLowerCase();
            const patterns = ext === 'css' ? [cssPattern] : refPatterns;
            patterns.forEach(({ re, kind }) => {
                re.lastIndex = 0;
                let m;
                while ((m = re.exec(code))) {
                    // For the css-selector pattern, m.index can point at a
                    // boundary character that's itself a newline consumed
                    // by the alternation — anchoring on the actual '#'
                    // position inside the match avoids undercounting
                    // lines by one whenever that happens.
                    const hashOffset = m[0].indexOf('#');
                    const anchor = hashOffset >= 0 ? m.index + hashOffset : m.index;
                    const line = code.slice(0, anchor).split('\n').length;
                    record(m[1], file, line, kind);
                }
            });
        });

        return results;
    },

    render() {
        if (!this._cache) return;
        const filterEl = document.getElementById('idMapFilter');
        const sortEl = document.getElementById('idMapSort');
        const filter = (filterEl && filterEl.value || '').toLowerCase().trim();
        const sortMode = sortEl ? sortEl.value : 'alpha';

        let entries = Object.entries(this._cache)
            .filter(([id]) => !filter || id.toLowerCase().includes(filter));

        const filesOf = ([, info]) => new Set(info.uses.map(u => u.file)).size;

        switch (sortMode) {
            case 'alpha': entries.sort((a, b) => a[0].localeCompare(b[0])); break;
            case 'alpha-desc': entries.sort((a, b) => b[0].localeCompare(a[0])); break;
            case 'first-use': entries.sort((a, b) => a[1].firstOrder - b[1].firstOrder); break;
            case 'most-used': entries.sort((a, b) => b[1].uses.length - a[1].uses.length); break;
            case 'least-used': entries.sort((a, b) => a[1].uses.length - b[1].uses.length); break;
            case 'unused': entries.sort((a, b) => a[1].uses.length - b[1].uses.length); break; // orphans (1 use = declared only) float to the top
            case 'most-files': entries.sort((a, b) => filesOf(b) - filesOf(a)); break;
        }

        const summary = document.getElementById('idMapSummary');
        if (summary) {
            const orphanCount = Object.values(this._cache).filter(v => v.uses.length === 1).length;
            summary.innerText = `${entries.length} id${entries.length === 1 ? '' : 's'} shown` +
                (filter ? ` (filtered from ${Object.keys(this._cache).length})` : '') +
                ` — ${orphanCount} declared but never referenced elsewhere`;
        }

        const list = document.getElementById('idMapList');
        if (!list) return;
        if (entries.length === 0) {
            list.innerHTML = '<div style="text-align:center; opacity:0.6; padding:20px; font-size:12px;">No matching ids.</div>';
            return;
        }

        list.innerHTML = entries.map(([id, info], i) => {
            const isOrphan = info.uses.length === 1;
            const fileCount = filesOf([, info]);
            const rowsHtml = info.uses.map(u =>
                `<div class="item-row" style="cursor:pointer; padding:8px 10px; font-size:11px;" onclick="Nexus.idMap.jumpTo('${u.file.replace(/'/g, "\\'")}', ${u.line})">
                    <span style="opacity:0.7;">${u.kind}</span>
                    <span style="margin-left:auto; font-family:monospace;">${u.file}:${u.line}</span>
                </div>`
            ).join('');

            // margin-bottom (not flex `gap`) because #idMapList is a plain
            // BLOCK scroller — see its comment in index.html for why flex
            // was removed here entirely. Block children take their natural
            // content height with no shrink step, which is what actually
            // fixed the collapsed-hairline rendering; `gap` simply doesn't
            // apply in block layout, so spacing has to come from the item.
            return `<details class="diag-section" id="idMapAcc${i}" style="margin-bottom:6px;">
                <summary style="display:flex; align-items:center; gap:8px;">
                    <span style="font-family:monospace; font-weight:bold; ${isOrphan ? 'color:var(--danger);' : ''}">#${id}</span>
                    <span style="opacity:0.6; font-size:10px;">${info.uses.length} use${info.uses.length === 1 ? '' : 's'} · ${fileCount} file${fileCount === 1 ? '' : 's'}${isOrphan ? ' · unused' : ''}</span>
                </summary>
                <div class="diag-body" style="display:flex; flex-direction:column; gap:4px;">${rowsHtml}</div>
            </details>`;
        }).join('');
    },

    jumpTo(file, line) {
        Nexus.UI.closeModal('id-map');
        if (Nexus.state.activeFile !== file) Nexus.Vfs.switchFile(file);
        Nexus.UI.jumpToLine(line);
    }
},

             
graph: {
   analyze() {
       const files = Object.keys(Nexus.state.Vfs);
       const deps = {};
       const incoming = {};
       files.forEach(f => { deps[f] = []; incoming[f] = 0; });

       // Normalizes paths so "./utils", "utils.js", and "/utils" all map to the same file
       const normalizePath = (relative) => {
           let p = relative.replace(/['"]/g, '').trim();
           if (p.startsWith('./')) p = p.substring(2);
           if (p.startsWith('/')) p = p.substring(1);
           if (!files.includes(p)) {
               if (files.includes(p + '.js')) p += '.js';
               else if (files.includes(p + '.css')) p += '.css';
           }
           return p;
       };

       files.forEach(file => {
           const code = Nexus.state.Vfs[file] || "";
           let matches = [];
           let m;

           // Universal Regex catching for JS Imports, HTML Scripts/Links, and CSS @imports
           const importRegex = /(?:import|export)\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/gi;
           const htmlRegex = /<(?:script|link)[^>]+(?:src|href)=["']([^"']+)["']/gi;
           const cssRegex = /@import\s+(?:url\()?["']?([^"'\)]+)["']?\)?/gi;

           while((m = importRegex.exec(code))) matches.push(m[1]);
           while((m = htmlRegex.exec(code))) matches.push(m[1]);
           while((m = cssRegex.exec(code))) matches.push(m[1]);

           matches.forEach(dep => {
               const cleanDep = normalizePath(dep);
               if (files.includes(cleanDep) && cleanDep !== file) {
                   if (!deps[file].includes(cleanDep)) {
                       deps[file].push(cleanDep);
                       incoming[cleanDep]++;
                   }
               }
           });
       });
       return { deps, incoming, files };
   },

   render() {
       const { deps, incoming, files } = this.analyze();
       const container = document.getElementById('graphResults');
       if (!container) return;

       let html = `<div style="font-family: monospace; font-size: 13px; line-height: 1.6; white-space: pre-wrap;">`;
       html += `<h3 style="color:var(--success); border-bottom:1px solid var(--border); padding-bottom:5px; margin-top:0;">🌳 Application Matrix</h3>`;
       
       // This Set tracks every single file the rendering loop touches.
       const touched = new Set(); 

       const buildTree = (node, prefix, isLast, visited) => {
           touched.add(node);
           if (visited.has(node)) {
               return `<div><span style="color:var(--border);">${prefix}${isLast ? '└── ' : '├── '}</span><span style="color:var(--danger)">🔄 ${node} (Circular Loop)</span></div>`;
           }
           visited.add(node);
           
           let line = `<div><span style="color:var(--border);">${prefix}${isLast ? '└── ' : '├── '}</span><span style="color:var(--text); cursor:pointer;" onmouseover="this.style.color='var(--gold)'" onmouseout="this.style.color='var(--text)'" onclick="Nexus.Vfs.switchFile('${node}'); Nexus.UI.closeModal('graph');">${node}</span></div>`;
           
           const children = deps[node] || [];
           for (let i = 0; i < children.length; i++) {
               line += buildTree(children[i], prefix + (isLast ? '    ' : '│   '), i === children.length - 1, new Set(visited));
           }
           return line;
       };

       // 1. FORCE THE SOVEREIGN ROOT
       let rootNode = null;
       if (files.includes('index.html')) {
           rootNode = 'index.html';
       } else if (files.includes('main.js')) {
           rootNode = 'main.js';
       } else if (files.includes('app.js')) {
           rootNode = 'app.js';
       } else {
           // Failsafe: If no standard root exists, just grab the first file with 0 incoming connections
           const possibleRoots = files.filter(f => incoming[f] === 0);
           if (possibleRoots.length > 0) rootNode = possibleRoots[0];
       }

       // 2. RENDER THE ACTIVE TREE
       if (rootNode) {
           html += `<div style="margin-top:10px;">📦 <span style="color:var(--gold); font-weight:bold; cursor:pointer;" onclick="Nexus.Vfs.switchFile('${rootNode}'); Nexus.UI.closeModal('graph');">${rootNode}</span></div>`;
           touched.add(rootNode);
           const children = deps[rootNode] || [];
           for (let i = 0; i < children.length; i++) {
               html += buildTree(children[i], '', i === children.length - 1, new Set([rootNode]));
           }
       } else {
           html += `<div style="color:var(--danger); opacity:0.8;">No entry point (index.html) detected in Vfs.</div>`;
       }

       // 3. FLAG THE DEAD SECTORS
       // Anything not in the 'touched' Set is dead to the application, regardless of local imports
       const orphans = files.filter(f => !touched.has(f));

       html += `<h3 style="color:var(--danger); border-bottom:1px solid var(--border); padding-bottom:5px; margin-top:25px;">👻 Dead Sectors (Unlinked)</h3>`;
       if (orphans.length > 0) {
           orphans.forEach(o => {
               html += `<div>💀 <span style="color:var(--text); opacity:0.6; cursor:pointer;" onclick="Nexus.Vfs.switchFile('${o}'); Nexus.UI.closeModal('graph');">${o}</span></div>`;
           });
       } else {
           html += `<div style="color:var(--success); opacity:0.8;">System clean. All Vfs files linked to entry point.</div>`;
       }

       html += `</div>`;
       container.innerHTML = html;
   }
},
settings: {
    async boot() { 
        const saved = await safeStorage.getItem('nexus_prefs_v42'); 
        if (saved) Nexus.state.prefs = saved; 

        // One-time migration: bookmarkHere/bookmarksList/select used to be
        // part of DEFAULT_UTIL_LAYOUT and so could already be baked into
        // an existing saved utilLayout string from before they were
        // removed as duplicates of the dropdown menu / footer dock. This
        // strips them out of whatever's already saved (if anything is
        // saved at all — a person who never customized their layout was
        // already fixed by the default change alone, and this simply has
        // nothing to touch for them). Safe to run every boot: once
        // they're gone from a saved layout, this is a no-op from then on.
        if (Nexus.state.prefs.utilLayout) {
            const stale = ['bookmarkHere', 'bookmarksList', 'select'];
            const cleaned = Nexus.state.prefs.utilLayout
                .split(',').map(s => s.trim()).filter(Boolean)
                .filter(key => !stale.includes(key));
            const cleanedStr = cleaned.join(', ');
            if (cleanedStr !== Nexus.state.prefs.utilLayout) {
                Nexus.state.prefs.utilLayout = cleanedStr;
                safeStorage.setItem('nexus_prefs_v42', Nexus.state.prefs);
            }
        }

        // Restore bookmarks — separate storage key from prefs, following
        // the same "own dedicated key" pattern already used for vault/
        // snapshots elsewhere in this file, since bookmarks are user
        // content tied to specific files rather than an app preference.
        const savedBookmarks = await safeStorage.getItem('nexus_bookmarks_v1');
        if (savedBookmarks) Nexus.state.bookmarks = savedBookmarks;

        // Restore widget visibility (utility bar, D-pad, etc.) from the
        // preference toggleWidget() now actually saves it under. Merge onto
        // the existing defaults rather than replacing outright, so a widget
        // added after this was last saved still gets its normal default.
        if (Nexus.state.prefs.widgetVisibility) {
            Object.assign(Nexus.state.widgets, Nexus.state.prefs.widgetVisibility);
        }

        // Restore display mode (dark vs outdoor/light).
        document.body.classList.toggle('outdoor-mode', !!Nexus.state.prefs.outdoorMode);
        
        // Ensure the base object exists
        if (!Nexus.state.prefs.kbLayouts) Nexus.state.prefs.kbLayouts = {};

        // --- 1. QWERTY DEFAULTS ---
        if(!Nexus.state.prefs.kbLayouts.qwerty || Nexus.state.prefs.kbLayouts.qwerty.length === 0) {
            Nexus.state.prefs.kbLayouts.qwerty = [
                {d: '1', i: '1'}, {d: '2', i: '2'}, {d: '3', i: '3'}, {d: '4', i: '4'}, {d: '5', i: '5'}, {d: '6', i: '6'}, {d: '7', i: '7'}, {d: '8', i: '8'}, {d: '9', i: '9'}, {d: '0', i: '0'},
                {d: 'q', i: 'q'}, {d: 'w', i: 'w'}, {d: 'e', i: 'e'}, {d: 'r', i: 'r'}, {d: 't', i: 't'}, {d: 'y', i: 'y'}, {d: 'u', i: 'u'}, {d: 'i', i: 'i'}, {d: 'o', i: 'o'}, {d: 'p', i: 'p'},
                {d: 'a', i: 'a'}, {d: 's', i: 's'}, {d: 'd', i: 'd'}, {d: 'f', i: 'f'}, {d: 'g', i: 'g'}, {d: 'h', i: 'h'}, {d: 'j', i: 'j'}, {d: 'k', i: 'k'}, {d: 'l', i: 'l'},
                {d: 'z', i: 'z'}, {d: 'x', i: 'x'}, {d: 'c', i: 'c'}, {d: 'v', i: 'v'}, {d: 'b', i: 'b'}, {d: 'n', i: 'n'}, {d: 'm', i: 'm'},
                {d: ',', i: ','}, {d: '.', i: '.'}, {d: '?', i: '?'}, {d: '!', i: '!'}, {d: '@', i: '@'}, {d: '"', i: '"'}, {d: "'", i: "'"},
                {d: 'SPACE', i: ' '}, {d: 'ENTER', i: '\n'}, {d: 'BACKSPACE', i: 'BACKSPACE'}
            ];
        }
        // --- 2. HTML DEFAULTS ---
        if(!Nexus.state.prefs.kbLayouts.html || Nexus.state.prefs.kbLayouts.html.length === 0) {
            Nexus.state.prefs.kbLayouts.html = [
                {d: '<>', i: '<*#>'}, {d: '</>', i: '<\\/*#>'}, 
                {d: 'div', i: '<div>*#<\\/div>'}, {d: 'span', i: '<span>*#<\\/span>'}, 
                {d: 'p', i: '<p>*#<\\/p>'}, {d: 'a', i: '<a href="*#"><\\/a>'}, 
                {d: 'img', i: '<img src="*#" alt="">'},
                {d: 'class=""', i: 'class="*#"'}, {d: 'id=""', i: 'id="*#"'}, {d: 'style=""', i: 'style="*#"'}, 
                {d: 'script', i: '<script>\n\t*#\n<\\/script>'}, 
                {d: 'style', i: '<style>\n\t*#\n<\\/style>'},
                {d: '!--', i: ''}, {d: '=', i: '='}, {d: '/', i: '/'},
                {d: 'SPACE', i: ' '}, {d: 'ENTER', i: '\n'}, {d: 'BACKSPACE', i: 'BACKSPACE'}
            ];
        }

        // --- 3. CSS DEFAULTS ---
        if(!Nexus.state.prefs.kbLayouts.css || Nexus.state.prefs.kbLayouts.css.length === 0) {
            Nexus.state.prefs.kbLayouts.css = [
                {d: '{}', i: '{\n\t*#\n}'}, {d: ':', i: ': '}, {d: ';', i: ';'}, {d: '#', i: '#'}, {d: '.', i: '.'}, 
                {d: 'px', i: 'px'}, {d: '%', i: '%'}, {d: 'rem', i: 'rem'}, {d: 'var()', i: 'var(--*#)'},
                {d: 'color', i: 'color: *#;'}, {d: 'bg', i: 'background: *#;'}, {d: 'margin', i: 'margin: *#;'}, 
                {d: 'padding', i: 'padding: *#;'}, {d: 'display', i: 'display: *#;'}, {d: 'flex', i: 'flex'}, 
                {d: 'grid', i: 'grid'}, {d: '/* */', i: '/* *# */'}, {d: '!imp', i: '!important'},
                {d: 'SPACE', i: ' '}, {d: 'ENTER', i: '\n'}, {d: 'BACKSPACE', i: 'BACKSPACE'}
            ];
        }

        // --- 4. JS DEFAULTS ---
        if(!Nexus.state.prefs.kbLayouts.js || Nexus.state.prefs.kbLayouts.js.length === 0) {
            Nexus.state.prefs.kbLayouts.js = [
                {d: '()', i: '(*#)'}, {d: '{}', i: '{\n\t*#\n}'}, {d: '[]', i: '[*#]'}, {d: '${}', i: '${*#}'}, 
                {d: '=>', i: '=> '}, {d: '===', i: '=== '}, {d: '!==', i: '!== '}, {d: '&&', i: '&& '}, {d: '||', i: '|| '},
                {d: 'const', i: 'const *#'}, {d: 'let', i: 'let *#'}, {d: 'fn', i: 'function *#() {\n\t\n}'}, 
                {d: 'async', i: 'async '}, {d: 'await', i: 'await '}, {d: 'return', i: 'return *#;'},
                {d: 'log', i: 'console.log(*#);'}, {d: 'getEl', i: "document.getElementById('*#')"}, 
                {d: "''", i: "'*#'"}, {d: '""', i: '"*#"'}, {d: '``', i: '`*#`'},
                {d: 'SPACE', i: ' '}, {d: 'ENTER', i: '\n'}, {d: 'BACKSPACE', i: 'BACKSPACE'}
            ];
        }

        // --- 5. TYPESCRIPT DEFAULTS ---
        // Superset of JS's keys plus the type-annotation syntax that's the
        // actual reason someone would switch to this tab over the plain JS
        // one — interfaces, generics, and union types are the highest-
        // friction things to type on a phone keyboard (lots of punctuation
        // in tight sequences: <T>, |, :, ?).
        if(!Nexus.state.prefs.kbLayouts.ts || Nexus.state.prefs.kbLayouts.ts.length === 0) {
            Nexus.state.prefs.kbLayouts.ts = [
                {d: '()', i: '(*#)'}, {d: '{}', i: '{\n\t*#\n}'}, {d: '[]', i: '[*#]'}, {d: '<>', i: '<*#>'},
                {d: ':', i: ': '}, {d: '?:', i: '?: '}, {d: '|', i: ' | '}, {d: '&', i: ' & '}, {d: '=>', i: '=> '},
                {d: 'interface', i: 'interface *# {\n\t\n}'}, {d: 'type', i: 'type *# = '}, {d: 'enum', i: 'enum *# {\n\t\n}'},
                {d: 'const', i: 'const *#'}, {d: 'let', i: 'let *#'}, {d: 'fn', i: 'function *#() {\n\t\n}'},
                {d: 'string', i: 'string'}, {d: 'number', i: 'number'}, {d: 'boolean', i: 'boolean'}, {d: 'void', i: 'void'},
                {d: 'async', i: 'async '}, {d: 'await', i: 'await '}, {d: 'return', i: 'return *#;'},
                {d: "''", i: "'*#'"}, {d: '""', i: '"*#"'},
                {d: 'SPACE', i: ' '}, {d: 'ENTER', i: '\n'}, {d: 'BACKSPACE', i: 'BACKSPACE'}
            ];
        }

        // --- 6. PYTHON DEFAULTS ---
        // No braces at all (indentation-only), so this leans heavily on
        // colon+newline+indent combos instead — the actual repetitive
        // pattern in Python is "keyword ... :" followed by an indented
        // block, which is exactly what def/if/for/class insert as one tap.
        if(!Nexus.state.prefs.kbLayouts.py || Nexus.state.prefs.kbLayouts.py.length === 0) {
            Nexus.state.prefs.kbLayouts.py = [
                {d: 'def', i: 'def *#():\n\t'}, {d: 'class', i: 'class *#:\n\t'}, {d: 'if', i: 'if *#:\n\t'},
                {d: 'elif', i: 'elif *#:\n\t'}, {d: 'else', i: 'else:\n\t'}, {d: 'for', i: 'for *# in :\n\t'},
                {d: 'while', i: 'while *#:\n\t'}, {d: 'return', i: 'return *#'}, {d: 'import', i: 'import *#'},
                {d: 'from', i: 'from *# import '}, {d: 'self', i: 'self.'}, {d: '__init__', i: '__init__(self, *#):'},
                {d: 'print', i: 'print(*#)'}, {d: 'True', i: 'True'}, {d: 'False', i: 'False'}, {d: 'None', i: 'None'},
                {d: '()', i: '(*#)'}, {d: '[]', i: '[*#]'}, {d: '{}', i: '{*#}'}, {d: ':', i: ':'},
                {d: "''", i: "'*#'"}, {d: '""', i: '"*#"'}, {d: 'f""', i: 'f"*#"'},
                {d: 'SPACE', i: ' '}, {d: 'ENTER', i: '\n'}, {d: 'BACKSPACE', i: 'BACKSPACE'}
            ];
        }

        // --- 7. SQL DEFAULTS ---
        if(!Nexus.state.prefs.kbLayouts.sql || Nexus.state.prefs.kbLayouts.sql.length === 0) {
            Nexus.state.prefs.kbLayouts.sql = [
                {d: 'SELECT', i: 'SELECT *#'}, {d: 'FROM', i: '\nFROM '}, {d: 'WHERE', i: '\nWHERE '},
                {d: 'JOIN', i: '\nJOIN '}, {d: 'ON', i: 'ON '}, {d: 'GROUP BY', i: '\nGROUP BY '},
                {d: 'ORDER BY', i: '\nORDER BY '}, {d: 'LIMIT', i: '\nLIMIT '}, {d: 'AND', i: ' AND '}, {d: 'OR', i: ' OR '},
                {d: 'INSERT', i: 'INSERT INTO *# ()\nVALUES ()'}, {d: 'UPDATE', i: 'UPDATE *#\nSET '}, {d: 'DELETE', i: 'DELETE FROM *#'},
                {d: '=', i: ' = '}, {d: '*', i: '*'}, {d: ',', i: ', '}, {d: ';', i: ';'},
                {d: "''", i: "'*#'"}, {d: 'COUNT()', i: 'COUNT(*#)'}, {d: 'AS', i: ' AS '},
                {d: 'SPACE', i: ' '}, {d: 'ENTER', i: '\n'}, {d: 'BACKSPACE', i: 'BACKSPACE'}
            ];
        }

        // --- 8. YAML DEFAULTS ---
        // Same indentation-only structural note as Python — YAML's actual
        // repetitive pattern is "key:" plus a newline at the right indent
        // level, and the list-item dash, neither of which QWERTY makes
        // fast to type correctly on a phone.
        if(!Nexus.state.prefs.kbLayouts.yaml || Nexus.state.prefs.kbLayouts.yaml.length === 0) {
            Nexus.state.prefs.kbLayouts.yaml = [
                {d: 'key:', i: '*#: '}, {d: '- item', i: '- *#'}, {d: '---', i: '---\n'}, {d: '|', i: '|\n\t'}, {d: '>', i: '>\n\t'},
                {d: 'true', i: 'true'}, {d: 'false', i: 'false'}, {d: 'null', i: 'null'}, {d: '#', i: '# '},
                {d: ':', i: ': '}, {d: '-', i: '- '}, {d: '[]', i: '[*#]'}, {d: '{}', i: '{*#}'},
                {d: "''", i: "'*#'"}, {d: '""', i: '"*#"'}, {d: '$', i: '${*#}'},
                {d: 'SPACE', i: ' '}, {d: 'ENTER', i: '\n'}, {d: 'BACKSPACE', i: 'BACKSPACE'}
            ];
        }

        // --- 9. SHELL/BASH DEFAULTS ---
        if(!Nexus.state.prefs.kbLayouts.sh || Nexus.state.prefs.kbLayouts.sh.length === 0) {
            Nexus.state.prefs.kbLayouts.sh = [
                {d: '#!/bin/bash', i: '#!/bin/bash\n'}, {d: 'if', i: 'if [ *# ]; then\n\t\nfi'}, {d: 'for', i: 'for *# in ; do\n\t\ndone'},
                {d: 'while', i: 'while [ *# ]; do\n\t\ndone'}, {d: 'echo', i: 'echo "*#"'}, {d: 'export', i: 'export *#='},
                {d: '$()', i: '$(*#)'}, {d: '${}', i: '${*#}'}, {d: '&&', i: ' && '}, {d: '||', i: ' || '}, {d: '|', i: ' | '},
                {d: '-', i: '-'}, {d: '--', i: '--'}, {d: '>', i: ' > '}, {d: '>>', i: ' >> '}, {d: '$1', i: '$1'},
                {d: "''", i: "'*#'"}, {d: '""', i: '"*#"'}, {d: 'chmod', i: 'chmod +x '},
                {d: 'SPACE', i: ' '}, {d: 'ENTER', i: '\n'}, {d: 'BACKSPACE', i: 'BACKSPACE'}
            ];
        }

        // --- 10. MARKDOWN DEFAULTS ---
        if(!Nexus.state.prefs.kbLayouts.md || Nexus.state.prefs.kbLayouts.md.length === 0) {
            Nexus.state.prefs.kbLayouts.md = [
                {d: '# H1', i: '# *#'}, {d: '## H2', i: '## *#'}, {d: '### H3', i: '### *#'},
                {d: '**bold**', i: '**\*#**'}, {d: '*italic*', i: '*\*#*'}, {d: '`code`', i: '`\*#`'},
                {d: '```', i: '```\n*#\n```'}, {d: '[]()', i: '[\*#]()'}, {d: '![]()', i: '![\*#]()'},
                {d: '- item', i: '- *#'}, {d: '1. item', i: '1. *#'}, {d: '> quote', i: '> *#'},
                {d: '---', i: '\n---\n'}, {d: '|table|', i: '| *# | |\n|---|---|'},
                {d: 'SPACE', i: ' '}, {d: 'ENTER', i: '\n'}, {d: 'BACKSPACE', i: 'BACKSPACE'}
            ];
        }

        this.apply(); 
    },


    update(k, v) { 
        if (['kbRows', 'fontSize', 'tabWidth'].includes(k)) v = parseInt(v);
        Nexus.state.prefs[k] = v; 
        safeStorage.setItem('nexus_prefs_v42', Nexus.state.prefs); 
        this.apply(); 
    },

    apply() { 
        const ed = document.getElementById('rawTerminal'); 
        if (ed) {
            ed.style.fontSize = Nexus.state.prefs.fontSize + 'px'; 
            ed.style.tabSize = Nexus.state.prefs.tabWidth; 
        }
        // FIX: fontSize previously only ever touched the vanilla textarea —
        // CM6 mode silently ignored it and always rendered at its own
        // default size. Applying directly to the live contentDOM gives an
        // immediate visual change; the theme construction in toggleEditor()
        // also reads this same preference for the next fresh boot/switch.
        if (Nexus.editorCore && Nexus.editorCore.isCM6 && Nexus.editorCore.view) {
            Nexus.editorCore.view.contentDOM.style.fontSize = Nexus.state.prefs.fontSize + 'px';
            // Font size just changed live, so the previously-measured
            // .cm-line height (and therefore the scroll-past-end padding
            // sized from it) is now stale — re-measure and re-apply so it
            // keeps corresponding to ~15 real lines instead of silently
            // drifting to whatever the old font size produced.
            if (typeof Nexus.editorCore.applyScrollPastEnd === 'function') {
                Nexus.editorCore.applyScrollPastEnd();
            }
        }
        
        // Sync open UI inputs safely using optional chaining
        if(document.getElementById('prefFont')) document.getElementById('prefFont').value = Nexus.state.prefs.fontSize;
        if(document.getElementById('prefTabs')) document.getElementById('prefTabs').value = Nexus.state.prefs.tabWidth;
        if(document.getElementById('prefKbRows')) document.getElementById('prefKbRows').value = Nexus.state.prefs.kbRows;
        if(document.getElementById('prefInfiniteScroll')) document.getElementById('prefInfiniteScroll').checked = !!Nexus.state.prefs.infiniteScroll;
        if(document.getElementById('prefWriterCustom')) document.getElementById('prefWriterCustom').value = Nexus.state.prefs.customVocab || "";
        if(document.getElementById('prefGhRepo')) document.getElementById('prefGhRepo').value = Nexus.state.prefs.ghRepo || "";
        if(document.getElementById('prefGhToken')) document.getElementById('prefGhToken').value = Nexus.state.prefs.ghToken || "";
        const indentBtn = document.getElementById('indentGuidesBtn');
        if (indentBtn) indentBtn.classList.toggle('btn-accent', Nexus.state.prefs.indentGuides !== false);
        const wordWrapBtn = document.getElementById('wordWrapBtn');
        if (wordWrapBtn) wordWrapBtn.classList.toggle('btn-accent', !!Nexus.state.prefs.wordWrap);
        const rawTerminalEl = document.getElementById('rawTerminal');
        if (rawTerminalEl) rawTerminalEl.classList.toggle('word-wrap-on', !!Nexus.state.prefs.wordWrap);
        const showWhitespaceBtn = document.getElementById('showWhitespaceBtn');
        if (showWhitespaceBtn) showWhitespaceBtn.classList.toggle('btn-accent', !!Nexus.state.prefs.showWhitespace);
        const bracketTracingBtn = document.getElementById('bracketTracingBtn');
        if (bracketTracingBtn) bracketTracingBtn.classList.toggle('btn-accent', Nexus.state.prefs.bracketTracing !== false);
        const stickyScrollBtn = document.getElementById('stickyScrollBtn');
        if (stickyScrollBtn) stickyScrollBtn.classList.toggle('btn-accent', Nexus.state.prefs.stickyScroll !== false);

        // Sync local widget engine configs 
        Nexus.widgetConfig.keyboard.visibleRows = Nexus.state.prefs.kbRows || 1;
        Nexus.widgetConfig.writerVocab.custom = (Nexus.state.prefs.customVocab || "").split(',').map(s => s.trim() + ' ');

        Nexus.kb.render();

        // Restore the docked utility bar's collapsed state
        const utilBar = document.getElementById('utilityBar');
        if (utilBar) {
            const collapsed = !!Nexus.state.prefs.utilBarCollapsed;
            utilBar.classList.toggle('util-collapsed', collapsed);
            const grip = utilBar.querySelector('.util-grip');
            if (grip) grip.textContent = collapsed ? '»' : '«';
        }
    },

    calcStorage() { 
        const getK = (obj) => (JSON.stringify(obj).length / 1024).toFixed(2) + " KB"; 
        if(document.getElementById('metricVfs')) document.getElementById('metricVfs').innerText = getK(Nexus.state.Vfs); 
        if(document.getElementById('metricVault')) document.getElementById('metricVault').innerText = getK(Nexus.state.vault); 
        if(document.getElementById('metricSnaps')) document.getElementById('metricSnaps').innerText = Nexus.state.snapshots.length; 
    }
},
kbEditor: {
       currentLang: 'html',
       tempLayout: {},
       
       open() {
           this.tempLayout = JSON.parse(JSON.stringify(Nexus.state.prefs.kbLayouts));
           Nexus.UI.openModal('kb-builder');
           this.render();
       },
       
       switchLang(lang) {
           this.currentLang = lang;
           this.render();
       },
       
       render() {
           const list = document.getElementById('kbBuilderList');
           const keys = this.tempLayout[this.currentLang] || [];
           
           list.innerHTML = keys.map((k, i) => `
               <div class="item-row" style="gap:10px; background:var(--surface); margin-bottom:5px; border-radius:8px; padding:10px;">
                   <div style="flex:1; display:flex; flex-direction:column; gap:5px;">
                       <div style="display:flex; align-items:center;">
                           <span style="font-size:9px; color:var(--gold); width:40px;">SHOW:</span>
                           <input type="text" value="${k.d.replace(/"/g, '&quot;')}" onchange="Nexus.kbEditor.update(${i}, 'd', this.value)" placeholder="Label" style="flex:1; background:var(--bg); border:1px solid var(--border); color:#fff; padding:8px; border-radius:4px; font-size:11px;">
                       </div>
                       <div style="display:flex; align-items:center;">
                           <span style="font-size:9px; color:var(--accent); width:40px;">CODE:</span>
                           <input type="text" value="${k.i.replace(/"/g, '&quot;')}" onchange="Nexus.kbEditor.update(${i}, 'i', this.value)" placeholder="Insert" style="flex:1; background:var(--bg); border:1px solid var(--border); color:#fff; padding:8px; border-radius:4px; font-size:11px;">
                       </div>
                   </div>
                   <div style="display:flex; flex-direction:column; gap:5px;">
                       <button class="tool-btn" style="padding:5px;" onclick="Nexus.kbEditor.moveUp(${i})" title="Move Up" aria-label="Move key up">▲</button>
                       <button class="tool-btn" style="padding:5px;" onclick="Nexus.kbEditor.moveDown(${i})" title="Move Down" aria-label="Move key down">▼</button>
                       <button class="tool-btn btn-danger" style="padding:5px;" onclick="Nexus.kbEditor.remove(${i})" title="Delete Key" aria-label="Delete key">🗑️</button>
                   </div>
               </div>`).join('');
           
           document.querySelectorAll('.kb-builder-tab').forEach(b => {
               b.classList.toggle('btn-active', b.innerText.toLowerCase() === this.currentLang);
           });
       },
       
       // AUDIT FIX: all five of these assumed this.tempLayout[currentLang]
       // was already an array — but tempLayout is cloned from
       // prefs.kbLayouts, which defaults to {} (empty). So for any
       // language the user hasn't already saved a custom layout for —
       // i.e. ALL of them, by default — tempLayout[currentLang] was
       // undefined and every one of these threw immediately ("Cannot read
       // properties of undefined"). The Keyboard Builder was effectively
       // dead on first use: open it, tap add, crash. Found by actually
       // invoking every zero-arg method across all 55 subsystems rather
       // than reading code. _ensureLang() lazily creates the array on
       // first touch, which is also what makes "customize a language that
       // has no saved layout yet" work at all.
       _ensureLang() {
           if (!Array.isArray(this.tempLayout[this.currentLang])) {
               this.tempLayout[this.currentLang] = [];
           }
           return this.tempLayout[this.currentLang];
       },

       update(i, field, val) {
           const arr = this._ensureLang();
           if (arr[i]) arr[i][field] = val;
       },
       add() { this._ensureLang().push({d: 'New', i: 'New'}); this.render(); },
       remove(i) { this._ensureLang().splice(i, 1); this.render(); },
       moveUp(i) { 
           const arr = this._ensureLang();
           if(i > 0 && arr[i] && arr[i-1]) { 
               [arr[i], arr[i-1]] = [arr[i-1], arr[i]];
               this.render(); 
           } 
       },
       moveDown(i) { 
           const arr = this._ensureLang();
           if(i < arr.length-1 && arr[i] && arr[i+1]) { 
               [arr[i], arr[i+1]] = [arr[i+1], arr[i]];
               this.render(); 
           } 
       },
       save() { 
           Nexus.state.prefs.kbLayouts = JSON.parse(JSON.stringify(this.tempLayout)); 
           Nexus.settings.update('kbLayouts', Nexus.state.prefs.kbLayouts); 
           Nexus.UI.closeModal('kb-builder'); 
       }
   },
kb: {
    render() {
        const wrap = document.getElementById('kbRowsWrapper');
        if (!wrap) return;

        // SAFE FALLBACKS: Guard against uninitialized config pathways
        const currentConfig = Nexus.widgetConfig?.keyboard || {};
        const lang = currentConfig.currentLang || 'html';
        
        const prefs = Nexus.state?.prefs || {};
        const layouts = prefs.kbLayouts || {};
        const keys = layouts[lang] || [];
        
        // Force at least 1 row if kbRows is undefined or set to 0
        const visibleRows = parseInt(prefs.kbRows) || 1; 
        
        if (keys.length === 0) {
            wrap.innerHTML = `<div style="color: #5c6370; padding: 10px; font-size: 12px;">No keys configured for '${lang}'</div>`;
            return;
        }
        
        const chunkSize = Math.ceil(keys.length / visibleRows);
        const rowsData = [];
        for (let i = 0; i < visibleRows; i++) {
            rowsData.push(keys.slice(i * chunkSize, (i + 1) * chunkSize));
        }
        
        wrap.innerHTML = rowsData.map((row, i) => {
            // Filter out empty rows to prevent blank track generation
            if (row.length === 0) return '';

            const baseHTML = row.map(k => {
                let dSafe = k.d.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                let iSafe = k.i.replace(/'/g, "\\'").replace(/"/g, '&quot;');
                let specialClass = (k.d === 'BACKSPACE' || k.d === 'ENTER') ? 'style="background:var(--accent); color:#fff;"' : '';
                if(k.d === 'SPACE') specialClass = 'style="width: 80px;"';
                
                return `<button class="kb-key" ${specialClass} onclick="Nexus.UI.injectChar('${iSafe}')">${dSafe}</button>`;
            }).join('');
            
            // Loop pattern 5 times for smooth horizontal loop boundaries
            const infiniteHTML = Array(5).fill(baseHTML).join('');
            return `<div class="kb-scroll-row" id="kb-r${i}" style="display: flex; gap: 6px; overflow-x: auto; white-space: nowrap; padding: 4px 0;">${infiniteHTML}</div>`;
        }).join('');

        // Handle the loop threshold scroll bindings cleanly on your inner rows
        setTimeout(() => {
            document.querySelectorAll('.kb-scroll-row').forEach(el => {
                el.scrollLeft = el.scrollWidth / 3;
                el.onscroll = () => {
                    if (el.scrollLeft < 100) {
                        el.scrollLeft = el.scrollWidth / 3;
                    } else if (el.scrollLeft > el.scrollWidth - el.clientWidth - 50) {
                        el.scrollLeft = el.scrollWidth / 3;
                    }
                };
            });
        }, 50);
    },

    switchLang(lang) {
        if (!Nexus.widgetConfig) Nexus.widgetConfig = { keyboard: {} };
        if (!Nexus.widgetConfig.keyboard) Nexus.widgetConfig.keyboard = {};
        
        Nexus.widgetConfig.keyboard.currentLang = lang;
        
        document.querySelectorAll('#kbLangToggles .kb-tab').forEach(b => {
            if (b.innerText.toLowerCase() === lang) { 
                b.classList.add('active'); 
            } else { 
                b.classList.remove('active'); 
            }
        });
        this.render();
    }
},


   search: {
       toggleOpt(opt) {
           Nexus.state.searchOpts[opt] = !Nexus.state.searchOpts[opt];
           const btn = document.getElementById(opt + 'Btn');
           if (btn) btn.classList.toggle('active');
       },
       buildRegex() {
           const term = document.getElementById('findInput').value;
           if (!term) return null;
           let searchStr = term;
           if (!Nexus.state.searchOpts.regex) {
               searchStr = searchStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
           }
           const flags = (Nexus.state.searchOpts.case ? '' : 'i') + 'g';
           try { return new RegExp(searchStr, flags); } catch(e) { return null; }
       },
       cycleFileForSearch(dir) {
           const files = Object.keys(Nexus.state.Vfs);
           let idx = files.indexOf(Nexus.state.activeFile);
           const startIdx = idx;
           const regex = this.buildRegex();
           if (!regex) return;

           while(true) {
               idx += dir;
               if (idx >= files.length) idx = 0;
               if (idx < 0) idx = files.length - 1;
               
               if (idx === startIdx) break; 

               const fileCode = Nexus.state.Vfs[files[idx]];
               regex.lastIndex = 0; 
               if (regex.test(fileCode)) {
                   // Logic Routing Fix: Call .Vfs not .state.Vfs
                   Nexus.Vfs.switchFile(files[idx]);
                   const ed = document.getElementById('rawTerminal');
                   ed.selectionStart = ed.selectionEnd = dir === 1 ? 0 : ed.value.length;
                   this.findNext(dir, true);
                   break;
               }
           }
       },

       // Shows every match across every file in one scannable list, grouped
       // by file, each tappable to jump straight there — complements
       // cycleFileForSearch's one-hop-at-a-time navigation with a proper
       // overview when you just want to see everywhere a term shows up.
       findInAllFiles() {
           const term = document.getElementById('findInput').value;
           const regex = this.buildRegex();
           const summaryEl = document.getElementById('findallSummary');
           const resultsEl = document.getElementById('findallResults');

           if (!term || !regex) {
               summaryEl.innerText = 'Type something to search for first.';
               resultsEl.innerHTML = '';
               Nexus.UI.openModal('findall');
               return;
           }

           const results = []; // { file, line, snippet }
           Object.entries(Nexus.state.Vfs).forEach(([file, content]) => {
               content.split('\n').forEach((lineText, i) => {
                   regex.lastIndex = 0;
                   if (regex.test(lineText)) {
                       results.push({ file, line: i + 1, snippet: lineText.trim().slice(0, 100) });
                   }
               });
           });

           const filesMatched = new Set(results.map(r => r.file)).size;
           summaryEl.innerText = results.length === 0
               ? `No matches for "${term}" in any file.`
               : `${results.length} match${results.length === 1 ? '' : 'es'} in ${filesMatched} file${filesMatched === 1 ? '' : 's'}.`;

           let html = '';
           let lastFile = null;
           results.forEach(r => {
               if (r.file !== lastFile) {
                   html += `<div style="font-size:10px; font-weight:800; color:var(--gold); margin-top:8px;">${r.file}</div>`;
                   lastFile = r.file;
               }
               const escaped = r.snippet.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
               html += `<div onclick="Nexus.UI.closeModal('findall'); Nexus.Vfs.switchFile('${r.file}'); setTimeout(() => Nexus.UI.jumpToLine(${r.line}), 100);" style="cursor:pointer; background:var(--surface); padding:6px 10px; border-radius:4px; display:flex; justify-content:space-between; align-items:center; gap:8px;">`
                   + `<span style="font-size:11px; font-family:monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escaped}</span>`
                   + `<span style="font-size:9px; opacity:0.6; white-space:nowrap;">LN ${r.line}</span>`
                   + `</div>`;
           });
           resultsEl.innerHTML = html;
           Nexus.UI.openModal('findall');
       },

       findNext(dir, isRecursive = false) {
           const ed = document.getElementById('rawTerminal');
           const regex = this.buildRegex();
           if (!regex) return;

           const text = ed.value;
           const matches = [];
           let m;
           while ((m = regex.exec(text)) !== null) {
               matches.push({ index: m.index, length: m[0].length });
               if (!regex.global) break; 
           }
           
           if (matches.length === 0) {
               if (Nexus.state.searchOpts.global && !isRecursive) this.cycleFileForSearch(dir);
               return;
           }

           const currentPos = ed.selectionStart;
           let targetMatch = null;

           if (dir === 1) { 
               for (let i = 0; i < matches.length; i++) {
                   if (matches[i].index > currentPos) { targetMatch = matches[i]; break; }
               }
           } else { 
               for (let i = matches.length - 1; i >= 0; i--) {
                   if (matches[i].index < currentPos) { targetMatch = matches[i]; break; }
               }
           }

           if (!targetMatch) {
               if (Nexus.state.searchOpts.global && !isRecursive) {
                   this.cycleFileForSearch(dir);
                   return;
               } else {
                   targetMatch = dir === 1 ? matches[0] : matches[matches.length - 1];
               }
           }

           if (targetMatch) {
               ed.focus();
               ed.setSelectionRange(targetMatch.index, targetMatch.index + targetMatch.length);
               const textBefore = text.substring(0, targetMatch.index);
               const linesBefore = textBefore.split('\n').length;
               ed.scrollTop = (linesBefore - 1) * 22 - (ed.clientHeight / 2);
           }
       },
       // CORRECTED: previously ignored Nexus.state.searchOpts.regex entirely
       // — always escaped special characters regardless of the .* toggle
       // button's state, so turning regex mode on never actually changed
       // what replace() did (only findNext()/buildRegex() respected it).
       // Now builds the same regex buildRegex() uses elsewhere, anchored to
       // the current selection specifically (^...$ against just the
       // selected text) so this remains "replace what's selected," not
       // "replace the first match anywhere" — same intent as the original,
       // just with regex mode and capture groups actually working.
       replace() {
   const ed = document.getElementById('rawTerminal');
   const find = document.getElementById('findInput').value;
   const rep = document.getElementById('replaceInput').value;
   
   if (!find || ed.hasAttribute('readonly')) return;

   const selStart = ed.selectionStart;
   const selEnd = ed.selectionEnd;
   const currentSelection = ed.value.substring(selStart, selEnd);

   let searchStr = find;
   if (!Nexus.state.searchOpts.regex) {
       searchStr = searchStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
   }
   const flags = Nexus.state.searchOpts.case ? '' : 'i';
   let matcher;
   try {
       matcher = new RegExp('^(?:' + searchStr + ')$', flags);
   } catch (e) {
       alert('Invalid regex: ' + e.message);
       return;
   }

   if (currentSelection && matcher.test(currentSelection)) {
       // String.replace natively substitutes $1, $2, etc. from capture
       // groups in `rep` when the pattern argument is a RegExp — exactly
       // the behavior needed for "wrap every match in parens" or
       // "swap two captured halves" style regex replacements. In
       // non-regex mode this still works safely: a literal replacement
       // string with no $-groups just passes through unchanged, and any
       // literal $ the user typed is preserved as-is since there's
       // nothing for it to reference.
       const newSelectionText = currentSelection.replace(matcher, rep);
       ed.value = ed.value.substring(0, selStart) + newSelectionText + ed.value.substring(selEnd);
       ed.setSelectionRange(selStart, selStart + newSelectionText.length);
       Nexus.state.Vfs[Nexus.state.activeFile] = ed.value;
       Nexus.Vfs.save();
       Nexus.UI.updateGutter();
   }
   this.findNext(1);
   },

   // Replace every match in the whole file in one pass, rather than the
   // find-select-replace-repeat cycle replace() is built for. Uses
   // buildRegex() directly (already global + correctly escaped/not based
   // on regex mode) so this stays in sync with whatever findNext() would
   // actually match, rather than re-deriving the pattern separately and
   // risking the two drifting apart.
   replaceAll() {
       const ed = document.getElementById('rawTerminal');
       const rep = document.getElementById('replaceInput').value;
       if (ed.hasAttribute('readonly')) return alert('UNLOCK EDITOR FIRST');

       const regex = this.buildRegex();
       if (!regex) return alert('Type something to find first.');

       const original = ed.value;
       let count = 0;
       const updated = original.replace(regex, (...args) => {
           count++;
           // Callback signature is (fullMatch, group1, group2, ..., offset,
           // string) — so args[0] is the WHOLE match and capture group N
           // lives at args[N], not args[N-1]. Confirmed by direct testing:
           // the first version of this line used args[Number(n) - 1],
           // which put $1 at args[0] (the full match, wrong) and $2 at
           // args[1] (actually group 1, also wrong) — every capture group
           // reference was off by one, silently producing scrambled output
           // (e.g. "foo_bar" -> "$2_$1" landed on "foo_foo_bar" instead of
           // the correct "bar_foo").
           return rep.replace(/\$(\d+)/g, (m, n) => args[Number(n)] ?? m).replace(/\$&/g, args[0]);
       });
       // The manual $-substitution above (rather than just returning `rep`
       // directly) exists because the callback form of String.replace does
       // NOT auto-expand $1/$2 the way the pattern-argument form does —
       // that native expansion only happens when the second argument is a
       // literal string, not a function. Using a callback here (needed to
       // count matches) means the $-group expansion has to be done by hand.

       if (count === 0) {
           alert('No matches found.');
           return;
       }

       ed.value = updated;
       Nexus.state.Vfs[Nexus.state.activeFile] = updated;
       Nexus.Vfs.save();
       Nexus.UI.updateGutter();

       const st = document.getElementById('footStatus');
       if (st) { st.innerText = `REPLACED ${count} MATCH${count === 1 ? '' : 'ES'}`; setTimeout(() => Nexus.UI.syncStatus(), 2500); }
   }
},

writer: {
   templates: {
       'fetch': "async function fetchData(url) {\n\ttry {\n\t\tconst res = await fetch(url);\n\t\tif (!res.ok) throw new Error('Network fault');\n\t\tconst data = await res.json();\n\t\treturn data;\n\t} catch (err) {\n\t\tconsole.error('Fetch error:', err);\n\t\tthrow err;\n\t}\n}",
       'component': "class CustomMatrixElement extends HTMLElement {\n\tconstructor() {\n\t\tsuper();\n\t\tthis.attachShadow({ mode: 'open' });\n\t}\n\tconnectedCallback() {\n\t\tthis.shadowRoot.innerHTML = `\n\t\t\t<style>:host { display: block; padding: 10px; }</style>\n\t\t\t<div>Component Initialized</div>\n\t\t`;\n\t}\n}\ncustomElements.define('matrix-element', CustomMatrixElement);",
       'canvas': "const canvas = document.getElementById('omniCanvas');\nconst ctx = canvas.getContext('2d');\nfunction resize() {\n\tcanvas.width = window.innerWidth;\n\tcanvas.height = window.innerHeight;\n}\nwindow.addEventListener('resize', resize);\nresize();\n\nfunction animate() {\n\tctx.clearRect(0, 0, canvas.width, canvas.height);\n\t// Render logic here\n\trequestAnimationFrame(animate);\n}\nanimate();",
       'express': "const express = require('express');\nconst app = express();\napp.use(express.json());\n\napp.get('/api/status', (req, res) => {\n\tres.json({ status: 'active', matrix: true });\n});\n\napp.listen(3000, () => console.log('DevOS Server running on 3000'));",
       'observer': "const observer = new IntersectionObserver((entries) => {\n\tentries.forEach(entry => {\n\t\tif (entry.isIntersecting) {\n\t\t\tentry.target.classList.add('visible');\n\t\t}\n\t});\n}, { threshold: 0.1 });\n\ndocument.querySelectorAll('.animate-on-scroll').forEach(el => observer.observe(el));"
   },
   go() {
       const ed = document.getElementById('rawTerminal');
       if (!Nexus.UI.needUnlocked('Boilerplate injection', () => Nexus.writer.go())) return;
       
       const mode = document.getElementById('writeMode').value;
       const result = this.templates[mode];

       Nexus.UI.injectChar(result + "\n");

       const statusEl = document.getElementById('writerStatus');
       statusEl.innerText = "INJECTED";
       statusEl.style.color = "var(--success)";
       statusEl.style.opacity = "1";
       setTimeout(() => {
           statusEl.innerText = "IDLE";
           statusEl.style.color = "";
           statusEl.style.opacity = "0.5";
       }, 1500);
   }
},

// UI-friendly wrappers around the shell's push/pull/pull-all commands (see
// Nexus.shell.commands below) — same underlying, tested logic, just with a
// proper settings-panel button instead of requiring the terminal.
github: {
    setStatus(msg, color) {
        const el = document.getElementById('githubStatus');
        if (el) { el.textContent = msg; el.style.color = color || 'var(--text)'; }
    },
    checkConfig() {
        if (!Nexus.state.prefs.ghRepo || !Nexus.state.prefs.ghToken) {
            this.setStatus('Set a repository and token above first.', 'var(--danger)');
            return false;
        }
        return true;
    },

    // FIX: every GitHub fetch() here previously had no timeout at all —
    // unlike the CM6 import chain (a Promise.race against a deadline,
    // since import() itself can't be cancelled), a real fetch() CAN be
    // aborted directly via AbortController, which is the more correct
    // mechanism when it's actually available. A stalled request against
    // api.github.com (slow connection, network hiccup, a captive portal
    // intercepting the request) would otherwise hang the awaiting
    // function forever with no error and no way to recover except
    // reloading the whole app — pull-all() in particular loops through
    // fetches SEQUENTIALLY, so one stalled file mid-loop would block
    // every file after it too.
    async fetchWithTimeout(url, options = {}, ms = 15000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ms);
        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    },

    async pushCurrentFile() {
        if (!Nexus.state.activeFile) return this.setStatus('No active file.', 'var(--danger)');
        if (!this.checkConfig()) return;
        this.setStatus('Pushing ' + Nexus.state.activeFile + '...', 'var(--text)');
        const result = await Nexus.shell.commands.push([Nexus.state.activeFile]);
        this.setStatus(result, result.includes('✅') ? 'var(--success)' : 'var(--danger)');
    },
    async pullCurrentFile() {
        if (!Nexus.state.activeFile) return this.setStatus('No active file.', 'var(--danger)');
        if (!this.checkConfig()) return;
        if (!confirm(`Pull '${Nexus.state.activeFile}' from GitHub? This overwrites your local version.`)) return;
        this.setStatus('Pulling ' + Nexus.state.activeFile + '...', 'var(--text)');
        const result = await Nexus.shell.commands.pull([Nexus.state.activeFile]);
        this.setStatus(result, result.includes('📥') ? 'var(--success)' : 'var(--danger)');
        if (result.includes('📥')) Nexus.Vfs.switchFile(Nexus.state.activeFile);
    },
    async pullAll() {
        if (!this.checkConfig()) return;
        if (!confirm('Pull the entire project from GitHub, including subfolders? This overwrites any local files with matching names.')) return;
        this.setStatus('Pulling project...', 'var(--text)');
        const result = await Nexus.shell.commands['pull-all']();
        this.setStatus(result, result.includes('✅') ? 'var(--success)' : 'var(--danger)');
        Nexus.Vfs.renderAccordion();
        if (Nexus.state.activeFile) Nexus.Vfs.switchFile(Nexus.state.activeFile);
    },
    async pushAll() {
        if (!this.checkConfig()) return;
        const fileCount = Object.keys(Nexus.state.Vfs).length;
        if (!confirm(`Push all ${fileCount} file(s) to GitHub? Existing remote files with the same names will be updated.`)) return;
        this.setStatus('Pushing project...', 'var(--text)');
        const result = await Nexus.shell.commands['push-all']();
        this.setStatus(result, result.includes('✅') && !result.includes('failed') ? 'var(--success)' : 'var(--danger)');
    }
},

shell: {
   out(msg, type = 'info') {
       // Rate-limit identical messages so a repeating failure (e.g. autosave
       // retrying every 400ms) can't stack duplicate toasts on screen.
       const now = Date.now();
       this._lastOut = this._lastOut || {};
       if (this._lastOut[msg] && now - this._lastOut[msg] < 8000) return;
       this._lastOut[msg] = now;

       const colors = { error: 'var(--danger)', success: 'var(--success)', warn: 'var(--warn)', accent: 'var(--accent)', info: 'var(--text)' };
       console.log(`[Nexus:${type}]`, msg);
       const toast = document.createElement('div');
       toast.textContent = msg;
       toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
       toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
       toast.style.cssText = `position:fixed; bottom:70px; left:50%; transform:translateX(-50%); background:var(--panel); color:${colors[type] || colors.info}; border:1px solid var(--border); padding:10px 18px; border-radius:10px; font-size:12px; font-weight:700; z-index:99999; box-shadow:0 4px 20px rgba(0,0,0,0.4); max-width:90vw; text-align:center; pointer-events:none;`;
       document.body.appendChild(toast);
       setTimeout(() => toast.remove(), 2500);
   },
   commands: {
       ls: () => {
           return Object.keys(Nexus.state.Vfs).join('\n') || "Vortex empty.";
       },
       help: () => {
           return `
       \x1b[33mNEXUS MATRIX SHELL COMMANDS\x1b[0m
       ---------------------------
       \x1b[36mls\x1b[0m                List all active sectors in the Vfs
       \x1b[36mtouch [name]\x1b[0m      Create a new file (e.g., touch style.css)
       \x1b[36mrm [name]\x1b[0m         Delete a specific file
       \x1b[36mdelete-folder [d]\x1b[0m Delete all files starting with a folder path
       \x1b[36mcat [name]\x1b[0m        Print file contents to terminal
       \x1b[36mpush [name]\x1b[0m       Commit and push a file to GitHub
       \x1b[36mpull [name]\x1b[0m       Pull a specific file from GitHub
       \x1b[36mpull-all\x1b[0m          Sync the entire project from GitHub
       \x1b[36mconfig\x1b[0m            Configure env variables (e.g., config set ghToken)
       \x1b[36mchange-repo\x1b[0m       Switch GitHub repo target
       \x1b[36mhelp\x1b[0m              Show this command list
       
       *Any unrecognized command will be evaluated as raw JavaScript.*`;
       },
       
       touch: (args) => {
           const path = args[0];
           if (!path) return "Error: Specify a path.";
           if (path in Nexus.state.Vfs) return `Error: '${path}' already exists.`;
           
           const ancestors = path.split('/').slice(0, -1);
           let currentPath = "";
           for (const part of ancestors) {
               currentPath = currentPath === "" ? part : `${currentPath}/${part}`;
               if (currentPath in Nexus.state.Vfs) {
                   return `Error: '${currentPath}' is a file, cannot be a folder.`;
               }
           }
           
           Nexus.state.Vfs[path] = "";
           Nexus.state.originals[path] = ""; 
           // Same reasoning as newFile(): a brand-new empty file, nothing
           // typed into it yet, shouldn't read as having unsaved changes.
           Nexus.state.lastSavedContent[path] = "";
           Nexus.Vfs.renderAccordion();
           Nexus.Vfs.save();
           return `Created: ${path}`;
       },

       rm: (args) => {
           const path = args[0];
           if (!path || !(path in Nexus.state.Vfs)) return "Error: File not found.";
           
           delete Nexus.state.Vfs[path];
           delete Nexus.state.originals[path];
           delete Nexus.state.lastSavedContent[path];
           // Terminal rm bypasses Vfs.deleteFile()/closeTab() entirely, so
           // it needs its own cleanup of any dangling open tab pointing at
           // the now-deleted file — otherwise the tab bar keeps showing a
           // tab for a file that no longer exists in Vfs at all.
           {
               const ti = Nexus.state.openTabs.indexOf(path);
               if (ti !== -1) { Nexus.state.openTabs.splice(ti, 1); Nexus.Vfs.saveOpenTabs(); }
           }
           if (Nexus.state.activeFile === path) Nexus.state.activeFile = null;
           Nexus.Vfs.renderAccordion();
           Nexus.Vfs.save();
           return `Deleted: ${path}`;
       },

       'delete-folder': (args) => {
           const folderPath = args[0].endsWith('/') ? args[0] : `${args[0]}/`;
           const allFiles = Object.keys(Nexus.state.Vfs);
           const toDelete = allFiles.filter(p => p.startsWith(folderPath));

           if (toDelete.length === 0) return `Error: No files in '${folderPath}'`;

           if (toDelete.includes(Nexus.state.activeFile)) {
               Nexus.state.activeFile = null;
           }

           toDelete.forEach(p => {
               delete Nexus.state.Vfs[p];
               delete Nexus.state.originals[p];
               delete Nexus.state.lastSavedContent[p];
               const ti = Nexus.state.openTabs.indexOf(p);
               if (ti !== -1) Nexus.state.openTabs.splice(ti, 1);
           });
           Nexus.Vfs.saveOpenTabs();

           Nexus.Vfs.renderAccordion();
           Nexus.Vfs.save();
           return `Deleted ${toDelete.length} files from ${folderPath} 🗑️`;
       },

       cat: (args) => {
           const path = args[0];
           return (path in Nexus.state.Vfs) ? (Nexus.state.Vfs[path] || '(empty file)') : "Error: File not found.";
       },

       'config': (args) => {
           const [action, key, value] = args;
           if (action === 'set' && (key === 'ghToken' || key === 'ghRepo') && value) {
               Nexus.state.prefs[key] = value;
               Nexus.Vfs.save();
               return `Success: ${key} updated ⚙️`;
           }
           return "Usage: config set [ghToken|ghRepo] [value]";
       },

       'change-repo': (args) => {
           const repo = args[0];
           if (!repo) return "Usage: change-repo [user/repo]";
           Nexus.settings.update('ghRepo', repo);
           return `Target switched to: ${repo} 🔄`;
       },

       pull: async (args) => {
           const path = args[0];
           const token = Nexus.state.prefs.ghToken;
           const repo = Nexus.state.prefs.ghRepo;
           const url = `https://api.github.com/repos/${repo}/contents/${path}`;
           try {
               const res = await Nexus.github.fetchWithTimeout(url, { headers: { "Authorization": `token ${token}` } });
               if (!res.ok) throw new Error("File not found.");
               const data = await res.json();
               const pulled = decodeURIComponent(escape(atob(data.content.replace(/\s/g, ''))));
               Nexus.state.Vfs[path] = pulled;
               // Treats a pull the same as a fresh load for dirty-tracking
               // purposes: content just came from the remote, so it isn't
               // "unsaved" relative to anything yet. Note this file's
               // pre-existing behavior of never touching originals[path]
               // here is untouched by this change — that's a separate,
               // pre-existing gap (refreshCurrent() on a pulled file would
               // revert to whatever was there before the pull, not to the
               // pulled content) outside this session's scope.
               Nexus.state.lastSavedContent[path] = pulled;
               Nexus.Vfs.renderAccordion();
               return `${path}: Pulled 📥`;
           } catch (e) { return `Error: ${e.message}`; }
       },

       // FIX (the reported crash, and the real underlying bug): the
       // GitHub contents API returns an ARRAY only when you list a
       // directory — the previous version assumed the repo root's
       // response was always that array and looped it directly with no
       // shape check, so any non-array response (a bad/expired token, a
       // rate limit, a wrong repo name — all of which return an error
       // OBJECT like {message:"Bad credentials"}) threw exactly "items is
       // not iterable" with zero indication of what actually went wrong.
       // Separately: even when it didn't crash, this only ever listed the
       // repo ROOT — GitHub's contents endpoint is per-directory, not
       // recursive, so it never descended into subfolders at all; a file
       // in src/utils/ was silently never even attempted, not just
       // skipped with a warning.
       'pull-all': async () => {
           const token = Nexus.state.prefs.ghToken;
           const repo = Nexus.state.prefs.ghRepo;
           if (!token || !repo) return "Error: set a repo and token in Settings first.";

           const results = { count: 0, failed: [], errors: [] };

           async function walk(dirPath, depth) {
               // Depth-capped the same defensive way this app's own
               // recursive CSS @import inliner already is — a
               // pathological or unexpectedly cyclic API response can't
               // spin this forever.
               if (depth > 12) { results.errors.push(`${dirPath || '(root)'}: too deeply nested, stopped descending`); return; }
               const listUrl = `https://api.github.com/repos/${repo}/contents/${dirPath}`;
               const res = await Nexus.github.fetchWithTimeout(listUrl, { headers: { "Authorization": `token ${token}` } });
               if (!res.ok) { results.errors.push(`${dirPath || '(root)'}: HTTP ${res.status}`); return; }
               const items = await res.json();
               if (!Array.isArray(items)) {
                   results.errors.push(`${dirPath || '(root)'}: GitHub returned an error, not a file listing — ${items && items.message || 'check your repo name and token'}`);
                   return;
               }
               for (const item of items) {
                   if (item.type === 'file') {
                       try {
                           const fRes = await Nexus.github.fetchWithTimeout(item.url, { headers: { "Authorization": `token ${token}` } });
                           if (!fRes.ok) { results.failed.push(item.path); continue; }
                           const fData = await fRes.json();
                           const pulled = decodeURIComponent(escape(atob(fData.content.replace(/\s/g, ''))));
                           // item.path already comes back from GitHub as
                           // the full "folder/file.ext" form — exactly
                           // the flat-path-with-slashes convention this
                           // app's own file explorer now uses for
                           // subfolder display, so no translation needed.
                           Nexus.state.Vfs[item.path] = pulled;
                           Nexus.state.originals[item.path] = pulled;
                           Nexus.state.lastSavedContent[item.path] = pulled;
                           results.count++;
                       } catch (e) {
                           results.failed.push(item.path);
                       }
                   } else if (item.type === 'dir') {
                       await walk(item.path, depth + 1);
                   }
               }
           }

           try {
               await walk('', 0);
           } catch (e) {
               return `Sync failed: ${e.message}`;
           }

           Nexus.Vfs.save();
           Nexus.Vfs.renderAccordion();

           let msg = `Pulled ${results.count} file(s) ✅`;
           if (results.failed.length) msg += ` — ${results.failed.length} failed: ${results.failed.join(', ')}`;
           if (results.errors.length) msg += ` — ${results.errors.join('; ')}`;
           return msg;
       },

       // Push-all's own equivalent of pull-all: walk every file currently
       // in the Vfs and push each one individually, reusing the exact
       // same create-vs-update logic the single-file 'push' command
       // already has (GET first to discover whether a sha exists — that's
       // what tells GitHub's PUT endpoint "update this" vs "create this
       // as new"). Vfs paths already use the same "folder/file.ext" flat
       // convention GitHub itself uses, so no path translation is needed
       // in either direction.
       'push-all': async () => {
           const token = Nexus.state.prefs.ghToken;
           const repo = Nexus.state.prefs.ghRepo;
           if (!token || !repo) return "Error: set a repo and token in Settings first.";

           const files = Object.keys(Nexus.state.Vfs);
           if (files.length === 0) return "Nothing to push — the project is empty.";

           let created = 0, updated = 0;
           const failed = [];

           for (const path of files) {
               const content = Nexus.state.Vfs[path];
               const url = `https://api.github.com/repos/${repo}/contents/${path}`;
               try {
                   const getRes = await Nexus.github.fetchWithTimeout(url, { headers: { "Authorization": `token ${token}` } });
                   let sha = '';
                   if (getRes.ok) {
                       const getData = await getRes.json();
                       sha = getData.sha;
                   }
                   const payload = {
                       message: `Push all via divIDE — ${path}`,
                       content: btoa(unescape(encodeURIComponent(content))),
                       sha: sha
                   };
                   const putRes = await Nexus.github.fetchWithTimeout(url, {
                       method: "PUT",
                       headers: { "Authorization": `token ${token}`, "Content-Type": "application/json" },
                       body: JSON.stringify(payload)
                   });
                   if (!putRes.ok) { failed.push(path); continue; }
                   if (sha) updated++; else created++;
               } catch (e) {
                   failed.push(path);
               }
           }

           let msg = `Pushed: ${created} created, ${updated} updated ✅`;
           if (failed.length) msg += ` — ${failed.length} failed: ${failed.join(', ')}`;
           return msg;
       },

       'push': async (args) => {
           const path = args[0] || Nexus.state.activeFile;
           if (!path) return "Error: No file specified.";

           const commitMsg = args.slice(1).join(' ') || `Update ${path} via Nexus Prime`;
           const token = Nexus.state.prefs.ghToken;
           const repo = Nexus.state.prefs.ghRepo;
           const url = `https://api.github.com/repos/${repo}/contents/${path}`;
           
           const content = Nexus.state.Vfs[path];
           if (content === undefined) return `Error: '${path}' not found in Vortex.`;

           try {
               const getRes = await Nexus.github.fetchWithTimeout(url, {
                   headers: { "Authorization": `token ${token}` }
               });
               
               let sha = "";
               if (getRes.ok) {
                   const getData = await getRes.json();
                   sha = getData.sha;
               }

               const payload = {
                   message: commitMsg,
                   content: btoa(unescape(encodeURIComponent(content))), 
                   sha: sha 
               };

               const putRes = await Nexus.github.fetchWithTimeout(url, {
                   method: "PUT",
                   headers: {
                       "Authorization": `token ${token}`,
                       "Content-Type": "application/json"
                   },
                   body: JSON.stringify(payload)
               });

               if (!putRes.ok) {
                   const errData = await putRes.json();
                   throw new Error(errData.message || "Upload failed");
               }

               return `${path}: Pushed to GitHub ✅`;
           } catch (e) {
               return `Push failed: ${e.message} ❌`;
           }
       }
   }, // Ends commands object

async exec(cmdStr) {
    // Pre-process the command string to convert ZZ -> // before parsing!
    const cleanCmdStr = Nexus.compiler.preprocess(cmdStr);

    const parts = cleanCmdStr.trim().split(/\s+/);
    const cmdName = parts[0].toLowerCase();
    const args = parts.slice(1);
    const action = this.commands[cmdName];

    try {
        if (action) {
            const result = await action(args);
            Nexus.UI.injectChar(`\n/* $ ${cleanCmdStr} */\n/* -> ${result} */\n`);
            return result;
        } else {
            // Intentional REPL fallback for the local dev terminal (same idea as
            // a browser DevTools console) — not a vulnerability by itself, since
            // input is local and interactive, never remote/imported content. Just
            // make sure exec() stays reachable only from this terminal input.
            return eval(cleanCmdStr); // Evaluates with proper slashes!
        }
    } catch (e) {
        return `Shell Fault: ${e.message}`;
    }
}

}, 

   
UI: {
    // Update your boot function to be completely non-blocking and guarded
    // Inside Nexus.UI
    async boot() { 
    
        // FIX (real, previously-undiscovered bug — every saved preference
        // was silently destroyed on every boot, not just the engine
        // choice): settings.boot() — the thing that actually loads the
        // real saved Nexus.state.prefs from storage — used to run AFTER
        // Vfs.boot(). But Vfs.boot() calls switchFile() internally, and
        // switchFile() calls setEditMode(Nexus.state.prefs.editMode ||
        // 'util') unconditionally — which in turn calls
        // settings.update(), which persists the ENTIRE current prefs
        // object back to storage. Since this ran before settings.boot()
        // had loaded anything, prefs was still sitting at hardcoded
        // defaults at that exact moment — so this write overwrote every
        // real saved preference (activeEngine, editMode, everything) with
        // defaults, moments before settings.boot() would have correctly
        // restored them. By the time settings.boot() ran, the real save
        // was already gone. Confirmed directly: seeded storage with
        // activeEngine:'cm6', watched the actual write during Vfs.boot(),
        // and captured it writing 'vanilla' back to storage before
        // settings.boot() ever got a chance to read the real value.
        // Moving settings.boot() first means Nexus.state.prefs is
        // genuinely hydrated with real saved values before ANYTHING else
        // in boot can read from or re-persist it.
        if (Nexus.settings && typeof Nexus.settings.boot === 'function') await Nexus.settings.boot();

        // FIX: Manually ignite the UI engines for ribbon and swipes
        if (typeof this.initSubSystems === 'function') this.initSubSystems();
        if (typeof this.updateWidgets === 'function') this.updateWidgets();
    
        // 1. Core Vfs Initialization
        if (Nexus.Vfs && typeof Nexus.Vfs.boot === 'function') {
            await Nexus.Vfs.boot(); 
        } else {
            console.warn("VORTEX BOOT WARN: Nexus.Vfs core module missing or unparsed.");
        }
    
        // 2. Safe Guarded Module Cascade
        if (Nexus.vault && typeof Nexus.vault.boot === 'function') await Nexus.vault.boot(); 
        if (Nexus.snapshots && typeof Nexus.snapshots.boot === 'function') await Nexus.snapshots.boot(); 

        // The second updateWidgets()/renderUtilBar()/renderUtilMirror()
        // call that used to sit here is no longer needed: it existed
        // specifically because settings.boot() used to run AFTER Vfs.boot,
        // so the first calls up top only ever saw hardcoded defaults and
        // needed a repeat once the real prefs were in. Now that
        // settings.boot() runs first (see this function's own opening
        // comment for why), the very first initSubSystems()/
        // updateWidgets() call already has the real saved values —
        // calling them again here was harmless but redundant.
        
        // 3. Engine Initializations
        if (Nexus.DpadEngine && typeof Nexus.DpadEngine.init === 'function') Nexus.DpadEngine.init();
        // The dock's arrow buttons (and their hold-to-repeat) get their
        // listeners from setupFastHold(). This used to live only inside a
        // dead function nothing called, so the bottom-toolbar arrows never
        // worked at all. It must run at boot, unconditionally.
        if (Nexus.DpadEngine && typeof Nexus.DpadEngine.setupFastHold === 'function') Nexus.DpadEngine.setupFastHold();
        if (Nexus.omni && typeof Nexus.omni.init === 'function') Nexus.omni.init();
        if (Nexus.CR && typeof Nexus.CR.init === 'function') Nexus.CR.init();
        if (Nexus.Terminal && typeof Nexus.Terminal.init === 'function') Nexus.Terminal.init();
        
        // RESTORE saved engine preference
        if (Nexus.state.prefs.activeEngine === 'cm6' && Nexus.state.activeFile) {
            setTimeout(() => Nexus.toggleEditor(), 300);
        }

        // RESTORE saved edit-mode (util/full — 'readonly' no longer exists
        // as a mode) — chained after a longer delay than the engine
        // restoration above so it applies once CM6 (if being restored) has
        // actually finished swapping in; applying inputmode/contentEditable
        // state before that would touch Nexus.editorCore.view.contentDOM
        // before that view exists.
        // Defaults to 'util' (the safer of the two remaining states — still
        // fully interactive, just keyboard-suppressed) if nothing was ever
        // saved, or if a pre-refactor save still has the old 'readonly'
        // value sitting in storage — setEditMode() itself also collapses
        // any unrecognized value to 'util' as a second layer of the same
        // guard.
        if (Nexus.state.activeFile) {
            setTimeout(() => {
                Nexus.UI.setEditMode(Nexus.state.prefs.editMode || 'util');
            }, 500);
        }
        
        // 4. Element DOM Check
        if (document.getElementById('dreamerType') && Nexus.dreamer && typeof Nexus.dreamer.updatePreview === 'function') {
            Nexus.dreamer.updatePreview(); 
        }

        // 5. Keyboard-aware viewport (see trackKeyboardViewport below). Runs
        // once for the app's lifetime, not per-file/per-engine-switch.
        if (typeof this.trackKeyboardViewport === 'function') this.trackKeyboardViewport();
        
    },
    
  // Fixed initialization block structure with explicit method wrapping and closing brace
  initSubSystems() {  
      if (typeof this.renderUtilBar === 'function') this.renderUtilBar();  
      if (typeof this.renderUtilMirror === 'function') this.renderUtilMirror();
      if (typeof this.renderNavDrawerButtons === 'function') this.renderNavDrawerButtons();
      if (typeof this.initInfiniteRibbon === 'function') this.initInfiniteRibbon(); 
      if (typeof this.initEdgeSwipes === 'function') this.initEdgeSwipes(); 
      if (typeof this.syncStatus === 'function') this.syncStatus(); 

      // FIX: navButtonsHidden was written by toggleNavButtons() but never
      // read back anywhere — the arrow-key group's shown/hidden state
      // reset to always-shown on every reload regardless of what was last
      // chosen. Applied directly (not via toggleNavButtons() itself, which
      // would flip whatever the current state already is rather than set
      // it to a known value).
      const dpadContainer = document.getElementById('dpadContainer');
      const navBtn = document.getElementById('navToggleBtn');
      if (dpadContainer && Nexus.state.prefs.navButtonsHidden) {
          dpadContainer.style.display = 'none';
          if (navBtn) navBtn.classList.add('active');
      }
  }, // <-- Closes initSubSystems cleanly and separates it from the next method!
  
  // Wrapped the naked widget sequence safely into its own method container
  updateWidgets() {
      if (Nexus.state && Nexus.state.widgets) {
          Object.keys(Nexus.state.widgets).forEach(id => {
              const el = document.getElementById(id);
              if (el) el.style.display = Nexus.state.widgets[id] ? 'flex' : 'none';
          });
      }
  }, // <-- Added the crucial closing method brace and trailing comma!

  // KEYBOARD-AWARE VIEWPORT — "the editor should rise above the keyboard,
  // not be hidden behind it." Two browser families need two different
  // fixes, and this covers both without them fighting each other:
  //
  //   - Chrome/Firefox on Android: the <meta interactive-widget=
  //     resizes-content> tag (see <head>) already makes the LAYOUT viewport
  //     itself shrink when the keyboard opens, so #appRoot's existing
  //     `height: 100dvh` automatically becomes correct — no JS needed, and
  //     this function's CSS var ends up unused there (harmless).
  //   - iOS Safari does not implement that meta tag at all. There, only the
  //     VISUAL viewport shrinks; the layout viewport (and therefore dvh,
  //     and therefore #appRoot) stays the original full-screen size, which
  //     is exactly why content ends up rendered underneath/behind the
  //     keyboard. The only reliable signal on iOS is the
  //     window.visualViewport resize event, so this listens for that and
  //     writes the real, live height into a CSS custom property.
  //
  // --app-vh-px is consumed by a small additive CSS rule (search
  // "--app-vh-px" in the <style> block) that only takes effect via an
  // @supports-guarded selector scoped to exactly the case where the visual
  // viewport is shorter than the layout viewport — i.e. only when a
  // keyboard (or similar overlay) is actually open — so it does nothing on
  // desktop or when the keyboard is closed, and never overrides the normal
  // 100dvh sizing that already works correctly everywhere else.
  trackKeyboardViewport() {
      if (!window.visualViewport) return; // very old browser — no signal available, degrade to prior (imperfect) behavior rather than throw
      const root = document.documentElement;
      const applyHeight = () => {
          root.style.setProperty('--app-vh-px', `${window.visualViewport.height}px`);
      };
      applyHeight();
      window.visualViewport.addEventListener('resize', applyHeight);
      // iOS in particular can fire scroll on the visual viewport as the
      // keyboard animates open/closed without a matching resize event on
      // some versions; re-applying on both keeps the boundary tracking
      // smoothly through the animation instead of snapping at the end.
      window.visualViewport.addEventListener('scroll', applyHeight);
  }, // <-- closes trackKeyboardViewport
  
  checkSyntax: () => {
      // 1. Get the code currently in your editor
      const ed = document.getElementById('rawTerminal');
      if (!ed) return;
      const code = ed.value; 
      
      try {
          // 2. Acorn attempts a strict parse
          acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" });
          Nexus.shell.out("Structure is valid — no syntax errors. Any problem is logic, not syntax.", "success");
      } catch (e) {
          // 3. Catch the exact line/column where the browser is choking
          const { line, column } = e.loc;
          const errorMsg = `SYNTAX ERROR FOUND:\n\n"${e.message}"\nLine: ${line}, Col: ${column}`;
          
          console.error(errorMsg);
          alert(errorMsg);
          
          // Optional: If you have a jump function, use it to go to the line
          if(Nexus.UI && typeof Nexus.UI.jumpToLine === 'function') Nexus.UI.jumpToLine(line);
      }
  },
  
   handleHandleTap(e, id) {
   const now = Date.now();
   if (Nexus.UI.lastTap && (now - Nexus.UI.lastTap < 300) && Nexus.UI.lastId === id) { 
       Nexus.UI.toggleSnap(id); 
       e.preventDefault(); 
       return; 
   }
   Nexus.UI.lastTap = now; 
   Nexus.UI.lastId = id;
       
       const el = document.getElementById(id);
       if (el.dataset.snapped === 'true') { 
           this.toggleSnap(id); 
           return; 
       }
       this.initDrag(e, id);
   },
// --- Place these inside Nexus.UI ---

// NOTE: no longer wired to any button. 🎮 (#ribbonDpadToggle) now opens
// #navDrawer via toggleDrawer('navDrawer') instead — this used to be that
// button's onclick, toggling the inline arrow/SEL/CTRL strip's visibility
// in the footer dock. Left defined (harmless, still callable) rather than
// deleted in case a future footer-decluttering pass wants to re-expose
// #dpadContainer's show/hide separately from the drawer.
toggleDpadPanel() {
    const container = document.getElementById('dpadContainer');
    const btn = document.getElementById('ribbonDpadToggle');
    if (!container) return;

    // Toggle display layout directly to avoid inline CSS conflicts
    if (container.style.display === 'none') {
        container.style.display = 'inline-flex';
        btn?.classList.add('btn-active');
    } else {
        container.style.display = 'none';
        btn?.classList.remove('btn-active');
    }

    window.dispatchEvent(new Event('resize'));
},

toggleKeyboardRows() {
    const container = document.getElementById('keyboardRowsContainer');
    const btn = document.getElementById('rowToggleBtn');
    if (!container) return;

    if (container.style.display === 'none' || !container.style.display) {
        container.style.display = 'block';
        btn?.classList.add('btn-active');
        
        // RE-TRIGGER INJECTION: Forces Nexus.kb to populate #kbRowsWrapper immediately
        const activeTab = document.querySelector('#kbLangToggles .kb-tab.active');
        if (activeTab) {
            activeTab.click();
        } else {
            // Fallback to HTML if no tab is marked active yet
            Nexus.kb?.switchLang('html'); 
        }
    } else {
        container.style.display = 'none';
        btn?.classList.remove('btn-active');
    }

    window.dispatchEvent(new Event('resize'));
},


   toggleSnap(id) {
       // FIX: `el.dataset` on the next line was completely unguarded — a
       // missing element (a renamed/removed ID, a stale caller) made this
       // throw "Cannot read properties of null", and since this runs from
       // a tap handler it would surface as a dead-feeling UI rather than
       // anything obviously diagnosable.
       const el = document.getElementById(id); 
       if (!el) {
           console.error(`toggleSnap: no element with id '${id}' — ignoring.`);
           return;
       }
       const isSnapped = el.dataset.snapped === 'true';
       
       el.style.transition = 'all 0.4s cubic-bezier(0.19, 1, 0.22, 1)';
       
       if (isSnapped) {
           // Unsnap: Return to float coordinates
           el.style.left = el.dataset.lx || '20px'; 
           el.style.top = el.dataset.ty || '140px';
           el.dataset.snapped = 'false';
           el.style.opacity = '1';
       } else {
           // Snap: Store current pos and dock to edge
           el.dataset.lx = el.style.left; 
           el.dataset.ty = el.style.top;
           
           if (id === 'kb-monolith') {
               if (Nexus.state.prefs.kbPos === 'top') {
                   el.style.top = '55px';
               } else {
                   el.style.bottom = '0px';
                   el.style.top = 'auto';
               }
           } else {
               // Dock to right edge, revealing only the grip handle (24px)
               el.style.left = (window.innerWidth - 24) + 'px';
           }
           el.dataset.snapped = 'true';
           el.style.opacity = '0.7'; 
       }
   },

   // Tracks the currently-active drag's own move/end closures (module-
   // level state, one drag at a time across the whole app — this app only
   // ever has 2 draggable floating widgets and dragging is inherently a
   // single-pointer gesture, so one shared slot is correct, not a
   // per-widget map).
   _activeDrag: null,

   initDrag(e, id) {
       // Same unguarded-null fix as toggleSnap above — el.dataset here had
       // no null check either.
       const el = document.getElementById(id);
       if (!el) {
           console.error(`initDrag: no element with id '${id}' — ignoring.`);
           return;
       }
       if (el.dataset.snapped === 'true') return;

       // FIX (real, plausible "random freezes" source — same bug class as
       // the utility-bar scrub fix above, actually worse here): move/end
       // used to be freshly-created ANONYMOUS closures on every single
       // call, with zero guard against re-entry. If the matching
       // touchend/mouseup was ever swallowed before reaching this listener
       // (an interrupting call/notification, the OS intercepting a
       // gesture, the app backgrounding mid-drag — all real, common
       // touchscreen conditions, not edge cases), that closure pair was
       // permanently orphaned: since they were anonymous, nothing kept a
       // reference to remove them later even if you wanted to — they'd
       // just sit there forever as 2 more live document-level
       // mousemove/touchmove listeners, doing real DOM writes (style.left/
       // top) on every pixel of movement anywhere on the page. Every
       // SUBSEQUENT drag of either floating widget in this app added yet
       // another pair on top, with no cap. Fixed by tracking the current
       // drag's handlers in one shared slot (_activeDrag) so a new drag
       // can always force-clean whatever the previous one left behind
       // before attaching its own — removeEventListener on a handler
       // that's already gone is a harmless no-op, so this is safe to run
       // unconditionally.
       if (this._activeDrag) {
           document.removeEventListener(this._activeDrag.moveEvent, this._activeDrag.move);
           document.removeEventListener(this._activeDrag.endEvent, this._activeDrag.end);
           this._activeDrag = null;
       }
       
       const isTouch = e.type && e.type.indexOf('touch') === 0;
       const clientX = isTouch ? e.touches[0].clientX : e.clientX;
       const clientY = isTouch ? e.touches[0].clientY : e.clientY;

       let ox = clientX - el.offsetLeft;
       let oy = clientY - el.offsetTop;

       const move = (me) => {
           const mX = isTouch ? me.touches[0].clientX : me.clientX;
           const mY = isTouch ? me.touches[0].clientY : me.clientY;
           
           el.style.left = (mX - ox) + 'px';
           el.style.top = (mY - oy) + 'px';
           el.style.right = 'auto'; 
           el.style.bottom = 'auto';
       };

       const moveEvent = isTouch ? 'touchmove' : 'mousemove';
       const endEvent = isTouch ? 'touchend' : 'mouseup';

       const end = () => {
           document.removeEventListener(moveEvent, move);
           document.removeEventListener(endEvent, end);
           if (Nexus.UI._activeDrag && Nexus.UI._activeDrag.end === end) {
               Nexus.UI._activeDrag = null;
           }
       };

       this._activeDrag = { move, end, moveEvent, endEvent };
       document.addEventListener(moveEvent, move, { passive: false });
       document.addEventListener(endEvent, end);
   },
   toggleWidget(id) {
           const el = document.getElementById(id);
           if (!el) return;
           const isHidden = el.style.display === 'none' || el.style.display === '';
           el.style.display = isHidden ? 'flex' : 'none';
           Nexus.state.widgets[id] = isHidden;
           // FIX: this used to call Nexus.Vfs.save(), which only persists
           // file contents — it never touched widget visibility at all, so
           // every toggle silently failed to save despite the comment here
           // saying otherwise. Persist through the same settings/prefs
           // mechanism the rest of the app's preferences already use.
           Nexus.settings.update('widgetVisibility', Nexus.state.widgets);
       },

       // The old grip on this bar tried to free-drag it (onmousedown only —
       // never wired for touch at all), which fought the !important CSS that
       // pins it to the right edge and never actually worked. Now that it's a
       // proper docked column, the grip collapses it to a slim strip instead —
       // a much more useful interaction for a fixed-position sidebar anyway.
       toggleUtilCollapse() {
           const el = document.getElementById('utilityBar');
           if (!el) return;
           const collapsed = el.classList.toggle('util-collapsed');
           const grip = el.querySelector('.util-grip');
           if (grip) grip.textContent = collapsed ? '»' : '«';
           Nexus.state.prefs.utilBarCollapsed = collapsed;
           Nexus.Vfs.save();
       },

       // Fast-scroll scrub: press the utility bar's grip and drag
       // vertically to jump proportionally through the document — grab
       // near the top of the screen and drag to 75% down and you land at
       // roughly line (0.75 × total lines), regardless of file size. A
       // genuine tap (released before any meaningful vertical movement)
       // still falls through to the existing collapse/expand toggle, so
       // this doesn't change that behavior at all — it only adds a new
       // gesture on top of it.
       //
       // The proportion is computed against the EDITOR'S OWN on-screen
       // viewport rect, not the grip's tiny height or the full window —
       // "3/4 of the way down the screen" only lines up with "75% into the
       // file" if 0%/100% are anchored to where the editor visually starts
       // and ends, which is #cm6Container/#rawTerminal's bounding box, not
       // an arbitrary fixed pixel range.
       _scrub: { active: false, startY: 0, startX: 0, moved: false, indicatorEl: null },

       scrubStart(event) {
           // FIX (real, plausible "random freezes, gets worse over time"
           // source): this added 4 document-level listeners on every
           // single call with NO guard against re-entry and no
           // corresponding cleanup if the matching scrubEnd never fires.
           // scrubEnd normally removes them correctly (it uses named
           // function references, the right way to make removeEventListener
           // actually work) — but on a touchscreen, a touchend/mouseup can
           // genuinely get swallowed before it ever reaches this listener:
           // an interrupting call/notification overlay, the OS intercepting
           // a gesture, the app backgrounding mid-touch, a finger sliding
           // off-screen. Any of those leaves _scrub.active stuck true
           // forever with 4 real listeners still attached — and the NEXT
           // press of this same grip would have added 4 MORE on top,
           // since there was no guard here at all. Repeat that a handful
           // of times across a session and you get a pile of duplicate
           // global mousemove/touchmove handlers — each doing real work
           // (line-offset math, preventDefault, DOM reads) on every pixel
           // of movement ANYWHERE on the page, not just on the grip —
           // which matches "random freezes that aren't consistent" far
           // better than a deterministic bug would: it depends entirely
           // on how many times a scrub gesture got interrupted, which
           // varies session to session.
           //
           // Two-part fix: force-clean any stale listeners from a
           // previous, never-completed drag before starting a new one
           // (idempotent — removing a listener that isn't there is a
           // harmless no-op), and reset _scrub.active first so a
           // currently-active real drag can't have its own state wiped
           // out from under it by this call.
           if (this._scrub.active) {
               document.removeEventListener('mousemove', Nexus.UI.scrubMove);
               document.removeEventListener('touchmove', Nexus.UI.scrubMove);
               document.removeEventListener('mouseup', Nexus.UI.scrubEnd);
               document.removeEventListener('touchend', Nexus.UI.scrubEnd);
           }

           const point = event.touches ? event.touches[0] : event;
           this._scrub.active = true;
           this._scrub.startY = point.clientY;
           this._scrub.startX = point.clientX;
           this._scrub.moved = false;

           document.addEventListener('mousemove', Nexus.UI.scrubMove);
           document.addEventListener('touchmove', Nexus.UI.scrubMove, { passive: false });
           document.addEventListener('mouseup', Nexus.UI.scrubEnd);
           document.addEventListener('touchend', Nexus.UI.scrubEnd);
       },

       scrubMove(event) {
           if (!Nexus.UI._scrub.active) return;
           const point = event.touches ? event.touches[0] : event;
           const dy = Math.abs(point.clientY - Nexus.UI._scrub.startY);
           const dx = Math.abs(point.clientX - Nexus.UI._scrub.startX);

           // Small deadzone (8px) before committing to drag mode, so a
           // slightly-imprecise tap (finger moves a pixel or two on
           // release, completely normal on touchscreens) doesn't
           // accidentally trigger a scroll-jump instead of the expected
           // collapse/expand toggle.
           if (!Nexus.UI._scrub.moved && (dy > 8 || dx > 8)) {
               Nexus.UI._scrub.moved = true;
               Nexus.UI._showScrubIndicator();
           }
           if (!Nexus.UI._scrub.moved) return;

           event.preventDefault(); // stop page scroll/text selection while dragging

           const editorEl = document.getElementById('cm6Container').style.display !== 'none'
               ? document.getElementById('cm6Container')
               : document.getElementById('rawTerminal');
           if (!editorEl) return;
           const rect = editorEl.getBoundingClientRect();

           // Clamp to [0,1] — dragging above or below the editor's own
           // visible bounds still resolves to line 1 or the last line
           // rather than doing nothing or erroring.
           const ratio = Math.max(0, Math.min(1, (point.clientY - rect.top) / rect.height));

           const totalLines = (Nexus.editorCore.isCM6 && Nexus.editorCore.view)
               ? Nexus.editorCore.view.state.doc.lines
               : (document.getElementById('rawTerminal')?.value.split('\n').length || 1);

           const targetLine = Math.max(1, Math.min(totalLines, Math.round(ratio * totalLines)));

           Nexus.UI._updateScrubIndicator(targetLine, totalLines, point.clientY);
           Nexus.UI.scrubJumpToLine(targetLine);
       },

       scrubEnd(event) {
           if (!Nexus.UI._scrub.active) return;
           Nexus.UI._scrub.active = false;

           document.removeEventListener('mousemove', Nexus.UI.scrubMove);
           document.removeEventListener('touchmove', Nexus.UI.scrubMove);
           document.removeEventListener('mouseup', Nexus.UI.scrubEnd);
           document.removeEventListener('touchend', Nexus.UI.scrubEnd);

           // Drop the cached line-offset table so the next drag rebuilds
           // it fresh — the file may have been edited since this drag
           // started, and a stale table would map line numbers to the
           // wrong character positions.
           Nexus.UI._scrubLineOffsets = null;

           if (Nexus.UI._scrub.moved) {
               // Was a drag — clean up the indicator, don't also fire the
               // collapse toggle (a real gesture just happened, treating
               // its release as a "tap" would be surprising).
               Nexus.UI._hideScrubIndicator();
               // A single focus() + scrollIntoView() now, after the drag
               // ends, gives CM6 a chance to properly center/settle the
               // final position — scrubJumpToLine() skipped this on every
               // intermediate move for performance, so it's worth doing
               // once here at the real destination.
               if (Nexus.editorCore.isCM6 && Nexus.editorCore.view) {
                   Nexus.editorCore.view.dispatch({ scrollIntoView: true });
                   Nexus.editorCore.view.focus();
               }
           } else {
               // Was a genuine tap — preserve the original grip behavior
               // exactly as it worked before this feature existed.
               Nexus.UI.toggleUtilCollapse();
           }
       },

       _showScrubIndicator() {
           if (this._scrub.indicatorEl) return;
           const el = document.createElement('div');
           el.id = 'scrubIndicator';
           el.style.cssText = `
               position: fixed; right: 60px; z-index: 9999;
               background: var(--gold); color: #0d1117; font-weight: 900;
               font-family: monospace; font-size: 13px; padding: 6px 12px;
               border-radius: 6px; box-shadow: 0 2px 10px rgba(0,0,0,0.4);
               pointer-events: none; white-space: nowrap;
               transform: translateY(-50%);
           `;
           document.body.appendChild(el);
           this._scrub.indicatorEl = el;
       },

       _updateScrubIndicator(line, total, clientY) {
           const el = this._scrub.indicatorEl;
           if (!el) return;
           el.style.top = clientY + 'px';
           el.innerText = `LINE ${line} / ${total}`;
       },

       _hideScrubIndicator() {
           if (this._scrub.indicatorEl) {
               this._scrub.indicatorEl.remove();
               this._scrub.indicatorEl = null;
           }
       },

       explodeVortex() {
           const isExploded = document.body.classList.toggle('vortex-active');
           const root = document.getElementById('appRoot');
           


           if (isExploded) {
               // Perspective is required for Z-axis translation to work
               root.style.perspective = "1000px";
               root.style.overflow = "visible";
       root.style.transformStyle = "preserve-3d";        
               document.querySelectorAll('#appRoot *').forEach(el => {
                   const z = window.getComputedStyle(el).zIndex;
                   if (z !== 'auto' && z !== '0') {
                       // Clamp translation so high z-index items (modals) don't vanish
                       const depth = Math.min(parseInt(z) * 5, 500); 
                       el.style.transition = "transform 0.5s cubic-bezier(0.19, 1, 0.22, 1), box-shadow 0.5s ease";
                       el.style.transform = `translateZ(${depth}px) rotateX(10deg) rotateY(-5deg)`;
                       el.style.boxShadow = "5px 10px 30px rgba(0, 0, 0, 0.5)";
                       el.dataset.vortex = "true";
                   }
               });
           } else {
               root.style.perspective = "";
               root.style.overflow = "hidden";
               document.querySelectorAll('[data-vortex="true"]').forEach(el => {
                   el.style.transform = "";
                   el.style.boxShadow = "";
                   delete el.dataset.vortex;
               });
           }
       },

               injectChar(val) {
   const ed = document.getElementById('rawTerminal');

   // FIX (unreliable Insert Tab): this always checked #rawTerminal's own
   // readonly attribute as a stand-in for "is editing locked right now,"
   // even when CM6 was the actual live engine. #rawTerminal and CM6's
   // contentDOM are supposed to be kept in lockstep by setEditMode() and
   // the engine-swap sync block, but that's several separate code paths
   // agreeing to stay in sync by convention, not one shared source of
   // truth being read from directly — any gap between them (one existed
   // until this session's engine-swap fix) left this check silently
   // testing the WRONG surface's lock state while CM6 was active, which
   // is exactly the kind of intermittent "works/doesn't work" behavior
   // reported. Check whichever engine is actually live, directly.
   const cmDom = (Nexus.editorCore && Nexus.editorCore.view && Nexus.editorCore.view.contentDOM) || null;
   const isLocked = (Nexus.editorCore.isCM6 && cmDom)
       ? cmDom.contentEditable === "false"
       : ed.hasAttribute('readonly');
   if (isLocked || !Nexus.state.activeFile) return;

   let processed = val.replace(/\*\+/g, '\t').replace(/\\t/g, '\t'); 
   let cursorOffset = processed.indexOf('*#'); 
   
   if (cursorOffset !== -1) {
       processed = processed.replace(/\*\#/g, '');
   } else {
       cursorOffset = processed.length;
   }

   if (Nexus.editorCore.isCM6 && Nexus.editorCore.view) {
       const view = Nexus.editorCore.view;
       const pos = view.state.selection.main.head;
       
       if (val === 'BACKSPACE') {
           if (pos > 0) {
               view.dispatch({
                   changes: { from: pos - 1, to: pos, insert: "" },
                   selection: { anchor: pos - 1 }
               });
           }
       } else {
           view.dispatch({
               changes: { from: pos, insert: processed },
               selection: { anchor: pos + cursorOffset }
           });
       }
       
       Nexus.state.Vfs[Nexus.state.activeFile] = view.state.doc.toString();
       Nexus.Vfs.save();
       Nexus.history.record();
       return; 
   }

   const start = ed.selectionStart;
   const end = ed.selectionEnd;
   
   if (val === 'BACKSPACE') {
       if (start === end && start > 0) {
           ed.value = ed.value.substring(0, start - 1) + ed.value.substring(end);
           ed.setSelectionRange(start - 1, start - 1);
       }
   } else {
       ed.value = ed.value.substring(0, start) + processed + ed.value.substring(end);
       ed.setSelectionRange(start + cursorOffset, start + cursorOffset);
   }
   
   Nexus.state.Vfs[Nexus.state.activeFile] = ed.value;
   this.updateGutter();
   Nexus.Vfs.save();
   Nexus.history.record();
},

// Zoom in/out — applies immediately to whichever engine is live via
// settings.apply(), and persists so it's still correct on the next boot.
adjustFontSize(delta) {
    const current = Nexus.state.prefs.fontSize || 14;
    const next = Math.min(24, Math.max(10, current + delta));
    if (next === current) return;
    Nexus.settings.update('fontSize', next);
},

// The utility bar's "Run Sweep" button needs the results panel actually
// visible — Full Sweep just populates auditor-report-box, which lives
// inside panel-right and could be closed at the time this is tapped.
utilRunSweep() {
    const panel = document.getElementById('panelRight');
    if (panel && !panel.classList.contains('open')) Nexus.UI.toggleSidebar('right');
    Nexus.auditor.runFullSweep();
},

// Inserts a human-readable local timestamp at the cursor.
insertDateTime() {
    const now = new Date();
    const stamp = now.toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
    Nexus.UI.injectChar(stamp);
},

// Inserts a fresh random UUID at the cursor.
insertUUID() {
    Nexus.UI.injectChar(crypto.randomUUID());
},

       
     

               async jumpPrompt(directLine) {
           if (!Nexus.state.activeFile) return Nexus.shell.out("No file open — open or create a file first.", "warn");
           
           // 1. Safety Guard: Ignore accidental MouseEvents from button clicks
           let ln = directLine;
           if (typeof directLine === 'object') ln = null; 
           
           // 2. Ask, if no valid line was passed in. Shows the file's real
           // line count and rejects out-of-range values up front — the old
           // prompt took any number, then either silently clamped or did
           // nothing, so "jump to 900" in a 300-line file gave no clue what
           // went wrong.
           if (!ln) {
               const total = (Nexus.editorCore.isCM6 && Nexus.editorCore.view)
                   ? Nexus.editorCore.view.state.doc.lines
                   : ((Nexus.state.Vfs[Nexus.state.activeFile] || '').split('\n').length);
               const answer = await Nexus.UI.askInput({
                   title: 'JUMP TO LINE',
                   label: 'Line number',
                   numeric: true,
                   placeholder: '1',
                   hint: `${Nexus.state.activeFile} has ${total} line${total === 1 ? '' : 's'}`,
                   validate: (v) => {
                       const t = (v || '').trim();
                       if (!t) return 'Enter a line number.';
                       if (!/^\d+$/.test(t)) return 'Numbers only.';
                       const n = parseInt(t, 10);
                       if (n < 1) return 'Line numbers start at 1.';
                       if (n > total) return `This file only has ${total} line${total === 1 ? '' : 's'}.`;
                       return null;
                   }
               });
               if (!answer) return; // cancelled
               ln = answer.trim();
           }
           
           // 3. The NaN Guard: Prevent letters from crashing the CM6 document state!
           const line = parseInt(ln);
           if (isNaN(line) || line < 1) return alert("Invalid line number.");
           
           // --- CM6 ROUTING ---
           if (Nexus.editorCore.isCM6 && Nexus.editorCore.view) {
               const view = Nexus.editorCore.view;
               const doc = view.state.doc;
               
               // Clamp line request to actual document length
               const targetLine = Math.max(1, Math.min(line, doc.lines));
               const pos = doc.line(targetLine).from;
               
               view.dispatch({
                   selection: { anchor: pos },
                   scrollIntoView: true
               });
               view.focus();
               return;
           }

           // --- VANILLA ROUTING ---
           const ed = document.getElementById('rawTerminal');
           const lines = ed.value.split('\n');
           let pos = 0;
           
           // Safe upper limit to prevent out-of-bounds looping
           const safeLineLimit = Math.min(line - 1, lines.length);
           for (let i = 0; i < safeLineLimit; i++) pos += lines[i].length + 1;
           
           ed.focus(); 
           ed.setSelectionRange(pos, pos);
           
           setTimeout(() => {
               const lh = 22; // Match your CSS line-height
               const targetScroll = 15 + ((line - 1) * lh) - (ed.clientHeight / 2) + (lh / 2);
               ed.scrollTop = Math.max(0, targetScroll);
           }, 50);
       },

       jumpRelative(offset) {
           if (!Nexus.state.activeFile) return Nexus.shell.out("No file open — open or create a file first.", "warn");
           
           // --- CM6 ROUTING ---
           if (Nexus.editorCore.isCM6 && Nexus.editorCore.view) {
               const view = Nexus.editorCore.view;
               const doc = view.state.doc;
               const currentPos = view.state.selection.main.head;
               const currentLine = doc.lineAt(currentPos).number;
               
               const targetLine = Math.max(1, Math.min(doc.lines, currentLine + offset));
               const newPos = doc.line(targetLine).from;
               
               view.dispatch({
                   selection: { anchor: newPos },
                   scrollIntoView: true
               });
               view.focus();
               return;
           }

           // --- VANILLA ROUTING ---
           const ed = document.getElementById('rawTerminal');
           const lines = ed.value.split('\n');
           const currentPos = ed.selectionStart;
           
           let currentLine = 0, chars = 0;
           for(let i=0; i<lines.length; i++) {
               chars += lines[i].length + 1;
               if(chars > currentPos) { 
                   currentLine = i; 
                   break; 
               }
           }
   
           const targetLine = Math.max(0, Math.min(lines.length - 1, currentLine + offset));
           let pos = 0;
           for (let i = 0; i < targetLine; i++) pos += lines[i].length + 1;
           
           ed.focus();
           ed.setSelectionRange(pos, pos);
           
           setTimeout(() => {
               const lh = parseInt(window.getComputedStyle(ed).lineHeight) || 22;
               const targetScroll = 15 + (targetLine * lh) - (ed.clientHeight / 2) + (lh / 2);
               ed.scrollTop = Math.max(0, targetScroll);
           }, 50);
       },



       // Single source of truth for what a tool is called and how it's
       // grouped in the customization modal below. Keys must match the
       // `tools` map in renderUtilBar() exactly. Display order here is also
       // the order tools are written into the saved layout string.
       // Single source of truth for what a tool is called and how it's
       // grouped when browsing "Available Tools" in the customization modal.
       // Keys must match the `tools` map in renderUtilBar() exactly.
       UTIL_TOOL_META: [
           { group: 'Editing', key: 'fullFold', label: 'Full Fold (collapse to top level)' },
           { group: 'Editing', key: 'oneFold', label: 'Fold -1 (one layer deeper)' },
           { group: 'Editing', key: 'unfold', label: 'Unfold All' },
           { group: 'Editing', key: 'oneUnfold', label: 'Unfold +1 (next layer up)' },
           { group: 'Editing', key: 'map', label: 'Save Structure Map' },
           { group: 'Fix & Format', key: 'oneLine', label: 'Format to One Line (function/class/const)' },
           { group: 'Fix & Format', key: 'editChunk', label: 'Edit Chunk (open function/class/const in mini-editor)' },
           { group: 'Selection & Lines', key: 'selectNext', label: 'Select Next Occurrence (multi-cursor)' },
           { group: 'Selection & Lines', key: 'selectAllMatches', label: 'Select All Occurrences (multi-cursor)' },
           { group: 'Selection & Lines', key: 'jumpBracket', label: 'Jump to Matching Bracket' },
           { group: 'Selection & Lines', key: 'jumpLine', label: 'Go to Line Number' },
           { group: 'Selection & Lines', key: 'bookmarkHere', label: 'Toggle Bookmark on Current Line' },
           { group: 'Selection & Lines', key: 'bookmarksList', label: 'View All Bookmarks' },
           { group: 'Fix & Format', key: 'expandLine', label: 'Expand/Restore from One Line' },
           { group: 'Selection & Lines', key: 'duplicate', label: 'Duplicate Line' },
           { group: 'Selection & Lines', key: 'comment', label: 'Toggle Comment' },
           { group: 'Selection & Lines', key: 'copyline', label: 'Copy Line' },
           { group: 'Selection & Lines', key: 'select', label: 'Toggle Select-Lock' },
           { group: 'View', key: 'zoomin', label: 'Zoom In' },
           { group: 'View', key: 'zoomout', label: 'Zoom Out' },
           { group: 'View', key: 'color', label: 'Color Picker' },
           { group: 'Fix & Format', key: 'cleanchars', label: 'Clean Smart Characters' },
           { group: 'Fix & Format', key: 'stripcomments', label: 'Strip Comments' },
           { group: 'Fix & Format', key: 'sortlines', label: 'Sort Lines' },
           { group: 'Fix & Format', key: 'blanklines', label: 'Remove Blank Lines' },
           { group: 'Fix & Format', key: 'alignleft', label: 'Align Left' },
           { group: 'Fix & Format', key: 'reindent', label: 'Re-indent by Depth' },
           { group: 'Selection & Lines', key: 'lineStart', label: 'Move Cursor to Beginning of Line' },
           { group: 'Selection & Lines', key: 'lineEnd', label: 'Move Cursor to End of Line' },
           // Ribbon-mirrored tools — the ribbon's own fixed set (Save,
           // Refresh, Undo, Redo, Insert Tab, Outdent, Cut, Copy, Paste,
           // Run) mirrored here so they're also available as optional
           // utility-bar entries, per the "mirror ribbon options onto the
           // utility toolbar" requirement. Deliberately NOT added to
           // DEFAULT_UTIL_LAYOUT below — they start available-but-unchecked
           // in "Available Tools," same as every other opt-in tool, so
           // nobody's existing custom layout gets tools silently injected
           // into it that they never asked for.
           { group: 'Ribbon (Mirrored)', key: 'rbSave', label: 'Save Now' },
           { group: 'Ribbon (Mirrored)', key: 'rbRefresh', label: 'Refresh File (restore to original)' },
           { group: 'Ribbon (Mirrored)', key: 'rbUndo', label: 'Undo' },
           { group: 'Ribbon (Mirrored)', key: 'rbRedo', label: 'Redo' },
           { group: 'Ribbon (Mirrored)', key: 'rbInsertTab', label: 'Insert Tab' },
           { group: 'Ribbon (Mirrored)', key: 'rbOutdent', label: 'Outdent Line' },
           { group: 'Ribbon (Mirrored)', key: 'rbCut', label: 'Cut' },
           { group: 'Ribbon (Mirrored)', key: 'rbCopy', label: 'Copy' },
           { group: 'Ribbon (Mirrored)', key: 'rbPaste', label: 'Paste' },
           { group: 'Ribbon (Mirrored)', key: 'rbRun', label: 'Run / Preview' },
       ],

       // Nav Drawer's 4 action-button slots are independently customizable
       // (each a dropdown over the same tool catalog as the utility bar,
       // UTIL_TOOL_META, rather than a second parallel list of "what tools
       // exist" that could drift out of sync with it). This map supplies
       // just the two things the utility bar's own per-key HTML doesn't
       // cleanly separate out (onclick + a single icon glyph) — the
       // utility bar's own entries bundle in .util-lbl text labels and
       // icon sizing built for a horizontal scroll strip, which doesn't
       // fit the drawer's fixed 56x56px square buttons, so reusing that
       // markup directly wasn't a good fit. Every key here should also
       // exist in UTIL_TOOL_META (for its label, shown in the picker) —
       // intentionally a SUBSET, not every single utility tool, since a
       // few (color picker, save-structure-map) don't make sense as a
       // one-tap drawer action the way they do as a labeled bar button.
       NAV_DRAWER_TOOL_ICONS: {
           jumpBracket: { icon: '↔{}', onclick: 'Nexus.UI.jumpToMatchingBracket()' },
           oneLine: { icon: '⟷', onclick: 'Nexus.UI.collapseSelectionToOneLine()' },
           expandLine: { icon: '⟵⟶', onclick: 'Nexus.UI.expandSelectionFromOneLine()' },
           select: { icon: 'SEL', onclick: 'Nexus.DpadEngine.toggleSelectLock()' },
           editChunk: { icon: '🔎', onclick: 'Nexus.chunkEditor.openForCursor()' },
           fullFold: { icon: '⇐⇒', onclick: 'Nexus.UI.collapseAll()' },
           oneFold: { icon: '│', onclick: 'Nexus.UI.foldToLayer()' },
           unfold: { icon: '≤≥', onclick: 'Nexus.UI.expandAll()' },
           oneUnfold: { icon: '∧', onclick: 'Nexus.UI.unfoldOnce()' },
           selectNext: { icon: '⊕', onclick: 'Nexus.UI.selectNextOccurrence()' },
           selectAllMatches: { icon: '⊛', onclick: 'Nexus.UI.selectAllOccurrences()' },
           bookmarkHere: { icon: '🔖', onclick: 'Nexus.UI.toggleBookmarkHere()' },
           bookmarksList: { icon: '📑', onclick: 'Nexus.UI.openBookmarksPanel()' },
           duplicate: { icon: '⧉', onclick: 'Nexus.tools.duplicateLine()' },
           comment: { icon: '//', onclick: 'Nexus.tools.toggleComment()' },
           copyline: { icon: '❐', onclick: 'Nexus.tools.copyLine()' },
           zoomin: { icon: 'A+', onclick: "Nexus.UI.adjustFontSize(2)" },
           zoomout: { icon: 'A-', onclick: "Nexus.UI.adjustFontSize(-2)" },
           cleanchars: { icon: '📱', onclick: 'Nexus.pasteGuard.cleanActiveFile()' },
           stripcomments: { icon: '💬', onclick: 'Nexus.Sentinel.stripComments()' },
           sortlines: { icon: '🔤', onclick: 'Nexus.Sentinel.sortLines()' },
           blanklines: { icon: '🧽', onclick: 'Nexus.Sentinel.removeBlankLines()' },
           alignleft: { icon: '⬅️', onclick: 'Nexus.Sentinel.alignLeft()' },
           reindent: { icon: '📐', onclick: 'Nexus.Sentinel.reindentByDepth()' },
           lineStart: { icon: '⏮️', onclick: 'Nexus.DpadEngine.goToLineStart()' },
           lineEnd: { icon: '⏭️', onclick: 'Nexus.DpadEngine.goToLineEnd()' },
       },
       DEFAULT_NAV_DRAWER_LAYOUT: 'jumpBracket, oneLine, lineStart, lineEnd',

       renderNavDrawerButtons() {
           const layout = (Nexus.state.prefs.navDrawerLayout || Nexus.UI.DEFAULT_NAV_DRAWER_LAYOUT)
               .split(',').map(s => s.trim()).filter(Boolean);
           const metaByKey = {};
           Nexus.UI.UTIL_TOOL_META.forEach(t => { metaByKey[t.key] = t; });
           const slotIds = ['navDrawerSlot0', 'navDrawerSlot1', 'navDrawerSlot2', 'navDrawerSlot3'];

           slotIds.forEach((slotId, i) => {
               const el = document.getElementById(slotId);
               if (!el) return;
               const key = layout[i];
               const entry = key && Nexus.UI.NAV_DRAWER_TOOL_ICONS[key];
               if (!entry) {
                   el.innerHTML = '';
                   el.onclick = null;
                   el.title = 'Empty — assign a tool in Settings';
                   el.style.opacity = '0.3';
                   return;
               }
               el.style.opacity = '1';
               el.textContent = entry.icon;
               el.title = (metaByKey[key] && metaByKey[key].label) || key;
               el.setAttribute('aria-label', el.title);
               // Assigned via a real onclick attribute (not addEventListener)
               // so this survives being re-rendered — same convention every
               // other dynamically-populated button map in this file uses,
               // and keeps Select-Lock's own id (needed elsewhere for its
               // active-state sync) attachable when that's the assigned tool.
               el.setAttribute('onclick', entry.onclick + "; Nexus.UI.syncNavDrawerSelectLockId()");
           });
       },

       // Select-Lock's active/inactive visual state is synced by ID
       // elsewhere (DpadEngine.toggleSelectLock's own id list) — since
       // which drawer slot (if any) holds Select-Lock can change via
       // customization, this keeps exactly one slot tagged with the
       // expected id at a time rather than a fixed button always having it.
       syncNavDrawerSelectLockId() {
           const layout = (Nexus.state.prefs.navDrawerLayout || Nexus.UI.DEFAULT_NAV_DRAWER_LAYOUT).split(',').map(s => s.trim());
           ['navDrawerSlot0', 'navDrawerSlot1', 'navDrawerSlot2', 'navDrawerSlot3'].forEach((slotId, i) => {
               const el = document.getElementById(slotId);
               if (!el) return;
               if (layout[i] === 'select') el.id = 'navDrawerSelectLockBtn'; 
               // Restore the generic slot id afterward so the next render
               // pass can still find it by slot index — navDrawerSelectLockBtn
               // is only needed transiently for toggleSelectLock's own
               // classList sync, not as this element's permanent identity.
               else if (el.id === 'navDrawerSelectLockBtn') el.id = slotId;
           });
       },

       renderNavDrawerCustomizer() {
           const layout = (Nexus.state.prefs.navDrawerLayout || Nexus.UI.DEFAULT_NAV_DRAWER_LAYOUT).split(',').map(s => s.trim());
           const options = Object.keys(Nexus.UI.NAV_DRAWER_TOOL_ICONS);
           const metaByKey = {};
           Nexus.UI.UTIL_TOOL_META.forEach(t => { metaByKey[t.key] = t; });
           const labelFor = (key) => (metaByKey[key] && metaByKey[key].label) || key;

           let html = '';
           for (let i = 0; i < 4; i++) {
               const current = layout[i] || '';
               html += `<div style="display:flex; align-items:center; gap:8px; padding:6px 0;">
                   <span style="font-size:11px; opacity:0.6; width:56px; flex-shrink:0;">Slot ${i + 1}</span>
                   <select class="sleek-input" style="flex:1; font-size:12px;" onchange="Nexus.UI.setNavDrawerSlot(${i}, this.value)">
                       <option value="">— Empty —</option>
                       ${options.map(k => `<option value="${k}" ${k === current ? 'selected' : ''}>${labelFor(k)}</option>`).join('')}
                   </select>
               </div>`;
           }
           const list = document.getElementById('navDrawerLayoutList');
           if (list) list.innerHTML = html;
       },

       setNavDrawerSlot(index, key) {
           const layout = (Nexus.state.prefs.navDrawerLayout || Nexus.UI.DEFAULT_NAV_DRAWER_LAYOUT).split(',').map(s => s.trim());
           while (layout.length < 4) layout.push('');
           layout[index] = key;
           const cleaned = layout.slice(0, 4);
           Nexus.settings.update('navDrawerLayout', cleaned.join(', '));
           Nexus.UI.renderNavDrawerButtons();
       },
       // FIX: bookmarkHere/bookmarksList removed from the default
       // layout — they're already reachable from the ⋮ dropdown menu
       // (🔖 Bookmark Line / 📑 All Bookmarks), so having them here too
       // was pure duplication. `select` (Select-Lock) removed for the
       // same reason: it's already a permanent fixture on the footer
       // dock (the SEL button), not something that needs a second copy
       // here by default. All three remain available to add back via
       // Settings -> Customize Utility Bar for anyone who specifically
       // wants them closer to their thumb — removed from the DEFAULT,
       // not deleted from the tool map entirely.
       DEFAULT_UTIL_LAYOUT: 'fullFold, oneFold, unfold, oneUnfold, map, selectNext, selectAllMatches, jumpBracket, jumpLine, bookmarkHere, duplicate, comment, copyline, zoomin, zoomout, color, oneLine, editChunk, expandLine, cleanchars, stripcomments, sortlines, blanklines, alignleft, reindent',

       // Populates #modalUtilLayout from current prefs. Two sections:
       // "Your Utility Bar" shows enabled tools in their actual saved order
       // with working reorder arrows (this order is exactly what renders in
       // the bar), and "Available Tools" is everything else, browsable by
       // category, to turn on.
       renderUtilLayoutModal() {
           const current = (Nexus.state.prefs.utilLayout || Nexus.UI.DEFAULT_UTIL_LAYOUT).split(',').map(s => s.trim()).filter(Boolean);
           const metaByKey = {};
           Nexus.UI.UTIL_TOOL_META.forEach(t => { metaByKey[t.key] = t; });

           const enabledRow = (key, idx) => {
               const meta = metaByKey[key] || { label: key };
               return `
                   <div style="display:flex; align-items:center; gap:8px; padding:8px 0; border-bottom:1px solid var(--border);">
                       <div style="display:flex; flex-direction:column;">
                           <button onclick="Nexus.UI.moveUtilTool('${key}', -1)" ${idx === 0 ? 'disabled' : ''} title="Move up" aria-label="Move up" style="background:none; border:none; color:var(--text); opacity:${idx === 0 ? 0.25 : 0.7}; font-size:12px; padding:1px 6px; cursor:${idx === 0 ? 'default' : 'pointer'};">▲</button>
                           <button onclick="Nexus.UI.moveUtilTool('${key}', 1)" ${idx === current.length - 1 ? 'disabled' : ''} title="Move down" aria-label="Move down" style="background:none; border:none; color:var(--text); opacity:${idx === current.length - 1 ? 0.25 : 0.7}; font-size:12px; padding:1px 6px; cursor:${idx === current.length - 1 ? 'default' : 'pointer'};">▼</button>
                       </div>
                       <span style="font-size:12px; flex:1;">${meta.label}</span>
                       <span class="pref-toggle">
                           <input type="checkbox" checked onchange="Nexus.UI.toggleUtilTool('${key}', this.checked)">
                           <span class="pref-toggle-track"></span>
                       </span>
                   </div>`;
           };

           let html = `<div class="slab"><div class="section-label" style="margin-top:0;">Your Utility Bar</div><div style="font-size:9px; opacity:0.6; margin:-6px 0 8px;">This order is exactly how it appears in the bar, top to bottom.</div>`;
           html += current.map((key, idx) => enabledRow(key, idx)).join('');
           html += `</div>`;

           const disabled = Nexus.UI.UTIL_TOOL_META.filter(t => !current.includes(t.key));
           const groups = [];
           disabled.forEach(t => {
               let g = groups.find(g => g.name === t.group);
               if (!g) { g = { name: t.group, items: [] }; groups.push(g); }
               g.items.push(t);
           });
           if (groups.length > 0) {
               html += groups.map(g => `
                   <div class="slab">
                       <div class="section-label" style="margin-top:0;">${g.name}</div>
                       ${g.items.map(t => `
                           <label style="display:flex; align-items:center; justify-content:space-between; padding:8px 0; cursor:pointer;">
                               <span style="font-size:12px;">${t.label}</span>
                               <span class="pref-toggle">
                                   <input type="checkbox" onchange="Nexus.UI.toggleUtilTool('${t.key}', this.checked)">
                                   <span class="pref-toggle-track"></span>
                               </span>
                           </label>
                       `).join('')}
                   </div>
               `).join('');
           }

           document.getElementById('utilLayoutList').innerHTML = html;
       },

       // Fired by each toggle. Turning ON appends the tool to the end of the
       // saved order (browsable from "Available Tools" -> immediately
       // reorderable from "Your Utility Bar" afterward); turning OFF removes
       // it. Re-renders both the live bar and the modal itself so it always
       // reflects current state, including if it's already open.
       toggleUtilTool(key, isChecked) {
           let current = (Nexus.state.prefs.utilLayout || Nexus.UI.DEFAULT_UTIL_LAYOUT).split(',').map(s => s.trim()).filter(Boolean);
           if (isChecked && !current.includes(key)) {
               current.push(key);
           } else if (!isChecked) {
               current = current.filter(k => k !== key);
           }
           Nexus.settings.update('utilLayout', current.join(', '));
           Nexus.UI.renderUtilBar();
           Nexus.UI.renderUtilMirror();
           Nexus.UI.renderUtilLayoutModal();
       },

       // Swaps an enabled tool with its neighbor in the saved order.
       moveUtilTool(key, direction) {
           let current = (Nexus.state.prefs.utilLayout || Nexus.UI.DEFAULT_UTIL_LAYOUT).split(',').map(s => s.trim()).filter(Boolean);
           const idx = current.indexOf(key);
           if (idx === -1) return;
           const newIdx = idx + direction;
           if (newIdx < 0 || newIdx >= current.length) return;
           [current[idx], current[newIdx]] = [current[newIdx], current[idx]];
           Nexus.settings.update('utilLayout', current.join(', '));
           Nexus.UI.renderUtilBar();
           Nexus.UI.renderUtilMirror();
           Nexus.UI.renderUtilLayoutModal();
       },

       renderUtilBar() {
           const layoutStr = Nexus.state.prefs.utilLayout || Nexus.UI.DEFAULT_UTIL_LAYOUT;
           const layout = layoutStr.split(',').map(s => s.trim());
           const tools = {
                'color': `<button class="sleek-btn" onclick="document.getElementById('colorPickerInput').click()"><img src="https://upload.wikimedia.org/wikipedia/commons/2/2f/Color_circle_%28hue_sat%29.png" style="width:20px; border-radius:50%;"><span class="util-lbl">Picker</span></button>`,       
              'fullFold': `<button class="sleek-btn" onclick="Nexus.UI.collapseAll()" title="Fold everything to top level"><span style="font-size:18px;">⇐⇒</span><span class="util-lbl">Full Fold</span></button>`,
               'oneFold': `<button class="sleek-btn" onclick="Nexus.UI.foldToLayer()" title="Fold deepest layer"><span style="font-size:16px;">│</span><span class="util-lbl">-1 Fold</span></button>`,
               'unfold': `<button class="sleek-btn" onclick="Nexus.UI.expandAll()"><span style="font-size:18px;">≤≥</span><span class="util-lbl">Unfold</span></button>`,
               'oneUnfold': `<button class="sleek-btn" onclick="Nexus.UI.unfoldOnce()" title="Unfold highest folded level"><span style="font-size:16px;">∧</span><span class="util-lbl">+1 Unfold</span></button>`,
               'map': `<button class="sleek-btn" onclick="Nexus.UI.saveMap()" title="Save visible structure as map.filename.txt"><span style="font-size:18px;">🗺</span><span class="util-lbl">Map</span></button>`,
               'oneLine': `<button class="sleek-btn" onclick="Nexus.UI.collapseSelectionToOneLine()" title="Format function/class/const under cursor to one line"><span style="font-size:16px;">⟷</span><span class="util-lbl">To 1-Line</span></button>`,
               'editChunk': `<button class="sleek-btn" onclick="Nexus.chunkEditor.openForCursor()" title="Open the function/class/const under the cursor in a focused mini-editor"><span style="font-size:16px;">🔎</span><span class="util-lbl">Edit Chunk</span></button>`,
               'selectNext': `<button class="sleek-btn" onclick="Nexus.UI.selectNextOccurrence()" title="Add the next occurrence of the current selection as another cursor"><span style="font-size:16px;">⊕</span><span class="util-lbl">+1 Match</span></button>`,
               'selectAllMatches': `<button class="sleek-btn" onclick="Nexus.UI.selectAllOccurrences()" title="Select every occurrence of the current selection at once"><span style="font-size:16px;">⊛</span><span class="util-lbl">All Matches</span></button>`,
               'jumpBracket': `<button class="sleek-btn" onclick="Nexus.UI.jumpToMatchingBracket()" title="Jump to the bracket matching the one next to the cursor"><span style="font-size:16px;">↔{}</span><span class="util-lbl">Match Bracket</span></button>`,
               'jumpLine': `<button class="sleek-btn" onclick="Nexus.UI.jumpPrompt()" title="Jump to a specific line number"><span style="font-size:16px;">#</span><span class="util-lbl">Go to Line</span></button>`,
               'bookmarkHere': `<button class="sleek-btn" onclick="Nexus.UI.toggleBookmarkHere()" title="Toggle a bookmark on the current line"><span style="font-size:16px;">🔖</span><span class="util-lbl">Bookmark</span></button>`,
               'bookmarksList': `<button class="sleek-btn" onclick="Nexus.UI.openBookmarksPanel()" title="View and jump to all bookmarks"><span style="font-size:16px;">📑</span><span class="util-lbl">Bookmarks</span></button>`,
               'expandLine': `<button class="sleek-btn" onclick="Nexus.UI.expandSelectionFromOneLine()" title="Restore/reformat function/class/const under cursor"><span style="font-size:16px;">⟵⟶</span><span class="util-lbl">Expand</span></button>`,
            // FIX: this used to be a crude document.execCommand('delete') —
           // effectively just "backspace once" regardless of cursor position,
           // which isn't an outdent at all. Now uses the real outdentLine(),
           // which removes exactly one tab-width of leading whitespace.
           'select': `<button class="sleek-btn" id="utilSelectLock" onclick="Nexus.DpadEngine.toggleSelectLock()" title="Toggle Select-Lock" aria-label="Toggle select lock"><span style="font-size:16px;">📌</span><span class="util-lbl">Sel-Lock</span></button>`,
           'duplicate': `<button class="sleek-btn" onclick="Nexus.tools.duplicateLine()" title="Duplicate Line" aria-label="Duplicate current line"><span style="font-size:16px;">⧉</span><span class="util-lbl">Dup Ln</span></button>`,
           'comment': `<button class="sleek-btn" onclick="Nexus.tools.toggleComment()" title="Toggle Comment" aria-label="Toggle line comment"><span style="font-size:16px;">//</span><span class="util-lbl">Cmt</span></button>`,
           'copyline': `<button class="sleek-btn" onclick="Nexus.tools.copyLine()" title="Copy Line" aria-label="Copy current line"><span style="font-size:16px;">❐</span><span class="util-lbl">Cp Ln</span></button>`,
           'zoomin': `<button class="sleek-btn" onclick="Nexus.UI.adjustFontSize(2)" title="Zoom In" aria-label="Increase font size"><span style="font-size:16px; font-weight:900;">A+</span><span class="util-lbl">Zoom+</span></button>`,
           'zoomout': `<button class="sleek-btn" onclick="Nexus.UI.adjustFontSize(-2)" title="Zoom Out" aria-label="Decrease font size"><span style="font-size:16px; font-weight:900;">A-</span><span class="util-lbl">Zoom-</span></button>`,
            'cleanchars': `<button class="sleek-btn" onclick="Nexus.pasteGuard.cleanActiveFile()" title="Clean Smart Characters" aria-label="Clean smart characters"><span style="font-size:16px;">📱</span><span class="util-lbl">Clean</span></button>`,
           'stripcomments': `<button class="sleek-btn" onclick="Nexus.Sentinel.stripComments()" title="Strip Comments" aria-label="Strip comments"><span style="font-size:16px;">💬</span><span class="util-lbl">No Cmt</span></button>`,
           'sortlines': `<button class="sleek-btn" onclick="Nexus.Sentinel.sortLines()" title="Sort Lines A-Z" aria-label="Sort lines alphabetically"><span style="font-size:16px;">🔤</span><span class="util-lbl">Sort</span></button>`,
           'blanklines': `<button class="sleek-btn" onclick="Nexus.Sentinel.removeBlankLines()" title="Remove Blank Lines" aria-label="Remove blank lines"><span style="font-size:16px;">🧽</span><span class="util-lbl">No Blank</span></button>`,
           'alignleft': `<button class="sleek-btn" onclick="Nexus.Sentinel.alignLeft()" title="Align Left" aria-label="Align everything to the left"><span style="font-size:16px;">⬅️</span><span class="util-lbl">Align</span></button>`,
           'reindent': `<button class="sleek-btn" onclick="Nexus.Sentinel.reindentByDepth()" title="Re-indent by Depth" aria-label="Re-indent by nesting depth"><span style="font-size:16px;">📐</span><span class="util-lbl">Indent</span></button>`,
           // Ribbon-mirrored entries — same onclick handlers as the actual
           // ribbon buttons, just reachable from the utility bar too for
           // anyone who wants them closer to their thumb or wants to
           // remove the ribbon's own copy from view eventually. See
           // UTIL_TOOL_META's own comment for why these default off.
           'rbSave': `<button class="sleek-btn" onclick="Nexus.Vfs.manualSave()" title="Save Now" aria-label="Save current file now"><span style="font-size:16px;">💾</span><span class="util-lbl">Save</span></button>`,
           'rbRefresh': `<button class="sleek-btn" onclick="Nexus.Vfs.refreshCurrent()" title="Refresh File" aria-label="Refresh current file"><span style="font-size:16px;">♻️</span><span class="util-lbl">Refresh</span></button>`,
           'rbUndo': `<button class="sleek-btn" onclick="Nexus.history.undo()" title="Undo" aria-label="Undo"><span style="font-size:16px;">↶</span><span class="util-lbl">Undo</span></button>`,
           'rbRedo': `<button class="sleek-btn" onclick="Nexus.history.redo()" title="Redo" aria-label="Redo"><span style="font-size:16px;">↷</span><span class="util-lbl">Redo</span></button>`,
           'rbInsertTab': `<button class="sleek-btn" onclick="Nexus.UI.injectChar('\\t')" title="Insert Tab" aria-label="Insert tab"><span style="font-size:16px;">→|</span><span class="util-lbl">Tab</span></button>`,
           'rbOutdent': `<button class="sleek-btn" onclick="Nexus.tools.outdentLine()" title="Outdent Line" aria-label="Outdent line"><span style="font-size:16px;">|←</span><span class="util-lbl">Outdent</span></button>`,
           'rbCut': `<button class="sleek-btn" onclick="document.execCommand('cut')" title="Cut" aria-label="Cut"><span style="font-size:16px;">✂️</span><span class="util-lbl">Cut</span></button>`,
           'rbCopy': `<button class="sleek-btn" onclick="document.execCommand('copy')" title="Copy" aria-label="Copy"><span style="font-size:16px;">⧉</span><span class="util-lbl">Copy</span></button>`,
           'rbPaste': `<button class="sleek-btn" onclick="Nexus.tools.clipboard('paste')" title="Paste" aria-label="Paste"><span style="font-size:16px;">📋</span><span class="util-lbl">Paste</span></button>`,
           'rbRun': `<button class="sleek-btn" onclick="Nexus.UI.openModal('sandbox')" title="Run / Preview" aria-label="Run preview"><span style="font-size:16px;">▶️</span><span class="util-lbl">Run</span></button>`,
           };
           
           const container = document.querySelector('#utilityBar .sleek-bar-content');
           if(container) {
               container.innerHTML = layout
                   .filter(k => tools[k]) // Filter out typos/unrecognized tools
                   .map(k => tools[k])
                   .join('');
           }
       },

       renderUtilMirror() {
           const layoutStr = Nexus.state.prefs.utilLayout || Nexus.UI.DEFAULT_UTIL_LAYOUT;
           const layout = layoutStr.split(',').map(s => s.trim());
           // Take the last 6 tools from the layout
           const lastSix = layout.slice(-6);
           const tools = {
                'color': `<button class="tool-btn" onclick="document.getElementById('colorPickerInput').click()" title="Color Picker" style="flex:1;">🎨 Picker</button>`,       
                'fullFold': `<button class="tool-btn" onclick="Nexus.UI.collapseAll()" title="Fold everything to top level" style="flex:1;">⇐⇒ Fold</button>`,
                'oneFold': `<button class="tool-btn" onclick="Nexus.UI.foldToLayer()" title="Fold deepest layer" style="flex:1;">│ -1</button>`,
                'unfold': `<button class="tool-btn" onclick="Nexus.UI.expandAll()" title="Unfold all" style="flex:1;">≤≥ All</button>`,
                'oneUnfold': `<button class="tool-btn" onclick="Nexus.UI.unfoldOnce()" title="Unfold highest folded level" style="flex:1;">∧ +1</button>`,
                'map': `<button class="tool-btn" onclick="Nexus.UI.saveMap()" title="Save visible structure as map.filename.txt" style="flex:1;">🗺 Map</button>`,
                'oneLine': `<button class="tool-btn" onclick="Nexus.UI.collapseSelectionToOneLine()" title="Format to one line" style="flex:1;">⟷ 1-Line</button>`,
                'editChunk': `<button class="tool-btn" onclick="Nexus.chunkEditor.openForCursor()" title="Open function/class in mini-editor" style="flex:1;">🔎 Edit</button>`,
                'selectNext': `<button class="tool-btn" onclick="Nexus.UI.selectNextOccurrence()" title="Add next occurrence as cursor" style="flex:1;">⊕ Next</button>`,
                'selectAllMatches': `<button class="tool-btn" onclick="Nexus.UI.selectAllOccurrences()" title="Select all occurrences" style="flex:1;">⊛ All</button>`,
                'jumpBracket': `<button class="tool-btn" onclick="Nexus.UI.jumpToMatchingBracket()" title="Jump to matching bracket" style="flex:1;">↔{} Bracket</button>`,
                'jumpLine': `<button class="tool-btn" onclick="Nexus.UI.jumpPrompt()" title="Jump to a specific line number" style="flex:1;"># Go to Line</button>`,
                'bookmarkHere': `<button class="tool-btn" onclick="Nexus.UI.toggleBookmarkHere()" title="Toggle bookmark on current line" style="flex:1;">🔖 Bk</button>`,
                'bookmarksList': `<button class="tool-btn" onclick="Nexus.UI.openBookmarksPanel()" title="View all bookmarks" style="flex:1;">📑 All</button>`,
                'expandLine': `<button class="tool-btn" onclick="Nexus.UI.expandSelectionFromOneLine()" title="Restore/reformat" style="flex:1;">⟵⟶ Exp</button>`,
                'select': `<button class="tool-btn" onclick="Nexus.DpadEngine.toggleSelectLock()" title="Toggle Select-Lock" style="flex:1;">📌 Sel</button>`,
                'duplicate': `<button class="tool-btn" onclick="Nexus.tools.duplicateLine()" title="Duplicate Line" style="flex:1;">⧉ Dup</button>`,
                'comment': `<button class="tool-btn" onclick="Nexus.tools.toggleComment()" title="Toggle Comment" style="flex:1;">//  Cmt</button>`,
                'copyline': `<button class="tool-btn" onclick="Nexus.tools.copyLine()" title="Copy Line" style="flex:1;">❐ Cp</button>`,
                'zoomin': `<button class="tool-btn" onclick="Nexus.UI.adjustFontSize(2)" title="Zoom In" style="flex:1;">A+ In</button>`,
                'zoomout': `<button class="tool-btn" onclick="Nexus.UI.adjustFontSize(-2)" title="Zoom Out" style="flex:1;">A- Out</button>`,
                'cleanchars': `<button class="tool-btn" onclick="Nexus.pasteGuard.cleanActiveFile()" title="Clean Smart Characters" style="flex:1;">📱 Clean</button>`,
                'stripcomments': `<button class="tool-btn" onclick="Nexus.Sentinel.stripComments()" title="Strip Comments" style="flex:1;">💬 Strip</button>`,
                'sortlines': `<button class="tool-btn" onclick="Nexus.Sentinel.sortLines()" title="Sort Lines A-Z" style="flex:1;">🔤 Sort</button>`,
                'blanklines': `<button class="tool-btn" onclick="Nexus.Sentinel.removeBlankLines()" title="Remove Blank Lines" style="flex:1;">🧽 Clean</button>`,
                'alignleft': `<button class="tool-btn" onclick="Nexus.Sentinel.alignLeft()" title="Align Left" style="flex:1;">⬅️ Align</button>`,
                'reindent': `<button class="tool-btn" onclick="Nexus.Sentinel.reindentByDepth()" title="Re-indent by Depth" style="flex:1;">📐 Indent</button>`,
                // Ribbon-mirrored entries, same reasoning/handlers as
                // renderUtilBar()'s copy above — kept in sync manually
                // since these are two separate template-string maps by
                // design (compact vs. full-size button markup), not two
                // copies that happened to drift.
                'rbSave': `<button class="tool-btn" onclick="Nexus.Vfs.manualSave()" title="Save Now" style="flex:1;">💾 Save</button>`,
                'rbRefresh': `<button class="tool-btn" onclick="Nexus.Vfs.refreshCurrent()" title="Refresh File" style="flex:1;">♻️ Refresh</button>`,
                'rbUndo': `<button class="tool-btn" onclick="Nexus.history.undo()" title="Undo" style="flex:1;">↶ Undo</button>`,
                'rbRedo': `<button class="tool-btn" onclick="Nexus.history.redo()" title="Redo" style="flex:1;">↷ Redo</button>`,
                'rbInsertTab': `<button class="tool-btn" onclick="Nexus.UI.injectChar('\\t')" title="Insert Tab" style="flex:1;">→| Tab</button>`,
                'rbOutdent': `<button class="tool-btn" onclick="Nexus.tools.outdentLine()" title="Outdent Line" style="flex:1;">|← Outdent</button>`,
                'rbCut': `<button class="tool-btn" onclick="document.execCommand('cut')" title="Cut" style="flex:1;">✂️ Cut</button>`,
                'rbCopy': `<button class="tool-btn" onclick="document.execCommand('copy')" title="Copy" style="flex:1;">⧉ Copy</button>`,
                'rbPaste': `<button class="tool-btn" onclick="Nexus.tools.clipboard('paste')" title="Paste" style="flex:1;">📋 Paste</button>`,
                'rbRun': `<button class="tool-btn" onclick="Nexus.UI.openModal('sandbox')" title="Run / Preview" style="flex:1;">▶️ Run</button>`,
           };
           
           const container = document.getElementById('utilMirrorContainer');
           if(container) {
               container.innerHTML = lastSix
                   .filter(k => tools[k])
                   .map(k => tools[k])
                   .join('');
           }
       },

       // NOTE: both of these are currently orphaned — nothing calls either
       // one, and neither #widgetDropMenu nor #formatDropMenu exists in
       // index.html anymore (leftovers from a removed dropdown UI). Kept
       // rather than deleted since that's a call about intent, but guarded
       // so they can't throw an unguarded null deref if something wires
       // them back up before the markup is restored.
       toggleWidgetDrop(e) {
       const menu = document.getElementById('widgetDropMenu');
       if (!menu) { console.error("toggleWidgetDrop: #widgetDropMenu does not exist."); return; }
       const rect = e.target.getBoundingClientRect();
       menu.style.left = rect.left + 'px';
       menu.classList.toggle('active');
       const closeMenu = (evt) => {
           if (!menu.contains(evt.target) && evt.target !== e.target) {
               menu.classList.remove('active'); document.removeEventListener('click', closeMenu);
           }
       };
       setTimeout(() => document.addEventListener('click', closeMenu), 50);
   },
       toggleFormatDrop(e) {
       const menu = document.getElementById('formatDropMenu');
       if (!menu) { console.error("toggleFormatDrop: #formatDropMenu does not exist."); return; }
       const rect = e.target.getBoundingClientRect();
       menu.style.left = rect.left + 'px';
       menu.classList.toggle('active');
       const closeMenu = (evt) => {
           if (!menu.contains(evt.target) && evt.target !== e.target) {
               menu.classList.remove('active'); document.removeEventListener('click', closeMenu);
           }
       };
       setTimeout(() => document.addEventListener('click', closeMenu), 50);
   },
   async runPrettier() {
       if (!Nexus.state.activeFile) return Nexus.shell.out("No file open — open or create a file first.", "warn");
       const ed = document.getElementById('rawTerminal');
       if (ed.hasAttribute('readonly')) return alert("UNLOCK EDITOR FIRST");
       
       const ext = Nexus.state.activeFile.split('.').pop().toLowerCase();
       
       let code = ed.value;
       if (Nexus.editorCore.isCM6 && Nexus.editorCore.view) {
           code = Nexus.editorCore.view.state.doc.toString();
       }

       let parser = 'babel';
       
       // THE FIX: Provide all plugins universally. Prettier delegates internally.
       const plugins = [
           prettierPlugins.babel, 
           prettierPlugins.estree, 
           prettierPlugins.html, 
           prettierPlugins.postcss
       ];

       if (ext === 'html') { parser = 'html'; } 
       else if (ext === 'css') { parser = 'css'; } 
       else if (ext !== 'js' && ext !== 'json') return alert("Prettier unsupported here.");
       
       try {
           const formatted = await prettier.format(code, { 
               parser, 
               plugins, 
               tabWidth: Nexus.state.prefs.tabWidth, 
               printWidth: 80, 
               singleQuote: true 
           });
           
           if (Nexus.editorCore.isCM6 && Nexus.editorCore.view) {
               Nexus.editorCore.view.dispatch({ changes: { from: 0, to: Nexus.editorCore.view.state.doc.length, insert: formatted } });
           } else {
               ed.value = formatted;
           }
           
           Nexus.state.Vfs[Nexus.state.activeFile] = formatted;
           this.updateGutter(); 
           Nexus.Vfs.save();
           
           const st = document.getElementById('footStatus');
           st.innerText = "PRETTIFIED (STRICT)"; 
           st.style.color = "var(--success)";
           setTimeout(() => Nexus.UI.syncStatus(), 2000);
       } catch(e) { 
           alert("Prettier Error:\n" + e.message); 
       }
   },
checkBrackets() {
  if (!Nexus.state.activeFile) {
      const out = document.getElementById('diagOut');
      if (out) out.innerHTML = `<div style="color:var(--gold); font-weight:bold;">No file open — open or create a file first.</div>`;
      return;
  }
  const code = Nexus.state.Vfs[Nexus.state.activeFile];
  const result = Nexus.BracketCartographer.mapStructure(code);
  const out = document.getElementById('diagOut');
  
  let html = `<div style="color:var(--accent); margin-bottom:5px; font-weight:bold;">BRACKET SCANNER</div>`;
  
  if (result.errors.length === 0) {
      html += `<div style="color:var(--success);">✅ All structure brackets match.</div>`;
  } else {
      html += `<div style="color:var(--danger); font-weight:bold;">❌ ${result.errors.length} Unmatched Brackets Detected:</div>`;
      
      // Mobile Safe Optimization: Cap the viewport readout to the first 5 critical breaks
      // so a massive 8,000 cascade doesn't freeze the DOM tree.
      const maxDisplay = 5;
const displayErrors = result.errors.filter(e => e.line < 6000).slice(0, 5);
      
      displayErrors.forEach(e => {
          html += `<div onclick="Nexus.UI.jumpToLine(${e.line + 1}, ${e.col})" style="cursor:pointer; font-size:11px; margin-top:4px; border-left:2px solid var(--danger); padding-left:8px; font-family:monospace; display:flex; justify-content:space-between; align-items:center;"><span>Ln ${e.line + 1}, Col ${e.col}: Missing or unmatched <b>${e.char}</b></span><span style="font-size:9px; opacity:0.6; white-space:nowrap; padding-left:6px;">→</span></div>`;
      });
      
      if (result.errors.length > maxDisplay) {
          html += `<div style="font-size:10px; color:#5c6370; margin-top:6px; font-style:italic;">...and ${result.errors.length - maxDisplay} downstream mismatches hidden. Fix the top errors to clear the cascade.</div>`;
      }
  }
  
  out.innerHTML = html;
},

   runJSBeautify() {
       if (!Nexus.state.activeFile) return Nexus.shell.out("No file open — open or create a file first.", "warn");
       const ed = document.getElementById('rawTerminal');
       if (ed.hasAttribute('readonly')) return alert("UNLOCK EDITOR FIRST");
       
       const ext = Nexus.state.activeFile.split('.').pop().toLowerCase();
       
       let code = ed.value;
       if (Nexus.editorCore.isCM6 && Nexus.editorCore.view) {
           code = Nexus.editorCore.view.state.doc.toString();
       }

       // Tighter configuration for HTML files
       const opts = { 
           indent_size: Nexus.state.prefs.tabWidth, 
           wrap_line_length: 80, 
           preserve_newlines: true,
           max_preserve_newlines: 2,
           indent_inner_html: true 
       };
       
       try {
           if (ext === 'html' && typeof html_beautify === 'function') {
               code = html_beautify(code, opts);
           } else if (ext === 'css' && typeof css_beautify === 'function') {
               code = css_beautify(code, opts);
           } else if (typeof js_beautify === 'function') {
               code = js_beautify(code, opts);
           }
           
           if (Nexus.editorCore.isCM6 && Nexus.editorCore.view) {
               Nexus.editorCore.view.dispatch({ changes: { from: 0, to: Nexus.editorCore.view.state.doc.length, insert: code } });
           } else {
               ed.value = code;
           }

           Nexus.state.Vfs[Nexus.state.activeFile] = code;
           this.updateGutter();
           Nexus.Vfs.save();
           
           const st = document.getElementById('footStatus');
           st.innerText = "BEAUTIFIED";
           st.style.color = "var(--success)";
           setTimeout(() => Nexus.UI.syncStatus(), 2000);
       } catch(e) {
           alert("Beautify engine encountered an error: " + e.message);
       }
   },

   // Enumerates every foldable range in the document along with its
   // "fold depth" — how many OTHER foldable ranges enclose it. This is
   // deliberately not raw syntax-tree depth: a Program -> Statement ->
   // ExpressionStatement -> CallExpression chain is 4 AST levels but 0
   // foldable ones, since none of those wrapper nodes are foldable
   // themselves. Depth here means "how many fold-brackets would you have
   // to cross to unfold your way out to this range", which is what -1
   // Fold / +1 Unfold actually need to reason about.
   // CORRECTED from an earlier version that called foldable(view.state,
   // node.from, node.to) — that is a documented misuse of the API.
   // foldable() is a *line-lookup* helper: you give it a line's start/end
   // and it searches the tree for whichever foldable region starts on
   // that line. It is not a way to ask "what is this specific node's fold
   // range" — passing a syntax node's own (often huge, multi-hundred-line)
   // from/to as if it were a single line's start/end causes it to return
   // null almost every time, which is exactly why -1 Fold/+1 Unfold always
   // degraded to all-or-nothing. (Confirmed directly against
   // @codemirror/language's source — see syntaxFolding() — and against
   // CodeMirror's own maintainer: "You pass it the start/end of a line...
   // If you know which range you want to fold, you should not be calling
   // foldable, and definitely not with the extent of a syntax node.")
   //
   // The correct mechanism, used here: each node TYPE that supports
   // folding has a fold function registered on it via foldNodeProp (this
   // is exactly how foldInside works — see the language package source).
   // Calling node.type.prop(foldNodeProp) retrieves that function; calling
   // it with the node itself gives that specific node's own fold range,
   // with no line-based guessing involved.
   _getFoldableRangesWithDepth(view) {
       const { syntaxTree, foldNodeProp } = Nexus.editorCore.modules;
       const tree = syntaxTree(view.state);
       const ranges = [];
       const seen = new Set();

       tree.iterate({
           enter(nodeRef) {
               const propFn = nodeRef.type.prop(foldNodeProp);
               if (!propFn) return;
               // node.node materializes the full SyntaxNode (with .parent
               // walkable) from the lighter-weight NodeRef iterate() gives —
               // needed for the depth walk below.
               const node = nodeRef.node;
               const range = propFn(node, view.state);
               if (!range || range.from >= range.to) return;

               const key = range.from + ':' + range.to;
               if (seen.has(key)) return;
               seen.add(key);

               // Depth = how many ANCESTOR nodes (walking up via .parent)
               // also have a foldable range of their own. This counts real
               // nesting of fold points, not raw AST depth — a node buried
               // under several non-foldable wrapper nodes (e.g. a bare
               // ExpressionStatement) still correctly reads as depth 0 if
               // nothing foldable actually encloses it.
               let depth = 0;
               let parent = node.parent;
               while (parent) {
                   const parentPropFn = parent.type.prop(foldNodeProp);
                   if (parentPropFn) {
                       const parentRange = parentPropFn(parent, view.state);
                       if (parentRange && parentRange.from < parentRange.to) depth++;
                   }
                   parent = parent.parent;
               }

               ranges.push({ key, from: range.from, to: range.to, depth });
           }
       });

       return ranges;
   },

   // Sixteen tools used to dead-end in vanilla mode with a modal saying
   // "switch engines first" — leaving you to dismiss it, find the engine
   // toggle, switch, then come back and tap the tool again. That's the
   // single most repeated bit of friction in daily use, since it covers
   // most of the good tools (folding, chunk editor, multi-cursor, bracket
   // jump, minimap, lint, autocomplete, whitespace, change gutter).
   //
   // This turns each of those into one tap: it offers to switch for you
   // and then re-runs whatever you originally tried. Returns true when
   // CM6 is already active (caller just proceeds), false otherwise —
   // in which case the caller returns immediately and the retry callback
   // takes over once the engine is up.
   // Same dead-end problem as needCM6, for the edit lock: several tools
   // used to just say "LOCKED" or "UNLOCK EDITOR FIRST" and stop, leaving
   // you to dismiss the modal, find the edit-mode toggle, unlock, and tap
   // the tool again. Unlocking is a single known action, so it's offered
   // inline and the original tool re-runs afterwards.
   // Promise-based replacement for the browser's prompt(). Resolves to the
   // entered string, or null if cancelled — same contract as prompt(), so
   // call sites convert cleanly, except this one can validate BEFORE
   // accepting rather than making you discover the problem afterwards.
   //
   //   const name = await Nexus.UI.askInput({
   //       title: 'NEW FILE',
   //       label: 'Filename',
   //       value: 'index.html',
   //       hint: '3 files in this project',
   //       validate: (v) => v.includes('.') ? null : 'Needs a file extension.'
   //   });
   //
   // validate() returns null/undefined when the value is acceptable, or a
   // message string to show and keep the dialog open.
   _askInputState: null,

   askInput(opts) {
       const o = opts || {};
       return new Promise((resolve) => {
           const titleEl = document.getElementById('askInputTitle');
           const labelEl = document.getElementById('askInputLabel');
           const field = document.getElementById('askInputField');
           const hintEl = document.getElementById('askInputHint');
           const errEl = document.getElementById('askInputError');

           // If the modal markup is missing for any reason, fall back to
           // the native prompt rather than hanging forever on a Promise
           // that can never resolve.
           if (!field) {
               resolve(window.prompt(o.label || o.title || '', o.value || ''));
               return;
           }

           if (titleEl) titleEl.innerText = o.title || 'INPUT';
           if (labelEl) labelEl.innerText = o.label || '';
           if (hintEl) hintEl.innerText = o.hint || '';
           if (errEl) errEl.innerText = '';
           field.value = o.value != null ? String(o.value) : '';
           field.setAttribute('inputmode', o.numeric ? 'numeric' : 'text');
           field.setAttribute('placeholder', o.placeholder || '');

           this._askInputState = { resolve, validate: o.validate, allowOverwriteOnSecondSubmit: !!o.allowOverwriteOnSecondSubmit, _lastRejected: null };
           Nexus.UI.openModal('ask-input');

           // Focus and select so the suggested value can be replaced by
           // typing, or kept by just tapping OK.
           setTimeout(() => {
               try { field.focus(); field.select(); } catch (e) {}
           }, 50);
       });
   },

   _askInputSubmit() {
       const st = this._askInputState;
       if (!st) return;
       const field = document.getElementById('askInputField');
       const errEl = document.getElementById('askInputError');
       const value = field ? field.value : '';

       if (typeof st.validate === 'function') {
           let problem = null;
           try { problem = st.validate(value); }
           catch (e) { problem = 'Could not check that value: ' + e.message; }
           if (problem) {
               // With allowOverwriteOnSecondSubmit, a repeated OK on the
               // SAME value is treated as "yes, I meant it" — used for
               // save-as, where blocking outright would strand finished
               // work behind a name you can't use, but silently
               // overwriting would destroy an existing file. Warn once,
               // then let it through. Changing the text resets this, so
               // the confirmation can't carry over to a different name.
               if (st.allowOverwriteOnSecondSubmit && st._lastRejected === value) {
                   this._askInputResolve(value);
                   return;
               }
               st._lastRejected = value;
               if (errEl) errEl.innerText = problem;
               if (field) { try { field.focus(); } catch (e) {} }
               return;
           }
       }
       this._askInputResolve(value);
   },

   _askInputResolve(value) {
       const st = this._askInputState;
       this._askInputState = null;
       Nexus.UI.closeModal('ask-input');
       if (st && typeof st.resolve === 'function') st.resolve(value);
   },

   needUnlocked(label, retry) {
       const ed = document.getElementById('rawTerminal');
       const locked = ed ? ed.hasAttribute('readonly') : false;
       if (!locked) return true;

       if (!confirm(`${label} needs the editor unlocked.\n\nUnlock it and continue?`)) {
           Nexus.shell.out(`${label} skipped — editor still locked.`, 'warn');
           return false;
       }
       Nexus.UI.setEditMode('full');
       Nexus.shell.out('Editor unlocked.', 'success');
       if (typeof retry === 'function') {
           // Let setEditMode's own DOM updates settle before re-running,
           // since the tool will immediately re-check the same attribute.
           setTimeout(retry, 0);
       }
       return false;
   },

   needCM6(label, retry) {
       if (Nexus.editorCore.isCM6 && Nexus.editorCore.view) return true;

       if (!confirm(`${label} needs the CodeMirror engine, which isn't active right now.\n\nSwitch to it and continue?`)) {
           Nexus.shell.out(`${label} skipped — still on the basic editor.`, 'warn');
           return false;
       }

       Nexus.shell.out('Switching to the CodeMirror engine…', 'accent');
       Promise.resolve(Nexus.toggleEditor()).then(() => {
           // toggleEditor loads CM6's modules over the network on first
           // use, so the view may not exist the instant it resolves.
           // Poll briefly rather than assume, and give up with a real
           // message instead of silently doing nothing.
           let waited = 0;
           const tick = () => {
               if (Nexus.editorCore.isCM6 && Nexus.editorCore.view) {
                   if (typeof retry === 'function') retry();
                   return;
               }
               waited += 150;
               if (waited > 6000) {
                   Nexus.shell.out(`Engine didn't finish loading — try ${label} again in a moment.`, 'error');
                   return;
               }
               setTimeout(tick, 150);
           };
           tick();
       }).catch((e) => {
           Nexus.shell.out('Could not switch engines: ' + (e && e.message || e), 'error');
       });
       return false;
   },

   collapseAll() {
           if (!Nexus.UI.needCM6('Folding', () => Nexus.UI.collapseAll())) return;
           const { foldAll } = Nexus.editorCore.modules;
           foldAll(Nexus.editorCore.view);
       },

       expandAll() {
           if (!Nexus.UI.needCM6('Folding', () => Nexus.UI.expandAll())) return;
           const { unfoldAll } = Nexus.editorCore.modules;
           unfoldAll(Nexus.editorCore.view);
       },

       // "-1 Fold": fold away the deepest layer that isn't ALREADY fully
       // folded. Finds the current deepest depth among ranges that have
       // at least one unfolded range, then folds every unfolded range at
       // that depth. Repeated presses walk outward one layer at a time —
       // deepest nested blocks fold first, then their parents, etc. —
       // until everything's collapsed, matching foldAll's end state.
       // CM6 parses lazily — syntaxTree(state) can return a PARTIAL tree if
       // the background parse worker hasn't finished the whole document yet
       // (see ParseContext/parseWorker in @codemirror/language's own
       // source: parsing happens in idle-callback chunks, not all at once
       // on every keystroke). Computing fold depths against a partial tree
       // would silently see only whatever's been parsed so far, which
       // could produce wrong/incomplete depth groupings depending on
       // timing — forceParsing() makes sure the full document is parsed
       // before depth calculation runs, so the fold/unfold buttons don't
       // depend on how much background parsing luck already happened.
       _ensureFullyParsed(view) {
           const { forceParsing } = Nexus.editorCore.modules;
           if (typeof forceParsing === 'function') {
               forceParsing(view, view.state.doc.length, 500);
           }
       },

       foldToLayer() {
           if (!Nexus.UI.needCM6('Folding', () => Nexus.UI.foldToLayer())) return;
           const view = Nexus.editorCore.view;
           this._ensureFullyParsed(view);
           const { foldEffect, foldedRanges } = Nexus.editorCore.modules;
           const folded = foldedRanges(view.state);

           const isAlreadyFolded = (from, to) => {
               let found = false;
               folded.between(from, to, (fFrom, fTo) => {
                   if (fFrom === from && fTo === to) found = true;
               });
               return found;
           };

           const ranges = this._getFoldableRangesWithDepth(view)
               .map(r => ({ ...r, folded: isAlreadyFolded(r.from, r.to) }));

           const unfoldedRanges = ranges.filter(r => !r.folded);

           // Diagnostic surface: if you're seeing "does everything or
           // nothing" again after this fix, check the console — this
           // prints exactly how many foldable ranges were found and at
           // what depths, which tells us immediately whether the tree
           // walk is finding real nesting (multiple depth values) or
           // collapsing everything into depth 0 (which would explain the
           // symptom precisely).
           const depthCounts = {};
           ranges.forEach(r => { depthCounts[r.depth] = (depthCounts[r.depth] || 0) + 1; });
           console.log('[divIDE fold debug] total foldable ranges:', ranges.length, '| by depth:', depthCounts, '| already folded:', ranges.length - unfoldedRanges.length);

           if (unfoldedRanges.length === 0) return; // everything's already fully folded

           const deepestUnfoldedDepth = Math.max(...unfoldedRanges.map(r => r.depth));
           const toFold = unfoldedRanges.filter(r => r.depth === deepestUnfoldedDepth);
           console.log('[divIDE fold debug] folding', toFold.length, 'range(s) at depth', deepestUnfoldedDepth);

           view.dispatch({
               effects: toFold.map(r => foldEffect.of({ from: r.from, to: r.to }))
           });
       },

       // "+1 Unfold": open back up the shallowest layer that's currently
       // folded. Mirror of foldToLayer — finds the minimum depth among
       // folded ranges and unfolds just those, so repeated presses peel
       // outward-in from the top level down, undoing a Full Fold one
       // layer per press instead of all at once.
       unfoldOnce() {
           if (!Nexus.UI.needCM6('Folding', () => Nexus.UI.unfoldOnce())) return;
           const view = Nexus.editorCore.view;
           this._ensureFullyParsed(view);
           const { unfoldEffect, foldedRanges } = Nexus.editorCore.modules;
           const folded = foldedRanges(view.state);

           const isFolded = (from, to) => {
               let found = false;
               folded.between(from, to, (fFrom, fTo) => {
                   if (fFrom === from && fTo === to) found = true;
               });
               return found;
           };

           const ranges = this._getFoldableRangesWithDepth(view)
               .filter(r => isFolded(r.from, r.to));

           console.log('[divIDE fold debug] currently folded ranges:', ranges.length, '| depths:', ranges.map(r => r.depth));

           if (ranges.length === 0) return; // nothing folded to open

           const shallowestFoldedDepth = Math.min(...ranges.map(r => r.depth));
           const toUnfold = ranges.filter(r => r.depth === shallowestFoldedDepth);
           console.log('[divIDE fold debug] unfolding', toUnfold.length, 'range(s) at depth', shallowestFoldedDepth);

           view.dispatch({
               effects: toUnfold.map(r => unfoldEffect.of({ from: r.from, to: r.to }))
           });
       },

       // Finds the "declaration-shaped" foldable node enclosing the cursor
       // — the innermost Function/Class/Method/Object/Array/Block whose
       // START is at or before the cursor and END is at or after it. This
       // deliberately walks OUT from the cursor's own tree position rather
       // than just taking foldable()'s first hit, because foldable() on a
       // raw cursor position often returns the nearest inner block (e.g.
       // an if-statement body one level down) rather than the whole
       // function/class the user actually means by "this function."
       // CORRECTED: previously matched only JS-shaped Lezer node names
       // (Function, Class, Property, VariableDeclaration, Object, Array,
       // Arrow) via a hardcoded regex — meaning "To 1-Line" and "Edit
       // Chunk" only ever worked on JavaScript. HTML's grammar has
       // completely different node names (Element, OpenTag, and so on;
       // Lezer node names are grammar-specific, not standardized across
       // languages), and CSS's are different again (RuleSet, Block,
       // Declaration), so the old regex silently matched NOTHING in
       // either — the cursor just walked all the way up to the document
       // root and returned null.
       //
       // Fixed by switching to the same foldNodeProp-based detection
       // _getFoldableRangesWithDepth already uses for the fold/unfold
       // feature: instead of asking "is this node's TYPE NAME one of a
       // JS-specific list," it asks "does this node have a foldable
       // region registered at all" — which every CM6 language package
       // answers correctly for its own grammar (a <div>...</div> Element
       // in HTML, a rule's { ... } Block in CSS, a function body in JS),
       // with zero per-language name-matching needed here.
       _getEnclosingDeclaration(view) {
           const { syntaxTree, foldNodeProp } = Nexus.editorCore.modules;
           const pos = view.state.selection.main.head;
           const tree = syntaxTree(view.state);
           let node = tree.resolveInner(pos, 1);

           while (node) {
               // Never match the document root itself — collapsing an
               // entire file to one line would be a far more destructive
               // outcome here than for plain fold/unfold (which is
               // trivially reversible with one tap of Unfold). No CM6
               // language package registers foldNodeProp on its top/@top
               // node in any example or real grammar checked while
               // building this (confirmed directly for JS's own
               // registration list: Block/ClassBody/SwitchBody/EnumBody/
               // ObjectExpression/ArrayExpression/ObjectType — no Program),
               // but this guard costs nothing and removes any doubt.
               if (!node.parent) { node = null; break; }

               const propFn = node.type.prop(foldNodeProp);
               if (propFn) {
                   const range = propFn(node, view.state);
                   // foldNodeProp's range is the INSIDE of the region (the
                   // part that actually collapses when folded — e.g. just
                   // the {...} body, not the `function foo()` signature in
                   // front of it). For "select the whole declaration to
                   // edit/collapse," node.from/node.to (the full node,
                   // signature included) is what's wanted, not just the
                   // foldable interior — so this only uses propFn's
                   // existence as the "is this a real, substantial region"
                   // test, then returns the node's own full span.
                   if (range && range.to > range.from && node.to > node.from) {
                       return { declFrom: node.from, declTo: node.to, nodeName: node.type.name };
                   }
               }
               node = node.parent;
           }
           return null;
       },

       // "Format to one line": collapses the enclosing function/class/
       // const/object under the cursor down to the minimum whitespace that
       // keeps it syntactically valid — strips comments, collapses all
       // runs of whitespace/newlines to single spaces, and tightens
       // spacing around punctuation. This is a purely textual transform
       // (not a Prettier "printWidth: Infinity" call) because Prettier's
       // own single-line mode still inserts the line breaks it considers
       // mandatory (e.g. after every statement in a block), which defeats
       // the point of an actual one-liner.
       // FIX: this always used the cursor-position node lookup
       // (_getEnclosingDeclaration), completely ignoring an active
       // selection — so highlighting a specific block of code and tapping
       // "To 1-Line" would silently collapse whatever function/class the
       // CURSOR happened to be inside instead of the actual highlighted
       // text. Same fix as chunkEditor.openForCursor() already has: check
       // for a real selection first and use its exact bounds verbatim,
       // falling back to the cursor-position lookup only when nothing's
       // selected — preserving the original "just place your cursor
       // inside a function" behavior for that case, unchanged.
       collapseSelectionToOneLine() {
           if (!Nexus.UI.needCM6('This tool', () => Nexus.UI.collapseSelectionToOneLine())) return;
           const view = Nexus.editorCore.view;
           const sel = view.state.selection.main;
           let target;

           if (!sel.empty) {
               // A manual selection has no syntax node to read a type
               // from the way the cursor-position fallback does — but
               // blindly defaulting every manual selection to the
               // JS-shaped collapse logic risks exactly the corruption
               // _toOneLineHTML was built to avoid (mangled URLs in
               // attributes, destroyed whitespace in quoted values) if
               // someone highlights actual markup. Infer from the active
               // file's extension plus a quick shape-check on the
               // selected text itself (starts with '<' after trimming) —
               // both signals have to agree before treating it as HTML,
               // so a JS/CSS selection inside an .html file (e.g. code
               // inside a <script> block) still correctly gets the
               // JS-shaped path rather than being misdetected just for
               // living inside an .html file.
               const selectedText = view.state.doc.sliceString(sel.from, sel.to);
               const activeExt = (Nexus.state.activeFile || '').split('.').pop().toLowerCase();
               const looksLikeMarkup = /^\s*</.test(selectedText) && (activeExt === 'html' || activeExt === 'htm');
               target = { declFrom: sel.from, declTo: sel.to, nodeName: looksLikeMarkup ? 'Element' : 'selection' };
           } else {
               target = this._getEnclosingDeclaration(view);
               if (!target) return alert("Place the cursor inside a function, class, const, or object first — or select a range of text.");
           }

           const original = view.state.doc.sliceString(target.declFrom, target.declTo);
           const oneLined = this._toOneLine(original, target.nodeName);

           if (oneLined === original) return; // already minimal, nothing to do

           // Stash the pre-collapse text (plus the collapsed line's own
           // length) keyed by position so expandSelectionFromOneLine can
           // restore exact original formatting rather than just re-
           // running a generic formatter (which could produce different
           // style choices than the user originally had — e.g. their own
           // comment placement), AND so it knows exactly how much text to
           // replace on the way back without needing to guess a range
           // from line boundaries or re-derive a syntax node.
           Nexus.state._foldSnapshots = Nexus.state._foldSnapshots || {};
           Nexus.state._foldSnapshots[target.declFrom] = { original, collapsedLength: oneLined.length };

           view.dispatch({
               changes: { from: target.declFrom, to: target.declTo, insert: oneLined },
               selection: { anchor: target.declFrom }
           });

           const st = document.getElementById('footStatus');
           if (st) { st.innerText = "COLLAPSED TO ONE LINE"; st.style.color = "var(--gold)"; setTimeout(() => Nexus.UI.syncStatus(), 2000); }
       },

       // "Expand from one line": the inverse. If a snapshot exists for
       // this exact position (i.e. this range was collapsed by the tool
       // above and hasn't been touched since), restores the original
       // multi-line text verbatim. Otherwise falls back to running the
       // existing Prettier pipeline scoped to just this node, wrapped in
       // a throwaway container so the parser accepts a bare
       // function/class/object fragment standalone.
       async expandSelectionFromOneLine() {
           if (!Nexus.UI.needCM6('This tool', () => Nexus.UI.expandSelectionFromOneLine())) return;
           const view = Nexus.editorCore.view;
           const cursorPos = view.state.selection.main.head;
           const snapshots = Nexus.state._foldSnapshots || {};

           // FIX: this used to always re-derive "target" via
           // _getEnclosingDeclaration (a fresh syntax-tree lookup from the
           // cursor's current position) before ever checking for a
           // snapshot — but collapseSelectionToOneLine() now also handles
           // manual selections, which have no syntax node to rediscover
           // the same way a moment later. The snapshot map is already
           // keyed by the exact position the collapse happened at
           // (collapseSelectionToOneLine leaves the cursor sitting
           // exactly there afterward), so checking that position directly
           // first — before doing any syntax-tree work at all — is both
           // more correct and more direct: it can't accidentally resolve
           // to the WRONG node on the newly-collapsed single line (whose
           // own enclosing-declaration boundaries may no longer match
           // where the original multi-line block started/ended) and fail
           // to find a snapshot that's actually sitting right there.
           if (snapshots[cursorPos] !== undefined) {
               const { original: snapshotText, collapsedLength } = snapshots[cursorPos];
               // Exact replacement range from the stashed collapsed
               // length — no guessing from line boundaries, which could
               // be wrong if anything else legitimately shares that same
               // line, and no re-deriving a syntax node, which the
               // now-collapsed single line might resolve differently than
               // the original multi-line block did.
               const declTo = cursorPos + collapsedLength;
               view.dispatch({
                   changes: { from: cursorPos, to: declTo, insert: snapshotText },
                   selection: { anchor: cursorPos }
               });
               delete snapshots[cursorPos];
               const st = document.getElementById('footStatus');
               if (st) { st.innerText = "RESTORED"; st.style.color = "var(--success)"; setTimeout(() => Nexus.UI.syncStatus(), 2000); }
               return;
           }

           const target = this._getEnclosingDeclaration(view);
           if (!target) return alert("Place the cursor inside a function, class, const, or object first.");

           const current = view.state.doc.sliceString(target.declFrom, target.declTo);
           // was hand-written, not tool-collapsed) — reformat with
           // Prettier instead of just failing silently. Wrapping keeps
           // babel's parser happy for fragments that aren't valid as a
           // top-level Program on their own (a bare object literal, for
           // instance, parses as a block statement without this).
           //
           // HTML has no snapshot-less fallback here: Prettier's babel
           // parser and js_beautify are both JS-shaped tools and would
           // either throw or silently mangle a raw <div>...</div> fragment
           // (mis-parsing tag syntax as JSX, for instance). Since the
           // normal path for any HTML chunk this app itself collapsed
           // ALWAYS has a snapshot (collapseSelectionToOneLine always
           // writes one before collapsing), the only way to reach this
           // branch with an Element target is a hand-typed one-liner with
           // no collapse history — an honest "can't do this one
           // automatically" beats a corrupted rewrite.
           if (target.nodeName === 'Element') {
               return alert("No collapse history for this markup, and automatic HTML reformatting isn't supported here — expand it by hand, or use Prettier/Beautify on the whole file instead.");
           }

           try {
               const wrapped = `const __nexus_fold_wrap__ = (${current.trim().replace(/;$/, '')});`;
               const formatted = await prettier.format(wrapped, {
                   parser: 'babel',
                   plugins: [prettierPlugins.babel, prettierPlugins.estree],
                   tabWidth: Nexus.state.prefs.tabWidth,
                   printWidth: 80,
                   singleQuote: true
               });
               // Strip the wrapper back off.
               let unwrapped = formatted.trim()
                   .replace(/^const __nexus_fold_wrap__ = \(?/, '')
                   .replace(/\)?;?\s*$/, '');
               view.dispatch({
                   changes: { from: target.declFrom, to: target.declTo, insert: unwrapped },
                   selection: { anchor: target.declFrom }
               });
               const st = document.getElementById('footStatus');
               if (st) { st.innerText = "REFORMATTED"; st.style.color = "var(--success)"; setTimeout(() => Nexus.UI.syncStatus(), 2000); }
           } catch (e) {
               // Fall back to the plain multi-line prettify path used
               // elsewhere (js_beautify) if the wrapped-fragment parse
               // trick fails on something unusual (e.g. a class with
               // decorators) rather than leaving the user stuck.
               try {
                   const beautified = js_beautify(current, { indent_size: Nexus.state.prefs.tabWidth });
                   view.dispatch({
                       changes: { from: target.declFrom, to: target.declTo, insert: beautified },
                       selection: { anchor: target.declFrom }
                   });
               } catch (e2) {
                   // Was referencing e (the OUTER prettier failure) instead
                   // of e2 (this inner js_beautify failure) — meant the
                   // alert always described why Prettier failed even when
                   // Prettier succeeded at wrapping and the actual failure
                   // was js_beautify itself (e.g. not loaded yet).
                   alert("Couldn't reformat this fragment automatically:\n" + e2.message);
               }
           }
       },

       // Pure text collapse: strip comments, collapse all whitespace runs
       // (including newlines) to single spaces, and tighten spacing
       // immediately inside/around braces and after semicolons/commas so
       // the result reads like a real one-liner rather than just
       // "multi-line with the breaks removed."
       // Dispatches to a content-appropriate one-line collapse instead of
       // applying one universal regex pass to everything. The original
       // version was JS/CSS-shaped only (comment stripping tuned for // and
       // /* */, brace/paren tightening) and actively corrupted HTML when
       // applied to it: its "// comment" stripper has no concept of being
       // inside a quoted attribute, so `<a href="//example.com/path">`
       // loses everything after the // on that line, and its blanket
       // \s+ -> ' ' collapse flattens meaningful whitespace inside quoted
       // attribute values (e.g. style="content: '  a  b  '"). Routed by
       // target.nodeName, which _getEnclosingDeclaration already provides
       // for free — Lezer's HTML grammar names a full tag+content node
       // 'Element' (this exact string is asserted from documented Lezer
       // HTML grammar naming, not verified live in this sandbox — network
       // access to import and inspect the real parser is blocked here;
       // confirm on-device). If that name assumption is ever wrong, this
       // simply falls through to the original JS/CSS-shaped path below
       // rather than throwing or silently no-op'ing — degrades to the old
       // (imperfect-for-HTML, but previously-shipped) behavior instead of
       // breaking. A <script>/<style> block's own contents still resolve
       // through the nested JS/CSS grammar and get real JS/CSS node names
       // (FunctionDeclaration, RuleSet, etc.) via syntaxTree()'s automatic
       // mixed-parser handling, so embedded code keeps using the JS/CSS
       // path correctly without any special-casing needed here for that.
       _toOneLine(code, nodeName) {
           if (nodeName === 'Element') return this._toOneLineHTML(code);
           return this._toOneLineJS(code);
       },

       // HTML-safe one-line collapse: only touches whitespace that sits
       // BETWEEN tags (`>   <` -> `><`) and leading/trailing whitespace of
       // the whole chunk, and does nothing else — no comment stripping, no
       // brace tightening, nothing that requires understanding what's
       // inside a quoted attribute value well enough to leave it alone.
       // Comments in HTML are <!-- --> (not // or /* */) and are left
       // untouched entirely: safely detecting "is this <!-- inside a
       // quoted attribute" with the same reliability the app already has
       // for JS/CSS isn't worth the risk of corrupting markup for what's
       // primarily a compaction tool, not a comment-stripping one, for
       // this content type.
       _toOneLineHTML(code) {
           let out = code.trim();
           // Collapse runs of whitespace that occur strictly between a
           // closing `>` and the next `<` — i.e. text/whitespace-only gaps
           // between tags — down to nothing, matching how a human would
           // actually compact markup by hand. Never touches whitespace
           // that isn't immediately tag-adjacent, so text content and
           // attribute values are never at risk.
           out = out.replace(/>\s+</g, '><');
           // Collapse any remaining internal newlines/tabs (e.g. inside a
           // single tag's own attribute list spanning multiple lines) to
           // single spaces — safe because this only fires on whitespace
           // that was already a run of 2+ chars including a newline/tab,
           // never a single meaningful space, and multi-line attribute
           // lists don't rely on preserved internal newlines the way
           // quoted CSS/text content can.
           out = out.replace(/[ \t]*\n[ \t]*/g, ' ');
           return out;
       },

       _toOneLineJS(code) {
           let out = code;
           // Strip // line comments (careful not to eat http:// or similar
           // — only treat // as a comment start when not inside a string;
           // approximated here by only stripping when preceded by
           // whitespace-or-start and not part of a :// pattern).
           out = out.replace(/^\s*\/\/.*$/gm, '');
           out = out.replace(/([^:])\/\/(?![:/]).*$/gm, '$1');
           // Strip /* */ block comments.
           out = out.replace(/\/\*[\s\S]*?\*\//g, '');
           // Collapse all whitespace runs (including newlines) to one space.
           out = out.replace(/\s+/g, ' ').trim();
           // Tighten spacing: no space after { or [ or (, none before } or ] or ),
           // single space after ; and , when followed by non-space.
           out = out.replace(/([{\[(])\s+/g, '$1');
           out = out.replace(/\s+([}\])])/g, '$1');
           out = out.replace(/;\s*/g, '; ').replace(/;\s*}/g, ';}').replace(/\s+$/,'');
           out = out.replace(/,\s*/g, ', ');
           // A trailing comma immediately before a closing brace/bracket
           // (valid JS, e.g. `{a: 1, b: 2,}`) reads as a leftover artifact
           // once collapsed to one line — drop it, matching how a human
           // would actually write the one-liner by hand.
           out = out.replace(/,\s*([}\]])/g, '$1');
           return out;
       },

       async saveMap() {
           if (!Nexus.state.activeFile) {
               alert("No file open.");
               return;
           }
           const fileName = Nexus.state.activeFile;
           const content = Nexus.state.Vfs[fileName] || '';
           const mapFileName = `map.${fileName}`;
           const mapContent = this._generateMap(content, fileName);
           try {
               Nexus.state.Vfs[mapFileName] = mapContent;
               await Nexus.Vfs.save();
               if (Nexus.shell && typeof Nexus.shell.out === 'function') {
                   Nexus.shell.out(`📍 Map saved: ${mapFileName}`, 'success');
               }
               if (typeof Nexus.UI.renderTabs === 'function') Nexus.UI.renderTabs();
           } catch (e) {
               console.error("Map save failed:", e);
               alert("Failed to save map.");
           }
       },

       _generateMap(content, fileName) {
           const ext = fileName.split('.').pop().toLowerCase();
           let map = `# Map of ${fileName}\n\n`;
           // ts/tsx/mjs/jsx share JS's actual syntax shape (classes,
           // functions, arrows, consts) closely enough that the existing
           // brace/depth-tracking JS mapper applies directly — TypeScript's
           // extra type annotations don't change where a function or class
           // starts, which is all the mapper looks for.
           if (['js', 'mjs', 'ts', 'tsx', 'jsx'].includes(ext)) map += this._mapJS(content);
           else if (ext === 'html' || ext === 'htm') map += this._mapHTML(content);
           // SVG is XML, and its meaningful structure (groups, paths,
           // symbols with ids/classes) is exactly the tag/id/class
           // hierarchy _mapHTML already extracts — no separate mapper
           // needed for what is structurally the same problem.
           else if (ext === 'svg' || ext === 'xml') map += this._mapHTML(content);
           // Sass/LESS are brace-based like CSS (SCSS/LESS both use { }
           // nesting); plain Sass's indentation syntax falls through to
           // the generic line-numbered listing below, since it shares
           // neither CSS's braces nor Python's simple flat indentation.
           else if (['css', 'scss', 'less'].includes(ext)) map += this._mapCSS(content);
           else if (ext === 'yaml' || ext === 'yml') map += this._mapYAML(content);
           else if (ext === 'md' || ext === 'markdown') map += this._mapMarkdown(content);
           // Broad C-family brace languages: their function/class/method
           // declarations are shaped closely enough alike (return-type-or-
           // modifier, name, parens, opening brace) that one generic
           // brace-depth mapper covers all of them reasonably, rather than
           // needing ~15 near-identical bespoke mappers.
           else if (['c','h','cpp','cc','cxx','hpp','java','cs','go','rs','kt','kts','swift','php','m','mm','scala','dart','groovy'].includes(ext)) {
               map += this._mapBraceLanguage(content);
           }
           // Python (and Cython) have no braces at all — nesting is purely
           // indentation, same category of problem as YAML but keyed off
           // def/class instead of key:.
           else if (['py','pyw','pyx'].includes(ext)) map += this._mapPython(content);
           else {
               map += content.split('\n').map((line, i) => {
                   if (line.trim()) return `${i + 1}: ${line.substring(0, 80)}`;
               }).filter(Boolean).join('\n');
           }
           return map;
       },

       // Generic brace-language mapper: covers C/C++/Java/C#/Go/Rust/
       // Kotlin/Swift/PHP/Scala/Dart/Groovy/Objective-C reasonably well by
       // looking for "class Name" and "word(...) {" shapes rather than
       // JS-specific keywords like function/const/=>. Deliberately simpler
       // than _mapJS — these languages' declaration syntax varies enough
       // (Go's `func (r *Receiver) Name()`, Rust's `fn name<T>()`, Kotlin's
       // `fun name()`) that one shared regex set aiming for "good outline,
       // not perfect per-language parsing" is more honest than pretending
       // this is as precise as the hand-tuned JS mapper.
       _mapBraceLanguage(content) {
           const lines = content.split('\n');
           const entries = [];
           const stack = [];
           let depth = 0;
           let inBlockComment = false;

           const CLASS_RE = /^(?:public\s+|private\s+|internal\s+|final\s+|abstract\s+|export\s+)*(?:class|struct|interface|enum|trait|impl)\s+(\w+)/;
           // Go declares structs as "type Name struct {" rather than
           // "struct Name {" like C/Rust — needs its own pattern since it
           // doesn't fit the leading-keyword shape CLASS_RE expects.
           const GO_TYPE_RE = /^type\s+(\w+)\s+(?:struct|interface)\s*\{/;
           // Go methods declare their name AFTER a receiver in parens:
           // "func (s *Server) Start()" — a plain "word(...)" match would
           // catch "Start" only if it skips the receiver group first.
           const GO_METHOD_RE = /^func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(/;
           const FUNC_RE = /^(?:[\w<>\[\],\s*&]+\s+)?(?:func\s+|fn\s+|def\s+)?(\w+)\s*(?:<[^>]*>)?\s*\([^;]*\)\s*(?:\{|->.*\{)\s*$/;

           for (let i = 0; i < lines.length; i++) {
               let trimmed = lines[i].trim();
               if (inBlockComment) { if (trimmed.includes('*/')) inBlockComment = false; continue; }
               if (trimmed.startsWith('/*')) { if (!trimmed.includes('*/')) inBlockComment = true; continue; }
               if (trimmed.startsWith('//')) continue;
               trimmed = trimmed.replace(/\/\/.*$/, '').trim();
               if (!trimmed) continue;

               let label = null, isOpener = false;
               let m;
               if ((m = trimmed.match(GO_TYPE_RE))) {
                   label = `struct ${m[1]}`;
                   isOpener = true;
               } else if ((m = trimmed.match(GO_METHOD_RE)) && trimmed.includes('{')) {
                   label = `${m[1]}()`;
                   isOpener = true;
               } else if ((m = trimmed.match(CLASS_RE))) {
                   label = `${trimmed.match(/^(class|struct|interface|enum|trait|impl)/)?.[1] || 'class'} ${m[1]}`;
                   isOpener = true;
               } else if ((m = trimmed.match(FUNC_RE)) && !/^(if|for|while|switch|catch|else)$/.test(m[1])) {
                   label = `${m[1]}()`;
                   isOpener = trimmed.includes('{');
               }

               const opens = (trimmed.match(/\{/g) || []).length;
               const closes = (trimmed.match(/\}/g) || []).length;

               if (label) {
                   const entry = { line: i + 1, endLine: null, indent: stack.length, label };
                   entries.push(entry);
                   if (isOpener) stack.push({ depth: depth + opens, entry });
               }

               depth += opens;
               depth -= closes;
               while (stack.length && depth < stack[stack.length - 1].depth) {
                   stack.pop().entry.endLine = i + 1;
               }
           }

           if (entries.length === 0) return '(no mappable structure)\n';
           return entries.map(e => {
               const span = e.endLine && e.endLine > e.line ? `${e.line}-${e.endLine}` : `${e.line}`;
               return `${'  '.repeat(e.indent)}[${span}] ${e.label}`;
           }).join('\n') + '\n';
       },

       // Python has no braces — block structure is indentation only, so
       // this tracks nesting the same way _mapYAML does (by comparing each
       // line's actual leading-whitespace column), keyed off def/class
       // instead of key:.
       _mapPython(content) {
           const lines = content.split('\n');
           const entries = [];
           const stack = []; // {indentCol}
           for (let i = 0; i < lines.length; i++) {
               const line = lines[i];
               if (!line.trim() || line.trim().startsWith('#')) continue;
               const indentCol = line.match(/^\s*/)[0].length;
               const match = line.match(/^\s*(?:async\s+)?(def|class)\s+(\w+)/);
               if (!match) continue;
               while (stack.length && stack[stack.length - 1].indentCol >= indentCol) stack.pop();
               const label = match[1] === 'class' ? `class ${match[2]}` : `${match[2]}()`;
               entries.push({ line: i + 1, indent: stack.length, label });
               stack.push({ indentCol });
           }
           if (entries.length === 0) return '(no mappable structure)\n';
           return entries.map(e => `${'  '.repeat(e.indent)}[${e.line}] ${e.label}`).join('\n') + '\n';
       },

       // YAML's structure is entirely indentation-driven rather than
       // brace-driven, so it needs its own outline logic rather than
       // reusing the JS mapper's brace-depth tracking. Maps top-level and
       // nested keys, using each line's actual leading-whitespace column
       // as the nesting signal (YAML has no other way to express nesting).
       _mapYAML(content) {
           const lines = content.split('\n');
           const entries = [];
           const stack = []; // {indentCol}
           for (let i = 0; i < lines.length; i++) {
               const line = lines[i];
               if (!line.trim() || line.trim().startsWith('#')) continue;
               const match = line.match(/^(\s*)(-\s+)?([\w.-]+)\s*:/);
               if (!match) continue;
               const indentCol = match[1].length + (match[2] ? match[2].length : 0);
               const key = match[3];
               while (stack.length && stack[stack.length - 1].indentCol >= indentCol) stack.pop();
               entries.push({ line: i + 1, indent: stack.length, label: key + ':' });
               stack.push({ indentCol });
           }
           if (entries.length === 0) return '(no mappable structure)\n';
           return entries.map(e => `${'  '.repeat(e.indent)}[${e.line}] ${e.label}`).join('\n') + '\n';
       },

       // Markdown's outline is its heading hierarchy (# down to ######) —
       // the direct equivalent of a table of contents, which is exactly
       // what the map/cheat-sheet feature is for on this file type.
       _mapMarkdown(content) {
           const lines = content.split('\n');
           const entries = [];
           let inCodeFence = false;
           for (let i = 0; i < lines.length; i++) {
               const trimmed = lines[i].trim();
               // Don't pick up lines that merely look like headings (a
               // shell comment, a Python type hint) if they appear inside
               // a fenced code block quoted in the markdown itself.
               if (trimmed.startsWith('```')) { inCodeFence = !inCodeFence; continue; }
               if (inCodeFence) continue;
               const match = trimmed.match(/^(#{1,6})\s+(.+)$/);
               if (match) {
                   entries.push({ line: i + 1, indent: match[1].length - 1, label: match[2].trim() });
               }
           }
           if (entries.length === 0) return '(no mappable structure)\n';
           return entries.map(e => `${'  '.repeat(e.indent)}[${e.line}] ${'#'.repeat(e.indent + 1)} ${e.label}`).join('\n') + '\n';
       },

       // Rebuilt from scratch — the original version was line-by-line regex
       // matching with no brace tracking, which meant: async methods never
       // matched (the `async` keyword sat before the name the regex
       // expected first), arrow-function consts were indistinguishable
       // from plain values, nested class methods rendered as flat
       // top-level entries with no indication of what they belonged to,
       // and there was no way to tell from the map how large any single
       // entry was. This version tracks actual brace depth so nesting and
       // extents are both real, and matches functions/methods/arrows in
       // any order the keywords appear.
       _mapJS(content) {
           const lines = content.split('\n');
           const entries = []; // {line, endLine, indent, label}
           const stack = []; // open braces: {depth, entry}
           let depth = 0;
           let inBlockComment = false;

           // Matches, in priority order: class Name, then any of
           // function decl / async function decl / method shorthand
           // (optionally async) / arrow assigned to const-let-var, then
           // plain const/let/var. Each capturer records whether what it
           // found actually opens a brace on this line, since only
           // brace-opening entries get pushed onto the nesting stack —
           // a one-line `const x = 5;` shouldn't swallow everything
           // that follows as its "children."
           const CLASS_RE = /^(?:export\s+)?class\s+(\w+)/;
           const FUNC_DECL_RE = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+(\w+)\s*\(/;
           const ARROW_RE = /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(?[^=]*\)?\s*=>/;
           const CONST_FN_EXPR_RE = /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function\b/;
           const METHOD_RE = /^(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?\*?\s*(\w+)\s*\([^)]*\)\s*\{?\s*$/;
           const PLAIN_VAR_RE = /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/;
           // Reserved words that would otherwise false-positive as
           // "methods" when they start a control-flow line ending in `) {`
           // — e.g. `if (x) {`, `for (;;) {`, `while (x) {`, `switch (x) {`,
           // `catch (e) {`.
           const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function']);

           for (let i = 0; i < lines.length; i++) {
               const raw = lines[i];
               let trimmed = raw.trim();

               // Comment handling: skip content inside /* */ spans and
               // strip trailing // comments before matching, so a
               // commented-out `class Foo {` doesn't get mapped.
               if (inBlockComment) {
                   if (trimmed.includes('*/')) inBlockComment = false;
                   continue;
               }
               if (trimmed.startsWith('/*')) {
                   if (!trimmed.includes('*/')) inBlockComment = true;
                   continue;
               }
               if (trimmed.startsWith('//')) continue;
               trimmed = trimmed.replace(/\/\/(?![:/]).*$/, '').trim();
               if (!trimmed) continue;

               let label = null;
               let isBraceOpener = false;

               let m;
               if ((m = trimmed.match(CLASS_RE))) {
                   label = `class ${m[1]}`;
                   isBraceOpener = true;
               } else if ((m = trimmed.match(FUNC_DECL_RE))) {
                   label = `${m[1]}()`;
                   isBraceOpener = true;
               } else if ((m = trimmed.match(ARROW_RE))) {
                   label = `${m[1]} = () =>`;
                   isBraceOpener = trimmed.includes('{');
               } else if ((m = trimmed.match(CONST_FN_EXPR_RE))) {
                   label = `${m[1]} = function()`;
                   isBraceOpener = true;
               } else if ((m = trimmed.match(METHOD_RE)) && !CONTROL_KEYWORDS.has(m[1]) && stack.length > 0) {
                   // Method shorthand only counts inside an existing
                   // class/object body (stack.length > 0) — otherwise
                   // `someCall(x) {` at top level (rare but possible in a
                   // callback-heavy file) would falsely read as a method.
                   label = `${m[1]}()`;
                   isBraceOpener = trimmed.includes('{');
               } else if ((m = trimmed.match(PLAIN_VAR_RE))) {
                   label = m[1];
                   // `const obj = {` opens an object body whose methods
                   // should nest underneath it — but `const x = 5;` or
                   // `const arr = [1,2,3];` should not become a fake
                   // parent for whatever code happens to follow. Only
                   // treat this as a brace opener when the line ends with
                   // an actual unclosed `{` (an object literal starting
                   // here), not just any line containing a brace.
                   isBraceOpener = /=\s*\{\s*$/.test(trimmed);
               }

               // Track brace depth for every line regardless of whether it
               // matched a label, so nesting stays accurate through plain
               // code between declarations.
               const opens = (trimmed.match(/\{/g) || []).length;
               const closes = (trimmed.match(/\}/g) || []).length;

               if (label) {
                   const indent = stack.length;
                   const entry = { line: i + 1, endLine: null, indent, label };
                   entries.push(entry);
                   if (isBraceOpener) {
                       stack.push({ depth: depth + opens, entry });
                   }
               }

               depth += opens;
               depth -= closes;

               // Pop any stack frames whose opening brace has now been
               // closed, recording the line each one closed on.
               while (stack.length && depth < stack[stack.length - 1].depth) {
                   const frame = stack.pop();
                   frame.entry.endLine = i + 1;
               }
           }

           if (entries.length === 0) return '(no mappable structure)\n';

           return entries.map(e => {
               const pad = '  '.repeat(e.indent);
               const span = e.endLine && e.endLine > e.line ? `${e.line}-${e.endLine}` : `${e.line}`;
               return `${pad}[${span}] ${e.label}`;
           }).join('\n') + '\n';
       },

       // Rebuilt from scratch — the original was a flat per-line scan with
       // no DOM nesting at all (a <header> inside a <div id="appRoot">
       // rendered as an unindented sibling) and only recognized a
       // handful of tags with id/class/heading — every other element,
       // including plain content tags like <a> or <p>, was invisible.
       // This version does simple tag-depth tracking so indentation
       // reflects actual nesting, and captures any tag that has an id,
       // a class, or is a heading/semantic landmark — while still
       // ignoring pure text/formatting tags that would just add noise
       // (span, b, i, br, etc. with no id/class of their own).
       _mapHTML(content) {
           const lines = content.split('\n');
           const entries = [];
           let depth = 0;
           const VOID_TAGS = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
           const NOISE_TAGS = new Set(['span','b','i','em','strong','small','br','wbr']);
           const LANDMARK_TAGS = new Set(['header','nav','main','footer','section','article','aside','form','table','ul','ol']);

           for (let i = 0; i < lines.length; i++) {
               const line = lines[i];
               // Walk the line character-by-character for tags rather than
               // one regex per line, so a line with multiple tags (common
               // in minified or tightly-written HTML) is handled correctly
               // and depth stays accurate.
               const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>]*)?)\s*(\/?)>/g;
               let m;
               while ((m = tagRe.exec(line)) !== null) {
                   const isClosing = m[1] === '/';
                   const tagName = m[2].toLowerCase();
                   const attrs = m[3] || '';
                   const isSelfClosing = m[4] === '/' || VOID_TAGS.has(tagName);

                   if (isClosing) {
                       depth = Math.max(0, depth - 1);
                       continue;
                   }

                   const idMatch = attrs.match(/\bid=["']([^"']+)["']/);
                   const classMatch = attrs.match(/\bclass=["']([^"']+)["']/);
                   const isHeading = /^h[1-6]$/.test(tagName);
                   const isLandmark = LANDMARK_TAGS.has(tagName);
                   const worthMapping = idMatch || classMatch || isHeading || isLandmark;

                   if (worthMapping && !NOISE_TAGS.has(tagName)) {
                       let label = `<${tagName}`;
                       if (idMatch) label += ` id="${idMatch[1]}"`;
                       if (classMatch) label += ` class="${classMatch[1]}"`;
                       label += '>';
                       if (isHeading) {
                           // Pull the heading's text content if it's on
                           // the same line (the common case).
                           const textMatch = line.slice(m.index).match(/>([^<]*)</);
                           if (textMatch && textMatch[1].trim()) label += ` ${textMatch[1].trim()}`;
                       }
                       entries.push({ line: i + 1, indent: depth, label });
                   }

                   if (!isSelfClosing) depth++;
               }
           }

           if (entries.length === 0) return '(no mappable structure)\n';
           return entries.map(e => `${'  '.repeat(e.indent)}[${e.line}] ${e.label}`).join('\n') + '\n';
       },

       // Rebuilt from scratch — the original had no concept of @media (or
       // @supports/@keyframes) blocks at all, so a rule nested inside a
       // media query rendered as an indistinguishable duplicate of any
       // same-named rule outside it. This version tracks brace depth and
       // nests rules found inside at-rule blocks under their condition.
       _mapCSS(content) {
           const lines = content.split('\n');
           const entries = [];
           const stack = []; // {depth, isAtRule}
           let depth = 0;
           let inBlockComment = false;

           const AT_RULE_RE = /^(@(?:media|supports|keyframes|font-face|page)\b[^{]*)\{/;
           const SELECTOR_RE = /^([^{}\n]+)\{/;

           for (let i = 0; i < lines.length; i++) {
               let trimmed = lines[i].trim();

               if (inBlockComment) {
                   if (trimmed.includes('*/')) inBlockComment = false;
                   continue;
               }
               if (trimmed.startsWith('/*')) {
                   if (!trimmed.includes('*/')) inBlockComment = true;
                   else trimmed = trimmed.replace(/\/\*.*?\*\//, '').trim();
                   if (!trimmed) continue;
               }
               if (!trimmed) continue;

               let m;
               if ((m = trimmed.match(AT_RULE_RE))) {
                   entries.push({ line: i + 1, indent: stack.length, label: m[1].trim() });
                   stack.push({ depth: depth + 1 });
                   depth++;
               } else if ((m = trimmed.match(SELECTOR_RE))) {
                   const selector = m[1].trim().replace(/\s+/g, ' ');
                   // Skip property-looking false positives (a value that
                   // happens to contain a brace, e.g. inside a custom
                   // property) — real selectors don't contain a colon
                   // immediately followed by a value-like token before
                   // the brace.
                   if (!/^[a-z-]+\s*:/i.test(selector)) {
                       entries.push({ line: i + 1, indent: stack.length, label: selector.length > 60 ? selector.slice(0, 57) + '...' : selector });
                   }
                   stack.push({ depth: depth + 1 });
                   depth++;
               } else {
                   const closes = (trimmed.match(/\}/g) || []).length;
                   for (let c = 0; c < closes; c++) {
                       if (stack.length) { stack.pop(); depth--; }
                   }
               }
           }

           if (entries.length === 0) return '(no mappable structure)\n';
           return entries.map(e => `${'  '.repeat(e.indent)}[${e.line}] ${e.label}`).join('\n') + '\n';
       },

       // Renders exactly the open tabs (Nexus.state.openTabs), not every
       // loaded file — this is the actual fix for "files should sit in
       // the explorer until clicked to open." A small dot marks any tab
       // with unsaved work (Vfs.isDirty()) so the popup closeTab() can
       // show isn't a surprise — the person can see which tabs it'll
       // apply to before they ever tap ×.
       renderTabs() {
           const bar = document.getElementById('fileTabsBar');
           if (!bar) return;
           
           bar.innerHTML = Nexus.state.openTabs.map(fn => `
               <div class="file-tab ${fn === Nexus.state.activeFile ? 'active' : ''}" onclick="Nexus.Vfs.switchFile('${fn}')">
                   ${Nexus.Vfs.isDirty(fn) ? '<span class="tab-dirty-dot" title="Unsaved changes">●</span>' : ''}${fn}
                   <span class="tab-close" onclick="event.stopPropagation(); Nexus.Vfs.closeTab('${fn}')">&times;</span>
               </div>
           `).join('');
           
           const activeTab = bar.querySelector('.active');
           if (activeTab) {
               activeTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
           }
       },
// FIX: this ran unconditionally on every boot regardless of the Infinite
// Scroll setting (Settings -> Kinetic Widgets, off by default) — the
// checkbox correctly read/wrote Nexus.state.prefs.infiniteScroll, but
// nothing ever actually checked that value before cloning the ribbon
// track, so the setting was purely decorative. Also handles turning it
// OFF after the clones already exist (not just skipping creation when
// off from the start) — the checkbox's onchange calls this directly (see
// its own handler), so toggling it needs to be able to undo a live
// infinite-scroll setup, not just gate the boot-time one.
initInfiniteRibbon() {
   const c = document.getElementById('ribbonContainer');
   const t = document.getElementById('ribbonTrack');
   if (!c || !t) return;

   const wantsInfinite = !!Nexus.state.prefs.infiniteScroll;

   if (!wantsInfinite) {
       // If clones exist from a previous session/toggle, remove them and
       // detach the scroll listener so a disabled setting genuinely means
       // disabled, not just "no new clones going forward."
       if (c._infiniteScrollHandler) {
           c.removeEventListener('scroll', c._infiniteScrollHandler);
           c._infiniteScrollHandler = null;
       }
       if (t._infiniteScrollWired) {
           // The real, single, original track content is exactly the
           // first third of what's currently in there (two clones were
           // appended after it) — slicing back to that undoes the clone
           // without needing to have kept a separate backup copy around.
           const originalChildCount = t.children.length / 3;
           while (t.children.length > originalChildCount) {
               t.removeChild(t.lastElementChild);
           }
           t._infiniteScrollWired = false;
       }
       c.scrollLeft = 0;
       return;
   }

   if (t._infiniteScrollWired) return; // already set up — toggling on when it's already on is a no-op, not a re-clone

   const fragment = document.createDocumentFragment();
   // Clone the track twice to create the infinite loop nodes
   fragment.appendChild(t.cloneNode(true));
   fragment.appendChild(t.cloneNode(true));
   t.appendChild(fragment);
   t._infiniteScrollWired = true;

   const handler = () => {
       const w = t.scrollWidth / 3;
       if (c.scrollLeft >= w * 2) c.scrollLeft -= w;
       if (c.scrollLeft <= 0) c.scrollLeft += w;
   };
   c._infiniteScrollHandler = handler;
   c.addEventListener('scroll', handler, { passive: true }); // Passive = Smoother scrolling

   // Use requestAnimationFrame to ensure the initial jump is invisible
   requestAnimationFrame(() => { c.scrollLeft = t.scrollWidth / 3; });
},

               initEdgeSwipes() { 
           let startX = 0; 
           window.addEventListener('touchstart', (e) => { 
               startX = e.touches[0].clientX; 
           }); 
           
           window.addEventListener('touchend', (e) => { 
               const d = e.changedTouches[0].clientX - startX; 
               if (startX < 30 && d > 100) this.toggleSidebar('left'); 
               if (startX > window.innerWidth - 30 && d < -100) this.toggleSidebar('right'); 
           }); 
       },
       
       // Pure 2-state toggle: 'util' and 'full' only. The former 'readonly'
       // (Regular Read Only) mode has been removed entirely per spec — this
       // app now has exactly two edit states, not three. Kept as a settable
       // function (not just a cycling button handler) for the same reason
       // as before: boot-time restoration needs to jump straight to
       // whatever was last saved, not advance one step at a time.
       //
       // 'util' is the fallback for any unrecognized/missing saved value —
       // it's still the least-surprising default of the two remaining
       // states: the editor is fully interactive (tap, select, cursor,
       // every tool button) but the OS soft keyboard stays suppressed via
       // inputmode="none" until the person explicitly asks for raw
       // keyboard input via Full Edit. Nothing about 'util' blocks typing
       // at the DOM level (contentEditable/readonly are both already
       // "true"/absent) — inputmode="none" only hints the OS soft keyboard
       // not to appear; it does not by itself prevent input from an
       // already-visible keyboard, a hardware keyboard, or any of this
       // app's own tool-driven insertions (chunk editor, keyboard rows,
       // paste, etc.), which is exactly why every hasAttribute('readonly')
       // gate elsewhere in this file already passes through in Util Mode.
       setEditMode(mode) {
           const ed = document.getElementById('rawTerminal');
           const st = document.getElementById('footStatus');
           const btns = document.querySelectorAll('.edit-btn-trigger');
           const cmDom = (Nexus.editorCore && Nexus.editorCore.view && Nexus.editorCore.view.contentDOM) || null;
           if (!ed) return;

           if (mode !== 'full') mode = 'util'; // collapse any unrecognized value (including the old 'readonly') to the safe default

           ed.removeAttribute('readonly');
           if (cmDom) cmDom.contentEditable = "true";

           if (mode === 'util') {
               ed.setAttribute('inputmode', 'none');
               if (cmDom) cmDom.setAttribute('inputmode', 'none');
               if (st) { st.innerText = "UTIL MODE"; st.style.color = "var(--accent)"; }
               btns.forEach(btn => {
                   btn.innerHTML = "🛠️";
                   btn.title = "Utility Mode — tap to switch to Full Edit";
                   btn.setAttribute('aria-label', 'Editor is in utility mode, tap to enable full editing');
                   btn.className = "tool-btn edit-btn-trigger btn-edit-util";
               });
           } else {
               ed.removeAttribute('inputmode');
               if (cmDom) cmDom.removeAttribute('inputmode');
               if (st) { st.innerText = "READY (FULL)"; st.style.color = "var(--success)"; }
               btns.forEach(btn => {
                   btn.innerHTML = "🔓";
                   btn.title = "Full Edit — tap to switch to Utility Mode";
                   btn.setAttribute('aria-label', 'Editor is fully unlocked, tap to switch to utility mode');
                   btn.className = "tool-btn edit-btn-trigger btn-edit-unlocked";
               });
           }

           Nexus.state.prefs.editMode = mode;
           Nexus.settings.update('editMode', mode);

           // Sync the dropdown's icon/state here, at the single source of
           // truth, instead of relying on every caller to remember a
           // separate syncRibbonMenu() afterward — newFile() used to skip
           // this entirely (see its own comment), leaving the dropdown
           // showing a stale icon after creating a file. Guarded with
           // typeof since setEditMode can run during boot restoration
           // before syncRibbonMenu (defined later in this same object
           // literal) has necessarily been assigned yet on some engines.
           if (typeof this.syncRibbonMenu === 'function') this.syncRibbonMenu();
       },

       toggleEditMode() { 
           const ed = document.getElementById('rawTerminal'); 
           const st = document.getElementById('footStatus'); 
           
           if (!Nexus.state.activeFile) {
               if (st) { st.innerText = "NO FILE OPEN"; st.style.color = "var(--gold)"; }
               return;
           }

           // Two states only — flip between them directly instead of
           // cycling through a third. Whatever the current inputmode is,
           // toggling means "the other one."
           const currentlyFull = ed.getAttribute('inputmode') !== 'none';
           this.setEditMode(currentlyFull ? 'util' : 'full');
       },

       toggleSidebar(s) { 
           const id = s === 'left' ? 'panelLeft' : 'panelRight';
           // panel-right and panel-terminal both render as full-width,
           // same-z-index right-side overlays (see Nexus.Terminal.toggle()).
           // If both end up "open" at once, whichever opened second stacks
           // on top and blocks every button in the other — closing the
           // terminal here (and vice versa, in Terminal.toggle()) keeps
           // only one of the two on screen at a time.
           if (s === 'right') {
               const terminal = document.getElementById('panelTerminal');
               if (terminal && terminal.classList.contains('open')) terminal.classList.remove('open');
               // Re-apply the relevant-tools filter every time the
               // diagnostics panel opens, since the active file may have
               // changed since it was last open — without this, switching
               // from a .js file to a .css file while the panel was closed
               // would leave stale JS-only tools visible/hidden wrong.
               this.filterDiagPanel();
           }
           document.getElementById(id).classList.toggle('open'); 
       },

       // Hides any [data-langs] tool whose comma-separated extension list
       // doesn't include the active file's extension — e.g. "FORMAT SQL"
       // only shows for .sql files, "HTML" audit card only for .html/.htm.
       // Tools with no data-langs attribute are considered universal and
       // always shown. Controlled by the "Only show tools relevant to the
       // open file" checkbox at the bottom of the panel; the checkbox
       // state persists via Nexus.settings like every other UI preference
       // in this app, so it doesn't reset every session.
       toggleDiagFilter(enabled) {
           Nexus.settings.update('diagFilterEnabled', enabled);
           this.filterDiagPanel();
       },

       filterDiagPanel() {
           const enabled = !!Nexus.state.prefs.diagFilterEnabled;
           const checkbox = document.getElementById('diagFilterToggle');
           if (checkbox) checkbox.checked = enabled;

           const ext = Nexus.state.activeFile ? Nexus.state.activeFile.split('.').pop().toLowerCase() : '';
           document.querySelectorAll('#panelRight [data-langs]').forEach(el => {
               if (!enabled) { el.classList.remove('diag-lang-hidden'); return; }
               const langs = el.dataset.langs.split(',').map(s => s.trim());
               el.classList.toggle('diag-lang-hidden', !langs.includes(ext));
           });
       },

       toggleSlide(t) { 
           const id = t === 'diag' ? 'diagHub' : 'shellSlide';
           document.getElementById(id).classList.toggle('open'); 
       },

       // Converts a modal argument like 'settings' or 'kb-builder' into its
       // real camelCase element id ('modalSettings', 'modalKbBuilder').
       // FIX: openModal/closeModal previously used 'modal-' + id directly,
       // which matched every modal element's id before the camelCase rename
       // but matches nothing now — every modal in the app was unable to
       // open or close. This restores the real mapping.
       toModalId(id) {
           return 'modal' + id.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
       },
       openModal(id) { 
           if (id === 'dreamer') Nexus.dreamer.updatePreview(); 
           if (id === 'graph') Nexus.graph.render(); 
           if (id === 'settings') { Nexus.settings.calcStorage(); Nexus.UI.renderNavDrawerCustomizer(); }
           if (id === 'util-layout') Nexus.UI.renderUtilLayoutModal();
           if (id === 'snapshots') Nexus.snapshots.render();
           if (id === 'storage-inspector') Nexus.storageInspector.render();
           if (id === 'peer-sync') {
               const joinRow = document.getElementById('peerSyncJoinRow');
               if (joinRow) joinRow.style.display = 'none';
               const codeEl = document.getElementById('peerSyncCode');
               if (codeEl) codeEl.innerText = '';
               const controls = document.getElementById('peerSyncControls');
               if (controls) controls.style.display = 'none';
               if (!Nexus.peerSync.conn) {
                   const status = document.getElementById('peerSyncStatus');
                   if (status) { status.innerText = 'Not connected.'; status.style.color = 'var(--text)'; }
               }
           }
           if (id === 'diff') {
               const files = Object.keys(Nexus.state.Vfs);
               const options = files.map(f => `<option value="${f}">${f}</option>`).join('');
               const lSel = document.getElementById('diffLeftSel');
               const rSel = document.getElementById('diffRightSel');
               lSel.innerHTML = options;
               rSel.innerHTML = options;
               // Sensible default: left = whatever's currently open, right =
               // the next different file if one exists — otherwise both
               // sides just show the same file with an empty diff, which is
               // an honest (if boring) starting state rather than an error.
               if (Nexus.state.activeFile) lSel.value = Nexus.state.activeFile;
               const other = files.find(f => f !== lSel.value);
               if (other) rSel.value = other;
               Nexus.DiffEngine.run();
           }
           if (id === 'combine') {
               const list = document.getElementById('combineList');
               list.innerHTML = Object.keys(Nexus.state.Vfs).map(f => `
                   <label style="display:flex; align-items:center; gap:10px; padding:12px; color:#fff; cursor:pointer; background:var(--surface); border-radius:8px; margin-bottom:5px;">
                       <input type="checkbox" value="${f}" class="combine-cb" style="width:18px; height:18px;"> 
                       <span style="font-family:monospace; font-size:12px;">${f}</span>
                   </label>
               `).join('');
           }

           // FIX (Device Sync opening underneath Settings): every
           // .modal-overlay shares the same z-index (10000, in the
           // stylesheet) — with two active at once, the browser falls
           // back to DOM source order to decide which renders on top,
           // not "which was opened more recently." Since this app's
           // entire modal design is one full-screen dimmed overlay at a
           // time, never two intentionally stacked, the real fix is
           // making that actually true: close any other currently-open
           // modal before opening this one. This wasn't unique to
           // Settings/Device Sync — the same latent bug exists for every
           // modal that opens another modal from inside itself (Compare,
           // Vault, Templates, Compress, Sprite Sheet, Customize Utility
           // Bar, the LocalStorage Inspector all do this too) — Settings
           // was just the one case where it happened to be visible, since
           // its own launch points (Files panel, Diagnostics Hub) are
           // side panels, not .modal-overlay elements themselves.
           document.querySelectorAll('.modal-overlay.active').forEach(el => {
               if (el.id !== this.toModalId(id)) el.classList.remove('active');
           });
           document.getElementById(this.toModalId(id)).classList.add('active'); 
       },

       openCombineModal() {
           this.openModal('combine');
       },

       closeModal(id) { 
           document.getElementById(this.toModalId(id)).classList.remove('active'); 
       },

       toggleSun() { 
           document.body.classList.toggle('outdoor-mode'); 
           // Persist — this used to be a bare class toggle with no memory,
           // so the display mode silently reset to dark on every reload.
           Nexus.settings.update('outdoorMode', document.body.classList.contains('outdoor-mode'));

           // FIX (light mode didn't affect the editor): live-reconfigure
           // the theme Compartment immediately, same pattern as every
           // other CM6 toggle in this app (see toggleIndentGuides() right
           // below for the reference version this copies) — previously
           // oneDark was decided once at construction time, so this class
           // toggle correctly repainted the chrome/panels/footer via CSS
           // variables but left an already-open editor's own syntax
           // highlighting on whatever theme it booted with until the next
           // file switch or reload.
           if (Nexus.editorCore.isCM6 && Nexus.editorCore.view && Nexus.editorCore.themeCompartment && Nexus.editorCore.modules && Nexus.editorCore.modules.oneDark) {
               const wantsDark = !document.body.classList.contains('outdoor-mode');
               Nexus.editorCore.view.dispatch({
                   effects: Nexus.editorCore.themeCompartment.reconfigure(wantsDark ? [Nexus.editorCore.modules.oneDark] : [])
               });
           }
       },

       toggleIndentGuides() {
           Nexus.state.prefs.indentGuides = !Nexus.state.prefs.indentGuides;
           Nexus.settings.update('indentGuides', Nexus.state.prefs.indentGuides);

           // Live-update immediately if CM6 is already open, via the
           // Compartment set up in toggleEditor() — no rebuild, no flicker,
           // no needing to switch files to see the change take effect. This
           // only works if CM6 has actually booted at least once this
           // session (indentGuideCompartment and modules only exist after
           // that); if not (still on vanilla, or CM6 never opened yet), the
           // preference is still saved correctly and will simply apply the
           // next time CM6 boots — same "not live, but correct on next
           // boot" fallback the outdoor-mode/theme toggle already uses.
           if (Nexus.editorCore.isCM6 && Nexus.editorCore.view && Nexus.editorCore.indentGuideCompartment && Nexus.editorCore.modules && Nexus.editorCore.modules.indentationMarkers) {
               const { indentationMarkers } = Nexus.editorCore.modules;
               const newExtension = Nexus.state.prefs.indentGuides
                   ? indentationMarkers({ hideFirstIndent: true })
                   : [];
               Nexus.editorCore.view.dispatch({
                   effects: Nexus.editorCore.indentGuideCompartment.reconfigure(newExtension)
               });
           }

           const btn = document.getElementById('indentGuidesBtn');
           if (btn) btn.classList.toggle('btn-accent', Nexus.state.prefs.indentGuides);
       },

       // Word wrap toggle — mirrors toggleIndentGuides' exact structure:
       // flip the pref, persist it, live-update CM6 via its Compartment if
       // already booted, and fall back to a CSS class for the vanilla
       // textarea engine (which has no Compartment concept at all, since
       // it's not CM6).
       toggleWordWrap() {
           Nexus.state.prefs.wordWrap = !Nexus.state.prefs.wordWrap;
           Nexus.settings.update('wordWrap', Nexus.state.prefs.wordWrap);

           if (Nexus.editorCore.isCM6 && Nexus.editorCore.view && Nexus.editorCore.wordWrapCompartment && Nexus.editorCore.modules && Nexus.editorCore.modules.EditorView) {
               const { EditorView } = Nexus.editorCore.modules;
               const newExtension = Nexus.state.prefs.wordWrap ? EditorView.lineWrapping : [];
               Nexus.editorCore.view.dispatch({
                   effects: Nexus.editorCore.wordWrapCompartment.reconfigure(newExtension)
               });
           }

           const ed = document.getElementById('rawTerminal');
           if (ed) ed.classList.toggle('word-wrap-on', Nexus.state.prefs.wordWrap);

           const btn2 = document.getElementById('wordWrapBtn');
           if (btn2) btn2.classList.toggle('btn-accent', Nexus.state.prefs.wordWrap);
       },

       // Whitespace visualization — CM6-only, unlike word wrap/indent
       // guides which both have a (lesser) vanilla-textarea fallback. A
       // plain <textarea> has no mechanism to style individual characters
       // differently from their neighbors — CM6's decoration system is
       // what makes rendering a space as a visible dot possible at all, so
       // there's no honest equivalent to fall back to here. Rather than
       // silently doing nothing on the vanilla engine (confusing — "I
       // toggled it, why didn't anything change?"), this says so directly.
       toggleShowWhitespace() {
           if (!Nexus.UI.needCM6('Whitespace visualization', () => Nexus.UI.toggleShowWhitespace())) return;

           Nexus.state.prefs.showWhitespace = !Nexus.state.prefs.showWhitespace;
           Nexus.settings.update('showWhitespace', Nexus.state.prefs.showWhitespace);

           if (Nexus.editorCore.view && Nexus.editorCore.whitespaceCompartment && Nexus.editorCore.modules && Nexus.editorCore.modules.highlightWhitespace) {
               const { highlightWhitespace, highlightTrailingWhitespace } = Nexus.editorCore.modules;
               const newExtension = Nexus.state.prefs.showWhitespace
                   ? [highlightWhitespace(), highlightTrailingWhitespace()]
                   : [];
               Nexus.editorCore.view.dispatch({
                   effects: Nexus.editorCore.whitespaceCompartment.reconfigure(newExtension)
               });
           }

           const btn = document.getElementById('showWhitespaceBtn');
           if (btn) btn.classList.toggle('btn-accent', Nexus.state.prefs.showWhitespace);
       },

       // Bracket tracing toggle. Defaults ON (prefs.bracketTracing !==
       // false, matching how the compartment itself is initialized above)
       // — this is the app's custom high-visibility bracket-pair styling,
       // not bracket matching itself (basicSetup's own bundled copy of
       // bracketMatching() keeps working regardless; see the long comment
       // on the compartment's setup for why turning this off doesn't fully
       // disable matching, just this app's louder styling for it).
       // FIX: no visible change on toggle isn't a bug in the matching or
       // its styling (both are real and already work — see the
       // .cm-matchingBracket CSS override, which deliberately makes
       // matches more legible than CM6's own barely-visible default) — the
       // actual problem is that bracketMatching() ONLY highlights when the
       // cursor sits directly next to a bracket. Toggle it off/on with the
       // cursor anywhere else and there is genuinely nothing to see either
       // way, which reads exactly like "I can't tell what this does."
       // Jumping the cursor to the nearest bracket on the page right when
       // this turns ON gives an immediate, real demonstration instead of
       // requiring you to already know to go place your cursor next to a
       // bracket yourself first.
       toggleBracketTracing() {
           if (!Nexus.UI.needCM6('Bracket match highlighting', () => Nexus.UI.toggleBracketTracing())) return;

           const newValue = !(Nexus.state.prefs.bracketTracing !== false);
           Nexus.state.prefs.bracketTracing = newValue;
           Nexus.settings.update('bracketTracing', newValue);

           if (Nexus.editorCore.view && Nexus.editorCore.bracketTracingCompartment && Nexus.editorCore.modules && Nexus.editorCore.modules.bracketMatching) {
               const { bracketMatching } = Nexus.editorCore.modules;
               const newExtension = newValue ? bracketMatching() : [];
               Nexus.editorCore.view.dispatch({
                   effects: Nexus.editorCore.bracketTracingCompartment.reconfigure(newExtension)
               });

               if (newValue) {
                   const view = Nexus.editorCore.view;
                   const doc = view.state.doc.toString();
                   const near = doc.slice(0, 400).search(/[{}()\[\]]/); // nearest bracket from the top of the file — a real, visible demo, not a guess at the cursor's own position
                   if (near !== -1) {
                       view.dispatch({ selection: { anchor: near + 1 }, scrollIntoView: true });
                       const st = document.getElementById('footStatus');
                       if (st) { st.innerText = "BRACKET TRACING ON — try placing your cursor next to any { } [ ] ( )"; setTimeout(() => Nexus.UI.syncStatus(), 3000); }
                   } else {
                       const st = document.getElementById('footStatus');
                       if (st) { st.innerText = "BRACKET TRACING ON — highlights a pair whenever your cursor sits next to one"; setTimeout(() => Nexus.UI.syncStatus(), 3000); }
                   }
               }
           }

           const btn2 = document.getElementById('bracketTracingBtn');
           if (btn2) btn2.classList.toggle('btn-accent', newValue);
       },

       // Diff-as-you-type gutter toggle (Feature 4). Simpler than the
       // Compartment-reconfigure pattern above: the gutter extension is
       // always present in currentExtensions, gated purely by this
       // preference INSIDE recomputeChangeGutter() itself — flipping the
       // pref and forcing one recompute is enough, no Compartment swap
       // needed since "off" already means "recompute always yields an
       // empty RangeSet" rather than "the extension isn't loaded at all."
       toggleChangeGutter() {
           if (!Nexus.UI.needCM6('The change gutter', () => Nexus.UI.toggleChangeGutter())) return;
           const newValue = !(Nexus.state.prefs.showChangeGutter !== false);
           Nexus.state.prefs.showChangeGutter = newValue;
           Nexus.settings.update('showChangeGutter', newValue);
           if (Nexus.editorCore.refreshChangeGutter) Nexus.editorCore.refreshChangeGutter();
       },

       // Sticky scope headers toggle. Defaults ON like bracket tracing —
       // see the long comment on the compartment's setup in the boot
       // function for why.
       toggleStickyScroll() {
           if (!Nexus.editorCore.isCM6) {
               return alert("Sticky scope headers require the CM6 Engine — switch engines first (🔄 in the top bar).");
           }

           const newValue = !(Nexus.state.prefs.stickyScroll !== false);
           Nexus.state.prefs.stickyScroll = newValue;
           Nexus.settings.update('stickyScroll', newValue);

           if (Nexus.editorCore.view && Nexus.editorCore.stickyScrollCompartment && Nexus.editorCore.modules && Nexus.editorCore.modules.stickyScroll) {
               const { stickyScroll } = Nexus.editorCore.modules;
               const newExtension = newValue ? stickyScroll({ maxStickyLines: 4 }) : [];
               Nexus.editorCore.view.dispatch({
                   effects: Nexus.editorCore.stickyScrollCompartment.reconfigure(newExtension)
               });
           }

           const btn3 = document.getElementById('stickyScrollBtn');
           if (btn3) btn3.classList.toggle('btn-accent', newValue);
       },

       // Minimap toggle. Defaults OFF, unlike bracket tracing/sticky
       // scroll — a minimap is a genuinely more opinionated addition to a
       // small phone screen (it permanently claims a vertical strip of an
       // already-limited editor width) rather than a background aid, so
       // it's opt-in rather than on-by-default.
       //
       // CONFIDENCE NOTE: showMinimap's exact configuration shape (whether
       // `create` must return a bare DOM node vs. an object wrapping one,
       // valid `showOverlay` values, whether Facet.compute is required
       // around it) is asserted with meaningfully LESS confidence than
       // this session's other CM6 API calls (keymap/indentWithTab/
       // selectMatchingBracket, all extremely well-established, ubiquitous
       // exports) — @replit/codemirror-minimap is a smaller, less
       // standardized third-party package, and this sandbox has no
       // network access to import and inspect its real source directly.
       // This is written to the best of documented knowledge of its
       // public API, but treat this one specifically as needing on-device
       // confirmation before trusting it, more so than anything else
       // shipped this session.
       // Shared extension builders for minimap/lint/autocomplete — used by
       // BOTH the boot-time compartment initialization (so a saved "on"
       // preference actually restores as on, not silently reset to off on
       // every reload) and the toggle functions below, so there's exactly
       // one definition of what each feature's extension looks like rather
       // than two copies that could drift apart.
       _buildMinimapExtension() {
           const { showMinimap } = Nexus.editorCore.modules || {};
           if (!showMinimap) return [];
           return showMinimap.compute(['doc'], () => ({
               create: () => ({ dom: document.createElement('div') }),
               displayText: 'blocks'
           }));
       },
       _buildLintExtension() {
           const { linter, lintGutter } = Nexus.editorCore.modules || {};
           if (!linter) return [];
           const source = (view) => {
               const diagnostics = [];
               const fn = Nexus.state.activeFile;
               if (!fn || !fn.toLowerCase().endsWith('.js')) return diagnostics;
               try {
                   Nexus.Sentinel.initEngine();
                   const { issues } = Nexus.Sentinel.engine.analyzeAndMutate(view.state.doc.toString(), 'LINT');
                   (issues || []).forEach(issue => {
                       if (!issue.line) return;
                       const lineObj = view.state.doc.line(Math.min(issue.line, view.state.doc.lines));
                       diagnostics.push({
                           from: lineObj.from,
                           to: lineObj.to,
                           severity: issue.severity === 'error' ? 'error' : 'warning',
                           message: issue.message || 'Issue detected'
                       });
                   });
               } catch (e) { /* mid-typing syntax errors are normal — degrade to no diagnostics, same as the Hub does elsewhere */ }
               return diagnostics;
           };
           return [linter(source), lintGutter()];
       },
       _buildAutocompleteExtension() {
           const { autocompletion } = Nexus.editorCore.modules || {};
           if (!autocompletion) return [];

           // Completion from words already in the document, on top of
           // whatever the language pack provides. This is the single
           // biggest typing win on a phone: long identifiers get typed
           // once and then recalled with two or three characters, instead
           // of being retyped in full on a cramped keyboard every time.
           // Language packs alone don't do this — they only know library
           // and keyword names, never the names you invented five minutes
           // ago, which are exactly the ones worth not retyping.
           const documentWords = (context) => {
               const before = context.matchBefore(/[A-Za-z_$][\w$]*/);
               if (!before) return null;
               // Require a couple of characters unless completion was
               // asked for explicitly — on mobile an panel that appears
               // after one keystroke covers the code you're reading and
               // fights every word you type.
               if (!context.explicit && (before.to - before.from) < 2) return null;

               const typed = before.text;
               const docText = context.state.doc.toString();
               const freq = new Map();
               const re = /[A-Za-z_$][\w$]*/g;
               let m;
               while ((m = re.exec(docText))) {
                   const w = m[0];
                   if (w.length < 3) continue;      // "id", "el" etc. cost more to pick than to type
                   if (w === typed) continue;        // don't offer the word being typed back to itself
                   freq.set(w, (freq.get(w) || 0) + 1);
               }

               const lower = typed.toLowerCase();
               const options = [...freq.entries()]
                   .filter(([w]) => w.toLowerCase().startsWith(lower))
                   // Most-used first: in practice the name you want is
                   // usually the one already used most in this file.
                   .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                   .slice(0, 40) // a phone screen can't show more, and scanning a longer list is slower than typing
                   .map(([label]) => ({ label, type: 'text' }));

               if (options.length === 0) return null;
               return { from: before.from, options };
           };

           // Registered through languageData rather than `override`.
           // `override` REPLACES every completion source, which would
           // throw away the language pack's own knowledge of keywords and
           // library names — the goal here is document words IN ADDITION
           // to those, not instead of them. Falls back to override only if
           // EditorState isn't available for some reason, since having
           // document words alone still beats having none.
           const { EditorState } = Nexus.editorCore.modules || {};
           const config = {
               activateOnTyping: true,
               maxRenderedOptions: 12,   // fits a phone screen without burying the code
               icons: false,             // on a narrow screen the label matters, the icon column just costs width
               closeOnBlur: true
           };
           if (EditorState && EditorState.languageData) {
               return [
                   autocompletion(config),
                   EditorState.languageData.of(() => [{ autocomplete: documentWords }])
               ];
           }
           return autocompletion({ ...config, override: [documentWords] });
       },

       // Minimap toggle. Defaults OFF, unlike bracket tracing/sticky
       // scroll — a minimap is a genuinely more opinionated addition to a
       // small phone screen (it permanently claims a vertical strip of an
       // already-limited editor width) rather than a background aid, so
       // it's opt-in rather than on-by-default.
       //
       // CONFIDENCE NOTE: showMinimap's exact configuration shape (whether
       // `create` must return a bare DOM node vs. an object wrapping one,
       // valid `showOverlay` values, whether Facet.compute is required
       // around it) is asserted with meaningfully LESS confidence than
       // this session's other CM6 API calls (keymap/indentWithTab/
       // selectMatchingBracket, all extremely well-established, ubiquitous
       // exports) — @replit/codemirror-minimap is a smaller, less
       // standardized third-party package, and this sandbox has no
       // network access to import and inspect its real source directly.
       // This is written to the best of documented knowledge of its
       // public API, but treat this one specifically as needing on-device
       // confirmation before trusting it, more so than anything else
       // shipped this session.
       toggleMinimap() {
           if (!Nexus.UI.needCM6('The minimap', () => Nexus.UI.toggleMinimap())) return;

           const newValue = !Nexus.state.prefs.minimap;
           Nexus.state.prefs.minimap = newValue;
           Nexus.settings.update('minimap', newValue);

           if (Nexus.editorCore.view && Nexus.editorCore.minimapCompartment) {
               Nexus.editorCore.view.dispatch({
                   effects: Nexus.editorCore.minimapCompartment.reconfigure(newValue ? this._buildMinimapExtension() : [])
               });
           }

           const btn = document.getElementById('ribbonMenuMinimap');
           if (btn) btn.classList.toggle('active-toggle', newValue);
       },

       // Lint toggle. Defaults OFF — this app has its own separate,
       // extensive Diagnostics Hub (Sentinel lint suite, fuzzy scanner,
       // BracketCartographer, etc.) already covering error-surfacing;
       // adding CM6's own inline lint decorations on top, always-on, would
       // be two overlapping systems fighting for the same visual space by
       // default. Opt-in avoids that collision until the user specifically
       // wants live inline squiggles alongside the existing Hub.
       //
       // linter() takes a source function: (view) => Diagnostic[]. This
       // wires it to Sentinel's own existing JS analysis engine
       // (Nexus.Sentinel.engine.analyzeAndMutate, already used throughout
       // this file for the Diagnostics Hub) rather than inventing a
       // second, separate lint ruleset — one source of truth for "what
       // counts as an issue" in JS files, surfaced through two different
       // UIs (the Hub's cards, and now optionally CM6's own inline
       // markers) instead of two disagreeing engines.
       // Lint toggle. Defaults OFF — this app has its own separate,
       // extensive Diagnostics Hub (Sentinel lint suite, fuzzy scanner,
       // BracketCartographer, etc.) already covering error-surfacing;
       // adding CM6's own inline lint decorations on top, always-on, would
       // be two overlapping systems fighting for the same visual space by
       // default. Opt-in avoids that collision until the user specifically
       // wants live inline squiggles alongside the existing Hub.
       //
       // _buildLintExtension() wires linter()'s source function to
       // Sentinel's own existing JS analysis engine
       // (Nexus.Sentinel.engine.analyzeAndMutate, already used throughout
       // this file for the Diagnostics Hub) rather than inventing a
       // second, separate lint ruleset — one source of truth for "what
       // counts as an issue" in JS files, surfaced through two different
       // UIs (the Hub's cards, and now optionally CM6's own inline
       // markers) instead of two disagreeing engines.
       toggleLint() {
           if (!Nexus.UI.needCM6('Inline linting', () => Nexus.UI.toggleLint())) return;

           const newValue = !Nexus.state.prefs.lintEnabled;
           Nexus.state.prefs.lintEnabled = newValue;
           Nexus.settings.update('lintEnabled', newValue);

           if (Nexus.editorCore.view && Nexus.editorCore.lintCompartment) {
               Nexus.editorCore.view.dispatch({
                   effects: Nexus.editorCore.lintCompartment.reconfigure(newValue ? this._buildLintExtension() : [])
               });
           }

           const btn = document.getElementById('ribbonMenuLint');
           if (btn) btn.classList.toggle('active-toggle', newValue);
       },

       // Autocomplete toggle. Defaults OFF — a popup that appears while
       // typing is a significant behavior change (it can intercept Enter/
       // Tab, cover nearby text on a small screen) that shouldn't switch
       // on for someone without them asking for it first, unlike a purely
       // passive visual aid.
       toggleAutocomplete() {
           if (!Nexus.UI.needCM6('Autocomplete', () => Nexus.UI.toggleAutocomplete())) return;

           const newValue = !Nexus.state.prefs.autocomplete;
           Nexus.state.prefs.autocomplete = newValue;
           Nexus.settings.update('autocomplete', newValue);

           if (Nexus.editorCore.view && Nexus.editorCore.autocompleteCompartment) {
               Nexus.editorCore.view.dispatch({
                   effects: Nexus.editorCore.autocompleteCompartment.reconfigure(newValue ? this._buildAutocompleteExtension() : [])
               });
           }

           const btn = document.getElementById('ribbonMenuAutocomplete');
           if (btn) btn.classList.toggle('active-toggle', newValue);
       },

       // Top-right ribbon dropdown. Standard anchored-menu pattern: toggle
       // the .open class, and close automatically on an outside click/tap
       // so it doesn't stay stuck open and block the editor underneath it.
       // The outside-click listener is added/removed on each open/close
       // rather than left permanently attached, so it costs nothing while
       // the menu is closed (which is almost always).
       _ribbonMenuOutsideHandler: null,
       toggleRibbonMenu() {
           const dd = document.getElementById('ribbonMenuDropdown');
           if (!dd) return;
           const isOpen = dd.classList.toggle('open');

           if (isOpen) {
               this.syncRibbonMenu();
               // Deferred by one tick so the click that OPENED the menu
               // doesn't also immediately trigger this same listener and
               // close it again in the same event loop pass.
               setTimeout(() => {
                   this._ribbonMenuOutsideHandler = (e) => {
                       // Was checking against #ribbonMenuBtn — a fixed
                       // top-right button that got removed once the real
                       // trigger moved to the file tab bar's right edge.
                       // Left unfixed, this would have made clicking the
                       // ACTUAL trigger button register as an "outside"
                       // click and instantly re-close the menu it just
                       // opened, the moment ribbonMenuBtn stopped existing
                       // in the DOM to be found (querying a missing id
                       // just returns null, which is falsy, so the OR
                       // below would always fall through to menu.contains
                       // alone — close enough to work by accident for
                       // clicks on the menu itself, but never for clicks
                       // on the trigger button).
                       const btn = document.getElementById('fileTabMenuBtn');
                       const menu = document.getElementById('ribbonMenuDropdown');
                       const clickedInside = (btn && btn.contains(e.target)) || (menu && menu.contains(e.target));
                       if (!clickedInside) this.toggleRibbonMenu();
                   };
                   document.addEventListener('click', this._ribbonMenuOutsideHandler);
                   document.addEventListener('touchstart', this._ribbonMenuOutsideHandler);
               }, 0);
           } else if (this._ribbonMenuOutsideHandler) {
               document.removeEventListener('click', this._ribbonMenuOutsideHandler);
               document.removeEventListener('touchstart', this._ribbonMenuOutsideHandler);
               this._ribbonMenuOutsideHandler = null;
           }
       },

       // Updates the dropdown's checkmarks (via .active-toggle) and the
       // Edit item's icon to reflect current state — called when the menu
       // opens, and after every toggle click so the checkmark updates
       // immediately without needing to close and reopen the menu to see
       // the new state. This REPLACES the old always-visible ribbon icon
       // buttons' own visual feedback (btn-accent highlighting) for these
       // five toggles, since those buttons no longer exist in the DOM now
       // that these controls moved into the dropdown — each toggle
       // function's own direct DOM update (e.g. toggleWordWrap() setting
       // #wordWrapBtn's class) is now a harmless no-op against a
       // nonexistent element; this is the new, actually-visible source of
       // truth for their state instead.
       syncRibbonMenu() {
           const setActive = (id, isOn) => {
               const el = document.getElementById(id);
               if (el) el.classList.toggle('active-toggle', !!isOn);
           };
           setActive('ribbonMenuIndentGuides', Nexus.state.prefs.indentGuides !== false);
           setActive('ribbonMenuWordWrap', !!Nexus.state.prefs.wordWrap);
           setActive('ribbonMenuWhitespace', !!Nexus.state.prefs.showWhitespace);
           setActive('ribbonMenuBracketTracing', Nexus.state.prefs.bracketTracing !== false);
           setActive('ribbonMenuChangeGutter', Nexus.state.prefs.showChangeGutter !== false);
           setActive('ribbonMenuBookmarkingEnabled', Nexus.state.prefs.bookmarkingEnabled !== false);
           setActive('ribbonMenuStickyScroll', Nexus.state.prefs.stickyScroll !== false);
           setActive('ribbonMenuMinimap', !!Nexus.state.prefs.minimap);
           setActive('ribbonMenuLint', !!Nexus.state.prefs.lintEnabled);
           setActive('ribbonMenuAutocomplete', !!Nexus.state.prefs.autocomplete);

           // Bookmark is a per-line toggle, not a persisted preference —
           // "is this on" depends on whether the CURRENT cursor line
           // already has a bookmark, checked fresh every time the menu
           // opens. FIX: this button previously showed no state at all,
           // so there was no way to tell whether tapping it would add or
           // remove a bookmark before actually doing it — exactly the
           // "accidental bookmark" risk being avoided by having it read
           // as a toggle in the first place.
           const bmBtn = document.getElementById('ribbonMenuBookmark');
           if (bmBtn) {
               let hasBookmark = false;
               if (Nexus.editorCore.isCM6 && Nexus.editorCore.view && Nexus.editorCore.bookmarkState) {
                   const view = Nexus.editorCore.view;
                   const line = view.state.doc.lineAt(view.state.selection.main.head);
                   view.state.field(Nexus.editorCore.bookmarkState).between(line.from, line.from, () => { hasBookmark = true; });
               }
               setActive('ribbonMenuBookmark', hasBookmark);
           }

           const editIcon = document.getElementById('ribbonMenuEditIcon');
           if (editIcon) {
               const mode = Nexus.state.prefs.editMode === 'full' ? 'full' : 'util';
               editIcon.textContent = mode === 'full' ? '🔓' : '🛠️';
           }
       },

       // FIX: this toggled a 'nav-hidden' class onto the BUTTON itself,
       // but no CSS rule anywhere in the stylesheet ever targeted
       // .nav-hidden — the button visibly toggled its own class with zero
       // actual effect on #dpadContainer (the arrow keys/SEL/CTRL group
       // this button is supposed to show/hide). Toggles the real target's
       // display directly instead, the same pattern toggleKeyboardRows()
       // and toggleDpadPanel() already use elsewhere in this file for
       // identical show/hide-a-sibling-container buttons.
       toggleNavButtons() {
           const container = document.getElementById('dpadContainer');
           const navBtn = document.getElementById('navToggleBtn');
           if (!container) return;

           const isHidden = container.style.display === 'none';
           container.style.display = isHidden ? 'inline-flex' : 'none';
           if (navBtn) navBtn.classList.toggle('active', isHidden);
           Nexus.settings.update('navButtonsHidden', !isHidden);
       },

       // Multi-cursor: selects the next occurrence of the current
       // selection (or the word under the cursor if nothing's selected —
       // selectNextOccurrence's own documented behavior) and ADDS it as a
       // second simultaneous selection range rather than replacing the
       // current one. Repeated calls keep adding more. This is CM6-only —
       // there's no vanilla-textarea equivalent at all, since a plain
       // <textarea> fundamentally supports exactly one selection range;
       // multiple simultaneous cursors require CM6's EditorSelection
       // system and drawSelection (already included via basicSetup) to
       // even render as more than one visible highlighted region.
       selectNextOccurrence() {
           if (!Nexus.UI.needCM6('Multi-cursor selection', () => Nexus.UI.selectNextOccurrence())) return;
           const { selectNextOccurrence } = Nexus.editorCore.modules;
           if (typeof selectNextOccurrence !== 'function') {
               return alert("Multi-cursor selection isn't available (module failed to load).");
           }
           const applied = selectNextOccurrence(Nexus.editorCore.view);
           if (!applied) {
               const st = document.getElementById('footStatus');
               if (st) { st.innerText = "NO MORE MATCHES"; setTimeout(() => Nexus.UI.syncStatus(), 1500); }
           }
       },

       // Select EVERY occurrence at once, rather than one more per tap —
       // the more useful default on a phone screen where repeatedly
       // finding and tapping a small toolbar button is more friction than
       // on desktop with a keyboard shortcut. Implemented by calling
       // selectNextOccurrence() in a loop until the selection's range
       // count stops growing (meaning it's wrapped around or run out of
       // matches), rather than reimplementing its matching logic —
       // reuses CM6's own exact notion of "what counts as an occurrence"
       // (word-boundary-aware per its changelog) instead of risking a
       // second, subtly different definition living in this file.
       selectAllOccurrences() {
           if (!Nexus.UI.needCM6('Multi-cursor selection', () => Nexus.UI.selectAllOccurrences())) return;
           const { selectNextOccurrence } = Nexus.editorCore.modules;
           if (typeof selectNextOccurrence !== 'function') {
               return alert("Multi-cursor selection isn't available (module failed to load).");
           }
           const view = Nexus.editorCore.view;

           if (view.state.selection.main.empty) {
               return alert("Select a word or phrase first, then use this to select every other occurrence.");
           }

           let previousCount = view.state.selection.ranges.length;
           // Hard cap purely as a safety net against an unforeseen infinite
           // loop (e.g. a future CM6 version changing selectNextOccurrence's
           // wraparound behavior) — 5,000 simultaneous selection ranges is
           // already far beyond any realistic use of this feature.
           for (let i = 0; i < 5000; i++) {
               const applied = selectNextOccurrence(view);
               if (!applied) break;
               const newCount = view.state.selection.ranges.length;
               if (newCount <= previousCount) break; // wrapped back to the start
               previousCount = newCount;
           }

           const st = document.getElementById('footStatus');
           if (st) { st.innerText = `SELECTED ${previousCount} OCCURRENCE${previousCount === 1 ? '' : 'S'}`; setTimeout(() => Nexus.UI.syncStatus(), 2000); }
       },

       // Jump to matching bracket: moves the cursor to whichever bracket
       // pairs with the one immediately next to the cursor. Uses CM6's own
       // cursorMatchingBracket command directly rather than re-implementing
       // bracket-pair-finding — that command already knows exactly what
       // bracketMatching() (already active in this editor) considers a
       // match, so this stays in sync with however that's configured
       // rather than risking a second, subtly different definition of
       // "matching" living in this file.
       // "Jump to matching bracket" respects Select Lock exactly the way
       // DpadEngine.navigate() already does for every other directional
       // command in this app: Select Lock OFF moves the cursor only;
       // Select Lock ON selects a full inclusive range instead of just
       // relocating the cursor and losing the start point.
       //
       // FIX: previously used selectMatchingBracket directly, which
       // extends the selection from wherever the cursor already sits to
       // the matched position — since the cursor is normally adjacent to
       // a bracket rather than exactly on top of it, the bracket
       // characters themselves usually ended up OUTSIDE the resulting
       // selection. For HTML, bracketMatching()'s tag-matching also
       // operates at the level of individual </> tokens (confirmed by
       // testing against lang-html's own bracketMatchingHandle setup
       // referenced elsewhere in this file), so it could match one tag's
       // own opening/closing angle brackets to each other rather than an
       // opening tag to its actual closing tag — explaining "selects part
       // of the tags." Now branches by content type: HTML resolves the
       // enclosing Element syntax node and selects its exact full span
       // (both tags, inclusive, whatever the cursor's precise position);
       // everything else uses matchBrackets()'s own real bracket-position
       // data to build a selection from the first bracket's start through
       // the second bracket's end, brackets included.
       // FIX: the previous version checked for an enclosing HTML Element
       // node FIRST, before ever trying matchBrackets — which is backwards
       // and caused a real regression: since an ancestor-walk looking for
       // an Element node will always eventually find one for ANY position
       // inside an HTML file (including a JS bracket sitting inside an
       // embedded <script> tag, since that tag's own Element node is a
       // genuine ancestor of everything inside it), tapping Match Bracket
       // on a { or } inside a <script> block would incorrectly select the
       // ENTIRE surrounding <script>...</script> tag instead of matching
       // the specific bracket that was actually tapped.
       //
       // matchBrackets() already handles HTML correctly on its own —
       // lang-html registers bracketMatchingHandle specifically so tag
       // names route through the same matcher as {}/[]/() (see the
       // matchBrackets module-loading comment above for the exact
       // mechanism) — so there was never a need for a separate Element-
       // node code path at all. This tries matchBrackets FIRST, at the
       // exact cursor position and a couple of small position nudges (the
       // matcher needs the position to land ON the bracket/tag-name text,
       // not merely nearby, and the cursor is often sitting just before
       // or after it rather than exactly on it) — only if every nearby
       // position genuinely finds nothing does it fall back to selecting
       // the enclosing element, which is now the FALLBACK, not the first
       // thing tried.
       jumpToMatchingBracket() {
           if (!Nexus.UI.needCM6('Jump to matching bracket', () => Nexus.UI.jumpToMatchingBracket())) return;
           const view = Nexus.editorCore.view;
           const useSelect = !!(Nexus.DpadEngine && Nexus.DpadEngine.selectLock);
           const pos = view.state.selection.main.head;
           const { matchBrackets, cursorMatchingBracket, syntaxTree } = Nexus.editorCore.modules;

           if (typeof matchBrackets !== 'function') {
               return alert("Bracket jump isn't available (module failed to load).");
           }

           // Try the exact position first (both directions, since the
           // cursor could be just before an opening bracket/tag-name or
           // just after a closing one), then a couple of small nudges —
           // handles the common case of the cursor sitting adjacent to,
           // rather than exactly on, a tag's name text.
           let match = null;
           for (const tryPos of [pos, pos - 1, pos + 1]) {
               if (tryPos < 0 || tryPos > view.state.doc.length) continue;
               match = matchBrackets(view.state, tryPos, 1) || matchBrackets(view.state, tryPos, -1);
               if (match && match.end) break;
           }

           if (match && match.end) {
               if (useSelect) {
                   // Inclusive of both bracket characters/tag-name tokens —
                   // from the earlier one's own start to the later one's
                   // own end, regardless of which direction was searched.
                   const from = Math.min(match.start.from, match.end.from);
                   const to = Math.max(match.start.to, match.end.to);
                   view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
               } else if (typeof cursorMatchingBracket === 'function') {
                   cursorMatchingBracket(view);
               } else {
                   view.dispatch({ selection: { anchor: match.end.to }, scrollIntoView: true });
               }
               view.focus();
               return;
           }

           // Fallback: no bracket/tag-name match found at or near the
           // cursor at all (e.g. cursor is inside plain text content
           // between tags, not on any tag itself) — select the nearest
           // enclosing Element as a reasonable "whole tag" result rather
           // than just reporting failure, but only reached now as a last
           // resort, not tried before the precise match above.
           if (syntaxTree) {
               const tree = syntaxTree(view.state);
               let node = tree.resolveInner(pos, 1);
               while (node) {
                   if (node.type.name === 'Element') {
                       if (useSelect) {
                           view.dispatch({ selection: { anchor: node.from, head: node.to }, scrollIntoView: true });
                       } else {
                           view.dispatch({ selection: { anchor: node.to }, scrollIntoView: true });
                       }
                       view.focus();
                       return;
                   }
                   if (!node.parent) break;
                   node = node.parent;
               }
           }

           const st = document.getElementById('footStatus');
           if (st) { st.innerText = "NO BRACKET HERE"; setTimeout(() => Nexus.UI.syncStatus(), 1500); }
       },

       // Toggles a bookmark on the line the cursor is currently on —
       // the toolbar-button equivalent of clicking the gutter directly,
       // for when tapping a specific gutter pixel on a small screen is
       // more fiddly than just having the cursor already where you want
       // the bookmark.
       toggleBookmarkHere() {
           if (!Nexus.editorCore.isCM6 || !Nexus.editorCore.view) {
               return alert("Bookmarks require the CM6 Engine — switch engines first (🔄 in the top bar).");
           }
           // The actual enable/disable check now lives inside
           // toggleBookmarkAt() itself (editorCore's shared function,
           // near the bookmarkGutter setup) — the one real choke point
           // BOTH this button and the gutter's own direct tap handler go
           // through. Keeping a second copy of the same check here would
           // just be two messages that could quietly drift apart later.
           const view = Nexus.editorCore.view;
           const pos = view.state.selection.main.head;
           Nexus.editorCore.toggleBookmarkAt(view, pos);
       },

       // The actual enable/disable switch — a separate concept from the
       // per-line toggleBookmarkHere() above. This one is a real
       // preference, not per-line state: while off, tapping the bookmark
       // button anywhere does nothing at all, which is what "stop
       // cleaning up accidental bookmarks" needs — a button that's merely
       // less reachable still gets tapped by accident; one that's
       // genuinely inert does not.
       toggleBookmarkingEnabled() {
           const newValue = !(Nexus.state.prefs.bookmarkingEnabled !== false);
           Nexus.state.prefs.bookmarkingEnabled = newValue;
           Nexus.settings.update('bookmarkingEnabled', newValue);
       },

       // Reads the CM6 bookmark StateField's current RangeSet and mirrors
       // it into Nexus.state.bookmarks[activeFile] as plain {line, label}
       // data, then persists it. This is the bridge between CM6's live,
       // in-memory, position-based bookmark state (which resets on every
       // page reload) and this app's actual durable storage — called after
       // every toggle so the two never drift out of sync.
       _syncBookmarksFromCM6(view) {
           if (!Nexus.state.activeFile) return;
           const { bookmarkState } = Nexus.editorCore;
           if (!bookmarkState) return;

           const existing = Nexus.state.bookmarks[Nexus.state.activeFile] || [];
           const labelByLine = new Map(existing.map(b => [b.line, b.label]));

           const lines = [];
           view.state.field(bookmarkState).between(0, view.state.doc.length, (from) => {
               const lineNum = view.state.doc.lineAt(from).number;
               lines.push({ line: lineNum, label: labelByLine.get(lineNum) || '' });
           });
           lines.sort((a, b) => a.line - b.line);

           Nexus.state.bookmarks[Nexus.state.activeFile] = lines;
           safeStorage.setItem('nexus_bookmarks_v1', Nexus.state.bookmarks);

           if (document.getElementById('modalBookmarks')?.classList.contains('active')) {
               Nexus.UI.renderBookmarksList();
           }
       },

       // Applies whatever bookmarks are saved for the file CM6 just opened
       // — called from the file-switch path (see Vfs.switchFile) since
       // the gutter's StateField starts empty on every fresh EditorView
       // and has no way to know about bookmarks from a previous session
       // on its own.
       _restoreBookmarksToCM6(view, filename) {
           const { bookmarkEffect } = Nexus.editorCore;
           if (!bookmarkEffect) return;
           const saved = Nexus.state.bookmarks[filename] || [];
           if (saved.length === 0) return;

           const effects = [];
           for (const b of saved) {
               if (b.line >= 1 && b.line <= view.state.doc.lines) {
                   const line = view.state.doc.line(b.line);
                   effects.push(bookmarkEffect.of({ pos: line.from, on: true }));
               }
           }
           if (effects.length) view.dispatch({ effects });
       },

       openBookmarksPanel() {
           Nexus.UI.renderBookmarksList();
           Nexus.UI.openModal('bookmarks');
       },

       renderBookmarksList() {
           const container = document.getElementById('bookmarksList');
           if (!container) return;

           const allEntries = [];
           for (const [filename, marks] of Object.entries(Nexus.state.bookmarks)) {
               for (const b of marks) allEntries.push({ filename, ...b });
           }

           if (allEntries.length === 0) {
               container.innerHTML = '<div style="padding:20px; text-align:center; opacity:0.6; font-size:12px;">No bookmarks yet. Place your cursor on a line and use "Bookmark Here," or tap the 🔖 gutter next to any line.</div>';
               return;
           }

           container.innerHTML = allEntries.map((b, i) => `
               <div style="display:flex; align-items:center; gap:8px; background:var(--surface); padding:10px 12px; margin-bottom:6px; border-radius:8px; border-left:3px solid var(--gold);">
                   <span onclick="Nexus.UI.jumpToBookmark('${b.filename.replace(/'/g, "\\'")}', ${b.line})" style="flex:1; cursor:pointer; font-family:monospace; font-size:12px;">
                       <span style="color:var(--gold); font-weight:800;">${b.filename}</span>
                       <span style="opacity:0.6;"> : line ${b.line}</span>
                       ${b.label ? `<div style="opacity:0.8; font-size:11px; margin-top:2px;">${b.label}</div>` : ''}
                   </span>
                   <button class="dock-btn special" style="height:24px; font-size:10px; padding:0 8px; border-radius:4px;" onclick="Nexus.UI.removeBookmark('${b.filename.replace(/'/g, "\\'")}', ${b.line})">REMOVE</button>
               </div>
           `).join('');
       },

       jumpToBookmark(filename, line) {
           if (filename !== Nexus.state.activeFile) {
               Nexus.Vfs.switchFile(filename);
           }
           document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
           Nexus.UI.jumpToLine(line);
       },

       removeBookmark(filename, line) {
           const marks = Nexus.state.bookmarks[filename];
           if (!marks) return;
           Nexus.state.bookmarks[filename] = marks.filter(b => b.line !== line);
           safeStorage.setItem('nexus_bookmarks_v1', Nexus.state.bookmarks);

           // If this is the currently open file in CM6, also remove the
           // live gutter marker so the two stay in sync immediately rather
           // than only after the next toggle/reload.
           if (filename === Nexus.state.activeFile && Nexus.editorCore.isCM6 && Nexus.editorCore.view) {
               const view = Nexus.editorCore.view;
               if (line >= 1 && line <= view.state.doc.lines) {
                   const lineObj = view.state.doc.line(line);
                   view.dispatch({ effects: Nexus.editorCore.bookmarkEffect.of({ pos: lineObj.from, on: false }) });
               }
           }
           Nexus.UI.renderBookmarksList();
       },

  syncStatus() {
       const ed = document.getElementById('rawTerminal');
       const st = document.getElementById('footStatus');
       if (!ed || !st) return;
       const isReadonly = ed.hasAttribute('readonly');
       st.innerText = isReadonly ? "LOCKED" : (ed.getAttribute('inputmode') === 'none' ? "UTIL MODE" : "READY (FULL)");
       st.style.color = isReadonly ? "var(--danger)" : "var(--success)";
   },
                   updateGutter() { 
           const ed = document.getElementById('rawTerminal');
           const gutter = document.getElementById('gutter');
           if (!ed || !gutter || Nexus.editorCore.isCM6) {
               if(gutter) gutter.style.display = Nexus.editorCore.isCM6 ? 'none' : 'block';
               return;
           }

           const lines = ed.value.split('\n');
           const lineCount = lines.length;
           
           // Only re-render if the number of lines actually changed
           if (gutter.dataset.lastCount != lineCount) {
               let gutterHTML = '';
               // Pro-Tip: Cache the line numbers in a single string to reduce DOM thrashing
               for (let i = 1; i <= lineCount; i++) {
                   gutterHTML += i + '<br>';
               }
               gutter.innerHTML = gutterHTML;
               gutter.dataset.lastCount = lineCount;
           }
           gutter.scrollTop = ed.scrollTop;
       },
// Converts a tap's Y position into a line number, then hands off to the
// existing onGutterClick logic below. This was the actual missing piece —
// onGutterClick() already did the right thing, but nothing ever called it
// because the gutter's CSS (pointer-events:none) made it unreachable.
handleGutterClick(event) {
    const gutter = document.getElementById('gutter');
    const ed = document.getElementById('rawTerminal');
    if (!gutter || !ed) return;
    const lineHeight = 22, topPadding = 15;
    const rect = gutter.getBoundingClientRect();
    const relativeY = (event.clientY - rect.top) - topPadding + gutter.scrollTop;
    const lineCount = ed.value.split('\n').length;
    const lineNumber = Math.min(lineCount, Math.max(1, Math.floor(relativeY / lineHeight) + 1));
    this.onGutterClick(lineNumber);
},
// Inside your gutter click handler
onGutterClick(lineNumber) {
    // 1. Ensure Select Mode is on (don't use toggleSelectLock() directly here,
    // since that would turn it OFF if it's already on — this needs "force on")
    if (!Nexus.DpadEngine.selectLock) Nexus.DpadEngine.toggleSelectLock();
    
    // 2. Select the whole line
    const lines = editor.value.split('\n');
    let startPos = 0;
    for(let i = 0; i < lineNumber - 1; i++) {
        startPos += lines[i].length + 1; // +1 for the newline
    }
    const endPos = startPos + lines[lineNumber - 1].length;
    
    editor.setSelectionRange(startPos, endPos);
    editor.focus();
},

// The missing piece behind "tools tell you things are wrong but don't let
// Lightweight variant of jumpToLine() built specifically for the scrub
// gesture, which can fire dozens of times per second during a drag.
// jumpToLine() itself calls view.focus() and closes any open panel/modal
// on every call — both fine for a single deliberate jump, but wasteful
// (and, for focus(), potentially disruptive to the drag gesture itself via
// mobile keyboard show/hide) when repeated continuously. This skips both,
// and for the vanilla textarea engine caches the line-offset table for the
// current drag instead of re-splitting the entire document on every move
// event — meaningful on files in the tens of thousands of lines, which is
// exactly the case this feature is for.
_scrubLineOffsets: null,

scrubJumpToLine(lineNumber) {
    if (Nexus.editorCore.isCM6 && Nexus.editorCore.view) {
        const view = Nexus.editorCore.view;
        const doc = view.state.doc;
        const clampedLine = Math.min(Math.max(1, lineNumber), doc.lines);
        const line = doc.line(clampedLine);
        view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
        return;
    }

    const ed = document.getElementById('rawTerminal');
    if (!ed) return;

    if (!this._scrubLineOffsets) {
        const lines = ed.value.split('\n');
        const offsets = new Array(lines.length);
        let acc = 0;
        for (let i = 0; i < lines.length; i++) {
            offsets[i] = acc;
            acc += lines[i].length + 1;
        }
        this._scrubLineOffsets = offsets;
    }

    const clampedLine = Math.min(Math.max(1, lineNumber), this._scrubLineOffsets.length);
    const startPos = this._scrubLineOffsets[clampedLine - 1];
    ed.setSelectionRange(startPos, startPos);
    ed.scrollTop = Math.max(0, (clampedLine - 1) * 22 - ed.clientHeight / 2);
},

// you jump to them": this was referenced from several places (search for
// "jumpToLine") behind a defensive typeof-guard, but never actually
// implemented — so every one of those call sites silently did nothing.
jumpToLine(lineNumber, colNumber) {
    if (!lineNumber || lineNumber < 1) return;

    // Close anything covering the editor so the jump is actually visible —
    // panel-right and panel-terminal both render full-width over it.
    const rightPanel = document.getElementById('panelRight');
    if (rightPanel) rightPanel.classList.remove('open');
    const terminalPanel = document.getElementById('panelTerminal');
    if (terminalPanel) terminalPanel.classList.remove('open');
    document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));

    if (Nexus.editorCore.isCM6 && Nexus.editorCore.view) {
        const view = Nexus.editorCore.view;
        const doc = view.state.doc;
        const clampedLine = Math.min(Math.max(1, lineNumber), doc.lines);
        const line = doc.line(clampedLine);
        const pos = colNumber ? Math.min(line.from + colNumber - 1, line.to) : line.from;
        view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
        view.focus();
        return;
    }

    const ed = document.getElementById('rawTerminal');
    if (!ed) return;
    const lines = ed.value.split('\n');
    const clampedLine = Math.min(Math.max(1, lineNumber), lines.length);
    let startPos = 0;
    for (let i = 0; i < clampedLine - 1; i++) startPos += lines[i].length + 1;
    if (colNumber) startPos += Math.min(Math.max(0, colNumber - 1), lines[clampedLine - 1].length);
    ed.focus();
    ed.setSelectionRange(startPos, startPos);
    // Textareas have no native scroll-to-position API — estimate using the
    // fixed 22px line-height from #rawTerminal's own CSS and center the
    // target line in the visible area.
    ed.scrollTop = Math.max(0, (clampedLine - 1) * 22 - ed.clientHeight / 2);
},

// Copies every log line and tutor "explain" card currently in the sandbox
// LOGS tab as plain text, in the order they appear (oldest first, since
// that's the natural reading order top-to-bottom — matches what's on
// screen, not reversed). Uses each entry's own .innerText rather than
// .textContent (which would squash the tutor cards' headers/paragraphs
// together with no line breaks) or raw .innerHTML (unreadable — full of
// tags), so a card like "Why it matters: ... How to think about fixing
// it: ..." copies out exactly as readable as it looks on screen.
copyLogsToClipboard() {
    const console = document.getElementById('ghostConsole');
    if (!console || console.children.length === 0) {
        return alert("No logs to copy yet — run the sandbox first.");
    }
    const text = Array.from(console.children)
        .map(el => (el.innerText || '').trim())
        .filter(Boolean)
        .join('\n\n');

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
            Nexus.shell.out('📋 Logs copied to clipboard.', 'success');
        }).catch(() => {
            alert("Clipboard access was denied — long-press the logs to copy manually.");
        });
    } else {
        alert("Clipboard API isn't available here — long-press the logs to copy manually.");
    }
},

    segSandbox(name) {
        const order = ['test', 'opts', 'network', 'element', 'logs'];
        document.querySelectorAll('.sandbox-nav .seg-btn').forEach((b, i) => b.classList.toggle('active', order[i] === name));
        const targetId = 'sb' + name.charAt(0).toUpperCase() + name.slice(1);
        document.querySelectorAll('.sb-page').forEach(p => p.classList.toggle('active', p.id === targetId));
    },
    runSandbox() { 
   const f = document.getElementById('sandboxFrame');
   const c = document.getElementById('ghostConsole'); 
   if(!f || !c) return; 
   
   c.innerHTML = ""; 
   // Fresh preview run = fresh network log and element pick — entries from
   // a previous run of a different (or even the same) file would be
   // actively misleading sitting next to a new run's results.
   Nexus.networkMonitor.clear();
   Nexus.elementInspector.lastPicked = null;
   Nexus.elementInspector.render();

   // 1. Memory Management: Revoke old Blob URLs to prevent Pixel 7 memory leaks
   if (this.sandboxBlobs) {
       this.sandboxBlobs.forEach(url => URL.revokeObjectURL(url));
   }
   this.sandboxBlobs = [];

   if(!Nexus.state.activeFile) {
       c.innerHTML = "<div style='color:var(--danger)'>&gt; Error: No active sector found in the Vortex.</div>";
       return;
   }
   
   // 2. Map the entire Vfs to temporary Blob URLs.
   // MIME types matter here: a blob served as text/plain won't execute as a
   // module, won't apply as a stylesheet, and won't render as an image, so
   // every type the sandbox might reference needs a correct one — not just
   // the three code types. Images/fonts/JSON referenced from HTML (icons,
   // manifests, assets) previously all fell through to text/plain and
   // silently failed to load.
   const MIME = {
       js: 'application/javascript', mjs: 'application/javascript',
       css: 'text/css', html: 'text/html', htm: 'text/html',
       json: 'application/json', webmanifest: 'application/manifest+json',
       svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
       jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
       ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2',
       ttf: 'font/ttf', otf: 'font/otf', txt: 'text/plain', md: 'text/markdown'
   };
   const VfsMap = {};
   Object.entries(Nexus.state.Vfs).forEach(([name, content]) => {
       const ext = name.split('.').pop().toLowerCase();
       const type = MIME[ext] || 'text/plain';
       const blob = new Blob([content], { type });
       const url = URL.createObjectURL(blob);
       VfsMap[name] = url;
       this.sandboxBlobs.push(url);
   });

   // Resolve a referenced path against the Vfs, tolerating the ways the
   // same file gets written in real projects: "app.js", "./app.js",
   // "/app.js", and "js/app.js" when only "app.js" exists (and vice
   // versa). Returns the real Vfs key, or null.
   const resolveRef = (ref) => {
       if (!ref) return null;
       const clean = ref.split('?')[0].split('#')[0].replace(/^\.\//, '').replace(/^\//, '');
       if (Nexus.state.Vfs[clean] !== undefined) return clean;
       const base = clean.split('/').pop();
       return Object.keys(Nexus.state.Vfs).find(k => k === base || k.endsWith('/' + base)) || null;
   };

   // 3. Virtualization: re-route any local reference to its Blob URL.
   // Now resolution-aware (via resolveRef) instead of only matching exact
   // filenames, so "js/app.js" style paths resolve too.
   // FIX (this is why running divIDE inside its own sandbox broke
   // completely): this used to rewrite EVERY quoted string that happened
   // to match a project filename — not just paths in src/href/import
   // positions, but ordinary string data anywhere in the code. In this
   // very app that silently corrupted 12 literals: comparisons like
   // `fn === 'index.html'`, MIME-map keys, GitHub path arguments. The
   // running code then compared against blob: URLs instead of filenames
   // and quietly did nothing, with no error to point at.
   //
   // Rewriting is now scoped to the positions that are genuinely paths:
   // src=/href= attributes in markup, and module specifiers in import
   // statements. A bare string in application logic is left alone.
   const virtualizeHtmlAttrs = (code) => {
       return code.replace(/\b(src|href)\s*=\s*(['"])([^'"\n]+?)\2/gi, (whole, attr, q, ref) => {
           if (/^(?:https?:|data:|blob:|#|mailto:|tel:)/i.test(ref)) return whole;
           const hit = resolveRef(ref);
           return hit ? `${attr}=${q}${VfsMap[hit]}${q}` : whole;
       });
   };

   // CSS path positions are url(...) and @import specifically — a bare
   // string elsewhere in a stylesheet (a content: value, a font-family
   // name) must not be rewritten.
   const virtualizeCssUrls = (code) => {
       return code
           .replace(/url\(\s*(['"]?)([^'")\n]+?)\1\s*\)/gi, (whole, q, ref) => {
               if (/^(?:https?:|data:|blob:|#)/i.test(ref)) return whole;
               const hit = resolveRef(ref);
               return hit ? `url(${q}${VfsMap[hit]}${q})` : whole;
           })
           .replace(/(@import\s+)(['"])([^'"\n]+?)\2/gi, (whole, head, q, ref) => {
               if (/^(?:https?:|data:|blob:)/i.test(ref)) return whole;
               const hit = resolveRef(ref);
               return hit ? `${head}${q}${VfsMap[hit]}${q}` : whole;
           });
   };

   const virtualizeJsImports = (code) => {
       // static:  import x from './y.js'   /  import './y.js'
       // dynamic: import('./y.js')
       return code
           .replace(/(\bimport\s+(?:[^'"();]*?\sfrom\s+)?)(['"])([^'"\n]+?)\2/g, (whole, head, q, ref) => {
               if (/^(?:https?:|data:|blob:)/i.test(ref)) return whole;
               const hit = resolveRef(ref);
               return hit ? `${head}${q}${VfsMap[hit]}${q}` : whole;
           })
           .replace(/(\bimport\s*\(\s*)(['"])([^'"\n]+?)\2/g, (whole, head, q, ref) => {
               if (/^(?:https?:|data:|blob:)/i.test(ref)) return whole;
               const hit = resolveRef(ref);
               return hit ? `${head}${q}${VfsMap[hit]}${q}` : whole;
           });
   };

   // Inline a CSS file's contents, recursively resolving its own @import
   // statements against the project. Without this, a stylesheet that
   // itself @imports another project file left that nested import pointing
   // at an unresolvable relative path — the imported rules silently never
   // applied. Depth-capped and cycle-guarded so a self-referencing or
   // mutually-importing pair can't spin forever.
   const inlineCss = (cssName, seen = new Set()) => {
       if (seen.has(cssName) || seen.size > 20) return '';
       seen.add(cssName);
       let css = Nexus.state.Vfs[cssName] || '';
       css = css.replace(/@import\s+(?:url\(\s*)?['"]?([^'")\s;]+)['"]?\s*\)?\s*;/gi, (whole, ref) => {
           if (/^(?:https?:|data:)/i.test(ref)) return whole; // leave real remote imports alone
           const hit = resolveRef(ref);
           return hit ? `\n/* inlined: ${hit} */\n` + inlineCss(hit, seen) : whole;
       });
       return css;
   };

   // 5. Entry-point resolution: "Play" means run the PROJECT. If the file
   // being edited isn't HTML but the project has an HTML page, assemble and
   // run that page (index.html preferred) — running a bare .js file against
   // an empty document just crashes on its first getElementById. Projects
   // with no HTML at all keep the isolated JS/CSS preview below.
   let entryFile = Nexus.state.activeFile;
   let entryExt = entryFile.split('.').pop().toLowerCase();
   if (entryExt !== 'html') {
       const htmlFiles = Object.keys(Nexus.state.Vfs).filter(f => f.toLowerCase().endsWith('.html'));
       if (htmlFiles.length > 0) {
           entryFile = htmlFiles.find(f => f.toLowerCase() === 'index.html' || f.toLowerCase().endsWith('/index.html')) || htmlFiles[0];
           entryExt = 'html';
           c.innerHTML += `<div style='color:var(--accent); padding:4px 8px; font-size:11px; font-family:monospace;'>&gt; Assembled project via ${entryFile}</div>`;
       }
   }
   const activeCode = Nexus.state.Vfs[entryFile] || "";
   const activeExt = entryExt;
// 4. The Diagnostic Interceptor (Hardened against parent syntax bleeding)
const inj = "<scr" + "ipt>\n" +
    "const send = (msg, col) => {\n" +
        "const d = document.createElement('div');\n" +
        "d.style.cssText = 'color:' + col + '; padding:4px 8px; border-bottom:1px solid rgba(255,255,255,0.05); font-family:monospace; font-size:11px;';\n" +
        "d.innerText = \"> \" + msg;\n" +
        "const container = window.parent.document.getElementById('ghostConsole');\n" +
        "if(container) { container.appendChild(d); d.scrollIntoView({ behavior: 'smooth' }); }\n" +
    "};\n" +
    "console.log = (...args) => send(args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' '), '#3fb950');\n" +
    "console.error = (...args) => send('[ERR] ' + args.join(' '), '#f85149');\n" +
    // Network monitor (Feature 1): intercepts BOTH fetch() and
    // XMLHttpRequest — real projects use either or both — and reports
    // method/url/status/duration/size back to the parent via the same
    // window.parent bridge everything else here already uses. Wrapping
    // fetch() has to preserve its exact Promise-returning contract (the
    // user's own .then()/await on the ORIGINAL call must still work
    // exactly as if this wrapper wasn't here) — timing and reporting
    // happen as side effects around the real call, never by replacing
    // what it resolves/rejects with.
    "(function(){\n" +
        "const send2 = (entry) => { try { window.parent.Nexus.networkMonitor._record(entry); } catch(e) {} };\n" +
        "const realFetch = window.fetch ? window.fetch.bind(window) : null;\n" +
        "if (realFetch) {\n" +
            "window.fetch = function(input, init) {\n" +
                "const start = performance.now();\n" +
                "const url = typeof input === 'string' ? input : (input && input.url) || String(input);\n" +
                "const method = (init && init.method) || (input && input.method) || 'GET';\n" +
                "return realFetch(input, init).then((res) => {\n" +
                    "const dur = performance.now() - start;\n" +
                    "res.clone().text().then((body) => {\n" +
                        "send2({ kind: 'fetch', method, url, status: res.status, ok: res.ok, duration: dur, size: body.length });\n" +
                    "}).catch(() => send2({ kind: 'fetch', method, url, status: res.status, ok: res.ok, duration: dur, size: null }));\n" +
                    "return res;\n" +
                "}).catch((err) => {\n" +
                    "send2({ kind: 'fetch', method, url, status: 0, ok: false, duration: performance.now() - start, error: String(err && err.message || err) });\n" +
                    "throw err;\n" +
                "});\n" +
            "};\n" +
        "}\n" +
        "const RealXHR = window.XMLHttpRequest;\n" +
        "if (RealXHR) {\n" +
            "window.XMLHttpRequest = function() {\n" +
                "const xhr = new RealXHR();\n" +
                "let _method = 'GET', _url = '', _start = 0;\n" +
                "const realOpen = xhr.open.bind(xhr);\n" +
                "xhr.open = function(method, url, ...rest) { _method = method; _url = url; return realOpen(method, url, ...rest); };\n" +
                "const realSend = xhr.send.bind(xhr);\n" +
                "xhr.send = function(...args) {\n" +
                    "_start = performance.now();\n" +
                    "xhr.addEventListener('loadend', () => {\n" +
                        "send2({ kind: 'xhr', method: _method, url: _url, status: xhr.status, ok: xhr.status >= 200 && xhr.status < 400, duration: performance.now() - _start, size: (xhr.responseText || '').length });\n" +
                    "});\n" +
                    "return realSend(...args);\n" +
                "};\n" +
                "return xhr;\n" +
            "};\n" +
        "}\n" +
    "})();\n" +
    // Element inspector (Feature 2): a single delegated click listener,
    // only active while Nexus.elementInspector.active is true (toggled
    // from the parent app) — checked at click time via the same
    // window.parent bridge, so the listener can stay attached for the
    // life of the preview without doing anything when the tool is off.
    // Walks up from event.target to the nearest element with an id or
    // class if the exact tapped node has neither, since "what did I tap"
    // on a deeply nested layout is usually more useful one level up than
    // the literal leaf text node's parent span.
    "document.addEventListener('click', function(e) {\n" +
        "let active = false;\n" +
        "try { active = window.parent.Nexus.elementInspector.active; } catch(err) {}\n" +
        "if (!active) return;\n" +
        "e.preventDefault(); e.stopPropagation();\n" +
        "let el = e.target;\n" +
        "const cs = getComputedStyle(el);\n" +
        "const r = el.getBoundingClientRect();\n" +
        "const info = {\n" +
            "tag: el.tagName.toLowerCase(), id: el.id || null,\n" +
            "classes: el.className && typeof el.className === 'string' ? el.className.split(/\\s+/).filter(Boolean) : [],\n" +
            "text: (el.textContent || '').trim().slice(0, 60),\n" +
            "rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },\n" +
            "styles: {\n" +
                "fontSize: cs.fontSize, color: cs.color, background: cs.backgroundColor,\n" +
                "padding: cs.padding, margin: cs.margin, display: cs.display,\n" +
                "position: cs.position, flexDirection: cs.flexDirection, overflow: cs.overflow\n" +
            "}\n" +
        "};\n" +
        "try { window.parent.Nexus.elementInspector._record(info); } catch(err) {}\n" +
    "}, true);\n" +
    // Service workers cannot register from a srcdoc iframe — the document
    // has an opaque origin, so the browser rejects it unconditionally. For
    // a PWA that means every single preview run would throw a confusing
    // SecurityError that looks like a bug in the user's own code. Shim it
    // to report clearly what happened instead, so the rest of the app
    // still previews normally rather than dying at the registration call.
    "if (navigator.serviceWorker) {\n" +
        "try {\n" +
            "Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {\n" +
                "register: () => { send('[sandbox] serviceWorker.register() skipped — service workers cannot run in a preview frame. Your real deployment is unaffected.', '#d29922'); return Promise.resolve({ scope: '(sandbox)', update(){}, unregister(){ return Promise.resolve(true); } }); },\n" +
                "getRegistration: () => Promise.resolve(undefined),\n" +
                "getRegistrations: () => Promise.resolve([]),\n" +
                "addEventListener: () => {}, removeEventListener: () => {}, controller: null, ready: new Promise(() => {})\n" +
            "} });\n" +
        "} catch (swErr) {}\n" +
    "}\n" +
    "window.onerror = (msg, url, ln, col, err) => {\n" +
        "send('Crash at line ' + ln + ': ' + msg, '#f85149');\n" +
        "try {\n" +
            "const explain = window.parent.Nexus.tutor.explainRuntimeError(msg);\n" +
            "if (explain) {\n" +
                "const card = document.createElement('div');\n" +
                "card.innerHTML = window.parent.Nexus.tutor.renderExplainCard(explain);\n" +
                "const container = window.parent.document.getElementById('ghostConsole');\n" +
                "if (container) { container.appendChild(card); card.scrollIntoView({ behavior: 'smooth' }); }\n" +
            "}\n" +
        "} catch (tutorErr) {}\n" +
        "return false;\n" +
    "};\n" +
"</scr" + "ipt>\n";

   // 6. Final Assembly & Injection
   if (activeExt === 'html') {
       let htmlCode = activeCode;

       // Inline locally-referenced <link rel="stylesheet"> and <script src>
       // rather than rewriting them to blob: URLs — this guarantees they
       // actually apply, without depending on how a given browser handles
       // blob: fetches from inside a srcdoc document.
       //
       // Three real multi-file bugs fixed here, all found by running an
       // actual PWA project through this:
       //   1. type="module" was DROPPED when inlining a script — the old
       //      pattern only captured attributes around `src` and rebuilt the
       //      tag without them in the right place, so any module script
       //      became a classic script and every `import` inside it became
       //      an instant syntax error.
       //   2. An inlined script's OWN imports were never resolved, so a
       //      dependency chain (index.html -> app.js -> helper.js) silently
       //      lost everything past the first hop — helper.js never appeared
       //      in the output at all.
       //   3. Nested @import inside an inlined stylesheet was left pointing
       //      at an unresolvable relative path.
       Object.keys(VfsMap).forEach(filename => {
           if (filename === entryFile) return; // don't inline the file into itself
           const ext = filename.split('.').pop().toLowerCase();
           const escapedName = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
           const pathPat = `(?:\\.\\/|\\/)?${escapedName}`;

           if (ext === 'css') {
               const linkRe = new RegExp(`<link\\b[^>]*href=(['"])${pathPat}\\1[^>]*>`, 'gi');
               htmlCode = htmlCode.replace(linkRe, () => `<style>\n${inlineCss(filename)}\n</style>`);
           } else if (ext === 'js' || ext === 'mjs') {
               // Capture the whole tag so every attribute (type="module",
               // defer, async) survives; only `src` is stripped out.
               const scriptRe = new RegExp(`<script\\b([^>]*?)\\ssrc=(['"])${pathPat}\\2([^>]*)>\\s*<\\/script>`, 'gi');
               htmlCode = htmlCode.replace(scriptRe, (m, before, q, after) => {
                   const attrs = `${before || ''}${after || ''}`.replace(/\s+/g, ' ').trim();
                   // Resolve this script's own imports to blob URLs so its
                   // dependencies load instead of dying on a bare path.
                   const body = virtualizeJsImports(Nexus.state.Vfs[filename] || '')
                       .replace(/<\/script>/gi, '<\\/script>');
                   return `<script${attrs ? ' ' + attrs : ''}>\n${body}\n<\/script>`;
               });
           }
       });

       // Any remaining local references (images, icons, manifest, fonts,
       // fetch() targets, and scripts/styles whose tags didn't match the
       // inline patterns above) get rewritten to their blob URLs, so they
       // resolve instead of 404ing against a srcdoc document that has no
       // real base URL at all.
       htmlCode = virtualizeHtmlAttrs(htmlCode);

       // Inject the console interceptor without disturbing doctype-first
       // ordering: prepending it before <!DOCTYPE html> makes the browser
       // ignore the doctype entirely and render the preview in quirks mode.
       if (/<head[\s>]/i.test(htmlCode)) {
           htmlCode = htmlCode.replace(/<head([^>]*)>/i, `<head$1>\n${inj}`);
       } else if (/<body[\s>]/i.test(htmlCode)) {
           htmlCode = htmlCode.replace(/<body([^>]*)>/i, `<body$1>\n${inj}`);
       } else if (/<html[\s>]/i.test(htmlCode)) {
           htmlCode = htmlCode.replace(/<html([^>]*)>/i, `<html$1>\n${inj}`);
       } else {
           htmlCode = inj + htmlCode; // bare fragment with no doctype — safe to prepend
       }
       f.srcdoc = htmlCode;
   } else if (activeExt === 'js') {
       const virtualJS = virtualizeJsImports(activeCode).replace(/<\/script>/gi, '<\\/script>'); 
       f.srcdoc = inj + '<scr'+'ipt type="module">\n' + virtualJS + '\n</scr'+'ipt>'; 
   } else if (activeExt === 'css') {
       const virtualCSS = virtualizeCssUrls(activeCode);
       f.srcdoc = inj + `<style>${virtualCSS}</style><div style="padding:20px; color:#666;">Previewing CSS: ${Nexus.state.activeFile}</div>`;
   }
},

    
       async exportZIP() { 
           const status = document.getElementById('footStatus'); 
           status.innerText = "ARCHIVING..."; 
           try { 
               const zip = new JSZip(); 
               const folder = zip.folder("Nexus_Project"); 
               
               Object.entries(Nexus.state.Vfs).forEach(([f, c]) => {
                   folder.file(f, c);
               });

               const content = await zip.generateAsync({ type: "blob" }); 
               const a = document.createElement('a'); 
               a.href = URL.createObjectURL(content); 
               a.download = `Nexus_v40_Bundle.zip`; 
               a.click(); 

               status.innerText = "EXPORTED"; 
               setTimeout(() => { status.innerText = "READY"; }, 3000); 
           } catch (e) { 
               alert("Export Fault: " + e.message); 
               status.innerText = "FAULT"; 
           } 
       },
toggleDrawer(id) {
    // Close other drawers automatically so they don't overlap.
    document.querySelectorAll('.transform-drawer').forEach(el => {
        if (el.id !== id) el.classList.remove('open');
    });
    const target = document.getElementById(id);
    if (!target) return;
    const opening = !target.classList.contains('open');
    target.classList.toggle('open');
    // Defensive: an inline style.display set by some other code path (this
    // exact bug happened once already — see the widgets registry comment
    // in Nexus.state — where updateWidgets() stamped display:none directly
    // onto searchDrawer/writerDrawer, which beat every .transform-drawer
    // CSS rule regardless of specificity and left them permanently hidden
    // even while .open was correctly applied) would silently defeat the
    // class-based show/hide this function is supposed to own. Clearing any
    // inline display on open guarantees the stylesheet rule is what
    // decides visibility, not whatever inline style happened to be left
    // over from elsewhere.
    if (opening) target.style.display = '';
},
// (Removed: toggleRibbonDpad() — dead code nothing called. It was also the
// only place setupFastHold() ever ran, which is why the dock's arrow buttons
// never worked; setupFastHold is now wired unconditionally at boot.)
openSuggestions() {
    // Clear previous filter and prepopulate the list
    const filterInput = document.getElementById('suggestFilter');
    if (filterInput) filterInput.value = '';
    
    this.populateSuggestions('');
    this.toggleDrawer('suggestionsDrawer');
},

populateSuggestions(filterTerm) {
    const list = document.getElementById('suggestList');
    if (!list) return;

    const term = (filterTerm || '').toLowerCase();
    let items = [];
    
    // 1. Pull dynamic snippets from the Sovereign Vault
    if (Nexus.state && Nexus.state.vault) {
        Nexus.state.vault.forEach(v => {
            items.push({ label: `💾 ${v.name}`, code: v.code });
        });
    }
    
    // 2. Add high-velocity standard templates (using your *# cursor logic)
    const standardSnippets = [
        { label: "⚡ console.log", code: "console.log(*#);" },
        { label: "⚡ document.getElementById", code: "document.getElementById('*#')" },
        { label: "⚡ querySelector", code: "document.querySelector('*#')" },
        { label: "⚡ async function", code: "async function *#() {\n\t\n}" },
        { label: "⚡ arrow function", code: "const *# = () => {\n\t\n};" },
        { label: "⚡ event listener", code: "addEventListener('*#', (e) => {\n\t\n});" },
        { label: "⚡ try / catch", code: "try {\n\t*#\n} catch (err) {\n\tconsole.error(err);\n}" },
        { label: "⚡ div tag", code: "<div>*#</div>" },
        { label: "⚡ span tag", code: "<span>*#</span>" }
    ];
    
    items = items.concat(standardSnippets);
    
    // 3. Filter based on user input
    if (term) {
        items = items.filter(i => 
            i.label.toLowerCase().includes(term) || 
            i.code.toLowerCase().includes(term)
        );
    }
    
    // 4. Render to DOM
    if (items.length === 0) {
        list.innerHTML = `<div style="color:var(--text); opacity:0.5; font-size:11px; text-align:center; padding:10px;">No matches found.</div>`;
        return;
    }
    
    // Notice we encode the code block slightly to prevent HTML breakout in the onclick handler
    list.innerHTML = items.map(item => {
        const safeLabel = item.label.replace(/</g, '&lt;');
        const safePreview = item.code.replace(/</g, '&lt;').replace(/\n/g, ' ');
        const escapeQuotes = item.code.replace(/'/g, "\\'").replace(/"/g, '&quot;').replace(/\n/g, '\\n').replace(/\t/g, '\\t');

        return `
            <button class="sleek-btn" style="justify-content:flex-start; text-align:left; flex-direction:column; align-items:flex-start; background:var(--bg); border:1px solid var(--border); padding:10px;" 
                    onclick="Nexus.UI.injectSuggestion('${escapeQuotes}')">
                <span style="color:var(--accent); font-weight:bold; font-size:11px;">${safeLabel}</span>
                <span style="font-size:9px; color:var(--text); opacity:0.6; font-family:monospace; margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; width:100%;">
                    ${safePreview}
                </span>
            </button>
        `;
    }).join('');
},

injectSuggestion(codePayload) {
    // 1. Close the drawer to return focus to the editor
    this.toggleDrawer('suggestionsDrawer');
    
    // 2. Decode the newline and tab characters back to raw strings
    const formattedCode = codePayload.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    
    // 3. Route through your existing injection engine so it processes the *# cursor offset
    this.injectChar(formattedCode);
},

             async nuke() { 
           if (!confirm("☢ FACTORY RESET: All files and settings will be permanently erased. Proceed?")) return;

           try {
               await localforage.clear();
           } catch (e) {
               console.error("Nuke: localforage clear failed", e);
           }

           // Also clear the Cache Storage API and unregister any service
           // workers, in case this file is ever hosted alongside one (e.g. a
           // PWA-forged export served from the same origin) — a plain
           // localforage.clear() + reload could otherwise still serve a
           // stale cached copy instead of actually starting fresh.
           try {
               if ('caches' in window) {
                   const keys = await caches.keys();
                   await Promise.all(keys.map(k => caches.delete(k)));
               }
           } catch (e) {
               console.error("Nuke: cache clear failed", e);
           }
           try {
               if ('serviceWorker' in navigator) {
                   const regs = await navigator.serviceWorker.getRegistrations();
                   await Promise.all(regs.map(r => r.unregister()));
               }
           } catch (e) {
               console.error("Nuke: service worker unregister failed", e);
           }

           // Cache-busting reload: a plain location.reload() can still be
           // served from the browser's HTTP cache. Appending a fresh query
           // param forces a real network fetch of the current page.
           const url = new URL(location.href);
           url.searchParams.set('_nuked', Date.now());
           location.href = url.toString();
       }
   } // Closes the "UI" object literal
};// Closes the "window.Nexus" object literal

/* --- GLOBAL LISTENERS & ENGINE HOOKS --- */

const editor = document.getElementById('rawTerminal');
const gutter = document.getElementById('gutter');
let saveDelayTimer = null;
let visualResetTimer = null; // New timer to prevent race conditions
let editorTouchStart = 0;
let longPressTimer;

// FIX (diagonal scroll drift): touch-action's own CSS values (manipulation,
// pan-x, pan-y, pan-x pan-y) can only allow or disallow WHOLE axes — there
// is no touch-action value in the spec that means "allow both, but lock to
// whichever direction the gesture actually starts in." That's why setting
// touch-action alone couldn't fix this: any value that keeps both vertical
// AND horizontal scrolling working at all (needed for long files / long
// unwrapped lines respectively) also permits scrolling diagonally at the
// same time, with no way to constrain it further from CSS. Real axis
// locking needs to detect the gesture's dominant direction in JS and then
// suppress the other axis for the rest of that same touch, which this
// does via toggling overflow-x/overflow-y rather than calling
// preventDefault() + manually driving scrollLeft/scrollTop — overflow
// toggling lets the browser's own native scroll/momentum physics keep
// handling the actual scrolling, so this doesn't introduce any jank or
// lose momentum scrolling to get the lock.
function lockScrollAxis(el) {
    if (!el || el._axisLockWired) return;
    el._axisLockWired = true;

    let startX = 0, startY = 0, locked = null;
    const THRESHOLD = 8; // px of movement before committing to an axis — avoids locking on jitter from a near-stationary touch

    el.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return; // pinch-zoom etc. — leave multi-touch alone entirely
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        locked = null;
    }, { passive: true });

    el.addEventListener('touchmove', (e) => {
        if (e.touches.length !== 1) return;
        if (locked) return; // already committed for this gesture — nothing more to decide
        const dx = Math.abs(e.touches[0].clientX - startX);
        const dy = Math.abs(e.touches[0].clientY - startY);
        if (dx < THRESHOLD && dy < THRESHOLD) return; // not enough movement yet to tell direction

        locked = dx > dy ? 'x' : 'y';
        // Suppress the OTHER axis for the rest of this gesture by
        // collapsing its overflow — the browser then has nothing to
        // scroll on that axis, which is what actually stops diagonal
        // drift without touching the axis that's supposed to keep moving.
        el.style.overflowX = locked === 'x' ? 'auto' : 'hidden';
        el.style.overflowY = locked === 'y' ? 'auto' : 'hidden';
    }, { passive: true });

    const release = () => {
        locked = null;
        // Restore both axes once the touch ends, so the NEXT gesture (or
        // a mouse wheel, or a keyboard-driven scroll) isn't left
        // permanently locked to whatever direction the last touch happened
        // to be.
        el.style.overflowX = '';
        el.style.overflowY = '';
    };
    el.addEventListener('touchend', release, { passive: true });
    el.addEventListener('touchcancel', release, { passive: true });
}

lockScrollAxis(editor);
// CM6's real scrolling element is view.scrollDOM, not the outer container
// (#cm6Container itself doesn't scroll — CM6 renders its own internal
// .cm-scroller and that's what actually has overflow:auto) — wired
// whenever the CM6 view exists, called again after every engine swap
// since a fresh view means a fresh scrollDOM element to wire.
function wireCM6ScrollLock() {
    if (Nexus.editorCore && Nexus.editorCore.view && Nexus.editorCore.view.scrollDOM) {
        lockScrollAxis(Nexus.editorCore.view.scrollDOM);
    }
}
wireCM6ScrollLock();

editor.addEventListener('touchstart', (e) => {
    // Give the browser a split second to update cursor position from the touch
    setTimeout(() => {
        editorTouchStart = editor.selectionStart;
        
        longPressTimer = setTimeout(() => {
            // Long press detected (600ms)
            Nexus.TextSelectionEngine.expandSelectionFrom(editorTouchStart);
        }, 600);
    }, 50);
});

editor.addEventListener('touchend', () => clearTimeout(longPressTimer));
editor.addEventListener('touchmove', () => clearTimeout(longPressTimer));

// Mobile smart-quote/autocorrect detector (see Nexus.pasteGuard). Wired to
// both editor surfaces: the plain textarea, and the CM6 container (paste
// events bubble up through CM6's editable DOM to its wrapping div, so this
// catches it without needing a CodeMirror-specific extension).
editor.addEventListener('paste', (e) => Nexus.pasteGuard.handlePaste(e));
const cm6ContainerForPaste = document.getElementById('cm6Container');
if (cm6ContainerForPaste) cm6ContainerForPaste.addEventListener('paste', (e) => Nexus.pasteGuard.handlePaste(e));

// The Engine logic
Nexus.TextSelectionEngine = {
    expandSelectionFrom(pos) {
        const text = editor.value;
        
        // 1. Auto-turn on Select Mode
        Nexus.DpadEngine.selectLock = true;
        document.getElementById('ribbonSelectBtn').classList.add('active');
        
        // 2. Use BracketCartographer (or simple regex) to find boundaries
        // Let's assume we are selecting between nearest curly braces or tags
        let start = pos;
        let end = pos;
        
        // Walk backwards to find opening { or <
        while(start > 0 && !/[{<]/.test(text[start])) { start--; }
        
        // Walk forwards to find closing } or >
        while(end < text.length && !/[}>]/.test(text[end])) { end++; }
        
        if (start >= 0 && end < text.length) {
            editor.setSelectionRange(start, end + 1);
            navigator.vibrate(50); // Haptic feedback on successful long-press
        }
    }
};
// Gutter Logic
editor.onscroll = () => { gutter.scrollTop = editor.scrollTop; };

editor.oninput = () => { 
   if(!Nexus.state.activeFile) return;
   Nexus.state.Vfs[Nexus.state.activeFile] = editor.value; 
   Nexus.UI.updateGutter(); 
   Nexus.Sentinel.pulse(); 
   
   const st = document.getElementById('footStatus');
   st.innerText = "SAVING...";
   st.style.color = "var(--gold)";
   
   clearTimeout(saveDelayTimer);
   clearTimeout(visualResetTimer); // Kill any pending visual resets if typing resumes
   
   saveDelayTimer = setTimeout(() => {
       Nexus.Vfs.save(); 
       st.innerText = "SAVED";
       st.style.color = "var(--success)";
       
       visualResetTimer = setTimeout(() => {
           if(!editor.hasAttribute('readonly')) {
               st.innerText = editor.getAttribute('inputmode') === 'none' ? "UTIL MODE" : "READY (FULL)";
               st.style.color = ""; // Reset to default CSS text color to fix the color bleed
           } else {
               st.innerText = "LOCKED";
               st.style.color = "var(--danger)";
           }
       }, 1000);
   }, 1200);
};

editor.onkeydown = (e) => { 
   if (e.key === 'Tab') { 
       e.preventDefault(); 
       // FIX (unreliable Insert Tab / inconsistent with the ribbon button):
       // this used to insert N literal spaces (tabWidth-controlled) via its
       // own separate execCommand call, while the dedicated ribbon button
       // (injectChar('\t')) inserts one real tab character via direct
       // value splicing — two different code paths producing two different
       // characters for what's supposed to be the same action, depending
       // on which one you happened to use. Routing both through the exact
       // same injectChar() call means there is now exactly one definition
       // of "what Insert Tab does" for this engine, not two that can drift
       // apart. The old comment here said execCommand was needed to
       // "preserve Undo/Redo" — but injectChar() already calls
       // Nexus.history.record() itself (this app's own 50-entry undo
       // stack, not the browser's native one), so nothing is actually lost
       // by switching to direct value splicing; the vanilla engine's undo
       // was never relying on native execCommand history to begin with.
       // injectChar() also re-checks the lock state itself, so the
       // readonly return here is a redundant-but-harmless fast bailout.
       if (editor.hasAttribute('readonly')) return;
       Nexus.UI.injectChar('\t');
       return;
   } 

   // Auto-closing brackets/quotes — CM6 mode already has this via its
   // basicSetup bundle (closeBrackets() ships in it by default); vanilla
   // mode had nothing, making it a strictly worse typing experience for
   // exactly the same editor. This brings the two engines to parity.
   if (!editor.hasAttribute('readonly')) Nexus.tools.handleAutoClose(e, editor);
};
const backdrop = document.getElementById('highlightBackdrop');

// Sync scroll exactly
editor.addEventListener('scroll', () => {
    if (backdrop) backdrop.scrollTop = editor.scrollTop;
});

// The Highlight Engine
document.addEventListener('selectionchange', () => {
    if(document.activeElement !== editor || !backdrop) return;
    
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const len = end - start;
    
    // Only trigger if selecting a word (2 to 50 chars)
    if (len > 1 && len < 50) {
        const word = editor.value.substring(start, end);
        
        // Ensure it's alphanumeric (no weird space highlighting)
        if (/^\w+$/.test(word)) { 
            const safeWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`\\b${safeWord}\\b`, 'g');
            
            // Escape HTML in the terminal to match rendering
            const escapedText = editor.value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            
            backdrop.innerHTML = escapedText.replace(regex, `<mark>${word}</mark>`);
            backdrop.scrollTop = editor.scrollTop; // Force scroll sync
            return;
        }
    }
    
    // Clear highlights if no word selected
    if (backdrop.innerHTML !== '') backdrop.innerHTML = '';
});
// Initialize namespace hooks if not present
if (!window.Nexus) window.Nexus = {};
// insertText and moveCursor are attached below as the real implementation.
Nexus.actions = {};

// (Removed: a third, redundant .dpad-arrow click listener used to live here.
// It checked for a Nexus.DpadEngine.move() method that was never defined
// anywhere in the app, so its "else" fallback — a crude left/right-only
// caret shift with no Up/Down support — ran on every single tap, on top of
// whatever setupFastHold()'s pointerdown handler had already done. D-pad
// input is now handled exclusively by DpadEngine.setupFastHold().)


// High-Efficiency Character Insertion (Dual-Engine Compatible)
Nexus.actions.insertText = (text) => {
    if (!Nexus.state.activeFile) return;

    // --- CM6 ENGINE ROUTING ---
    if (Nexus.editorCore && Nexus.editorCore.isCM6 && Nexus.editorCore.view) {
        const view = Nexus.editorCore.view;
        const mainSel = view.state.selection.main;
        view.dispatch({
            changes: { from: mainSel.from, to: mainSel.to, insert: text },
            selection: { anchor: mainSel.from + text.length },
            scrollIntoView: true
        });
        view.focus();
        return;
    }

    // --- VANILLA TEXTAREA ROUTING ---
    const ed = document.getElementById('rawTerminal');
    if (!ed || ed.hasAttribute('readonly')) return;

    const start = ed.selectionStart;
    const end = ed.selectionEnd;
    const value = ed.value;

    ed.value = value.substring(0, start) + text + value.substring(end);
    ed.selectionStart = ed.selectionEnd = start + text.length;
    
    // Sync to Virtual File System
    if (Nexus.state && Nexus.state.Vfs) {
        Nexus.state.Vfs[Nexus.state.activeFile] = ed.value;
    }
    
    ed.focus();
    if (typeof updateCursorPos === 'function') updateCursorPos();
};

// Tooldeck D-Pad Cursor Adjustments
Nexus.actions.moveCursor = (direction) => {
    // Delegates entirely to DpadEngine.navigate() — the previous version
    // reimplemented movement here separately, with Up/Down calling a
    // jumpRelative() that was never defined anywhere (silently doing
    // nothing), and Left/Right not respecting selectLock/lineLock/ctrlLock
    // the way the real d-pad does. One correct, well-tested implementation
    // instead of two drifting-apart ones.
    Nexus.DpadEngine.navigate(direction);
    if (typeof updateCursorPos === 'function') updateCursorPos();
};

const updateCursorPos = () => {
   const footPos = document.getElementById('footPos');
   const ed = document.getElementById('rawTerminal');
   
   if (!footPos || !ed) return; // Exit early if elements aren't ready
   
   if (!Nexus.state.activeFile || !ed.value) {
       footPos.innerText = "LN 1, COL 1";
       return;
   }
   const pos = ed.selectionStart;
   const lines = ed.value.substring(0, pos).split('\n');
   footPos.innerText = `LN ${lines.length}, COL ${lines[lines.length - 1].length + 1}`;
};

window.addEventListener('DOMContentLoaded', async () => { 

    // 0. Force-update shortcut (long-press app icon -> "Force Update", or
    // manually visiting ?action=force-update). Runs before anything else
    // boots — if the person is here because the app seemed stuck on an
    // old version, there's no point spending time initializing that same
    // old code first. Nukes every cache layer this app touches and does a
    // real network-bypassing reload:
    //   1. Tells the active service worker to drop its cache (uses the
    //      CLEAR_CACHE message type sw.js already listens for).
    //   2. ALSO clears caches directly via the Cache API as a
    //      belt-and-suspenders — if the service worker itself is the
    //      stale part (an old sw.js still controlling the page), relying
    //      only on messaging it might just ask the old code to clear the
    //      old cache under the old rules, which may not be enough if the
    //      cache key/logic itself changed between versions.
    //   3. Unregisters the service worker entirely so the next load
    //      re-registers whatever the fresh sw.js actually is, rather than
    //      keeping the old worker instance alive.
    //   4. Reloads with cache-bypass. location.reload() alone can still
    //      be satisfied from HTTP cache in some browsers even after step
    //      1-3; appending a cache-busting query param forces a genuinely
    //      new network request for index.html itself.
    if (new URLSearchParams(location.search).get('action') === 'force-update') {
        try {
            if ('serviceWorker' in navigator) {
                const reg = await navigator.serviceWorker.getRegistration();
                if (reg && reg.active) {
                    reg.active.postMessage({ type: 'CLEAR_CACHE' });
                }
                if ('caches' in window) {
                    const keys = await caches.keys();
                    await Promise.all(keys.map(k => caches.delete(k)));
                }
                if (reg) await reg.unregister();
            } else if ('caches' in window) {
                const keys = await caches.keys();
                await Promise.all(keys.map(k => caches.delete(k)));
            }
        } catch (e) {
            console.error("Force-update cache clear failed:", e);
            // Still attempt the reload below even if cache clearing partly
            // failed — a plain reload is strictly better than getting
            // stuck on this action forever.
        }
        location.replace(location.pathname + '?_fresh=' + Date.now());
        return; // don't fall through into a normal boot of the (possibly stale) code that's still running right now
    }
    
    // 1. Structural Sanity Check
    if (typeof Nexus === 'undefined') {
        console.error("VORTEX CRITICAL: The global 'Nexus' object is completely undefined! Check for syntax errors at the top of your file.");
        return;
    }
    
    if (!Nexus.UI) {
        console.error("VORTEX CRITICAL: 'Nexus.UI' is undefined! There is likely a missing comma or broken brace right above your UI: { ... } block.");
        return;
    }

    try {
        // 2. Safe execution of the UI Boot sequence
        await Nexus.UI.boot(); 

        // Wipe VFS shortcut (long-press app icon -> "Wipe Project", or
        // manually visiting ?action=wipe-vfs). Deliberately handled HERE —
        // after boot, not alongside force-update's own early-exit check
        // above — because a full project wipe genuinely needs Nexus.Vfs/
        // Nexus.state to exist and be populated first; force-update
        // intentionally skips booting at all, so the two can't share a
        // spot. Reuses Vfs.clearAll() rather than duplicating its wipe
        // logic — that function already carries its own confirm() gate,
        // which matters MORE here than from the in-app button: a
        // shortcut fires with zero context (no prior screen, no "are you
        // sure you meant this project" signal), so the very first thing
        // the person sees after tapping it is the confirmation prompt
        // itself, not an already-wiped project.
        if (new URLSearchParams(location.search).get('action') === 'wipe-vfs') {
            if (Nexus.Vfs && typeof Nexus.Vfs.clearAll === 'function') {
                Nexus.Vfs.clearAll();
            }
            // Strip the query param regardless of whether the confirm was
            // accepted or declined, so a later reload/re-launch of the app
            // from this same tab doesn't silently re-trigger the prompt.
            history.replaceState(null, '', location.pathname);
        }

        // File Handling API safety net: if the launchQueue consumer (set
        // up in <head>, before Nexus.pwa existed) already fired and
        // stashed files on Nexus._pendingLaunchFiles, drain them now that
        // Nexus.pwa/Vfs are guaranteed to exist. Normally the head
        // consumer's own call to consumeLaunchFiles already handles this;
        // this only matters on the rare timing where launchQueue's
        // consumer runs before this handler finishes attaching.
        if (Nexus._pendingLaunchFiles && Nexus.pwa && typeof Nexus.pwa.consumeLaunchFiles === 'function') {
            Nexus.pwa.consumeLaunchFiles();
        }
        
        // 3. Safely bind listeners after everything successfully initialised
        const ed = document.getElementById('rawTerminal');
        if (ed) {
            ed.addEventListener('keyup', updateCursorPos);
            ed.addEventListener('click', updateCursorPos);
            ed.addEventListener('input', updateCursorPos);

            // Autosave: the CM6 engine already persists on every keystroke via its
            // updateListener, but the vanilla textarea fallback had no equivalent,
            // so edits typed there were silently lost on file switch / reload.
            let autosaveTimer = null;
            ed.addEventListener('input', () => {
                if (ed.hasAttribute('readonly') || !Nexus.state.activeFile) return;
                Nexus.state.Vfs[Nexus.state.activeFile] = ed.value;
                clearTimeout(autosaveTimer);
                autosaveTimer = setTimeout(() => Nexus.Vfs.save(), 400);
            });

        }
    } catch (bootError) {
        console.error("VORTEX BOOT FAILURE EXCEPTION:", bootError);
    }
});


