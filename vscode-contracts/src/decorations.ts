/**
 * Contract Decoration Provider
 *
 * Provides inline decorations for contract functions showing
 * selector, gas estimates, and other metadata.
 */

import * as vscode from 'vscode';

/**
 * Decoration types
 */
const selectorDecorationType = vscode.window.createTextEditorDecorationType({
    after: {
        margin: '0 0 0 1em',
        color: new vscode.ThemeColor('editorCodeLens.foreground')
    }
});

const gasDecorationType = vscode.window.createTextEditorDecorationType({
    after: {
        margin: '0 0 0 0.5em',
        color: new vscode.ThemeColor('editorCodeLens.foreground')
    }
});

/**
 * Contract Decoration Provider
 */
export class ContractDecorationProvider {
    private enabled: boolean = true;

    /**
     * Enable or disable decorations
     */
    setEnabled(enabled: boolean) {
        this.enabled = enabled;
    }

    /**
     * Update decorations for an editor
     */
    updateDecorations(editor: vscode.TextEditor) {
        if (!this.enabled) {
            editor.setDecorations(selectorDecorationType, []);
            return;
        }

        const document = editor.document;
        const languageId = document.languageId;

        if (languageId === 'rust') {
            this.decorateRust(editor);
        } else if (languageId === 'typescript') {
            this.decorateTypeScript(editor);
        }
    }

    /**
     * Add decorations for Rust contracts
     */
    private decorateRust(editor: vscode.TextEditor) {
        const text = editor.document.getText();
        const decorations: vscode.DecorationOptions[] = [];

        // Find #[call], #[view], #[init] attributes
        const attributeRegex = /#\[(call|view|init)(?:\([^)]*\))?\]\s*(?:pub\s+)?fn\s+(\w+)/g;
        let match;

        while ((match = attributeRegex.exec(text)) !== null) {
            const startPos = editor.document.positionAt(match.index);
            const endPos = editor.document.positionAt(match.index + match[0].length);

            const attrType = match[1];
            const functionName = match[2];
            const selector = this.calculateSelector(functionName);

            let decoration: vscode.DecorationOptions = {
                range: new vscode.Range(startPos, endPos),
                renderOptions: {
                    after: {
                        contentText: ` // selector: 0x${selector.toString(16).padStart(8, '0')}`,
                        color: new vscode.ThemeColor('editorCodeLens.foreground')
                    }
                }
            };

            decorations.push(decoration);
        }

        // Find #[event] structs
        const eventRegex = /#\[event\]\s*(?:pub\s+)?struct\s+(\w+)/g;

        while ((match = eventRegex.exec(text)) !== null) {
            const startPos = editor.document.positionAt(match.index);
            const endPos = editor.document.positionAt(match.index + match[0].length);

            const eventName = match[1];
            const signature = this.calculateSelector(eventName);

            let decoration: vscode.DecorationOptions = {
                range: new vscode.Range(startPos, endPos),
                renderOptions: {
                    after: {
                        contentText: ` // signature: 0x${signature.toString(16).padStart(8, '0')}`,
                        color: new vscode.ThemeColor('editorCodeLens.foreground')
                    }
                }
            };

            decorations.push(decoration);
        }

        editor.setDecorations(selectorDecorationType, decorations);
    }

    /**
     * Add decorations for TypeScript/AssemblyScript contracts
     */
    private decorateTypeScript(editor: vscode.TextEditor) {
        const text = editor.document.getText();
        const decorations: vscode.DecorationOptions[] = [];

        // Find exported functions
        const exportRegex = /export\s+function\s+(\w+)\s*\(/g;
        let match;

        while ((match = exportRegex.exec(text)) !== null) {
            const startPos = editor.document.positionAt(match.index);
            const endPos = editor.document.positionAt(match.index + match[0].length - 1);

            const functionName = match[1];

            // Skip common non-contract functions
            if (['__alloc', '__new', '__pin', '__unpin'].includes(functionName)) {
                continue;
            }

            const selector = this.calculateSelector(functionName);

            let decoration: vscode.DecorationOptions = {
                range: new vscode.Range(startPos, endPos),
                renderOptions: {
                    after: {
                        contentText: ` // selector: 0x${selector.toString(16).padStart(8, '0')}`,
                        color: new vscode.ThemeColor('editorCodeLens.foreground')
                    }
                }
            };

            decorations.push(decoration);
        }

        editor.setDecorations(selectorDecorationType, decorations);
    }

    /**
     * Calculate function selector (FNV-1a hash)
     */
    private calculateSelector(name: string): number {
        let hash = 0x811c9dc5; // FNV offset basis
        for (let i = 0; i < name.length; i++) {
            hash ^= name.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193); // FNV prime
        }
        return hash >>> 0; // Convert to unsigned 32-bit
    }
}

/**
 * Create hover provider for contract attributes
 */
export function createHoverProvider(): vscode.HoverProvider {
    return {
        provideHover(document, position, token) {
            const range = document.getWordRangeAtPosition(position);
            if (!range) return null;

            const word = document.getText(range);
            const line = document.lineAt(position.line).text;

            // Check for Rust attributes
            if (document.languageId === 'rust') {
                if (line.includes('#[contract]')) {
                    return new vscode.Hover([
                        '**Infrix Contract**',
                        'Marks this struct as an Infrix smart contract.',
                        'Generates storage layout and entry points.'
                    ].join('\n\n'));
                }

                if (line.includes('#[init]')) {
                    return new vscode.Hover([
                        '**Initialization Function**',
                        'Called once when the contract is deployed.',
                        'Must return `Self` or `Result<Self, Error>`.'
                    ].join('\n\n'));
                }

                if (line.includes('#[call]')) {
                    return new vscode.Hover([
                        '**Callable Function**',
                        'State-modifying function that can be called via transactions.',
                        'Must take `&mut self` as the first parameter.',
                        '',
                        '**Attributes:**',
                        '- `payable` - Function can receive tokens',
                        '- `only_owner` - Only contract owner can call'
                    ].join('\n\n'));
                }

                if (line.includes('#[view]')) {
                    return new vscode.Hover([
                        '**View Function**',
                        'Read-only function that queries state without modification.',
                        'Must take `&self` (not `&mut self`) as the first parameter.',
                        'Can be called for free via queries.'
                    ].join('\n\n'));
                }

                if (line.includes('#[event]')) {
                    return new vscode.Hover([
                        '**Contract Event**',
                        'Emitted when certain actions occur.',
                        'Events are indexed and can be queried via the API.',
                        '',
                        '**Attributes:**',
                        '- `#[indexed]` on fields - Mark as indexed for efficient filtering'
                    ].join('\n\n'));
                }
            }

            return null;
        }
    };
}
