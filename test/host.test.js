import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import {
  MAX_INPUT_CHARS,
  PURPOSE,
  REFORGE_PATH,
  readRequest,
  reforgeHandler,
} from '../lib/index.js'
import { SYSTEM_PROMPT } from '../lib/prompts.js'

/**
 * Start the route on an ephemeral port with a stubbed LLM service.
 *
 * @param {object} [options]
 * @param {(request: any) => AsyncIterable<any>} [options.stream]
 * @param {any} [options.llm] override the whole service
 */
async function startRoute(options = {}) {
  const seen = { requests: [], signals: [] }

  const llm =
    'llm' in options
      ? options.llm
      : {
          stream(request) {
            seen.requests.push(request)
            seen.signals.push(request.signal)
            return options.stream === undefined ? happyStream() : options.stream(request)
          },
        }

  const warnings = []
  const ctx = {
    get: (service) => (service === 'llm' ? llm : undefined),
    logger: { warn: (...args) => warnings.push(args) },
  }

  const server = createServer(reforgeHandler(ctx))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  return {
    seen,
    warnings,
    url: `http://127.0.0.1:${port}${REFORGE_PATH}`,
    post: (body, init = {}) =>
      fetch(`http://127.0.0.1:${port}${REFORGE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
        ...init,
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function* happyStream() {
  yield { type: 'text-delta', index: 0, text: '"请说明' }
  yield { type: 'text-delta', index: 0, text: '目标格式。"' }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

const VALID = { draft: '帮我写个函数', provider: 'workbuddy', model: 'deepseek-v4.1-flash' }

test('readRequest accepts a well-formed body', () => {
  const parsed = readRequest({ ...VALID, sessionId: 's1' })
  assert.deepEqual(parsed, { draft: VALID.draft, provider: VALID.provider, model: VALID.model, sessionId: 's1' })
})

test('readRequest drops an empty sessionId', () => {
  const parsed = readRequest({ ...VALID, sessionId: '' })
  assert.equal('sessionId' in parsed, false)
})

test('readRequest rejects an empty draft', () => {
  const parsed = readRequest({ ...VALID, draft: '   ' })
  assert.equal(parsed.error.code, 'empty_draft')
  assert.equal(parsed.error.status, 400)
})

test('readRequest rejects an over-long draft', () => {
  const parsed = readRequest({ ...VALID, draft: 'x'.repeat(MAX_INPUT_CHARS + 1) })
  assert.equal(parsed.error.code, 'draft_too_long')
  assert.equal(parsed.error.status, 413)
})

test('readRequest rejects a missing route', () => {
  assert.equal(readRequest({ draft: 'hi' }).error.code, 'missing_route')
  assert.equal(readRequest({ draft: 'hi', provider: 'x' }).error.code, 'missing_route')
})

test('POST returns the normalized rewrite', async () => {
  const route = await startRoute()
  try {
    const response = await route.post({ ...VALID, sessionId: 'session-1' })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, text: '请说明目标格式。' })

    const [request] = route.seen.requests
    // The route must forward the caller's route to the LLM runtime: without
    // these two the adapter lookup fails with NO_ADAPTER at runtime.
    assert.equal(request.provider, VALID.provider)
    assert.equal(request.model, VALID.model)
    assert.equal(request.system, SYSTEM_PROMPT)
    assert.equal(request.purpose, PURPOSE)
    assert.equal(request.sessionId, 'session-1')
    assert.equal(request.messages.length, 1)
    assert.equal(request.messages[0].role, 'user')
    assert.ok(request.messages[0].content[0].text.includes(VALID.draft))
  } finally {
    await route.close()
  }
})

test('POST omits sessionId from the LLM request when absent', async () => {
  const route = await startRoute()
  try {
    await route.post(VALID)
    assert.equal('sessionId' in route.seen.requests[0], false)
  } finally {
    await route.close()
  }
})

test('a terminal error becomes a 502 with the upstream code', async () => {
  const route = await startRoute({
    stream: async function* () {
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'RATE_LIMITED', message: 'quota exhausted' } },
      }
    },
  })
  try {
    const response = await route.post(VALID)
    assert.equal(response.status, 502)
    const payload = await response.json()
    assert.equal(payload.error.code, 'RATE_LIMITED')
    assert.equal(payload.error.message, 'quota exhausted')
    assert.equal(route.warnings.length, 1)
  } finally {
    await route.close()
  }
})

test('a truncated completion still returns 200', async () => {
  const route = await startRoute({
    stream: async function* () {
      yield { type: 'text-delta', index: 0, text: 'partial answer' }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    },
  })
  try {
    const response = await route.post(VALID)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).text, 'partial answer')
  } finally {
    await route.close()
  }
})

test('an empty completion becomes 502 empty_result', async () => {
  const route = await startRoute({
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  try {
    const response = await route.post(VALID)
    assert.equal(response.status, 502)
    assert.equal((await response.json()).error.code, 'empty_result')
  } finally {
    await route.close()
  }
})

test('unknown chunk types are ignored', async () => {
  const route = await startRoute({
    stream: async function* () {
      yield { type: 'reasoning-delta', index: 0, text: 'thinking…' }
      yield { type: 'text-delta', index: 1, text: 'answer' }
      yield null
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  try {
    assert.equal((await (await route.post(VALID)).json()).text, 'answer')
  } finally {
    await route.close()
  }
})

test('GET is rejected with 405 and an Allow header', async () => {
  const route = await startRoute()
  try {
    const response = await fetch(route.url)
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), 'POST')
    assert.equal((await response.json()).error.code, 'method_not_allowed')
  } finally {
    await route.close()
  }
})

test('a non-JSON body is rejected with 400', async () => {
  const route = await startRoute()
  try {
    const response = await route.post('not json')
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, 'invalid_body')
  } finally {
    await route.close()
  }
})

test('a JSON array body is rejected with 400', async () => {
  const route = await startRoute()
  try {
    const response = await route.post('[1,2]')
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, 'invalid_body')
  } finally {
    await route.close()
  }
})

test('an empty body reports the field-level error, not a parse error', async () => {
  const route = await startRoute()
  try {
    const response = await route.post('')
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, 'empty_draft')
  } finally {
    await route.close()
  }
})

test('an over-long draft is rejected with 413', async () => {
  const route = await startRoute()
  try {
    const response = await route.post({ ...VALID, draft: 'x'.repeat(MAX_INPUT_CHARS + 1) })
    assert.equal(response.status, 413)
    assert.equal((await response.json()).error.code, 'draft_too_long')
  } finally {
    await route.close()
  }
})

test('a missing LLM service is reported as 503', async () => {
  const route = await startRoute({ llm: null })
  try {
    const response = await route.post(VALID)
    assert.equal(response.status, 503)
    assert.equal((await response.json()).error.code, 'llm_unavailable')
  } finally {
    await route.close()
  }
})

test('a client disconnect aborts the in-flight model call', async () => {
  const route = await startRoute({
    stream: async function* (request) {
      await new Promise((resolve) => setTimeout(resolve, 5000))
      yield { type: 'finish', reason: { kind: 'stop' } }
      void request
    },
  })

  try {
    const controller = new AbortController()
    const pending = route.post(VALID, { signal: controller.signal }).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 250))

    assert.equal(route.seen.signals.length, 1)
    assert.equal(route.seen.signals[0].aborted, false)

    controller.abort()
    await pending
    await new Promise((resolve) => setTimeout(resolve, 250))

    assert.equal(route.seen.signals[0].aborted, true)
  } finally {
    await route.close()
  }
})
