/**
 * Infrix Wallet — Content Script
 *
 * Injected into every page to provide the `window.infrix` provider object.
 * dApps use this to detect the wallet, connect, and send transactions.
 *
 * Communication flow:
 *   dApp → window.infrix (this script) → chrome.runtime.sendMessage → background.js
 */

(function() {
  'use strict';

  // Don't inject twice.
  if (window.infrix) return;

  /**
   * The Infrix provider object injected into every page.
   * dApps access this via `window.infrix`.
   */
  const provider = {
    isInfrix: true,
    version: '0.1.0',

    /**
     * Connect to the wallet. Returns the active ADI.
     * @returns {Promise<{adi: string, rpcUrl: string}>}
     */
    connect: function() {
      return sendToBackground({ type: 'wallet.getState' }).then(state => {
        if (!state.adi) {
          // No ADI configured yet — prompt the user via the popup.
          return sendToBackground({ type: 'wallet.requestApproval', requestType: 'connect', params: {} })
            .then(() => sendToBackground({ type: 'wallet.getState' }));
        }
        return { adi: state.adi, rpcUrl: 'http://localhost:8080/rpc' };
      });
    },

    /**
     * Submit a governed intent. State-changing contract deployment or
     * invocation is expressed as an intent with an appropriate goal type
     * (e.g. CONTRACT_DEPLOY, CONTRACT_CALL, OBJECT_CREATE) and flows
     * through the canonical spine. The extension does not expose direct
     * contract mutation paths.
     */
    submitIntent: function(goal, opts) {
      return sendToBackground({ type: 'wallet.submitIntent', goal, opts: opts || {} });
    },

    /**
     * Sign an ApprovalEnvelope for a plan hash.
     */
    approveIntent: function(intentId, planHash) {
      return sendToBackground({ type: 'wallet.approveIntent', intentId, planHash });
    },

    /**
     * Create a session key with scoped permissions.
     */
    createSession: function(scope) {
      return sendToBackground({ type: 'wallet.createSession', scope });
    },

    /**
     * Revoke a session key.
     */
    revokeSession: function(publicKey) {
      return sendToBackground({ type: 'wallet.revokeSession', publicKey });
    },

    /**
     * Sign a message with the active key.
     */
    sign: function(message) {
      return sendToBackground({ type: 'wallet.sign', message });
    },

    /**
     * Register an event listener.
     */
    on: function(event, handler) {
      if (!provider._handlers) provider._handlers = {};
      if (!provider._handlers[event]) provider._handlers[event] = [];
      provider._handlers[event].push(handler);
    },

    /**
     * Emit an event to registered handlers.
     */
    _emit: function(event, data) {
      if (provider._handlers && provider._handlers[event]) {
        provider._handlers[event].forEach(h => h(data));
      }
    },
  };

  // Inject the provider into the page.
  window.infrix = provider;

  // Dispatch a custom event so dApps can detect the wallet.
  window.dispatchEvent(new CustomEvent('infrix:ready', { detail: { version: '0.1.0' } }));

  /**
   * Send a message to the background script via chrome.runtime.sendMessage.
   */
  function sendToBackground(message) {
    return new Promise((resolve, reject) => {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage(message, response => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.error) {
            reject(new Error(response.error));
          } else {
            resolve(response);
          }
        });
      } else {
        // Fallback for non-extension environments (testing).
        reject(new Error('Infrix extension not available'));
      }
    });
  }
})();
