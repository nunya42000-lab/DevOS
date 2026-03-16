
/* =============================================================================
   FILE: nexus.js (Omni-Edition - Full Integration)
   ============================================================================= */
/* nexus.js: Thorough Integration Patch */

window.Nexus = {
    state: { vfs: {}, activeFile: "main.js", cm: null, history: [] },

    boot() {
        this.log("DevOS Nexus Prime: Omni-Engine Online.", "var(--accent)");
        this.initGestures();
        
        // Verifies VFS state without opening UI modals
        this.verifyIntelligence();

        window.addEventListener('cm6-ready', () => {
            this.initEditor();
            this.renderExplorer();
            this.syncUI(); 
        });

        // Initialize Terminal Input logic
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

    // Bridge for virtual-keyboard.js to interact with CodeMirror
      type(char) {
        if (!this.state.cm) return;
        const state = this.state.cm.state;
        const selection = state.selection.main;
        
        if (char === 'BACKSPACE') {
            this.state.cm.dispatch({
                changes: { from: selection.from > 0 ? selection.from - 1 : 0, to: selection.to, insert: '' }
            });
        } else {
            this.state.cm.dispatch({
                changes: { from: selection.from, to: selection.to, insert: char },
                selection: { anchor: selection.from + char.length, head: selection.from + char.length }
            });
        }
        this.state.cm.focus();
    },

    // FIXED: Uses classes to match your CSS transitions
    toggleKb() { 
        const k = document.getElementById('kb-drawer'); 
        if (k) k.classList.toggle('active'); 
    },

    toggleTerminalPopup() { 
        const t = document.getElementById('terminal-zone'); 
        if (t) {
            // Check if it's currently hidden or has no inline style
            const isHidden = t.style.display === 'none' || t.style.display === '';
            t.style.display = isHidden ? 'flex' : 'none'; 
        }
    },

    // MODAL LOGIC: Prevents the "Undefined" errors
    showModal(title, html) {
        const overlay = document.getElementById('modal-overlay');
        if (overlay) {
            document.getElementById('modal-title').innerText = title;
            document.getElementById('modal-body').innerHTML = html;
            overlay.style.display = 'flex';
        }
    },

    closeModal() { 
        const overlay = document.getElementById('modal-overlay');
        if (overlay) overlay.style.display = 'none'; 
    }
};
           

// NEW: Ensures system files always exist in VFS
async verifyIntelligence() {
    const suite = {
        'DevOSSentinel.js': `/* Sentinel Engine v3.5 Source */`,
        'SentinelFixer.js': `/* Fixer Logic Source */`,
        'NexusContext.js': `/* Context Map Source */`
    };
    let repaired = false;
    for (const [name, code] of Object.entries(suite)) {
        if (!this.state.vfs[name]) {
            this.state.vfs[name] = code;
            repaired = true;
        }
    }
    if (repaired && window.localforage) {
        await localforage.setItem('nexus_vfs', this.state.vfs);
    }
},
/* --- PERMANENT WORKSTATION TOOLS --- */
openMerger() {
    const html = `
        <div style="display:flex; flex-direction:column; gap:10px;">
            <textarea id="merger-input" style="width:100%; height:200px; background:#000; color:#22c55e; font-family:monospace; padding:10px; border:1px solid var(--border);"></textarea>
            <div style="display:flex; gap:10px;">
                <button class="tool-btn btn-blue" style="flex:1" onclick="Nexus.applyMerge('replace')">Replace File</button>
                <button class="tool-btn btn-accent" style="flex:1" onclick="Nexus.applyMerge('cursor')">Insert at Cursor</button>
            </div>
        </div>`;
    this.showModal("⚡ Project Merger", html);
},

applyMerge(mode) {
    const code = document.getElementById('merger-input').value;
    const view = this.state.cm;
    if (!code || !view) return;
    if (mode === 'replace') {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } });
    } else {
        const pos = view.state.selection.main.from;
        view.dispatch({ changes: { from: pos, insert: code } });
    }
    this.closeModal();
    this.log("Code Merged Successfully.", "var(--success)");
},

compareFiles() {
    const f1 = this.state.activeFile;
    const f2 = prompt("Enter file to compare against:");
    if (!this.state.vfs[f1] || !this.state.vfs[f2]) return this.log("File missing.", "var(--danger)");
    
    const dmp = new diff_match_patch();
    const diffs = dmp.diff_main(this.state.vfs[f1], this.state.vfs[f2]);
    dmp.diff_cleanupSemantic(diffs);
    
    this.showModal("⚖️ Comparison Results", `<div style="font-family:monospace; font-size:12px; white-space:pre-wrap; background:#000; padding:15px; overflow-y:auto; max-height:400px;">${dmp.diff_prettyHtml(diffs)}</div>`);
        }
   
// NEW: The Permanent Button Fixer
syncUI() {
    const ribbon = document.querySelector('.toolbar-track');
    if (!ribbon) return;

    const bindings = {
        "Merge": () => this.openMerger(),
        "Intel": () => this.openIntel(),
        "Compare": () => this.compareFiles(),
        "Visual": () => this.toggleVisual(),
        "Vault": () => this.openVault()
    };

    Array.from(ribbon.querySelectorAll('.tool-btn')).forEach(btn => {
        for (let label in bindings) {
            if (btn.innerText.includes(label)) {
                btn.onclick = (e) => { e.preventDefault(); bindings[label](); };
                btn.style.borderBottom = "2px solid var(--success)";
            }
        }
    });
    this.log("UI Systems Synchronized.", "var(--success)");
},
   
    
    initEditor() {
        const parent = document.getElementById('editor-wrapper');
        if (this.state.cm) this.state.cm.destroy();
        this.state.cm = new window.CM6.EditorView({
            doc: this.state.vfs[this.state.activeFile] || "// DevOS Nexus Prime Ready\n",
            extensions: [window.CM6.basicSetup, window.CM6.oneDark, window.CM6.javascript()],
            parent: parent
        });
    },

    initGestures() {
        let startX, startY;
        document.body.addEventListener('touchstart', e => {
            startX = e.touches[0].clientX; startY = e.touches[0].clientY;
        }, {passive: true});
        document.body.addEventListener('touchend', e => {
            const deltaX = e.changedTouches[0].clientX - startX;
            if (startX < 40 && startY > (window.innerHeight / 2) && deltaX > 80) this.toggleSidebar(true);
            if (deltaX < -80) this.toggleSidebar(false);
        }, {passive: true});
    },

    // --- Vault System ---
    openVault() { NexusVault.openModal(); },

    // --- Preview System ---
    toggleVisual() {
        const preview = document.getElementById('visual-preview');
        if (preview.style.display === 'none') {
            preview.style.display = 'flex';
            document.getElementById('editor-wrapper').style.display = 'none';
            const code = this.state.cm.state.doc.toString();
            document.getElementById('preview-frame').srcdoc = `<html><body><script>
                window.onerror = (m, u, l) => window.parent.postMessage({t:'err', m, l}, '*');
                try { ${code} } catch(e) { window.parent.postMessage({t:'err', m:e.message, l:0}, '*'); }
            <\/script></body></html>`;
        } else { this.killPreview(); }
    },

    killPreview() {
        document.getElementById('visual-preview').style.display = 'none';
        document.getElementById('editor-wrapper').style.display = 'flex';
    },

    // --- Search System ---
    openFindReplace() {
        const html = `
            <input type="text" id="find-val" placeholder="Find..." class="modal-input">
            <button class="tool-btn btn-blue" style="width:100%; margin-top:5px;" onclick="Nexus.performSearch()">Search</button>
            <div id="search-results"></div>
            <input type="text" id="replace-val" placeholder="Replace..." class="modal-input" style="margin-top:10px;">
            <button class="tool-btn btn-green" style="width:100%; margin-top:5px;" onclick="Nexus.executeReplace()">Replace All</button>
        `;
        this.showModal("🔍 Search", html);
    },

    performSearch() {
        const query = document.getElementById('find-val').value;
        const code = this.state.cm.state.doc.toString();
        const res = document.getElementById('search-results');
        res.innerHTML = "";
        code.split('\n').forEach((line, i) => {
            if (line.includes(query) && query) {
                const d = document.createElement('div');
                d.innerHTML = `L${i+1}: ${line.substring(0,30)}...`;
                d.onclick = () => {
                    const pos = this.state.cm.state.doc.line(i + 1).from;
                    this.state.cm.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
                    this.closeModal();
                };
                res.appendChild(d);
            }
        });
    },

    // --- File System & Core ---
    renderExplorer() {
        const container = document.getElementById('explorer');
        container.innerHTML = "";
        Object.keys(this.state.vfs).forEach(file => {
            const div = document.createElement('div');
            div.className = "explorer-item";
            div.innerHTML = `<span onclick="Nexus.loadFile('${file}')">${file}</span><button onclick="Nexus.deleteFile('${file}')">🗑️</button>`;
            container.appendChild(div);
        });
    },

    loadFile(name) {
        this.state.vfs[this.state.activeFile] = this.state.cm.state.doc.toString();
        this.state.activeFile = name;
        this.initEditor();
    },

    deleteFile(name) {
        delete this.state.vfs[name];
        this.renderExplorer();
    },

    async syncToLocalFolder() {
        if (!window.showDirectoryPicker) return this.log("API Unsupported", "var(--danger)");
        try {
            const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
            for (const [n, c] of Object.entries(this.state.vfs)) {
                const h = await dir.getFileHandle(n, { create: true });
                const w = await h.createWritable();
                await w.write(c); await w.close();
            }
            this.log("Synced to Disk.", "var(--success)");
        } catch (e) { this.log("Sync Cancelled.", "var(--warn)"); }
    },

    log(msg, color = "var(--text)") {
        const term = document.getElementById('term-out');
        const line = document.createElement('div');
        line.style.color = color;
        line.innerText = `> ${msg}`;
        term.appendChild(line);
        term.scrollTop = term.scrollHeight;
    },

    executeCommand(cmd) { try { this.log(eval(cmd), "var(--success)"); } catch(e) { this.log(e.message, "var(--danger)"); } },
    showModal(title, html) {
        document.getElementById('modal-title').innerText = title;
        document.getElementById('modal-body').innerHTML = html;
        document.getElementById('modal-overlay').style.display = 'flex';
    },
    closeModal() { document.getElementById('modal-overlay').style.display = 'none'; },
    toggleSidebar(s) { document.getElementById('sidebar').classList.toggle('active', s); },
    toggleTerminalPopup() { 
        const t = document.getElementById('terminal-zone'); 
        t.style.display = t.style.display === 'none' ? 'flex' : 'none'; 
    },
    toggleKb() { 
        const k = document.getElementById('kb-drawer'); 
        k.style.display = k.style.display === 'none' ? 'block' : 'none'; 
        if(k.style.display === 'block') window.VirtualKeyboard.render();
    }
};

window.onload = () => window.Nexus.boot();
