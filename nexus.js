/* =============================================================================
   FILE: nexus.js (DevOS Nexus Prime Ultimate)
   CORE VERSION: 6.0.0
   TOTAL SCALE: ~800 Lines
   ============================================================================= */

/**
 * CORE ARCHITECTURE:
 * DevOS Nexus Prime is a high-performance PWA IDE designed for mobile development.
 * This file manages the VFS, CodeMirror 6 (CM6), Programmatic Scrolling,
 * PeerJS Synchronization, and Hardware Integration.
 */

// --- 1. THE PROGRAMMATIC SCROLL ENGINE ---
/**
 * Bypasses browser touch-engine limitations by interacting directly with
 * the CodeMirror 6 ScrollDOM. Ensures precision navigation even on high-scale.
 */
const ScrollEngine = {
    jump(lines) {
        // Target the popup if open, otherwise default to main view
        const view = Nexus.state.popupCm || Nexus.state.cm;
        if (!view) return;

        const scroller = view.scrollDOM;
        const content = view.contentDOM;
        
        // Calculate dynamic line height based on current computed styles
        const computedStyle = window.getComputedStyle(content);
        const lineHeight = parseFloat(computedStyle.lineHeight) || 18;
        
        if (lines === 'TOP') {
            scroller.scrollTo({ top: 0, behavior: 'smooth' });
            Nexus.log("Scrolled to Top", "var(--accent)");
        } else if (lines === 'BOTTOM') {
            scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
            Nexus.log("Scrolled to End", "var(--accent)");
        } else {
            scroller.scrollBy({ top: lines * lineHeight, behavior: 'smooth' });
        }

        // Hardware Feedback
        if (Nexus.state.config.haptics && window.navigator.vibrate) {
            window.navigator.vibrate(20);
        }
    }
};

// --- 2. BACKEND SYSTEMS (VFS & CLOUD) ---

const System = {
    async nuke() {
        const check = confirm("DANGER: This will permanently erase ALL files, history, branches, and settings. Proceed?");
        if (!check) return;

        Nexus.log("Nuking system storage...", "var(--danger)");
        await localforage.clear();
        
        const cacheKeys = await caches.keys();
        for (let key of cacheKeys) {
            await caches.delete(key);
        }
        
        Nexus.log("System wiped. Reloading...", "var(--gold)");
        setTimeout(() => window.location.reload(), 1000);
    },

    generatePWA() {
        Nexus.log("Synthesizing PWA Manifest...", "var(--gold)");
        const manifest = {
            name: "DevOS Custom App",
            short_name: "App",
            display: "standalone",
            start_url: "./index.html",
            background_color: "#0d1117",
            theme_color: "#d29922",
            icons: [{ "src": "icon.png", "sizes": "512x512", "type": "image/png" }]
        };
        
        const sw = `
const CACHE = 'app-cache-v1';
const ASSETS = ['./index.html', './manifest.json'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))));
self.addEventListener('fetch', e => e.respondWith(caches.match(e.request).then(res => res || fetch(e.request))));
        `.trim();

        Nexus.state.vfs['manifest.json'] = JSON.stringify(manifest, null, 2);
        Nexus.state.vfs['sw.js'] = sw;
        
        Nexus.save();
        Nexus.renderAll();
        Nexus.log("PWA Assets Generated Successfully.", "var(--success)");
    }
};

const Vault = {
    compile() {
        Nexus.log("Initiating Production Build...", 'var(--gold)');
        
        const bundle = Object.entries(Nexus.state.vfs)
            .map(([name, content]) => {
                const ext = name.split('.').pop();
                return `/* --- FILE: ${name} --- */\n${content}\n`;
            }).join('\n');

        const blob = new Blob([bundle], { type: 'text/javascript' });
        Nexus.download(blob, 'devos-production-bundle.js');
        Nexus.log("Build Complete. Bundle Downloaded.", 'var(--success)');
    }
};

const NexusHistory = {
    history: {}, 
    limit: 50,

    async init() {
        this.history = await localforage.getItem('nexus_history') || {};
    },

    async takeSnapshot(filename, code) {
        if (!this.history[filename]) this.history[filename] = [];
        
        const snapshots = this.history[filename];
        const last = snapshots[snapshots.length - 1];

        // Only save if the code has actually changed
        if (last && last.code === code) return;

        snapshots.push({
            ts: Date.now(),
            code: code
        });

        if (snapshots.length > this.limit) snapshots.shift();
        
        await localforage.setItem('nexus_history', this.history);
    },

    restore(filename, timestamp) {
        const snap = this.history[filename].find(h => h.ts === timestamp);
        if (snap) {
            Nexus.state.vfs[filename] = snap.code;
            Nexus.save();
            Nexus.openFile(filename);
            Nexus.log(`Restored ${filename} to snapshot: ${new Date(timestamp).toLocaleTimeString()}`, "var(--success)");
        }
    }
};

const NexusSync = {
    peer: null,
    conn: null,

    init() {
        if (typeof Peer === 'undefined') {
            return Nexus.log("PeerJS library not detected.", 'var(--danger)');
        }

        const deviceId = 'nexus-' + Math.floor(Math.random() * 10000);
        this.peer = new Peer(deviceId);

        this.peer.on('open', (id) => {
            Nexus.log(`Sync Server Online. ID: ${id}`, 'var(--accent)');
        });

        this.peer.on('connection', (connection) => {
            this.conn = connection;
            this.setupListeners();
            Nexus.log("LINK ESTABLISHED: Remote Input Active", 'var(--success)');
        });

        this.peer.on('error', (err) => {
            Nexus.log(`Sync Error: ${err.type}`, 'var(--danger)');
        });
    },

    connectTo(remoteId) {
        if (!this.peer) return;
        this.conn = this.peer.connect(remoteId);
        this.setupListeners();
    },

    setupListeners() {
        this.conn.on('data', (data) => {
            if (data.type === 'KEYSTROKE') {
                Nexus.type(data.value, true);
            }
        });
        
        this.conn.on('close', () => {
            Nexus.log("Sync Connection Lost.", "var(--warn)");
            this.conn = null;
        });
    },

    sendKeystroke(key) {
        if (this.conn && this.conn.open) {
            this.conn.send({ type: 'KEYSTROKE', value: key });
        }
    }
};

// --- 3. THE MAIN NEXUS ENGINE ---

const Nexus = {
    state: {
        vfs: {},
        active: 'index.html',
        tabs: [],
        cm: null,
        popupCm: null,
        languageConf: null,
        branchesData: {},
        currentBranch: 'main',
        config: {
            haptics: true,
            scale: 1,
            termHeight: 180,
            gesturesEnabled: true,
            kbEnabled: true,
            kb: ['{', '}', '(', ')', ';', '=>', '&&', '||', '!', '=', '$', '_', '.', ',', '+', '-', '*', '/', '<', '>']
        }
    },

    /**
     * BOOT SEQUENCE
     * Initializes storage, UI properties, and CodeMirror environment.
     */
    async boot() {
        Nexus.log("System Booting...", "var(--gold)");
        localforage.config({ name: 'Nexus_Prime_V6' });

        // Load Virtual File System
        this.state.vfs = await localforage.getItem('vfs') || {
            'index.html': '<!DOCTYPE html>\n<html>\n<head>\n<title>DevOS App</title>\n</head>\n<body>\n  <h1>Hello Nexus</h1>\n</body>\n</html>',
            'main.js': '// Logic goes here\nconsole.log("Nexus Prime Online");',
            'styles.css': 'body { background: #0d1117; color: #c9d1d9; font-family: sans-serif; }'
        };

        // Load Configuration
        const savedConfig = await localforage.getItem('config');
        if (savedConfig) this.state.config = { ...this.state.config, ...savedConfig };

        // Load Branch Data
        this.state.branchesData = await localforage.getItem('nexus_branches') || { 'main': { ...this.state.vfs } };
        this.state.currentBranch = await localforage.getItem('nexus_active_branch') || 'main';

        await NexusHistory.init();
        this.applyUIProperties();
        
        // --- 1. INITIALIZE PILLAR ---
        this.initScrollPillar();

        // --- 2. INITIALIZE EDITOR ---
        if (!window.CM6) {
            await new Promise(r => window.addEventListener('cm6-ready', r));
        }

        this.initEditor(this.state.vfs['index.html'] || '');
        this.initResizer();
        this.initGestures();
        this.initImporter();
        this.initTerm();

        // --- 3. UI RENDER ---
        this.renderAll();
        this.openFile('index.html');
        
        Nexus.log("Engine Online. All modules initialized.", "var(--success)");
    },

    initEditor(initialContent) {
        const editorArea = document.querySelector('.editor-area');
        editorArea.innerHTML = '';

        this.state.languageConf = new window.CM6.Compartment();

        // Core Update Listener for Auto-Save
        const updateListener = window.CM6.EditorView.updateListener.of((update) => {
            if (update.docChanged && !this.state.popupCm) {
                const code = update.state.doc.toString();
                this.state.vfs[this.state.active] = code;
                NexusHistory.takeSnapshot(this.state.active, code);
            }
        });

        this.state.cm = new window.CM6.EditorView({
            state: window.CM6.EditorState.create({
                doc: initialContent,
                extensions: [
                    window.CM6.basicSetup,
                    window.CM6.oneDark,
                    this.state.languageConf.of(window.CM6.html()),
                    updateListener,
                    window.CM6.EditorView.lineWrapping
                ]
            }),
            parent: editorArea
        });
    },

    // --- MAXIMIZE EDITOR (MODAL SYSTEM) ---
    /**
     * Spawns a dedicated high-priority modal with a secondary CM6 instance.
     * This bypasses the main layout constraints to allow full-screen focus.
     */
    maximizeEditor() {
        const filename = this.state.active;
        const content = this.state.vfs[filename] || '';

        const modalHTML = `
            <div class="editor-modal-overlay" id="nexus-editor-modal">
                <div class="editor-popup-window">
                    <div class="editor-popup-header">
                        <span style="color:var(--accent); font-weight:bold; font-size:12px;">EDITOR MAXIMIZED: ${filename}</span>
                        <div style="display:flex; gap:8px;">
                            <button class="tool-btn" onclick="Nexus.formatCode()">FORMAT</button>
                            <button class="tool-btn btn-gold" onclick="Nexus.closePopupEditor()">SAVE & CLOSE [X]</button>
                        </div>
                    </div>
                    <div class="editor-popup-body" id="popup-editor-target"></div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHTML);

        // Initialize the Popup Editor Instance
        this.state.popupCm = new window.CM6.EditorView({
            state: window.CM6.EditorState.create({
                doc: content,
                extensions: [
                    window.CM6.basicSetup,
                    window.CM6.oneDark,
                    window.CM6.EditorView.lineWrapping,
                    this.state.languageConf.of(window.CM6.javascript())
                ]
            }),
            parent: document.getElementById('popup-editor-target')
        });

        // Set Language based on filename
        const ext = filename.split('.').pop().toLowerCase();
        let langExt = window.CM6.javascript();
        if (ext === 'html') langExt = window.CM6.html();
        else if (ext === 'css') langExt = window.CM6.css();
        
        this.state.popupCm.dispatch({
            effects: this.state.languageConf.reconfigure(langExt)
        });

        // Force measurement to ensure internal scrolling is calculated
        setTimeout(() => {
            if (this.state.popupCm) this.state.popupCm.requestMeasure();
        }, 100);
    },

    closePopupEditor() {
        if (this.state.popupCm) {
            const newCode = this.state.popupCm.state.doc.toString();
            this.state.vfs[this.state.active] = newCode;
            this.save();
            this.openFile(this.state.active);
        }
        const modal = document.getElementById('nexus-editor-modal');
        if (modal) modal.remove();
        this.state.popupCm = null;
        Nexus.log("Popup Session Closed. Sync complete.", "var(--accent)");
    },

    // --- PROGRAMMATIC SCROLL PILLAR ---
    /**
     * Injects the Scroll Pillar UI. This bar allows programmatic scrolling
     * which is much more reliable than native touch for virtual lists.
     */
    initScrollPillar() {
        const existing = document.querySelector('.scroll-pillar');
        if (existing) existing.remove();

        const pillar = document.createElement('div');
        pillar.className = 'scroll-pillar';

        const buttons = [
            { label: 'TOP', val: 'TOP' },
            { label: '▲ 100', val: -100 },
            { label: '▲ 25', val: -25 },
            { label: '▲ 5', val: -5 },
            { label: '▼ 5', val: 5 },
            { label: '▼ 25', val: 25 },
            { label: '▼ 100', val: 100 },
            { label: 'END', val: 'BOTTOM' }
        ];

        buttons.forEach(cfg => {
            const btn = document.createElement('button');
            btn.className = 'scroll-btn';
            btn.innerText = cfg.label;
            btn.onclick = () => ScrollEngine.jump(cfg.val);
            pillar.appendChild(btn);
        });

        document.body.appendChild(pillar);
    },

    // --- CORE IO & VFS ---

    async save() {
        await localforage.setItem('vfs', this.state.vfs);
        await localforage.setItem('config', this.state.config);
    },

    openFile(filename) {
        this.state.active = filename;
        if (!this.state.tabs.includes(filename)) this.state.tabs.push(filename);

        const content = this.state.vfs[filename] || '';

        if (this.state.cm) {
            const ext = filename.split('.').pop().toLowerCase();
            let langExt = window.CM6.javascript();
            if (ext === 'html') langExt = window.CM6.html();
            else if (ext === 'css') langExt = window.CM6.css();

            this.state.cm.dispatch({
                changes: { from: 0, to: this.state.cm.state.doc.length, insert: String(content) },
                effects: this.state.languageConf.reconfigure(langExt)
            });
        }

        this.renderAll();
        // UI cleanup for mobile
        if (window.innerWidth < 1024) {
            const sb = document.getElementById('sidebar');
            if (sb) sb.classList.remove('active');
        }
    },

    type(val, fromSync = false) {
        // CONTEXT-AWARE: Typing always targets the visible editor
        const activeView = this.state.popupCm || this.state.cm;
        if (!activeView) return;

        const cursor = activeView.state.selection.main.head;

        if (val === 'BACKSPACE') {
            if (cursor > 0) {
                activeView.dispatch({
                    changes: { from: cursor - 1, to: cursor, insert: "" }
                });
            }
        } else {
            activeView.dispatch({
                changes: { from: cursor, insert: val },
                selection: { anchor: cursor + val.length }
            });
        }

        if (this.state.config.haptics && window.navigator.vibrate) window.navigator.vibrate(40);
        if (!fromSync && NexusSync.conn) NexusSync.sendKeystroke(val);
    },

    // --- UI MODULES & HELPERS ---

    applyUIProperties() {
        document.documentElement.style.setProperty('--ui-scale', this.state.config.scale);
        document.documentElement.style.setProperty('--term-height', this.state.config.termHeight + 'px');
        
        const editorArea = document.querySelector('.editor-area');
        if (editorArea) {
            editorArea.style.paddingRight = "45px"; // Make room for Scroll Pillar
        }
    },

    toggleSidebar() {
        const sb = document.getElementById('sidebar');
        if (sb) sb.classList.toggle('active');
    },

    initResizer() {
        const resizer = document.getElementById('resizer');
        if (!resizer) return;

        let startY, startHeight;

        const onDown = (e) => {
            startY = e.touches ? e.touches[0].clientY : e.clientY;
            startHeight = this.state.config.termHeight;

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onUp);
        };

        const onMove = (e) => {
            const currentY = e.touches ? e.touches[0].clientY : e.clientY;
            const delta = startY - currentY;
            const newHeight = Math.max(80, Math.min(window.innerHeight * 0.8, startHeight + delta));
            
            this.state.config.termHeight = newHeight;
            this.applyUIProperties();
            
            // Force CodeMirror to measure its new box
            if (this.state.cm) this.state.cm.requestMeasure();
        };

        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onUp);
            this.save();
        };

        resizer.addEventListener('mousedown', onDown);
        resizer.addEventListener('touchstart', onDown);
    },

    initGestures() {
        let initialDist = 0;
        let initialScale = 1;
        const toast = document.getElementById('scale-toast');

        window.addEventListener('touchstart', (e) => {
            if (!this.state.config.gesturesEnabled) return;
            if (e.touches.length === 2) {
                initialDist = Math.hypot(
                    e.touches[0].pageX - e.touches[1].pageX,
                    e.touches[0].pageY - e.touches[1].pageY
                );
                initialScale = this.state.config.scale;
            }
        }, { passive: false });

        window.addEventListener('touchmove', (e) => {
            if (!this.state.config.gesturesEnabled || e.touches.length !== 2) return;
            e.preventDefault();

            const currentDist = Math.hypot(
                e.touches[0].pageX - e.touches[1].pageX,
                e.touches[0].pageY - e.touches[1].pageY
            );
            const factor = currentDist / initialDist;
            const newScale = Math.max(0.6, Math.min(2.0, initialScale * factor));

            this.state.config.scale = parseFloat(newScale.toFixed(2));
            this.applyUIProperties();

            if (toast) {
                toast.innerText = Math.round(this.state.config.scale * 100) + '%';
                toast.style.opacity = '1';
            }
        }, { passive: false });

        window.addEventListener('touchend', () => {
            if (toast) setTimeout(() => toast.style.opacity = '0', 800);
            this.save();
        });
    },

    // --- FILE OPERATIONS ---

    createFile() {
        const name = prompt("Enter file name (e.g., component.js):");
        if (name && !this.state.vfs[name]) {
            this.state.vfs[name] = "";
            this.save();
            this.openFile(name);
        }
    },

    deleteFile(name) {
        if (confirm(`Are you sure you want to delete ${name}?`)) {
            delete this.state.vfs[name];
            this.state.tabs = this.state.tabs.filter(t => t !== name);
            this.save();
            this.renderAll();
            if (this.state.active === name) this.openFile(this.state.tabs[0] || 'index.html');
        }
    },

    initImporter() {
        const input = document.getElementById('import-input');
        if (!input) return;

        input.onchange = async (e) => {
            const files = e.target.files;
            if (!files.length) return;

            for (let file of files) {
                if (file.name.endsWith('.zip')) {
                    const zip = await JSZip.loadAsync(file);
                    for (let path in zip.files) {
                        if (!zip.files[path].dir) {
                            this.state.vfs[zip.files[path].name] = await zip.files[path].async("string");
                        }
                    }
                    this.log(`Extracted ZIP: ${file.name}`, "var(--success)");
                } else {
                    const content = await file.text();
                    this.state.vfs[file.name] = content;
                }
            }
            this.save();
            this.renderAll();
            input.value = "";
        };
    },

    // --- TERMINAL ENGINE ---

    initTerm() {
        const input = document.getElementById('term-in');
        if (!input) return;

        input.onkeydown = (e) => {
            if (e.key === 'Enter') {
                const val = input.value;
                if (val) {
                    this.log(`> ${val}`, "white");
                    this.processCommand(val);
                    input.value = "";
                }
            }
        };
    },

    log(msg, color = "var(--text)") {
        const out = document.getElementById('term-out');
        if (!out) return;

        const entry = document.createElement('div');
        entry.style.color = color;
        entry.style.marginBottom = "4px";
        entry.innerText = msg;
        
        out.appendChild(entry);
        out.scrollTop = out.scrollHeight;
    },

    processCommand(cmd) {
        const raw = cmd.trim();
        const low = raw.toLowerCase();

        if (low.startsWith('=')) {
            try {
                const result = math.evaluate(raw.substring(1));
                this.log(`RESULT: ${result}`, "var(--success)");
            } catch (e) {
                this.log("Evaluation Error", "var(--danger)");
            }
        } 
        else if (low === 'clear') {
            document.getElementById('term-out').innerHTML = "";
        }
        else if (low === 'nuke') System.nuke();
        else if (low === 'pwa') System.generatePWA();
        else if (low === 'build') Vault.compile();
        else if (low === 'sync') NexusSync.init();
        else if (low === 'help') {
            this.log("COMMANDS: clear, pwa, build, nuke, sync, help, = (math)", "var(--gold)");
        }
        else {
            this.log(`Unknown command: ${low}`, "var(--danger)");
        }
    },

    // --- RENDERING PIPELINE ---

    renderAll() {
        this.renderTabs();
        this.renderExplorer();
    },

    renderTabs() {
        const bar = document.getElementById('tabs');
        if (!bar) return;

        bar.innerHTML = "";
        this.state.tabs.forEach(tab => {
            const div = document.createElement('div');
            div.className = `tab ${tab === this.state.active ? 'active' : ''}`;
            div.innerHTML = `
                ${tab} 
                <span class="close-tab" onclick="event.stopPropagation(); Nexus.closeTab('${tab}')">✕</span>
            `;
            div.onclick = () => this.openFile(tab);
            bar.appendChild(div);
        });
    },

    closeTab(tab) {
        this.state.tabs = this.state.tabs.filter(t => t !== tab);
        if (this.state.active === tab) {
            this.openFile(this.state.tabs[0] || 'index.html');
        } else {
            this.renderTabs();
        }
    },

    renderExplorer() {
        const list = document.getElementById('explorer');
        if (!list) return;

        list.innerHTML = "";
        Object.keys(this.state.vfs).sort().forEach(file => {
            const div = document.createElement('div');
            div.className = `list-entry ${file === this.state.active ? 'active' : ''}`;
            div.innerHTML = `
                <span>📄 ${file}</span>
                <span class="del-file" onclick="event.stopPropagation(); Nexus.deleteFile('${file}')">🗑</span>
            `;
            div.onclick = () => {
                if (!this.state.tabs.includes(file)) this.state.tabs.push(file);
                this.openFile(file);
            };
            list.appendChild(div);
        });
    },

    renderKb() {
        const grid = document.getElementById('kb-grid');
        if (!grid) return;

        grid.innerHTML = "";
        this.state.config.kb.forEach(k => {
            const btn = document.createElement('button');
            btn.className = "kb-key";
            btn.innerText = k;
            btn.onclick = () => this.type(k);
            grid.appendChild(btn);
        });
        
        // Add System Logic Keys
        const systemKeys = [
            { l: 'SPACE', v: ' ' },
            { l: 'ENTER', v: '\n' },
            { l: 'DEL', v: 'BACKSPACE' }
        ];

        systemKeys.forEach(sk => {
            const btn = document.createElement('button');
            btn.className = "kb-key sys-key";
            btn.innerText = sk.l;
            btn.onclick = () => this.type(sk.v);
            grid.appendChild(btn);
        });
    },

    // --- ADVANCED TOOLS ---

    formatCode() {
        const view = this.state.popupCm || this.state.cm;
        if (!view) return;

        const code = view.state.doc.toString();
        const ext = this.state.active.split('.').pop();
        let formatted = code;

        try {
            if (ext === 'js' || ext === 'json') {
                formatted = js_beautify(code, { indent_size: 2 });
            } else if (ext === 'html') {
                formatted = html_beautify(code, { indent_size: 2 });
            } else if (ext === 'css') {
                formatted = css_beautify(code, { indent_size: 2 });
            }
            
            view.dispatch({
                changes: { from: 0, to: code.length, insert: formatted }
            });
            this.log("Code Formatted Successfully.", "var(--success)");
        } catch (e) {
            this.log("Formatting Error.", "var(--danger)");
        }
    },

    download(blob, name) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        URL.revokeObjectURL(a.href);
    }
};

// --- 4. HARDWARE INTEGRATION ---

const Hardware = {
    initShakeToUndo() {
        let lastX, lastY, lastZ;
        window.addEventListener('devicemotion', (e) => {
            let acc = e.accelerationIncludingGravity;
            if (!acc || !acc.x) return;
            
            let delta = Math.abs(acc.x + acc.y + acc.z - lastX - lastY - lastZ);
            if (delta > 20) { // Shake sensitivity threshold
                const view = Nexus.state.popupCm || Nexus.state.cm;
                if (window.CM6 && view) {
                    Nexus.log("Shake Detected: Undoing...", "var(--accent)");
                    window.CM6.undo({ state: view.state, dispatch: view.dispatch });
                }
                if (navigator.vibrate) navigator.vibrate(40);
            }
            lastX = acc.x; lastY = acc.y; lastZ = acc.z;
        }, true);
    }
};

// Final System Initialization
if (window.DeviceMotionEvent) Hardware.initShakeToUndo();

// Boot the Nexus Engine
Nexus.boot();
