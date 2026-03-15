/* =============================================================================
   FILE: nexus.js (DevOS Nexus Prime)
   CORE VERSION: 6.0.2 - Restored Edition
   ============================================================================= */

// --- 1. NEW SCROLL ENGINE & AUTO-HIDER ---
const ScrollEngine = {
    jump(amount) {
        const view = window.Nexus.state.popupCm || window.Nexus.state.cm;
        if (!view) return;
        const scroller = view.scrollDOM;
        
        if (amount === 'TOP') {
            scroller.scrollTo({ top: 0, behavior: 'smooth' });
        } else if (amount === 'BOTTOM') {
            scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
        } else if (typeof amount === 'number') {
            const content = view.contentDOM;
            const computedStyle = window.getComputedStyle(content);
            const lineHeight = parseFloat(computedStyle.lineHeight) || 18;
            scroller.scrollBy({ top: amount * lineHeight, behavior: 'smooth' });
        }
    }
};

const NavAutoHider = {
    timeout: null,
    init() {
        const navBar = document.getElementById('quick-nav-bar');
        const editorWrapper = document.getElementById('editor-wrapper');
        if (!navBar || !editorWrapper) return;

        const hideAndReset = () => {
            navBar.classList.add('hidden');
            if (this.timeout) clearTimeout(this.timeout);
            this.timeout = setTimeout(() => navBar.classList.remove('hidden'), 1500); 
        };

        editorWrapper.addEventListener('keydown', hideAndReset);
        editorWrapper.addEventListener('touchstart', hideAndReset, { passive: true });
        editorWrapper.addEventListener('wheel', hideAndReset, { passive: true });
    }
};

// --- 2. RESTORED UI RESIZER ---
const UIResizer = {
    init() {
        const resizer = document.getElementById('resizer');
        let isResizing = false;

        if (!resizer) return;

        const startResize = (e) => {
            isResizing = true;
            document.body.style.cursor = 'row-resize';
            e.preventDefault();
        };

        const stopResize = () => {
            isResizing = false;
            document.body.style.cursor = 'default';
        };

        const resize = (e) => {
            if (!isResizing) return;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            const newHeight = window.innerHeight - clientY;
            if (newHeight > 50 && newHeight < window.innerHeight * 0.8) {
                document.documentElement.style.setProperty('--term-height', `${newHeight}px`);
                if (window.Nexus.state.cm) window.Nexus.state.cm.requestMeasure();
            }
        };

        resizer.addEventListener('mousedown', startResize);
        resizer.addEventListener('touchstart', startResize, { passive: false });
        window.addEventListener('mousemove', resize);
        window.addEventListener('touchmove', resize, { passive: false });
        window.addEventListener('mouseup', stopResize);
        window.addEventListener('touchend', stopResize);
    }
};

// --- 3. HARDWARE (Shake to Undo) ---
const Hardware = {
    initShakeToUndo() {
        let lastX, lastY, lastZ;
        const threshold = 25; 
        window.addEventListener('devicemotion', (e) => {
            const acc = e.accelerationIncludingGravity;
            if (!acc || acc.x === null) return;
            if (lastX !== undefined) {
                let delta = Math.abs(acc.x + acc.y + acc.z - lastX - lastY - lastZ);
                if (delta > threshold) {
                    window.Nexus.log("Shake Detected: Undo", "var(--gold)");
                    if (navigator.vibrate && window.Nexus.state.config.haptics) navigator.vibrate(50);
                    const view = window.Nexus.state.popupCm || window.Nexus.state.cm;
                    if (window.CM6 && view) window.CM6.undo({ state: view.state, dispatch: view.dispatch });
                }
            }
            lastX = acc.x; lastY = acc.y; lastZ = acc.z;
        }, true);
    }
};

// --- 4. SUB-SYSTEMS: VAULT, HISTORY, BRANCHES, MIC ---
window.NexusVault = {
    snippets: JSON.parse(localStorage.getItem('nexus_vault')) || {},
    openModal() {
        let html = `<div style="margin-bottom:10px;"><input type="text" id="vault-name" placeholder="Snippet Name" style="width:100%; padding:5px;"></div>
                    <button class="tool-btn btn-blue" onclick="NexusVault.saveSelection()">Save Selection</button>
                    <hr style="border-color:var(--border); margin:10px 0;">
                    <div id="vault-list" style="max-height:150px; overflow-y:auto;"></div>`;
        window.Nexus.showModal("🗄️ Vault Snippets", html);
        this.renderList();
    },
    saveSelection() {
        const name = document.getElementById('vault-name').value;
        const view = window.Nexus.state.cm;
        if (!name || !view) return;
        const selection = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
        if (selection) {
            this.snippets[name] = selection;
            localStorage.setItem('nexus_vault', JSON.stringify(this.snippets));
            this.renderList();
            window.Nexus.log(`Saved snippet: ${name}`, "var(--success)");
        }
    },
    renderList() {
        const list = document.getElementById('vault-list');
        if (!list) return;
        list.innerHTML = Object.keys(this.snippets).map(k => 
            `<div style="display:flex; justify-content:space-between; margin-bottom:5px;">
                <span style="color:var(--text); cursor:pointer;" onclick="NexusVault.insert('${k}')">${k}</span>
                <button class="tool-btn btn-red" style="padding:2px 5px;" onclick="NexusVault.delete('${k}')">X</button>
            </div>`
        ).join('');
    },
    insert(name) {
        const view = window.Nexus.state.cm;
        if (!view || !this.snippets[name]) return;
        view.dispatch(view.state.replaceSelection(this.snippets[name]));
        window.Nexus.closeModal();
    },
    delete(name) {
        delete this.snippets[name];
        localStorage.setItem('nexus_vault', JSON.stringify(this.snippets));
        this.renderList();
    }
};

window.NexusHistory = {
    snapshots: [],
    saveSnapshot() {
        const vfsCopy = JSON.parse(JSON.stringify(window.Nexus.state.vfs));
        if (window.Nexus.state.cm) vfsCopy[window.Nexus.state.activeFile] = window.Nexus.state.cm.state.doc.toString();
        const time = new Date().toLocaleTimeString();
        this.snapshots.push({ time, vfs: vfsCopy });
        this.renderList();
        window.Nexus.log(`Snapshot saved at ${time}`, "var(--accent)");
    },
    renderList() {
        const list = document.getElementById('history-list');
        if (!list) return;
        list.innerHTML = this.snapshots.map((s, i) => 
            `<div style="margin-top:5px; cursor:pointer; color:var(--text); border-bottom:1px solid var(--border);" 
                  onclick="NexusHistory.restore(${i})">📸 Snapshot ${s.time}</div>`
        ).reverse().join('');
    },
    restore(index) {
        if(confirm("Restore this snapshot? Current unsaved changes will be lost.")) {
            window.Nexus.state.vfs = JSON.parse(JSON.stringify(this.snapshots[index].vfs));
            window.Nexus.renderExplorer();
            window.Nexus.initEditor();
            window.Nexus.log("Time Machine Restore Complete.", "var(--success)");
        }
    }
};

window.NexusBranches = {
    currentBranch: 'main',
    branches: { 'main': {} },
    createBranch() {
        const name = prompt("Enter new branch name:");
        if (name && !this.branches[name]) {
            // Save current state to current branch
            if (window.Nexus.state.cm) window.Nexus.state.vfs[window.Nexus.state.activeFile] = window.Nexus.state.cm.state.doc.toString();
            this.branches[this.currentBranch] = JSON.parse(JSON.stringify(window.Nexus.state.vfs));
            
            // Create new branch
            this.branches[name] = JSON.parse(JSON.stringify(window.Nexus.state.vfs));
            this.switchBranch(name);
        }
    },
    switchBranch(name) {
        if (!this.branches[name]) return;
        if (window.Nexus.state.cm) this.branches[this.currentBranch] = JSON.parse(JSON.stringify(window.Nexus.state.vfs));
        this.currentBranch = name;
        window.Nexus.state.vfs = JSON.parse(JSON.stringify(this.branches[name]));
        this.renderList();
        window.Nexus.renderExplorer();
        window.Nexus.initEditor();
        window.Nexus.log(`Switched to branch: ${name}`, "var(--accent)");
    },
    renderList() {
        const list = document.getElementById('branch-list');
        if (!list) return;
        list.innerHTML = Object.keys(this.branches).map(b => 
            `<div style="margin-top:5px; cursor:pointer; color:${b === this.currentBranch ? 'var(--gold)' : 'var(--text)'};" 
                  onclick="NexusBranches.switchBranch('${b}')">${b === this.currentBranch ? '★ ' : '  '}${b}</div>`
        ).join('');
    }
};

window.NexusMic = {
    recognition: null,
    isListening: false,
    init() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) return;
        this.recognition = new SpeechRecognition();
        this.recognition.continuous = true;
        this.recognition.interimResults = false;
        
        this.recognition.onresult = (event) => {
            const transcript = event.results[event.results.length - 1][0].transcript;
            window.Nexus.type(transcript + ' ');
            window.Nexus.log(`[Mic]: ${transcript}`, "var(--text)");
        };
        this.recognition.onerror = (e) => window.Nexus.log(`Mic Error: ${e.error}`, "var(--danger)");
    },
    toggle() {
        if (!this.recognition) this.init();
        if (!this.recognition) return window.Nexus.log("Speech recognition not supported in this browser.", "var(--danger)");
        
        if (this.isListening) {
            this.recognition.stop();
            window.Nexus.log("Mic Offline", "var(--warn)");
        } else {
            this.recognition.start();
            window.Nexus.log("Mic Online - Listening...", "var(--success)");
        }
        this.isListening = !this.isListening;
    }
};

// --- 5. CORE NEXUS APP ---
window.Nexus = {
    state: {
        vfs: {
            "main.js": "console.log('Welcome to Nexus Prime');\n",
            "index.html": "<h1>Hello World</h1>\n"
        },
        activeFile: "main.js",
        cm: null,
        config: { haptics: true, kbEnabled: false }
    },

    boot() {
        this.log("System Boot Sequence Initiated...", "var(--success)");
        NavAutoHider.init();
        UIResizer.init();
        Hardware.initShakeToUndo();

        window.addEventListener('cm6-ready', () => {
            this.initEditor();
            this.renderExplorer();
            NexusBranches.branches['main'] = JSON.parse(JSON.stringify(this.state.vfs));
            NexusBranches.renderList();
            this.log("CM6 Engine Online.", "var(--accent)");
        });
        
        const termIn = document.getElementById('term-in');
        if (termIn) {
            termIn.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    this.executeCommand(termIn.value);
                    termIn.value = '';
                }
            });
        }
    },

    initEditor() {
        if (!window.CM6) return;
        const parent = document.getElementById('editor-wrapper');
        if (this.state.cm) this.state.cm.destroy();
        
        const fileExt = this.state.activeFile.split('.').pop();
        let langExt = window.CM6.javascript();
        if (fileExt === 'html') langExt = window.CM6.html();
        if (fileExt === 'css') langExt = window.CM6.css();

        this.state.cm = new window.CM6.EditorView({
            doc: this.state.vfs[this.state.activeFile] || "",
            extensions: [window.CM6.basicSetup, window.CM6.oneDark, langExt],
            parent: parent
        });
    },

    // --- UI Helpers ---
    showModal(title, html) {
        document.getElementById('modal-title').innerText = title;
        document.getElementById('modal-body').innerHTML = html;
        document.getElementById('modal-overlay').style.display = 'flex';
    },
    closeModal() { document.getElementById('modal-overlay').style.display = 'none'; },
    toggleSidebar() { document.getElementById('sidebar').classList.toggle('active'); },
    toggleAcc(el) {
        const body = el.nextElementSibling;
        body.classList.toggle('active');
        el.querySelector('span').innerText = body.classList.contains('active') ? '▼' : '▶';
    },
    toggleKb() {
        const drawer = document.getElementById('kb-drawer');
        const isHidden = drawer.style.display === 'none';
        drawer.style.display = isHidden ? 'block' : 'none';
        if (isHidden && window.VirtualKeyboard) window.VirtualKeyboard.render('js');
    },

    // --- Ribbon Actions ---
    newFile() {
        const name = prompt("Enter new file name:");
        if (name && !this.state.vfs[name]) {
            this.state.vfs[name] = "";
            this.renderExplorer();
            this.loadFile(name);
        }
    },
    cutText() {
        if (!this.state.cm) return;
        const view = this.state.cm;
        const selection = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
        navigator.clipboard.writeText(selection).then(() => {
            view.dispatch(view.state.replaceSelection(""));
            this.log("Cut to clipboard", "var(--text)");
        });
    },
    copyText() {
        if (!this.state.cm) return;
        const view = this.state.cm;
        const selection = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
        navigator.clipboard.writeText(selection).then(() => this.log("Copied to clipboard", "var(--text)"));
    },
    formatCode() {
        if (!window.html_beautify || !this.state.cm) return this.log("Formatter offline.", "var(--danger)");
        const view = this.state.cm;
        const formatted = window.html_beautify(view.state.doc.toString(), { indent_size: 4 });
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: formatted } });
        this.log("Code Beautified.", "var(--success)");
    },
    runLinters() {
        this.log("Running simulated Lint check...", "var(--warn)");
        if (!this.state.cm) return;
        const code = this.state.cm.state.doc.toString();
        if (code.includes("console.log")) this.log("Lint Warning: console.log found.", "var(--warn)");
        if (code.match(/var\s/)) this.log("Lint Warning: 'var' used. Consider 'let' or 'const'.", "var(--warn)");
        this.log("Lint check complete.", "var(--success)");
    },
    openFindReplace() {
        const html = `
            <input type="text" id="find-val" placeholder="Find..." style="width:100%; margin-bottom:5px; padding:5px;">
            <input type="text" id="replace-val" placeholder="Replace With..." style="width:100%; margin-bottom:10px; padding:5px;">
            <button class="tool-btn btn-blue" onclick="Nexus.executeReplace()">Replace All</button>
        `;
        this.showModal("🔍 Find & Replace", html);
    },
    executeReplace() {
        const find = document.getElementById('find-val').value;
        const replace = document.getElementById('replace-val').value;
        if (!this.state.cm || !find) return;
        const view = this.state.cm;
        const content = view.state.doc.toString();
        const newContent = content.split(find).join(replace);
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: newContent } });
        this.closeModal();
        this.log(`Replaced all instances of '${find}'`, "var(--success)");
    },
    compareFiles() {
        this.log("Diff tool requires two files. (Diff Engine Hook Ready)", "var(--accent)");
    },
    toggleVisual() {
        const preview = document.getElementById('visual-preview');
        const wrapper = document.getElementById('editor-wrapper');
        const isHidden = preview.style.display === 'none';
        
        if (isHidden) {
            preview.style.display = 'flex';
            wrapper.style.display = 'none';
            const frame = document.getElementById('preview-frame');
            // Flush CM state to VFS before rendering
            if (this.state.cm) this.state.vfs[this.state.activeFile] = this.state.cm.state.doc.toString();
            
            // Build visual output
            let htmlContent = this.state.vfs['index.html'] || "<h1>No index.html found</h1>";
            // Simple injection of css and js for preview
            if (this.state.vfs['styles.css']) htmlContent = `<style>${this.state.vfs['styles.css']}</style>` + htmlContent;
            if (this.state.vfs['main.js']) htmlContent += `<script>${this.state.vfs['main.js']}</script>`;
            
            frame.srcdoc = htmlContent;
            this.log("Visual Preview Online.", "var(--accent)");
        } else {
            preview.style.display = 'none';
            wrapper.style.display = 'flex';
            this.log("Returned to Editor.", "var(--text)");
        }
    },
    nukeSystem() {
        if(confirm("☢️ WARNING: This will format your Virtual File System and reset Nexus. Are you sure?")) {
            this.state.vfs = { "main.js": "// Clean slate.\n" };
            this.activeFile = "main.js";
            this.renderExplorer();
            this.initEditor();
            this.log("System Nuked.", "var(--danger)");
        }
    },

    // --- Core Methods ---
    type(val) {
        const view = this.state.popupCm || this.state.cm;
        if (!view) return;
        if (this.state.config.haptics && navigator.vibrate) navigator.vibrate(20);
        if (val === 'BACKSPACE') {
            window.CM6.deleteCharBackward({ state: view.state, dispatch: view.dispatch });
        } else {
            view.dispatch(view.state.replaceSelection(val));
        }
        view.focus();
    },
    loadFile(filename) {
        if (this.state.cm) this.state.vfs[this.state.activeFile] = this.state.cm.state.doc.toString();
        this.state.activeFile = filename;
        this.initEditor();
        this.log(`Loaded: ${filename}`, "var(--accent)");
    },
    renderExplorer() {
        const container = document.getElementById('explorer');
        if (!container) return;
        container.innerHTML = "";
        Object.keys(this.state.vfs).forEach(file => {
            const div = document.createElement('div');
            div.style.padding = "8px";
            div.style.cursor = "pointer";
            div.style.borderBottom = "1px solid var(--border)";
            div.innerText = (file === this.state.activeFile ? "🟢 " : "📄 ") + file;
            div.onclick = () => { this.loadFile(file); this.renderExplorer(); };
            container.appendChild(div);
        });
    },

    // --- Operations / File Syncing ---
    importFiles(event) {
        const files = event.target.files;
        if (!files.length) return;
        Array.from(files).forEach(file => {
            const reader = new FileReader();
            reader.onload = (e) => {
                this.state.vfs[file.name] = e.target.result;
                this.log(`Imported: ${file.name}`, "var(--success)");
                this.renderExplorer();
            };
            reader.readAsText(file);
        });
        event.target.value = ''; 
    },
    exportCurrentFile() {
        if (!this.state.activeFile || !this.state.cm) return;
        const content = this.state.cm.state.doc.toString();
        this.state.vfs[this.state.activeFile] = content;
        this.download(new Blob([content], { type: "text/plain" }), this.state.activeFile);
        this.log(`Exported ${this.state.activeFile}`, "var(--success)");
    },
    exportProject() {
        if (!window.JSZip || !this.state.cm) return;
        this.state.vfs[this.state.activeFile] = this.state.cm.state.doc.toString();
        const zip = new window.JSZip();
        Object.keys(this.state.vfs).forEach(filename => zip.file(filename, this.state.vfs[filename]));
        zip.generateAsync({ type: "blob" }).then(content => {
            this.download(content, "Nexus_Project.zip");
            this.log("Project Exported as ZIP.", "var(--success)");
        });
    },
    download(blob, name) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        URL.revokeObjectURL(a.href);
    },

    // --- Terminal ---
    log(msg, color = "var(--text)") {
        const term = document.getElementById('term-out');
        if (!term) return;
        const line = document.createElement('div');
        line.style.color = color;
        line.innerText = `> ${msg}`;
        term.appendChild(line);
        term.scrollTop = term.scrollHeight;
    },
    executeCommand(cmd) {
        this.log(cmd, "var(--text)");
        try { this.log(eval(cmd), "var(--success)"); } catch (e) { this.log(e.message, "var(--danger)"); }
    },
    runIntel() {
        const out = document.getElementById('intel-output');
        if (!out) return;
        out.innerHTML = `<strong>VFS Status:</strong> ${Object.keys(this.state.vfs).length} files.<br>Active: ${this.state.activeFile}`;
        this.log("Intel gathered.", "var(--accent)");
    }
};

window.onload = () => window.Nexus.boot();
