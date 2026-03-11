/**
 * nexus-sync.js - WebRTC P2P Multi-Device Engine
 */

const NexusSync = {
    peer: null,
    conn: null,

    init() {
        // Generate a random ID for this device
        const deviceId = 'devos-' + Math.floor(Math.random() * 10000);
        this.peer = new Peer(deviceId);

        this.peer.on('open', (id) => {
            Nexus.updateTerminal(`Device ID: ${id}. Share this to sync.`, 'var(--accent)');
            document.getElementById('sync-status').classList.replace('offline', 'online');
        });

        // Listen for incoming connections (e.g., from your Tablet)
        this.peer.on('connection', (connection) => {
            this.conn = connection;
            this.setupListeners();
            Nexus.updateTerminal("REMOTE DEVICE LINKED", 'var(--success)');
        });
    },

    // Connect to your other device
    connectTo(remoteId) {
        this.conn = this.peer.connect(remoteId);
        this.setupListeners();
    },

    setupListeners() {
        this.conn.on('data', (data) => {
            // If the remote device types, we insert it here
            if (data.type === 'KEYSTROKE') {
                Editor.insertText(data.value);
                Nexus.haptic('light');
            }
            // If the remote device sends a whole file
            if (data.type === 'VFS_SYNC') {
                VFS.files = data.value;
                VFS.renderExplorer();
                Nexus.updateTerminal("VFS Synchronized with remote.");
            }
        });
    },

    sendKeystroke(key) {
        if (this.conn && this.conn.open) {
            this.conn.send({ type: 'KEYSTROKE', value: key });
        }
    }
};

NexusSync.init();
