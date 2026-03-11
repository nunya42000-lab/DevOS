/**
 * nexus-preview.js - Live Sandbox & Hardware Simulation
 */

const Preview = {
    fps: 0,
    lastTime: performance.now(),

    init() {
        this.startFPSCounter();
    },

    refresh() {
        const frame = document.getElementById('live-preview-frame');
        if (!frame) return;

        const html = VFS.files['index.html'] || '';
        const css = `<style>${VFS.files['styles.css'] || ''}</style>`;
        const js = `<script>${VFS.files['main.js'] || ''}<\/script>`;

        const blob = new Blob([html + css + js], { type: 'text/html' });
        frame.src = URL.createObjectURL(blob);
        
        Nexus.updateTerminal("Sandbox Refreshed", 'var(--success)');
        Nexus.haptic('medium');
    },

    startFPSCounter() {
        const track = (now) => {
            const delta = now - this.lastTime;
            this.lastTime = now;
            this.fps = Math.round(1000 / delta);
            // In a real build, we display this in the UI corner
            requestAnimationFrame(track);
        };
        requestAnimationFrame(track);
    }
};

Preview.init();
