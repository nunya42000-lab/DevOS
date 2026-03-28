/* =============================================================================
   FILE: nexus.js (Patched & CMD-Enabled)
   ============================================================================= */

window.Nexus = {
    state: { vfs: {}, activeFile: "main.js", cm: null, history: [] },

    boot() {
        console.log("DevOS Nexus Prime: Initializing...");
        this.initGestures();
        this.verifyIntelligence();

        window.addEventListener('cm6-ready', () => {
            this.initEditor();
            this.renderExplorer();
            this.syncUI(); 
        });
    },

    // COMMAND PROMPT LOGIC
    toggleCMD() {
        const panel = document.getElementById('cmd-panel');
        if (panel) panel.classList.toggle('active');
    },

    runCMD() {
        const code = document.getElementById('cmd-input').value;
        if (!code) return;
        try {
            const result = eval(code);
            this.log(`Exec Success: ${result}`, "var(--success)");
            this.toggleCMD();
        } catch (e) {
            this.log(`Exec Error: ${e.message}`, "var(--danger)");
        }
    },

    // UI & EDITOR METHODS
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
    },

    toggleSidebar(force) {
        const s = document.getElementById('sidebar');
        if (s) s.classList.toggle('active', force);
    },

    openMerger() {
        const html = `
            <textarea id="merger-input" style="width:100%;height:180px;background:#000;color:#22c55e;font-family:monospace;padding:10px;border:1px solid #2d333f;"></textarea>
            <div style="display:flex;gap:10px;margin-top:10px;">
                <button class="tool-btn btn-accent" style="flex:1;" onclick="Nexus.applyMerge('cursor')">Insert</button>
                <button class="tool-btn btn-blue" style="flex:1;" onclick="Nexus.applyMerge('replace')">Replace All</button>
            </div>`;
        this.showModal("⚡ Project Merger", html);
    },

    applyMerge(mode) {
        const code = document.getElementById('merger-input').value;
        if (!code || !this.state.cm) return;
        if (mode === 'replace') {
            this.state.cm.dispatch({ changes: { from: 0, to: this.state.cm.state.doc.length, insert: code } });
        } else {
            this.type(code);
        }
        this.closeModal();
        this.log("Merge completed.", "var(--success)");
    },

    log(msg, color = "var(--text)") {
        const term = document.getElementById('term-out');
        if (!term) { console.log(msg); return; }
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

    closeModal() { document.getElementById('modal-overlay').style.display = 'none'; },

    async verifyIntelligence() {
        const suite = { 'main.js': '// Welcome to Nexus Prime' };
        for (const [name, code] of Object.entries(suite)) {
            if (!this.state.vfs[name]) this.state.vfs[name] = code;
        }
    },

    initEditor() {
        const parent = document.getElementById('editor-wrapper');
        this.state.cm = new window.CM6.EditorView({
            doc: this.state.vfs[this.state.activeFile],
            extensions: [window.CM6.basicSetup, window.CM6.oneDark, window.CM6.javascript()],
            parent: parent
        });
    },

    syncUI() {
        this.log("All systems online.", "var(--success)");
    },

    initGestures() { /* Add gesture logic here */ },
    openVault() { this.log("Vault logic not implemented.", "var(--gold)"); },
    openIntel() { this.log("Intel logic not implemented.", "var(--gold)"); },
    toggleVisual() { this.log("Visual toggle logic here.", "var(--accent)"); },
    nukeSystem() { if(confirm("Nuke everything?")) location.reload(); }
};
