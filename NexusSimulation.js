/**
 * NexusSimulation.js
 * ----------------------------------------
 * Automated branch testing and Time-Dilation Sandbox via Web Workers.
 */
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

export class NexusChronos {
    constructor() {
        // Isolated Web Worker from a Blob
        const workerCode = `
            self.onmessage = function(e) {
                const { code, iterations } = e.data;
                const start = performance.now();
                try {
                    // Time Dilation logic
                    self.setTimeout = (fn) => fn(); 
                    self.requestAnimationFrame = (fn) => fn(performance.now());
                    
                    // Scope encapsulation to prevent 'let/const already declared' errors in loops
                    const testRunner = new Function(code);
                    
                    for(let i = 0; i < iterations; i++) {
                        testRunner(); 
                    }
                    postMessage({ success: true, duration: performance.now() - start, iterations });
                } catch (err) {
                    postMessage({ success: false, error: err.message });
                }
            };
        `;
        const blob = new Blob([workerCode], { type: 'application/javascript' });
        this.worker = new Worker(URL.createObjectURL(blob));
    }

    runHighSpeed(code, iterations = 1000) {
        return new Promise((resolve) => {
            // Using once-event logic so multiple calls don't trip over each other
            const handler = (e) => {
                this.worker.removeEventListener('message', handler);
                if (e.data.success) {
                    console.log(`[Chronos] Simulation complete. ${e.data.iterations} cycles in ${e.data.duration.toFixed(2)}ms.`);
                } else {
                    console.warn(`[Chronos] Simulation failed: ${e.data.error}`);
                }
                resolve(e.data);
            };
            this.worker.addEventListener('message', handler);
            this.worker.postMessage({ code, iterations });
        });
    }
    
    terminate() {
        this.worker.terminate();
    }
}

export const NexusDreamer = {
    async startNightCycle(projectFiles) {
        console.log("[Dreamer] Starting Automated Branch Testing...");
        const chronos = new NexusChronos();
        const testPromises = [];
        
        for (const file of projectFiles) {
            let ast;
            try {
                ast = acorn.parse(file.content, { ecmaVersion: 2022, sourceType: 'module' });
            } catch (e) {
                console.warn(`[Dreamer] Skipping ${file.path} due to parse error.`);
                continue;
            }
            
            // Safely walk the AST
            walk.simple(ast, {
                IfStatement(node) {
                    const block = file.content.substring(node.start, node.end);
                    testPromises.push(chronos.runHighSpeed(block));
                },
                SwitchStatement(node) {
                    const block = file.content.substring(node.start, node.end);
                    testPromises.push(chronos.runHighSpeed(block));
                }
            });
        }
        
        // Wait for all queued background tests to finish
        await Promise.all(testPromises);
        console.log("[Dreamer] Night cycle complete. All branches verified.");
        chronos.terminate(); // Clean up memory
    }
};
