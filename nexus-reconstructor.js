/**
 * nexus-reconstructor.js - Integrated Conversation Parser
 * Automatically extracts code blocks from chat text and updates the VFS.
 */

const NexusReconstructor = {
    /**
     * The Master Parser
     * Scans for the "### filename" followed by triple-backtick code blocks.
     */
    async digest(text) {
        // Regex to find "### filename" then "```javascript ... ```"
        const blockPattern = /### ([\w.-]+)\n```\w*\n([\s\S]*?)```/g;
        let match;
        let updatedFiles = [];

        Nexus.updateTerminal("Starting reconstruction process...", 'var(--accent)');

        while ((match = blockPattern.exec(text)) !== null) {
            const fileName = match[1];
            const fileContent = match[2].trim();
            
            // Update the in-memory Virtual File System
            VFS.files[fileName] = fileContent;
            updatedFiles.push(fileName);
        }

        if (updatedFiles.length > 0) {
            // Save to LocalForage immediately
            await localforage.setItem('nexus_vfs', VFS.files);
            
            // Refresh the UI
            VFS.renderExplorer();
            Nexus.updateTerminal(`Successfully reconstructed ${updatedFiles.length} files:`, 'var(--success)');
            updatedFiles.forEach(f => Nexus.updateTerminal(` -> ${f}`, 'var(--text)'));
            
            Nexus.haptic('success');
        } else {
            Nexus.updateTerminal("Reconstruction failed: No valid file blocks found.", 'var(--warn)');
            Nexus.updateTerminal("Ensure the text includes '### filename' headers.", 'var(--muted)');
        }
    },

    /**
     * UI Trigger: Opens a dedicated paste-bin for reconstruction
     */
    openPortal() {
        const text = prompt("Paste the chat history or file blocks here to rebuild:");
        if (text) {
            this.digest(text);
        }
    }
};
