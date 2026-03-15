/**
 * virtual-keyboard.js - Context-Aware Input Ribbon
 */

const VirtualKeyboard = {
    layouts: {
        js: ['{', '}', '(', ')', ';', '=>', 'import', 'const', 'let', 'async', 'await', '?', ':', '`'],
        html: ['<', '>', '/', '=', '"', '!', 'div', 'span', 'class', 'id', 'script', 'br']
    },
    alpha: "qwertyuiopasdfghjklzxcvbnm".split(""),

    render(context = 'js') {
        const kb = document.getElementById('devos-keyboard');
        if (!kb) return;
        kb.innerHTML = '';

        const keys = [...(this.layouts[context] || this.layouts.js), ...this.alpha];
        keys.forEach(key => {
            const btn = document.createElement('button');
            btn.innerText = key;
            btn.onclick = () => this.type(key);
            kb.appendChild(btn);
        });

        this.addSystemKey('Space', ' ', 'wide-key');
        this.addSystemKey('Enter', '\n', 'action-key');
        this.addSystemKey('DEL', 'BACKSPACE', 'delete-key');
    },

    type(val) {
        // Automatically targets the active editor via Nexus.type logic
        Nexus.type(val);
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
