/**
 * NexusRefactor.js
 * -------------------------------
 * Performs project-wide renames and codebase mutations.
 */

export const NexusRefactor = {
    async rename(oldName, newName, contextEngine) {
        const definition = contextEngine.getDefinition(oldName);
        if (!definition) return console.warn(`[Refactor] Cannot find definition for ${oldName}`);

        const usages = contextEngine.getImpactRadius(oldName);
        const affectedFiles = new Set([definition.path, ...usages.map(u => u.path)]);
        
        console.log(`[Refactor] Renaming '${oldName}' to '${newName}' in ${affectedFiles.size} files.`);

        for (const path of affectedFiles) {
            const content = await window.NexusFS.readFile(path);
            
            // Note: AST-based replacement is safer, but regex word-boundary is kept here for performance
            const regex = new RegExp(`\\b${oldName}\\b`, 'g');
            const updatedContent = content.replace(regex, newName);
            
            await window.NexusFS.writeFile(path, updatedContent);
            
            if (window.currentFilePath === path && window.myEditor) {
                window.myEditor.dispatch({
                    changes: { from: 0, to: content.length, insert: updatedContent }
                });
            }
        }
        console.log(`[Refactor] Rename complete. Knowledge graph requires re-indexing.`);
    }
};

export const nexusJumpToDefinition = (identifier, contextEngine, editor) => {
    const target = contextEngine.getDefinition(identifier);
    if (target) {
        window.NexusFS.openFile(target.path);
        editor.dispatch({
            selection: { anchor: editor.state.doc.line(target.line).from },
            scrollIntoView: true
        });
        console.log(`[Nexus] Jumped to ${identifier} in ${target.path}`);
    } else {
        console.warn(`[Nexus] Could not find definition for ${identifier}`);
    }
};
