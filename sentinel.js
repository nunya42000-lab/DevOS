/**
 * DevOS Sentinel Master Module (sentinel.js)
 * ------------------------------------------
 * Combines the Dashboard UI, the Auto-Fixer, the core AST Analyzer,
 * and the Project-Wide Scanner into a single unified file.
================================================= */

import * as acorn from 'https://esm.sh/acorn@8.11.3';

export class SentinelDashboard {
  constructor(containerId, onFixRequest) {
    this.container = document.getElementById(containerId);
    this.onFixRequest = onFixRequest;
    this.issues = [];
    this.render();
  }

  update(issues) {
    this.issues = issues;
    this.render();
  }

  render() {
    if (!this.container) return;

    const severityColors = {
      'CRITICAL': '#ff4d4d',
      'HIGH': '#ff944d',
      'MEDIUM': '#ffdb4d',
      'LOW': '#4d94ff',
      'FATAL': '#000000'
    };

    this.container.innerHTML = `
      <div style="font-family: monospace; background: #1e1e1e; color: #ccc; height: 100%; display: flex; flex-direction: column;">
        <div style="padding: 8px; border-bottom: 1px solid #333; display: flex; justify-content: space-between;">
          <span>PROBLEMS (${this.issues.length})</span>
          <span style="cursor: pointer;" onclick="this.parentElement.parentElement.style.display='none'">×</span>
        </div>
        <div style="flex: 1; overflow-y: auto;">
          ${this.issues.length === 0 ? 
            '<div style="padding: 20px; text-align: center; color: #666;">No issues detected. Your code is clean!</div>' : 
            this.issues.map((issue, index) => `
              <div style="padding: 8px; border-bottom: 1px solid #252525; display: flex; align-items: start; gap: 10px; font-size: 12px;">
                <span style="color: ${severityColors[issue.severity] || '#ccc'}; font-weight: bold;">[${issue.severity}]</span>
                <div style="flex: 1;">
                  <div style="color: #eee;">${issue.message}</div>
                  <div style="color: #888;">Line ${issue.line}, Col ${issue.column} (${issue.id})</div>
                </div>
                ${issue.fix ? `
                  <button 
                    onclick="window.dispatchSentinelFix(${index})"
                    style="background: #333; color: #fff; border: 1px solid #555; padding: 2px 8px; cursor: pointer; border-radius: 3px;"
                  >Fix</button>` : ''}
              </div>
            `).join('')
          }
        </div>
      </div>
    `;

    // Global hook for the inline buttons
    window.dispatchSentinelFix = (index) => {
      this.onFixRequest(this.issues[index]);
    };
  }
}

/* =========================================================
   2. SENTINEL FIXER (Auto-Correction Engine)
   ========================================================= */
export const SentinelFixer = {
  // Registry of automated fixes
  fixes: {
    'INF_LOOP': (code, issue) => {
      return SentinelFixer.replaceLine(code, issue.line, "  if (/* check */) break; // Auto-added safety");
    },
    'ZOMBIE_CODE': (code, issue) => {
      return SentinelFixer.replaceLine(code, issue.line, `// ${SentinelFixer.getLine(code, issue.line)} // Unused`);
    },
    'LOGIC_FLIP': (code, issue) => {
      const lineText = SentinelFixer.getLine(code, issue.line);
      const fixed = lineText.replace(/!!(\w+)/g, 'Boolean($1)');
      return SentinelFixer.replaceLine(code, issue.line, fixed);
    },
    'SEC_LEAK': (code, issue) => {
       const lineText = SentinelFixer.getLine(code, issue.line);
       const fixed = lineText.replace(/'[^']+'|"[^"]+"/, "process.env.REPLACE_ME");
       return SentinelFixer.replaceLine(code, issue.line, fixed);
    },
    'LAYOUT_THRASH': (code, issue) => {
      const line = SentinelFixer.getLine(code, issue.line);
      const varName = line.match(/(\w+)\s*=/)?.[1] || 'rect';
      return SentinelFixer.replaceLine(code, issue.line, `// Move this read outside the loop:\n  // const ${varName} = element.getBoundingClientRect();\n  ${line}`);
    },
    'FLOATING_PROMISE': (code, issue) => {
      const line = SentinelFixer.getLine(code, issue.line);
      return SentinelFixer.replaceLine(code, issue.line, `${line.replace(';', '')}.catch(err => console.error(err));`);
    },
    'OFFLINE_FAIL': (code, issue) => {
      const line = SentinelFixer.getLine(code, issue.line);
      const indent = line.match(/^\s*/)[0];
      const wrapped = `${indent}try {\n  ${line}\n${indent}} catch (err) {\n${indent}  console.error("Offline:", err);\n${indent}}`;
      return SentinelFixer.replaceLine(code, issue.line, wrapped);
    }
  },

  applyFix(code, issue) {
    const fixer = this.fixes[issue.id];
    if (fixer) {
      return fixer(code, issue);
    }
    return code;
  },

  getLine(code, lineNo) {
    return code.split('\n')[lineNo - 1];
  },

  replaceLine(code, lineNo, newLineText) {
    const lines = code.split('\n');
    lines[lineNo - 1] = newLineText;
    return lines.join('\n');
  }
};

/* =========================================================
   3. DEVOS SENTINEL (The Core AST Analyzer)
   ========================================================= */
export class DevOSSentinel {
  constructor() {
    this.registry = [];
    this.declarations = new Map();
    this.references = new Set();
    this.magicNumbers = new Map();
    this.initDefaultCheckers();
  }

  initDefaultCheckers() {
    // 1. LOGIC & CRITICAL FLOW
    this.use((node) => {
      if (['WhileStatement', 'ForStatement'].includes(node.type)) {
        if (node.test?.value === true && !this.findInNode(node.body, 'BreakStatement')) {
          return { id: 'INF_LOOP', message: "Infinite Loop: No break found.", severity: 'CRITICAL', fix: true };
        }
      }
    });

    this.use((node, parent, context) => {
      if (node.type === 'FunctionDeclaration' && node.id) context.currentFunctionName = node.id.name;
      if (node.type === 'CallExpression' && node.callee.name === context.currentFunctionName) {
        let isGuarded = false;
        let tracer = node.parent;
        while (tracer && tracer.type !== 'FunctionDeclaration') {
          if (['IfStatement', 'SwitchStatement', 'ConditionalExpression'].includes(tracer.type)) { isGuarded = true; break; }
          tracer = tracer.parent;
        }
        if (!isGuarded) return { id: 'STACK_OVERFLOW', message: `Recursion Risk: '${node.callee.name}' calls itself without an exit guard.`, severity: 'CRITICAL' };
      }
    });

    this.use((node) => {
      if (node.type === 'IfStatement' && node.test.type === 'Literal' && node.test.value === false) {
        return { id: 'DEAD_CODE', message: "Dead Branch: This block will never execute.", severity: 'LOW' };
      }
    });

    // 2. SECURITY & DATA INTEGRITY
    this.use((node) => {
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
        const name = node.id.name.toLowerCase();
        const val = node.init?.value;
        if ((name.includes('key') || name.includes('secret')) && typeof val === 'string' && val.length > 10) {
          return { id: 'SEC_LEAK', message: `Secret Leak: Hardcoded '${node.id.name}'. Move to .env.`, severity: 'HIGH', fix: true };
        }
      }
    });

    this.use((node) => {
      if (node.type === 'AssignmentExpression' && node.right.type === 'MemberExpression') {
        const sink = node.left.property?.name || node.left.name;
        if (['innerHTML', 'outerHTML', 'insertAdjacentHTML'].includes(sink)) {
          return { id: 'TAINT_FLOW', message: `XSS Risk: Flow into '${sink}'. Use textContent or sanitize.`, severity: 'CRITICAL' };
        }
      }
    });

    this.use((node) => {
      if (node.type === 'Literal' && typeof node.value === 'string') {
        if (/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/.test(node.value)) {
          return { id: 'PII_LEAK', message: "Privacy Risk: Potential PII detected in string.", severity: 'HIGH' };
        }
      }
    });

    this.use((node) => {
      const risky = ['eval', 'setTimeout', 'setInterval', 'Function'];
      if (node.type === 'CallExpression' && risky.includes(node.callee.name)) {
        if (node.arguments[0]?.type === 'Literal' && typeof node.arguments[0].value === 'string') {
          return { id: 'EVAL_CODE', message: `Security Risk: '${node.callee.name}' using a string argument.`, severity: 'CRITICAL' };
        }
      }
    });

    // 3. PERFORMANCE & PWA
    this.use((node, parent, context) => {
      if ((node.type === 'FunctionDeclaration' || node.type === 'ArrowFunctionExpression') && node.async) context.inAsync = true;
      if (context?.inAsync && ['WhileStatement', 'ForStatement'].includes(node.type)) {
        if (!this.findInNode(node.body, 'AwaitExpression')) {
          return { id: 'ASYNC_FREEZE', message: "UI Thread Alert: Async loop missing 'await'. Tab will freeze.", severity: 'CRITICAL' };
        }
      }
    });

    this.use((node) => {
      const triggers = ['offsetWidth', 'offsetHeight', 'getBoundingClientRect', 'getComputedStyle'];
      const prop = node.property?.name || node.callee?.property?.name;
      if (triggers.includes(prop)) {
        let tracer = node.parent;
        while (tracer) {
          if (['ForStatement', 'WhileStatement'].includes(tracer.type)) return { id: 'LAYOUT_THRASH', message: "Performance: Layout read inside loop causing thrashing.", severity: 'HIGH', fix: true };
          tracer = tracer.parent;
        }
      }
    });

    this.use((node) => {
      if (['ForStatement', 'WhileStatement', 'ForOfStatement'].includes(node.type)) {
        if (this.findInNode(node.body, 'CallExpression', (n) => n.callee.name === 'fetch' || n.callee.property?.name === 'query')) {
          return { id: 'N_PLUS_ONE', message: "Performance: Network/DB call inside loop (N+1 Risk).", severity: 'HIGH' };
        }
      }
    });

    this.use((node) => {
      if (node.type === 'CallExpression' && node.callee.name === 'fetch') {
        let tracer = node.parent;
        let inTry = false;
        while (tracer) { if (tracer.type === 'TryStatement') { inTry = true; break; } tracer = tracer.parent; }
        if (!inTry) return { id: 'OFFLINE_FAIL', message: "PWA Reliability: 'fetch' outside try/catch will crash offline.", severity: 'CRITICAL', fix: true };
      }
    });

    this.use((node) => {
      if (node.type === 'CallExpression' && node.callee.name === 'setInterval') {
        const delay = node.arguments[1]?.value;
        if (delay && delay < 100) return { id: 'BATTERY_DRAIN', message: "Efficiency: High-frequency interval drains battery.", severity: 'MEDIUM' };
      }
    });

    // 4. ARCHITECTURE & CLEAN CODE
    this.use((node) => {
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') this.declarations.set(node.id.name, node);
      if (node.type === 'FunctionDeclaration' && node.id) this.declarations.set(node.id.name, node);
    });

    this.use((node, parent) => {
      if (node.type === 'Identifier') {
        const isUsage = parent && !['VariableDeclarator', 'FunctionDeclaration'].includes(parent.type) &&
                        !(parent.type === 'MemberExpression' && parent.property === node);
        if (isUsage) this.references.add(node.name);
      }
    });

    this.use((node) => {
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
        let tracer = node.parent;
        while (tracer) {
          if (['FunctionDeclaration', 'Program'].includes(tracer.type)) {
            if (this.findDeclarationsInScope(tracer, node.id.name, node)) {
              return { id: 'SHADOW_VAR', message: `Ambiguity: '${node.id.name}' shadows an outer scope variable.`, severity: 'MEDIUM' };
            }
          }
          tracer = tracer.parent;
        }
      }
    });

    this.use((node) => {
      if (node.type === 'Literal' && typeof node.value === 'number' && ![0, 1, -1].includes(node.value)) {
        const count = (this.magicNumbers.get(node.value) || 0) + 1;
        this.magicNumbers.set(node.value, count);
        if (count > 2) return { id: 'MAGIC_NUMBER', message: `Magic Number: '${node.value}' used repeatedly. Define as a constant.`, severity: 'LOW' };
      }
    });

    this.use((node) => {
      if (node.type === 'UnaryExpression' && node.operator === '!' && node.argument.type === 'UnaryExpression' && node.argument.operator === '!') {
        return { id: 'LOGIC_FLIP', message: "Clarity: '!!' is less readable than Boolean() cast.", severity: 'LOW', fix: true };
      }
    });
  }

  use(checkerFunc) {
    this.registry.push(checkerFunc);
  }

  analyze(code) {
    this.declarations.clear();
    this.references.clear();
    this.magicNumbers.clear();
    const issues = [];
    let ast;

    try {
      ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'module', locations: true });
    } catch (e) {
      return [{ message: `Syntax Error: ${e.message}`, line: e.loc?.line, severity: 'FATAL' }];
    }

    const context = { inAsync: false, currentFunctionName: null };
    
    this.traverse(ast, (node, parent) => {
      this.registry.forEach(check => {
        const result = check(node, parent, context);
        if (result) issues.push({ ...result, line: node.loc?.start.line, column: node.loc?.start.column });
      });
    });

    for (const [name, node] of this.declarations) {
      if (!this.references.has(name)) {
        issues.push({ id: 'ZOMBIE_CODE', message: `Unused variable: '${name}'.`, severity: 'LOW', line: node.loc?.start.line, fix: true });
      }
    }

    return issues;
  }

  traverse(node, callback, parent = null) {
    if (!node) return;
    node.parent = parent; 
    callback(node, parent);
    for (const key in node) {
      const child = node[key];
      if (child && typeof child === 'object') {
        if (Array.isArray(child)) child.forEach(c => this.traverse(c, callback, node));
        else this.traverse(child, callback, node);
      }
    }
  }

  findInNode(node, type, filter = () => true) {
    let found = false;
    this.traverse(node, (n) => { if (n.type === type && filter(n)) found = true; });
    return found;
  }

  findDeclarationsInScope(scopeNode, name, originalNode) {
    let found = false;
    this.traverse(scopeNode, (child) => {
      if (child === originalNode) return;
      if (child.type === 'VariableDeclarator' && child.id.name === name) found = true;
      if (child.type === 'FunctionDeclaration' && child.id?.name === name) found = true;
    });
    return found;
  }
}

/* =========================================================
   4. PROJECT SENTINEL (Multi-File Aggregator)
   ========================================================= */
export const ProjectSentinel = {
    async scanProject(files, sentinelController) {
        const projectReport = {};
        
        const scanPromises = files.map(file => {
            return new Promise((resolve) => {
                sentinelController.check(file.content, (issues) => {
                    projectReport[file.path] = issues;
                    resolve();
                }, file.path); 
            });
        });

        await Promise.all(scanPromises);
        return projectReport;
    }
};
