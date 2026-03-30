/* =============================================================================
   FILE: nexus.js (Omni-Merged & Refactored)
   DESCRIPTION: Core Engine for DevOS Nexus Prime PWA
   ============================================================================= */

// --- 1. DEVOS SENTINEL ENGINE (Static Analysis) ---
class DevOSSentinel {
    constructor() {
        this.registry = [];
        this.declarations = new Map();
        this.references = new Set();
        this.initDefaultCheckers();
    }

    initDefaultCheckers() {
        // Logic & Critical Flow
        this.use((node) => {
            if (['WhileStatement', 'ForStatement'].includes(node.type)) {
                if (node.test?.value === true && !this.findInNode(node.body, 'BreakStatement')) {
                    return { id: 'INF_LOOP', message: "Infinite Loop: No break found.", severity: 'CRITICAL' };
                }
            }
        });

        // Recursion Guard
        this.use((node, parent, context) => {
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
        });

        // Security: Hardcoded Secrets
        this.use((node) => {
            if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
                const name = node.id.name.toLowerCase();
                const val = node.init?.value;
                if ((name.includes('key') || name.includes('secret')) && typeof val === 'string' && val.length > 10) {
                    return { id: 'SEC_LEAK', message: `Secret Leak: Hardcoded '${node.id.name}'.`, severity: 'HIGH' };
                }
            }
        });

        // UI Performance: Async Loops
        this.use((node, parent, context) => {
            if ((node.type === 'FunctionDeclaration' || node.type === 'ArrowFunctionExpression') && node.async) context.inAsync = true;
            if (context?.inAsync && ['WhileStatement', 'ForStatement'].includes(node.type)) {
                if (!this.findInNode(node.body, 'AwaitExpression')) {
                    return { id: 'ASYNC_FREEZE', message: "UI Thread Alert: Async loop missing 'await'.", severity: 'CRITICAL' };
                }
            }
        });

        // Zombie Code Detection
        this.use((node) => {
            if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') this.declarations.set(node.id.name, node);
            if (node.type === 'FunctionDeclaration' && node.id) this.declarations.set(node.id.name, node);
        });

        this.use((node, parent) => {
            if (node.type === 'Identifier') {
                const isUsage = parent && !['VariableDeclarator', 'FunctionDeclaration'].includes(parent.type) &&
                                !(parent.type === 'MemberExpression' && parent.property === node);
                if (isUsage) this.references.add(node.name);
            }
        });
    }

    use(checkerFunc) { this.registry.push(checkerFunc); }

    analyze(code) {
        this.declarations.clear();
        this.references.clear();
        const issues = [];
        let ast;
        try {
            ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'module', locations: true });
        } catch (e) {
            return [{ message: `Syntax Error: ${e.message}`, line: e.loc?.line, severity: 'FATAL' }];
        }
        const context = { inAsync: false, currentFunctionName: null };
        this.traverse(ast, (node, parent) => {
            this.registry.forEach(check => {
                const result = check(node, parent, context);
                if (result) issues.push({ ...result, line: node.loc?.start.line });
            });
        });
        for (const [name, node] of this.declarations) {
            if (!this.references.has(name)) {
                issues.push({ id: 'ZOMBIE_CODE', message: `Unused variable: '${name}'.`, severity: 'LOW', line: node.loc?.start.line });
            }
        }
        return issues;
    }

    traverse(node, callback, parent = null) {
        if (!node) return;
        node.parent = parent; 
        callback(node, parent);
        for (const key in node) {
            const child = node[key];
            if (child && typeof child === 'object') {
                if (Array.isArray(child)) child.forEach(c => this.traverse(c, callback, node));
                else this.traverse(child, callback, node);
            }
        }
    }

    findInNode(node, type) {
        let found = false;
        this.traverse(node, (n) => { if (n.type === type) found = true; });
        return found;
    }
}

// --- 2. NEXUS CORE OBJECT ---
window.Nexus = {
    state: { 
        vfs: {}, 
        activeFile: "main.js", 
        cm: null,
        sentinel: new DevOSSentinel(),
        autoSaveTimer: null,
        fps: 0,
        lastFrameTime: performance.now(),
        touchStart: { x: 0, y: 0 }
    },

    async boot() {
        console.log("Nexus Prime: Systems Online.");
        
        // Load Data
        const saved = await localforage.getItem('nexus_vfs_v4');
        if (saved) this.state.vfs = saved;

        // Initialize UI
        this.initEditor();
        this.initGestures();
        this.initMobileSoftKeys();
        this.initFPSTicker();
        this.renderExplorer();
        this.initSearch();

        // Load Default File
        if (this.state.vfs[this.state.activeFile]) {
            this.loadFile(this.state.activeFile);
        }

        this.log("DevOS Nexus Prime Initialized.", "var(--success)");
    },

    // --- System Utilities ---
    log(msg, color = "var(--text)") {
        console.log(`%c[Nexus] ${msg}`, `color: ${color}`);
    },

    triggerHaptic(type = 'light') {
        if (!navigator.vibrate) return;
        const patterns = { light: 10, medium: 25, heavy: [30, 50, 30] };
        navigator.vibrate(patterns[type] || 10);
    },

    // --- Layout & View Control ---
    switchTab(tabId) {
        this.triggerHaptic('light');
        
        // Update Ribbon
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active-tab'));
        const btn = document.getElementById(`tab-btn-${tabId}`);
        if (btn) btn.classList.add('active-tab');

        // Update Panel
        document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
        const panel = document.getElementById(`${tabId}-view`);
        if (panel) panel.classList.add('active');

        // Contextual Refresh
        if (tabId === 'intel') this.updateProjectStats();
        if (tabId === 'diagnostic') this.refreshStorageInspector();
        if (tabId === 'time') this.initDiffViewer();
        if (this.state.cm) this.state.cm.focus();
    },

    toggleSidebar(force) {
        const s = document.getElementById('sidebar') || document.getElementById('ui-sidebar');
        if (s) s.classList.toggle('open', force);
    },

    // --- Gesture Engine ---
    initGestures() {
        document.addEventListener('touchstart', e => {
            this.state.touchStart.x = e.changedTouches[0].screenX;
            this.state.touchStart.y = e.changedTouches[0].screenY;
        }, { passive: true });

        document.addEventListener('touchend', e => {
            const diffX = e.changedTouches[0].screenX - this.state.touchStart.x;
            const threshold = 60;

            // Edge Swipes
            if (this.state.touchStart.x < 40 && diffX > threshold) this.toggleSidebar(true);
            if (this.state.touchStart.x > (window.innerWidth - 40) && diffX < -threshold) this.refreshLivePreview();

            // Generic Side Closures
            if (Math.abs(diffX) > 100) {
                if (diffX < 0) this.toggleSidebar(false);
            }
        }, { passive: true });
    },

    // --- VFS & Editor Logic ---
    initEditor() {
        const wrapper = document.getElementById('editor-wrapper');
        if (!wrapper || !window.CM6) return;

        this.state.cm = new window.CM6.EditorView({
            doc: this.state.vfs[this.state.activeFile] || "",
            extensions: [
                window.CM6.basicSetup, 
                window.CM6.oneDark, 
                window.CM6.javascript(),
                window.CM6.EditorView.updateListener.of((v) => {
                    if (v.docChanged) {
                        this.state.vfs[this.state.activeFile] = v.state.doc.toString();
                        clearTimeout(this.state.autoSaveTimer);
                        this.state.autoSaveTimer = setTimeout(() => this.saveVFS(), 1500);
                    }
                })
            ],
            parent: wrapper
        });
    },

    async loadFile(filename) {
        if (!this.state.vfs[filename] && this.state.vfs[filename] !== "") return;
        this.state.activeFile = filename;
        this.state.cm.dispatch({
            changes: { from: 0, to: this.state.cm.state.doc.length, insert: this.state.vfs[filename] }
        });
        document.getElementById('active-file-display').innerText = filename;
        this.renderExplorer();
    },

    async saveVFS() {
        await localforage.setItem('nexus_vfs_v4', this.state.vfs);
        if (window.NexusSync) window.NexusSync.pushState();
    },
Nexus.TerminalEngine = {
    // Standard File System Commands
    commands: {
        // Create an empty file: touch index.html
        touch: (args) => {
            const fileName = args[0];
            if (!fileName) return "Usage: touch <filename>";
            if (Nexus.state.vfs[fileName]) return `Error: ${fileName} already exists.`;
            Nexus.state.vfs[fileName] = "";
            Nexus.renderExplorer();
            Nexus.saveVFS();
            return `File ${fileName} created.`;
        },

        // Delete a file: rm temp.js
        rm: (args) => {
            const fileName = args[0];
            if (!fileName || !Nexus.state.vfs[fileName]) return "Error: File not found.";
            delete Nexus.state.vfs[fileName];
            Nexus.renderExplorer();
            Nexus.saveVFS();
            return `File ${fileName} removed permanently.`;
        },

        // Write to file: echo "console.log('hi')" > main.js
        // Append to file: echo "// comment" >> main.js
        echo: (args) => {
            const raw = args.join(' ');
            const mode = raw.includes(' >> ') ? 'append' : raw.includes(' > ') ? 'write' : null;
            if (!mode) return "Usage: echo 'content' > filename";

            const parts = raw.split(mode === 'append' ? ' >> ' : ' > ');
            const content = parts[0].replace(/['"]/g, '').trim();
            const fileName = parts[1].trim();

            if (mode === 'write') {
                Nexus.state.vfs[fileName] = content;
            } else {
                Nexus.state.vfs[fileName] = (Nexus.state.vfs[fileName] || "") + "\n" + content;
            }

            if (Nexus.state.activeFile === fileName) Nexus.loadFile(fileName);
            Nexus.saveVFS();
            return `Updated ${fileName}.`;
        },

        // Execute a JS file as a system script: run update_ui.js
        run: async (args) => {
            const fileName = args[0];
            const script = Nexus.state.vfs[fileName];
            if (!script) return `Error: Script '${fileName}' not found.`;

            try {
                // We wrap the script in an async function and provide 'Nexus' as a local variable
                const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
                const execute = new AsyncFunction('Nexus', script);
                await execute(Nexus);
                return `Script '${fileName}' executed successfully.`;
            } catch (err) {
                return `Script Error: ${err.message}`;
            }
        },

        // The Nuke Command from earlier
        nuke: async () => {
            if (confirm("☢️ NUCLEAR OVERRIDE: Clear all system data?")) {
                // Call the systemNuke function we defined previously
                await systemNuke(); 
                return "System wiped.";
            }
            return "Nuke aborted.";
        }
    },

    async exec(rawInput) {
        const [cmd, ...args] = rawInput.trim().split(/\s+/);
        if (this.commands[cmd]) {
            return await this.commands[cmd](args);
        }
        return `Unknown command: ${cmd}`;
    }
};

    // --- Diagnostic Hub ---
    runSentinel() {
        if (!this.state.activeFile.endsWith('.js')) return alert("Sentinel only scans JS.");
        
        this.triggerHaptic('medium');
        const code = this.state.cm.state.doc.toString();
        const results = this.state.sentinel.analyze(code);
        const container = document.getElementById('sentinel-results');
        
        if (results.length === 0) {
            container.innerHTML = `<div style="color:var(--success)">✅ Clean: No risks detected.</div>`;
            return;
        }

        container.innerHTML = results.map(issue => `
            <div class="sentinel-issue" onclick="Nexus.goToLine(${issue.line})" style="border-left: 3px solid var(--danger); padding:8px; margin-bottom:5px; background:#111; cursor:pointer;">
                <small style="color:var(--accent)">Line ${issue.line}</small>
                <div>${issue.message}</div>
            </div>
        `).join('');
    },

    goToLine(line) {
        try {
            const pos = this.state.cm.state.doc.line(line).from;
            this.state.cm.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
            this.state.cm.focus();
            this.switchTab('editor');
        } catch(e) {}
    },

    // --- Live Preview ---
    refreshLivePreview() {
        this.triggerHaptic('medium');
        const frame = document.getElementById('live-preview-frame');
        if (!frame) return;

        const html = this.state.vfs['index.html'] || "<h1>No index.html</h1>";
        const js = this.state.vfs['main.js'] || "";
        
        const blob = new Blob([`
            <html>
                <body>${html}</body>
                <script type="module">${js}<\/script>
            </html>
        `], { type: 'text/html' });
        
        frame.src = URL.createObjectURL(blob);
        this.switchTab('preview');
    },

    // --- Mobile Interface ---
    initMobileSoftKeys() {
        const kb = document.getElementById('mobile-soft-keys');
        if (!kb) return;
        const keys = ['{', '}', '(', ')', '[', ']', ';', '=>', '"', "'", '=', '+', ':', '?', '!', '/'];
        kb.innerHTML = keys.map(k => `<button class="soft-key" onclick="Nexus.insertSoftKey('${k}')">${k}</button>`).join('');
    },

    insertSoftKey(key) {
        if (!this.state.cm) return;
        this.triggerHaptic('light');
        const pos = this.state.cm.state.selection.main.head;
        this.state.cm.dispatch({
            changes: { from: pos, insert: key },
            selection: { anchor: pos + key.length }
        });
        this.state.cm.focus();
    },

    initFPSTicker() {
        const fpsEl = document.getElementById('fps-counter');
        const tick = () => {
            const now = performance.now();
            this.state.fps = Math.round(1000 / (now - this.state.lastFrameTime));
            this.state.lastFrameTime = now;
            if (fpsEl) fpsEl.innerText = `${this.state.fps} FPS`;
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }
};

// --- 3. PEER SYNC MODULE ---
window.NexusSync = {
    peer: null, 
    conn: null,
    init() {
        if (!window.Peer) return;
        this.peer = new Peer();
        this.peer.on('open', id => console.log("Sync ID:", id));
        this.peer.on('connection', c => { this.conn = c; this.listen(); });
    },
    listen() {
        this.conn.on('data', data => {
            if (data.type === 'vfs_sync') {
                window.Nexus.state.vfs = data.vfs;
                window.Nexus.renderExplorer();
            }
        });
    },
    pushState() {
        if (this.conn) this.conn.send({ type: 'vfs_sync', vfs: window.Nexus.state.vfs });
    }
};

// Start Kernel
window.addEventListener('DOMContentLoaded', () => window.Nexus.boot());
