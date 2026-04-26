// G-21 phase 5 — Governance tree provider.
//
// The sidebar's tree shows recent intents grouped by status. Each
// intent expands to its plan steps. Each plan step's tooltip shows
// the chosen plugin's Reason, ConfidentialityImplications, and
// CostImplications — surfaced from /v4/intents/{id}/plan via the
// criteria-aware ComputePluginSelectionsWithCriteria path.

import * as vscode from "vscode";
import {
  InfrixClient,
  IntentSummary,
  PlanSummary,
  PlanStepSummary,
} from "./api-client";

export type GovernanceNode =
  | IntentNode
  | PlanStepNode
  | DisconnectedNode
  | EmptyNode;

export interface IntentNode {
  kind: "intent";
  intent: IntentSummary;
  plan?: PlanSummary;
}

export interface PlanStepNode {
  kind: "step";
  intentId: string;
  step: PlanStepSummary;
  selectionReason: string;
  costImplications: string;
  confidentialityImplications: string;
}

export interface DisconnectedNode {
  kind: "disconnected";
}

export interface EmptyNode {
  kind: "empty";
  message: string;
}

export class GovernanceTreeProvider
  implements vscode.TreeDataProvider<GovernanceNode>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    GovernanceNode | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private client: InfrixClient) {}

  /** refresh forces the tree to re-fetch on next render. */
  refresh(client?: InfrixClient): void {
    if (client) {
      this.client = client;
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(node: GovernanceNode): vscode.TreeItem {
    switch (node.kind) {
      case "disconnected":
        return labelItem("Connect wallet to inspect governance",
          vscode.TreeItemCollapsibleState.None,
          undefined,
          new vscode.ThemeIcon("warning"));
      case "empty":
        return labelItem(node.message,
          vscode.TreeItemCollapsibleState.None);
      case "intent": {
        const item = new vscode.TreeItem(
          `${node.intent.goal} — ${node.intent.id}`,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.description = node.intent.status;
        item.tooltip = `Intent ${node.intent.id}\nGoal: ${node.intent.goal}\nStatus: ${node.intent.status}`;
        item.contextValue = node.intent.status === "completed" ? "intent-with-outcome" : "intent";
        return item;
      }
      case "step": {
        const item = new vscode.TreeItem(
          `${node.step.stepType}`,
          vscode.TreeItemCollapsibleState.None,
        );
        item.description = node.step.stageId;
        item.tooltip =
          `${node.step.description}\n\n` +
          `Plugin selection reason:\n  ${node.selectionReason}\n` +
          `${node.confidentialityImplications}\n` +
          `${node.costImplications}`;
        item.iconPath = new vscode.ThemeIcon("circle-outline");
        return item;
      }
    }
  }

  async getChildren(node?: GovernanceNode): Promise<GovernanceNode[]> {
    if (!this.client.isConnected()) {
      return [{ kind: "disconnected" }];
    }
    if (!node) {
      // Top level: list recent intents.
      try {
        const intents = await this.client.listRecentIntents();
        if (intents.length === 0) {
          return [{ kind: "empty", message: "No recent intents" }];
        }
        return intents.map((i) => ({ kind: "intent", intent: i }));
      } catch (err) {
        return [{ kind: "empty", message: `Error: ${(err as Error).message}` }];
      }
    }
    if (node.kind === "intent") {
      try {
        const plan = await this.client.getPlan(node.intent.id);
        return plan.steps.map((s) => {
          const sel = plan.pluginSelections[s.stageId] ?? {
            reason: "(no selection record)",
            costImplications: "",
            confidentialityImplications: "",
          };
          return {
            kind: "step",
            intentId: node.intent.id,
            step: s,
            selectionReason: sel.reason,
            costImplications: sel.costImplications,
            confidentialityImplications: sel.confidentialityImplications,
          };
        });
      } catch (err) {
        return [{ kind: "empty", message: `Plan unavailable: ${(err as Error).message}` }];
      }
    }
    return [];
  }
}

function labelItem(
  label: string,
  state: vscode.TreeItemCollapsibleState,
  contextValue?: string,
  icon?: vscode.ThemeIcon,
): vscode.TreeItem {
  const item = new vscode.TreeItem(label, state);
  if (contextValue) item.contextValue = contextValue;
  if (icon) item.iconPath = icon;
  return item;
}
