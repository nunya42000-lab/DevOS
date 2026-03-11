/**
 * nexus-git.js - Branching & Version Snapshots
 */

const NexusGit = {
    branches: {},
    current: 'main',

    async init() {
        this.branches = await localforage.getItem('nexus_branches') || { 'main': { ...VFS.files } };
        this.current = await localforage.getItem('nexus_active_branch') || 'main';
        this.render();
    },

    async createBranch(name) {
        const id = name.toLowerCase().replace(/\s+/g, '-');
        if (this.branches[id]) return Nexus.updateTerminal("Branch already exists.", 'var(--warn)');
        
        // Save current progress to current branch first
        this.branches[this.current] = { ...VFS.files };
        // Clone to new branch
        this.branches[id] = { ...VFS.files };
        this.current = id;
        
        await this.persist();
        Nexus.updateTerminal(`Switched to new branch: ${id}`, 'var(--success)');
    },

    async switchBranch(id) {
        if (!this.branches[id]) return;
        
        // Save state of outgoing branch
        this.branches[this.current] = { ...VFS.files };
        this.current = id;
        
        // Load incoming branch state into VFS
        VFS.files = { ...this.branches[id] };
        await VFS.saveVFS(); // Triggers re-render of file list
        
        await this.persist();
        Nexus.updateTerminal(`Active Branch: ${id}`);
        Nexus.haptic('medium');
    },

    async persist() {
        await localforage.setItem('nexus_branches', this.branches);
        await localforage.setItem('nexus_active_branch', this.current);
        this.render();
    },

    render() {
        const container = document.getElementById('branch-list');
        if (!container) return;
        container.innerHTML = Object.keys(this.branches).map(b => `
            <div class="branch-item ${this.current === b ? 'active' : ''}" onclick="NexusGit.switchBranch('${b}')">
                ${this.current === b ? '●' : '○'} ${b}
            </div>
        `).join('');
    }
};

NexusGit.init();
