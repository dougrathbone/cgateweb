const httpDefault = require('http');

/**
 * Thin helper for creating/dismissing Home Assistant persistent notifications
 * via the Supervisor → Core API proxy (http://supervisor/core/api/...).
 * Requires a Supervisor token (add-on environment). `httpModule` is injectable
 * for testing.
 */

function _postService(domainService, body, { token, httpModule = httpDefault, timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = httpModule.request(
            `http://supervisor/core/api/services/${domainService}`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data)
                },
                timeout: timeoutMs
            },
            (res) => {
                let bodyText = '';
                res.on('data', (chunk) => { bodyText += chunk; });
                res.on('end', () => resolve({ statusCode: res.statusCode, body: bodyText }));
            }
        );
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(data);
        req.end();
    });
}

/**
 * Create (or replace, by notification_id) an HA persistent notification.
 * @param {{notificationId:string, title:string, message:string, token:string, httpModule?:object, timeoutMs?:number}} opts
 */
function createPersistentNotification({ notificationId, title, message, token, httpModule, timeoutMs }) {
    return _postService(
        'persistent_notification/create',
        { notification_id: notificationId, title, message },
        { token, httpModule, timeoutMs }
    );
}

/**
 * Dismiss a previously-created persistent notification by id.
 * @param {{notificationId:string, token:string, httpModule?:object, timeoutMs?:number}} opts
 */
function dismissPersistentNotification({ notificationId, token, httpModule, timeoutMs }) {
    return _postService(
        'persistent_notification/dismiss',
        { notification_id: notificationId },
        { token, httpModule, timeoutMs }
    );
}

module.exports = { createPersistentNotification, dismissPersistentNotification };
