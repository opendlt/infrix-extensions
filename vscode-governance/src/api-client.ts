// G-21 phase 5 — Infrix VS Code extension HTTP client.
//
// Every governance read goes through this client. Disclosure
// headers (X-Actor / X-Purpose / X-Workflow-Instance) are injected
// from VS Code workspace configuration so the server-side gate
// admits the request.
//
// P2-004 closure (2026-05-03): the client now (1) emits the full
// disclosure-header trio including X-Workflow-Instance — the Gap 12
// gate rejects requests missing any of the three with HTTP 400 —
// and (2) accepts a constructor-supplied fetchFn so the smoke test
// suite can drive it against an in-process http.Server without a
// network detour. Production callers pass nothing and inherit the
// platform's globalThis.fetch.

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
  /** Workflow-instance marker for the X-Workflow-Instance header.
   * Defaults to a stable per-session value derived from the actor
   * when omitted; smoke tests pass an explicit value to assert
   * round-trip propagation. */
  workflowInstance?: string;
  /** Optional fetch implementation for tests / dependency injection.
   * When omitted the client uses globalThis.fetch (Node 18+ /
   * VS Code's built-in). */
  fetchFn?: typeof fetch;
}

/**
 * Minimal Infrix REST client for the VS Code extension. All
 * methods return parsed JSON; HTTP errors throw.
 */
export class InfrixClient {
  private readonly endpoint: string;
  private readonly actor: string;
  private readonly purpose: string;
  private readonly workflowInstance: string;
  private readonly fetchFn: typeof fetch;

  constructor(config: ClientConfig) {
    this.endpoint = config.endpoint.replace(/\/$/, "");
    this.actor = config.actor;
    this.purpose = config.purpose || "audit";
    // Stable default keeps repeated calls from a single VS Code
    // session correlatable in the audit log without forcing every
    // operator to set the value explicitly. Smoke tests override.
    this.workflowInstance =
      config.workflowInstance && config.workflowInstance.length > 0
        ? config.workflowInstance
        : `vscode-${this.actor || "anonymous"}`;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
    if (typeof this.fetchFn !== "function") {
      throw new Error(
        "InfrixClient: no fetch implementation available — pass config.fetchFn or run on Node 18+/VS Code with globalThis.fetch",
      );
    }
  }

  /** isConnected is true when the actor is non-empty (wallet connected). */
  isConnected(): boolean {
    return this.actor !== "";
  }

  /** Returns the canonical disclosure header trio for testing. */
  disclosureHeaders(): Record<string, string> {
    return {
      "X-Actor": this.actor,
      "X-Purpose": this.purpose,
      "X-Workflow-Instance": this.workflowInstance,
    };
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
      ...this.disclosureHeaders(),
    };
    const res = await this.fetchFn(this.endpoint + path, { headers });
    if (!res.ok) {
      throw new Error(`${path}: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }
}
