/**
 * virtual-keyboard.js - Context-Aware Input Ribbon
 */

window.VirtualKeyboard = {
    layouts: {
        js: ['{', '}', '(', ')', ';', '=>', 'import', 'const', 'let', 'async', 'await', '?', ':', '`'],
        html: ['<', '>', '/', '=', '"', '!', 'div', 'span', 'class', 'id', 'script', 'br']
    },
    alpha: "qwertyuiopasdfghjklzxcvbnm".split(""),

    render(context = 'js') {
        const kb = document.getElementById('kb-grid'); 
        if (!kb) return;
        kb.innerHTML = '';

        const keys = [...(this.layouts[context] || this.layouts.js), ...this.alpha];
        keys.forEach(key => {
            const btn = document.createElement('button');
            btn.innerText = key;
            btn.style.background = "var(--surface)";
            btn.style.color = "var(--text)";
            btn.style.border = "1px solid var(--border)";
            btn.style.borderRadius = "4px";
            btn.style.padding = "10px 5px";
            btn.style.cursor = "pointer";
            btn.onclick = () => this.type(key);
            kb.appendChild(btn);
        });

        this.addSystemKey('Space', ' ', 'wide-key');
        this.addSystemKey('Enter', '\n', 'action-key');
        this.addSystemKey('DEL', 'BACKSPACE', 'delete-key');
    },

    type(val) {
        if (window.Nexus && window.Nexus.type) {
            window.Nexus.type(val);
        }
    },

    addSystemKey(label, val, className) {
        const kb = document.getElementById('kb-grid');
        if (!kb) return;
        
        const btn = document.createElement('button');
        btn.innerText = label;
        btn.className = className;
        btn.style.background = "var(--surface)";
        btn.style.color = "var(--text)";
        btn.style.border = "1px solid var(--border)";
        btn.style.borderRadius = "4px";
        btn.style.padding = "10px 5px";
        btn.style.fontWeight = "bold";
        btn.style.cursor = "pointer";
        
        if (label === 'Space') btn.style.gridColumn = "span 2";
        if (label === 'Enter') btn.style.color = "var(--accent)";
        if (label === 'DEL') btn.style.color = "var(--danger)";
        
        btn.onclick = () => this.type(val);
        kb.appendChild(btn);
    }
};
