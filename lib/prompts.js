/**
 * Prompt text for the enhancement call.
 *
 * The wording here is original to this plugin. The *behaviour* is modelled on
 * the "enhance prompt" affordance found in other assistants — mirror the
 * author's language, sharpen the request, never answer it, never editorialise —
 * but none of the strings are copied from another product.
 */

/** How much room the rewrite gets, in characters. Advisory, not enforced. */
export const LENGTH_BUDGET = 800

/**
 * Instruction block. Sent as the call's `system` so the user message can stay
 * a verbatim copy of the draft — adapters that flatten leading system messages
 * (`options.system` / in-history system turns) all converge on this shape.
 */
export const SYSTEM_PROMPT = `You rewrite rough drafts into precise prompts for a coding assistant.

You receive the author's draft. You return a better version of that draft, and nothing else.

WHAT TO IMPROVE
- Name the task explicitly instead of alluding to it.
- Pin down scope: what is in, what is out, where the work stops.
- Surface the constraints the author implied but did not state: language, framework, file layout, interface, compatibility, performance envelope.
- Say what a good answer looks like: the shape of the output, the level of detail, whether code or prose is wanted.
- Keep the author's own vocabulary for their domain. Do not rename their concepts.

WHAT TO PRESERVE
- The author's intent, subject matter and hard requirements. You are sharpening a request, not replacing it with your own.
- The author's language. Detect it and answer in it, entirely. Chinese draft, Chinese rewrite. English draft, English rewrite. A mixed draft stays mixed in the same proportion. Never mention this rule, never label the language, never translate the request into a single language.
- Roughly the author's length. Stay under about ${LENGTH_BUDGET} characters. A terse draft becomes a tight prompt, not an essay.

WHAT NOT TO DO
- Do not answer the request. Do not solve the problem, write the code, or explain how the work would be done. Describe what is wanted, not how to get it.
- Do not add requirements the author never implied: no invented stack choices, no invented acceptance criteria, no invented deadlines or audiences.
- Do not wrap the result in commentary. No preamble, no "here is", no headings, no bullet-point meta sections, no markdown fence, no language analysis, no notes about what you changed.
- Do not pad. If the draft is already precise, tighten the phrasing and stop.
- Do not end mid-thought. No dangling conjunction, no trailing colon, no unfinished list.

OUTPUT
The rewritten prompt, plain text, nothing before it and nothing after it.`

/**
 * User-message template. `{{draft}}` is substituted once, by
 * {@link renderUserPrompt}; the draft itself is never interpreted.
 */
export const USER_TEMPLATE = `Draft to rewrite:

<draft>
{{draft}}
</draft>

Return only the rewritten prompt.`

/**
 * Substitute the draft into {@link USER_TEMPLATE}.
 *
 * Uses a function replacement so `$&`, `$1` and friends inside the draft are
 * inserted literally rather than expanded.
 *
 * @param {string} draft
 * @returns {string}
 */
export function renderUserPrompt(draft) {
  return USER_TEMPLATE.replace('{{draft}}', () => draft)
}

/** Fences some models still wrap their answer in, despite the instruction. */
const FENCE_RE = /^```[^\n]*\n([\s\S]*?)\n?```$/

/** Leading label some models prepend, in either language. */
const LABEL_RE = /^(?:enhanced prompt|improved prompt|rewritten prompt|prompt|增强后的提示词|优化后的提示词|改写后的提示词)\s*[:：]\s*/i

/** Straight and typographic quotes, used for the wrapping-quote strip. */
const EDGE_QUOTE_RE = /^["'“”‘’「」]|["'“”‘’「」]$/gu

/**
 * Turn a raw model answer into the text that belongs in the composer.
 *
 * Deliberately conservative: it only removes wrapping the model was told not to
 * add. Interior markdown, lists and code stay untouched.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeEnhancedText(raw) {
  if (typeof raw !== 'string') return ''
  let text = raw.trim()
  if (text === '') return ''

  const fenced = FENCE_RE.exec(text)
  if (fenced !== null) text = fenced[1].trim()

  // A label can sit either outside or inside the fence; strip after unwrapping.
  text = text.replace(LABEL_RE, '').trim()

  // Only strip quotes that actually wrap the whole answer.
  if (text.length > 1 && EDGE_QUOTE_RE.test(text)) {
    const stripped = text.replace(EDGE_QUOTE_RE, '').trim()
    if (stripped !== '') text = stripped
  }

  return text
}
