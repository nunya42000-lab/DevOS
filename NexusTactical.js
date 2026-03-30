/**
 * NexusTactical.js
 * -------------------------
 * Contains the Omni-Gesture Engine for tactical mobile input 
 * and the Vortex Z-Layer Visualizer.
 */

export class OmniGesture {
    constructor(onCommand) {
        this.path = [];
        this.onCommand = onCommand;
        this.library = {
            'DRUL': 'REFRESH',   // Square: Down-Right-Up-Left
            'DL': 'FIX',         // L-shape: Down-Left
            'R': 'NEXT_ISSUE',   // Swipe Right
            'L': 'PREV_ISSUE',   // Swipe Left
            'UDUD': 'INTEL',     // Zig-zag: Up-Down-Up-Down
            'CIRCLE': 'DREAMER'  // Handled by specific curvature logic
        };
    }

    record(x, y) {
        this.path.push({ x, y });
    }

    process() {
        if (this.path.length < 5) return this.reset();

        const directions = this.getDirectionString();
        const command = this.library[directions];

        if (command) {
            console.log(`[Omni] Gesture Recognized: ${command}`);
            this.onCommand(command);
        }
        this.reset();
    }

    getDirectionString() {
        let str = "";
        for (let i = 1; i < this.path.length; i++) {
            const dx = this.path[i].x - this.path[i-1].x;
            const dy = this.path[i].y - this.path[i-1].y;
            
            // Only record significant movement to filter micro-jitters
            if (Math.abs(dx) < 10 && Math.abs(dy) < 10) continue;

            let dir = Math.abs(dx) > Math.abs(dy) 
                ? (dx > 0 ? 'R' : 'L') 
                : (dy > 0 ? 'D' : 'U');
            
            if (str[str.length - 1] !== dir) str += dir;
        }
        return str;
    }

    reset() {
        this.path = [];
    }
}

export const NexusVortex = {
    explode(containerSelector) {
        const elements = document.querySelectorAll(`${containerSelector} *`);
        elements.forEach(el => {
            const z = window.getComputedStyle(el).zIndex;
            if (z !== 'auto') {
                // Apply a CSS transform based on Z-depth for a 3D view
                el.style.transition = "transform 0.5s ease";
                el.style.transform = `translateZ(${z * 50}px) rotateY(20deg)`;
                el.style.boxShadow = "0 0 10px rgba(77, 148, 255, 0.5)";
            }
        });
    }
};

// Expose globally for wires.js
window.OmniGesture = OmniGesture;
window.NexusVortex = NexusVortex;
