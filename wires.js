// ============================================================
// DEVOS NEXUS: MAIN WIRING (wires.js)
// ============================================================
import { SentinelController } from './SentinelController.js';
import { SentinelFixer } from './sentinel.js'; // Fixed Import Path
import { NexusRefactor } from './NexusRefactor.js';

// --- 1. STATE & DOM REFERENCES ---
let currentIssues = [];
let lastKnownGoodIssues = [];
let lastKnownGoodContext = null;

const intelBtn = document.getElementById('intel-button');
const intelModal = document.getElementById('intel-modal');
const intelBackdrop = document.getElementById('intel-modal-backdrop');
const closeIntel = document.getElementById('close-intel');
const intelContent = document.getElementById('intel-content');
const intelPill = document.getElementById('intel-count-pill');

// --- 2. INTEL HUB UI & MODAL ---
const toggleIntel = (forceOpen = null) => {
    const isVisible = forceOpen !== null ? !forceOpen : intelModal.style.display === 'flex';
    intelModal.style.display = isVisible ? 'none' : 'flex';
    if (intelBackdrop) intelBackdrop.style.display = isVisible ? 'none' : 'block';
    
    // Render Visualizer map when opening
    if (!isVisible && window.contextEngine && window.NexusVisualizer) {
        window.NexusVisualizer.renderProjectMap(window.contextEngine);
    }
};

const renderIntelUI = (issues) => {
    currentIssues = issues;
    if (intelPill) intelPill.innerText = `${issues.length} Issue${issues.length !== 1 ? 's' : ''}`;
    
    if (issues.length === 0) {
        intelContent.innerHTML = `
            <div style="text-align:center; padding:60px 20px; color:var(--text); opacity:0.5;">
                <div style="font-size:32px; margin-bottom:10px;">🛡️</div>
                <div>Optimal Performance Reached. No threats detected.</div>
            </div>`;
        return;
    }

    const severityIcons = { 'CRITICAL': '🔴', 'HIGH': '🟠', 'MEDIUM': '🟡', 'LOW': '🔵' };

    intelContent.innerHTML = issues.map((issue, index) => `
        <div class="intel-issue-card">
            <div style="display:flex; justify-content:space-between; align-items:start;">
                <div>
                    <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
                        <span>${severityIcons[issue.severity] || '⚪'}</span>
                        <strong style="color:var(--gold); font-size:12px; letter-spacing:1px;">${issue.id}</strong>
                        <span style="color:var(--text); opacity:0.4; font-size:10px;">LINE ${issue.line}</span>
                    </div>
                    <div style="color:var(--text); font-size:13px; line-height:1.4;">${issue.message}</div>
                </div>
                ${issue.fix ? `
                    <button onclick="window.nexusApplyFix(${index})" class="tool-btn btn-gold" style="padding:4px 10px; font-size:10px;">AUTO-FIX</button>
                ` : ''}
            </div>
        </div>
    `).join('');
};

// --- 3. AUTO-FIX & PERSISTENCE ---
window.nexusApplyFix = async (index) => {
    const issue = currentIssues[index];
    const oldCode = window.myEditor.state.doc.toString();
    const fixedCode = SentinelFixer.applyFix(oldCode, issue);
    
    // A. Update Editor (CM6 Syntax)
    window.myEditor.dispatch({
        changes: { from: 0, to: oldCode.length, insert: fixedCode }
    });

    // B. Persist to Virtual File System
    if (window.NexusFS && window.currentFilePath) {
        await window.NexusFS.writeFile(window.currentFilePath, fixedCode);
        console.log(`[Sentinel] Fix persisted to ${window.currentFilePath}`);
    }

    // C. Re-scan immediately
    sentinel.check(fixedCode);
    if (currentIssues.length <= 1) toggleIntel(false);
};

// --- 4. SENTINEL ENGINE INIT ---
const sentinel = new SentinelController('./sentinel.worker.js', (issues) => {
    renderIntelUI(issues);
    
    // Visual Pulse for the Intel Button
    const hasCritical = issues.some(i => i.severity === 'CRITICAL');
    if (intelBtn) {
        intelBtn.classList.toggle('btn-red', hasCritical);
        if (!hasCritical) intelBtn.classList.add('btn-gold');
    }

    // Run Neural Analysis Delta if baseline exists
    if (lastKnownGoodContext && window.contextEngine && window.NexusNeural) {
        const delta = window.NexusNeural.analyzeDelta(lastKnownGoodIssues, issues, lastKnownGoodContext, window.contextEngine);
        // Dispatch to UI
        if (window.renderNeuralReview) window.renderNeuralReview(delta);
    }
});

// --- 5. SYSTEM EVENT LISTENERS ---
if (intelBtn) intelBtn.addEventListener('click', () => toggleIntel());
if (closeIntel) closeIntel.addEventListener('click', () => toggleIntel(false));
if (intelBackdrop) intelBackdrop.addEventListener('click', () => toggleIntel(false));

// Fixed: Async Callback pattern instead of synchronous execution
window.NexusFS.onFileLoad = (path, content) => {
    sentinel.check(content, (issues) => {
        lastKnownGoodIssues = issues;
        if (window.contextEngine) {
            lastKnownGoodContext = JSON.parse(JSON.stringify(window.contextEngine)); 
        }
    });
};

window.nexusPromptRename = async () => {
    const oldName = prompt("Rename identifier:");
    if (!oldName) return;
    const newName = prompt(`Rename '${oldName}' to:`);
    if (!newName) return;

    if (confirm(`Proceed with renaming '${oldName}' to '${newName}'?`)) {
        await NexusRefactor.rename(oldName, newName, window.contextEngine);
    }
};

// --- 6. UI & UX WIRING ---
document.addEventListener("DOMContentLoaded", () => {
    initInfiniteRibbon();
    initEdgeSwipes();
    initReadOnlyGuard();
    initCommandPrompt();
    initOmniGestures();
    
    // Fixed: Wait for editor to exist before attaching hooks
    initEditorHooks();
});

function initEditorHooks() {
    if (!window.myEditor) {
        setTimeout(initEditorHooks, 100); // Check again in 100ms
        return;
    }
    window.myEditor.onUpdate((update) => {
        if (update.docChanged) {
            sentinel.check(update.state.doc.toString());
        }
    });
}

function initInfiniteRibbon() {
    const track = document.querySelector('.ribbon-track');
    if (!track) return;
    const items = Array.from(track.children);
    
    items.forEach(item => track.appendChild(item.cloneNode(true)));
    items.forEach(item => track.appendChild(item.cloneNode(true)));

    track.parentElement.addEventListener('scroll', (e) => {
        const ribbon = e.target;
        if (ribbon.scrollLeft <= 0 || ribbon.scrollLeft >= (track.scrollWidth / 3) * 2) {
            ribbon.scrollLeft = track.scrollWidth / 3;
        }
    });
    setTimeout(() => { document.getElementById('ribbon-toolbar').scrollLeft = track.scrollWidth / 3; }, 50);
}

function initEdgeSwipes() {
    let startX = 0;
    const threshold = 40; 
    
    document.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
    document.addEventListener('touchend', e => {
        const diffX = e.changedTouches[0].clientX - startX;
        if (startX < threshold && diffX > 50) document.getElementById('panel-left')?.classList.add('open');
        if (startX > window.innerWidth - threshold && diffX < -50) document.getElementById('panel-right')?.classList.add('open');
    }, { passive: true });

    document.querySelectorAll('.close-panel').forEach(btn => {
        btn.addEventListener('click', (e) => document.getElementById(e.target.dataset.target)?.classList.remove('open'));
    });
}

function initReadOnlyGuard() {
    const toggle = document.getElementById('readonly-toggle');
    const wrapper = document.getElementById('editor-wrapper');
    if (!toggle || !wrapper) return;
    
    const shield = document.createElement('div');
    shield.id = 'editor-shield';
    wrapper.appendChild(shield);

    toggle.addEventListener('change', () => {
        shield.classList.toggle('active', toggle.checked);
        document.querySelector('.toggle-label').style.color = toggle.checked ? "var(--success)" : "var(--text)";
    });
}

function initCommandPrompt() {
    const cmdOverlay = document.getElementById('cmd-overlay');
    const cmdInput = document.getElementById('cmd-input');
    if (!cmdOverlay || !cmdInput) return;
    
    document.addEventListener('click', (e) => {
        if (e.target.id === 'btn-cmd' || e.target.textContent.includes('CMD')) {
            cmdOverlay.classList.add('active');
            setTimeout(() => cmdInput.focus(), 100);
        }
    });

    cmdOverlay.addEventListener('click', (e) => { if (e.target === cmdOverlay) cmdOverlay.classList.remove('active'); });
    cmdInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            console.log(`[Nexus] Executing: ${cmdInput.value}`);
            cmdInput.value = '';
            cmdOverlay.classList.remove('active');
        }
    });
}

function initOmniGestures() {
    const canvas = document.getElementById('omni-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    const resizeCanvas = () => {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    };
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();

    const gestureEngine = new window.OmniGesture((cmd) => {
        switch(cmd) {
            case 'FIX': if (currentIssues.length > 0) window.nexusApplyFix(0); break;
            case 'INTEL': toggleIntel(); break;
            case 'REFRESH': sentinel.check(window.myEditor.state.doc.toString()); break;
            case 'DREAMER': console.log("[Dreamer] Initiating Night Cycle..."); break;
        }
    });

    let isDrawing = false;

    window.addEventListener('keydown', (e) => { if (e.key === 'Control') canvas.classList.add('active'); });
    window.addEventListener('keyup', (e) => {
        if (e.key === 'Control') {
            canvas.classList.remove('active');
            gestureEngine.process();
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
    });

    document.addEventListener('touchstart', (e) => { if (e.touches.length === 3) canvas.classList.add('active'); });

    canvas.addEventListener('mousemove', (e) => {
        if (!canvas.classList.contains('active')) return;
        gestureEngine.record(e.clientX, e.clientY);
        ctx.strokeStyle = 'var(--accent)'; ctx.lineWidth = 3;
        ctx.lineTo(e.clientX, e.clientY); ctx.stroke();
    });

    canvas.addEventListener('touchstart', (e) => {
        if (!canvas.classList.contains('active')) return;
        isDrawing = true;
        ctx.beginPath();
        ctx.moveTo(e.touches[0].clientX, e.touches[0].clientY);
    });

    canvas.addEventListener('touchmove', (e) => {
        if (!isDrawing) return;
        gestureEngine.record(e.touches[0].clientX, e.touches[0].clientY);
        ctx.strokeStyle = 'var(--accent)'; ctx.lineWidth = 3;
        ctx.lineTo(e.touches[0].clientX, e.touches[0].clientY); ctx.stroke();
    });

    canvas.addEventListener('touchend', () => {
        if (!isDrawing) return;
        isDrawing = false;
        canvas.classList.remove('active');
        gestureEngine.process();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    });
}

window.renderNeuralReview = (delta) => {
    const intelContent = document.getElementById('intel-content');
    if (!intelContent) return;
    
    const statusColor = delta.summary.some(s => s.includes('⚠️') || s.includes('📉')) ? 'var(--danger)' : 'var(--success)';

    const existingReview = document.getElementById('neural-logic-review-block');
    if (existingReview) existingReview.remove();

    const reviewHtml = `
        <div id="neural-logic-review-block" style="margin-top: 20px; padding: 15px; background: rgba(0,0,0,0.3); border: 1px solid ${statusColor}; border-radius: 8px;">
            <div style="color:${statusColor}; font-weight:bold; font-size:11px; margin-bottom:10px; letter-spacing:1px;">NEURAL LOGIC REVIEW</div>
            <ul style="list-style:none; padding:0; margin:0; font-size:12px; color:var(--text);">
                ${delta.summary.map(s => `<li style="margin-bottom:8px;">${s}</li>`).join('')}
            </ul>
        </div>
    `;

    intelContent.insertAdjacentHTML('afterbegin', reviewHtml);
};
