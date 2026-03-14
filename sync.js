const NexusSync = {
    conn: null,
    peer: null,
    
    init(peerId) {
        // Placeholder for PeerJS or WebSocket connection logic
        console.log(`[Nexus Sync] Initializing connection to ${peerId}...`);
        
        // Mock connection true for testing
        this.conn = true; 
        
        window.Nexus.log(`Sync initialized with ${peerId}`, "var(--success)");
    },

    sendKeystroke(val) {
        if (!this.conn) return;
        
        const payload = {
            type: 'keystroke',
            key: val,
            timestamp: Date.now()
        };

        // Here is where you would do: this.conn.send(JSON.stringify(payload));
        console.log("[Nexus Sync] Sending:", payload);
    },

    receiveKeystroke(payload) {
        // Prevent infinite loops by temporarily disabling sync outgoing
        const tempConn = this.conn;
        this.conn = null; 
        
        window.Nexus.type(payload.key);
        
        this.conn = tempConn; // Restore outgoing sync
    }
};

// Bind to window so the main Nexus object can find it
window.NexusSync = NexusSync;
