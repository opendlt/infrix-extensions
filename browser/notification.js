/**
 * InfrixNotification - Transaction result notifications for the extension.
 * Shows browser notifications after transaction execution and provides
 * links to Cinema replay.
 */
class InfrixNotification {
    constructor(rpcUrl) {
        this.rpcUrl = rpcUrl;
    }

    /**
     * Show a transaction result notification.
     * @param {string} txHash - Transaction hash
     * @param {object} result - Execution result
     */
    showTransactionResult(txHash, result) {
        const title = result.success ? 'Transaction Confirmed' : 'Transaction Failed';
        const truncated = txHash.length > 16 ? txHash.slice(0, 16) + '...' : txHash;

        let message;
        if (result.success) {
            message = `${truncated} succeeded\nGas: ${(result.gasUsed || 0).toLocaleString()}`;
        } else {
            message = `${truncated} failed\n${result.error || 'Unknown error'}`;
        }

        this.show(title, message, txHash);
    }

    /**
     * Show a Mission Control alert notification.
     * @param {object} alert - Alert from Mission Control WebSocket
     */
    showAlert(alert) {
        if (alert.severity === 'critical' || alert.severity === 'high') {
            this.show(
                `Alert: ${alert.type}`,
                alert.message || alert.description || 'No details',
                `alert_${Date.now()}`
            );
        }
    }

    /**
     * Show a Cinema replay available notification.
     * @param {string} txHash - Transaction hash
     * @param {string} sessionId - Cinema session ID
     */
    showCinemaReady(txHash, sessionId) {
        this.show(
            'Cinema Replay Ready',
            `View execution trace for ${txHash.slice(0, 16)}...`,
            `cinema_${txHash}`
        );
    }

    /**
     * Show a generic browser notification.
     */
    show(title, message, notificationId) {
        // Use Chrome notifications API if available (service worker context)
        if (typeof chrome !== 'undefined' && chrome.notifications) {
            chrome.notifications.create(notificationId || `notif_${Date.now()}`, {
                type: 'basic',
                iconUrl: 'icons/icon48.png',
                title: `Infrix: ${title}`,
                message: message,
            });
            return;
        }

        // Fallback to Web Notifications API (popup/content context)
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            new Notification(`Infrix: ${title}`, { body: message });
        }
    }

    /**
     * Request notification permission.
     */
    static async requestPermission() {
        if (typeof Notification !== 'undefined') {
            return Notification.requestPermission();
        }
        return 'denied';
    }
}

if (typeof window !== 'undefined') window.InfrixNotification = InfrixNotification;
if (typeof module !== 'undefined') module.exports = { InfrixNotification };
