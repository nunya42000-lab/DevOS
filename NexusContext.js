/**
 * DevOS Nexus: Semantic Context Engine
 */
export class NexusContext {
  constructor() { this.graph = new Map(); this.definitions = new Map(); }
  indexFile(path, ast) {
    this.traverse(ast, (node) => {
      if (node.type === 'FunctionDeclaration' && node.id) this.definitions.set(node.id.name, { path, line: node.loc.start.line });
    });
  }
  getDefinition(name) { return this.definitions.get(name); }
  traverse(node, cb) {
    if (!node) return; cb(node);
    for (let k in node) {
      if (node[k] && typeof node[k] === 'object') {
        if (Array.isArray(node[k])) node[k].forEach(c => this.traverse(c, cb));
        else this.traverse(node[k], cb);
      }
    }
  }
}