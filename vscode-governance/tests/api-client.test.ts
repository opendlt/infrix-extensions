// Copyright 2024 The Infrix Authors
//
// Use of this source code is governed by an MIT-style
// license that can be found in the LICENSE file or at
// https://opensource.org/licenses/MIT.

// P2-004 closure (Infrix-Gap-Closure-Plan-2026-05-02) — VS Code
// extension smoke tests.
//
// Drives the InfrixClient against an in-process node:http server
// that records every inbound request. The mock server is the
// authoritative gate for the milestone-required header propagation
// check: every request must carry the full disclosure trio
// (X-Actor, X-Purpose, X-Workflow-Instance) and the canonical /v4
// path. Compiled via tests/tsconfig.json into out-tests/ and run
// with `node --test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { once } from "node:events";
import {
  InfrixClient,
  IntentSummary,
  PlanSummary,
  EvidenceBundleSummary,
} from "../src/api-client";

interface RecordedCall {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
}

interface MockServer {
  url: string;
  calls: RecordedCall[];
  setHandler(fn: (path: string) => unknown | { status: number; body?: unknown }): void;
  close(): Promise<void>;
}

async function startMockApi(): Promise<MockServer> {
  const calls: RecordedCall[] = [];
  let handler: (path: string) => unknown | { status: number; body?: unknown } = () => null;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    calls.push({
      method: req.method ?? "",
      path: req.url ?? "",
      headers: { ...req.headers },
    });
    const out = handler(req.url ?? "");
    if (out && typeof out === "object" && "status" in out) {
      const status = (out as { status: number }).status;
      const body = (out as { body?: unknown }).body ?? {};
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("mock api: failed to bind");
  }
  return {
    url: `http://127.0.0.1:${addr.port}`,
    calls,
    setHandler(fn) {
      handler = fn;
    },
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}

test("listRecentIntents hits /v4/intents/recent and unwraps the intents array", async () => {
  const mock = await startMockApi();
  try {
    const sample: IntentSummary[] = [
      { id: "intent-1", goal: "SWAP", status: "completed", createdAt: "2026-05-01T00:00:00Z" },
      { id: "intent-2", goal: "CONTRACT_DEPLOY", status: "pending", createdAt: "2026-05-02T00:00:00Z" },
    ];
    mock.setHandler(() => ({ intents: sample }));
    const c = new InfrixClient({
      endpoint: mock.url,
      actor: "acc://alice.acme",
      purpose: "audit",
      workflowInstance: "wfi-list-1",
    });
    const got = await c.listRecentIntents();
    assert.deepEqual(got, sample);
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].path, "/v4/intents/recent");
  } finally {
    await mock.close();
  }
});

test("getPlan hits /v4/intents/{id}/plan and returns the body verbatim", async () => {
  const mock = await startMockApi();
  try {
    const plan: PlanSummary = {
      id: "plan-1",
      intentId: "intent-1",
      steps: [
        { stageId: "step-1", stepType: "wasm", description: "deploy" },
      ],
      pluginSelections: {
        "step-1": {
          stepId: "step-1",
          pluginId: "plugins.wasm.wazero",
          reason: "default selection",
          fallbacks: [],
          confidentialityImplications: "none",
          costImplications: "low",
        },
      },
    };
    mock.setHandler(() => plan);
    const c = new InfrixClient({
      endpoint: mock.url,
      actor: "acc://alice.acme",
      purpose: "audit",
      workflowInstance: "wfi-plan-1",
    });
    const got = await c.getPlan("intent-1");
    assert.deepEqual(got, plan);
    assert.equal(mock.calls[0].path, "/v4/intents/intent-1/plan");
  } finally {
    await mock.close();
  }
});

test("getEvidence hits /v4/intents/{id}/evidence and returns bundle", async () => {
  const mock = await startMockApi();
  try {
    const bundle: EvidenceBundleSummary = {
      intentId: "intent-1",
      chainHash: "0xabc",
      contributions: [
        { pluginId: "plugins.wasm.wazero", kind: "execution_trace" },
      ],
    };
    mock.setHandler(() => bundle);
    const c = new InfrixClient({
      endpoint: mock.url,
      actor: "acc://alice.acme",
      purpose: "audit",
      workflowInstance: "wfi-evidence-1",
    });
    const got = await c.getEvidence("intent-1");
    assert.deepEqual(got, bundle);
    assert.equal(mock.calls[0].path, "/v4/intents/intent-1/evidence");
  } finally {
    await mock.close();
  }
});

test("every governance read carries X-Actor / X-Purpose / X-Workflow-Instance trio", async () => {
  const mock = await startMockApi();
  try {
    mock.setHandler((p) => {
      if (p.endsWith("/recent")) return { intents: [] };
      if (p.endsWith("/plan")) return { id: "p", intentId: "i", steps: [], pluginSelections: {} };
      if (p.endsWith("/evidence")) return { intentId: "i", chainHash: "0x", contributions: [] };
      return {};
    });
    const c = new InfrixClient({
      endpoint: mock.url,
      actor: "acc://alice.acme",
      purpose: "audit-deep",
      workflowInstance: "wfi-trio",
    });
    await c.listRecentIntents();
    await c.getPlan("intent-x");
    await c.getEvidence("intent-x");
    assert.equal(mock.calls.length, 3);
    for (const call of mock.calls) {
      assert.equal(call.headers["x-actor"], "acc://alice.acme",
        `P2-004: every governance read must carry X-Actor; saw headers=${JSON.stringify(call.headers)}`);
      assert.equal(call.headers["x-purpose"], "audit-deep",
        "P2-004: every governance read must carry X-Purpose verbatim from config");
      assert.equal(call.headers["x-workflow-instance"], "wfi-trio",
        "P2-004: every governance read must carry X-Workflow-Instance — Gap 12 disclosure gate rejects partial trios with HTTP 400");
      assert.equal(call.headers["content-type"], "application/json");
    }
  } finally {
    await mock.close();
  }
});

test("workflowInstance defaults to vscode-<actor> when config omits it", async () => {
  const mock = await startMockApi();
  try {
    mock.setHandler(() => ({ intents: [] }));
    const c = new InfrixClient({
      endpoint: mock.url,
      actor: "acc://alice.acme",
      purpose: "audit",
    });
    await c.listRecentIntents();
    assert.equal(mock.calls[0].headers["x-workflow-instance"], "vscode-acc://alice.acme",
      "P2-004: empty workflowInstance config must fall back to a stable per-actor default so audit trails always carry the trio");
  } finally {
    await mock.close();
  }
});

test("workflowInstance defaults to vscode-anonymous when actor empty (still requires connect)", async () => {
  const c = new InfrixClient({
    endpoint: "http://127.0.0.1:1",
    actor: "",
    purpose: "audit",
  });
  // Sanity: header default is computed from actor at construct time.
  assert.equal(c.disclosureHeaders()["X-Workflow-Instance"], "vscode-anonymous");
  // And the actual fetch fails closed with an actionable message.
  await assert.rejects(
    () => c.listRecentIntents(),
    /wallet not connected/,
    "P2-004: empty actor must fail closed with the canonical 'wallet not connected' message",
  );
});

test("isConnected flips true when actor is non-empty", () => {
  const empty = new InfrixClient({ endpoint: "http://x", actor: "", purpose: "audit" });
  assert.equal(empty.isConnected(), false);
  const set = new InfrixClient({ endpoint: "http://x", actor: "acc://alice.acme", purpose: "audit" });
  assert.equal(set.isConnected(), true);
});

test("non-2xx HTTP responses surface an actionable error message", async () => {
  const mock = await startMockApi();
  try {
    mock.setHandler(() => ({ status: 503, body: { error: "down" } }));
    const c = new InfrixClient({
      endpoint: mock.url,
      actor: "acc://alice.acme",
      purpose: "audit",
    });
    await assert.rejects(
      () => c.listRecentIntents(),
      /\/v4\/intents\/recent: 503/,
      "P2-004: non-2xx responses must surface path + status so the operator can act",
    );
  } finally {
    await mock.close();
  }
});

test("constructor injects fetchFn override (dependency-injection seam)", async () => {
  let captured: { url: string | URL | Request; init?: RequestInit } | null = null;
  const fakeFetch: typeof fetch = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ intents: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const c = new InfrixClient({
    endpoint: "http://example.invalid",
    actor: "acc://alice.acme",
    purpose: "audit",
    fetchFn: fakeFetch,
  });
  await c.listRecentIntents();
  if (!captured) {
    assert.fail("fakeFetch must have been invoked");
  }
  const cap = captured as { url: string | URL | Request; init?: RequestInit };
  assert.equal(String(cap.url), "http://example.invalid/v4/intents/recent");
  const init = cap.init as RequestInit;
  const headers = init.headers as Record<string, string>;
  assert.equal(headers["X-Actor"], "acc://alice.acme");
  assert.equal(headers["X-Purpose"], "audit");
  assert.equal(headers["X-Workflow-Instance"], "vscode-acc://alice.acme");
});
