/* =============================================================================
   FILE: nexus.js (Omni-Merged with Sync, Injector, & Virtual Keyboard)
   ============================================================================= */

window.Nexus = {
    state: { 
        vfs: {}, 
        activeFile: "main.js", 
        cm: null,
        autoSaveTimer: null,
        diffEditorInstance: null,
        loadedSprite: null,
        fps: 0,
        lastFrameTime: performance.now()
    },

    async boot() {
        console.log("Nexus Prime: Systems Online.");
        
        const saved = await localforage.getItem('nexus_vfs_v4');
        if (saved) this.state.vfs = saved;

        window.addEventListener('cm6-ready', () => {
            this.initEditor();
            this.renderExplorer();
            this.initMobileSoftKeys(); 
            this.initSearch();
            this.initFPSTicker(); // Restored FPS Logic
            
            if (this.state.vfs[this.state.activeFile]) {
                document.getElementById('active-file-display').innerText = this.state.activeFile;
            }
            this.log("DevOS Nexus Prime Initialized.", "var(--success)");
        });
    },

    // --- Haptic Feedback (For Pixel 7 Pro) ---
    triggerHaptic(type = 'light') {
        if (!navigator.vibrate) return;
        if (type === 'light') navigator.vibrate(10);
        else if (type === 'medium') navigator.vibrate(25);
        else if (type === 'heavy') navigator.vibrate([30, 50, 30]);
    },

    // --- Layout & View Switching ---
    switchTab(tabId) {
        this.triggerHaptic('light');
        document.querySelectorAll('.tabs-ribbon .tab-btn').forEach(b => b.classList.remove('active-tab'));
        const btn = document.getElementById(`tab-btn-${tabId}`);
        if (btn) btn.classList.add('active-tab');

        document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
        const panel = document.getElementById(`${tabId}-view`);
        if (panel) panel.classList.add('active');

        if (tabId === 'intel') this.updateProjectStats();
        if (tabId === 'diagnostic') this.refreshStorageInspector();
        if (tabId === 'time') this.initDiffViewer();
 // Navigation & Sidebar Logic
function toggleLeftSidebar(state) {
    const sb = document.getElementById('ui-sidebar');
    sb.classList.toggle('open', state);
}

function toggleRightSidebar(state) {
    const rb = document.getElementById('testing-sidebar');
    rb.classList.toggle('open', state);
}

function toggleCommandPrompt() {
    const tb = document.getElementById('bottom-terminal');
    tb.classList.toggle('open');
    if (tb.classList.contains('open')) {
        document.getElementById('terminal-input').focus();
    }
}

function runTestingPanel() {
    toggleRightSidebar(true);
    if (window.Nexus) window.Nexus.refreshLivePreview(); // Triggers existing preview logic
}

// Swipe Gesture Implementation
let touchStartX = 0;
let touchStartY = 0;

document.addEventListener('touchstart', e => {
    touchStartX = e.changedTouches[0].screenX;
    touchStartY = e.changedTouches[0].screenY;
}, false);

document.addEventListener('touchend', e => {
    const touchEndX = e.changedTouches[0].screenX;
    const diffX = touchEndX - touchStartX;
    const edgeThreshold = 40; // Sensitivity for edge swipes

    // Open Left Sidebar (Swipe from left edge)
    if (touchStartX < edgeThreshold && diffX > 50) {
        toggleLeftSidebar(true);
    }
    
    // Open Testing Sidebar (Swipe from right edge)
    if (touchStartX > (window.innerWidth - edgeThreshold) && diffX < -50) {
        runTestingPanel();
    }

    // Close Sidebars (Regular swipe away from the sidebar)
    if (Math.abs(diffX) > 100) {
        if (diffX < 0) toggleLeftSidebar(false); // Swipe left closes left sidebar
        if (diffX > 0) toggleRightSidebar(false); // Swipe right closes right sidebar
    }
}, false);
       
    },

    // --- PeerJS Sync Module ---
    initSync() {
        if (!window.NexusSync) return;
        window.NexusSync.init();
    },
    connectSync() {
        const id = prompt("Enter the Host ID of the peer you want to connect to:");
        if (id && window.NexusSync) window.NexusSync.connect(id);
    },

    // --- Search & Jump ---
    initSearch() {
        const input = document.getElementById('global-search-input');
        if (!input) return;

        input.oninput = (e) => {
            const query = e.target.value.toLowerCase();
            const tree = document.getElementById('search-results-tree');
            tree.innerHTML = '';
            if (!query) return;

            Object.entries(this.state.vfs).forEach(([file, code]) => {
                const lines = code.split('\n');
                lines.forEach((line, i) => {
                    if (line.toLowerCase().includes(query)) {
                        const div = document.createElement('div');
                        div.className = 'search-hit';
                        div.innerHTML = `<span style="color:var(--accent)">${file}:${i+1}</span> ${line.trim().substring(0, 30)}`;
                        div.onclick = () => {
                            this.loadFile(file);
                            this.switchTab('editor');
                            this.toggleSidebar(false);
                            setTimeout(() => {
                                if (!this.state.cm) return;
                                try {
                                    const targetLine = this.state.cm.state.doc.line(i + 1);
                                    this.state.cm.dispatch({ selection: { anchor: targetLine.from }, scrollIntoView: true });
                                    this.state.cm.focus();
                                } catch(e) {}
                            }, 100);
                        };
                        tree.appendChild(div);
                    }
                });
            });
        };
    },

    // --- Live Preview & Sandbox Controls ---
    initFPSTicker() {
        const fpsEl = document.getElementById('fps-counter');
        const tick = () => {
            const now = performance.now();
            const delta = now - this.state.lastFrameTime;
            this.state.fps = Math.round(1000 / delta);
            this.state.lastFrameTime = now;
            if (fpsEl) fpsEl.innerText = `${this.state.fps} FPS`;
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    },

    refreshLivePreview() {
        this.triggerHaptic('medium');
        const frame = document.getElementById('live-preview-frame');
        const ghost = document.getElementById('ghost-console');
        if (!frame || !ghost) return;

        ghost.innerHTML = ''; 
        const html = this.state.vfs['index.html'] || '<div style="color:black; padding:20px;">No index.html found.</div>';
        
        let jsToLoad = "";
        if (this.state.vfs['main.js']) jsToLoad = this.state.vfs['main.js'];
        else if (this.state.activeFile && this.state.activeFile.endsWith('.js')) jsToLoad = this.state.vfs[this.state.activeFile];
        
        const injection = `<script>
            (function(){
                const ghost = window.parent.document.getElementById('ghost-console');
                function logToGhost(type, args) {
                    if(!ghost) return;
                    const div = document.createElement('div');
                    div.style.color = type === 'error' ? '#da3633' : '#3fb950';
                    div.style.borderBottom = '1px solid #333';
                    div.style.paddingBottom = '4px';
                    div.style.marginBottom = '4px';
                    const msg = Array.from(args).map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
                    div.innerText = "[" + type.toUpperCase() + "] " + msg;
                    ghost.appendChild(div);
                    ghost.scrollTop = ghost.scrollHeight;
                }
                console.log = function(){ logToGhost('log', arguments); };
                console.error = function(){ logToGhost('error', arguments); };
                console.warn = function(){ logToGhost('warn', arguments); };
                window.onerror = function(msg, url, line) { console.error("Line " + line + ": " + msg); return false; };
            })();
        <\/script>`;

        const fullHTML = `
            <!DOCTYPE html>
            <html>
            <head><style>body { margin: 0; padding: 0; font-family: sans-serif; overflow: hidden; }</style></head>
            <body>
                ${html}
                ${injection}
                <script type="module">${jsToLoad}<\/script>
            </body>
            </html>
        `;

        const blob = new Blob([fullHTML], {type: 'text/html'});
        frame.src = URL.createObjectURL(blob);
    },
    
    stopSandbox() {
        this.triggerHaptic('heavy');
        const frame = document.getElementById('live-preview-frame');
        const consoleOut = document.getElementById('ghost-console');
        if (frame) frame.src = 'about:blank';
        if (consoleOut) {
            consoleOut.innerHTML += '<div style="color:var(--gold); margin-bottom:4px;">> Sandbox execution stopped manually.</div>';
            consoleOut.scrollTop = consoleOut.scrollHeight;
        }
    },

    resizePreview(width) {
        const frame = document.getElementById('live-preview-frame');
        if (frame) {
            frame.style.width = width;
            frame.style.margin = width === '100%' ? '0' : '0 auto';
        }
    },

    // --- Diagnostics Hub ---
    runLinter() {
        if(!this.state.activeFile || !this.state.cm) return;
        const code = this.state.cm.state.doc.toString();
        const ext = this.state.activeFile.split('.').pop().toLowerCase();
        let html = '';

        if (ext === 'js') {
            if (typeof JSHINT === 'undefined') {
                document.getElementById('diagnostic-results').innerHTML = '<div style="color:var(--danger)">JSHint library failed to load.</div>';
                return;
            }
            JSHINT(code, { esversion: 11, browser: true, module: true });
            if (JSHINT.errors.length > 0) {
                JSHINT.errors.forEach(e => { if (e) html += `<div style="color:var(--danger); margin-bottom:4px;">Line ${e.line}: ${e.reason}</div>`; });
            }
        } else if (ext === 'json') {
            try { JSON.parse(code); } catch (e) { html += `<div style="color:var(--danger)">JSON Error: ${e.message}</div>`; }
        } else if (ext === 'html') {
            const parser = new DOMParser();
            const doc = parser.parseFromString(code, "text/html");
            const errors = doc.getElementsByTagName("parsererror");
            if (errors.length > 0) html += `<div style="color:var(--danger)">HTML Error: ${errors[0].innerText}</div>`;
        }
        document.getElementById('diagnostic-results').innerHTML = html || '<div style="color:var(--success)">No syntax errors found. File is clean.</div>';
    },

    runDependencyCheck() {
        let html = '';
        const importRegex = /(?:import\s+.*?from\s+['"]([^'"]+)['"])|(?:<script\s+.*?src=['"]([^'"]+)['"])|(?:<link\s+.*?href=['"]([^'"]+)['"])/g;

        for (const [fn, code] of Object.entries(this.state.vfs)) {
            let match;
            while ((match = importRegex.exec(code)) !== null) {
                let importedPath = match[1] || match[2] || match[3];
                if (importedPath.startsWith('http') || importedPath.startsWith('//')) continue;
                importedPath = importedPath.replace(/^(\.\/|\.\.\/)+/, '').replace(/^\//, '');
                
                if (!this.state.vfs[importedPath]) {
                    html += `<div style="color:var(--danger); margin-bottom:4px;">[Missing] <strong>${fn}</strong> imports: <em>${importedPath}</em></div>`;
                }
            }
        }
        document.getElementById('diagnostic-results').innerHTML = html || `<div style="color:var(--success)">Scan complete. All local dependency paths resolved.</div>`;
    },

    autoFixCurrentFile() {
        this.triggerHaptic('medium');
        if(!this.state.activeFile) return;
        const ext = this.state.activeFile.split('.').pop().toLowerCase();
        
        if (ext === 'json') {
            try {
                const looseParse = new Function('return ' + this.state.cm.state.doc.toString())();
                this.state.cm.dispatch({ changes: { from: 0, to: this.state.cm.state.doc.length, insert: JSON.stringify(looseParse, null, 4) } });
                document.getElementById('diagnostic-results').innerHTML = `<div style="color:var(--success)">Strict JSON format applied.</div>`;
                this.saveVFS();
            } catch (e) { document.getElementById('diagnostic-results').innerHTML = `<div style="color:var(--danger)">Failed to auto-fix JSON: ${e.message}</div>`; }
        } else {
            this.beautifyCode();
            document.getElementById('diagnostic-results').innerHTML = `<div style="color:var(--accent)">Auto-formatter applied.</div>`;
        }
    },

    copyDiagnostics() {
        const text = document.getElementById('diagnostic-results').innerText;
        navigator.clipboard.writeText(text).then(() => this.log("Diagnostics copied to clipboard.", "var(--success)"));
    },

    // --- Data Inspector ---
    refreshStorageInspector() {
        const container = document.getElementById('storage-inspector-ui');
        if (!container) return;
        container.innerHTML = '';
        
        const keys = Object.keys(localStorage);
        const projectKeys = keys.filter(k => !k.startsWith('devos_') && !k.startsWith('settings_') && !k.startsWith('nexus_') && k !== 'vault_snippets');
        
        if (projectKeys.length === 0) {
            container.innerHTML = '<div style="color:var(--muted); font-style:italic; font-size:12px;">No sandbox project data found in LocalStorage.</div>';
            return;
        }

        projectKeys.forEach(key => {
            const val = localStorage.getItem(key);
            const row = document.createElement('div');
            row.style.cssText = `display:flex; flex-direction:column; gap:5px; padding:10px; background:var(--bg); border:1px solid var(--border); border-radius:6px; margin-bottom:8px;`;
            row.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <strong style="color:var(--accent); font-size:13px;">${key}</strong>
                    <button class="btn-danger" style="padding:2px 6px; font-size:10px;" onclick="Nexus.deleteStorageKey('${key}')">Delete</button>
                </div>
                <textarea id="storage-val-${key}" style="width:100%; background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:4px; font-size:11px; padding:5px; height:60px; box-sizing:border-box;">${val}</textarea>
                <button class="btn-primary" style="width:100%; font-size:10px;" onclick="Nexus.updateStorageKey('${key}')">Update Value</button>
            `;
            container.appendChild(row);
        });
    },

    updateStorageKey(key) {
        const newVal = document.getElementById(`storage-val-${key}`).value;
        localStorage.setItem(key, newVal);
        this.log(`Updated storage key: ${key}`, "var(--success)");
        this.refreshLivePreview();
    },

    deleteStorageKey(key) {
        if (confirm(`Delete key "${key}"?`)) {
            localStorage.removeItem(key);
            this.refreshStorageInspector();
            this.refreshLivePreview();
            this.log(`Deleted storage key: ${key}`, "var(--warn)");
        }
    },

    openDataSeeder() {
        const seedName = prompt("Enter a name for this data pattern (e.g., 'simon_high_score'):");
        if (!seedName) return;
        const seedData = prompt("Enter the JSON or value to store:");
        if (seedData) {
            localStorage.setItem(seedName, seedData);
            this.refreshStorageInspector();
            this.refreshLivePreview();
            this.log(`Seeded data for: ${seedName}`, "var(--success)");
        }
    },

    clearLiveStorage() {
        const keys = Object.keys(localStorage);
        const projectKeys = keys.filter(k => !k.startsWith('devos_') && !k.startsWith('settings_') && !k.startsWith('nexus_') && k !== 'vault_snippets');
        if (confirm(`Wipe ALL project data (${projectKeys.length} keys)? IDE settings will remain.`)) {
            projectKeys.forEach(k => localStorage.removeItem(k));
            this.refreshStorageInspector();
            this.refreshLivePreview();
            this.log("Sandbox storage wiped.", "var(--danger)");
        }
    },

    exportStorageToJSON() {
        const data = {};
        const keys = Object.keys(localStorage).filter(k => !k.startsWith('devos_') && !k.startsWith('settings_') && !k.startsWith('nexus_') && k !== 'vault_snippets');
        keys.forEach(k => data[k] = localStorage.getItem(k));
        const blob = new Blob([JSON.stringify(data, null, 4)], {type: 'application/json'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'project_data_export.json';
        a.click();
    },

    // --- Diff Comparator ---
    initDiffViewer() {
        const selectA = document.getElementById('diff-file-a');
        const selectB = document.getElementById('diff-file-b');
        if (!selectA || !selectB) return;

        let optionsHTML = '';
        Object.keys(this.state.vfs).forEach(filename => {
            optionsHTML += `<option value="${filename}">📄 ${filename} (Live Version)</option>`;
        });
        
        selectA.innerHTML = optionsHTML;
        selectB.innerHTML = optionsHTML;
        if (selectA.options.length > 0) selectA.selectedIndex = 0;
        if (selectB.options.length > 1) selectB.selectedIndex = 1;
    },

    async executeDiff() {
        if (!window.CodeMirror || !window.CodeMirror.MergeView) {
            this.log("CodeMirror 5 MergeView not loaded.", "var(--danger)");
            return;
        }

        const fileA = document.getElementById('diff-file-a').value;
        const fileB = document.getElementById('diff-file-b').value;
        const container = document.getElementById('diff-container');
        if (!fileA || !fileB || !container) return;

        const contentA = this.state.vfs[fileA] || '';
        const contentB = this.state.vfs[fileB] || '';

        container.innerHTML = '';
        
        let mode = 'javascript';
        if (fileA.includes('.html') || fileB.includes('.html')) mode = 'htmlmixed';
        if (fileA.includes('.css') || fileB.includes('.css')) mode = 'css';

        this.state.diffEditorInstance = window.CodeMirror.MergeView(container, {
            value: contentB,       
            origLeft: null, 
            orig: contentA,        
            lineNumbers: true,
            mode: mode,
            theme: 'dracula',
            highlightDifferences: true,
            connect: 'align',
            collapseIdentical: false,
            revertButtons: false
        });

        if (this.state.diffEditorInstance.edit && this.state.diffEditorInstance.right) {
            this.state.diffEditorInstance.edit.setSize("100%", "100%");
            this.state.diffEditorInstance.right.orig.setSize("100%", "100%");
        }
    },

    updateProjectStats() {
        const container = document.getElementById('project-stats-container');
        if (!container) return;
        
        let fileCount = Object.keys(this.state.vfs).length;
        let totalBytes = JSON.stringify(this.state.vfs).length;
        
        container.innerHTML = `
            <div style="background:var(--surface); padding:15px; border-radius:8px; border:1px solid var(--border);">
                <div style="color:var(--accent); font-weight:bold; margin-bottom:10px;">VFS Telemetry</div>
                <div>Total Files: <span style="color:white">${fileCount}</span></div>
                <div>Storage Footprint: <span style="color:white">${(totalBytes / 1024).toFixed(2)} KB</span></div>
                <div>Active Buffer: <span style="color:white">${this.state.activeFile}</span></div>
            </div>
        `;
    },

    // --- Editor & Upgraded Soft Keys ---
    initEditor() {
        const parent = document.getElementById('editor-wrapper');
        if (!parent || !window.CM6) return;

        this.state.cm = new window.CM6.EditorView({
            doc: this.state.vfs[this.state.activeFile] || "// Nexus Codebase\n",
            extensions: [
                window.CM6.basicSetup, 
                window.CM6.oneDark, 
                window.CM6.javascript(),
                window.CM6.EditorView.updateListener.of((v) => {
                    if (v.docChanged && this.state.activeFile) {
                        this.state.vfs[this.state.activeFile] = v.state.doc.toString();
                        clearTimeout(this.state.autoSaveTimer);
                        this.state.autoSaveTimer = setTimeout(() => this.saveVFS(), 1500);
                    }
                })
            ],
            parent: parent
        });
    },

    initMobileSoftKeys() {
        const kb = document.getElementById('mobile-soft-keys');
        if (!kb) return;
        kb.innerHTML = '';
        
        const keys = ['{', '}', '(', ')', '[', ']', ';', '=>', '"', "'", '=', '+', '-', ':', '===', '!=='];
        const tripleKeys = [...keys, ...keys, ...keys]; 
        
        tripleKeys.forEach(key => {
            const btn = document.createElement('button');
            btn.className = 'soft-key';
            btn.innerText = key;
            btn.onclick = () => {
                this.triggerHaptic('light');
                this.insertSoftKey(key);
            };
            kb.appendChild(btn);
        });

        kb.onscroll = () => {
            const itemWidth = 55; 
            const totalWidth = keys.length * itemWidth;
            if (kb.scrollLeft >= totalWidth * 2) kb.scrollLeft = totalWidth; 
            else if (kb.scrollLeft <= 0) kb.scrollLeft = totalWidth; 
        };

        setTimeout(() => kb.scrollLeft = keys.length * 55, 100);
    },

    insertSoftKey(key) {
        if (!this.state.cm) return;
        const pos = this.state.cm.state.selection.main.head;
        this.state.cm.dispatch({
            changes: { from: pos, insert: key },
            selection: { anchor: pos + key.length }
        });
        this.state.cm.focus();
    },

    // --- Visual Labs Integration ---
    generateStateMachine() {
        const name = prompt("Enter Machine Name (e.g. 'SlotState'):");
        if (!name) return;
        const code = `class ${name}Machine {\n    constructor() {\n        this.state = 'IDLE';\n    }\n    transition(newState) {\n        console.log(\`Transition: \${this.state} -> \${newState}\`);\n        this.state = newState;\n    }\n}\nexport default new ${name}Machine();`;
        this.state.vfs[`${name.toLowerCase()}-machine.js`] = code;
        this.saveVFS();
        this.renderExplorer();
        this.loadFile(`${name.toLowerCase()}-machine.js`);
        this.switchTab('editor');
        this.log("State Machine generated.", "var(--success)");
    },

    handleSpriteUpload(e) {
        const file = e.target.files[0];
        const reader = new FileReader();
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                this.state.loadedSprite = img;
                const canvas = document.getElementById('sprite-canvas-tool');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                this.log(`Sprite loaded: ${img.width}x${img.height}`, "var(--success)");
            };
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);
    },

    generateSpriteCSS() {
        if (!this.state.loadedSprite) return alert("Upload a sprite sheet first.");
        const w = parseInt(document.getElementById('sprite-w').value) || 32;
        const h = parseInt(document.getElementById('sprite-h').value) || 32;
        
        let css = `.sprite {\n    background-image: url('YOUR_IMAGE_HERE');\n    display: inline-block;\n    width: ${w}px;\n    height: ${h}px;\n}\n`;
        const cols = Math.floor(this.state.loadedSprite.width / w);
        const rows = Math.floor(this.state.loadedSprite.height / h);
        
        let index = 0;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                css += `.sprite-${index} { background-position: -${c * w}px -${r * h}px; }\n`;
                index++;
            }
        }
        
        this.state.vfs['sprites.css'] = css;
        this.saveVFS();
        this.renderExplorer();
        this.loadFile('sprites.css');
        this.switchTab('editor');
        this.log("Sprite CSS generated and saved.", "var(--success)");
    },

    // --- UI Helpers ---
    toggleCMD() {
        this.triggerHaptic('light');
        const panel = document.getElementById('cmd-panel');
        if (panel) panel.style.bottom = panel.style.bottom === '0px' ? '-400px' : '0px';
    },

    runCMD() {
        this.triggerHaptic('medium');
        const code = document.getElementById('cmd-input').value;
        if (!code) return;
        try {
            const result = new Function(code).bind(this)();
            this.log(`Result: ${result || 'Success'}`, "var(--success)");
        } catch (e) {
            this.log(`Script Error: ${e.message}`, "var(--danger)");
        }
    },

    log(msg, color = "var(--text)") { console.log(`[Nexus] ${msg}`); },
    showModal(title, html) {
        const overlay = document.getElementById('modal-overlay');
        document.getElementById('modal-title').innerText = title;
        document.getElementById('modal-body').innerHTML = html;
        overlay.style.display = 'flex';
    },
    closeModal() {
        const overlay = document.getElementById('modal-overlay');
        if (overlay) overlay.style.display = 'none';
    },
    toggleSidebar(force) {
        this.triggerHaptic('light');
        const s = document.getElementById('sidebar');
        if (s) s.classList.toggle('active', force);
    },

    // --- Explorer & VFS ---
    renderExplorer() {
        const exp = document.getElementById('explorer');
        if (!exp) return;
        const keys = Object.keys(this.state.vfs);
        if (keys.length === 0) {
            exp.innerHTML = `<div style="padding:20px; text-align:center; font-size:11px; opacity:0.5;">EXPLORER EMPTY</div>`;
            return;
        }

        exp.innerHTML = keys.map(name => `
            <div style="padding:10px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; cursor:pointer;" onclick="Nexus.loadFile('${name}')">
                <span style="color:${this.state.activeFile === name ? 'var(--success)' : 'var(--text)'}; word-break: break-all; font-size: 12px;">${name}</span>
                <button onclick="event.stopPropagation(); Nexus.deleteFile('${name}')" style="background:none; border:none; color:var(--danger); cursor:pointer;">🗑️</button>
            </div>
        `).join('');
    },

    loadFile(filename) {
        this.triggerHaptic('light');
        if (this.state.vfs[filename] === undefined) return;
        this.state.activeFile = filename;
        if (this.state.cm) {
            this.state.cm.dispatch({
                changes: { from: 0, to: this.state.cm.state.doc.length, insert: this.state.vfs[filename] }
            });
        }
        this.toggleSidebar(false);
        this.renderExplorer();
        const display = document.getElementById('active-file-display');
        if (display) display.innerText = filename;
    },

    deleteFile(filename) {
        if (confirm(`Delete ${filename}?`)) {
            this.triggerHaptic('heavy');
            delete this.state.vfs[filename];
            if (this.state.activeFile === filename) this.loadFile("main.js");
            this.renderExplorer();
            this.saveVFS();
        }
    },

    async saveVFS() {
        await localforage.setItem('nexus_vfs_v4', this.state.vfs);
        if (window.NexusSync && window.NexusSync.pushState) window.NexusSync.pushState();
    },

    clearWorkspace() {
        if (confirm("Permanently wipe all files and data?")) {
            this.triggerHaptic('heavy');
            localforage.clear().then(() => {
                this.state.vfs = {};
                this.state.activeFile = null;
                if (this.state.cm) {
                    this.state.cm.dispatch({ changes: { from: 0, to: this.state.cm.state.doc.length, insert: "" } });
                }
                this.renderExplorer();
                const display = document.getElementById('active-file-display');
                if (display) display.innerText = "No File Selected";
                this.saveVFS();
                this.toggleSidebar(false);
            });
        }
    },

    // --- Component & Build Utilities ---
    exportForAI() {
        this.triggerHaptic('medium');
        let output = "DevOS Project Context\n\n";
        for (const [name, code] of Object.entries(this.state.vfs)) {
            output += `\n--- File: ${name} ---\n${code}\n`;
        }
        const blob = new Blob([output], { type: "text/plain" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "Nexus_AI_Context.txt";
        a.click();
    },

    beautifyCode() {
        this.triggerHaptic('medium');
        if (!this.state.activeFile || !this.state.cm) return;
        const code = this.state.cm.state.doc.toString();
        const ext = this.state.activeFile.split('.').pop().toLowerCase();
        let formatted = code;
        try {
            if (ext === 'js' || ext === 'json') formatted = js_beautify(code, { indent_size: 4, space_in_empty_paren: true });
            else if (ext === 'html') formatted = html_beautify(code, { indent_size: 4, wrap_line_length: 120 });
            else if (ext === 'css') formatted = css_beautify(code, { indent_size: 4 });
            if (formatted !== code) {
                this.state.cm.dispatch({ changes: { from: 0, to: code.length, insert: formatted } });
                this.saveVFS();
            }
        } catch (err) { console.error(err); }
    },

    generateComponent() {
        const name = prompt("Enter Component Name (e.g. 'BetSelector'):");
        if (!name) return;
        this.triggerHaptic('medium');
        const lowerName = name.toLowerCase();
        this.state.vfs[`${lowerName}.html`] = `<div id="${lowerName}-container">\n    \n</div>`;
        this.state.vfs[`${lowerName}.js`] = `// ${name} Logic\nfunction init${name}() {\n    console.log('${name} Initialized');\n}`;
        this.state.vfs[`${lowerName}.css`] = `#${lowerName}-container {\n    padding: 10px;\n}`;
        this.saveVFS();
        this.renderExplorer();
        this.loadFile(`${lowerName}.js`);
        this.switchTab('editor');
    },

    async downloadProjectZip() {
        this.triggerHaptic('medium');
        if (!window.JSZip) return alert("JSZip not loaded.");
        const zip = new JSZip();
        Object.keys(this.state.vfs).forEach(filename => zip.file(filename, this.state.vfs[filename]));
        const blob = await zip.generateAsync({ type: "blob" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'DevOS-Project.zip';
        a.click();
    },

    async minifyJS(code) {
        if (typeof Terser === 'undefined') return code;
        try {
            const result = await Terser.minify(code, {
                mangle: true,
                compress: { dead_code: true, drop_console: false, drop_debugger: true }
            });
            return result.code;
        } catch (err) { throw err; }
    },

    async buildForProduction() {
        this.triggerHaptic('heavy');
        if (!window.JSZip) return alert("JSZip not loaded.");
        this.log("Starting Production Build...", "var(--gold)");
        const zip = new JSZip();
        const buildFolder = zip.folder("production_build");
        const jsFiles = Object.keys(this.state.vfs).filter(f => f.endsWith('.js'));
        const cssFiles = Object.keys(this.state.vfs).filter(f => f.endsWith('.css'));
        const otherFiles = Object.keys(this.state.vfs).filter(f => !f.endsWith('.js') && !f.endsWith('.css'));

        for (const file of jsFiles) {
            try {
                const minified = await this.minifyJS(this.state.vfs[file]);
                buildFolder.file(file, minified);
            } catch (err) { buildFolder.file(file, this.state.vfs[file]); }
        }
        for (const file of cssFiles) {
            const minifiedCss = this.state.vfs[file].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
            buildFolder.file(file, minifiedCss);
        }
        for (const file of otherFiles) buildFolder.file(file, this.state.vfs[file]);

        const content = await zip.generateAsync({ type: "blob" });
        const url = URL.createObjectURL(content);
        const a = document.createElement("a");
        a.href = url; a.download = `DevOS_Build_${Date.now()}.zip`;
        a.click();
        this.log("Production Build Downloaded.", "var(--success)");
    },

    async loadZipToVFS(file) {
        if (!file) return;
        this.triggerHaptic('medium');
        if (!window.JSZip) return alert("JSZip not loaded.");
        try {
            const zip = new JSZip();
            const contents = await zip.loadAsync(file);
            const promises = [];
            contents.forEach((relativePath, zipEntry) => {
                if (!zipEntry.dir && !relativePath.includes('__MACOSX')) {
                    promises.push(zipEntry.async('string').then(text => { this.state.vfs[relativePath] = text; }));
                }
            });
            await Promise.all(promises);
            this.renderExplorer();
            this.saveVFS();
        } catch (err) { alert(err.message); }
    },

    openAdvancedMerger() {
        this.triggerHaptic('light');
        const vfsFiles = Object.keys(this.state.vfs).filter(f => f.endsWith('.js') || f.endsWith('.mjs'));
        let fileListHtml = vfsFiles.length > 0 
            ? vfsFiles.map(f => `<div style="padding:8px; border-bottom:1px solid var(--border);"><label style="display:flex; align-items:center; gap:10px;"><input type="checkbox" class="merger-checkbox" value="${f}"> ${f}</label></div>`).join('')
            : '<div style="padding:10px; color:var(--danger);">No JS files found.</div>';

        const html = `<div style="display:flex; flex-direction:column; gap:10px;"><div style="background:#000; border-radius:6px; max-height:220px; overflow-y:auto;">${fileListHtml}</div><input type="text" id="merger-output-name" placeholder="bundled.js" style="padding:10px; background:#000; color:white; border:1px solid var(--border);"><button class="btn-purple" style="padding:10px;" onclick="Nexus.executeMerge()">Merge Selected</button><div id="merger-status"></div></div>`;
        this.showModal("📦 PWA Studio Merger", html);
    },

    async executeMerge() {
        this.triggerHaptic('medium');
        const checkboxes = document.querySelectorAll('.merger-checkbox:checked');
        const selectedFiles = Array.from(checkboxes).map(cb => cb.value);
        let outName = document.getElementById('merger-output-name').value.trim() || 'merged-bundle.js';
        const statusEl = document.getElementById('merger-status');
        if (selectedFiles.length < 2) return;
        
        statusEl.innerText = "Merging...";
        try {
            const memoryPlugin = { name: 'nexus-vfs', resolveId: (id) => id, load: (id) => this.state.vfs[id] || null };
            const entry = selectedFiles.map(p => `import './${p}';`).join('\n');
            this.state.vfs['__temp_entry__.js'] = entry;
            const bundle = await window.rollup.rollup({ input: '__temp_entry__.js', plugins: [memoryPlugin] });
            const { output } = await bundle.generate({ format: 'es' });
            this.state.vfs[outName] = output[0].code;
            delete this.state.vfs['__temp_entry__.js'];
            this.renderExplorer();
            this.loadFile(outName);
            this.saveVFS();
            this.closeModal();
        } catch (err) { statusEl.innerText = err.message; }
    }
};

/* --- Sync & Injector --- */
window.NexusSync = {
    peer: null, conn: null, isSyncing: false,
    init() {
        if (!window.Peer) return;
        this.peer = new Peer(); 
        this.peer.on('open', (id) => alert(`Host ID: ${id}`));
        this.peer.on('connection', (c) => { this.conn = c; this.setup(); });
    },
    connect(id) {
        if (!this.peer) this.peer = new Peer(); 
        this.peer.on('open', () => { this.conn = this.peer.connect(id); this.conn.on('open', () => this.setup()); });
    },
    setup() {
        this.conn.on('data', (d) => {
            if (d.type === 'vfs_sync') {
                this.isSyncing = true;
                window.Nexus.state.vfs = d.vfs;
                window.Nexus.renderExplorer();
                setTimeout(() => { this.isSyncing = false; }, 100);
            }
        });
    },
    pushState() { if (this.conn && !this.isSyncing) this.conn.send({ type: 'vfs_sync', vfs: window.Nexus.state.vfs }); }
};

window.CodeInjector = class CodeInjector {
    static inject(current, patch, anchor) {
        const sm = `// START: ${anchor}`, em = `// END: ${anchor}`;
        const si = current.indexOf(sm), ei = current.indexOf(em);
        if (si === -1 || ei === -1) return { error: "Markers not found", content: current };
        const pre = current.substring(0, si + sm.length), post = current.substring(ei);
        return { status: "SUCCESS", content: `${pre}\n${patch}\n${post}` };
    }
};
