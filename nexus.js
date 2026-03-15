/* ========================================
   FILE: nexus.js (Ultimate CM6 Engine)
   ======================================== */

const Nexus = {
    state: {
        vfs: {}, active: 'index.html', tabs: [], cm: null,
        languageConf: null, 
        branchesData: {}, currentBranch: 'main',
        config: { 
            haptics: true, scale: 1, termHeight: 180, gesturesEnabled: true,
            kb: ['{', '}', '(', ')', ';', '=>', '&&', '||', '!', '=', '$', '_', '.', ',', '+', '-', '*', '/', '<', '>'] 
        }
    },
Nexus.maximizeEditor = function() {
    const filename = this.state.active;
    const content = this.state.vfs[filename];

    const modalHTML = `
        <div class="editor-modal-overlay" id="nexus-editor-modal">
            <div class="editor-popup-window">
                <div class="editor-popup-header">
                    <span style="color:var(--accent); font-weight:bold;">MAXIMIZED: ${filename}</span>
                    <button class="tool-btn" onclick="Nexus.closePopupEditor()">SAVE & EXIT [X]</button>
                </div>
                <div class="editor-popup-body" id="popup-editor-target"></div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHTML);

    // Initialize the Modal Editor
    this.state.popupCm = new window.CM6.EditorView({
        state: window.CM6.EditorState.create({
            doc: content,
            extensions: [
                window.CM6.basicSetup,
                window.CM6.oneDark,
                window.CM6.EditorView.lineWrapping,
                this.state.languageConf.of(window.CM6.javascript())
            ]
        }),
        parent: document.getElementById('popup-editor-target')
    });
    
    // Force measurement for scrolling
    setTimeout(() => this.state.popupCm.requestMeasure(), 50);
};

Nexus.closePopupEditor = function() {
    if (this.state.popupCm) {
        const newCode = this.state.popupCm.state.doc.toString();
        this.state.vfs[this.state.active] = newCode;
        this.openFile(this.state.active); // Sync back to standard view
    }
    document.getElementById('nexus-editor-modal').remove();
    this.state.popupCm = null;
};
    async boot() {
        localforage.config({ name: 'Nexus_Prime_V6' });
        this.state.vfs = await localforage.getItem('vfs') || {
            'index.html': '<h1>Nexus Prime Ultimate</h1>\n<p>Scroll testing...</p>' + '\n<p>More lines...</p>'.repeat(50),
            'main.js': 'console.log("Ready.");',
            'styles.css': 'body { background: #000; color: #fff; }'
        };
        this.state.config = await localforage.getItem('config') || this.state.config;
        this.state.branchesData = await localforage.getItem('nexus_branches') || { 'main': { ...this.state.vfs } };
        this.state.currentBranch = await localforage.getItem('nexus_active_branch') || 'main';

        this.applyUIProperties();

        if (!window.CM6) {
            await new Promise(r => window.addEventListener('cm6-ready', r));
        }

        this.initEditor(this.state.vfs[this.state.active] || '');
        this.initResizer();
        this.initGestures();
        this.initTerm();
        
        this.renderAll();
        this.openFile(this.state.active);
        this.log("Nexus Prime Online.", "var(--gold)");
    },
initEditor(initialContent) {
    const editorArea = document.querySelector('.editor-area');
    editorArea.innerHTML = ''; 

    // This forces the editor's internal container to be 100% height
    const scrollTheme = window.CM6.EditorView.theme({
        "&": { height: "100%" },
        ".cm-scroller": { overflow: "auto" }
    });

    this.state.languageConf = new window.CM6.Compartment();

    this.state.cm = new window.CM6.EditorView({
        state: window.CM6.EditorState.create({
            doc: initialContent,
            extensions: [
                window.CM6.basicSetup,
                window.CM6.oneDark,
                scrollTheme, // Added the height theme
                this.state.languageConf.of(window.CM6.html()), 
                window.CM6.EditorView.lineWrapping,
                window.CM6.EditorView.updateListener.of((update) => {
                    if (update.docChanged) {
                        this.state.vfs[this.state.active] = update.state.doc.toString();
                    }
                })
            ]
        }),
        parent: editorArea
    });
   }
    openFile(filename) {
        this.state.active = filename;
        if (!this.state.tabs.includes(filename)) this.state.tabs.push(filename);
        
        const content = this.state.vfs[filename] || '';
        if (this.state.cm) {
            const ext = filename.split('.').pop().toLowerCase();
            let langExt = window.CM6.javascript();
            if (ext === 'html') langExt = window.CM6.html();
            else if (ext === 'css') langExt = window.CM6.css();

            this.state.cm.dispatch({
                changes: { from: 0, to: this.state.cm.state.doc.length, insert: String(content) },
                effects: this.state.languageConf.reconfigure(langExt)
            });
            // Force CodeMirror to recalculate height after loading content
            setTimeout(() => this.state.cm.requestMeasure(), 10);
        }
        this.renderAll();
    },

    applyUIProperties() {
        document.documentElement.style.setProperty('--ui-scale', this.state.config.scale);
        document.documentElement.style.setProperty('--term-height', this.state.config.termHeight + 'px');
    },

    initResizer() {
        const resizer = document.getElementById('resizer');
        let startY, startH;

        const onDown = (e) => {
            startY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
            startH = this.state.config.termHeight;
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onUp);
        };

        const onMove = (e) => {
            const currentY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
            const delta = startY - currentY;
            this.state.config.termHeight = Math.max(80, Math.min(window.innerHeight * 0.8, startH + delta));
            this.applyUIProperties();
            // Force editor to resize internally while dragging
            if (this.state.cm) this.state.cm.requestMeasure();
        };

        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onUp);
            this.save();
        };

        resizer.addEventListener('mousedown', onDown);
        resizer.addEventListener('touchstart', onDown);
    },

    initGestures() {
        let initialDist = 0; let initialScale = 1;
        window.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) {
                initialDist = Math.hypot(e.touches[0].pageX - e.touches[1].pageX, e.touches[0].pageY - e.touches[1].pageY);
                initialScale = this.state.config.scale;
            }
        }, { passive: false });

        window.addEventListener('touchmove', (e) => {
            if (e.touches.length !== 2) return; // Allow 1-finger scrolling
            e.preventDefault(); 
            const currentDist = Math.hypot(e.touches[0].pageX - e.touches[1].pageX, e.touches[0].pageY - e.touches[1].pageY);
            const newScale = Math.max(0.6, Math.min(2.0, initialScale * (currentDist / initialDist)));
            this.state.config.scale = parseFloat(newScale.toFixed(2));
            this.applyUIProperties();
        }, { passive: false });
    },

    async save() { 
        await localforage.setItem('vfs', this.state.vfs);
        await localforage.setItem('config', this.state.config); 
    },

    log(msg, color = "var(--text)") {
        const out = document.getElementById('term-out');
        const div = document.createElement('div');
        div.style.color = color;
        div.innerText = msg;
        out.appendChild(div);
        out.scrollTop = out.scrollHeight;
    },

    initTerm() {
        const input = document.getElementById('term-in');
        input.onkeydown = (e) => {
            if (e.key === 'Enter') {
                this.log(`> ${input.value}`);
                input.value = "";
            }
        };
    },

    renderAll() {
        const t = document.getElementById('tabs');
        t.innerHTML = "";
        this.state.tabs.forEach(tab => {
            const div = document.createElement('div');
            div.className = `tab ${tab === this.state.active ? 'active' : ''}`;
            div.innerText = tab;
            div.onclick = () => this.openFile(tab);
            t.appendChild(div);
        });
    }
};

Nexus.boot();
