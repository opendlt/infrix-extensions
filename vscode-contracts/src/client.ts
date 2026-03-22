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

        switch (this.config.network) {
            case 'mainnet':
                return 'https://mainnet.accumulatenetwork.io/v3';
            case 'testnet':
                return 'https://testnet.accumulatenetwork.io/v3';
            case 'devnet':
                return 'https://devnet.accumulatenetwork.io/v3';
            case 'local':
                return 'http://localhost:26660/v3';
            default:
                return 'https://testnet.accumulatenetwork.io/v3';
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
     * Deploy a contract
     */
    async deploy(wasmPath: string, contractUrl: string): Promise<DeployResult> {
        // Read WASM file
        const wasmBytes = fs.readFileSync(wasmPath);

        // Validate WASM
        if (wasmBytes.length < 4 || wasmBytes.toString('utf8', 0, 4) !== '\0asm') {
            throw new Error('Invalid WASM file');
        }

        const result = await this.rpc('contract.deploy', {
            url: contractUrl,
            bytecode: wasmBytes.toString('hex'),
            gasLimit: 500000
        });

        return {
            txHash: result.txHash
        };
    }

    /**
     * Call a contract function
     */
    async call(
        contractUrl: string,
        functionName: string,
        args: any[]
    ): Promise<CallResult> {
        const result = await this.rpc('contract.call', {
            url: contractUrl,
            function: functionName,
            args,
            gasLimit: 200000
        });

        return {
            txHash: result.txHash,
            returnData: result.returnData
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
     * Get contract events
     */
    async getEvents(
        contractUrl: string,
        eventName?: string,
        fromBlock?: number,
        toBlock?: number
    ): Promise<ContractEvent[]> {
        const result = await this.rpc('contract.events', {
            url: contractUrl,
            eventName,
            fromBlock,
            toBlock
        });

        return result.events || [];
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
