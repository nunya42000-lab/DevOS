/**
 * nexus-history.js - Deep History & Diff Tracker
 */

const NexusHistory = {
    history: {}, // { filename: [ {ts, code} ] }
    limit: 30,

    async init() {
        this.history = await localforage.getItem('nexus_history') || {};
    },

    async takeSnapshot(filename, code) {
        if (!this.history[filename]) this.history[filename] = [];
        
        const last = this.history[filename][this.history[filename].length - 1];
        if (last && last.code === code) return; // Skip if no change

        this.history[filename].push({ ts: Date.now(), code });
        
        if (this.history[filename].length > this.limit) this.history[filename].shift();
        
        await localforage.setItem('nexus_history', this.history);
    },

    restore(filename, timestamp) {
        const snap = this.history[filename].find(h => h.ts === timestamp);
        if (snap) {
            VFS.files[filename] = snap.code;
            VFS.saveVFS();
            Editor.loadContent(snap.code, filename);
            Nexus.updateTerminal(`Restored ${filename} to ${new Date(timestamp).toLocaleTimeString()}`);
        }
    }
};

NexusHistory.init();
