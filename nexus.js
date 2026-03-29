/* =============================================================================
   FILE: nexus.js (Omni-Merged & Multi-Pane)
   ============================================================================= */

window.Nexus = {
    state: { 
        vfs: {}, 
        activeFile: "main.js", 
        cm: null,
        autoSaveTimer: null
    },

    async boot() {
        console.log("Nexus Prime: Systems Online.");
        this.initGestures();
        this.verifyIntelligence();

        const saved = await localforage.getItem('nexus_vfs_v4');
        if (saved) this.state.vfs = saved;

        window.addEventListener('cm6-ready', () => {
            this.initEditor();
            this.renderExplorer();
            this.initMobileSoftKeys();
            this.initSearch();
            this.initPreviewHooks();
            this.log("DevOS Nexus Prime Initialized.", "var(--success)");
        });
    },

    // --- Layout & View Switching ---
    switchTab(tabId) {
        // Update Buttons
        document.querySelectorAll('.navbar .tool-btn').forEach(b => b.classList.remove('active-tab'));
        const btn = document.getElementById(`tab-btn-${tabId}`);
        if (btn) btn.classList.add('active-tab');

        // Update Panels
        document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
        const panel = document.getElementById(`${tabId}-view`);
        if (panel) panel.classList.add('active');

        // Fire specific refresh logic
        if (tabId === 'intel') this.updateProjectStats();
    },

    // --- Search & Jump (CM6 Integration) ---
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
                            // Jump to line in CM6
                            setTimeout(() => {
                                if (!this.state.cm) return;
                                try {
                                    const targetLine = this.state.cm.state.doc.line(i + 1);
                                    this.state.cm.dispatch({ 
                                        selection: { anchor: targetLine.from }, 
                                        scrollIntoView: true 
                                    });
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
        
        const html = this.state.vfs['index.html'] || '<div style="color:white; padding:20px;">No index.html found.</div>';
        
        // If main.js exists, load it. If not, load whatever the active file is (for isolated testing)
        let jsToLoad = "";
        if (this.state.vfs['main.js']) {
            jsToLoad = this.state.vfs['main.js'];
        } else if (this.state.activeFile.endsWith('.js')) {
            jsToLoad = this.state.vfs[this.state.activeFile];
        }
        
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
                    
                    // Convert objects to strings safely
                    const msg = Array.from(args).map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
                    div.innerText = "[" + type.toUpperCase() + "] " + msg;
                    ghost.appendChild(div);
                    ghost.scrollTop = ghost.scrollHeight;
                }
                console.log = function(){ logToGhost('log', arguments); };
                console.error = function(){ logToGhost('error', arguments); };
                console.warn = function(){ logToGhost('warn', arguments); };
                
                window.onerror = function(msg, url, line) {
                    console.error("Line " + line + ": " + msg);
                    return false;
                };
            })();
        <\/script>`;

        const fullHTML = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>body { background: #000; color: #fff; font-family: sans-serif; }</style>
            </head>
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

    resizePreview(width) {
        const frame = document.getElementById('live-preview-frame');
        if (frame) {
            frame.style.width = width;
            // Center it if it's smaller than full width
            frame.style.margin = width === '100%' ? '0' : '0 auto';
        }
    },

    initPreviewHooks() {
        let last = performance.now();
        const fpsCounter = document.getElementById('fps-counter');
        if (!fpsCounter) return;

        function track() {
            let now = performance.now();
            fpsCounter.innerText = Math.round(1000/(now-last)) + " FPS";
            last = now;
            requestAnimationFrame(track);
        }
        requestAnimationFrame(track);
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
                        
                        // Auto-Save Throttle
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

    // --- Core Routing ---
    executeCommand(cmd) {
        const args = cmd.split(' ');
        const command = args[0].toLowerCase();

        switch(command) {
            case 'merger':
            case 'bundle':
                this.openAdvancedMerger();
                break;
            default:
                try {
                    const out = new Function(`return ${cmd}`).bind(this)();
                    this.log(out || "Executed", "var(--success)");
                } catch(e) {
                    this.log(e.message, "var(--danger)");
                }
        }
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

    log(msg, color = "var(--text)") {
        console.log(`[Nexus] ${msg}`);
    },

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
    },

    deleteFile(filename) {
        if (filename === "main.js") { alert("main.js protected."); return; }
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

    // --- Rollup & Zip (Intact from previous iteration) ---
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
                    <button class="tool-btn" style="background:var(--purple); color:white; flex:1;" onclick="Nexus.executeMerge()">Merge Selected</button>
                    <button class="tool-btn" style="background:var(--success); color:white; flex:1;" onclick="Nexus.downloadProjectZip()">Download ZIP</button>
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

        if (selectedFiles.length < 2) { statusEl.innerText = "Select at least 2 files."; return; }
        if (!outName) outName = 'merged-bundle.js';
        if (!outName.endsWith('.js')) outName += '.js';

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
            statusEl.innerText = `Success: ${outName}`;
            this.saveVFS();
        } catch (err) {
            statusEl.innerText = "Error: See Console";
            console.error(err);
        }
    },

    async downloadProjectZip() {
        if (!window.JSZip) return;
        try {
            const zip = new JSZip();
            Object.keys(this.state.vfs).forEach(filename => zip.file(filename, this.state.vfs[filename]));
            const blob = await zip.generateAsync({ type: "blob" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = 'DevOS-Project.zip';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (err) { alert(err.message); }
    },

    initGestures() {
        let startX;
        document.addEventListener('touchstart', e => startX = e.touches[0].clientX);
        document.addEventListener('touchend', e => {
            const diff = e.changedTouches[0].clientX - startX;
            if (startX < 50 && diff > 100) this.toggleSidebar(true);
            if (diff < -100) this.toggleSidebar(false);
        });
    },

    verifyIntelligence() {
        if (!this.state.vfs["main.js"]) {
            this.state.vfs["main.js"] = "// Main Script\nconsole.log('Online');";
        }
    },
    nukeSystem() { 
        if(confirm("Wipe cache?")) { localforage.clear(); location.reload(); } 
    }
};
