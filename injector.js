class CodeInjector {
    /**
     * @param {string} currentContent - The full text of your current file.
     * @param {string} patchContent - The new code block to inject.
     * @param {string} anchorLabel - The label used in the comments (e.g., "EDITOR_CSS").
     */
    static inject(currentContent, patchContent, anchorLabel) {
        const startMarker = `// START: ${anchorLabel}`;
        const endMarker = `// END: ${anchorLabel}`;

        const startIndex = currentContent.indexOf(startMarker);
        const endIndex = currentContent.indexOf(endMarker);

        if (startIndex === -1 || endIndex === -1) {
            console.error(`Markers for "${anchorLabel}" not found.`);
            return { error: "Markers not found", content: currentContent };
        }

        // Extract what is currently between the markers
        const contentBefore = currentContent.substring(0, startIndex + startMarker.length);
        const existingLogic = currentContent.substring(startIndex + startMarker.length, endIndex).trim();
        const contentAfter = currentContent.substring(endIndex);

        // Conflict Detection: If existing logic isn't empty and isn't identical to new logic
        if (existingLogic.length > 0 && existingLogic !== patchContent.trim()) {
            return {
                status: "CONFLICT",
                current: existingLogic,
                incoming: patchContent,
                apply: (choice) => {
                    const finalContent = choice === 'incoming' ? patchContent : existingLogic;
                    return `${contentBefore}\n${finalContent}\n${contentAfter}`;
                }
            };
        }

        // Auto-merge if no conflict
        const merged = `${contentBefore}\n${patchContent}\n${contentAfter}`;
        return { status: "SUCCESS", content: merged };
    }
}
