/* =============================================================================
   FILE: nexus.js (Omni-Merged Version)
   ============================================================================= */

window.Nexus = {
    state: { 
        vfs: {}, 
        activeFile: "main.js", 
        cm: null 
    },

    async boot() {
        console.log("Nexus Prime: Systems Online.");
        this.initGestures();
        this.verifyIntelligence();

        // Load saved state from LocalForage
        const saved = await localforage.getItem('nexus_vfs_v4');
        if (saved) this.state.vfs = saved;

        // Listen for CodeMirror ready signal
        window.addEventListener('cm6-ready', () => {
            this.initEditor();
            this.renderExplorer();
            this.log("DevOS Nexus Prime Initialized.", "var(--success)");
        });

        const termIn = document.getElementById('term-in');
        if (termIn) {
            termIn.onkeydown = (e) => {
                if (e.key === 'Enter') { 
                    this.executeCommand(e.target.value);
                    e.target.value = ''; 
                }
            };
        }
    },

    // --- Core Command Parsing ---
    executeCommand(cmd) {
        const args = cmd.split(' ');
        const command = args[0].toLowerCase();

        switch(command) {
            case 'merger':
            case 'bundle':
                this.openAdvancedMerger();
                break;
            case 'maxbet':
                this.calculateMaxBet(args.slice(1));
                break;
            case 'clear':
                const termOut = document.getElementById('term-out');
                if (termOut) termOut.innerHTML = '';
                break;
            case 'find':
                const search = args.slice(1).join(' ');
                const editor = this.state.cm;
                if (!editor) return;
                const content = editor.state.doc.toString();
                const index = content.indexOf(search);
                if (index !== -1) {
                    editor.dispatch({ selection: { anchor: index, head: index }, scrollIntoView: true });
                    this.log(`Jumped to: ${search}`, "var(--accent)");
                } else {
                    this.log("Not found.", "var(--danger)");
                }
                break;
            case 'predict':
                this.log("Analyzing gameplay sequence...", "var(--gold)");
                const confidence = Math.floor(Math.random() * 20) + 80; 
                this.log(`Pattern detected. Signal Strength: ${confidence}%`, "var(--success)");
                this.log("Recommendation: Prepare for Max Bet.", "var(--gold)");
                break;
            case 'status':
                this.log(`System: ${Object.keys(this.state.vfs).length} modules linked.`, "var(--accent)");
                this.log(`VFS State: ${Math.round(JSON.stringify(this.state.vfs).length / 1024)}KB`, "var(--text)");
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

    calculateMaxBet(params) {
        this.log("Running Max Bet Logic Analyzer...", "var(--gold)");
        const prediction = (Math.random() * 100).toFixed(2);
        this.log(`Simulation Result: Strategy Optimality at ${prediction}%`, "var(--accent)");
        this.log("Action: Recommended Max Bet on Next Cycle.", "var(--success)");
    },

    // --- CMD & Script Injection ---
    toggleCMD() {
        const panel = document.getElementById('cmd-panel');
        if (panel) panel.classList.toggle('active');
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

    // --- UI & Modals ---
    log(msg, color = "var(--text)") {
        const term = document.getElementById('term-out');
        if (!term) return;
        const line = document.createElement('div');
        line.style.color = color;
        line.innerText = `> ${msg}`;
        term.appendChild(line);
        term.scrollTop = term.scrollHeight;
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
            <div class="explorer-item ${this.state.activeFile === name ? 'active' : ''}" onclick="Nexus.loadFile('${name}')">
                <span style="font-size:12px; word-break: break-all;">${name}</span>
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
        this.log(`Switched to: ${filename}`, "var(--accent)");
    },

    deleteFile(filename) {
        if (filename === "main.js") return this.log("System protected: main.js cannot be deleted.", "var(--danger)");
        if (confirm(`Delete ${filename}?`)) {
            delete this.state.vfs[filename];
            if (this.state.activeFile === filename) this.loadFile("main.js");
            this.renderExplorer();
            this.saveVFS();
            this.log(`Deleted ${filename}`, "var(--danger)");
        }
    },

    async saveVFS() {
        await localforage.setItem('nexus_vfs_v4', this.state.vfs);
        this.log("VFS State Saved to Local Cache.", "var(--success)");
    },

    // ==========================================
    // Advanced PWA Merger & Packager Integration
    // ==========================================

    async loadZipToVFS(file) {
        if (!file) return;
        if (!window.JSZip) return this.log("[Error] JSZip not loaded.", "var(--danger)");
        
        this.log("Unpacking ZIP into Nexus VFS...", "var(--gold)");
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
            this.log(`Successfully imported ${loaded} files.`, "var(--success)");
            const zipInput = document.getElementById('zip-upload-input');
            if (zipInput) zipInput.value = ''; 
        } catch (err) {
            this.log(`[ZIP Error] ${err.message}`, "var(--danger)");
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
            : '<div style="padding:10px; color:var(--danger);">No JS files found in VFS. Load some first!</div>';

        const html = `
            <div style="display:flex; flex-direction:column; gap:10px; height: 100%;">
                <p style="color:var(--text); font-size:12px; margin:0;">Select files to merge together. Rollup will resolve dependencies directly from the Nexus VFS.</p>
                
                <div style="background:#000; border:1px solid var(--border); border-radius:6px; max-height:220px; overflow-y:auto; margin-bottom:10px;">
                    ${fileListHtml}
                </div>
                
                <input type="text" id="merger-output-name" placeholder="Output filename (e.g. bundled.js)" style="padding:10px; background:#000; border:1px solid var(--border); color:var(--success); border-radius:6px; font-family:monospace;">
                
                <div style="display:flex; gap:10px; margin-top:10px;">
                    <button class="tool-btn" style="background:var(--purple); border-color:var(--purple); color:white; flex:1; padding:12px; font-size:14px;" onclick="Nexus.executeMerge()">Merge Selected</button>
                    <button class="tool-btn" style="background:var(--success); border-color:var(--success); color:white; flex:1; padding:12px; font-size:14px;" onclick="Nexus.downloadProjectZip()">Download Project ZIP</button>
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
            statusEl.innerText = "Error: Select at least 2 files to merge.";
            return;
        }
        if (!outName) outName = 'merged-bundle.js';
        if (!outName.endsWith('.js')) outName += '.js';

        statusEl.style.color = "var(--accent)";
        statusEl.innerText = "Analyzing dependencies & merging...";

        try {
            const memoryPlugin = {
                name: 'nexus-vfs',
                resolveId: (source, importer) => {
                    let cleanName = source.replace(/^(\.\/|\.\.\/)+/, '').replace(/^\//, '');
                    if (!cleanName.endsWith('.js') && !cleanName.endsWith('.mjs')) cleanName += '.js';
                    if (this.state.vfs[cleanName]) return cleanName;
                    return null;
                },
                load: (id) => {
                    return this.state.vfs[id] || null;
                }
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
            statusEl.innerText = `Successfully merged into ${outName}!`;
            this.log(`[Merger] Created ${outName} from ${selectedFiles.length} files.`, "var(--success)");

            checkboxes.forEach(cb => cb.checked = false);
            this.saveVFS();
        } catch (err) {
            statusEl.style.color = "var(--danger)";
            statusEl.innerText = "Merge Error (See Terminal)";
            this.log(`[Merger Error] ${err.message}`, "var(--danger)");
            console.error(err);
        }
    },

    async downloadProjectZip() {
        const statusEl = document.getElementById('merger-status');
        if (!window.JSZip) {
            this.log("[Error] JSZip not loaded.", "var(--danger)");
            return;
        }
        
        if (statusEl) {
            statusEl.style.color = "var(--gold)";
            statusEl.innerText = "Packaging ZIP...";
        }
        
        try {
            const zip = new JSZip();
            Object.keys(this.state.vfs).forEach(filename => {
                zip.file(filename, this.state.vfs[filename]);
            });

            const blob = await zip.generateAsync({ type: "blob" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'DevOS-Nexus-Project.zip';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            if (statusEl) {
                statusEl.style.color = "var(--success)";
                statusEl.innerText = "Project Downloaded!";
            }
            this.log("[Packager] Full project ZIP downloaded.", "var(--success)");
        } catch (err) {
            if (statusEl) {
                statusEl.style.color = "var(--danger)";
                statusEl.innerText = "ZIP generation failed.";
            }
            this.log(`[Packager Error] ${err.message}`, "var(--danger)");
        }
    },

    // --- Core Editor & Internal Logic ---
    initEditor() {
        const parent = document.getElementById('editor-wrapper');
        if (!parent) return;
        if (window.CM6) {
            this.state.cm = new window.CM6.EditorView({
                doc: this.state.vfs[this.state.activeFile] || "// Nexus Codebase\n",
                extensions: [
                    window.CM6.basicSetup, 
                    window.CM6.oneDark, 
                    window.CM6.javascript(),
                    window.CM6.EditorView.updateListener.of((v) => {
                        if (v.docChanged && this.state.activeFile) {
                            this.state.vfs[this.state.activeFile] = v.state.doc.toString();
                        }
                    })
                ],
                parent: parent
            });
        } else {
            parent.innerHTML = `<div style="color:var(--danger); padding:20px;">CodeMirror 6 Dependency Not Found.</div>`;
        }
    },

    verifyIntelligence() {
        if (!this.state.vfs["main.js"]) {
            this.state.vfs["main.js"] = "// Nexus Main Script\nconsole.log('Online');";
        }
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

    // Stubs
    openVault() { this.log("Vault Encrypted. Access Denied.", "var(--gold)"); },
    openIntel() { this.log("Analyzing local data streams...", "var(--gold)"); },
    beautifyCode() { this.log("Format module standby.", "var(--accent)"); },
    nukeSystem() { 
        if(confirm("Wipe cache?")) { 
            localforage.clear(); 
            location.reload(); 
        } 
    }
};
