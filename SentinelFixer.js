/**
 * DevOS Sentinel Fixer
 * -------------------
 */
export const SentinelFixer = {
  fixes: {
    'INF_LOOP': (code, issue) => this.replaceLine(code, issue.line, "  if (/* check */) break; // Safety"),
    'ZOMBIE_CODE': (code, issue) => this.replaceLine(code, issue.line, "// " + this.getLine(code, issue.line) + " // Unused"),
    'LOGIC_FLIP': (code, issue) => this.replaceLine(code, issue.line, this.getLine(code, issue.line).replace(/!!(\w+)/g, 'Boolean($1)')),
    'OFFLINE_FAIL': (code, issue) => {
      const line = this.getLine(code, issue.line);
      const indent = line.match(/^\s*/)[0];
      return this.replaceLine(code, issue.line, `${indent}try {\n  ${line}\n${indent}} catch (err) { console.error(err); }`);
    }
  },
  applyFix(code, issue) { return this.fixes[issue.id] ? this.fixes[issue.id](code, issue) : code; },
  getLine(code, lineNo) { return code.split('\n')[lineNo - 1]; },
  replaceLine(code, lineNo, text) { const lines = code.split('\n'); lines[lineNo-1] = text; return lines.join('\n'); }
};