/* =============================================================================
   FILE: nexus.js (DevOS Nexus Prime)
   CORE VERSION: 6.0.1
   ============================================================================= */

// --- 1. THE PROGRAMMATIC SCROLL ENGINE ---
const ScrollEngine = {
    jump(amount) {
        const view = window.Nexus.state.popupCm || window.Nexus.state.cm;
        if (!view) return;

        const scroller = view.scrollDOM;
        
        if (amount === 'TOP') {
            scroller.scrollTo({ top: 0, behavior: 'smooth' });
            window.Nexus.log("Scrolled to Top", "var(--accent)");
        } 
        else if (amount === 'BOTTOM') {
            scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
            window.Nexus.log("Scrolled to Bottom", "var(--accent)");
        } 
        else if (typeof amount === 'number') {
            const content = view.contentDOM;
            const computedStyle = window.getComputedStyle(content);
            const lineHeight = parseFloat(computedStyle.lineHeight) || 18;
            scroller.scrollBy({ top: amount * lineHeight, behavior: 'smooth' });
        }
    }
};

// --- 2. AUTO-HIDER FOR NAVIGATION ---
const NavAutoHider = {
    timeout: null,
    
    init() {
        const navBar = document.getElementById('quick-nav-bar');
        const editorWrapper = document.getElementById('editor-wrapper');
        
        if (!navBar || !editorWrapper) return;

        const hideAndReset = () => {
            navBar.classList.add('hidden');
            if (this.timeout) clearTimeout(this.timeout);
            this.timeout = setTimeout(() => {
                navBar.classList.remove('hidden');
            }, 1500); 
        };

        editorWrapper.addEventListener('keydown', hideAndReset);
        editorWrapper.addEventListener('touchstart', hideAndReset, { passive: true });
        editorWrapper.addEventListener('wheel', hideAndReset, { passive: true });
    }
};

// --- 3. HARDWARE INTEGRATION ---
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
                    window.Nexus.log("Shake Detected: Processing Undo...", "var(--gold)");
                    if (navigator.vibrate && window.Nexus.state.config.haptics) navigator.vibrate(50);
                    
                    const view = window.Nexus.state.popupCm || window.Nexus.state.cm;
                    if (window.CM6 && view) {
                        window.CM6.undo({ state: view.state, dispatch: view.dispatch });
                    }
                }
            }
            lastX = acc.x; lastY = acc.y; lastZ = acc.z;
        }, true);
    }
};

// --- 4. CORE NEXUS STATE & LOGIC ---
window.Nexus = {
    state: {
        vfs: {
            "main.js": "console.log('Welcome to Nexus Prime');\n",
            "index.html": "<h1>Hello World</h1>\n"
        },
        activeFile: "main.js",
        cm: null,
        popupCm: null,
        config: {
            haptics: true,
            kbEnabled: false,
            kb: []
        }
    },

    boot() {
        this.log("System Boot Sequence Initiated...", "var(--success)");
        
        // Initialize Auto-Hider and Hardware
        NavAutoHider.init();
        Hardware.initShakeToUndo();

        // Wait for CodeMirror to be ready
        window.addEventListener('cm6-ready', () => {
            this.initEditor();
            this.renderExplorer();
            this.log("CM6 Engine Online.", "var(--accent)");
        });
        
        // Setup Terminal Input
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
        
        // Remove old instance if exists
        if (this.state.cm) this.state.cm.destroy();
        
        this.state.cm = new window.CM6.EditorView({
            doc: this.state.vfs[this.state.activeFile] || "",
            extensions: [
                window.CM6.basicSetup,
                window.CM6.oneDark,
                window.CM6.javascript() // Defaulting to JS for simplicity
            ],
            parent: parent
        });
    },

    // --- UI & Modals ---
    showModal(title, htmlContent) {
        document.getElementById('modal-title').innerText = title;
        document.getElementById('modal-body').innerHTML = htmlContent;
        document.getElementById('modal-overlay').classList.add('active');
    },

    closeModal() {
        document.getElementById('modal-overlay').classList.remove('active');
    },

    openHelp() {
        this.showModal("📖 Help & Documentation", `
            <div style="color: var(--text); font-size: 14px; line-height: 1.5;">
                <p>Welcome to <strong>DevOS Nexus Prime</strong>.</p>
                <ul style="padding-left: 20px;">
                    <li style="margin-bottom: 8px;"><strong>File Explorer:</strong> Manage your Virtual File System (VFS).</li>
                    <li style="margin-bottom: 8px;"><strong>Hardware:</strong> Shake your device to trigger an undo in the editor.</li>
                    <li style="margin-bottom: 8px;"><strong>Terminal:</strong> Run JS commands or view Intel.</li>
                </ul>
            </div>
        `);
    },

    openSettings() {
        const html = `
            <div style="display:flex; flex-direction:column; gap:15px; font-size: 14px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span>Haptic Feedback</span>
                    <input type="checkbox" onchange="Nexus.state.config.haptics = this.checked" ${this.state.config.haptics ? 'checked' : ''}>
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span>Virtual Keyboard</span>
                    <input type="checkbox" onchange="Nexus.state.config.kbEnabled = this.checked;" ${this.state.config.kbEnabled ? 'checked' : ''}>
                </div>
            </div>
        `;
        this.showModal("⚙️ Settings", html);
    },

    toggleSidebar() {
        document.getElementById('sidebar').classList.toggle('active');
    },

    toggleAcc(element) {
        const body = element.nextElementSibling;
        body.classList.toggle('active');
        const span = element.querySelector('span');
        span.innerText = body.classList.contains('active') ? '▼' : '▶';
    },

    toggleKb() {
        const drawer = document.getElementById('kb-drawer');
        drawer.classList.toggle('active');
        if (drawer.classList.contains('active') && window.VirtualKeyboard) {
            window.VirtualKeyboard.render('js');
        }
    },

    // --- Editor Actions ---
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

    formatCode() {
        if (!window.html_beautify) {
            this.log("Formatter not loaded yet.", "var(--danger)");
            return;
        }
        const view = this.state.cm;
        const code = view.state.doc.toString();
        const formatted = window.html_beautify(code, { indent_size: 4 });
        
        view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: formatted }
        });
        this.log("Code Formatted Successfully.", "var(--success)");
    },
    download(blob, name) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        URL.revokeObjectURL(a.href);
    },
                      
    newFile() {
        const name = prompt("Enter new file name:");
        if (name && !this.state.vfs[name]) {
            this.state.vfs[name] = "";
            this.renderExplorer();
            this.loadFile(name);
        }
    },

    loadFile(filename) {
        if (this.state.cm) {
            // Save current file
            this.state.vfs[this.state.activeFile] = this.state.cm.state.doc.toString();
        }
        this.state.activeFile = filename;
        this.initEditor();
        this.toggleSidebar();
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
            div.innerText = "📄 " + file;
            div.onclick = () => this.loadFile(file);
            container.appendChild(div);
        });
    },

    // --- Terminal & Intel ---
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
        try {
            const result = eval(cmd);
            this.log(result, "var(--success)");
        } catch (e) {
            this.log(e.message, "var(--danger)");
        }
    },

    runIntel() {
        this.intelDeps();
        this.intelStorage();
    },

    intelDeps() {
        const output = document.getElementById('intel-output');
        if (!output) return;
        const deps = [
            "CodeMirror 6.0.1 (ESM)", "LocalForage 1.10.0", 
            "Math.js 11.8.0", "JSZip 3.10.1", "PeerJS 1.4.7"
        ];
        output.innerHTML = "<strong>Loaded Dependencies:</strong><br><br>" + deps.join("<br>");
    },

    intelStorage() {
        const output = document.getElementById('intel-output');
        if (!output) return;
        
        if (window.localforage) {
            window.localforage.keys().then(keys => {
                const kbSize = (JSON.stringify(this.state.vfs).length / 1024).toFixed(2);
                output.innerHTML += `<br><br><strong>LocalForage Storage:</strong><br><br>Keys Count: ${keys.length}<br>Estimated VFS Size: ${kbSize} KB`;
            }).catch(err => {
                output.innerHTML += `<br><br><span style="color:var(--danger)">Storage Read Error: ${err}</span>`;
            });
        }
    }
};

// Start boot sequence when page loads
window.onload = () => window.Nexus.boot();
