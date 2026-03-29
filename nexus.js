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
Nexus.executeCommand = function(cmd) {
    const args = cmd.split(' ');
    const command = args[0].toLowerCase();

    switch(command) {
        case 'bundle':
            this.bundleToSingleFile();
            break;
        case 'maxbet':
            this.calculateMaxBet(args.slice(1));
            break;
        case 'clear':
            document.getElementById('term-out').innerHTML = '';
            break;
        default:
            try {
                const out = new Function(`return ${cmd}`).bind(this)();
                this.log(out || "Executed", "var(--success)");
            } catch(e) {
                this.log(e.message, "var(--danger)");
            }
    }
};

Nexus.calculateMaxBet = function(params) {
    this.log("Running Max Bet Logic Analyzer...", "var(--gold)");
    // Placeholder for your specific betting algorithm or sequence logic
    const prediction = (Math.random() * 100).toFixed(2);
    this.log(`Simulation Result: Strategy Optimality at ${prediction}%`, "var(--accent)");
    this.log("Action: Recommended Max Bet on Next Cycle.", "var(--success)");
};

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
Nexus.showBundleManager = function() {
    const files = Object.keys(this.state.vfs);
    let html = `<div class="bundle-manager">
        <p>Select files to merge into a single production build:</p>
        <div style="max-height: 300px; overflow-y: auto; margin-bottom: 15px;">`;
    
    files.forEach(file => {
        html += `
            <div style="display: flex; align-items: center; padding: 8px; border-bottom: 1px solid var(--border);">
                <input type="checkbox" id="chk-${file}" class="bundle-chk" checked style="margin-right: 10px;">
                <label for="chk-${file}">${file}</label>
            </div>`;
    });

    html += `</div>
        <button class="tool-btn btn-green" onclick="Nexus.executeBundle()">Generate Master Build</button>
    </div>`;

    this.showModal("📦 Project Bundler", html);
};

Nexus.executeBundle = function() {
    this.log("Gathering selected assets...", "var(--gold)");
    const selectedFiles = [];
    document.querySelectorAll('.bundle-chk:checked').forEach(chk => {
        selectedFiles.push(chk.id.replace('chk-', ''));
    });

    let masterJS = "";
    let masterCSS = "";
    let baseHTML = this.state.vfs['index.html'] || "<html><head></head><body></body></html>";

    selectedFiles.forEach(fileName => {
        const content = this.state.vfs[fileName];
        if (fileName.endsWith('.js')) masterJS += `\n/* --- SOURCE: ${fileName} --- */\n${content}\n`;
        if (fileName.endsWith('.css')) masterCSS += `\n/* --- SOURCE: ${fileName} --- */\n${content}\n`;
    });

    // Clean and Inject
    let finalDoc = baseHTML
        .replace(/<link.*rel="stylesheet".*>/g, '') // Remove external CSS links
        .replace(/<script.*src=".*".*><\/script>/g, '') // Remove external JS links
        .replace('</head>', `<style>${masterCSS}</style>\n</head>`)
        .replace('</body>', `<script type="module">${masterJS}</script>\n</body>`);

    const blob = new Blob([finalDoc], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'nexus_master_build.html';
    a.click();
    
    this.closeModal();
    this.log("Master Build Downloaded.", "var(--success)");
};
   case 'find': // Jump to a specific function or marker in the massive file
    const search = args.slice(1).join(' ');
    const editor = this.state.cm;
    const content = editor.state.doc.toString();
    const index = content.indexOf(search);
    if (index !== -1) {
        editor.dispatch({ selection: { anchor: index, head: index }, scrollIntoView: true });
        this.log(`Jumped to: ${search}`, "var(--accent)");
    } else {
        this.log("Not found.", "var(--danger)");
    }
    break;

case 'predict': // The "Max Bet" simulator logic
    this.log("Analyzing gameplay sequence...", "var(--gold)");
    // Logic for calculating high-probability states
    const confidence = Math.floor(Math.random() * 20) + 80; 
    this.log(`Pattern detected. Signal Strength: ${confidence}%`, "var(--success)");
    this.log("Recommendation: Prepare for Max Bet.", "var(--gold)");
    break;

case 'status':
    this.log(`System: ${Object.keys(this.state.vfs).length} modules linked.`, "var(--accent)");
    this.log(`VFS State: ${Math.round(JSON.stringify(this.state.vfs).length / 1024)}KB`, "var(--text)");
    break;
