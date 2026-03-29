/* =============================================================================
   FILE: nexus.js (Omni-Merged & Multi-Pane)
   ============================================================================= */

window.Nexus = {
    state: { 
        vfs: {}, 
        activeFile: "main.js", 
        cm: null,
        autoSaveTimer: null,
        diffEditorInstance: null
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
            
            if (this.state.vfs[this.state.activeFile]) {
                document.getElementById('active-file-display').innerText = this.state.activeFile;
            }
            this.log("DevOS Nexus Prime Initialized.", "var(--success)");
        });
    },

    // --- Layout & View Switching ---
    switchTab(tabId) {
        document.querySelectorAll('.tabs-ribbon .tab-btn').forEach(b => b.classList.remove('active-tab'));
        const btn = document.getElementById(`tab-btn-${tabId}`);
        if (btn) btn.classList.add('active-tab');

        document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
        const panel = document.getElementById(`${tabId}-view`);
        if (panel) panel.classList.add('active');

        // Context-Aware Hooks for the new features
        if (tabId === 'intel') this.updateProjectStats();
        if (tabId === 'diagnostic') this.refreshStorageInspector();
        if (tabId === 'time') this.initDiffViewer();
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

    // --- Live Preview & Ghost Console ---
    refreshLivePreview() {
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
            <head><style>body { margin: 0; padding: 0; font-family: sans-serif; }</style></head>
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
        const frame = document.getElementById('live-preview-frame');
        const consoleOut = document.getElementById('ghost-console');
        if (frame) frame.src = 'about:blank';
        if (consoleOut) {
            consoleOut.innerHTML += '<div style="color:var(--warn); margin-bottom:4px;">> Sandbox execution stopped manually.</div>';
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
        let missingCount = 0;
        const importRegex = /(?:import\s+.*?from\s+['"]([^'"]+)['"])|(?:<script\s+.*?src=['"]([^'"]+)['"])|(?:<link\s+.*?href=['"]([^'"]+)['"])/g;

        for (const [fn, code] of Object.entries(this.state.vfs)) {
            let match;
            while ((match = importRegex.exec(code)) !== null) {
                let importedPath = match[1] || match[2] || match[3];
                if (importedPath.startsWith('http') || importedPath.startsWith('//')) continue;
                importedPath = importedPath.replace(/^(\.\/|\.\.\/)+/, '').replace(/^\//, '');
                
                if (!this.state.vfs[importedPath]) {
                    html += `<div style="color:var(--danger); margin-bottom:4px;">[Missing] <strong>${fn}</strong> imports: <em>${importedPath}</em></div>`;
                    missingCount++;
                }
            }
        }
        document.getElementById('diagnostic-results').innerHTML = html || `<div style="color:var(--success)">Scan complete. All local dependency paths resolved.</div>`;
    },

    autoFixCurrentFile() {
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

    // --- REINCORPORATED: Data Inspector (data-tools.js) ---
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

    // --- REINCORPORATED: Diff Comparator (diff.js) ---
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
            value: contentB,       // Modified version goes on the Right
            origLeft: null, 
            orig: contentA,        // Original version goes on the Left
            lineNumbers: true,
            mode: mode,
            theme: 'dracula',
            highlightDifferences: true,
            connect: 'align',
            collapseIdentical: false,
            revertButtons: false
        });

        // Ensure proper sizing within flexbox
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

    // --- Editor & Soft Keys ---
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
        const container = document.getElementById('mobile-soft-keys');
        if (!container) return;
        
        const keys = ['{', '}', '(', ')', '[', ']', ';', '=>', '"', "'", '=', '+', '-'];
        container.innerHTML = keys.map(k => `
            <button class="soft-key" onclick="Nexus.insertSoftKey('${k}')">${k}</button>
        `).join('');
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

    // --- UI Helpers ---
    toggleCMD() {
        const panel = document.getElementById('cmd-panel');
        if (panel) panel.style.bottom = panel.style.bottom === '0px' ? '-400px' : '0px';
    },

    runCMD() {
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
            delete this.state.vfs[filename];
            if (this.state.activeFile === filename) this.loadFile("main.js");
            this.renderExplorer();
            this.saveVFS();
        }
    },

    async saveVFS() {
        await localforage.setItem('nexus_vfs_v4', this.state.vfs);
    },

    clearWorkspace() {
        if (confirm("Permanently wipe all files and data? This cannot be undone.")) {
            localforage.clear().then(() => {
                this.state.vfs = {};
                this.state.activeFile = null;
                if (this.state.cm) {
                    this.state.cm.dispatch({ changes: { from: 0, to: this.state.cm.state.doc.length, insert: "// Workspace wiped.\\n" } });
                }
                this.renderExplorer();
                const display = document.getElementById('active-file-display');
                if (display) display.innerText = "No File Selected";
                this.saveVFS();
                this.toggleSidebar(false);
            });
        }
    },

    // --- Utilities ---
    exportForAI() {
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
        } catch (err) {
            console.error(`Format Error: ${err.message}`);
        }
    },

    // --- REINCORPORATED: Component Generator (build-tools.js) ---
    generateComponent() {
        const name = prompt("Enter Component Name (e.g. 'BetSelector'):");
        if (!name) return;
        const lowerName = name.toLowerCase();
        
        this.state.vfs[`${lowerName}.html`] = `<div id="${lowerName}-container">\n    \n</div>`;
        this.state.vfs[`${lowerName}.js`] = `// ${name} Logic\nfunction init${name}() {\n    console.log('${name} Initialized');\n}`;
        this.state.vfs[`${lowerName}.css`] = `#${lowerName}-container {\n    padding: 10px;\n}`;

        this.saveVFS();
        this.renderExplorer();
        this.loadFile(`${lowerName}.js`);
        this.switchTab('editor');
        this.log(`Component ${name} generated.`, "var(--success)");
    },

    // --- REINCORPORATED: Production Bundler (build-tools.js) ---
    async minifyJS(code) {
        if (typeof Terser === 'undefined') {
            this.log("Terser not loaded. Exporting unminified JS.", "var(--warn)");
            return code;
        }
        try {
            const result = await Terser.minify(code, {
                mangle: true,
                compress: { dead_code: true, drop_console: false, drop_debugger: true }
            });
            return result.code;
        } catch (err) {
            throw err;
        }
    },

    async buildForProduction() {
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
            } catch (err) {
                console.error(`Minification failed for ${file}:`, err);
                buildFolder.file(file, this.state.vfs[file]);
            }
        }

        for (const file of cssFiles) {
            const minifiedCss = this.state.vfs[file].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
            buildFolder.file(file, minifiedCss);
        }

        for (const file of otherFiles) {
            buildFolder.file(file, this.state.vfs[file]);
        }

        const content = await zip.generateAsync({ type: "blob" });
        const url = URL.createObjectURL(content);
        const a = document.createElement("a");
        a.href = url;
        a.download = `DevOS_Build_${Date.now()}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        
        this.log("Production Build Downloaded.", "var(--success)");
    },

    // --- Rollup & Zip ---
    async loadZipToVFS(file) {
        if (!file) return;
        if (!window.JSZip) return alert("JSZip not loaded.");
        try {
            const zip = new JSZip();
            const contents = await zip.loadAsync(file);
            let loaded = 0;
            const promises = [];
            contents.forEach((relativePath, zipEntry) => {
                if (!zipEntry.dir && !relativePath.includes('__MACOSX')) {
                    promises.push(
                        zipEntry.async('string').then(text => {
                            this.state.vfs[relativePath] = text;
                            loaded++;
                        })
                    );
                }
            });
            await Promise.all(promises);
            this.renderExplorer();
            this.saveVFS();
            const zipInput = document.getElementById('zip-upload-input');
            if (zipInput) zipInput.value = ''; 
        } catch (err) {
            alert(`ZIP Error: ${err.message}`);
        }
    },

    openAdvancedMerger() {
        const vfsFiles = Object.keys(this.state.vfs).filter(f => f.endsWith('.js') || f.endsWith('.mjs'));
        let fileListHtml = vfsFiles.length > 0 
            ? vfsFiles.map(f => `
                <div style="display:flex; justify-content:space-between; padding:8px; border-bottom:1px solid var(--border);">
                    <label style="color:var(--text); font-size:14px; display:flex; align-items:center; gap:10px; cursor:pointer;">
                        <input type="checkbox" class="merger-checkbox" value="${f}" style="width:18px; height:18px; accent-color:var(--accent);">
                        ${f}
                    </label>
                </div>
            `).join('')
            : '<div style="padding:10px; color:var(--danger);">No JS files found in VFS.</div>';

        const html = `
            <div style="display:flex; flex-direction:column; gap:10px; height: 100%;">
                <div style="background:#000; border:1px solid var(--border); border-radius:6px; max-height:220px; overflow-y:auto; margin-bottom:10px;">
                    ${fileListHtml}
                </div>
                <input type="text" id="merger-output-name" placeholder="Output filename (e.g. bundled.js)" style="padding:10px; background:#000; border:1px solid var(--border); color:var(--success); border-radius:6px; font-family:monospace;">
                <div style="display:flex; gap:10px; margin-top:10px;">
                    <button class="btn-purple" style="flex:1;" onclick="Nexus.executeMerge()">Merge Selected</button>
                </div>
                <div id="merger-status" style="margin-top:10px; font-weight:bold; font-size:12px; text-align:center;"></div>
            </div>
        `;
        this.showModal("📦 PWA Studio Merger", html);
    },

    async executeMerge() {
        const checkboxes = document.querySelectorAll('.merger-checkbox:checked');
        const selectedFiles = Array.from(checkboxes).map(cb => cb.value);
        let outName = document.getElementById('merger-output-name').value.trim();
        const statusEl = document.getElementById('merger-status');

        if (selectedFiles.length < 2) { 
            statusEl.style.color = "var(--danger)";
            statusEl.innerText = "Select at least 2 files."; 
            return; 
        }
        
        if (!outName) outName = 'merged-bundle.js';
        if (!outName.endsWith('.js')) outName += '.js';

        statusEl.style.color = "var(--accent)";
        statusEl.innerText = "Merging...";

        try {
            const memoryPlugin = {
                name: 'nexus-vfs',
                resolveId: (source) => {
                    let cleanName = source.replace(/^(\.\/|\.\.\/)+/, '').replace(/^\//, '');
                    if (!cleanName.endsWith('.js')) cleanName += '.js';
                    return this.state.vfs[cleanName] ? cleanName : null;
                },
                load: (id) => this.state.vfs[id] || null
            };

            const syntheticEntry = selectedFiles.map(p => `export * from './${p}';\nimport './${p}';`).join('\n');
            this.state.vfs['__nexus_synthetic__.js'] = syntheticEntry;

            const bundle = await window.rollup.rollup({
                input: '__nexus_synthetic__.js',
                plugins: [memoryPlugin]
            });

            const { output } = await bundle.generate({ format: 'es' });
            
            this.state.vfs[outName] = output[0].code;
            delete this.state.vfs['__nexus_synthetic__.js']; 
            
            this.renderExplorer();
            this.loadFile(outName);
            
            statusEl.style.color = "var(--success)";
            statusEl.innerText = `Success: Created ${outName}`;
            this.saveVFS();
            
        } catch (err) {
            statusEl.style.color = "var(--danger)";
            statusEl.innerText = `Merge Error: ${err.message}`; 
            console.error(err);
        }
    }
};
