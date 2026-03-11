/**
 * nexus-importer.js - Conversation Parser & System Updater
 */

const NexusImporter = {
    async parseFromClipboard() {
        try {
            const text = await navigator.clipboard.readText();
            this.process(text);
        } catch (err) {
            Nexus.updateTerminal("Clipboard access denied. Paste into terminal manually.", 'var(--warn)');
        }
    },

    async process(text) {
        // Look for the "### filename" pattern followed by code blocks
        const filePattern = /### ([\w.-]+)\n```\w*\n([\s\S]*?)```/g;
        let match;
        let count = 0;

        while ((match = filePattern.exec(text)) !== null) {
            const fileName = match[1];
            const fileContent = match[2].trim();
            
            VFS.files[fileName] = fileContent;
            count++;
        }

        if (count > 0) {
            await localforage.setItem('nexus_vfs', VFS.files);
            VFS.renderExplorer();
            Nexus.updateTerminal(`Reconstruction Complete: ${count} files updated.`, 'var(--success)');
            Nexus.haptic('success');
        } else {
            Nexus.updateTerminal("No valid file blocks detected in text.", 'var(--warn)');
        }
    }
};

// Add to terminal commands in nexus-core.js
// if (input === 'import') NexusImporter.parseFromClipboard();
