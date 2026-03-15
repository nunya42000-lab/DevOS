/* =============================================================================
   FILE: nexus.js (Omni-Edition - Full Integration)
   ============================================================================= */

window.Nexus = {
    state: { vfs: {}, activeFile: "main.js", cm: null, history: [] },

    boot() {
        this.log("Omni-Engine Restored.", "var(--accent)");
        this.initGestures();
        window.addEventListener('cm6-ready', () => {
            this.initEditor();
            this.renderExplorer();
        });
        document.getElementById('term-in').onkeydown = (e) => {
            if (e.key === 'Enter') { this.executeCommand(e.target.value); e.target.value = ''; }
        };
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
