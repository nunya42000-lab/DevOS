/* ========================================
   FILE: nexus.js (Ultimate DevOS Engine)
   ======================================== */

// --- 1. THE PROGRAMMATIC SCROLL ENGINE ---
// Bypasses browser touch-scroll bugs by talking directly to the CM6 scroller
const ScrollEngine = {
    jump(lines) {
        // Targets the popup if it's open, otherwise the standard view
        const view = Nexus.state.popupCm || Nexus.state.cm;
        if (!view) return;

        const scroller = view.scrollDOM;
        // Calculate dynamic line height based on current UI scale
        const lineHeight = parseFloat(window.getComputedStyle(view.contentDOM).lineHeight) || 18;
        
        if (lines === 'TOP') {
            scroller.scrollTo({ top: 0, behavior: 'smooth' });
        } else if (lines === 'BOTTOM') {
            scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
        } else {
            scroller.scrollBy({ top: lines * lineHeight, behavior: 'smooth' });
        }

        if (Nexus.state.config.haptics && window.navigator.vibrate) {
            window.navigator.vibrate(30);
        }
    }
};

// --- 2. BACKEND & SYSTEM UTILITIES ---
const System = {
    async nuke() {
        if (confirm("WARNING: This will permanently erase ALL files, history, branches, and settings. Proceed?")) {
            await localforage.clear();
            const keys = await caches.keys();
            for (let k of keys) await caches.delete(k);
            window.location.reload();
        }
    },
    generatePWA() {
        const manifest = {
            name: "DevOS Custom App", short_name: "App", display: "standalone",
            start_url: "./index.html", background_color: "#0d1117", theme_color: "#d29922"
        };
        const sw = `const CACHE = 'app-cache-v1';\nself.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(['./', './index.html']))));\nself.addEventListener('fetch', e => e.respondWith(caches.match(e.request).then(res => res || fetch(e.request))));`;
        Nexus.state.vfs['manifest.json'] = JSON.stringify(manifest, null, 2);
        Nexus.state.vfs['sw.js'] = sw;
        Nexus.save();
        Nexus.renderAll();
        Nexus.log("PWA Manifest & Service Worker generated.", "var(--success)");
    }
};

const Vault = {
    compile() {
        Nexus.log("Building Production Bundle...", 'var(--gold)');
        const bundle = Object.entries(Nexus.state.vfs)
            .map(([n, c]) => `/* File: ${n} */\n${c}`).join('\n\n');
        Nexus.download(new Blob([bundle], { type: 'text/javascript' }), 'devos-bundle.js');
    }
};

const NexusHistory = {
    history: {}, limit: 30,
    async init() { this.history = await localforage.getItem('nexus_history') || {}; },
    async takeSnapshot(filename, code) {
        if (!this.history[filename]) this.history[filename] = [];
        const last = this.history[filename][this.history[filename].length - 1];
        if (last && last.code === code) return;
        this.history[filename].push({ ts: Date.now(), code });
        if (this.history[filename].length > this.limit) this.history[filename].shift();
        await localforage.setItem('nexus_history', this.history);
    }
};

// --- 3. THE CORE NEXUS ENGINE ---
const Nexus = {
    state: {
        vfs: {}, active: 'index.html', tabs: [], cm: null, popupCm: null,
        languageConf: null, branchesData: {}, currentBranch: 'main',
        config: { 
            haptics: true, scale: 1, termHeight: 180, gesturesEnabled: true,
            kb: ['{', '}', '(', ')', ';', '=>', '&&', '||', '!', '=', '$', '_', '.', ',', '+', '-', '*', '/', '<', '>'] 
        }
    },

    async boot() {
        localforage.config({ name: 'Nexus_Prime_V6' });
        
        // Initial Data Fetch
        this.state.vfs = await localforage.getItem('vfs') || {
            'index.html': '<h1>Nexus Prime Ultimate</h1>\n<p>Scroll testing active...</p>' + '\n<p>Line content...</p>'.repeat(50),
            'main.js': 'console.log("Ready.");',
            'styles.css': 'body { background: #0d1117; color: #fff; }'
        };
        this.state.config = await localforage.getItem('config') || this.state.config;
        this.state.branchesData = await localforage.getItem('nexus_branches') || { 'main': { ...this.state.vfs } };
        this.state.currentBranch = await localforage.getItem('nexus_active_branch') || 'main';

        await NexusHistory.init();
        this.applyUIProperties();
        
        // Load UI components
        this.initScrollPillar();

        // Ensure CodeMirror 6 is ready
        if (!window.CM6) {
            await new Promise(r => window.addEventListener('cm6-ready', r));
        }

        // Boot Systems
        this.initEditor(this.state.vfs['index.html'] || '');
        this.initResizer();
        this.initGestures();
        this.initImporter();
        this.initTerm();
        
        // Initial Render
        this.renderAll();
        this.renderKb();
        this.openFile('index.html');
        this.log("Nexus Prime Online. Programmatic Scroll Active.", "var(--gold)");
    },

    initEditor(initialContent) {
        const area = document.querySelector('.editor-area');
        area.innerHTML = ''; 
        this.state.languageConf = new window.CM6.Compartment();

        this.state.cm = new window.CM6.EditorView({
            state: window.CM6.EditorState.create({
                doc: initialContent,
                extensions: [
                    window.CM6.basicSetup, 
                    window.CM6.oneDark,
                    this.state.languageConf.of(window.CM6.html()), 
                    window.CM6.EditorView.lineWrapping,
                    window.CM6.EditorView.updateListener.of((update) => {
                        if (update.docChanged && !this.state.popupCm) {
                            this.state.vfs[this.state.active] = update.state.doc.toString();
                            NexusHistory.takeSnapshot(this.state.active, this.state.vfs[this.state.active]);
                        }
                    })
                ]
            }),
            parent: area
        });
    },

    // --- POPUP / MODAL EDITOR ---
    maximizeEditor() {
        const filename = this.state.active;
        const content = this.state.vfs[filename] || '';
        
        const modalHTML = `
            <div class="editor-modal-overlay" id="nexus-editor-modal">
                <div class="editor-popup-window">
                    <div class="editor-popup-header">
                        <span style="color:var(--accent); font-weight:bold;">MAXIMIZED: ${filename}</span>
                        <div style="display:flex; gap:10px;">
                            <button class="tool-btn" onclick="Nexus.formatCode()">Format</button>
                            <button class="tool-btn btn-gold" onclick="Nexus.closePopupEditor()">SAVE & EXIT [X]</button>
                        </div>
                    </div>
                    <div class="editor-popup-body" id="popup-editor-target"></div>
                </div>
            </div>`;
        document.body.insertAdjacentHTML('beforeend', modalHTML);

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

        const ext = filename.split('.').pop().toLowerCase();
        let lang = window.CM6.javascript();
        if (ext === 'html') lang = window.CM6.html();
        else if (ext === 'css') lang = window.CM6.css();
        this.state.popupCm.dispatch({ effects: this.state.languageConf.reconfigure(lang) });
        
        setTimeout(() => this.state.popupCm.requestMeasure(), 50);
    },

    closePopupEditor() {
        if (this.state.popupCm) {
            this.state.vfs[this.state.active] = this.state.popupCm.state.doc.toString();
            this.save();
            this.openFile(this.state.active); 
        }
        const modal = document.getElementById('nexus-editor-modal');
        if (modal) modal.remove();
        this.state.popupCm = null;
    },

    // --- SCROLL PILLAR UI ---
    initScrollPillar() {
        const pillar = document.createElement('div');
        pillar.className = 'scroll-pillar';
        
        const cfg = [
            { l: 'TOP', v: 'TOP' },
            { l: '▲100', v: -100 },
            { l: '▲25', v: -25 },
            { l: '▲5', v: -5 },
            { l: '▼5', v: 5 },
            { l: '▼25', v: 25 },
            { l: '▼100', v: 100 },
            { l: 'END', v: 'BOTTOM' }
        ];

        cfg.forEach(i => {
            const b = document.createElement('button');
            b.className = 'scroll-btn';
            b.innerText = i.l;
            b.onclick = () => ScrollEngine.jump(i.v);
            pillar.appendChild(b);
        });

        document.body.appendChild(pillar);
    },

    // --- FILE OPERATIONS ---
    openFile(filename) {
        this.state.active = filename;
        if (!this.state.tabs.includes(filename)) this.state.tabs.push(filename);
        
        const content = this.state.vfs[filename] || '';
        if (this.state.cm) {
            const ext = filename.split('.').pop().toLowerCase();
            let lang = window.CM6.javascript();
            if (ext === 'html') lang = window.CM6.html();
            else if (ext === 'css') lang = window.CM6.css();
            
            this.state.cm.dispatch({
                changes: { from: 0, to: this.state.cm.state.doc.length, insert: String(content) },
                effects: this.state.languageConf.reconfigure(lang)
            });
        }
        this.renderAll();
    },

    type(val) {
        const view = this.state.popupCm || this.state.cm;
        if (!view) return;

        const cursor = view.state.selection.main.head;
        if (val === 'BACKSPACE') {
            if (cursor > 0) {
                view.dispatch({ changes: { from: cursor - 1, to: cursor, insert: "" } });
            }
        } else {
            view.dispatch({ 
                changes: { from: cursor, insert: val }, 
                selection: { anchor: cursor + val.length } 
            });
        }
        
        if (this.state.config.haptics && window.navigator.vibrate) {
            window.navigator.vibrate(50);
        }
    },

    async save() { 
        await localforage.setItem('vfs', this.state.vfs);
        await localforage.setItem('config', this.state.config); 
    },

    applyUIProperties() {
        document.documentElement.style.setProperty('--ui-scale', this.state.config.scale);
        document.documentElement.style.setProperty('--term-height', this.state.config.termHeight + 'px');
    },

    // --- INTERFACE SYSTEMS ---
    initResizer() {
        const resizer = document.getElementById('resizer');
        if (!resizer) return;
        let startY, startH;

        const onMove = (e) => {
            const curY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
            const delta = startY - curY;
            this.state.config.termHeight = Math.max(80, Math.min(window.innerHeight * 0.8, startH + delta));
            this.applyUIProperties();
            if (this.state.cm) this.state.cm.requestMeasure();
        };

        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onUp);
            this.save();
        };

        const onDown = (e) => {
            startY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
            startH = this.state.config.termHeight;
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onUp);
        };

        resizer.addEventListener('mousedown', onDown);
        resizer.addEventListener('touchstart', onDown);
    },

    initGestures() {
        let dist = 0, scale = 1;
        window.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) {
                dist = Math.hypot(e.touches[0].pageX - e.touches[1].pageX, e.touches[0].pageY - e.touches[1].pageY);
                scale = this.state.config.scale;
            }
        }, { passive: false });

        window.addEventListener('touchmove', (e) => {
            if (e.touches.length !== 2) return; 
            e.preventDefault(); 
            const curDist = Math.hypot(e.touches[0].pageX - e.touches[1].pageX, e.touches[0].pageY - e.touches[1].pageY);
            this.state.config.scale = parseFloat(Math.max(0.6, Math.min(2.0, scale * (curDist / dist))).toFixed(2));
            this.applyUIProperties();
        }, { passive: false });
    },

    initTerm() {
        const tin = document.getElementById('term-in');
        if (!tin) return;
        tin.onkeydown = (e) => {
            if (e.key === 'Enter') {
                this.log(`> ${tin.value}`, "white");
                this.processCommand(tin.value);
                tin.value = "";
            }
        };
    },

    log(msg, color = "var(--text)") {
        const out = document.getElementById('term-out');
        if (!out) return;
        const div = document.createElement('div');
        div.style.color = color; div.innerText = msg;
        out.appendChild(div); out.scrollTop = out.scrollHeight;
    },

    processCommand(cmd) {
        const c = cmd.trim().toLowerCase();
        if (c.startsWith('=')) {
            try { this.log(`= ${math.evaluate(cmd.substring(1))}`, "var(--success)"); } 
            catch (e) { this.log("Math Error", "var(--danger)"); }
        } 
        else if (c === 'clear') document.getElementById('term-out').innerHTML = "";
        else if (c === 'pwa') System.generatePWA();
        else if (c === 'nuke') System.nuke();
        else if (c === 'build') Vault.compile();
        else this.log("Unknown command (clear, pwa, build, nuke)", "var(--danger)");
    },

    renderAll() {
        this.renderTabs();
        this.renderExplorer();
    },

    renderTabs() {
        const t = document.getElementById('tabs');
        if (!t) return;
        t.innerHTML = "";
        this.state.tabs.forEach(tab => {
            const div = document.createElement('div');
            div.className = `tab ${tab === this.state.active ? 'active' : ''}`;
            div.innerHTML = `${tab} <span onclick="event.stopPropagation(); Nexus.closeTab('${tab}')">✕</span>`;
            div.onclick = () => this.openFile(tab);
            t.appendChild(div);
        });
    },

    closeTab(tab) {
        this.state.tabs = this.state.tabs.filter(t => t !== tab);
        if (this.state.active === tab) this.openFile(this.state.tabs[0] || 'index.html');
        else this.renderTabs();
    },

    renderExplorer() {
        const e = document.getElementById('explorer');
        if (!e) return;
        e.innerHTML = "";
        Object.keys(this.state.vfs).forEach(file => {
            const div = document.createElement('div');
            div.className = `list-entry ${file === this.state.active ? 'active' : ''}`;
            div.innerHTML = `📄 ${file}`;
            div.onclick = () => this.openFile(file);
            e.appendChild(div);
        });
    },

    renderKb() {
        const grid = document.getElementById('kb-grid');
        if(!grid) return;
        grid.innerHTML = "";
        this.state.config.kb.forEach(k => {
            const btn = document.createElement('button');
            btn.innerText = k;
            btn.onclick = () => this.type(k);
            grid.appendChild(btn);
        });
    },

    formatCode() {
        const activeView = this.state.popupCm || this.state.cm;
        if (!activeView) return;
        const code = activeView.state.doc.toString();
        const ext = this.state.active.split('.').pop();
        let formatted = code;
        try {
            if (ext === 'js' || ext === 'json') formatted = js_beautify(code, { indent_size: 4 });
            else if (ext === 'html') formatted = html_beautify(code, { indent_size: 4 });
            else if (ext === 'css') formatted = css_beautify(code, { indent_size: 4 });
            activeView.dispatch({ changes: { from: 0, to: code.length, insert: formatted } });
            this.log("Formatted.");
        } catch(e) { this.log("Format failed."); }
    },

    initImporter() {
        const input = document.getElementById('import-input');
        if (!input) return;
        input.onchange = async (e) => {
            const files = e.target.files;
            if (!files.length) return;
            for(let file of files) {
                if (file.name.endsWith('.zip')) {
                    const zip = await JSZip.loadAsync(file);
                    for (let path in zip.files) {
                        if (!zip.files[path].dir) {
                            this.state.vfs[zip.files[path].name] = await zip.files[path].async("string");
                        }
                    }
                } else {
                    this.state.vfs[file.name] = await file.text();
                }
            }
            this.save();
            this.renderAll();
            input.value = "";
        };
    },

    download(blob, name) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name; a.click();
    }
};

// --- 4. HARDWARE & INIT ---
const Hardware = {
    initShakeToUndo() {
        let lastX, lastY, lastZ;
        window.addEventListener('devicemotion', (e) => {
            let acc = e.accelerationIncludingGravity;
            if (!acc || !acc.x) return;
            let delta = Math.abs(acc.x + acc.y + acc.z - lastX - lastY - lastZ);
            if (delta > 20) { 
                const view = Nexus.state.popupCm || Nexus.state.cm;
                if(window.CM6 && view) {
                    Nexus.log("Shake: Undoing...");
                    window.CM6.undo({state: view.state, dispatch: view.dispatch});
                }
                if(navigator.vibrate) navigator.vibrate(30);
            }
            lastX = acc.x; lastY = acc.y; lastZ = acc.z;
        });
    }
};

if (window.DeviceMotionEvent) Hardware.initShakeToUndo();
Nexus.boot();
