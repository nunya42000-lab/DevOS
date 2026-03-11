/**
 * nexus-core.js - The Brain of DevOS
 * Handles State, Biometrics, and Terminal Routing.
 */

const Nexus = {
    state: {
        locked: true,
        orientation: 'portrait',
        activeFile: null,
        terminalMode: 'drawer',
        peer: null // For WebRTC Sync
    },

    async boot() {
        console.log("Nexus Booting...");
        this.checkOrientation();
        this.initEventListeners();
        
        // Load VFS and Settings
        const vfs = await localforage.getItem('nexus_vfs') || {};
        console.log("VFS Loaded", Object.keys(vfs).length, "files");

        this.updateTerminal("DevOS Nexus v2.0 Online. Type 'help' to start.");
    },

    initEventListeners() {
        window.addEventListener('resize', () => this.checkOrientation());
        
        // Biometric Unlock Trigger
        document.getElementById('auth-btn').onclick = () => this.authenticate();
        
        // Terminal Input Handling
        document.getElementById('terminal-command').onkeydown = (e) => {
            if (e.key === 'Enter') {
                this.executeCommand(e.target.value);
                e.target.value = '';
            }
        };
    },

    async authenticate() {
        // Using WebAuthn for Biometrics if supported
        if (window.PublicKeyCredential) {
            try {
                // This would typically involve a server challenge, 
                // but we can simulate a successful local biometric check
                document.body.classList.remove('state-locked');
                this.state.locked = false;
                this.haptic('success');
            } catch (err) {
                this.updateTerminal("Auth Failed: " + err);
            }
        } else {
            // Fallback for devices without biometric hardware
            const pin = prompt("Enter Master PIN:");
            if (pin === "1234") { // Placeholder
                document.body.classList.remove('state-locked');
                this.state.locked = false;
            }
        }
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
        this.updateTerminal(`> ${cmd}`, 'var(--accent)');
        const input = cmd.toLowerCase().trim();

        if (input === 'help') {
            this.updateTerminal("Available: sync, math, theme, clear, layout");
        } else if (input.startsWith('math ')) {
            this.solveMath(cmd.replace('math ', ''));
        } else if (input === 'sync') {
            this.startSync();
        } else {
            this.updateTerminal(`Unknown command: ${input}`, 'var(--warn)');
        }
    },

    checkOrientation() {
        this.state.orientation = window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
        document.body.setAttribute('data-orientation', this.state.orientation);
    },

    haptic(type) {
        if (!navigator.vibrate) return;
        const patterns = { light: 10, medium: 30, success: [20, 50, 20], error: [50, 100, 50] };
        navigator.vibrate(patterns[type] || 10);
    }
};

// Start the system
Nexus.boot();
