/**
 * Infrix Cinema — expanded console (full-tab host).
 *
 * Opened from the wallet popup (an activity row, or an approval's Expand
 * affordance) via chrome.tabs.create on this internal extension page. It mounts
 * the canonical Cinema core full-screen in `cinema.nexus` mode — the same
 * renderer, vocabulary, disclosure, narrative, proof, minimap, search, and
 * trust-ladder the Nexus SPA uses — against the wallet's RPC, scoped to the
 * intent in the query string (?intent=...). This is where the engine finally
 * gets the room a 360px popup can't give it.
 *
 * The page has no host_permissions of its own beyond the extension's; it reads
 * scene data by proxying cinema.* JSON-RPC through the background service
 * worker (which stamps the disclosure trio), so the server gate is satisfied
 * and no extra permission is required.
 */
(function () {
  'use strict';

  function showEmpty(msg) {
    const el = document.getElementById('consoleEmpty');
    if (el) { el.textContent = msg; el.hidden = false; }
  }

  const params = new URLSearchParams(location.search);
  const intentId = params.get('intent') || '';
  document.title = intentId ? ('Infrix Cinema · ' + intentId) : 'Infrix Cinema';

  const root = document.getElementById('cinema-root');
  const core = (typeof window !== 'undefined') && window.InfrixCinema;
  if (!core || typeof core.mountCinema !== 'function') {
    showEmpty('Cinema core failed to load.');
    return;
  }

  // JSON-RPC closure → background wallet.rpc proxy. The background augments the
  // disclosure context (actor / purpose / workflow-instance) on every call.
  function rpc(method, rpcParams) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: 'wallet.rpc', method, params: rpcParams || {} }, (res) => {
          if (chrome.runtime && chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!res) return reject(new Error('no response from background'));
          if (res.error) return reject(new Error(typeof res.error === 'string' ? res.error : JSON.stringify(res.error)));
          resolve(res.result);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  const sceneParams = intentId ? { intentId } : {};
  let dataSource = null;
  if (typeof core.NexusCinemaDataSource === 'function') {
    dataSource = new core.NexusCinemaDataSource({ rpc, method: 'cinema.scene', params: sceneParams });
  }

  try {
    core.mountCinema({
      mode: 'cinema.nexus',
      root,
      dataSource,
      rpc,
      method: 'cinema.scene',
      params: sceneParams,
    });
  } catch (e) {
    showEmpty('Could not start Cinema: ' + (e && e.message ? e.message : String(e)));
  }
})();
