/**
 * nexus-math.js - Complex Equation Generator
 */

const NexusMath = {
    generateLogic(expression) {
        try {
            // Use mathjs to parse the expression
            const node = math.parse(expression);
            const variables = [];
            
            // Find all variables used in the equation (e.g., x, y, speed)
            node.traverse((node) => {
                if (node.isSymbolNode && !math[node.name]) {
                    variables.push(node.name);
                }
            });

            const uniqueVars = [...new Set(variables)];
            const args = uniqueVars.length > 0 ? uniqueVars.join(', ') : 'val';
            
            // Generate the optimized JS function string
            const funcSnippet = `
/**
 * Generated Logic for: ${expression}
 */
const calculateResult = (${args}) => {
    return ${node.toTex().replace(/\\frac{([^}]*)}{([^}]*)}/g, '($1/$2)') // Basic TeX to JS cleanup
                 .replace(/\\cdot/g, '*')
                 .replace(/\^/g, '**')}; 
};`;

            Nexus.updateTerminal(`Math Logic Generated for variables: [${args}]`, 'var(--success)');
            Editor.insertText(funcSnippet);
        } catch (err) {
            Nexus.updateTerminal("Math Parser Error: " + err.message, 'var(--warn)');
        }
    }
};
