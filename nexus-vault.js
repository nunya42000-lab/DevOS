/**
 * nexus-vault.js - Snippets and Bundling
 */

const Vault = {
    snippets: [],

    async init() {
        this.snippets = await localforage.getItem('nexus_snippets') || [];
    },

    async addSnippet(name, code) {
        this.snippets.push({ id: Date.now(), name, code });
        await localforage.setItem('nexus_snippets', this.snippets);
        Nexus.updateTerminal(`Snippet "${name}" added to Vault.`);
    },

    compile() {
        Nexus.updateTerminal("Starting Production Bundle...", 'var(--accent)');
        
        // 1. Minification simulation (joining files)
        const bundle = Object.entries(VFS.files)
            .map(([name, content]) => `/* File: ${name} */\n${content}`)
            .join('\n\n');
            
        // 2. Create a downloadable blob
        const blob = new Blob([bundle], { type: 'text/javascript' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'devos-bundle.js';
        a.click();
        
        Nexus.updateTerminal("Build Complete. Download started.", 'var(--success)');
    },

    exportAIContext() {
        const context = Object.entries(VFS.files)
            .map(([name, content]) => `FILE: ${name}\n\`\`\`\n${content}\n\`\`\``)
            .join('\n\n');
        
        navigator.clipboard.writeText(context);
        Nexus.updateTerminal("Project context copied for AI Assistant.");
        Nexus.haptic('success');
    }
};
