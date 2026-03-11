/**
 * nexus-visual.js - State Machine & Audio Synth
 */

const VisualTools = {
    // Restores the logic for IDLE -> SPINNING -> WIN transitions
    generateStateMachine(states) {
        const logic = `switch(currentState) {\n${states.map(s => 
            `  case '${s}':\n    // Logic for ${s}\n    break;`
        ).join('\n')}\n}`;
        
        Editor.insertText(logic);
        Nexus.updateTerminal("State machine injected.", 'var(--success)');
    },

    // Restores the Audio Synth from your original audio logic
    playBeep(freq = 440, type = 'sine') {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, ctx.currentTime);
        osc.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.1);
    }
};
