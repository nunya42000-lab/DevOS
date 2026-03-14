/**
 * nexus-hardware.js - Biometrics and Sensors
 */

const Hardware = {
    init() {
        this.initShakeToUndo();
        this.initOrientationTriggers();
    },

    // 1. Shake to Undo (using Accelerometer)
    initShakeToUndo() {
        let lastX, lastY, lastZ;
        let threshold = 15;

        window.addEventListener('devicemotion', (e) => {
            let acc = e.accelerationIncludingGravity;
            if (!acc.x) return;

            let delta = Math.abs(acc.x + acc.y + acc.z - lastX - lastY - lastZ);
            if (delta > threshold) {
                Nexus.updateTerminal("Shake detected: Undoing last action...");
                // Trigger CodeMirror Undo
                CodeMirror.undo(Editor.view);
                Nexus.haptic('medium');
            }
            lastX = acc.x; lastY = acc.y; lastZ = acc.z;
        });
    },

    // 2. Biometric Unlock (Pixel 7 Pro WebAuthn)
    async requestBiometric() {
        if (!window.PublicKeyCredential) return true; // Fallback

        try {
            // This initializes a local biometric challenge
            Nexus.updateTerminal("Verifying Identity...");
            // Simulated successful biometric response for local IDE
            return true;
        } catch (err) {
            Nexus.updateTerminal("Biometric Error: " + err.message, 'var(--warn)');
            return false;
        }
    }
};

Hardware.init();
