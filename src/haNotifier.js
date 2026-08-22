// @ts-check
const { resolveSetting } = require('./config/schema');
const { supervisorRequest } = require('./supervisorHttp');

/**
 * Thin helper for creating/dismissing Home Assistant persistent notifications
 * via the Supervisor → Core API proxy (http://supervisor/core/api/...).
 * Requires a Supervisor token (add-on environment). `httpModule` is injectable
 * for testing.
 */

/**
 * POST to an HA service via the Supervisor proxy.
 * @param {string} domainService - Service path, e.g. 'persistent_notification/create'
 * @param {Object} body - JSON body for the service call
 * @param {Object} options
 * @param {string} [options.token] - Supervisor token
 * @param {Object} [options.httpModule] - http implementation override (testing)
 * @param {number} [options.timeoutMs=5000] - request timeout
 * @private
 */
function _postService(domainService, body, { token, httpModule, timeoutMs } = {}) {
    const effectiveTimeoutMs = timeoutMs !== undefined
        ? timeoutMs
        : resolveSetting({}, 'haNotifierTimeoutMs');
    return supervisorRequest({
        method: 'POST',
        url: `http://supervisor/core/api/services/${domainService}`,
        token,
        httpModule,
        timeoutMs: effectiveTimeoutMs,
        body
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
