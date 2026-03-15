/* =============================================================================
   FILE: nexus.js (Omni-Edition Engine)
   CORE VERSION: 6.0.5 - Integrated Smart Merger & Native Sync
   ============================================================================= */

// --- 1. CORE UTILITIES: SCROLLING & UI RESIZER ---
const ScrollEngine = {
    jump(amount) {
        const view = window.Nexus.state.cm;
        if (!view) return;
        const scroller = view.scrollDOM;
        if (amount === 'TOP') scroller.scrollTo({ top: 0, behavior: 'smooth' });
        else if (amount === 'BOTTOM') scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
        else if (typeof amount === 'number') {
            const lineHeight = parseFloat(window.getComputedStyle(view.contentDOM).lineHeight) || 18;
            scroller.scrollBy({ top: amount * lineHeight, behavior: 'smooth' });
        }
    }
};

const UIResizer = {
    init() {
        const resizer = document.getElementById('resizer');
        let isResizing = false;
        if (!resizer) return;
        resizer.addEventListener('mousedown', () => isResizing = true);
        resizer.addEventListener('touchstart', () => isResizing = true);
        window.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const newHeight = window.innerHeight - e.clientY;
            if (newHeight > 50 && newHeight < window.innerHeight * 0.8) {
                document.documentElement.style.setProperty('--term-height', `${newHeight}px`);
            }
        });
        window.addEventListener('mouseup', () => isResizing = false);
        window.addEventListener('touchend', () => isResizing = false);
    }
};

// --- 2. OMNI-ENGINE: SHADOW EXECUTION & ANALYSIS ---
const OmniEngine = {
    runShadow(code) {
        const frame = document.getElementById('shadow-engine');
        const logs = document.getElementById('shadow-logs');
        if (!frame || !logs) return;

        const blob = new Blob([`
            <html><body><div id="root"></div>
            <script>
                window.onerror = (m) => window.parent.postMessage({t:'err', m}, '*');
                try { ${code} } catch(e) { window.parent.postMessage({t:'err', m:e.message}, '*'); }
            <\/script></body></html>
        `], { type: 'text/html' });

        frame.src = URL.createObjectURL(blob);
        window.onmessage = (e) => {
            if (e.data.t === 'err') {
                logs.innerText = "Runtime: " + e.data.m;
                logs.style.color = "var(--danger)";
            } else {
                logs.innerText = "Shadow: Active & Stable";
                logs.style.color = "var(--success)";
            }
        };
    },

    analyze(code) {
        const aiGuard = document.getElementById('ai-guard');
        const sast = document.getElementById('security-scan');
        const arch = document.getElementById('arch-linter');

        if (code.includes("eval(") || code.includes("innerHTML")) {
            if (sast) sast.innerHTML = `SAST: <span style="color:var(--warn)">VULNERABLE</span>`;
        }
        if (code.includes("React.render(")) {
            if (aiGuard) aiGuard.innerHTML = `AI Guard: <span style="color:var(--danger)">OUTDATED</span>`;
        }
    }
};

// --- 3. SMART MERGER & NATIVE SYNC ---
window.NexusSmartMerger = {
    openModal() {
        const html = `
            <div style="display:flex; flex-direction:column; gap:10px;">
                <textarea id="merger-input" placeholder="Paste patch here..." style="width:100%; height:200px; background:#000; color:var(--success); font-family:monospace; border:1px solid var(--border);"></textarea>
                <div style="display:flex; gap:10px;">
                    <button class="tool-btn btn-accent" style="flex:1" onclick="NexusSmartMerger.autoMerge()">🤖 Auto-Merge</button>
                    <button class="tool-btn btn-green" style="flex:1" onclick="window.Nexus.syncToLocalFolder()">📁 Sync to GitHub Folder</button>
                </div>
            </div>`;
        window.Nexus.showModal("⚡ Smart Merger", html);
    },
    autoMerge() {
        const payload = document.getElementById('merger-input').value;
        try {
            eval(payload);
            window.Nexus.log("Patch applied via Smart Merger.", "var(--success)");
            window.Nexus.closeModal();
        } catch (e) {
            window.Nexus.log("Merge Error: " + e.message, "var(--danger)");
        }
    }
};

// --- 4. MAIN NEXUS OBJECT ---
window.Nexus = {
    state: { vfs: {}, activeFile: "main.js", cm: null, history: [] },

    boot() {
        this.log("Omni-Engine Online.", "var(--accent)");
        UIResizer.init();
        
        window.addEventListener('cm6-ready', () => {
            this.initEditor();
            this.renderExplorer();
        });

        // Swipe Gestures
        let startX = 0;
        document.addEventListener('touchstart', (e) => startX = e.touches[0].clientX);
        document.addEventListener('touchend', (e) => {
            const diffX = e.changedTouches[0].clientX - startX;
            if (diffX > 100) this.toggleSidebar(true);
            if (diffX < -100) this.toggleSidebar(false);
        });
    },

    initEditor() {
        const parent = document.getElementById('editor-wrapper');
        if (this.state.cm) this.state.cm.destroy();
        this.state.cm = new window.CM6.EditorView({
            doc: this.state.vfs[this.state.activeFile] || "",
            extensions: [
                window.CM6.basicSetup,
                window.CM6.oneDark,
                window.CM6.javascript(),
                window.CM6.EditorView.updateListener.of(u => {
                    if (u.docChanged) {
                        const code = u.state.doc.toString();
                        OmniEngine.analyze(code);
                        OmniEngine.runShadow(code);
                    }
                })
            ],
            parent: parent
        });
    },

    async syncToLocalFolder() {
        if (!window.showDirectoryPicker) return this.log("API Not Supported", "var(--danger)");
        try {
            const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
            for (const [name, content] of Object.entries(this.state.vfs)) {
                const fileHandle = await dirHandle.getFileHandle(name, { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(content);
                await writable.close();
            }
            this.log("Synced to Local Repo!", "var(--success)");
        } catch (e) { this.log("Sync Aborted", "var(--warn)"); }
    },

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
        document.getElementById('modal-title').innerText = title;
        document.getElementById('modal-body').innerHTML = html;
        document.getElementById('modal-overlay').style.display = 'flex';
    },

    closeModal() { document.getElementById('modal-overlay').style.display = 'none'; },
    toggleSidebar(state) { document.getElementById('sidebar').classList.toggle('active', state); },
    toggleKb() { 
        const drawer = document.getElementById('kb-drawer');
        drawer.style.display = drawer.style.display === 'none' ? 'block' : 'none';
        if (window.VirtualKeyboard) window.VirtualKeyboard.render();
    },
    toggleTerminalPopup() {
        const term = document.getElementById('terminal-zone');
        term.style.display = term.style.display === 'none' ? 'flex' : 'none';
    },

    renderExplorer() {
        const container = document.getElementById('explorer');
        container.innerHTML = "";
        Object.keys(this.state.vfs).forEach(file => {
            const div = document.createElement('div');
            div.className = "explorer-item";
            div.innerHTML = `<span>${file}</span> <button onclick="Nexus.deleteFile('${file}')">🗑️</button>`;
            div.onclick = () => this.loadFile(file);
            container.appendChild(div);
        });
    },

    loadFile(name) {
        if (this.state.cm) this.state.vfs[this.state.activeFile] = this.state.cm.state.doc.toString();
        this.state.activeFile = name;
        this.initEditor();
    },

    deleteFile(name) {
        delete this.state.vfs[name];
        this.renderExplorer();
    }
};

window.onload = () => window.Nexus.boot();
