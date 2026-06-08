/**
 * Infrix Cinema — data sources.
 *
 * A CinemaDataSource is the ONLY way the core obtains scene data, so the same
 * renderer/controls/details code drives every surface. The contract:
 *
 *   getScene()                  -> Promise<SceneGraph>
 *   subscribeScene(onScene)     -> unsubscribe()   (live updates; optional)
 *   getTimeline()               -> Promise<{currentSeq,totalSeq,speed}> | null
 *   getStateAt(blockOrSeq)      -> Promise<SceneGraph> | null  (replay)
 *   getDetails(nodeOrEdge)      -> Promise<object> | null      (enrichment)
 *   exportSnapshot()            -> Promise<{graph,meta}>       (for export)
 *   capabilities()              -> { live, replay, controls, disclosureAware }
 *
 * Four adapters cover the four modes:
 *   - NexusCinemaDataSource     RPC projection inside the Nexus SPA
 *   - StandaloneCinemaDataSource live Cinema WebSocket (the operator product)
 *   - ProofCinemaDataSource     a portable proof bundle, node-independent
 *   - EmbedCinemaDataSource     a pre-scoped, disclosure-filtered static scene
 *
 * Every adapter is disclosure-aware: the scene it yields is run through
 * InfrixCinema.applyDisclosure before the renderer sees it, so a read can
 * never leak private content client-side regardless of the host.
 */
(function (root) {
  'use strict';

  const ns = (root.InfrixCinema = root.InfrixCinema || {});

  // ---- WebSocket client (moved into the core from tools/cinema-viewer) ----
  class CinemaWSClient {
    constructor(url) {
      this.url = url;
      this.ws = null;
      this.sessionId = null;
      this.handlers = new Map();
      this.reconnectAttempts = 0;
      this.maxReconnectAttempts = 10;
      this.reconnectDelay = 1000;
    }
    connect() {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000;
        if (this.sessionId) this.subscribe(this.sessionId);
        this.dispatch('connected', {});
      };
      this.ws.onmessage = (event) => {
        try { const msg = JSON.parse(event.data); this.dispatch(msg.type, msg); }
        catch (e) { console.warn('Cinema WS: invalid message', e); }
      };
      this.ws.onclose = () => { this.dispatch('disconnected', {}); this.attemptReconnect(); };
      this.ws.onerror = (err) => { this.dispatch('error', { error: err }); };
    }
    subscribe(sessionId) { this.sessionId = sessionId; this.send({ type: 'subscribe', sessionId, payload: { sessionId } }); }
    unsubscribe() { this.send({ type: 'unsubscribe', sessionId: this.sessionId }); this.sessionId = null; }
    play() { this.send({ type: 'play', sessionId: this.sessionId }); }
    pause() { this.send({ type: 'pause', sessionId: this.sessionId }); }
    seek(eventSeq, block) { this.send({ type: 'seek', sessionId: this.sessionId, payload: { eventSeq, block } }); }
    setSpeed(speed) { this.send({ type: 'set_speed', sessionId: this.sessionId, payload: { speed } }); }
    stepForward() { this.send({ type: 'step_forward', sessionId: this.sessionId }); }
    stepBackward() { this.send({ type: 'step_backward', sessionId: this.sessionId }); }
    zoom(level) { this.send({ type: 'zoom', sessionId: this.sessionId, payload: { level } }); }
    on(type, cb) { if (!this.handlers.has(type)) this.handlers.set(type, []); this.handlers.get(type).push(cb); }
    off(type, cb) { const a = this.handlers.get(type); if (a) { const i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); } }
    dispatch(type, data) { (this.handlers.get(type) || []).forEach(cb => cb(data)); }
    send(msg) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg)); }
    attemptReconnect() {
      if (this.reconnectAttempts >= this.maxReconnectAttempts) { this.dispatch('reconnect_failed', {}); return; }
      this.reconnectAttempts++;
      this.dispatch('reconnecting', { attempt: this.reconnectAttempts });
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    }
    disconnect() { this.maxReconnectAttempts = 0; if (this.ws) this.ws.close(); }
    get isConnected() { return this.ws && this.ws.readyState === WebSocket.OPEN; }
  }

  // sceneFromMessage normalizes a WS/payload envelope into a scene graph.
  function sceneFromMessage(msg) { return (msg && (msg.payload || msg.data)) || msg || {}; }

  // disclosed runs a graph through the client-side disclosure filter when a
  // viewer context is present. Anonymous/embed contexts still get filtered so
  // any stray private node is redacted before the renderer sees it.
  function disclosed(graph, ctx) {
    if (!ns.applyDisclosure) return graph;
    return ns.applyDisclosure(graph || {}, ctx || {});
  }

  // ---- Base ----
  class CinemaDataSource {
    constructor(opts) { this.opts = opts || {}; this.disclosureContext = this.opts.disclosureContext || {}; }
    async getScene() { return disclosed({}, this.disclosureContext); }
    subscribeScene(_onScene) { return () => {}; }
    async getTimeline() { return null; }
    async getStateAt(_pos) { return null; }
    async getDetails(_target) { return null; }
    async exportSnapshot() { const g = await this.getScene(); return { graph: g, meta: {} }; }
    capabilities() { return { live: false, replay: false, controls: false, disclosureAware: true }; }
  }

  // ---- Nexus (RPC projection) ----
  // Polls a JSON-RPC projection method (default cinema.scene) through the
  // Nexus disclosure-aware rpc helper, so the scene is scoped to the viewer.
  class NexusCinemaDataSource extends CinemaDataSource {
    constructor(opts) {
      super(opts);
      this.rpc = opts.rpc;                       // function(method, params) -> Promise<result>
      this.method = opts.method || 'cinema.scene';
      this.params = opts.params || {};
      this.pollMs = opts.pollMs || 3000;
      this._timer = null;
    }
    async getScene() {
      const r = await this.rpc(this.method, this.params);
      return disclosed(r && (r.scene || r.graph || r), this.disclosureContext);
    }
    subscribeScene(onScene) {
      let stopped = false;
      const tick = async () => {
        if (stopped) return;
        try { const g = await this.getScene(); if (!stopped) onScene(g); } catch (e) { /* keep polling */ }
        if (!stopped) this._timer = setTimeout(tick, this.pollMs);
      };
      tick();
      return () => { stopped = true; if (this._timer) clearTimeout(this._timer); };
    }
    async getStateAt(pos) {
      const r = await this.rpc(this.method, Object.assign({}, this.params, { at: pos }));
      return disclosed(r && (r.scene || r.graph || r), this.disclosureContext);
    }
    capabilities() { return { live: true, replay: true, controls: true, disclosureAware: true }; }
  }

  // ---- Standalone (live WebSocket) ----
  class StandaloneCinemaDataSource extends CinemaDataSource {
    constructor(opts) {
      super(opts);
      this.wsUrl = opts.wsUrl;
      this.sessionId = opts.sessionId || null;
      this.client = opts.client || new CinemaWSClient(this.wsUrl);
      this._scene = null;
      this._timeline = { currentSeq: 0, totalSeq: 0, speed: 1 };
    }
    async discoverSession() {
      if (this.sessionId) return this.sessionId;
      try {
        const rpcUrl = this.wsUrl.replace('ws://', 'http://').replace('wss://', 'https://').replace('/cinema/ws', '/rpc');
        const resp = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'cinema.sessions', params: {}, id: 1 }) });
        const data = await resp.json();
        const sessions = data && data.result && data.result.sessions;
        if (sessions && sessions.length) { this.sessionId = sessions[0].id; return this.sessionId; }
      } catch (e) { /* fall through */ }
      return null;
    }
    subscribeScene(onScene) {
      const c = this.client;
      c.on('scene_full', (m) => { this._scene = disclosed(sceneFromMessage(m), this.disclosureContext); onScene(this._scene); });
      c.on('scene_graph', (m) => { this._scene = disclosed(sceneFromMessage(m), this.disclosureContext); onScene(this._scene); });
      c.on('scene_update', (m) => { /* renderer.applyUpdate is wired by app */ onScene({ __update: sceneFromMessage(m) }); });
      c.on('timeline_update', (m) => { this._timeline = sceneFromMessage(m); });
      this.discoverSession().then((sid) => { c.connect(); if (sid) c.subscribe(sid); });
      return () => c.disconnect();
    }
    async getScene() { return this._scene || disclosed({}, this.disclosureContext); }
    async getTimeline() { return this._timeline; }
    async getStateAt(pos) { this.client.seek(pos, pos); return this._scene; }
    capabilities() { return { live: true, replay: true, controls: true, disclosureAware: true }; }
  }

  // ---- Proof (portable bundle, node-independent) ----
  // Reads a self-contained proof bundle: scene + assurance + the canonical
  // artifacts it visualizes. It never contacts a node, so a recipient can
  // inspect a result without trusting the server that produced it.
  class ProofCinemaDataSource extends CinemaDataSource {
    constructor(opts) {
      super(opts);
      this.proof = opts.proof || {};
    }
    async getScene() {
      const g = this.proof.scene || this.proof.graph || {};
      // Proof mode shows ONLY what the bundle contains — still disclosure-filtered.
      return disclosed(g, this.disclosureContext);
    }
    async getTimeline() {
      const tl = this.proof.timeline;
      return tl || null;
    }
    async getStateAt(pos) {
      const frames = this.proof.frames || this.proof.replay;
      if (Array.isArray(frames) && frames.length) {
        // pick the frame at or before pos
        let chosen = frames[0];
        for (const f of frames) { if ((f.block || f.seq || 0) <= pos) chosen = f; }
        return disclosed(chosen.scene || chosen.graph || chosen, this.disclosureContext);
      }
      return this.getScene();
    }
    async getDetails(target) {
      const id = target && (target.id || target.fromId);
      const map = this.proof.details || {};
      return (id && map[id]) || null;
    }
    async exportSnapshot() { return { graph: await this.getScene(), meta: this.proof.meta || {} }; }
    // The assurance ladder for THIS proof — the highest level the bundle backs.
    assurance() { return this.proof.assurance || { id: 'offline' }; }
    capabilities() { return { live: false, replay: Array.isArray(this.proof.frames), controls: true, disclosureAware: true }; }
  }

  // ---- Embed (pre-scoped static scene, read-only) ----
  class EmbedCinemaDataSource extends CinemaDataSource {
    constructor(opts) { super(opts); this.scene = opts.scene || {}; }
    async getScene() { return disclosed(this.scene, this.disclosureContext); }
    capabilities() { return { live: false, replay: false, controls: false, disclosureAware: true }; }
  }

  Object.assign(ns, {
    CinemaWSClient, CinemaDataSource,
    NexusCinemaDataSource, StandaloneCinemaDataSource,
    ProofCinemaDataSource, EmbedCinemaDataSource,
    sceneFromMessage,
  });
  const api = {
    CinemaWSClient, CinemaDataSource,
    NexusCinemaDataSource, StandaloneCinemaDataSource,
    ProofCinemaDataSource, EmbedCinemaDataSource, sceneFromMessage,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
