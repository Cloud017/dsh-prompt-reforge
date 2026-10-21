/**
 * dsh-prompt-reforge — host half.
 *
 * Owns exactly one HTTP route, `POST /plugins/dsh-prompt-reforge/enhance`, plus
 * the single host row registered by `cordis.patch.yml`. It deliberately does
 * not touch model routing, providers or the default model.
 *
 * Why a browser→host route instead of a client-side LLM call: the browser half
 * has no LLM service, and the host already holds the credentials, the retry
 * policy and the per-model capability metadata. The route also keeps the
 * prompt templates off the wire.
 *
 * Dependency rule: no `@deepseek-ai/*` imports. Services are read at runtime
 * through `ctx.get(...)` / `ctx.inject([...])`.
 */

import { readJsonBody, loopbackRequest, sendFailure, sendJson } from './http.js'
import { EnhanceError, EMPTY_RESULT, failureOf, streamCompletion } from './llm.js'
import { SYSTEM_PROMPT, normalizeEnhancedText, renderUserPrompt } from './prompts.js'

export const name = 'prompt-reforge'

/** Route path. Also referenced by the browser half. */
export const REFORGE_PATH = '/plugins/dsh-prompt-reforge/enhance'

/** Longest draft we accept, in characters. */
export const MAX_INPUT_CHARS = 20000

/** Longest request body we accept, in bytes. */
export const MAX_BODY_BYTES = 256 * 1024

/** Completion budget for one rewrite. */
export const MAX_TOKENS = 2048

/** Wall-clock budget for one rewrite, in milliseconds. */
export const TIMEOUT_MS = 60000

/** Purpose tag handed to the LLM runtime, visible in its telemetry. */
export const PURPOSE = 'prompt-reforge'

/**
 * Cheap structural check before we spend a model call.
 *
 * @param {Record<string, unknown>} body
 * @returns {{ draft: string, provider: string, model: string, sessionId?: string }
 *   | { error: { status: number, code: string, message: string } }}
 */
export function readRequest(body) {
  const draft = typeof body.draft === 'string' ? body.draft : ''
  if (draft.trim() === '') {
    return {
      error: { status: 400, code: 'empty_draft', message: 'draft is empty' },
    }
  }
  if (draft.length > MAX_INPUT_CHARS) {
    return {
      error: {
        status: 413,
        code: 'draft_too_long',
        message: `draft is longer than ${MAX_INPUT_CHARS} characters`,
      },
    }
  }

  const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (provider === '' || model === '') {
    return {
      error: {
        status: 400,
        code: 'missing_route',
        message: 'provider and model are required',
      },
    }
  }

  const sessionId =
    typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined

  return {
    draft,
    provider,
    model,
    ...(sessionId === undefined ? {} : { sessionId }),
  }
}

/**
 * Build the request handler.
 *
 * @param {any} ctx a context that can `get('llm')`
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function reforgeHandler(ctx) {
  return async function handleReforge(req, res) {
    if (!loopbackRequest(req)) {
      sendFailure(res, 403, 'request_not_trusted', 'only a same-machine browser may call this route')
      return
    }
    if (req.method !== 'POST') {
      if (!res.destroyed && !res.writableEnded) res.setHeader('Allow', 'POST')
      sendFailure(res, 405, 'method_not_allowed', 'use POST')
      return
    }

    let body
    try {
      body = await readJsonBody(req, MAX_BODY_BYTES)
    } catch (error) {
      const code = error?.code === 'body_too_large' ? 'body_too_large' : 'invalid_body'
      sendFailure(res, code === 'body_too_large' ? 413 : 400, code, error.message)
      return
    }

    const request = readRequest(body)
    if ('error' in request) {
      sendFailure(res, request.error.status, request.error.code, request.error.message)
      return
    }

    const llm = ctx.get('llm')
    if (llm === undefined || llm === null) {
      sendFailure(res, 503, 'llm_unavailable', 'the host has no LLM service')
      return
    }

    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, TIMEOUT_MS)
    timer.unref?.()

    // The browser cancelling (new click, revert, tab close) must stop the model
    // call too, otherwise a superseded rewrite keeps burning tokens.
    const onClose = () => controller.abort()
    res.on('close', onClose)

    try {
      const { text } = await streamCompletion({
        llm,
        provider: request.provider,
        model: request.model,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: renderUserPrompt(request.draft) }],
          },
        ],
        maxTokens: MAX_TOKENS,
        signal: controller.signal,
        sessionId: request.sessionId,
        purpose: PURPOSE,
      })

      const normalized = normalizeEnhancedText(text)
      if (normalized === '') {
        sendFailure(res, 502, EMPTY_RESULT, 'the model returned no usable text')
        return
      }

      sendJson(res, 200, { ok: true, text: normalized })
    } catch (error) {
      if (controller.signal.aborted && !timedOut) {
        // Cancelled by the client: nobody is listening, but keep the shape.
        sendFailure(res, 499, 'aborted', 'the request was cancelled')
        return
      }
      const failure = failureOf(error, controller.signal, timedOut)
      ctx.logger?.warn?.('dsh-prompt-reforge: %s', failure.message)
      sendFailure(res, failure.status, failure.code, failure.message)
    } finally {
      clearTimeout(timer)
      res.off('close', onClose)
    }
  }
}

/**
 * Mount the route. `webServer` is optional so a headless composition can still
 * load the plugin (the browser half simply never renders).
 *
 * @param {any} ctx
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (scope) => {
    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'exact',
          path: REFORGE_PATH,
          handler: reforgeHandler(scope),
        }),
      `dsh-prompt-reforge: POST ${REFORGE_PATH}`,
    )
  })
}

export { EnhanceError }
