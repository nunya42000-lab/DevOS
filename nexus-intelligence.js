/**
 * nexus-intelligence.js - Dependency Mapping & Stats
 */

const Intelligence = {
    map: {},

    analyze() {
        this.map = {};
        Object.entries(VFS.files).forEach(([name, content]) => {
            if (!name.endsWith('.js')) return;
            
            // Regex to find variable/function definitions and calls
            const provides = content.match(/(?:function\s+|const\s+|let\s+)([a-zA-Z_$][\w$]*)/g) || [];
            const requires = content.match(/([a-zA-Z_$][\w$]*)\s*\(/g) || [];

            this.map[name] = {
                provides: provides.map(p => p.split(/\s+/).pop()),
                requires: requires.map(r => r.replace('(', '').trim())
            };
        });
        
        this.renderStats();
    },

    renderStats() {
        const totalLines = Object.values(VFS.files).reduce((a, b) => a + b.split('\n').length, 0);
        Nexus.updateTerminal(`Project Intelligence: ${Object.keys(VFS.files).length} files, ${totalLines} lines of logic.`);
    }
};
