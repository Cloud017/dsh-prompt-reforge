import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/**
 * Minimal React stand-in: enough of the hook set for one component, driven by
 * an explicit render/replay loop. No DOM, no scheduler — the point is to
 * exercise the control's state machine and its HTTP contract.
 */
function createHarness() {
  const hookState = []
  const effectSlots = new Map()
  const memoSlots = new Map()
  let cursor = 0
  let effects = []
  let pendingReplay = false

  /** Mirrors React's dependency comparison closely enough for tests. */
  function depsChanged(before, after) {
    if (before === undefined || after === undefined) return true
    if (before.length !== after.length) return true
    return before.some((value, index) => !Object.is(value, after[index]))
  }

  const react = {
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: children.length === 0 ? undefined : children } }
    },
    useState(initial) {
      const slot = cursor++
      if (!(slot in hookState)) hookState[slot] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        const value = typeof next === 'function' ? next(hookState[slot]) : next
        if (Object.is(value, hookState[slot])) return
        hookState[slot] = value
        pendingReplay = true
      }
      return [hookState[slot], set]
    },
    useRef(initial) {
      const slot = cursor++
      if (!(slot in hookState)) hookState[slot] = { current: initial }
      return hookState[slot]
    },
    useCallback(fn, deps) {
      const slot = cursor++
      const previous = memoSlots.get(slot)
      // Identity stability is the whole point of useCallback: effects that
      // depend on the callback must not re-fire on every render.
      if (previous !== undefined && !depsChanged(previous.deps, deps)) return previous.value
      memoSlots.set(slot, { deps, value: fn })
      return fn
    },
    useMemo(fn, deps) {
      const slot = cursor++
      const previous = memoSlots.get(slot)
      if (previous !== undefined && !depsChanged(previous.deps, deps)) return previous.value
      const value = fn()
      memoSlots.set(slot, { deps, value })
      return value
    },
    useEffect(fn, deps) {
      const slot = cursor++
      const previous = effectSlots.get(slot)
      if (previous !== undefined && !depsChanged(previous, deps)) return
      effectSlots.set(slot, deps)
      effects.push(fn)
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      cursor++
      // Re-subscribing on every render would loop; the fake store is static
      // between renders so a no-op subscription is enough here.
      void subscribe
      return getSnapshot()
    },
  }

  return {
    react,
    reset() {
      cursor = 0
      effects = []
      pendingReplay = false
    },
    runEffects() {
      const queued = effects
      effects = []
      for (const fn of queued) fn()
      const replay = pendingReplay
      pendingReplay = false
      return replay
    },
    /** Start a fresh mount: hook slots and the effect memo both reset. */
    remount() {
      hookState.length = 0
      effectSlots.clear()
      this.reset()
    },
  }
}

/** Load the browser bundle and return its exports. */
function loadBundle() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let captured
  const window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        captured = { id, factory }
      },
    },
  }
  // eslint-disable-next-line no-new-func
  new Function('window', source)(window)
  return captured
}

const harness = createHarness()
const bundle = loadBundle()
const reactModule = harness.react
const moduleExports = bundle.factory((specifier) => {
  if (specifier === 'react') return reactModule
  throw new Error(`unexpected require(${specifier})`)
})

/** A store the test can push values into. */
function createStore(initial) {
  let value = initial
  const listeners = new Set()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot() {
      return value
    },
    emit(next) {
      value = next
      for (const listener of listeners) listener()
    },
  }
}

/**
 * Build the fake plugin context, run `apply`, and expose the registration.
 */
function mountPlugin({
  language = 'en',
  route = { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
  status,
  sessionId = 'session-1',
} = {}) {
  const dictionaries = { en: {}, zh: {} }
  const registrations = []
  const slotsInjected = []
  const directory = {
    loads: 0,
    store: createStore({ current: route, status: status ?? (route === null ? 'loading' : 'ready') }),
    load() {
      this.loads += 1
      return Promise.resolve(route === null ? { current: null } : { current: route })
    },
  }

  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register(namespace, dicts) {
        for (const [key, value] of Object.entries(dicts)) dictionaries[key] = value
        return () => {}
      },
      bind(namespace) {
        return (key, params) => {
          const dict = dictionaries[language] ?? {}
          const text = dict[key] ?? key
          if (params === undefined) return text
          return text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
        }
      },
    },
    inject(deps, run) {
      assert.deepEqual(deps, ['modelDirectories'], 'only modelDirectories is injected late')
      run({
        modelDirectories: {
          directoryFor(id) {
            assert.equal(id, sessionId)
            return directory
          },
        },
        slots: ctx.slots,
      })
    },
    slots: {
      inject(name, run) {
        slotsInjected.push(name)
        run()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }

  moduleExports.apply(ctx)

  assert.equal(registrations.length, 1)
  return { registration: registrations[0], slotsInjected, directory }
}

/**
 * Mount the control and drive it through re-renders the way React would.
 *
 * `update()` keeps hook state, refs and the external-store subscription alive,
 * so a ref written during one render is still readable in the next — the
 * control relies on exactly that to notice edits that land while a request is
 * in flight.
 *
 * @param {Function} component
 * @param {object} props
 * @param {string} draft
 * @param {Array<object>} occurrences
 */
function mount(component, props, draft, occurrences = []) {
  const settled = { ...props, inputActions: props.inputActions ?? { setDraft() {} } }
  let current = { draft, occurrences }
  let element

  const paint = () => {
    // Effects run after the render that scheduled them, so a state change
    // written from an effect becomes visible on the following pass.
    for (let pass = 0; pass < 2; pass += 1) {
      harness.reset()
      element = component({
        ...settled,
        useInput: (selector) =>
          selector({ draft: current.draft, draftRev: 3, occurrences: current.occurrences }),
      })
      harness.runEffects()
    }
    return element
  }

  harness.remount()
  paint()

  return {
    get element() {
      return element
    },
    /** Re-render with new composer content, keeping component state alive. */
    update(nextDraft, nextOccurrences = current.occurrences) {
      current = { draft: nextDraft, occurrences: nextOccurrences }
      return paint()
    },
  }
}

/** Convenience wrapper for assertions that only need the first paint. */
function render(component, props, draft, occurrences = []) {
  return { element: mount(component, props, draft, occurrences).element }
}

test('bundle exports the plugin shape', () => {
  assert.equal(bundle.id, 'dsh-prompt-reforge')
  assert.equal(moduleExports.name, 'prompt-reforge')
  assert.deepEqual(moduleExports.inject, ['slots', 'locale', 'sessions', 'remote', 'remote.session'])
  assert.equal(typeof moduleExports.apply, 'function')
})

test('the control registers in the composer toolbar left of the model seat', () => {
  const { registration, slotsInjected, directory } = mountPlugin()
  assert.deepEqual(slotsInjected, ['conversation.input.right'])
  assert.equal(registration.options.name, 'conversation.input.right')
  assert.equal(registration.options.id, 'prompt-reforge')
  assert.equal(registration.options.order, 5)
  assert.equal(registration.options.locale, 'prompt-reforge')
  assert.equal(typeof registration.component, 'function')

  const injected = registration.options.inject('session-1')
  assert.equal(injected.sessionId, 'session-1')
  assert.equal(injected.directory, directory)
  assert.equal(typeof injected.t, 'function')
})

test('the slot injection returns session props and tolerates a missing directory', () => {
  const { registration } = mountPlugin()
  const ctxWithoutDirectories = {
    modelDirectories: {
      directoryFor() {
        throw new Error('ui-model-selection: session "x" resolved no scope')
      },
    },
  }
  assert.equal(typeof registration.options.inject.call(ctxWithoutDirectories, 'session-1'), 'object')
  // The real path: a directory is returned.
  assert.ok(registration.options.inject('session-1').directory)
})

test('an empty draft leaves the button inert and explains why', () => {
  const { registration } = mountPlugin()
  const props = registration.options.inject('session-1')
  const { element } = render(registration.component, props, '')

  assert.equal(element.type, 'button')
  assert.equal(element.props.disabled, true)
  assert.equal(element.props['data-phase'], 'idle')
  assert.equal(element.props.title, 'Write something first, then reforge it.')
})

test('a draft with a route arms the button', () => {
  const { registration } = mountPlugin()
  const props = registration.options.inject('session-1')
  const { element } = render(registration.component, props, '帮我写个函数')

  assert.equal(element.props.disabled, false)
  assert.equal(element.props.title, 'Reforge this draft into a sharper prompt')
})

test('a missing route disables the button with a routing hint', () => {
  const { registration } = mountPlugin({ route: null })
  const props = registration.options.inject('session-1')
  const { element } = render(registration.component, props, '帮我写个函数')

  assert.equal(element.props.disabled, true)
  assert.equal(element.props.title, 'Pick a model first, then reforge.')
})

test('the directory is loaded once on mount', () => {
  const { registration, directory } = mountPlugin()
  const props = registration.options.inject('session-1')
  render(registration.component, props, 'draft')
  assert.equal(directory.loads, 1)
})

test('reference chips block the rewrite', () => {
  const { registration } = mountPlugin()
  const props = registration.options.inject('session-1')

  const { element } = render(registration.component, props, 'x', [{}])
  assert.equal(element.props.disabled, true)
  assert.equal(element.props.title, 'Remove reference chips before reforging.')
})

test('clicking rewrites the draft, then restores it', async () => {
  const original = globalThis.fetch
  const calls = []
  let release
  globalThis.fetch = (url, init) => {
    calls.push({ url, init })
    return new Promise((resolve) => {
      release = () =>
        resolve({ status: 200, json: async () => ({ ok: true, text: 'sharpened prompt' }) })
    })
  }

  try {
    const { registration } = mountPlugin()
    const props = registration.options.inject('session-1')
    const drafts = []
    const inputActions = { setDraft: (text) => drafts.push(text) }

    const { element } = render(registration.component, { ...props, inputActions }, 'rough draft')
    assert.equal(element.props.disabled, false)

    element.props.onClick()

    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, '/plugins/dsh-prompt-reforge/enhance')
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(calls[0].init.credentials, 'same-origin')
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      draft: 'rough draft',
      provider: 'workbuddy',
      model: 'deepseek-v4.1-flash',
      sessionId: 'session-1',
    })

    release()
    await new Promise((resolve) => setImmediate(resolve))

    assert.deepEqual(drafts, ['sharpened prompt'])

    // Second render picks up the enhanced state: the same button now reverts.
    const after = render(registration.component, { ...props, inputActions }, 'sharpened prompt')
    assert.equal(after.element.props['data-phase'], 'enhanced')
    assert.equal(after.element.props.title, 'Restore the original draft')
    assert.equal(after.element.props['aria-pressed'], 'true')

    after.element.props.onClick()
    assert.deepEqual(drafts, ['sharpened prompt', 'rough draft'])

    const reverted = render(registration.component, { ...props, inputActions }, 'rough draft')
    assert.equal(reverted.element.props['data-phase'], 'idle')
  } finally {
    globalThis.fetch = original
  }
})

test('a failed rewrite keeps the draft and surfaces the reason', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    status: 502,
    json: async () => ({ ok: false, error: { code: 'RATE_LIMITED', message: 'quota exhausted' } }),
  })

  try {
    const { registration } = mountPlugin()
    const props = registration.options.inject('session-1')
    const drafts = []
    const { element } = render(
      registration.component,
      { ...props, inputActions: { setDraft: (text) => drafts.push(text) } },
      'rough draft',
    )

    element.props.onClick()
    await new Promise((resolve) => setImmediate(resolve))

    assert.deepEqual(drafts, [], 'the draft is left alone')

    const after = render(
      registration.component,
      { ...props, inputActions: { setDraft: (text) => drafts.push(text) } },
      'rough draft',
    )
    assert.equal(after.element.props['data-phase'], 'failed')
    assert.equal(after.element.props.title, 'Reforging failed: quota exhausted')
  } finally {
    globalThis.fetch = original
  }
})

test('an unreachable route is reported as a failure, not a crash', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch')
  }

  try {
    const { registration } = mountPlugin()
    const props = registration.options.inject('session-1')
    const { element } = render(registration.component, { ...props, inputActions: { setDraft() {} } }, 'draft')

    element.props.onClick()
    await new Promise((resolve) => setImmediate(resolve))

    const after = render(registration.component, { ...props, inputActions: { setDraft() {} } }, 'draft')
    assert.equal(after.element.props['data-phase'], 'failed')
    assert.match(after.element.props.title, /unreachable/)
  } finally {
    globalThis.fetch = original
  }
})

test('clicking while enhancing cancels instead of starting a second call', async () => {
  const original = globalThis.fetch
  let capturedSignal
  globalThis.fetch = (url, init) => {
    capturedSignal = init.signal
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
      void resolve
    })
  }

  try {
    const { registration } = mountPlugin()
    const props = registration.options.inject('session-1')
    const inputActions = { setDraft() {} }

    const { element } = render(registration.component, { ...props, inputActions }, 'draft')
    element.props.onClick()
    await new Promise((resolve) => setImmediate(resolve))

    const busy = render(registration.component, { ...props, inputActions }, 'draft')
    assert.equal(busy.element.props['data-phase'], 'enhancing')
    assert.equal(busy.element.props['aria-busy'], 'true')
    // Cancelling has to stay possible: `disabled` would swallow the click.
    assert.equal(busy.element.props.disabled, false)

    busy.element.props.onClick()
    assert.equal(capturedSignal.aborted, true)

    await new Promise((resolve) => setImmediate(resolve))
    const idle = render(registration.component, { ...props, inputActions }, 'draft')
    assert.equal(idle.element.props['data-phase'], 'idle')
  } finally {
    globalThis.fetch = original
  }
})

test('editing an enhanced draft drops the revert backup', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    status: 200,
    json: async () => ({ ok: true, text: 'sharpened prompt' }),
  })

  try {
    const { registration } = mountPlugin()
    const props = registration.options.inject('session-1')
    const inputActions = { setDraft() {} }

    const { element } = render(registration.component, { ...props, inputActions }, 'rough draft')
    element.props.onClick()
    await new Promise((resolve) => setImmediate(resolve))

    const enhanced = render(registration.component, { ...props, inputActions }, 'sharpened prompt')
    assert.equal(enhanced.element.props['data-phase'], 'enhanced')

    // The author keeps typing: the backup no longer matches the editor.
    const edited = render(registration.component, { ...props, inputActions }, 'sharpened prompt, and also tests')
    assert.equal(edited.element.props['data-phase'], 'idle')
  } finally {
    globalThis.fetch = original
  }
})

test('a whole-draft rewrite goes through one insertText edit, not setDraft', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    status: 200,
    json: async () => ({ ok: true, text: 'sharpened prompt' }),
  })

  try {
    const { registration } = mountPlugin({ sessionId: 'session-insert' })
    const props = registration.options.inject('session-insert')
    const inserts = []
    const drafts = []
    const inputActions = {
      insertText(text, span) {
        inserts.push({ text, span })
        return true
      },
      setDraft(text) {
        drafts.push(text)
      },
    }

    const control = mount(registration.component, { ...props, inputActions }, 'rough draft')
    control.element.props.onClick()
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(inserts.length, 1, 'the editor API is preferred when it exists')
    assert.equal(inserts[0].text, 'sharpened prompt')
    // Replacing the whole draft keeps the caret and undo history coherent, so
    // the span has to cover every character and carry the live revision.
    assert.deepEqual(inserts[0].span, { start: 0, end: 'rough draft'.length, draftRev: 3 })
    assert.deepEqual(drafts, [], 'setDraft is only a fallback')
  } finally {
    globalThis.fetch = original
  }
})

test('a refused insertText is final: setDraft never runs over it', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    status: 200,
    json: async () => ({ ok: true, text: 'sharpened prompt' }),
  })

  try {
    const { registration } = mountPlugin({ sessionId: 'session-refuse' })
    const props = registration.options.inject('session-refuse')
    const drafts = []
    const inputActions = {
      // The real editor answers false when the revision moved, the message was
      // sent, or the composer is gone — never when it is safe to force a write.
      insertText: () => false,
      setDraft: (text) => drafts.push(text),
    }

    const control = mount(registration.component, { ...props, inputActions }, 'rough draft')
    control.element.props.onClick()
    await new Promise((resolve) => setImmediate(resolve))

    assert.deepEqual(drafts, [], 'a refused edit must not be replaced by a forced one')
    assert.equal(
      control.update('rough draft').props['data-phase'],
      'idle',
      'no revert is offered for a write that never happened',
    )
  } finally {
    globalThis.fetch = original
  }
})

test('compositions without the editor API still write through setDraft', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    status: 200,
    json: async () => ({ ok: true, text: 'sharpened prompt' }),
  })

  try {
    const { registration } = mountPlugin({ sessionId: 'session-legacy' })
    const props = registration.options.inject('session-legacy')
    const drafts = []

    const control = mount(
      registration.component,
      { ...props, inputActions: { setDraft: (text) => drafts.push(text) } },
      'rough draft',
    )
    control.element.props.onClick()
    await new Promise((resolve) => setImmediate(resolve))

    assert.deepEqual(drafts, ['sharpened prompt'])
    assert.equal(control.update('sharpened prompt').props['data-phase'], 'enhanced')
  } finally {
    globalThis.fetch = original
  }
})

test('editing while the rewrite is in flight drops the result and says so', async () => {
  const original = globalThis.fetch
  let release
  globalThis.fetch = () =>
    new Promise((resolve) => {
      release = () =>
        resolve({ status: 200, json: async () => ({ ok: true, text: 'sharpened prompt' }) })
    })

  try {
    const { registration } = mountPlugin({ sessionId: 'session-race' })
    const props = registration.options.inject('session-race')
    const drafts = []
    const inputActions = { setDraft: (text) => drafts.push(text) }

    const control = mount(registration.component, { ...props, inputActions }, 'rough draft')
    control.element.props.onClick()

    // The author keeps typing before the model answers.
    assert.equal(control.update('rough draft, now longer').props['data-phase'], 'enhancing')

    release()
    await new Promise((resolve) => setImmediate(resolve))

    assert.deepEqual(drafts, [], 'the newer text is never overwritten')

    const dropped = control.update('rough draft, now longer')
    assert.equal(dropped.props['data-phase'], 'stale')
    assert.match(dropped.props.title, /edited the draft while it was being reforged/)
  } finally {
    globalThis.fetch = original
  }
})

test('a dropped result clears once the author edits again', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    status: 200,
    json: async () => ({ ok: true, text: 'sharpened prompt' }),
  })

  try {
    const { registration } = mountPlugin({ sessionId: 'session-dropped' })
    const props = registration.options.inject('session-dropped')
    const inputActions = { setDraft() {} }

    const control = mount(registration.component, { ...props, inputActions }, 'rough draft')
    control.element.props.onClick()
    // Editing before the answer arrives is what produces the drop notice.
    control.update('rough draft v2')
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(control.update('rough draft v2').props['data-phase'], 'stale')
    assert.equal(control.update('rough draft v3').props['data-phase'], 'idle')
  } finally {
    globalThis.fetch = original
  }
})

test('a failed catalog load keeps the button clickable and retries it', () => {
  const { registration, directory } = mountPlugin({
    sessionId: 'session-broken',
    route: null,
    status: 'error',
  })
  const props = registration.options.inject('session-broken')

  const { element } = render(registration.component, props, 'draft')
  // A broken catalog is recoverable, so it must not look like "no model picked".
  assert.equal(element.props.disabled, false)
  assert.equal(element.props['aria-disabled'], undefined)
  assert.equal(element.props.title, 'The model list failed to load. Click to retry.')

  // The mount already asked once; the click asks again rather than rewriting.
  assert.equal(directory.loads, 1)
  element.props.onClick()
  assert.equal(directory.loads, 2, 'the click retries the catalog load')
})

test('copy is registered for both locales', () => {
  const { registration } = mountPlugin({ language: 'zh' })
  const props = registration.options.inject('session-1')
  const { element } = render(registration.component, props, '')

  assert.equal(element.props.title, '先在输入框里写点内容，再来重铸。')
})

test('the whole plugin survives a broken locale registration', () => {
  const ctx = {
    effect(fn) {
      return fn() ?? (() => {})
    },
    locale: {
      register() {
        throw new Error('locale namespace already has locale "en"')
      },
      bind: () => (key) => key,
    },
    inject() {
      throw new Error('unreachable')
    },
    slots: {},
  }

  const errors = []
  const originalError = console.error
  console.error = (...args) => errors.push(args)
  try {
    assert.doesNotThrow(() => moduleExports.apply(ctx))
  } finally {
    console.error = originalError
  }

  // Both guarded contributions report through the console and neither throws:
  // a broken seam degrades the feature instead of failing the whole client.
  assert.equal(errors.length, 2)
  for (const entry of errors) assert.match(String(entry[0]), /\[dsh-prompt-reforge\]/)
})
