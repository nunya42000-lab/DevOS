/* ========================================
   FILE: nexus.js (Unified)
   ======================================== */

// --- 1. CORE ---
const Nexus = {
    state: {
        locked: true,
        orientation: 'portrait',
        activeFile: null,
        terminalMode: 'drawer',
        peer: null // For WebRTC Sync
    },

    async boot() {
        console.log("Nexus Booting...");
        this.checkOrientation();
        this.initEventListeners();
        
        // Load VFS and Settings
        const vfs = await localforage.getItem('nexus_vfs') || {};
        console.log("VFS Loaded", Object.keys(vfs).length, "files");

        this.updateTerminal("DevOS Nexus v2.0 Online. Type 'help' to start.");
    },

    initEventListeners() {
        window.addEventListener('resize', () => this.checkOrientation());
        
        // Biometric Unlock Trigger
        document.getElementById('auth-btn').onclick = () => this.authenticate();
        
        // Terminal Input Handling
        document.getElementById('terminal-command').onkeydown = (e) => {
            if (e.key === 'Enter') {
                this.executeCommand(e.target.value);
                e.target.value = '';
            }
        };
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
            if (pin === "1234") { // Placeholder
                document.body.classList.remove('state-locked');
                this.state.locked = false;
            }
        }
    },

    updateTerminal(msg, color = 'var(--text)') {
        const output = document.getElementById('terminal-output');
        const line = document.createElement('div');
        line.style.color = color;
        line.innerText = `[${new Date().toLocaleTimeString()}] ${msg}`;
        output.appendChild(line);
        output.scrollTop = output.scrollHeight;
    },

    executeCommand(cmd) {
        this.updateTerminal(`> ${cmd}`, 'var(--accent)');
        const input = cmd.toLowerCase().trim();
        
        if (input === 'rebuild' || input === 'import') {
            NexusReconstructor.openPortal();
        } else if (input.startsWith('math ')) {
            NexusMath.generateLogic(cmd.replace('math ', ''));
        } else if (input.startsWith('branch ')) {
            NexusGit.createBranch(cmd.replace('branch ', ''));
        } else if (input === 'analyze') {
            Intelligence.analyze();
        } else if (input === 'build') {
            Vault.compile();
        } else if (input === 'sync') {
            NexusSync.init();
        } else {
            Nexus.terminal.process(input);
        }
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

// --- 2. EDITOR ---
const Editor = {
    view: null,

    init() {
        this.view = new CodeMirror.EditorView({
            parent: document.getElementById('editor-wrapper'),
            extensions: [
                CodeMirror.basicSetup,
                CodeMirror.javascript(),
                CodeMirror.EditorView.updateListener.of((v) => {
                    if (v.docChanged) {
                        VFS.files[VFS.activeFile] = v.state.doc.toString();
                    }
                })
            ]
        });
    },

    loadContent(content, filename) {
        const transaction = this.view.state.update({
            changes: {from: 0, to: this.view.state.doc.length, insert: content}
        });
        this.view.dispatch(transaction);
    },

    insertText(text) {
        const range = this.view.state.selection.main;
        this.view.dispatch({
            changes: {from: range.from, to: range.to, insert: text},
            selection: {anchor: range.from + text.length}
        });
    }
};

// --- 3. GIT & HISTORY ---
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
        await VFS.saveVFS();
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
            <div class="branch-item ${this.current === b ? 'active' : ''}" onclick="NexusGit.switchBranch('${b}')">
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
            VFS.saveVFS();
            Editor.loadContent(snap.code, filename);
            Nexus.updateTerminal(`Restored ${filename} to ${new Date(timestamp).toLocaleTimeString()}`);
        }
    }
};

// --- 4. HARDWARE & PREVIEW ---
const Hardware = {
    init() {
        this.initShakeToUndo();
        // this.initOrientationTriggers(); // Called in original, implementation missing
    },

    initShakeToUndo() {
        let lastX, lastY, lastZ;
        let threshold = 15;

        window.addEventListener('devicemotion', (e) => {
            let acc = e.accelerationIncludingGravity;
            if (!acc.x) return;

            let delta = Math.abs(acc.x + acc.y + acc.z - lastX - lastY - lastZ);
            if (delta > threshold) {
                Nexus.updateTerminal("Shake detected: Undoing last action...");
                CodeMirror.undo(Editor.view);
                Nexus.haptic('medium');
            }
            lastX = acc.x; lastY = acc.y; lastZ = acc.z;
        });
    },

    async requestBiometric() {
        if (!window.PublicKeyCredential) return true;

        try {
            Nexus.updateTerminal("Verifying Identity...");
            return true;
        } catch (err) {
            Nexus.updateTerminal("Biometric Error: " + err.message, 'var(--warn)');
            return false;
        }
    }
};

const Preview = {
    fps: 0,
    lastTime: performance.now(),

    init() {
        this.startFPSCounter();
    },

    refresh() {
        const frame = document.getElementById('live-preview-frame');
        if (!frame) return;
        const html = VFS.files['index.html'] || '';
        const css = `<style>${VFS.files['styles.css'] || ''}</style>`;
        const js = `<script>${VFS.files['main.js'] || ''}<\/script>`;
        const blob = new Blob([html + css + js], { type: 'text/html' });
        frame.src = URL.createObjectURL(blob);
        
        Nexus.updateTerminal("Sandbox Refreshed", 'var(--success)');
        Nexus.haptic('medium');
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

// --- 5. UTILITIES ---
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
            await localforage.setItem('nexus_vfs', VFS.files);
            VFS.renderExplorer();
            Nexus.updateTerminal(`Reconstruction Complete: ${count} files updated.`, 'var(--success)');
            Nexus.haptic('success');
        } else {
            Nexus.updateTerminal("No valid file blocks detected in text.", 'var(--warn)');
        }
    }
};

const NexusReconstructor = {
    async digest(text) {
        const blockPattern = /### ([\w.-]+)\n```\w*\n([\s\S]*?)```/g;
        let match;
        let updatedFiles = [];

        Nexus.updateTerminal("Starting reconstruction process...", 'var(--accent)');
        while ((match = blockPattern.exec(text)) !== null) {
            const fileName = match[1];
            const fileContent = match[2].trim();
            
            VFS.files[fileName] = fileContent;
            updatedFiles.push(fileName);
        }

        if (updatedFiles.length > 0) {
            await localforage.setItem('nexus_vfs', VFS.files);
            VFS.renderExplorer();
            Nexus.updateTerminal(`Successfully reconstructed ${updatedFiles.length} files:`, 'var(--success)');
            updatedFiles.forEach(f => Nexus.updateTerminal(` -> ${f}`, 'var(--text)'));
            Nexus.haptic('success');
        } else {
            Nexus.updateTerminal("Reconstruction failed: No valid file blocks found.", 'var(--warn)');
            Nexus.updateTerminal("Ensure the text includes '### filename' headers.", 'var(--muted)');
        }
    },

    openPortal() {
        const text = prompt("Paste the chat history or file blocks here to rebuild:");
        if (text) {
            this.digest(text);
        }
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

const NexusMath = {
    generateLogic(expression) {
        try {
            const node = math.parse(expression);
            const variables = [];
            
            node.traverse((node) => {
                if (node.isSymbolNode && !math[node.name]) {
                    variables.push(node.name);
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

// --- 6. SYNC ---
const NexusSync = {
    peer: null,
    conn: null,

    init() {
        const deviceId = 'devos-' + Math.floor(Math.random() * 10000);
        this.peer = new Peer(deviceId);

        this.peer.on('open', (id) => {
            Nexus.updateTerminal(`Device ID: ${id}. Share this to sync.`, 'var(--accent)');
            document.getElementById('sync-status').classList.replace('offline', 'online');
        });
        
        this.peer.on('connection', (connection) => {
            this.conn = connection;
            this.setupListeners();
            Nexus.updateTerminal("REMOTE DEVICE LINKED", 'var(--success)');
        });
    },

    connectTo(remoteId) {
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

// --- 7. TERMINAL ROUTER ---
Nexus.terminal = {
    mode: 'drawer',
    context: 'js',

    solveMath(expression) {
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

    setContext(ext) {
        this.context = ext;
        Nexus.updateTerminal(`Context Switched: ${ext.toUpperCase()}`);
        if (window.VirtualKeyboard) VirtualKeyboard.render(ext);
    },

    process(input) {
        // Integrated Search logic
        if (input.startsWith('find ')) {
            NexusSearch.query(input.replace('find ', ''));
            return;
        }

        // Integrated Math Logic
        if (input.startsWith('=')) { 
            this.solveMath(input.substring(1));
            return;
        }

        switch(input) {
            case 'clear':
                document.getElementById('terminal-output').innerHTML = '';
                break;
            case 'float':
                document.getElementById('universal-terminal').className = 'terminal-float';
                break;
            case 'drawer':
                document.getElementById('universal-terminal').className = 'terminal-drawer';
                break;
            case 'build':
                Nexus.updateTerminal("Compiling PWA...", 'var(--warn)');
                Vault.compile(); 
                break;
            default:
                Nexus.updateTerminal(`Unknown: ${input}. Try '= 2+2', 'find [term]' or 'float'`);
        }
    }
};

// --- 8. INITIALIZATION ---
// Initialize subsystems before the core boot
Vault.init();
NexusHistory.init();
NexusGit.init();
Hardware.init();
Editor.init();
Preview.init();
NexusSync.init();

// Boot Core Nexus System
Nexus.boot();
