/**
 * virtual-keyboard.js - Context-Aware Input Ribbon
 */

 window.VirtualKeyboard = {
    render(layout) {
        const kb = document.createElement('div');
        kb.id = "kb-drawer";
        kb.style = "position:fixed; bottom:0; width:100%; background:var(--panel); border-top:1px solid var(--border); padding:10px; z-index:9999; display:grid; grid-template-columns: repeat(10, 1fr); gap:5px; transform:translateY(100%); transition:0.3s;";
        
        const keys = "QWERTYUIOPASDFGHJKLZXCVBNM".split('');
        keys.forEach(key => {
            const btn = document.createElement('button');
            btn.innerText = key;
            btn.style = "background:var(--surface); color:var(--text); border:1px solid var(--border); padding:10px 5px; cursor:pointer;";
            btn.onclick = () => this.type(key);
            kb.appendChild(btn);
        });
        
        document.body.appendChild(kb);
    },
    type(val) {
        if (window.Nexus) window.Nexus.type(val);
    }
};


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
window.VirtualKeyboard = {
    render(keys) {
        const kb = document.getElementById('kb-drawer');
        kb.innerHTML = '';
        
        // Triple the keys to ensure seamless looping
        const tripleKeys = [...keys, ...keys, ...keys];
        
        tripleKeys.forEach((key, index) => {
            const btn = document.createElement('button');
            btn.className = 'kb-item tool-btn';
            btn.innerText = key;
            btn.onclick = () => window.Nexus.type(key);
            kb.appendChild(btn);
        });

        // Loop detection logic
        kb.onscroll = () => {
            const itemWidth = 70; // width + margin
            const totalWidth = keys.length * itemWidth;
            
            if (kb.scrollLeft >= totalWidth * 2) {
                kb.scrollLeft = totalWidth; // Reset to middle
            } else if (kb.scrollLeft <= 0) {
                kb.scrollLeft = totalWidth; // Reset to middle
            }
        };

        // Initialize at the middle set of keys
        setTimeout(() => kb.scrollLeft = keys.length * 70, 10);
    }
};
