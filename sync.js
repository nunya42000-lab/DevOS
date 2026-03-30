/**
 * sync.js - PeerJS Synchronization (DevOS Nexus Prime)
 */

window.NexusSync = {
    peer: null,
    conn: null,
    isSyncing: false,

    init() {
        if (!window.Peer) {
            window.Nexus.log("[Sync] PeerJS library not loaded.", "var(--danger)");
            return;
        }
        window.Nexus.log("[Sync] Initializing PeerJS...", "var(--gold)");
        
        this.peer = new Peer(); 
        this.peer.on('open', (id) => {
            window.Nexus.log(`[Sync] Online! Your Host ID: ${id}`, "var(--success)");
            alert(`Your Host ID is: ${id}\nShare this so others can connect.`);
        });

        this.peer.on('connection', (connection) => {
            this.conn = connection;
            this.setupConnection();
            window.Nexus.log(`[Sync] Peer connected: ${connection.peer}`, "var(--accent)");
        });

        this.peer.on('error', (err) => {
            window.Nexus.log(`[Sync Error] ${err.type}`, "var(--danger)");
        });
    },

    connect(targetId) {
        if (!this.peer) this.peer = new Peer(); // Auto-init if not a host

        window.Nexus.log(`[Sync] Connecting to ${targetId}...`, "var(--gold)");
        
        // Wait for peer to get an ID before connecting
        this.peer.on('open', () => {
            this.conn = this.peer.connect(targetId);
            this.conn.on('open', () => {
                this.setupConnection();
                window.Nexus.log(`[Sync] Successfully connected to ${targetId}!`, "var(--success)");
            });
        });
    },

    setupConnection() {
        this.conn.on('data', (data) => {
            if (data.type === 'vfs_sync') {
                this.isSyncing = true;
                window.Nexus.state.vfs = data.vfs;
                window.Nexus.renderExplorer();
                if (window.Nexus.state.vfs[window.Nexus.state.activeFile] !== undefined) {
                    window.Nexus.initEditor();
                }
                window.Nexus.log("[Sync] Files updated from peer.", "var(--accent)");
                setTimeout(() => { this.isSyncing = false; }, 100);
            }
        });
        this.conn.on('close', () => {
            window.Nexus.log("[Sync] Connection closed.", "var(--warn)");
            this.conn = null;
        });
    },

    pushState() {
        if (!this.conn || this.isSyncing) return;
        if (window.Nexus.state.cm) {
            window.Nexus.state.vfs[window.Nexus.state.activeFile] = window.Nexus.state.cm.state.doc.toString();
        }
        this.conn.send({ type: 'vfs_sync', vfs: window.Nexus.state.vfs });
        window.Nexus.log("[Sync] VFS pushed to peer.", "var(--success)");
    }
};
              
