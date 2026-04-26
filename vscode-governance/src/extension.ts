// G-21 phase 5 — Infrix VS Code extension entry point.
//
// Wires the governance tree provider, the plan-view webview, the
// evidence-view webview, and the wallet-connect command.

import * as vscode from "vscode";
import { InfrixClient } from "./api-client";
import { GovernanceTreeProvider } from "./governance-tree";
import { renderPlanWebview } from "./webviews/plan-view";
import { renderEvidenceWebview } from "./webviews/evidence-view";

export function activate(context: vscode.ExtensionContext): void {
  const client = clientFromConfig();
  const tree = new GovernanceTreeProvider(client);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("infrix.governanceTree", tree),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("infrix.refresh", () => {
      tree.refresh(clientFromConfig());
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("infrix.viewPlan", async (item: any) => {
      const intentId = (item?.intent?.id ?? item?.id) as string | undefined;
      if (!intentId) {
        vscode.window.showWarningMessage("Select an intent to view its plan.");
        return;
      }
      try {
        const plan = await clientFromConfig().getPlan(intentId);
        renderPlanWebview(context, plan);
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to load plan for ${intentId}: ${(err as Error).message}`,
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "infrix.viewEvidence",
      async (item: any) => {
        const intentId = (item?.intent?.id ?? item?.id) as string | undefined;
        if (!intentId) {
          vscode.window.showWarningMessage("Select an intent to view its evidence.");
          return;
        }
        try {
          const bundle = await clientFromConfig().getEvidence(intentId);
          renderEvidenceWebview(context, bundle);
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to load evidence for ${intentId}: ${(err as Error).message}`,
          );
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("infrix.connectWallet", async () => {
      const actor = await vscode.window.showInputBox({
        prompt: "Wallet ADI (e.g., acc://alice.acme)",
        placeHolder: "acc://alice.acme",
        value: vscode.workspace.getConfiguration("infrix").get<string>("actor"),
      });
      if (!actor) return;
      await vscode.workspace
        .getConfiguration("infrix")
        .update("actor", actor, vscode.ConfigurationTarget.Workspace);
      tree.refresh(clientFromConfig());
      vscode.window.showInformationMessage(`Infrix wallet connected as ${actor}`);
    }),
  );

  // Refresh whenever the workspace config changes the endpoint or
  // actor — operators flipping between devnets see the new tree
  // immediately.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("infrix.endpoint") ||
        e.affectsConfiguration("infrix.actor") ||
        e.affectsConfiguration("infrix.purpose")
      ) {
        tree.refresh(clientFromConfig());
      }
    }),
  );
}

export function deactivate(): void {
  // No cleanup needed — VS Code disposes context.subscriptions.
}

function clientFromConfig(): InfrixClient {
  const cfg = vscode.workspace.getConfiguration("infrix");
  return new InfrixClient({
    endpoint: cfg.get<string>("endpoint") ?? "http://localhost:8080",
    actor: cfg.get<string>("actor") ?? "",
    purpose: cfg.get<string>("purpose") ?? "audit",
  });
}
