/**
 * nexus-terminal.js - Universal Command Processor
 */

Nexus.terminal = {
    mode: 'drawer',
    context: 'js',

    // The Math-to-Logic Engine
    solveMath(expression) {
        try {
            // 1. Calculate the result
            const result = math.evaluate(expression);
            
            // 2. Generate a JS snippet for that math
            const cleanExpr = expression.replace(/x/g, 'val');
            const snippet = `const calculate = (val) => { return ${cleanExpr}; }; // Result: ${result}`;
            
            Nexus.updateTerminal(`Math Result: ${result}`, 'var(--accent)');
            
            // Option to inject directly into code
            if (confirm("Insert this math logic as a JS function?")) {
                Editor.insertText(snippet);
            }
        } catch (err) {
            Nexus.updateTerminal("Math Error: " + err.message, 'var(--warn)');
        }
    },

    setContext(ext) {
        this.context = ext;
        Nexus.updateTerminal(`Context Switched: ${ext.toUpperCase()}`);
        // This will trigger the Virtual Keyboard to change its "Special Keys"
        if (window.VirtualKeyboard) VirtualKeyboard.render(ext);
    },

    // Command Router
    process(input) {
        if (input.startsWith('=')) { // Shortcut for math: "= 50 * 2 / 10"
            this.solveMath(input.substring(1));
            return;
        }

        switch(input) {
            case 'clear':
                document.getElementById('terminal-output').innerHTML = '';
                break;
            case 'float':
                document.getElementById('universal-terminal').className = 'terminal-float';
                break;
            case 'drawer':
                document.getElementById('universal-terminal').className = 'terminal-drawer';
                break;
            case 'build':
                Nexus.updateTerminal("Compiling PWA...", 'var(--warn)');
                // Trigger vault-compiler logic here
                break;
            default:
                Nexus.updateTerminal(`Unknown: ${input}. Try '= 2+2' or 'float'`);
        }
    }
};
