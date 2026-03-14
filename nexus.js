/* ========================================
   FILE: nexus.js (Fully Unified & Patched Ultimate Edition)
   ======================================== */

// --- 1. SYSTEM & CORE ---
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
            name: "DevOS Custom App",
            short_name: "App",
            display: "standalone",
            start_url: "./index.html",
            background_color: "#000000",
            theme_color: "#2f81f7",
            icons: [{"src": "icon.png", "sizes": "512x512", "type": "image/png"}]
        };

        const sw = `const CACHE = 'app-cache-v1';
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(['./', './index.html']))));
self.addEventListener('fetch', e => e.respondWith(caches.match(e.request).then(res => res || fetch(e.request))));`;

        VFS.files['manifest.json'] = JSON.stringify(manifest, null, 2);
        VFS.files['sw.js'] = sw;
        VFS.save();
        Nexus.updateTerminal("Manifest and Service Worker generated.", "var(--success)");
    }
};

const Nexus = {
    state: {
        locked: false,
        orientation: 'portrait',
        terminalMode: 'drawer'
    },

    async boot() {
        console.log("Nexus Booting...");
        this.checkOrientation();
        this.initEventListeners();
        
        // Initialize all subsystems
        Vault.init();
        NexusHistory.init();
        NexusGit.init();
        Hardware.init();
        Editor.init();
        Preview.init();
        NexusSync.init();
        await VFS.init();

        this.updateTerminal("DevOS Nexus Ultimate Online. Type 'help' to start.");

        // Attach Drag & Drop Listeners
        const dropZone = document.getElementById('drop-overlay');
        if (dropZone) {
            window.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('active'); });
            window.addEventListener('dragleave', (e) => { e.preventDefault(); dropZone.classList.remove('active'); });
            window.addEventListener('drop', (e) => { 
                e.preventDefault(); 
                dropZone.classList.remove('active'); 
                VFS.importFiles({ target: { files: e.dataTransfer.files, value: '' } }); 
            });
        }

        // Attach File Import Input Listener
        const importInput = document.getElementById('file-import-input');
        if (importInput) {
            importInput.addEventListener('change', (e) => VFS.importFiles(e));
        }
    },

    initEventListeners() {
        window.addEventListener('resize', () => this.checkOrientation());
        
        const authBtn = document.getElementById('auth-btn');
        if (authBtn) authBtn.onclick = () => this.authenticate();
        
        const termCmd = document.getElementById('terminal-command');
        if (termCmd) {
            termCmd.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    this.executeCommand(e.target.value);
                    e.target.value = '';
                }
            };
        }
    },

    async authenticate() {
        if (window.PublicKeyCredential) {
            try {
                document.body.classList.remove('state-locked');
                this.state.locked = false;
                this.haptic('success');
            } catch (err) {
                this.updateTerminal("Auth Failed: " + err);
            }
        } else {
            const pin = prompt("Enter Master PIN:");
            if (pin === "1234") { 
                document.body.classList.remove('state-locked');
                this.state.locked = false;
            }
        }
    },

    updateTerminal(msg, color = 'var(--text)') {
        const output = document.getElementById('terminal-output');
        if (!output) return;
        const line = document.createElement('div');
        line.style.color = color;
        line.innerText = `[${new Date().toLocaleTimeString()}] ${msg}`;
        output.appendChild(line);
        output.scrollTop = output.scrollHeight;
    },

    executeCommand(cmd) {
        if (!cmd) return;
        this.updateTerminal(`> ${cmd}`, 'var(--accent)');
        const input = cmd.toLowerCase().trim();
        
        if (input === 'rebuild' || input === 'import') NexusReconstructor.openPortal();
        else if (input.startsWith('math ')) NexusMath.generateLogic(cmd.replace('math ', ''));
        else if (input.startsWith('branch ')) NexusGit.createBranch(cmd.replace('branch ', ''));
        else if (input === 'analyze') Intelligence.analyze();
        else if (input === 'sync') NexusSync.init();
        else if (input === 'clear') document.getElementById('terminal-output').innerHTML = '';
        else if (input === 'nuke') System.nuke();
        else if (input === 'pwa') System.generatePWA();
        else this.terminal.process(input);
    },

    checkOrientation() {
        this.state.orientation = window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
        document.body.setAttribute('data-orientation', this.state.orientation);
    },

    haptic(type) {
        if (!navigator.vibrate) return;
        const patterns = { light: 10, medium: 30, success: [20, 50, 20], error: [50, 100, 50] };
        navigator.vibrate(patterns[type] || 10);
    }
};

// --- 2. VIRTUAL FILE SYSTEM (VFS) ---
const VFS = {
    files: {},
    activeFile: null,

    async init() {
        this.files = await localforage.getItem('nexus_vfs') || {};
        this.renderExplorer();
    },

    async save() {
        await localforage.setItem('nexus_vfs', this.files);
        this.renderExplorer();
    },

    openFile(filename) {
        this.activeFile = filename;
        const content = this.files[filename] || '';
        Editor.loadContent(content, filename);
        
        const ext = filename.split('.').pop();
        if (window.VirtualKeyboard && window.VirtualKeyboard.render) VirtualKeyboard.render(ext);
        
        Nexus.updateTerminal(`Opened: ${filename}`);
        this.renderExplorer();
    },

    createFile() {
        const name = prompt("Enter file name (e.g., script.js, index.html):");
        if (name && !this.files[name]) {
            this.files[name] = "";
            this.save();
            this.openFile(name);
        }
    },

    async deleteFile(name) {
        if(confirm(`Delete ${name}?`)) {
            delete this.files[name];
            if(this.activeFile === name) {
                this.activeFile = null;
                if (Editor.cm) Editor.cm.setValue("");
            }
            await this.save();
        }
    },

    async importFiles(event) {
        const fileList = event.target.files;
        if (!fileList || !fileList.length) return;

        Nexus.updateTerminal(`Importing ${fileList.length} item(s)...`, 'var(--accent)');

        for (let file of fileList) {
            if (file.name.endsWith('.zip')) {
                try {
                    const zip = await JSZip.loadAsync(file);
                    for (let relativePath in zip.files) {
                        const zipEntry = zip.files[relativePath];
                        if (!zipEntry.dir) {
                            const content = await zipEntry.async('string');
                            this.files[zipEntry.name] = content;
                        }
                    }
                    Nexus.updateTerminal(`Extracted ZIP: ${file.name}`, 'var(--success)');
                } catch (err) {
                    Nexus.updateTerminal(`ZIP Error: ${err.message}`, 'var(--warn)');
                }
            } else {
                const content = await file.text();
                this.files[file.name] = content;
            }
        }
        
        await this.save();
        if (event.target.value !== undefined) event.target.value = ''; 
    },

    renderExplorer() {
        const exp = document.getElementById('explorer');
        this.renderTabs();
        
        if (!exp) return;
        if (Object.keys(this.files).length === 0) {
            exp.innerHTML = `<div style="padding:10px; color:var(--muted); text-align:center;">No files found.</div>`;
            return;
        }

        exp.innerHTML = Object.keys(this.files).map(f => `
            <div class="file-item ${this.activeFile === f ? 'active' : ''}" 
                 onclick="VFS.openFile('${f}')" 
                 style="padding: 8px; cursor: pointer; border-bottom: 1px solid var(--border); ${this.activeFile === f ? 'background: var(--border); color: var(--accent);' : ''}">
                📄 ${f}
            </div>
        `).join('');
    },

    renderTabs() {
        const tc = document.getElementById('tabs-container');
        if (!tc) return;
        tc.innerHTML = Object.keys(this.files).map(f => `
            <div onclick="VFS.openFile('${f}')" style="display:inline-block; padding: 5px 15px; background: ${this.activeFile === f ? 'var(--bg)' : 'transparent'}; border: 1px solid var(--border); border-bottom: none; cursor: pointer; border-radius: 4px 4px 0 0; color: ${this.activeFile === f ? 'var(--accent)' : 'var(--text)'};">
                ${f} <span onclick="event.stopPropagation(); VFS.deleteFile('${f}')" style="margin-left: 5px; color: var(--danger); font-weight: bold;">×</span>
            </div>
        `).join('');
    }
};

// --- 3. EDITOR ---
const Editor = {
    cm: null,

    init() {
        const wrapper = document.getElementById('editor-wrapper');
        if (!wrapper) return;

        this.cm = CodeMirror(wrapper, {
            value: "// Welcome to Nexus Prime Ultimate\n// Select, create, or import a file to begin.",
            mode: "javascript",
            theme: "dracula",
            lineNumbers: true,
            autoCloseBrackets: true,
            autoCloseTags: true,
            matchBrackets: true,
            foldGutter: true,
            gutters: ["CodeMirror-linenumbers", "CodeMirror-foldgutter"],
            viewportMargin: Infinity
        });

        this.cm.on('change', () => {
            if (VFS.activeFile) {
                VFS.files[VFS.activeFile] = this.cm.getValue();
                NexusHistory.takeSnapshot(VFS.activeFile, this.cm.getValue());
            }
        });
    },

    loadContent(content, filename) {
        if (!this.cm) return;
        const ext = filename.split('.').pop();
        const modes = { js: 'javascript', html: 'htmlmixed', css: 'css', json: 'javascript', md: 'markdown' };
        
        this.cm.setOption("mode", modes[ext] || "javascript");
        this.cm.setValue(content);
    },

    insertText(text) {
        if (this.cm) {
            this.cm.replaceSelection(text);
            this.cm.focus();
        }
    },

    formatCode() {
        if (!VFS.activeFile || !this.cm) return;
        const code = this.cm.getValue();
        const ext = VFS.activeFile.split('.').pop();
        let formatted = code;

        try {
            if (ext === 'js' || ext === 'json') formatted = js_beautify(code, { indent_size: 4 });
            else if (ext === 'html') formatted = html_beautify(code, { indent_size: 4 });
            else if (ext === 'css') formatted = css_beautify(code, { indent_size: 4 });
            
            this.cm.setValue(formatted);
            Nexus.updateTerminal("Code Formatted.", "var(--success)");
            Nexus.haptic('success');
        } catch (e) {
            Nexus.updateTerminal("Format error.", "var(--danger)");
        }
    }
};

// --- 4. PREVIEW & HARDWARE ---
const Preview = {
    fps: 0,
    lastTime: performance.now(),

    init() {
        this.startFPSCounter();
    },

    refresh() {
        const frame = document.getElementById('live-preview-frame');
        if (!frame) return;
        const html = VFS.files['index.html'] || '<h2 style="color:white;text-align:center;font-family:sans-serif;margin-top:20%;">No index.html found in VFS</h2>';
        const css = `<style>${VFS.files['styles.css'] || ''}</style>`;
        const js = `<script>${VFS.files['main.js'] || ''}<\/script>`;
        
        const blob = new Blob([html + css + js], { type: 'text/html' });
        frame.src = URL.createObjectURL(blob);
        
        Nexus.updateTerminal("Sandbox Refreshed", 'var(--success)');
        Nexus.haptic('medium');
    },

    resize(dimensions) {
        const frame = document.getElementById('live-preview-frame');
        if (!frame) return;
        
        if (dimensions.includes('x') && !dimensions.includes('100%')) {
            const [w, h] = dimensions.split('x');
            frame.style.width = w.trim();
            frame.style.height = h.trim();
            frame.style.border = "10px solid #333";
            frame.style.borderRadius = "30px";
        } else {
            frame.style.width = "100%";
            frame.style.height = "100%";
            frame.style.border = "none";
            frame.style.borderRadius = "0";
        }
        Nexus.updateTerminal(`Preview Resized: ${dimensions}`);
    },

    startFPSCounter() {
        const track = (now) => {
            const delta = now - this.lastTime;
            this.lastTime = now;
            this.fps = Math.round(1000 / delta);
            requestAnimationFrame(track);
        };
        requestAnimationFrame(track);
    }
};

const Hardware = {
    init() {
        this.initShakeToUndo();
    },

    initShakeToUndo() {
        let lastX, lastY, lastZ;
        let threshold = 15;

        window.addEventListener('devicemotion', (e) => {
            let acc = e.accelerationIncludingGravity;
            if (!acc || !acc.x) return;

            let delta = Math.abs(acc.x + acc.y + acc.z - lastX - lastY - lastZ);
            if (delta > threshold) {
                Nexus.updateTerminal("Shake detected: Undoing last action...");
                if (Editor.cm) Editor.cm.undo();
                Nexus.haptic('medium');
            }
            lastX = acc.x; lastY = acc.y; lastZ = acc.z;
        });
    }
};

// --- 5. GIT & HISTORY ---
const NexusGit = {
    branches: {},
    current: 'main',

    async init() {
        this.branches = await localforage.getItem('nexus_branches') || { 'main': { ...VFS.files } };
        this.current = await localforage.getItem('nexus_active_branch') || 'main';
        this.render();
    },

    async createBranch(name) {
        const id = name.toLowerCase().replace(/\s+/g, '-');
        if (this.branches[id]) return Nexus.updateTerminal("Branch already exists.", 'var(--warn)');
        
        this.branches[this.current] = { ...VFS.files };
        this.branches[id] = { ...VFS.files };
        this.current = id;
        
        await this.persist();
        Nexus.updateTerminal(`Switched to new branch: ${id}`, 'var(--success)');
    },

    async switchBranch(id) {
        if (!this.branches[id]) return;
        this.branches[this.current] = { ...VFS.files };
        this.current = id;
        
        VFS.files = { ...this.branches[id] };
        await VFS.save();
        await this.persist();
        
        Nexus.updateTerminal(`Active Branch: ${id}`);
        Nexus.haptic('medium');
    },

    async persist() {
        await localforage.setItem('nexus_branches', this.branches);
        await localforage.setItem('nexus_active_branch', this.current);
        this.render();
    },

    render() {
        const container = document.getElementById('branch-list');
        if (!container) return;
        container.innerHTML = Object.keys(this.branches).map(b => `
            <div class="branch-item ${this.current === b ? 'active' : ''}" onclick="NexusGit.switchBranch('${b}')" style="cursor:pointer; padding:5px;">
                ${this.current === b ? '●' : '○'} ${b}
            </div>
        `).join('');
    }
};

const NexusHistory = {
    history: {}, 
    limit: 30,

    async init() {
        this.history = await localforage.getItem('nexus_history') || {};
    },

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
            VFS.files[filename] = snap.code;
            VFS.save();
            Editor.loadContent(snap.code, filename);
            Nexus.updateTerminal(`Restored ${filename} to ${new Date(timestamp).toLocaleTimeString()}`);
        }
    }
};

// --- 6. UTILITIES (MATH, SEARCH, INTELLIGENCE) ---
const NexusMath = {
    generateLogic(expression) {
        if (typeof math === 'undefined') {
            Nexus.updateTerminal("Math.js library not loaded.", 'var(--warn)');
            return;
        }
        try {
            const node = math.parse(expression);
            const variables = [];
            
            node.traverse((n) => {
                if (n.isSymbolNode && !math[n.name]) {
                    variables.push(n.name);
                }
            });
            const uniqueVars = [...new Set(variables)];
            const args = uniqueVars.length > 0 ? uniqueVars.join(', ') : 'val';
            const funcSnippet = `
/**
 * Generated Logic for: ${expression}
 */
const calculateResult = (${args}) => {
    return ${node.toTex().replace(/\\frac{([^}]*)}{([^}]*)}/g, '($1/$2)') 
                 .replace(/\\cdot/g, '*')
                 .replace(/\^/g, '**')};
};`;

            Nexus.updateTerminal(`Math Logic Generated for variables: [${args}]`, 'var(--success)');
            Editor.insertText(funcSnippet);
        } catch (err) {
            Nexus.updateTerminal("Math Parser Error: " + err.message, 'var(--warn)');
        }
    }
};

const NexusSearch = {
    query(term) {
        if (!term) return;
        let matchCount = 0;
        Nexus.updateTerminal(`Searching for: "${term}"...`, 'var(--accent)');

        Object.entries(VFS.files).forEach(([filename, content]) => {
            const lines = content.split('\n');
            lines.forEach((line, i) => {
                if (line.toLowerCase().includes(term.toLowerCase())) {
                    matchCount++;
                    Nexus.updateTerminal(`[${filename}:${i+1}] ${line.trim().substring(0, 30)}...`, 'var(--text)');
                }
            });
        });
        if (matchCount === 0) Nexus.updateTerminal("No matches found.", 'var(--warn)');
        else Nexus.updateTerminal(`Found ${matchCount} matches.`, 'var(--success)');
    }
};

const Intelligence = {
    map: {},

    analyze() {
        this.map = {};
        Object.entries(VFS.files).forEach(([name, content]) => {
            if (!name.endsWith('.js')) return;
            
            const provides = content.match(/(?:function\s+|const\s+|let\s+)([a-zA-Z_$][\w$]*)/g) || [];
            const requires = content.match(/([a-zA-Z_$][\w$]*)\s*\(/g) || [];

            this.map[name] = {
                provides: provides.map(p => p.split(/\s+/).pop()),
                requires: requires.map(r => r.replace('(', '').trim())
            };
        });
        
        this.renderStats();
    },

    renderStats() {
        const totalLines = Object.values(VFS.files).reduce((a, b) => a + b.split('\n').length, 0);
        Nexus.updateTerminal(`Project Intelligence: ${Object.keys(VFS.files).length} files, ${totalLines} lines of logic.`);
    }
};

// --- 7. IMPORTER & RECONSTRUCTOR ---
const NexusImporter = {
    async parseFromClipboard() {
        try {
            const text = await navigator.clipboard.readText();
            this.process(text);
        } catch (err) {
            Nexus.updateTerminal("Clipboard access denied. Paste into terminal manually.", 'var(--warn)');
        }
    },

    async process(text) {
        const filePattern = /### ([\w.-]+)\n```\w*\n([\s\S]*?)```/g;
        let match;
        let count = 0;

        while ((match = filePattern.exec(text)) !== null) {
            const fileName = match[1];
            const fileContent = match[2].trim();
            VFS.files[fileName] = fileContent;
            count++;
        }

        if (count > 0) {
            await VFS.save();
            Nexus.updateTerminal(`Reconstruction Complete: ${count} files updated.`, 'var(--success)');
            Nexus.haptic('success');
        } else {
            Nexus.updateTerminal("No valid file blocks detected in text.", 'var(--warn)');
        }
    }
};

const NexusReconstructor = {
    openPortal() {
        const text = prompt("Paste the chat history or file blocks here to rebuild:");
        if (text) NexusImporter.process(text);
    }
};

// --- 8. VAULT COMPILER ---
const Vault = {
    snippets: [],

    async init() {
        this.snippets = await localforage.getItem('nexus_snippets') || [];
    },

    async addSnippet(name, code) {
        this.snippets.push({ id: Date.now(), name, code });
        await localforage.setItem('nexus_snippets', this.snippets);
        Nexus.updateTerminal(`Snippet "${name}" added to Vault.`);
    },

    compile() {
        Nexus.updateTerminal("Starting Production Bundle...", 'var(--accent)');
        const bundle = Object.entries(VFS.files)
            .map(([name, content]) => `/* File: ${name} */\n${content}`)
            .join('\n\n');
        const blob = new Blob([bundle], { type: 'text/javascript' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'devos-bundle.js';
        a.click();
        
        Nexus.updateTerminal("Build Complete. Download started.", 'var(--success)');
    },

    exportAIContext() {
        const context = Object.entries(VFS.files)
            .map(([name, content]) => `FILE: ${name}\n\`\`\`\n${content}\n\`\`\``)
            .join('\n\n');
        navigator.clipboard.writeText(context);
        Nexus.updateTerminal("Project context copied for AI Assistant.");
        Nexus.haptic('success');
    }
};

// --- 9. SYNC (WEBRTC) ---
const NexusSync = {
    peer: null,
    conn: null,

    init() {
        if (typeof Peer === 'undefined') {
            Nexus.updateTerminal("PeerJS library not loaded. Sync unavailable.", 'var(--warn)');
            return;
        }
        const deviceId = 'devos-' + Math.floor(Math.random() * 10000);
        this.peer = new Peer(deviceId);

        this.peer.on('open', (id) => {
            Nexus.updateTerminal(`Device ID: ${id}. Share this to sync.`, 'var(--accent)');
        });
        
        this.peer.on('connection', (connection) => {
            this.conn = connection;
            this.setupListeners();
            Nexus.updateTerminal("REMOTE DEVICE LINKED", 'var(--success)');
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
                Editor.insertText(data.value);
                Nexus.haptic('light');
            }
            if (data.type === 'VFS_SYNC') {
                VFS.files = data.value;
                VFS.renderExplorer();
                Nexus.updateTerminal("VFS Synchronized with remote.");
            }
        });
    },

    sendKeystroke(key) {
        if (this.conn && this.conn.open) {
            this.conn.send({ type: 'KEYSTROKE', value: key });
        }
    }
};

// --- 10. TERMINAL ROUTER ---
Nexus.terminal = {
    mode: 'drawer',
    context: 'js',

    solveMath(expression) {
        if (typeof math === 'undefined') return;
        try {
            const result = math.evaluate(expression);
            const cleanExpr = expression.replace(/x/g, 'val');
            const snippet = `const calculate = (val) => { return ${cleanExpr}; }; // Result: ${result}`;
            
            Nexus.updateTerminal(`Math Result: ${result}`, 'var(--accent)');
            if (confirm("Insert this math logic as a JS function?")) {
                Editor.insertText(snippet);
            }
        } catch (err) {
            Nexus.updateTerminal("Math Error: " + err.message, 'var(--warn)');
        }
    },

    process(input) {
        if (input.startsWith('find ')) {
            NexusSearch.query(input.replace('find ', ''));
            return;
        }
        if (input.startsWith('=')) { 
            this.solveMath(input.substring(1));
            return;
        }

        switch(input) {
            case 'build':
                Nexus.updateTerminal("Compiling Vault...", 'var(--warn)');
                Vault.compile(); 
                break;
            case 'export':
                Vault.exportAIContext();
                break;
            case 'float':
                document.getElementById('universal-terminal').className = 'terminal-float';
                break;
            case 'drawer':
                document.getElementById('universal-terminal').className = 'terminal-drawer';
                break;
            case 'help':
                Nexus.updateTerminal("Commands: build, export, find [term], nuke, pwa, = [math]");
                break;
            default:
                Nexus.updateTerminal(`Unknown: ${input}. Type 'help'.`);
        }
    }
};

// --- BOOT TRIGGER ---
window.onload = () => Nexus.boot();
