/**
 * Streaming a completion out of the host's LLM service.
 *
 * Hard constraint: a profile-installed plugin must not `import` any
 * `@deepseek-ai/*` package — those live in the desktop bundle's module table,
 * not in `node_modules`, so a static import would break at load time. The LLM
 * runtime is reached through `ctx.get('llm')` instead, and messages are plain
 * objects (no message factories) because no adapter reads `message.id`.
 */

/**
 * @typedef {object} EnhanceTarget
 * @property {string} provider
 * @property {string} model
 * @property {string} [sessionId]
 */

/**
 * Error carrying a stable machine code so the route can pick a status.
 */
export class EnhanceError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   */
  constructor(code, message, status) {
    super(message)
    this.name = 'EnhanceError'
    this.code = code
    if (status !== undefined) this.status = status
  }
}

export const ABORTED = 'aborted'
export const TIMEOUT = 'timeout'
export const EMPTY_RESULT = 'empty_result'

/**
 * Run one non-agentic completion and concatenate its text blocks.
 *
 * @param {object} options
 * @param {any} options.llm                host LLM service
 * @param {string} options.provider        provider id, e.g. `workbuddy`
 * @param {string} options.model           model id within that provider
 * @param {string} options.system          instruction block
 * @param {Array<Record<string, unknown>>} options.messages
 * @param {number} options.maxTokens
 * @param {AbortSignal} options.signal
 * @param {string} [options.sessionId]
 * @param {string} [options.purpose]
 * @returns {Promise<{ text: string, truncated: boolean }>}
 */
export async function streamCompletion(options) {
  const { llm, provider, model, system, messages, maxTokens, signal, sessionId, purpose } = options

  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
    throw new EnhanceError('missing_route', 'provider and model are required to reach the LLM')
  }

  const request = {
    provider,
    model,
    system,
    messages,
    maxTokens,
    signal,
    ...(purpose === undefined ? {} : { purpose }),
    ...(sessionId === undefined ? {} : { sessionId }),
  }

  let text = ''
  let truncated = false

  for await (const chunk of llm.stream(request)) {
    if (chunk === null || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta') {
      if (typeof chunk.text === 'string') text += chunk.text
      continue
    }
    if (chunk.type !== 'finish') continue

    const reason = chunk.reason
    const kind = reason?.kind
    if (kind === 'stop') continue
    if (kind === 'max-tokens') {
      // A truncated completion is still useful: keep what the model produced.
      truncated = true
      continue
    }
    if (kind === 'aborted') {
      throw new EnhanceError(ABORTED, 'the enhancement was cancelled')
    }
    const failure = reason?.failure
    throw new EnhanceError(
      typeof failure?.code === 'string' && failure.code !== '' ? failure.code : 'llm_error',
      typeof failure?.message === 'string' && failure.message !== ''
        ? failure.message
        : 'the model call failed',
    )
  }

  return { text, truncated }
}

/**
 * Map a thrown value onto an HTTP status plus a stable code.
 *
 * @param {unknown} error
 * @param {AbortSignal} signal
 * @param {boolean} timedOut
 * @returns {{ status: number, code: string, message: string }}
 */
export function failureOf(error, signal, timedOut) {
  if (timedOut) {
    return {
      status: 504,
      code: TIMEOUT,
      message: 'the model did not answer in time',
    }
  }
  if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
    return { status: 499, code: ABORTED, message: 'the enhancement was cancelled' }
  }
  if (error instanceof EnhanceError) {
    if (error.code === ABORTED) {
      return { status: 499, code: ABORTED, message: error.message }
    }
    return { status: error.status ?? 502, code: error.code, message: error.message }
  }
  const message = error instanceof Error && error.message !== '' ? error.message : 'unknown failure'
  const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'llm_error'
  return { status: 502, code, message }
}
