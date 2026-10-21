/**
 * Node-side HTTP helpers for the enhancement route.
 *
 * Everything here is dependency-free on purpose: a profile-installed plugin
 * cannot rely on resolving `@deepseek-ai/*` packages at import time, so the
 * route only uses the `node:http` primitives handed to it by the host.
 */

/** Hosts a browser on the same machine is allowed to address us by. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * Strip the port from a `Host` header value, keeping IPv6 brackets intact.
 * @param {string} host
 * @returns {string}
 */
export function hostnameOfHost(host) {
  const value = host.trim()
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end === -1 ? value : value.slice(0, end + 1)
  }
  const colon = value.lastIndexOf(':')
  return colon === -1 ? value : value.slice(0, colon)
}

/**
 * @param {string} host
 * @returns {boolean}
 */
export function hostIsLoopback(host) {
  return LOOPBACK_HOSTS.has(hostnameOfHost(host).toLowerCase())
}

/**
 * `<img>`-style cross-origin requests and non-browser clients omit `Origin`;
 * only an explicit non-loopback origin is treated as untrusted.
 * @param {string | undefined} origin
 * @returns {boolean}
 */
export function originIsLoopback(origin) {
  if (origin === undefined || origin === '') return true
  try {
    return hostIsLoopback(new URL(origin).host)
  } catch {
    return false
  }
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function loopbackRequest(req) {
  const host = req.headers.host
  if (typeof host !== 'string') return false
  return hostIsLoopback(host) && originIsLoopback(req.headers.origin)
}

/**
 * Write a JSON body, tolerating a socket the client already closed.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
export function sendJson(res, status, body) {
  if (res.destroyed || res.writableEnded) return
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(payload)
}

/**
 * The single failure envelope the browser half understands.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} code
 * @param {string} message
 */
export function sendFailure(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } })
}

/**
 * Read and parse a bounded JSON request body.
 *
 * Resolves to `{}` for an empty body so the caller can report a field-level
 * error instead of a parse error.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<Record<string, unknown>>}
 */
export function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false

    const fail = (error) => {
      if (settled) return
      settled = true
      req.destroy()
      reject(error)
    }

    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        fail(Object.assign(new Error('request body is too large'), { code: 'body_too_large' }))
        return
      }
      chunks.push(chunk)
    })
    req.on('error', fail)
    req.on('aborted', () => fail(Object.assign(new Error('request aborted'), { code: 'body_aborted' })))
    req.on('end', () => {
      if (settled) return
      settled = true
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') {
        resolve({})
        return
      }
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        reject(Object.assign(new Error('request body is not valid JSON'), { code: 'invalid_body' }))
        return
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reject(Object.assign(new Error('request body must be a JSON object'), { code: 'invalid_body' }))
        return
      }
      resolve(parsed)
    })
  })
}
