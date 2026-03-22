/**
 * Contract Explorer Tree View
 *
 * Provides a tree view of contracts and their functions in the Explorer sidebar.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Tree item types
 */
type ContractTreeItemType = 'project' | 'contract' | 'function' | 'event' | 'storage';

/**
 * Contract tree item
 */
export class ContractTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly itemType: ContractTreeItemType,
        public readonly metadata?: any
    ) {
        super(label, collapsibleState);

        // Set icon based on type
        switch (itemType) {
            case 'project':
                this.iconPath = new vscode.ThemeIcon('folder');
                break;
            case 'contract':
                this.iconPath = new vscode.ThemeIcon('file-code');
                break;
            case 'function':
                this.iconPath = new vscode.ThemeIcon('symbol-method');
                this.contextValue = 'function';
                break;
            case 'event':
                this.iconPath = new vscode.ThemeIcon('symbol-event');
                break;
            case 'storage':
                this.iconPath = new vscode.ThemeIcon('database');
                break;
        }
    }
}

/**
 * Contract Explorer Provider
 */
export class ContractExplorer implements vscode.TreeDataProvider<ContractTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ContractTreeItem | undefined | null | void> =
        new vscode.EventEmitter<ContractTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ContractTreeItem | undefined | null | void> =
        this._onDidChangeTreeData.event;

    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    /**
     * Refresh the tree view
     */
    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    /**
     * Get tree item
     */
    getTreeItem(element: ContractTreeItem): vscode.TreeItem {
        return element;
    }

    /**
     * Get children of a tree item
     */
    async getChildren(element?: ContractTreeItem): Promise<ContractTreeItem[]> {
        if (!element) {
            // Root level - show projects
            return this.getProjects();
        }

        switch (element.itemType) {
            case 'project':
                return this.getProjectContracts(element.metadata.path);
            case 'contract':
                return this.getContractItems(element.metadata);
            default:
                return [];
        }
    }

    /**
     * Get projects in workspace
     */
    private async getProjects(): Promise<ContractTreeItem[]> {
        const items: ContractTreeItem[] = [];
        const workspaceFolders = vscode.workspace.workspaceFolders;

        if (!workspaceFolders) {
            return items;
        }

        for (const folder of workspaceFolders) {
            const projectType = await this.detectProjectType(folder.uri.fsPath);
            if (projectType) {
                items.push(new ContractTreeItem(
                    folder.name,
                    vscode.TreeItemCollapsibleState.Expanded,
                    'project',
                    { path: folder.uri.fsPath, type: projectType }
                ));
            }
        }

        return items;
    }

    /**
     * Get contracts in a project
     */
    private async getProjectContracts(projectPath: string): Promise<ContractTreeItem[]> {
        const items: ContractTreeItem[] = [];

        // Look for ABI files
        const abiFiles = this.findFiles(projectPath, '.abi.json');
        for (const abiFile of abiFiles) {
            try {
                const abiContent = fs.readFileSync(abiFile, 'utf8');
                const abi = JSON.parse(abiContent);

                items.push(new ContractTreeItem(
                    abi.name || path.basename(abiFile, '.abi.json'),
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'contract',
                    { path: abiFile, abi }
                ));
            } catch (error) {
                // Skip invalid ABI files
            }
        }

        // If no ABI files, show a placeholder
        if (items.length === 0) {
            const buildItem = new ContractTreeItem(
                'Build to generate ABI',
                vscode.TreeItemCollapsibleState.None,
                'contract'
            );
            buildItem.command = {
                command: 'infrix.build',
                title: 'Build Contract'
            };
            items.push(buildItem);
        }

        return items;
    }

    /**
     * Get items within a contract (functions, events)
     */
    private getContractItems(metadata: any): ContractTreeItem[] {
        const items: ContractTreeItem[] = [];
        const abi = metadata.abi;

        if (!abi) {
            return items;
        }

        // Functions
        if (abi.functions && abi.functions.length > 0) {
            for (const func of abi.functions) {
                const inputs = func.inputs?.map((i: any) => `${i.type} ${i.name}`).join(', ') || '';
                const outputs = func.outputs?.map((o: any) => o.type).join(', ') || 'void';
                const label = `${func.name}(${inputs}) → ${outputs}`;

                const item = new ContractTreeItem(
                    label,
                    vscode.TreeItemCollapsibleState.None,
                    'function',
                    { function: func, contractAbi: abi }
                );

                // Add badge for mutability
                if (func.mutability === 'view') {
                    item.description = 'view';
                } else if (func.payable) {
                    item.description = 'payable';
                }

                // Add command to call function
                item.command = {
                    command: func.mutability === 'view' ? 'infrix.query' : 'infrix.call',
                    title: func.mutability === 'view' ? 'Query' : 'Call',
                    arguments: [func.name]
                };

                items.push(item);
            }
        }

        // Events
        if (abi.events && abi.events.length > 0) {
            for (const event of abi.events) {
                const params = [
                    ...(event.topics || []).map((t: any) => `${t.type} indexed ${t.name}`),
                    ...(event.data || []).map((d: any) => `${d.type} ${d.name}`)
                ].join(', ');

                items.push(new ContractTreeItem(
                    `${event.name}(${params})`,
                    vscode.TreeItemCollapsibleState.None,
                    'event',
                    { event, contractAbi: abi }
                ));
            }
        }

        return items;
    }

    /**
     * Detect project type
     */
    private async detectProjectType(dir: string): Promise<string | null> {
        if (fs.existsSync(path.join(dir, 'Cargo.toml'))) {
            return 'rust';
        }
        if (fs.existsSync(path.join(dir, 'asconfig.json'))) {
            return 'assemblyscript';
        }
        return null;
    }

    /**
     * Find files with extension
     */
    private findFiles(dir: string, extension: string): string[] {
        const files: string[] = [];

        const search = (currentDir: string) => {
            try {
                const entries = fs.readdirSync(currentDir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(currentDir, entry.name);

                    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'target') {
                        search(fullPath);
                    } else if (entry.isFile() && entry.name.endsWith(extension)) {
                        files.push(fullPath);
                    }
                }
            } catch (error) {
                // Ignore permission errors
            }
        };

        search(dir);
        return files;
    }
}
