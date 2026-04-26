// G-21 phase 5 — Infrix VS Code extension HTTP client.
//
// Every governance read goes through this client. Disclosure
// headers (X-Actor / X-Purpose / X-Workflow-Instance) are injected
// from VS Code workspace configuration so the server-side gate
// admits the request.

export interface IntentSummary {
  id: string;
  goal: string;
  status: string;
  createdAt: string;
}

export interface PlanSummary {
  id: string;
  intentId: string;
  steps: PlanStepSummary[];
  pluginSelections: Record<string, PluginSelectionSummary>;
}

export interface PlanStepSummary {
  stageId: string;
  stepType: string;
  description: string;
}

export interface PluginSelectionSummary {
  stepId: string;
  pluginId: string;
  reason: string;
  fallbacks: string[];
  confidentialityImplications: string;
  costImplications: string;
}

export interface EvidenceBundleSummary {
  intentId: string;
  chainHash: string;
  contributions: Array<{
    pluginId: string;
    kind: string;
  }>;
}

export interface ClientConfig {
  endpoint: string;
  actor: string;
  purpose: string;
}

/**
 * Minimal Infrix REST client for the VS Code extension. All
 * methods return parsed JSON; HTTP errors throw.
 */
export class InfrixClient {
  private readonly endpoint: string;
  private readonly actor: string;
  private readonly purpose: string;

  constructor(config: ClientConfig) {
    this.endpoint = config.endpoint.replace(/\/$/, "");
    this.actor = config.actor;
    this.purpose = config.purpose || "audit";
  }

  /** isConnected is true when the actor is non-empty (wallet connected). */
  isConnected(): boolean {
    return this.actor !== "";
  }

  async listRecentIntents(): Promise<IntentSummary[]> {
    const body = await this.get<{ intents: IntentSummary[] }>("/v4/intents/recent");
    return body.intents ?? [];
  }

  async getPlan(intentId: string): Promise<PlanSummary> {
    return await this.get<PlanSummary>(`/v4/intents/${intentId}/plan`);
  }

  async getEvidence(intentId: string): Promise<EvidenceBundleSummary> {
    return await this.get<EvidenceBundleSummary>(`/v4/intents/${intentId}/evidence`);
  }

  private async get<T>(path: string): Promise<T> {
    if (!this.isConnected()) {
      throw new Error("wallet not connected: set 'infrix.actor' in workspace settings");
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Actor": this.actor,
      "X-Purpose": this.purpose,
    };
    const res = await fetch(this.endpoint + path, { headers });
    if (!res.ok) {
      throw new Error(`${path}: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }
}
