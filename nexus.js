/* ========================================
   FILE: nexus.js (Unified & Fixed)
   ======================================== */

const System = {
    async nuke() {
        if (confirm("WARNING: This will permanently erase ALL files, history, branches, and settings. Proceed?")) {
            await localforage.clear(); // Wipe IndexedDB
            const cacheKeys = await caches.keys();
            for (let key of cacheKeys) {
                await caches.delete(key); // Wipe Service Worker Caches
            }
            window.location.reload(); // Clean start
        }
    },

    generatePWA() {
        const manifest = {
            name: "My Nexus App",
            short_name: "App",
            display: "standalone",
            start_url: "./index.html",
            background_color: "#000000",
            theme_color: "#2f81f7",
            icons: [{"src": "icon.png", "sizes": "512x512", "type": "image/png"}]
        };

        const sw = `const CACHE = 'app-cache-v1';
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(['./', './index.html']))));
self.addEventListener('fetch', e => e.respondWith(caches.match(e.request).then(res => res || fetch(e.request))));`;

        VFS.files['manifest.json'] = JSON.stringify(manifest, null, 2);
        VFS.files['sw.js'] = sw;
        VFS.save();
        Nexus.updateTerminal("Manifest and Service Worker generated.", "var(--success)");
    }
};

const VFS = {
    files: {},
    activeFile: null,

    async init() {
        // Starts completely empty if no previous save exists
        this.files = await localforage.getItem('nexus_vfs') || {};
        this.renderExplorer();
    },

    async save() {
        await localforage.setItem('nexus_vfs', this.files);
        this.renderExplorer();
    },

    openFile(filename) {
        this.activeFile = filename;
        const content = this.files[filename] || '';
        Editor.loadContent(content, filename);
        
        // Auto-switch keyboard context based on extension
        const ext = filename.split('.').pop();
        if (VirtualKeyboard && VirtualKeyboard.render) VirtualKeyboard.render(ext);
        
        Nexus.updateTerminal(`Opened: ${filename}`);
        this.renderExplorer();
    },

    async importFiles(event) {
        const fileList = event.target.files;
        if (!fileList.length) return;

        Nexus.updateTerminal(`Importing ${fileList.length} item(s)...`, 'var(--accent)');

        for (let file of fileList) {
            if (file.name.endsWith('.zip')) {
                try {
                    const zip = await JSZip.loadAsync(file);
                    for (let relativePath in zip.files) {
                        const zipEntry = zip.files[relativePath];
                        if (!zipEntry.dir) {
                            const content = await zipEntry.async('string');
                            this.files[zipEntry.name] = content;
                        }
                    }
                    Nexus.updateTerminal(`Extracted ZIP: ${file.name}`, 'var(--success)');
                } catch (err) {
                    Nexus.updateTerminal(`ZIP Error: ${err.message}`, 'var(--warn)');
                }
            } else {
                // Regular file (js, html, css, json, txt)
                const content = await file.text();
                this.files[file.name] = content;
            }
        }
        
        await this.save();
        event.target.value = ''; // Reset input
    },

    renderExplorer() {
        const exp = document.getElementById('explorer');
        if (!exp) return;
        
        if (Object.keys(this.files).length === 0) {
            exp.innerHTML = `<div style="padding:10px; color:var(--muted); text-align:center;">No files found.<br>Import or create one.</div>`;
            return;
        }

        exp.innerHTML = Object.keys(this.files).map(f => `
            <div class="file-item ${this.activeFile === f ? 'active' : ''}" 
                 onclick="VFS.openFile('${f}')" 
                 style="padding: 8px; cursor: pointer; border-bottom: 1px solid var(--border); ${this.activeFile === f ? 'background: var(--border); color: var(--accent);' : ''}">
                📄 ${f}
            </div>
        `).join('');
    }
};

const Editor = {
    cm: null,

    init() {
        this.cm = CodeMirror(document.getElementById('editor-wrapper'), {
            value: "// Welcome to Nexus Prime\n// Select or import a file to begin.",
            mode: "javascript",
            theme: "dracula",
            lineNumbers: true,
            autoCloseBrackets: true,
            matchBrackets: true,
            viewportMargin: Infinity
        });

        this.cm.on('change', () => {
            if (VFS.activeFile) {
                VFS.files[VFS.activeFile] = this.cm.getValue();
                // We don't save to localForage on every keystroke to prevent lag, 
                // but we keep the VFS object updated.
            }
        });
    },

    loadContent(content, filename) {
        const ext = filename.split('.').pop();
        const modes = { js: 'javascript', html: 'htmlmixed', css: 'css', json: 'javascript' };
        
        this.cm.setOption("mode", modes[ext] || "javascript");
        this.cm.setValue(content);
    },

    insertText(text) {
        if (this.cm) this.cm.replaceSelection(text);
    }
};

const Nexus = {
    state: { locked: false }, // Set to true if you want biometric lock back

    async boot() {
        this.updateTerminal("DevOS Nexus Online.");
        
        // Init Subsystems
        Editor.init();
        await VFS.init();
        
        if (VirtualKeyboard && VirtualKeyboard.render) {
            VirtualKeyboard.render('js');
        }

        // Attach Import Listener
        document.getElementById('file-import-input').addEventListener('change', (e) => VFS.importFiles(e));
    },

    updateTerminal(msg, color = 'var(--text)') {
        const output = document.getElementById('terminal-output');
        const line = document.createElement('div');
        line.style.color = color;
        line.innerText = `[${new Date().toLocaleTimeString()}] ${msg}`;
        output.appendChild(line);
        output.scrollTop = output.scrollHeight;
    },

    executeCommand(cmd) {
        if (!cmd) return;
        this.updateTerminal(`> ${cmd}`, 'var(--accent)');
        const input = cmd.toLowerCase().trim();
        
        if (input === 'clear') document.getElementById('terminal-output').innerHTML = '';
        else if (input === 'nuke') System.nuke();
        else if (input === 'pwa') System.generatePWA();
        else this.updateTerminal(`Unknown command. Try: clear, nuke, pwa`);
    },

    haptic(type) {
        if (!navigator.vibrate) return;
        navigator.vibrate(type === 'light' ? 10 : 30);
    }
};

// Bind Terminal Enter Key
document.getElementById('terminal-command').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        Nexus.executeCommand(e.target.value);
        e.target.value = '';
    }
});

// Boot
window.onload = () => Nexus.boot();
