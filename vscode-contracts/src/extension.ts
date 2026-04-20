/**
 * Infrix VS Code Extension
 *
 * Provides development tools for Infrix governed contracts including:
 * - Contract project initialization
 * - Build + governance-first deploy commands (deployment is submitted
 *   as a CONTRACT_DEPLOY intent through governed.submit; the same is
 *   true for CONTRACT_CALL and CONTRACT_UPGRADE)
 * - Read-only contract inspection (query, inspect, schema)
 * - Event history (events.history)
 * - IntelliSense and code snippets
 *
 * State-changing operations never bypass the canonical spine:
 *   Intent -> Plan -> Approval -> Execution -> Outcome -> Evidence -> Anchor
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ContractExplorer } from './contractExplorer';
import { InfrixClient } from './client';
import { ContractDecorationProvider } from './decorations';

// Extension state
let client: InfrixClient;
let contractExplorer: ContractExplorer;
let decorationProvider: ContractDecorationProvider;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;

/**
 * Extension activation
 */
export function activate(context: vscode.ExtensionContext) {
    console.log('Infrix extension activating...');

    // Create output channel
    outputChannel = vscode.window.createOutputChannel('Infrix');
    context.subscriptions.push(outputChannel);

    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'infrix.setNetwork';
    updateStatusBar();
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Initialize client
    client = new InfrixClient(getConfig());

    // Initialize contract explorer
    contractExplorer = new ContractExplorer(context);
    vscode.window.registerTreeDataProvider('infrixContracts', contractExplorer);

    // Initialize decoration provider
    decorationProvider = new ContractDecorationProvider();
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) {
                decorationProvider.updateDecorations(editor);
            }
        })
    );

    // Register commands
    registerCommands(context);

    // Watch for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('infrix')) {
                client.updateConfig(getConfig());
                updateStatusBar();
            }
        })
    );

    // Check for Infrix project
    checkForInfrixProject();

    outputChannel.appendLine('Infrix extension activated');
}

/**
 * Extension deactivation
 */
export function deactivate() {
    outputChannel.appendLine('Infrix extension deactivating...');
}

/**
 * Register all commands
 */
function registerCommands(context: vscode.ExtensionContext) {
    // Initialize project
    context.subscriptions.push(
        vscode.commands.registerCommand('infrix.contract.init', async () => {
            const templates = ['rust', 'assemblyscript', 'counter', 'token', 'nft'];
            const template = await vscode.window.showQuickPick(templates, {
                placeHolder: 'Select contract template'
            });

            if (!template) return;

            const name = await vscode.window.showInputBox({
                prompt: 'Enter project name',
                placeHolder: 'my-contract'
            });

            if (!name) return;

            const folder = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                openLabel: 'Select Folder'
            });

            if (!folder || folder.length === 0) return;

            await initProject(folder[0].fsPath, name, template);
        })
    );

    // Build contract
    context.subscriptions.push(
        vscode.commands.registerCommand('infrix.contract.build', async () => {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('No workspace folder open');
                return;
            }

            await buildContract(workspaceFolder.uri.fsPath);
        })
    );

    // Deploy contract
    context.subscriptions.push(
        vscode.commands.registerCommand('infrix.intent.contractDeploy', async (uri?: vscode.Uri) => {
            let wasmPath: string;

            if (uri) {
                wasmPath = uri.fsPath;
            } else {
                const files = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: false,
                    filters: { 'WASM Files': ['wasm'] }
                });

                if (!files || files.length === 0) return;
                wasmPath = files[0].fsPath;
            }

            const contractUrl = await vscode.window.showInputBox({
                prompt: 'Enter contract URL',
                placeHolder: 'acc://myadi.acme/mycontract'
            });

            if (!contractUrl) return;

            await deployContract(wasmPath, contractUrl);
        })
    );

    // Call contract function
    context.subscriptions.push(
        vscode.commands.registerCommand('infrix.intent.contractCall', async () => {
            const contractUrl = await vscode.window.showInputBox({
                prompt: 'Enter contract URL',
                placeHolder: 'acc://myadi.acme/mycontract'
            });

            if (!contractUrl) return;

            const functionName = await vscode.window.showInputBox({
                prompt: 'Enter function name',
                placeHolder: 'transfer'
            });

            if (!functionName) return;

            const args = await vscode.window.showInputBox({
                prompt: 'Enter arguments (JSON array)',
                placeHolder: '["acc://bob.acme", "1000"]'
            });

            await callContract(contractUrl, functionName, args || '[]');
        })
    );

    // Query contract
    context.subscriptions.push(
        vscode.commands.registerCommand('infrix.contract.query', async () => {
            const contractUrl = await vscode.window.showInputBox({
                prompt: 'Enter contract URL',
                placeHolder: 'acc://myadi.acme/mycontract'
            });

            if (!contractUrl) return;

            const functionName = await vscode.window.showInputBox({
                prompt: 'Enter function name',
                placeHolder: 'balanceOf'
            });

            if (!functionName) return;

            const args = await vscode.window.showInputBox({
                prompt: 'Enter arguments (JSON array)',
                placeHolder: '["acc://alice.acme"]'
            });

            await queryContract(contractUrl, functionName, args || '[]');
        })
    );

    // Generate ABI
    context.subscriptions.push(
        vscode.commands.registerCommand('infrix.contract.generateABI', async () => {
            const files = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: { 'WASM Files': ['wasm'] }
            });

            if (!files || files.length === 0) return;

            await generateABI(files[0].fsPath);
        })
    );

    // View events
    context.subscriptions.push(
        vscode.commands.registerCommand('infrix.contract.events', async () => {
            const contractUrl = await vscode.window.showInputBox({
                prompt: 'Enter contract URL',
                placeHolder: 'acc://myadi.acme/mycontract'
            });

            if (!contractUrl) return;

            const eventName = await vscode.window.showInputBox({
                prompt: 'Enter event name (optional)',
                placeHolder: 'Transfer'
            });

            await viewEvents(contractUrl, eventName || undefined);
        })
    );

    // Set network
    context.subscriptions.push(
        vscode.commands.registerCommand('infrix.setNetwork', async () => {
            const networks = ['mainnet', 'testnet', 'devnet', 'local'];
            const network = await vscode.window.showQuickPick(networks, {
                placeHolder: 'Select network'
            });

            if (network) {
                const config = vscode.workspace.getConfiguration('infrix');
                await config.update('network', network, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`Network set to ${network}`);
            }
        })
    );
}

/**
 * Get extension configuration
 */
function getConfig() {
    const config = vscode.workspace.getConfiguration('infrix');
    return {
        network: config.get<string>('network', 'testnet'),
        rpcUrl: config.get<string>('rpcUrl', ''),
        defaultKeyFile: config.get<string>('defaultKeyFile', ''),
        autoGenerateABI: config.get<boolean>('autoGenerateABI', true),
        showDecorations: config.get<boolean>('showDecorations', true)
    };
}

/**
 * Update status bar
 */
function updateStatusBar() {
    const config = getConfig();
    statusBarItem.text = `$(cloud) Infrix: ${config.network}`;
    statusBarItem.tooltip = `Click to change network\nRPC: ${getRpcUrl(config.network)}`;
}

/**
 * Get RPC URL for network
 */
function getRpcUrl(network: string): string {
    const config = getConfig();
    if (config.rpcUrl) return config.rpcUrl;

    // Gap 15 sixteenth-pass closure (commit 4/6) — Infrix JSON-RPC
    // dispatcher endpoints, not Accumulate L0 (:26660/v3). Mirrors
    // tools/vscode-extension/src/client.ts::getRpcUrl.
    switch (network) {
        case 'mainnet':
            return 'https://mainnet.infrix.io/rpc';
        case 'testnet':
            return 'https://testnet.infrix.io/rpc';
        case 'devnet':
            return 'https://devnet.infrix.io/rpc';
        case 'local':
            return 'http://localhost:8080/rpc';
        default:
            return 'http://localhost:8080/rpc';
    }
}

/**
 * Check for Infrix project in workspace
 */
function checkForInfrixProject() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;

    const hasCargoToml = fs.existsSync(path.join(workspaceFolder.uri.fsPath, 'Cargo.toml'));
    const hasAsConfig = fs.existsSync(path.join(workspaceFolder.uri.fsPath, 'asconfig.json'));

    vscode.commands.executeCommand('setContext', 'infrix.hasProject', hasCargoToml || hasAsConfig);
}

/**
 * Initialize new project
 */
async function initProject(folder: string, name: string, template: string) {
    outputChannel.show();
    outputChannel.appendLine(`Initializing ${template} project: ${name}`);

    try {
        const terminal = vscode.window.createTerminal('Infrix');
        terminal.show();
        terminal.sendText(`cd "${folder}" && infrix contract init ${name} --template ${template}`);

        vscode.window.showInformationMessage(`Created Infrix project: ${name}`);

        // Open the new project
        const projectPath = path.join(folder, name);
        if (fs.existsSync(projectPath)) {
            vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(projectPath));
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to initialize project: ${error}`);
    }
}

/**
 * Build contract
 */
async function buildContract(projectPath: string) {
    outputChannel.show();
    outputChannel.appendLine(`Building contract in: ${projectPath}`);

    const config = getConfig();

    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Building contract...',
        cancellable: false
    }, async () => {
        try {
            const terminal = vscode.window.createTerminal('Infrix Build');
            terminal.show();
            terminal.sendText(`cd "${projectPath}" && infrix contract build --release${config.autoGenerateABI ? ' --abi' : ''}`);

            outputChannel.appendLine('Build started');
        } catch (error) {
            vscode.window.showErrorMessage(`Build failed: ${error}`);
            outputChannel.appendLine(`Build error: ${error}`);
        }
    });
}

/**
 * Deploy contract
 */
async function deployContract(wasmPath: string, contractUrl: string) {
    outputChannel.show();
    outputChannel.appendLine(`Deploying contract: ${wasmPath} -> ${contractUrl}`);

    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Deploying contract...',
        cancellable: false
    }, async () => {
        try {
            const result = await client.deploy(wasmPath, contractUrl);
            vscode.window.showInformationMessage(`Contract deployed: ${result.txHash}`);
            outputChannel.appendLine(`Deployment successful: ${result.txHash}`);
            contractExplorer.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Deployment failed: ${error}`);
            outputChannel.appendLine(`Deployment error: ${error}`);
        }
    });
}

/**
 * Call contract function
 */
async function callContract(contractUrl: string, functionName: string, args: string) {
    outputChannel.show();
    outputChannel.appendLine(`Calling ${contractUrl}.${functionName}(${args})`);

    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Calling ${functionName}...`,
        cancellable: false
    }, async () => {
        try {
            const parsedArgs = JSON.parse(args);
            const result = await client.call(contractUrl, functionName, parsedArgs);

            vscode.window.showInformationMessage(`Call successful: ${result.txHash}`);
            outputChannel.appendLine(`Call result: ${JSON.stringify(result)}`);

            // Show result in output
            if (result.returnData) {
                outputChannel.appendLine(`Return data: ${result.returnData}`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Call failed: ${error}`);
            outputChannel.appendLine(`Call error: ${error}`);
        }
    });
}

/**
 * Query contract
 */
async function queryContract(contractUrl: string, functionName: string, args: string) {
    outputChannel.show();
    outputChannel.appendLine(`Querying ${contractUrl}.${functionName}(${args})`);

    try {
        const parsedArgs = JSON.parse(args);
        const result = await client.query(contractUrl, functionName, parsedArgs);

        outputChannel.appendLine(`Query result: ${JSON.stringify(result, null, 2)}`);

        // Show result in information message
        vscode.window.showInformationMessage(`Result: ${JSON.stringify(result.result)}`);
    } catch (error) {
        vscode.window.showErrorMessage(`Query failed: ${error}`);
        outputChannel.appendLine(`Query error: ${error}`);
    }
}

/**
 * Generate ABI from WASM
 */
async function generateABI(wasmPath: string) {
    outputChannel.show();
    outputChannel.appendLine(`Generating ABI from: ${wasmPath}`);

    try {
        const abiPath = wasmPath.replace('.wasm', '.abi.json');
        const terminal = vscode.window.createTerminal('Infrix');
        terminal.show();
        terminal.sendText(`infrix contract abi generate --wasm "${wasmPath}" --output "${abiPath}"`);

        vscode.window.showInformationMessage(`ABI generated: ${abiPath}`);
    } catch (error) {
        vscode.window.showErrorMessage(`ABI generation failed: ${error}`);
    }
}

/**
 * View contract events
 */
async function viewEvents(contractUrl: string, eventName?: string) {
    outputChannel.show();
    outputChannel.appendLine(`Fetching events from: ${contractUrl}`);

    try {
        const events = await client.getEvents(contractUrl, eventName);

        outputChannel.appendLine(`Found ${events.length} events:`);
        for (const event of events) {
            outputChannel.appendLine(JSON.stringify(event, null, 2));
        }

        if (events.length === 0) {
            vscode.window.showInformationMessage('No events found');
        } else {
            vscode.window.showInformationMessage(`Found ${events.length} events (see Output)`);
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to fetch events: ${error}`);
    }
}
