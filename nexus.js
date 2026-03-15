/* ========================================
   FILE: nexus.js (Ultimate CM6 Engine)
   ======================================== */

// --- BACKEND SYSTEMS ---
const System = {
    async nuke() {
        if (confirm("WARNING: This will permanently erase ALL files, history, branches, and settings. Proceed?")) {
            await localforage.clear();
            const cacheKeys = await caches.keys();
            for (let key of cacheKeys) {
                await caches.delete(key);
            }
            window.location.reload();
        }
    },
    generatePWA() {
        const manifest = {
            name: "DevOS Custom App", short_name: "App", display: "standalone",
            start_url: "./index.html", background_color: "#000000", theme_color: "#2f81f7",
            icons: [{"src": "icon.png", "sizes": "512x512", "type": "image/png"}]
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
        Nexus.log("Starting Production Bundle...", 'var(--gold)');
        const bundle = Object.entries(Nexus.state.vfs)
            .map(([name, content]) => `/* File: ${name} */\n${content}`).join('\n\n');
        const blob = new Blob([bundle], { type: 'text/javascript' });
        Nexus.download(blob, 'devos-bundle.js');
        Nexus.log("Build Complete. Download started.", 'var(--success)');
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
    },
    restore(filename, timestamp) {
        const snap = this.history[filename].find(h => h.ts === timestamp);
        if (snap) {
            Nexus.state.vfs[filename] = snap.code;
            Nexus.save();
            Nexus.openFile(filename);
            Nexus.log(`Restored ${filename}`, "var(--success)");
        }
    }
};

const NexusSync = {
    peer: null, conn: null,
    init() {
        if (typeof Peer === 'undefined') return Nexus.log("PeerJS missing.", 'var(--danger)');
        const deviceId = 'devos-' + Math.floor(Math.random() * 10000);
        this.peer = new Peer(deviceId);
        this.peer.on('open', (id) => Nexus.log(`Sync ID: ${id}. Share to link devices.`, 'var(--accent)'));
        this.peer.on('connection', (connection) => {
            this.conn = connection;
            this.setupListeners();
            Nexus.log("REMOTE DEVICE LINKED", 'var(--success)');
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
    },
    sendKeystroke(key) {
        if (this.conn && this.conn.open) this.conn.send({ type: 'KEYSTROKE', value: key });
    }
};

// --- CORE NEXUS OBJECT ---
const Nexus = {
    state: {
        vfs: {}, active: 'index.html', tabs: [], cm: null, popupCm: null,
        languageConf: null, 
        branchesData: {}, currentBranch: 'main',
        config: { 
            haptics: true, scale: 1, termHeight: 180, gesturesEnabled: true,
            kb: ['{', '}', '(', ')', ';', '=>', '&&', '||', '!', '=', '$', '_', '.', ',', '+', '-', '*', '/', '<', '>'] 
        }
    },

    async boot() {
        localforage.config({ name: 'Nexus_Prime_V6' });
        this.state.vfs = await localforage.getItem('vfs') || {
            'index.html': '<h1>Nexus Prime Ultimate</h1>\n<p>Code here...</p>',
            'main.js': 'console.log("Ready.");',
            'styles.css': 'body { background: #000; color: #fff; }'
        };
        this.state.config = await localforage.getItem('config') || this.state.config;
        
        this.state.branchesData = await localforage.getItem('nexus_branches') || { 'main': { ...this.state.vfs } };
        this.state.currentBranch = await localforage.getItem('nexus_active_branch') || 'main';

        await NexusHistory.init();
        this.applyUIProperties();

        if (!window.CM6) {
            await new Promise(r => window.addEventListener('cm6-ready', r));
        }

        this.initEditor(this.state.vfs['index.html'] || '');
        this.initResizer();
        this.initGestures();
        this.initImporter();
        this.initTerm();
        
        this.renderAll();
        this.renderKb();
        this.openFile('index.html');
        this.log("Nexus Prime Ultimate Active. Engine Online.", "var(--gold)");
    },

    initEditor(initialContent) {
        const editorArea = document.querySelector('.editor-area');
        editorArea.innerHTML = ''; 

        this.state.languageConf = new window.CM6.Compartment();

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

    // --- POPUP MODAL LOGIC ---
    maximizeEditor() {
        const filename = this.state.active;
        const content = this.state.vfs[filename] || '';

        const modalHTML = `
            <div class="editor-modal-overlay" id="nexus-editor-modal">
                <div class="editor-popup-window">
                    <div class="editor-popup-header">
                        <span style="color:var(--accent); font-weight:bold;">MAXIMIZED: ${filename}</span>
                        <button class="tool-btn btn-gold" onclick="Nexus.closePopupEditor()">SAVE & EXIT [X]</button>
                    </div>
                    <div class="editor-popup-body" id="popup-editor-target"></div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHTML);

        this.state.popupCm = new window.CM6.EditorView({
            state: window.CM6.EditorState.create({
                doc: content,
                extensions: [
                    window.CM6.basicSetup,
                    window.CM6.oneDark,
                    this.state.languageConf.of(window.CM6.javascript()),
                    window.CM6.EditorView.lineWrapping
                ]
            }),
            parent: document.getElementById('popup-editor-target')
        });

        const ext = filename.split('.').pop().toLowerCase();
        let langExt = window.CM6.javascript();
        if (ext === 'html') langExt = window.CM6.html();
        else if (ext === 'css') langExt = window.CM6.css();
        this.state.popupCm.dispatch({
            effects: this.state.languageConf.reconfigure(langExt)
        });

        setTimeout(() => this.state.popupCm.requestMeasure(), 50);
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
    },

    async save() { 
        await localforage.setItem('vfs', this.state.vfs);
        await localforage.setItem('config', this.state.config); 
    },

    applyUIProperties() {
        document.documentElement.style.setProperty('--ui-scale', this.state.config.scale);
        document.documentElement.style.setProperty('--term-height', this.state.config.termHeight + 'px');
    },

    openFile(filename) {
        this.state.active = filename;
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
        if (window.innerWidth < 1024) {
            const sb = document.getElementById('sidebar');
            if (sb) sb.classList.remove('active');
        }
    },

    type(val, fromSync = false) {
        const activeView = this.state.popupCm || this.state.cm;
        if (!activeView) return;
        const cursor = activeView.state.selection.main.head;
        
        if (val === 'BACKSPACE') {
            if (cursor > 0) activeView.dispatch({ changes: { from: cursor - 1, to: cursor, insert: "" } });
        } else {
            activeView.dispatch({
                changes: { from: cursor, insert: val },
                selection: { anchor: cursor + val.length } 
            });
        }
        
        if (this.state.config.haptics && window.navigator.vibrate) window.navigator.vibrate(50);
        if (!fromSync && NexusSync.conn) NexusSync.sendKeystroke(val);
    },

    toggleSidebar() { 
        const sb = document.getElementById('sidebar');
        if (sb) sb.classList.toggle('active'); 
    },
    triggerImport() { document.getElementById('import-input').click(); },

    // --- GESTURE ENGINE ---
    initGestures() {
        let initialDist = 0; let initialScale = 1;
        const toast = document.getElementById('scale-toast');

        window.addEventListener('touchstart', (e) => {
            if (!this.state.config.gesturesEnabled) return;
            if (e.touches.length === 2) {
                initialDist = Math.hypot( e.touches[0].pageX - e.touches[1].pageX, e.touches[0].pageY - e.touches[1].pageY );
                initialScale = this.state.config.scale;
            }
        }, { passive: false });
        window.addEventListener('touchmove', (e) => {
            if (!this.state.config.gesturesEnabled || e.touches.length !== 2) return;
            e.preventDefault(); 
            const currentDist = Math.hypot( e.touches[0].pageX - e.touches[1].pageX, e.touches[0].pageY - e.touches[1].pageY );
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
            if (!this.state.config.gesturesEnabled) return;
            if (toast) setTimeout(() => toast.style.opacity = '0', 1000);
            this.save();
        });
    },

    // --- RESIZER LOGIC ---
    initResizer() {
        const resizer = document.getElementById('resizer');
        if (!resizer) return;
        let startY, startH;
        const onDown = (e) => {
            startY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
            startH = this.state.config.termHeight;
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onUp);
        };
        const onMove = (e) => {
            const currentY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
            const delta = startY - currentY;
            this.state.config.termHeight = Math.max(100, Math.min(window.innerHeight * 0.7, startH + delta));
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
        resizer.addEventListener('mousedown', onDown);
        resizer.addEventListener('touchstart', onDown);
    },

    // --- SETTINGS & HELP ---
    openSettings() {
        const body = `
            <div style="display:grid; gap:15px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span>Pinch Zoom Gestures</span>
                    <input type="checkbox" id="gest-tog" ${this.state.config.gesturesEnabled ? 'checked' : ''}>
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span>Haptic Vibrate</span>
                    <input type="checkbox" id="hap-tog" ${this.state.config.haptics ? 'checked' : ''}>
                </div>
                <div>
                    <label style="font-size:12px; display:block; margin-bottom:5px;">Manual UI Scale (0.6 - 2.0)</label>
                    <input type="range" id="ui-scale-rng" min="0.6" max="2.0" step="0.05" value="${this.state.config.scale}" style="width:100%;">
                </div>
                <button class="tool-btn btn-gold" style="width:100%; height:45px; justify-content:center;" onclick="Nexus.saveSettings()">APPLY CONFIG</button>
            </div>
        `;
        this.showModal("Control Center", body);
    },

    saveSettings() {
        this.state.config.gesturesEnabled = document.getElementById('gest-tog').checked;
        this.state.config.haptics = document.getElementById('hap-tog').checked;
        this.state.config.scale = parseFloat(document.getElementById('ui-scale-rng').value);
        this.save();
        this.applyUIProperties();
        this.closeModal();
        this.log("Settings updated.", "var(--success)");
    },

    openHelp() {
        const helpHTML = `
            <div style="line-height: 1.6;">
                <h4 style="margin-top:0;">Nexus Prime Ultimate - Quick Guide</h4>
                <ul style="padding-left: 20px;">
                    <li><b>File Importer:</b> Use the 'Import' button to load multiple files (.js, .html, .css) or full .zip projects simultaneously.</li>
                    <li><b>Voice Commands (🎙️):</b> Click the mic and dictate commands like "build", "nuke", "clear", or "pwa".</li>
                    <li><b>Math Engine:</b> In the terminal, type <code>= 50 * 4</code> to compute equations instantly.</li>
                    <li><b>Gestures:</b> Pinch with two fingers to zoom the UI in/out.</li>
                    <li><b>Terminal:</b> Drag the grey horizontal bar above the terminal to resize it.</li>
                </ul>
            </div>
        `;
        this.showModal("📖 Help & Documentation", helpHTML);
    },

    // --- FILE PORTER ---
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
                    this.log(`Extracted ZIP: ${file.name}`, "var(--success)");
                } else {
                    this.state.vfs[file.name] = await file.text();
                }
            }
            this.save();
            this.renderAll();
            input.value = "";
        };
    },

    async exportZIP() {
        const zip = new JSZip();
        Object.entries(this.state.vfs).forEach(([n, c]) => zip.file(n, c));
        const blob = await zip.generateAsync({ type: "blob" });
        this.download(blob, `nexus-project.zip`);
    },

    exportTXT() {
        let out = "";
        Object.entries(this.state.vfs).forEach(([n, c]) => { out += `${n}\n\`\`\`\n${c}\n\`\`\`\n\n`; });
        this.download(new Blob([out], { type: "text/plain" }), "nexus-log.txt");
    },

    download(blob, name) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
    },

    // --- CORE LOGIC ---
    formatCode() {
        const activeView = this.state.popupCm || this.state.cm;
        if (!this.state.active || !activeView) return;
        const code = activeView.state.doc.toString();
        const ext = this.state.active.split('.').pop();
        let formatted = code;
        try {
            if (ext === 'js' || ext === 'json') formatted = js_beautify(code, { indent_size: 4 });
            else if (ext === 'html') formatted = html_beautify(code, { indent_size: 4 });
            else if (ext === 'css') formatted = css_beautify(code, { indent_size: 4 });
            activeView.dispatch({ changes: { from: 0, to: code.length, insert: formatted } });
            this.log("Code Formatted ✨", "var(--success)");
        } catch(e) { this.log("Format error", "var(--danger)"); }
    },

    run() {
        const html = this.state.vfs['index.html'] || '<h1>No index.html</h1>';
        const css = `<style>${this.state.vfs['styles.css'] || ''}</style>`;
        const js = `<script>${this.state.vfs['main.js'] || ''}<\/script>`;
        const blob = new Blob([html + css + js], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        
        const frameHtml = `
            <div style="display:flex; justify-content:flex-end; padding-bottom:10px;">
                <a href="${url}" target="_blank" style="color:var(--accent); text-decoration:none; font-size:12px;">Open in New Tab ↗</a>
            </div>
            <iframe src="${url}" style="width:100%; height:60vh; border:none; background:#fff; border-radius:8px;"></iframe>
        `;
        this.showModal("Live App Sandbox", frameHtml);
        this.log("Sandbox Preview launched.", "var(--success)");
    },

    visual() { this.showModal("Visual Builders", "<p style='color:var(--text)'>Visual State Machine builder module pending initialization.</p>"); },
    
    history() {
        const hist = NexusHistory.history[this.state.active] || [];
        let html = `<h4 style="margin-top:0;">History for ${this.state.active}</h4><div style="display:flex;flex-direction:column;gap:5px;">`;
        if(hist.length === 0) html += "<p>No snapshots found.</p>";
        hist.slice().reverse().forEach(h => {
            html += `<button onclick="NexusHistory.restore('${this.state.active}', ${h.ts}); Nexus.closeModal();" style="padding:10px; background:var(--surface); color:white; border:1px solid var(--border); border-radius:6px; cursor:pointer; text-align:left;">Restore: ${new Date(h.ts).toLocaleString()}</button>`;
        });
        html += "</div>";
        this.showModal("🕒 Time Machine", html);
    },

    searchAll() {
        const q = document.getElementById('find-box').value.toLowerCase();
        const res = document.getElementById('search-results');
        if (!res) return;
        res.innerHTML = "";
        if (!q) return;
        Object.entries(this.state.vfs).forEach(([file, code]) => {
            code.split('\n').forEach((line, i) => {
                if (line.toLowerCase().includes(q)) {
                    const div = document.createElement('div');
                    div.className = "list-entry";
                    div.style.fontSize = "10px";
                    div.innerText = `${file}:${i+1} > ${line.trim().substring(0, 30)}`;
                    div.onclick = () => this.openFile(file);
                    res.appendChild(div);
                }
            });
        });
    },

    replaceAll() {
        const f = document.getElementById('find-box').value;
        const r = document.getElementById('replace-box').value;
        if (!f) return;
        Object.keys(this.state.vfs).forEach(file => {
            this.state.vfs[file] = this.state.vfs[file].split(f).join(r);
        });
        this.save();
        this.openFile(this.state.active);
        this.log("Global replace complete.");
    },

    runIntel() {
        const activeView = this.state.popupCm || this.state.cm;
        if (!activeView) return;
        const code = activeView.state.doc.toString();
        const decls = code.match(/(?:const|let|var|function|class)\s+([a-zA-Z_$][\w$]*)/g) || [];
        const ilist = document.getElementById('intel-list');
        if (ilist) ilist.innerHTML = [...new Set(decls)].map(d => `<div class="list-entry">${d}</div>`).join('');
        this.log("Intelligence mapping ready.", "var(--accent)");
    },

    // Modals & Drawers
    showModal(title, bodyHTML) {
        document.getElementById('modal-title').innerText = title;
        document.getElementById('modal-body').innerHTML = bodyHTML;
        document.getElementById('modal-overlay').style.display = 'flex';
    },
    closeModal() { document.getElementById('modal-overlay').style.display = 'none'; },
    toggleAcc(el) {
        const body = el.nextElementSibling;
        body.classList.toggle('active');
        el.querySelector('span').innerText = body.classList.contains('active') ? '▼' : '▶';
    },
    toggleKb() { 
        const kb = document.getElementById('kb-drawer');
        const navBtn = document.getElementById('mobile-nav');
        if (kb) kb.classList.toggle('active'); 
        if (kb && navBtn) {
            if (kb.classList.contains('active')) {
                navBtn.style.bottom = '260px';
            } else {
                navBtn.style.bottom = '100px';
            }
        }
    },
    copy() { 
        const activeView = this.state.popupCm || this.state.cm;
        if (!activeView) return;
        navigator.clipboard.writeText(activeView.state.sliceDoc(activeView.state.selection.main.from, activeView.state.selection.main.to) || activeView.state.doc.toString()); 
        this.log("Copied."); 
    },
    cut() { 
        const activeView = this.state.popupCm || this.state.cm;
        if (!activeView) return;
        const s = activeView.state.selection.main;
        if (s.from !== s.to) {
            navigator.clipboard.writeText(activeView.state.sliceDoc(s.from, s.to));
            activeView.dispatch({ changes: { from: s.from, to: s.to, insert: "" } });
            this.log("Cut.");
        }
    },

    // Terminal
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

    // Speech API for Voice Trigger
    startVoice() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            this.log("Voice dictation not supported in this browser.", "var(--danger)");
            return;
        }
        const recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = false;
        
        this.log("🎙️ Listening...", "var(--accent)");
        
        recognition.onresult = (event) => {
            const transcript = event.results[0][0].transcript;
            this.log(`Heard: "${transcript}"`, "var(--text)");
            const tin = document.getElementById('term-in');
            if (tin) tin.value = transcript;
            this.processCommand(transcript);
        };
        
        recognition.onerror = (e) => this.log(`🎙️ Error: ${e.error}`, "var(--danger)");
        recognition.start();
    },

    log(msg, color = "var(--text)") {
        const out = document.getElementById('term-out');
        if (!out) return;
        const div = document.createElement('div');
        div.style.color = color;
        div.innerText = msg;
        out.appendChild(div);
        out.scrollTop = out.scrollHeight;
    },

    processCommand(cmd) {
        const c = cmd.trim().toLowerCase();
        if (c.startsWith('=')) {
            try { this.log(`= ${math.evaluate(cmd.substring(1))}`, "var(--success)"); } 
            catch (e) { this.log("Math Error", "var(--danger)"); }
        } 
        else if (c === 'clear') {
            const out = document.getElementById('term-out');
            if (out) out.innerHTML = "";
        }
        else if (c === 'nuke') System.nuke();
        else if (c === 'pwa') System.generatePWA();
        else if (c === 'build') Vault.compile();
        else if (c === 'sync') NexusSync.init();
        else if (c === 'help') this.log("Available: clear, nuke, pwa, build, sync, =, help", "var(--gold)");
        else this.log("Unknown command. Type 'help'.", "var(--danger)");
    },

    // UI Render Updates
    renderAll() {
        this.renderTabs();
        this.renderExplorer();
        this.renderBranches();
    },

    renderTabs() {
        const t = document.getElementById('tabs');
        if (!t) return;
        t.innerHTML = "";
        this.state.tabs.forEach(tab => {
            const div = document.createElement('div');
            div.className = `tab ${tab === this.state.active ? 'active' : ''}`;
            div.innerHTML = `${tab} <span style="margin-left:8px;color:#888;" onclick="event.stopPropagation(); Nexus.closeTab('${tab}')">✕</span>`;
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
            div.innerHTML = `<span>📄 ${file}</span> <span style="color:var(--danger);" onclick="event.stopPropagation(); Nexus.deleteFile('${file}')">🗑</span>`;
            div.onclick = () => {
                if (!this.state.tabs.includes(file)) this.state.tabs.push(file);
                this.openFile(file);
            };
            e.appendChild(div);
        });
    },

    createFile() {
        const name = prompt("File name (e.g., script.js):");
        if (name && !this.state.vfs[name]) {
            this.state.vfs[name] = "";
            this.state.tabs.push(name);
            this.save();
            this.openFile(name);
        }
    },

    deleteFile(name) {
        if (confirm(`Delete ${name}?`)) {
            delete this.state.vfs[name];
            this.closeTab(name);
            this.save();
            this.renderAll();
        }
    },

    // Git / Branching Logic
    async createBranch(name) {
        const id = name.toLowerCase().replace(/\s+/g, '-');
        if (this.state.branchesData[id]) return this.log("Branch already exists.", 'var(--warn)');
        
        this.state.branchesData[this.state.currentBranch] = { ...this.state.vfs };
        this.state.branchesData[id] = { ...this.state.vfs };
        this.state.currentBranch = id;
        
        await localforage.setItem('nexus_branches', this.state.branchesData);
        await localforage.setItem('nexus_active_branch', this.state.currentBranch);
        this.log(`Switched to new branch: ${id}`, 'var(--success)');
        this.renderBranches();
    },

    async switchBranch(id) {
        if (!this.state.branchesData[id]) return;
        this.state.branchesData[this.state.currentBranch] = { ...this.state.vfs };
        this.state.currentBranch = id;
        this.state.vfs = { ...this.state.branchesData[id] };
        
        await this.save();
        await localforage.setItem('nexus_branches', this.state.branchesData);
        await localforage.setItem('nexus_active_branch', this.state.currentBranch);
        
        this.log(`Active Branch: ${id}`);
        this.renderAll();
        this.openFile('index.html');
    },

    renderBranches() {
        const b = document.getElementById('branch-list');
        if (!b) return;
        b.innerHTML = "";
        Object.keys(this.state.branchesData).forEach(br => {
            const div = document.createElement('div');
            div.className = `list-entry ${br === this.state.currentBranch ? 'active' : ''}`;
            div.innerHTML = `${br === this.state.currentBranch ? '●' : '○'} ${br}`;
            div.onclick = () => this.switchBranch(br);
            b.appendChild(div);
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
        ['Space: ', 'Enter:\n', 'Del:BACKSPACE'].forEach(sys => {
            const [label, val] = sys.split(':');
            const btn = document.createElement('button');
            btn.innerText = label;
            if(label === 'Space') btn.style.gridColumn = "span 2";
            btn.onclick = () => this.type(val);
            grid.appendChild(btn);
        });
    }
};

// --- HARDWARE MODULES ---
const Hardware = {
    initShakeToUndo() {
        let lastX, lastY, lastZ;
        window.addEventListener('devicemotion', (e) => {
            let acc = e.accelerationIncludingGravity;
            if (!acc || !acc.x) return;
            let delta = Math.abs(acc.x + acc.y + acc.z - lastX - lastY - lastZ);
            if (delta > 15) { // Threshold
                Nexus.log("Shake detected: Undoing last action...");
                const activeView = Nexus.state.popupCm || Nexus.state.cm;
                if(window.CM6 && activeView) window.CM6.undo({state: activeView.state, dispatch: activeView.dispatch});
                if(navigator.vibrate) navigator.vibrate(30);
            }
            lastX = acc.x; lastY = acc.y; lastZ = acc.z;
        });
    }
};

// Initialize hardware and boot system
if (window.DeviceMotionEvent) Hardware.initShakeToUndo();
Nexus.boot();
