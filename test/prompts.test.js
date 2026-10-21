import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LENGTH_BUDGET,
  SYSTEM_PROMPT,
  USER_TEMPLATE,
  normalizeEnhancedText,
  renderUserPrompt,
} from '../lib/prompts.js'

test('the user template has exactly one draft slot', () => {
  assert.equal(USER_TEMPLATE.split('{{draft}}').length, 2)
})

test('renderUserPrompt substitutes the draft once', () => {
  const rendered = renderUserPrompt('写一个快排')
  assert.ok(rendered.includes('写一个快排'))
  assert.ok(!rendered.includes('{{draft}}'))
})

test('renderUserPrompt inserts replacement patterns literally', () => {
  // A draft containing `$&` must not be re-interpreted as a replacement token.
  const rendered = renderUserPrompt('price is $& and $1')
  assert.ok(rendered.includes('price is $& and $1'))
})

test('renderUserPrompt tolerates an empty draft', () => {
  assert.ok(!renderUserPrompt('').includes('{{draft}}'))
})

test('the system prompt states the length budget', () => {
  assert.ok(SYSTEM_PROMPT.includes(String(LENGTH_BUDGET)))
})

test('the system prompt forbids answering the request', () => {
  assert.match(SYSTEM_PROMPT, /Do not answer the request/)
})

test('normalizeEnhancedText trims', () => {
  assert.equal(normalizeEnhancedText('  hi  '), 'hi')
})

test('normalizeEnhancedText returns empty for non-strings', () => {
  for (const value of [undefined, null, 42, {}, []]) {
    assert.equal(normalizeEnhancedText(value), '')
  }
  assert.equal(normalizeEnhancedText('   '), '')
})

test('normalizeEnhancedText unwraps a fenced block', () => {
  assert.equal(normalizeEnhancedText('```text\nclarify the input format\n```'), 'clarify the input format')
})

test('normalizeEnhancedText strips a leading label', () => {
  assert.equal(normalizeEnhancedText('Enhanced prompt: do the thing'), 'do the thing')
  assert.equal(normalizeEnhancedText('增强后的提示词：做这件事'), '做这件事')
})

test('normalizeEnhancedText strips wrapping quotes only', () => {
  assert.equal(normalizeEnhancedText('"do the thing"'), 'do the thing')
  assert.equal(normalizeEnhancedText('“做这件事”'), '做这件事')
  assert.equal(normalizeEnhancedText('「做这件事」'), '做这件事')
  // A quote in the middle is part of the content.
  assert.equal(normalizeEnhancedText('say "hi" to the user'), 'say "hi" to the user')
})

test('normalizeEnhancedText keeps list structure intact', () => {
  const text = '- one\n- two\n- three'
  assert.equal(normalizeEnhancedText(text), text)
})

test('normalizeEnhancedText does not strip a lone quote character', () => {
  assert.equal(normalizeEnhancedText('"'), '"')
})
