/**
 * Diagnostics for slow or failing proxied requests.
 *
 * The plugin shares SillyTavern's event loop. When ST blocks its main thread
 * (building a large prompt, thumbnails, ...), the proxy stalls too, and
 * outbound connects can time out: Node's happy-eyeballs gives each address
 * only 250 ms, so a blocked loop can skip a healthy IPv4 address and end up
 * waiting on an unreachable IPv6 one. `fetch failed` alone hides all of that,
 * so these helpers record per-stage timings, event-loop stalls and the full
 * error `cause` chain.
 */

import { performance } from 'node:perf_hooks'

/**
 * Flatten an error and its `cause` chain (and AggregateError members) into one
 * line, e.g. `fetch failed; cause=ConnectTimeoutError: Connect Timeout Error
 * (...) [UND_ERR_CONNECT_TIMEOUT]`.
 *
 * @param {unknown} error
 */
export function describeError(error) {
  const parts = []
  const seen = new Set()
  /** @param {any} err @param {string} prefix */
  const visit = (err, prefix) => {
    if (err == null || seen.has(err) || parts.length >= 8) return
    if (typeof err !== 'object') {
      parts.push(`${prefix}${String(err)}`)
      return
    }
    seen.add(err)
    const name = prefix && err.name && err.name !== 'Error' ? `${err.name}: ` : ''
    const code = err.code ? ` [${err.code}]` : ''
    parts.push(`${prefix}${name}${err.message ?? String(err)}${code}`)
    if (Array.isArray(err.errors)) {
      for (const member of err.errors) visit(member, 'error=')
    }
    visit(err.cause, 'cause=')
  }
  visit(error, '')
  return parts.join('; ')
}

/** @param {number} ms */
export function formatMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

/** @param {number} bytes */
export function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)}MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${bytes}B`
}

/**
 * Samples event-loop lag with a coarse timer. Stalls of at least `warnMs` are
 * logged as they end; `track()` also reports the worst stall seen while a
 * request was in flight.
 *
 * @param {{ intervalMs?: number, warnMs?: number, log?: (message: string) => void }} [options]
 */
export function createLoopLagMonitor({ intervalMs = 100, warnMs = 1000, log = () => {} } = {}) {
  /** @type {Set<{ maxLagMs: number }>} */
  const trackers = new Set()
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    const lag = Math.max(0, now - last - intervalMs)
    last = now
    for (const tracker of trackers) {
      if (lag > tracker.maxLagMs) tracker.maxLagMs = lag
    }
    if (warnMs > 0 && lag >= warnMs) {
      log(`Event loop was blocked for ${formatMs(lag)} (SillyTavern's main thread was busy; proxied requests stall and outbound connects may time out meanwhile).`)
    }
  }, intervalMs)
  timer.unref?.()

  return {
    /** Start recording the worst lag until `done()` is called. */
    track() {
      const tracker = { maxLagMs: 0, done: () => trackers.delete(tracker) }
      trackers.add(tracker)
      return tracker
    },
    stop() {
      clearInterval(timer)
      trackers.clear()
    },
  }
}
