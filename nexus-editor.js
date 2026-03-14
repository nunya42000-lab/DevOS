/**
 * nexus-editor.js - CodeMirror 6 Implementation
 * Built for mobile performance and external input sync.
 */

const Editor = {
    view: null,

    init() {
        // We initialize a minimal CM6 instance
        // In a real build, you'd use the CM6 bundled ESM, 
        // but here we hook into the wrapper.
        this.view = new CodeMirror.EditorView({
            parent: document.getElementById('editor-wrapper'),
            extensions: [
                CodeMirror.basicSetup,
                CodeMirror.javascript(), // Default to JS
                CodeMirror.EditorView.updateListener.of((v) => {
                    if (v.docChanged) {
                        // Autosave logic
                        VFS.files[VFS.activeFile] = v.state.doc.toString();
                    }
                })
            ]
        });
    },

    loadContent(content, filename) {
        const transaction = this.view.state.update({
            changes: {from: 0, to: this.view.state.doc.length, insert: content}
        });
        this.view.dispatch(transaction);
    },

    // This allows the Terminal or Sync to "type" into the editor
    insertText(text) {
        const range = this.view.state.selection.main;
        this.view.dispatch({
            changes: {from: range.from, to: range.to, insert: text},
            selection: {anchor: range.from + text.length}
        });
    }
};

Editor.init();
