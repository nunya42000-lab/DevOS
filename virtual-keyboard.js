/**
 * virtual-keyboard.js - Context-Aware Input Ribbon
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
        if (!kb) return;
        kb.classList.remove('hidden');
        kb.innerHTML = '';

        const keys = [...(this.layouts[context] || this.layouts.js), ...this.alpha];
        
        keys.forEach(key => {
            const btn = document.createElement('button');
            btn.innerText = key;
            
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

        this.addSystemKey('Space', ' ', 'wide-key');
        this.addSystemKey('Enter', '\n', 'action-key');
        this.addSystemKey('DEL', 'BACKSPACE', 'delete-key');
    },

    type(val) {
        // Uniform entry point for all typing
        Nexus.type(val);
    },

    handleLongPress(key) {
        if (window.navigator.vibrate) window.navigator.vibrate(50);
        this.type(key.toUpperCase());
    },

    addSystemKey(label, val, className) {
        const btn = document.createElement('button');
        btn.innerText = label;
        btn.className = className;
        btn.onclick = () => this.type(val);
        const kb = document.getElementById('devos-keyboard');
        if (kb) kb.appendChild(btn);
    }
};
