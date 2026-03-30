/**
 * NexusNeural.js
 * ----------------------------
 * Analyzes the logical impact of code changes to calculate a Logic Delta.
 */

export const NexusNeural = {
    analyzeDelta(oldIssues, newIssues, oldContext, newContext) {
        const delta = {
            performance: 0, // Negative is bad, positive is improvement
            security: 0,
            complexity: 0,
            summary: []
        };

        // 1. Check Security Delta
        const oldSec = oldIssues.filter(i => i.id === 'SEC_LEAK' || i.id === 'TAINT_FLOW').length;
        const newSec = newIssues.filter(i => i.id === 'SEC_LEAK' || i.id === 'TAINT_FLOW').length;
        if (newSec > oldSec) {
            delta.security = -1;
            delta.summary.push("⚠️ Security decreased: New potential data leak or XSS sink detected.");
        }

        // 2. Check Performance Delta (Loops & Layout)
        const oldPerf = oldIssues.filter(i => i.id === 'LAYOUT_THRASH' || i.id === 'N_PLUS_ONE').length;
        const newPerf = newIssues.filter(i => i.id === 'LAYOUT_THRASH' || i.id === 'N_PLUS_ONE').length;
        if (newPerf > oldPerf) {
            delta.performance = -1;
            delta.summary.push("📉 Performance hit: You added logic that may cause UI thrashing or N+1 issues.");
        }

        // 3. Complexity Shift (Impact Radius)
        const oldRadius = Array.from(oldContext.graph.values()).flat().length;
        const newRadius = Array.from(newContext.graph.values()).flat().length;
        if (newRadius > oldRadius) {
            delta.complexity = -1;
            delta.summary.push(`🧠 Complexity increased: This file now has ${newRadius - oldRadius} more logical dependencies.`);
        }

        if (delta.summary.length === 0) delta.summary.push("✅ Logic is stable or improved.");
        
        return delta;
    }
};

// Expose globally for the wires.js UI hooks
window.NexusNeural = NexusNeural;
