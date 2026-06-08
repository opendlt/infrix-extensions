/**
 * Infrix Cinema — canonical visual vocabulary.
 *
 * This is the SINGLE browser-side source of truth for the Cinema visual
 * language: node kinds, edge kinds, shapes, the color palette, disclosure
 * placeholders, and the assurance ladder used by proof mode. Every Cinema
 * surface (full / nexus / embed / proof) renders from this vocabulary so the
 * standalone product and the Nexus-mounted view prove the SAME things with the
 * SAME symbols.
 *
 * Parity is enforced against the Go scene vocabulary
 * (pkg/cinema/scene/types.go) by TestCinemaVocabularyParity in
 * pkg/cinema/scene. The Go test parses both this file and types.go and fails
 * if a NodeKind / EdgeKind / Shape / Color drifts between them. Keep the
 * literal shapes below (flat `name: 'value'` and `Name: { r, g, b, a }`)
 * parseable — do not introduce computed values.
 *
 * Loaded as a classic script (no bundler, works over file://). It attaches to
 * window.InfrixCinema; the tiny ESM shim cinema-core/esm.js re-exports it for
 * the Nexus module context.
 */
(function (root) {
  'use strict';

  // ---- Node kinds (mirror pkg/cinema/scene/types.go NodeKind) ----
  const NODE_KINDS = {
    contract: 'contract',
    account: 'account',
    token_pool: 'token_pool',
    invariant: 'invariant',
    circuit_breaker: 'circuit_breaker',
    block: 'block',
    gas_meter: 'gas_meter',
    plan_timeline: 'plan_timeline',
    plan_step: 'plan_step',
    ghost_prediction: 'ghost_prediction',
    ghost_drift: 'ghost_drift',
    ghost_actual: 'ghost_actual',
    swarm_governance: 'swarm_governance',
    swarm_member_status: 'swarm_member_status',
    approver: 'approver',
    approval_gate: 'approval_gate',
    policy: 'policy',
    policy_decision: 'policy_decision',
    intent: 'intent',
    outcome: 'outcome',
    evidence: 'evidence',
    evidence_link: 'evidence_link',
    trust_profile: 'trust_profile',
    trust_domain: 'trust_domain',
    capability: 'capability',
    trust_bridge: 'trust_bridge',
    trust_feed: 'trust_feed',
    trust_credential: 'trust_credential',
    trust_verifier: 'trust_verifier',
    trust_oracle: 'trust_oracle',
    trust_ml_model: 'trust_ml_model',
    trust_governance: 'trust_governance',
    role: 'role',
    role_binding: 'role_binding',
    settlement: 'settlement',
    escrow: 'escrow',
    reservation: 'reservation',
    netting_group: 'netting_group',
    disclosure_grant: 'disclosure_grant',
    anchor: 'anchor',
    l0_bridge: 'l0_bridge',
  };

  // ---- Edge kinds (mirror pkg/cinema/scene/types.go EdgeKind) ----
  const EDGE_KINDS = {
    transfer: 'transfer',
    contract_call: 'contract_call',
    contract_return: 'contract_return',
    event_emit: 'event_emit',
    event_dispatch: 'event_dispatch',
    dependency: 'dependency',
    quarantine_warn: 'quarantine_warn',
    plan_link: 'plan_link',
    ghost_drift: 'ghost_drift',
    ghost_compare: 'ghost_compare',
    swarm_coordination: 'swarm_coordination',
    approval: 'approval',
    policy_check: 'policy_check',
    capability_exercise: 'capability_exercise',
    capability_delegation: 'capability_delegation',
    trust_evaluation: 'trust_evaluation',
    trust_dependency: 'trust_dependency',
    evidence_link: 'evidence_link',
    evidence_chain: 'evidence_chain',
    evidence_anchor: 'evidence_anchor',
    intent_to_outcome: 'intent_to_outcome',
    role_binding: 'role_binding',
    role_scope: 'role_scope',
    settlement_leg: 'settlement_leg',
    escrow_deposit: 'escrow_deposit',
    escrow_release: 'escrow_release',
    reservation_hold: 'reservation_hold',
    netting_link: 'netting_link',
    disclosure: 'disclosure',
    disclosure_grant: 'disclosure_grant',
    disclosure_access: 'disclosure_access',
    anchor_link: 'anchor_link',
    l0_connection: 'l0_connection',
  };

  // ---- Shapes (mirror pkg/cinema/scene/types.go Shape) ----
  const SHAPES = {
    circle: 'circle',
    hexagon: 'hexagon',
    shield: 'shield',
    diamond: 'diamond',
    rectangle: 'rectangle',
    gauge: 'gauge',
    star: 'star',
    gate: 'gate',
    document: 'document',
    arrow: 'arrow',
    octagon: 'octagon',
    pentagon: 'pentagon',
  };

  // ---- Color palette (mirror pkg/cinema/scene/types.go Color vars) ----
  // Keyed by the Go identifier WITHOUT the "Color" prefix, RGBA 0-255.
  const COLORS = {
    Normal: { r: 76, g: 175, b: 80, a: 255 },
    Throttled: { r: 255, g: 193, b: 7, a: 255 },
    Paused: { r: 255, g: 152, b: 0, a: 255 },
    Frozen: { r: 244, g: 67, b: 54, a: 255 },
    Transfer: { r: 33, g: 150, b: 243, a: 255 },
    Call: { r: 156, g: 39, b: 176, a: 255 },
    Event: { r: 0, g: 188, b: 212, a: 255 },
    Attack: { r: 244, g: 67, b: 54, a: 200 },
    Shield: { r: 76, g: 175, b: 80, a: 180 },
    Anomaly: { r: 255, g: 87, b: 34, a: 255 },
    Encrypted: { r: 158, g: 158, b: 158, a: 150 },
    Gas: { r: 255, g: 111, b: 0, a: 255 },
    Plan: { r: 33, g: 150, b: 243, a: 200 },
    PlanStep: { r: 100, g: 181, b: 246, a: 180 },
    Approved: { r: 76, g: 175, b: 80, a: 220 },
    Drift: { r: 255, g: 152, b: 0, a: 255 },
    GhostPrediction: { r: 137, g: 180, b: 250, a: 100 },
    GhostMatch: { r: 76, g: 175, b: 80, a: 150 },
    GhostMismatch: { r: 244, g: 67, b: 54, a: 180 },
    PolicyAllow: { r: 76, g: 175, b: 80, a: 220 },
    PolicyDeny: { r: 244, g: 67, b: 54, a: 220 },
    PolicyConflict: { r: 255, g: 193, b: 7, a: 220 },
    ApprovalPending: { r: 255, g: 235, b: 59, a: 200 },
    ApprovalGranted: { r: 76, g: 175, b: 80, a: 240 },
    ApprovalDenied: { r: 244, g: 67, b: 54, a: 240 },
    ApprovalExpired: { r: 158, g: 158, b: 158, a: 180 },
    Intent: { r: 63, g: 81, b: 181, a: 220 },
    IntentActive: { r: 92, g: 107, b: 192, a: 255 },
    IntentFailed: { r: 239, g: 83, b: 80, a: 220 },
    Capability: { r: 171, g: 71, b: 188, a: 220 },
    CapabilityDenied: { r: 186, g: 104, b: 200, a: 150 },
    TrustHealthy: { r: 0, g: 200, b: 83, a: 220 },
    TrustActive: { r: 76, g: 175, b: 80, a: 255 },
    TrustDegraded: { r: 255, g: 109, b: 0, a: 220 },
    TrustSuspended: { r: 255, g: 152, b: 0, a: 255 },
    TrustRevoked: { r: 244, g: 67, b: 54, a: 255 },
    Evidence: { r: 0, g: 172, b: 193, a: 200 },
    EvidenceAnchored: { r: 0, g: 131, b: 143, a: 240 },
    Outcome: { r: 121, g: 134, b: 203, a: 220 },
    OutcomeFailed: { r: 239, g: 83, b: 80, a: 220 },
    Settlement: { r: 255, g: 193, b: 7, a: 255 },
    SettlementActive: { r: 255, g: 235, b: 59, a: 255 },
    Escrow: { r: 171, g: 71, b: 188, a: 255 },
    EscrowFunded: { r: 126, g: 87, b: 194, a: 255 },
    Reservation: { r: 255, g: 152, b: 0, a: 180 },
    Dispute: { r: 244, g: 67, b: 54, a: 255 },
    Disclosure: { r: 255, g: 215, b: 0, a: 200 },
    DisclosureGrant: { r: 255, g: 215, b: 0, a: 150 },
    DisclosureRevoke: { r: 255, g: 87, b: 34, a: 200 },
    DisclosureProof: { r: 0, g: 200, b: 83, a: 200 },
    Anchor: { r: 255, g: 215, b: 0, a: 220 },
    AnchorFail: { r: 244, g: 67, b: 54, a: 200 },
    L0Bridge: { r: 0, g: 150, b: 136, a: 255 },
  };

  // ---- Disclosure placeholders (mirror visibility_filter.go) ----
  // These are the EXACT label/placeholder strings the Go VisibilityFilter
  // emits; the browser must render the same, never the redacted size/label.
  const DISCLOSURE = {
    PLACEHOLDER_ENCRYPTED: '[encrypted]',
    LABEL_PRIVATE: '[private]',
    LABEL_OWNER_RESTRICTED: '[owner-restricted]',
    LABEL_UNKNOWN: '[unknown-visibility]',
    FILTERED: '[filtered]',
    PRIVATE_NODE_FIXED_SIZE: 20.0,
    PRIVATE_NODE_FIXED_OPACITY: 0.4,
    PRIVATE_EDGE_FIXED_WIDTH: 1.5,
    PRIVATE_PARTICLE_FIXED_COUNT: 2,
    // Disclosed-via suffix the Go filter appends when a grant authorizes a
    // reveal: `key [disclosed]` or `key [disclosed via <grantID>]`.
    DISCLOSED_SUFFIX: ' [disclosed]',
    DISCLOSED_VIA_PREFIX: ' [disclosed via ',
  };

  // ---- Assurance ladder (proof mode labels) ----
  // Cinema is NON-COMMITTING: it visualizes canonical artifacts, it is never
  // canonical truth itself. Proof mode labels each claim with how strongly it
  // is backed. NEVER imply L4 (full external finality) without an L0 anchor.
  const ASSURANCE = {
    OFFLINE: { id: 'offline', label: 'Offline (structural)', rank: 0, color: COLORS.Encrypted, note: 'Bundle is internally consistent; not checked against any network.' },
    REPLAY: { id: 'replay', label: 'Replay-verified', rank: 1, color: COLORS.PlanStep, note: 'Re-executed from the portable capsule; deterministic result matches.' },
    L0: { id: 'l0', label: 'L0-anchored', rank: 2, color: COLORS.Anchor, note: 'Evidence digest is anchored on Accumulate L0.' },
    WITNESS: { id: 'witness', label: 'Witness-quorum', rank: 3, color: COLORS.DisclosureProof, note: 'Independent witnesses co-signed the receipt.' },
  };

  // Allowed assurance id set, in ladder order. Used to validate proof bundles.
  const ASSURANCE_ORDER = ['offline', 'replay', 'l0', 'witness'];

  function colorCss(c, alphaOverride) {
    if (!c) return 'rgba(120,140,170,0.8)';
    const a = (alphaOverride != null ? alphaOverride : (c.a != null ? c.a / 255 : 1));
    return `rgba(${c.r},${c.g},${c.b},${a})`;
  }

  // A coarse semantic role for a node kind, used by the legend to group symbols
  // and by embed mode to decide what is operator-only.
  function kindFamily(kind) {
    if (/^trust/.test(kind)) return 'trust';
    if (/^ghost/.test(kind)) return 'prediction';
    if (kind === 'policy' || kind === 'policy_decision' || kind === 'approver' || kind === 'approval_gate') return 'governance';
    if (kind === 'intent' || kind === 'outcome' || kind === 'evidence' || kind === 'evidence_link') return 'lifecycle';
    if (kind === 'anchor' || kind === 'l0_bridge') return 'anchor';
    if (kind === 'disclosure_grant') return 'disclosure';
    if (kind === 'settlement' || kind === 'escrow' || kind === 'reservation' || kind === 'netting_group') return 'settlement';
    if (kind === 'role' || kind === 'role_binding' || kind === 'capability') return 'authority';
    return 'core';
  }

  // VOCABULARY_MANIFEST is the flat, machine-readable summary the parity test
  // and the export/share report read. Counts let a fence detect silent drift.
  const VOCABULARY_MANIFEST = {
    version: 1,
    nodeKinds: Object.keys(NODE_KINDS).length,
    edgeKinds: Object.keys(EDGE_KINDS).length,
    shapes: Object.keys(SHAPES).length,
    colors: Object.keys(COLORS).length,
    assurance: ASSURANCE_ORDER.slice(),
  };

  const api = {
    NODE_KINDS, EDGE_KINDS, SHAPES, COLORS, DISCLOSURE, ASSURANCE,
    ASSURANCE_ORDER, VOCABULARY_MANIFEST, colorCss, kindFamily,
  };

  const ns = (root.InfrixCinema = root.InfrixCinema || {});
  Object.assign(ns, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
