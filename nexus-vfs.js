/**
 * nexus-vfs.js - The Immutable File System
 * Uses localforage for persistence and manages the project tree.
 */

const VFS = {
    files: {},
    activeFile: null,

    async init() {
        this.files = await localforage.getItem('nexus_vfs') || {
            'index.html': '<html><body><h1>DevOS v2.0</h1></body></html>',
            'main.js': '// Start coding here\nconsole.log("Nexus Active");',
            'styles.css': 'body { background: #0d1117; color: white; }'
        };
        this.renderExplorer();
    },

    async saveFile(name, content) {
        this.files[name] = content;
        await localforage.setItem('nexus_vfs', this.files);
        Nexus.updateTerminal(`Saved: ${name}`, 'var(--success)');
        Nexus.haptic('light');
    },

    async deleteFile(name) {
        if (confirm(`Delete ${name}?`)) {
            delete this.files[name];
            await localforage.setItem('nexus_vfs', this.files);
            this.renderExplorer();
        }
    },

    renderExplorer() {
        const container = document.getElementById('file-explorer');
        container.innerHTML = '';
        
        Object.keys(this.files).sort().forEach(name => {
            const el = document.createElement('div');
            el.className = `file-item ${this.activeFile === name ? 'active' : ''}`;
            el.innerHTML = `<span>📄 ${name}</span>`;
            el.onclick = () => this.openFile(name);
            container.appendChild(el);
        });
    },

    openFile(name) {
        this.activeFile = name;
        Editor.loadContent(this.files[name], name);
        this.renderExplorer();
        
        // Auto-configure terminal context
        Nexus.terminal.setContext(name.split('.').pop());
    }
};

VFS.init();
