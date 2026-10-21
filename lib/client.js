/**
 * dsh-prompt-reforge — browser half.
 *
 * One control in the composer toolbar: click to rewrite the draft, click again
 * to put the original back. The rewrite itself happens on the host
 * (`POST /plugins/dsh-prompt-reforge/enhance`), so this file only owns the
 * button, its four states and the draft read/write.
 *
 * State lives at module scope, keyed by session id, so it survives the slot
 * being torn down and rebuilt (session switch, layout change). A request that
 * is already in flight is *not* cancelled on unmount — it lands in the map and
 * the remounted control picks it up.
 */
window.__ModuleLoader__.load({
  id: 'dsh-prompt-reforge',
  factory: (require) => {
    const module = { exports: {} }
    const react = require('react')
    const h = react.createElement

    /** Host route. Must match `REFORGE_PATH` in lib/index.js. */
    const REFORGE_PATH = '/plugins/dsh-prompt-reforge/enhance'

    /** Locale namespace; also the key `slots.register({ locale })` resolves. */
    const NAMESPACE = 'prompt-reforge'

    /** Mirrors `MAX_INPUT_CHARS` in lib/index.js. Keep the two in step. */
    const MAX_DRAFT_CHARS = 20000

    const ICON_SIZE = 16

    //#region copy

    // Copy for the control itself. The plugin-list title and description live in
    // `locale/*.json`, which is the only place the harness reads them from.
    const en = {
      title: 'Reforge this draft into a sharper prompt',
      enhancing: 'Reforging… (click to stop)',
      revert: 'Restore the original draft',
      empty: 'Write something first, then reforge it.',
      noModel: 'Pick a model first, then reforge.',
      routeError: 'The model list failed to load. Click to retry.',
      tooLong: 'This draft is too long to reforge.',
      withChips: 'Remove reference chips before reforging.',
      failed: 'Reforging failed: {message}',
      stale: 'You edited the draft while it was being reforged, so the result was dropped.',
    }

    const zh = {
      title: '把这个草稿重铸成更精准的提示词',
      enhancing: '重铸中…（点击停止）',
      revert: '恢复原文',
      empty: '先在输入框里写点内容，再来重铸。',
      noModel: '先选一个模型，再重铸。',
      routeError: '模型列表加载失败，点击重试。',
      tooLong: '这段草稿太长，无法重铸。',
      withChips: '含引用片段时无法重铸，请先移除。',
      failed: '重铸失败：{message}',
      stale: '重铸期间你改了草稿，为避免覆盖，这次结果已被丢弃。',
    }

    //#endregion

    /**
     * Run a contribution and never let it take the whole plugin down: a broken
     * seam must degrade to "control absent", not to a load error banner.
     *
     * @param {string} label
     * @param {() => any} run
     * @returns {any}
     */
    function guarded(label, run) {
      try {
        return run()
      } catch (error) {
        console.error(`[dsh-prompt-reforge] ${label} failed:`, error)
        return () => {}
      }
    }

    //#region state store

    /** @typedef {{ phase: 'idle' }} IdleState */
    /** @typedef {{ phase: 'enhancing', controller: AbortController, sent: string }} EnhancingState */
    /** @typedef {{ phase: 'enhanced', backup: string, applied: string }} EnhancedState */
    /** @typedef {{ phase: 'failed', message: string }} FailedState */
    /** @typedef {{ phase: 'stale', kept: string }} StaleState */

    const IDLE = Object.freeze({ phase: 'idle' })

    /** @type {Map<string, IdleState | EnhancingState | EnhancedState | FailedState>} */
    const states = new Map()
    /** @type {Set<() => void>} */
    const listeners = new Set()

    /** @param {string} sessionId */
    function stateOf(sessionId) {
      return states.get(sessionId) ?? IDLE
    }

    function notify() {
      for (const listener of listeners) {
        try {
          listener()
        } catch (error) {
          console.error('[dsh-prompt-reforge] subscriber failed:', error)
        }
      }
    }

    /**
     * @param {string} sessionId
     * @param {IdleState | EnhancingState | EnhancedState | FailedState} next
     */
    function writeState(sessionId, next) {
      const current = states.get(sessionId)
      if (next.phase === 'idle') {
        if (current === undefined) return
        states.delete(sessionId)
      } else {
        if (current === next) return
        states.set(sessionId, next)
      }
      notify()
    }

    /** @param {() => void} listener */
    function subscribeStates(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }

    /** Cancel every in-flight rewrite. Called when the plugin is disposed. */
    function abortAll() {
      for (const [sessionId, state] of states) {
        if (state.phase !== 'enhancing') continue
        state.controller.abort()
        states.delete(sessionId)
      }
      notify()
    }

    //#endregion

    //#region transport

    /**
     * Ask the host for a rewrite.
     *
     * @param {object} options
     * @param {string} options.draft
     * @param {string} options.provider
     * @param {string} options.model
     * @param {string} options.sessionId
     * @param {AbortSignal} options.signal
     * @returns {Promise<string>}
     */
    async function requestReforge(options) {
      const { draft, provider, model, sessionId, signal } = options

      let response
      try {
        response = await fetch(REFORGE_PATH, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ draft, provider, model, sessionId }),
          signal,
        })
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error
        const wrapped = new Error('the reforge route is unreachable')
        wrapped.code = 'unreachable'
        throw wrapped
      }

      let payload
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }

      if (payload?.ok === true && typeof payload.text === 'string' && payload.text !== '') {
        return payload.text
      }

      const failure = payload?.error
      const error = new Error(
        typeof failure?.message === 'string' && failure.message !== ''
          ? failure.message
          : `the reforge route answered ${response.status}`,
      )
      error.code = typeof failure?.code === 'string' ? failure.code : `http_${response.status}`
      error.status = response.status
      throw error
    }

    //#endregion

    //#region icons

    const ICON_PROPS = {
      width: ICON_SIZE,
      height: ICON_SIZE,
      viewBox: '0 0 16 16',
      'aria-hidden': 'true',
      focusable: 'false',
    }

    function ReforgeIcon() {
      return h(
        'svg',
        { ...ICON_PROPS, fill: 'currentColor' },
        h('path', {
          key: 'spark',
          d: 'M8.6 1.4a.55.55 0 0 0-1.05 0l-.72 2.2a3.2 3.2 0 0 1-2.03 2.03l-2.2.72a.55.55 0 0 0 0 1.05l2.2.72a3.2 3.2 0 0 1 2.03 2.03l.72 2.2a.55.55 0 0 0 1.05 0l.72-2.2a3.2 3.2 0 0 1 2.03-2.03l2.2-.72a.55.55 0 0 0 0-1.05l-2.2-.72A3.2 3.2 0 0 1 9.32 3.6z',
        }),
        h('path', {
          key: 'tail',
          opacity: '0.65',
          d: 'M4.1 11.1a.45.45 0 0 0-.63 0l-.62.62a.45.45 0 0 0 0 .63l.62.62a.45.45 0 0 0 .63 0l.62-.62a.45.45 0 0 0 0-.63z',
        }),
      )
    }

    function RevertIcon() {
      return h(
        'svg',
        {
          ...ICON_PROPS,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '1.5',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        h('path', { key: 'arc', d: 'M3.2 7.6a4.9 4.9 0 1 1 1.5 3.9' }),
        h('path', { key: 'head', d: 'M3 4.3v3.4h3.4' }),
      )
    }

    function BusyIcon() {
      return h(
        'svg',
        { ...ICON_PROPS, fill: 'none', stroke: 'currentColor', strokeWidth: '1.6' },
        h('circle', { key: 'track', cx: '8', cy: '8', r: '5.6', opacity: '0.25' }),
        h(
          'path',
          { key: 'arc', d: 'M8 2.4a5.6 5.6 0 0 1 5.6 5.6', strokeLinecap: 'round' },
          h('animateTransform', {
            key: 'spin',
            attributeName: 'transform',
            type: 'rotate',
            from: '0 8 8',
            to: '360 8 8',
            dur: '0.85s',
            repeatCount: 'indefinite',
          }),
        ),
      )
    }

    //#endregion

    //#region draft write

    /**
     * Put `text` into the composer, replacing the whole draft.
     *
     * `insertText` replaces a span as one undo step and keeps the editor's own
     * history intact, which is what rewriting a whole draft wants. When it is
     * present its answer is final: a `false` means the editor refused because
     * the revision moved, the message was already sent, or the composer is
     * gone — and blasting `setDraft` over all three would overwrite text the
     * author just typed. `setDraft` is only the fallback for compositions that
     * do not expose the editor API at all.
     *
     * @param {any} inputActions
     * @param {string} text
     * @param {{ draft: string, rev: unknown }} current
     * @returns {boolean} whether the text reached the composer
     */
    function writeDraft(inputActions, text, current) {
      if (typeof inputActions?.insertText === 'function') {
        const span = { start: 0, end: current.draft.length, draftRev: current.rev }
        try {
          return inputActions.insertText(text, span) === true
        } catch (error) {
          console.error('[dsh-prompt-reforge] insertText threw:', error)
          return false
        }
      }
      if (typeof inputActions?.setDraft === 'function') {
        inputActions.setDraft(text)
        return true
      }
      return false
    }

    //#endregion

    /**
     * The composer control.
     *
     * @param {object} props
     * @param {string} props.sessionId
     * @param {any} [props.directory] model directory controller for this session
     * @param {(key: string, params?: Record<string, string>) => string} props.t
     * @param {any} props.useInput   standard hook: (selector) => snapshot slice
     * @param {any} props.inputActions composer actions, including `setDraft`
     */
    function ReforgeControl(props) {
      const { sessionId, directory, t, useInput, inputActions } = props

      const draft = useInput((state) => state.draft)
      const draftRev = useInput((state) => state.draftRev)
      const chipCount = useInput((state) => (Array.isArray(state.occurrences) ? state.occurrences.length : 0))

      const state = react.useSyncExternalStore(
        subscribeStates,
        () => stateOf(sessionId),
        () => stateOf(sessionId),
      )

      // `directoryFor()` resolves lazily: nothing is routable until the catalog
      // has loaded, so nudge it once per controller.
      const loadRoute = react.useCallback(() => {
        if (typeof directory?.load !== 'function') return
        Promise.resolve(directory.load()).catch(() => {})
      }, [directory])

      react.useEffect(() => {
        loadRoute()
      }, [loadRoute])

      const store = directory?.store
      const subscribeRoute = react.useCallback(
        (listener) => (typeof store?.subscribe === 'function' ? store.subscribe(listener) : () => {}),
        [store],
      )
      const readRoute = react.useCallback(
        () => (typeof store?.getSnapshot === 'function' ? store.getSnapshot() : undefined),
        [store],
      )
      const snapshot = react.useSyncExternalStore(subscribeRoute, readRoute, readRoute)
      const route = snapshot?.current
      const provider = typeof route?.provider === 'string' ? route.provider : ''
      const model = typeof route?.model === 'string' ? route.model : ''
      const routeBroken = snapshot?.status === 'error'

      const [hovered, setHovered] = react.useState(false)

      // The request outlives this render, so the callbacks read the live draft
      // through a ref instead of the snapshot captured when the click happened.
      const latest = react.useRef({ draft, rev: draftRev })
      latest.current = { draft, rev: draftRev }

      // The rewrite replaced the draft. If the author then edits it, the backup
      // no longer describes what is on screen, so drop it instead of offering a
      // revert that would silently discard their edit.
      react.useEffect(() => {
        if (state.phase === 'enhanced') {
          if (draft === state.applied || draft === state.backup) return
          writeState(sessionId, IDLE)
          return
        }
        // A drop notice describes the draft that replaced the rewrite: it stays
        // put until the author changes that text again.
        if (state.phase === 'stale' && draft !== state.kept) writeState(sessionId, IDLE)
      }, [draft, state, sessionId])

      const busy = state.phase === 'enhancing'
      const holding = state.phase === 'enhanced'
      const failed = state.phase === 'failed'

      const hasDraft = typeof draft === 'string' && draft.trim() !== ''
      const canWrite =
        typeof inputActions?.setDraft === 'function' || typeof inputActions?.insertText === 'function'
      const hasRoute = provider !== '' && model !== ''
      const tooLong = typeof draft === 'string' && draft.length > MAX_DRAFT_CHARS
      // A failed catalog load is actionable, so it must not disable the button:
      // the click retries the load instead of starting a rewrite.
      const retryable = !hasRoute && routeBroken && !busy
      const blocked =
        !busy && (!hasDraft || !canWrite || tooLong || chipCount > 0 || (!hasRoute && !routeBroken))

      /** Why the button is inert, in priority order. */
      const reason = busy
        ? undefined
        : !hasDraft || !canWrite
          ? t('empty')
          : chipCount > 0
            ? t('withChips')
            : tooLong
              ? t('tooLong')
              : !hasRoute
                ? routeBroken
                  ? t('routeError')
                  : t('noModel')
                : undefined

      const label = busy
        ? t('enhancing')
        : holding
          ? t('revert')
          : failed
            ? t('failed', { message: state.message })
            : state.phase === 'stale'
              ? t('stale')
              : (reason ?? t('title'))

      const onClick = react.useCallback(() => {
        const current = stateOf(sessionId)

        if (current.phase === 'enhancing') {
          current.controller.abort()
          writeState(sessionId, IDLE)
          return
        }

        if (current.phase === 'enhanced') {
          writeDraft(inputActions, current.backup, latest.current)
          // Reverting is not worth a second attempt either: if the editor
          // refused, the draft on screen is already something else.
          writeState(sessionId, IDLE)
          return
        }

        if (retryable) {
          writeState(sessionId, IDLE)
          loadRoute()
          return
        }

        const sent = typeof latest.current.draft === 'string' ? latest.current.draft : ''
        if (sent.trim() === '') return
        if (!hasRoute || !canWrite) return

        const controller = new AbortController()
        writeState(sessionId, { phase: 'enhancing', controller, sent })

        requestReforge({ draft: sent, provider, model, sessionId, signal: controller.signal }).then(
          (text) => {
            // Cancelled: the click that aborted already put us back to idle.
            const settled = stateOf(sessionId)
            if (settled.phase !== 'enhancing' || settled.controller !== controller) return
            // The author kept typing while the model worked. Overwriting now
            // would destroy that edit, so drop the result and say so.
            if (latest.current.draft !== sent) {
              writeState(sessionId, { phase: 'stale', kept: latest.current.draft })
              return
            }
            // A refused write means the editor moved on under us (revision
            // change, message sent, composer gone). Claiming success would arm
            // a revert against a draft that never changed.
            if (!writeDraft(inputActions, text, latest.current)) {
              writeState(sessionId, IDLE)
              return
            }
            writeState(sessionId, { phase: 'enhanced', backup: sent, applied: text })
          },
          (error) => {
            const settled = stateOf(sessionId)
            if (settled.phase !== 'enhancing' || settled.controller !== controller) return
            if (error instanceof Error && error.name === 'AbortError') {
              writeState(sessionId, IDLE)
              return
            }
            writeState(sessionId, {
              phase: 'failed',
              message: error instanceof Error ? error.message : String(error),
            })
          },
        )
      }, [canWrite, hasRoute, inputActions, loadRoute, model, provider, retryable, sessionId])

      const icon = busy ? h(BusyIcon) : holding ? h(RevertIcon) : h(ReforgeIcon)

      const inert = blocked && !busy

      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-prompt-reforge',
          title: label,
          'aria-label': label,
          'aria-busy': busy ? 'true' : undefined,
          'aria-pressed': holding ? 'true' : undefined,
          'aria-disabled': inert ? 'true' : undefined,
          'data-phase': state.phase,
          'data-draft-rev': String(draftRev ?? ''),
          disabled: blocked,
          onClick,
          onMouseEnter: () => setHovered(true),
          onMouseLeave: () => setHovered(false),
          onFocus: () => setHovered(true),
          onBlur: () => setHovered(false),
          style: {
            width: 28,
            height: 28,
            flex: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            margin: 0,
            border: 'none',
            borderRadius: 999,
            background: hovered && !inert ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
            color: failed
              ? 'var(--dsw-alias-state-error-primary)'
              : holding
                ? 'var(--dsw-alias-state-business-primary)'
                : state.phase === 'stale'
                  ? 'var(--dsw-alias-label-tertiary)'
                  : 'var(--dsw-alias-label-secondary)',
            opacity: inert ? 0.4 : 1,
            cursor: inert ? 'default' : 'pointer',
            transition: 'background 120ms ease, color 120ms ease',
          },
        },
        icon,
      )
    }

    //#endregion

    /**
     * `directoryFor()` resolves `sessions` / `remote.session` on the *calling*
     * fiber, so those have to be declared here even though this file never
     * touches them directly.
     */
    const inject = ['slots', 'locale', 'sessions', 'remote', 'remote.session']

    /** @param {any} ctx */
    function apply(ctx) {
      guarded('copy', () => ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), 'dsh-prompt-reforge: copy'))

      const t = ctx.locale.bind(NAMESPACE)

      guarded('composer control', () =>
        ctx.inject(['modelDirectories'], (scope) =>
          guarded('composer control', () =>
            scope.slots.inject('conversation.input.right', () =>
              guarded('composer control', () =>
                scope.slots.register(
                  {
                    name: 'conversation.input.right',
                    id: 'prompt-reforge',
                    order: 5,
                    locale: NAMESPACE,
                    inject: (sessionId) => {
                      let directory
                      try {
                        directory = scope.modelDirectories.directoryFor(sessionId)
                      } catch {
                        // No scope, or a subagent session: no route, so the
                        // control degrades to a disabled button.
                        directory = undefined
                      }
                      return { sessionId, directory, t }
                    },
                  },
                  ReforgeControl,
                ),
              ),
            ),
          ),
        ),
      )

      ctx.effect(() => () => abortAll(), 'dsh-prompt-reforge: cancel in-flight rewrites')
    }

    module.exports.apply = apply
    module.exports.inject = inject
    module.exports.name = 'prompt-reforge'
    return module.exports
  },
})
