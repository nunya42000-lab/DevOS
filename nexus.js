/* =============================================================================
   FILE: nexus.js (Patched & Optimized)
   ============================================================================= */

window.Nexus = {
    state: { 
        vfs: {}, 
        activeFile: "main.js", 
        cm: null 
    },

    boot() {
        console.log("Nexus Prime: Systems Online.");
        this.initGestures();
        this.verifyIntelligence();

        // Listen for CodeMirror ready signal (if external) or manual init
        setTimeout(() => {
            this.initEditor();
            this.renderExplorer();
            this.log("DevOS Nexus Prime Initialized.", "var(--success)");
        }, 100);

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

    // --- CMD & Script Injection ---
    toggleCMD() {
        const panel = document.getElementById('cmd-panel');
        if (panel) panel.classList.toggle('active');
    },

    runCMD() {
        const code = document.getElementById('cmd-input').value;
        if (!code) return;
        try {
            // Using Function constructor for cleaner scope than eval
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
        document.getElementById('modal-overlay').style.display = 'none';
    },

    toggleSidebar(force) {
        const s = document.getElementById('sidebar');
        if (s) s.classList.toggle('active', force);
    },

    // --- Explorer & VFS ---
    renderExplorer() {
        const exp = document.getElementById('explorer');
        if (!exp) return;
        exp.innerHTML = Object.keys(this.state.vfs).map(name => `
            <div style="padding:10px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; cursor:pointer;" onclick="Nexus.loadFile('${name}')">
                <span style="color:${this.state.activeFile === name ? 'var(--success)' : 'var(--text)'}">${name}</span>
                <button onclick="event.stopPropagation(); Nexus.deleteFile('${name}')" style="background:none; border:none; color:var(--danger); cursor:pointer;">🗑️</button>
            </div>
        `).join('');
    },

    loadFile(filename) {
        if (!this.state.vfs[filename]) return;
        this.state.activeFile = filename;
        if (this.state.cm) {
            this.state.cm.dispatch({
                changes: { from: 0, to: this.state.cm.state.doc.length, insert: this.state.vfs[filename] }
            });
        }
        this.renderExplorer();
        this.log(`Switched to: ${filename}`, "var(--accent)");
    },

    deleteFile(filename) {
        if (filename === "main.js") return this.log("System protected: main.js cannot be deleted.", "var(--danger)");
        if (confirm(`Delete ${filename}?`)) {
            delete this.state.vfs[filename];
            if (this.state.activeFile === filename) this.loadFile("main.js");
            this.renderExplorer();
        }
    },

    // --- Merger Logic ---
    openMerger() {
        const html = `
            <textarea id="merger-input" style="width:100%; height:180px; background:#000; color:#22c55e; font-family:monospace; padding:10px; border:1px solid var(--border);"></textarea>
            <div style="display:flex; gap:10px; margin-top:10px;">
                <button class="tool-btn btn-blue" style="flex:1" onclick="Nexus.applyMerge('replace')">Replace All</button>
                <button class="tool-btn btn-accent" style="flex:1" onclick="Nexus.applyMerge('cursor')">Insert At Cursor</button>
            </div>`;
        this.showModal("⚡ Code Merger", html);
    },

    applyMerge(mode) {
        const code = document.getElementById('merger-input').value;
        if (!code || !this.state.cm) return;
        if (mode === 'replace') {
            this.state.cm.dispatch({ changes: { from: 0, to: this.state.cm.state.doc.length, insert: code } });
        } else {
            const pos = this.state.cm.state.selection.main.from;
            this.state.cm.dispatch({ changes: { from: pos, insert: code } });
        }
        this.closeModal();
        this.log("Merge Successful.", "var(--success)");
    },

    // --- Core Editor & Internal Logic ---
    initEditor() {
        const parent = document.getElementById('editor-wrapper');
        if (!parent) return;
        // Check if CodeMirror 6 (CM6) is available on window
        if (window.CM6) {
            this.state.cm = new window.CM6.EditorView({
                doc: this.state.vfs[this.state.activeFile] || "// Nexus Codebase\n",
                extensions: [window.CM6.basicSetup, window.CM6.oneDark, window.CM6.javascript()],
                parent: parent
            });
        } else {
            parent.innerHTML = `<div style="color:var(--danger); padding:20px;">CodeMirror 6 Dependency Not Found.</div>`;
        }
    },

    executeCommand(cmd) {
        try {
            const out = eval(cmd);
            this.log(out, "var(--success)");
        } catch(e) {
            this.log(e.message, "var(--danger)");
        }
    },

    verifyIntelligence() {
        // Simple default file seeding
        if (!this.state.vfs["main.js"]) {
            this.state.vfs["main.js"] = "// Nexus Main Script\nconsole.log('Online');";
        }
    },

    initGestures() {
        // Basic swipe to open menu
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
    compareFiles() { this.log("Compare module standby.", "var(--accent)"); },
    nukeSystem() { if(confirm("Wipe all local VFS data?")) { this.state.vfs = {}; location.reload(); } }
};
Nexus.bundleToSingleFile = function() {
    this.log("Initiating full system bundle...", "var(--gold)");
    
    // 1. Get the base HTML structure
    let bundledHTML = this.state.vfs['index.html'] || document.documentElement.outerHTML;

    // 2. Inline all CSS from VFS
    let styles = "";
    Object.keys(this.state.vfs).filter(f => f.endsWith('.css')).forEach(file => {
        styles += `\n/* Source: ${file} */\n${this.state.vfs[file]}\n`;
    });
    bundledHTML = bundledHTML.replace(/<link.*rel="stylesheet".*>/g, ''); // Remove external links
    bundledHTML = bundledHTML.replace('</head>', `<style>${styles}</style>\n</head>`);

    // 3. Inline all JS from VFS (excluding the Service Worker)
    let scripts = "";
    Object.keys(this.state.vfs).filter(f => f.endsWith('.js') && f !== 'sw.js').forEach(file => {
        scripts += `\n// Source: ${file}\n${this.state.vfs[file]}\n`;
    });
    bundledHTML = bundledHTML.replace(/<script.*src=".*".*><\/script>/g, ''); // Remove external scripts
    bundledHTML = bundledHTML.replace('</body>', `<script type="module">${scripts}</script>\n</body>`);

    // 4. Trigger Download
    const blob = new Blob([bundledHTML], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'Nexus_Prime_Standalone.html';
    a.click();
    
    this.log("Bundle Complete: Standalone file generated.", "var(--success)");
};
