/**
 * Wire constants shared by the `kody dev` proxy (Node) and the dev entry that
 * runs inside workerd.
 */

/**
 * Prefix the dev entry puts on every captured `console.*` line it writes to
 * workerd stdout. Control characters keep it from colliding with app output.
 */
export const appLogMarker = '\u001fkody-dev-log\u001f'

/** Proxy → workerd: short request id used to tag logs and errors. */
export const devRequestIdHeader = 'x-kody-dev-request'

/** workerd → proxy: the response carries a serialized uncaught handler error. */
export const devErrorHeader = 'x-kody-dev-error'
