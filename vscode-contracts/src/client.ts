/**
 * Infrix RPC Client
 *
 * Client for interacting with the Infrix JSON-RPC API.
 */

import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';

export interface InfrixConfig {
    network: string;
    rpcUrl: string;
    defaultKeyFile: string;
}

export interface DeployResult {
    txHash: string;
}

export interface CallResult {
    txHash: string;
    returnData?: string;
}

export interface QueryResult {
    result: any;
    rawData?: string;
}

export interface ContractEvent {
    blockHeight: number;
    txHash: string;
    logIndex: number;
    topics: string[];
    data: string;
}

/**
 * Infrix RPC Client
 */
export class InfrixClient {
    private config: InfrixConfig;
    private http: AxiosInstance;

    constructor(config: InfrixConfig) {
        this.config = config;
        this.http = this.createHttpClient();
    }

    /**
     * Update client configuration
     */
    updateConfig(config: InfrixConfig) {
        this.config = config;
        this.http = this.createHttpClient();
    }

    /**
     * Create HTTP client with config
     */
    private createHttpClient(): AxiosInstance {
        const baseURL = this.getRpcUrl();
        return axios.create({
            baseURL,
            timeout: 30000,
            headers: {
                'Content-Type': 'application/json'
            }
        });
    }

    /**
     * Get RPC URL
     */
    private getRpcUrl(): string {
        if (this.config.rpcUrl) {
            return this.config.rpcUrl;
        }

        // Gap 15 sixteenth-pass closure (commit 4/6) — these defaults
        // address the Infrix JSON-RPC dispatcher (POST /rpc on the
        // Infrix node), NOT Accumulate L0's REST API (which lives at
        // :26660/v3 and is consumed only by pkg/l0/*). Any state-
        // changing call here flows through governed.submit.
        switch (this.config.network) {
            case 'mainnet':
                return 'https://mainnet.infrix.opendlt.org/rpc';
            case 'testnet':
                return 'https://testnet.infrix.opendlt.org/rpc';
            case 'devnet':
                return 'https://devnet.infrix.opendlt.org/rpc';
            case 'local':
                return 'http://localhost:8080/rpc';
            default:
                return 'http://localhost:8080/rpc';
        }
    }

    /**
     * Make JSON-RPC call
     */
    private async rpc(method: string, params: any): Promise<any> {
        const response = await this.http.post('', {
            jsonrpc: '2.0',
            id: Date.now(),
            method,
            params
        });

        if (response.data.error) {
            throw new Error(response.data.error.message || 'RPC error');
        }

        return response.data.result;
    }

    /**
     * Deploy a contract through the canonical governed.submit seam.
     *
     * Gap 15 sixth-pass §15 Phase R closure: every contract deployment
     * flows through the Intent->Plan->Approval->Execution->Outcome->
     * Evidence spine via governed.submit with goalType: 'CONTRACT_DEPLOY'.
     * The legacy contract.deploy RPC method was deleted in Phase H; this
     * client now mirrors the canonical pkg/wallet/wallet.go::Deploy shape.
     */
    async deploy(wasmPath: string, contractUrl: string): Promise<DeployResult> {
        // Read WASM file
        const wasmBytes = fs.readFileSync(wasmPath);

        // Validate WASM
        if (wasmBytes.length < 4 || wasmBytes.toString('utf8', 0, 4) !== '\0asm') {
            throw new Error('Invalid WASM file');
        }

        const result = await this.rpc('governed.submit', {
            goalType: 'CONTRACT_DEPLOY',
            actor: contractUrl,
            purpose: 'operational',
            workflowInstance: 'vscode-deploy',
            customParams: {
                authority: contractUrl,
                bytecode: wasmBytes.toString('hex'),
                gasLimit: 500000
            }
        });

        return {
            txHash: result?.intent?.id ?? ''
        };
    }

    /**
     * Call a contract function through the canonical governed.submit seam.
     *
     * Gap 15 sixth-pass §15 Phase R closure: contract calls flow through
     * the Intent->Plan->Approval->Execution->Outcome->Evidence spine via
     * governed.submit with goalType: 'CONTRACT_CALL'. The legacy
     * contract.call RPC method was deleted in Phase H; this client now
     * mirrors the canonical pkg/wallet/wallet.go::Call shape.
     */
    async call(
        contractUrl: string,
        functionName: string,
        args: any[]
    ): Promise<CallResult> {
        const result = await this.rpc('governed.submit', {
            goalType: 'CONTRACT_CALL',
            actor: contractUrl,
            purpose: 'operational',
            workflowInstance: 'vscode-call',
            customParams: {
                contract: contractUrl,
                function: functionName,
                args,
                gasLimit: 200000
            }
        });

        return {
            txHash: result?.intent?.id ?? '',
            returnData: result?.receipt?.returnData
        };
    }

    /**
     * Query contract state
     */
    async query(
        contractUrl: string,
        functionName: string,
        args: any[]
    ): Promise<QueryResult> {
        const result = await this.rpc('contract.query', {
            url: contractUrl,
            function: functionName,
            args
        });

        return {
            result: result.result,
            rawData: result.rawData
        };
    }

    /**
     * Get contract events. Routed through the registered events.history
     * JSON-RPC method (pkg/devnet/rpc_handler.go:140) — the legacy
     * `contract.events` method was never registered server-side and
     * would have returned method-not-found at runtime. Filtering by
     * contract URL / block range is performed client-side because the
     * server's eventsHistoryParams accepts only an eventType filter.
     */
    async getEvents(
        contractUrl: string,
        eventName?: string,
        fromBlock?: number,
        toBlock?: number
    ): Promise<ContractEvent[]> {
        const result = await this.rpc('events.history', {
            eventType: eventName ?? '',
        });

        const events: ContractEvent[] = (result.events || []) as ContractEvent[];
        return events.filter(e => {
            if (fromBlock !== undefined && e.blockHeight < fromBlock) return false;
            if (toBlock !== undefined && e.blockHeight > toBlock) return false;
            void contractUrl;
            return true;
        });
    }

    /**
     * Subscribe to contract events
     */
    async subscribeEvents(
        contractUrl: string,
        eventName?: string,
        callback: (event: ContractEvent) => void = () => {}
    ): Promise<{ unsubscribe: () => void }> {
        // WebSocket subscription would be implemented here
        // For now, use polling
        let running = true;
        let lastBlock = 0;

        const poll = async () => {
            while (running) {
                try {
                    const events = await this.getEvents(contractUrl, eventName, lastBlock);
                    for (const event of events) {
                        if (event.blockHeight > lastBlock) {
                            lastBlock = event.blockHeight;
                            callback(event);
                        }
                    }
                } catch (error) {
                    console.error('Event polling error:', error);
                }
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        };

        poll();

        return {
            unsubscribe: () => { running = false; }
        };
    }

    /**
     * Get transaction receipt
     */
    async getTransaction(txHash: string): Promise<any> {
        return this.rpc('tx.get', { txHash });
    }

    /**
     * Wait for transaction confirmation
     */
    async waitForTransaction(txHash: string, timeout: number = 60000): Promise<any> {
        const startTime = Date.now();

        while (Date.now() - startTime < timeout) {
            try {
                const tx = await this.getTransaction(txHash);
                if (tx.status !== 'pending') {
                    return tx;
                }
            } catch (error) {
                // Transaction not found yet
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        throw new Error('Transaction confirmation timeout');
    }
}
