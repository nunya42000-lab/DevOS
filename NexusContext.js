/**
 * NexusContext.js
 * ------------------------------------
 * Semantic Context Engine, Assembler, and Visualizer.
 */
import * as acorn from 'https://esm.sh/acorn@8.11.3';

export class NexusContext {
    constructor() {
        this.graph = new Map(); 
        this.definitions = new Map(); 
    }

    indexFile(path, ast) {
        this.traverse(ast, (node) => {
            if (node.type === 'FunctionDeclaration' && node.id) {
                this.definitions.set(node.id.name, { path, line: node.loc.start.line, type: 'function' });
            }
            if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
                this.definitions.set(node.id.name, { path, line: node.loc.start.line, type: 'variable' });
            }
            if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
                const name = node.callee.name;
                if (!this.graph.has(name)) this.graph.set(name, []);
                this.graph.get(name).push({ path, line: node.loc.start.line });
            }
        });
    }

    getImpactRadius(identifier) { return this.graph.get(identifier) || []; }
    getDefinition(identifier) { return this.definitions.get(identifier); }

    traverse(node, cb) {
        if (!node) return;
        cb(node);
        for (let k in node) {
            if (node[k] && typeof node[k] === 'object') {
                if (Array.isArray(node[k])) node[k].forEach(c => this.traverse(c, cb));
                else this.traverse(node[k], cb);
            }
        }
    }
}

export const NexusAssembler = {
    split(code) {
        const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'module' });
        const parts = {};
        ast.body.forEach(node => {
            const name = node.id?.name || `anon_${node.start}`;
            parts[name] = code.substring(node.start, node.end);
        });
        return parts;
    },
    merge(partsMap) {
        return Object.values(partsMap).join('\n\n');
    }
};

export const NexusVisualizer = {
    renderProjectMap(contextEngine) {
        const container = document.getElementById('intel-content');
        if (!container) return;
        
        const graph = contextEngine.graph;
        const defs = contextEngine.definitions;

        let html = `<div style="padding:10px; font-family:monospace;">
            <h4 style="color:var(--gold); border-bottom:1px solid var(--border); padding-bottom:5px;">DEPENDENCY MAP</h4>`;

        defs.forEach((data, name) => {
            const consumers = graph.get(name) || [];
            if (consumers.length > 0) {
                html += `
                <div style="margin-bottom:12px; padding:8px; background:var(--surface); border-radius:4px;">
                    <div style="color:var(--accent); font-weight:bold;">ƒ ${name}</div>
                    <div style="font-size:10px; opacity:0.5; margin-bottom:5px;">Defined in: ${data.path}</div>
                    <div style="padding-left:10px; border-left:1px solid #444;">
                        ${consumers.map(c => `
                            <div style="font-size:11px; color:var(--text);">↳ used by <span style="color:var(--gold);">${c.path}</span> (Line ${c.line})</div>
                        `).join('')}
                    </div>
                </div>`;
            }
        });
        html += `</div>`;
        container.innerHTML = html;
    }
};
