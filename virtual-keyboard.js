/**
 * virtual-keyboard.js - Context-Aware Input Ribbon
 * Replaces the system keyboard with a programmable IDE interface.
 */

const VirtualKeyboard = {
    layouts: {
        js: ['{', '}', '(', ')', ';', '=>', 'import', 'const', 'let', 'async', 'await', '?', ':', '`'],
        html: ['<', '>', '/', '=', '"', '!', 'div', 'span', 'class', 'id', 'script', 'br'],
        math: ['+', '-', '*', '/', 'sin', 'cos', 'tan', 'log', 'exp', 'PI', 'sqrt', '^']
    },
    alpha: "qwertyuiopasdfghjklzxcvbnm".split(""),

    render(context = 'js') {
        const kb = document.getElementById('devos-keyboard');
        kb.classList.remove('hidden');
        kb.innerHTML = '';

        const keys = [...(this.layouts[context] || this.layouts.js), ...this.alpha];
        
        keys.forEach(key => {
            const btn = document.createElement('button');
            btn.innerText = key;
            
            // Long Press Logic for secondary symbols
            let pressTimer;
            btn.onpointerdown = () => {
                pressTimer = setTimeout(() => this.handleLongPress(key), 500);
            };
            btn.onpointerup = () => {
                clearTimeout(pressTimer);
                this.type(key);
            };

            kb.appendChild(btn);
        });

        // Add System Keys
        this.addSystemKey('Space', ' ', 'wide-key');
        this.addSystemKey('Enter', '\n', 'action-key');
        this.addSystemKey('DEL', 'BACKSPACE', 'delete-key');
    },
// Replace the type() function in virtual-keyboard.js
type(val) {
    // Determine which editor is currently active
    const activeView = Nexus.state.popupCm || Nexus.state.cm;
    if (!activeView) return;

    const cursor = activeView.state.selection.main.head;
    
    if (val === 'BACKSPACE') {
        if (cursor > 0) {
            activeView.dispatch({ 
                changes: { from: cursor - 1, to: cursor, insert: "" } 
            });
        }
    } else {
        activeView.dispatch({
            changes: { from: cursor, insert: val },
            selection: { anchor: cursor + val.length }
        });
    }

    Nexus.haptic('light');
    if (window.NexusSync && NexusSync.conn) NexusSync.sendKeystroke(val);
}
    

    handleLongPress(key) {
        Nexus.haptic('medium');
        // Logic to toggle uppercase or alternative symbols
        const alt = key.toUpperCase();
        this.type(alt);
    },

    addSystemKey(label, val, className) {
        const btn = document.createElement('button');
        btn.innerText = label;
        btn.className = className;
        btn.onclick = () => this.type(val);
        document.getElementById('devos-keyboard').appendChild(btn);
    }
};
