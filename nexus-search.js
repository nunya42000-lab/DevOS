/**
 * nexus-search.js - Global Project Search
 * Restored from search.js; refactored for Terminal output.
 */

const NexusSearch = {
    query(term) {
        if (!term) return;
        let matchCount = 0;
        Nexus.updateTerminal(`Searching for: "${term}"...`, 'var(--accent)');

        Object.entries(VFS.files).forEach(([filename, content]) => {
            const lines = content.split('\n');
            lines.forEach((line, i) => {
                if (line.toLowerCase().includes(term.toLowerCase())) {
                    matchCount++;
                    // Create a clickable result in the terminal
                    Nexus.updateTerminal(`[${filename}:${i+1}] ${line.trim().substring(0, 30)}...`, 'var(--text)');
                }
            });
        });

        if (matchCount === 0) Nexus.updateTerminal("No matches found.", 'var(--warn)');
        else Nexus.updateTerminal(`Found ${matchCount} matches.`, 'var(--success)');
    }
};

// Integration: Terminal now responds to "find [term]"
Nexus.terminal.process = (input) => {
    if (input.startsWith('find ')) {
        NexusSearch.query(input.replace('find ', ''));
    } else {
        // ... previous command logic
    }
};
