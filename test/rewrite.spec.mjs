/**
 * The rewrite is the only thing this plugin does, and it has to be exact in both
 * directions: every literal the shipped parser would refuse must be broken, and
 * every literal it would accept must come out byte-identical.
 *
 * "Byte-identical" is not a stylistic preference. The guard's failure mode is not
 * failing to help — it is damaging a mention that worked, which no test of the
 * defect would notice. So each arm asserts the untouched half as loudly as the
 * touched one, and the whole suite is closed by feeding every rewritten text
 * back through the shipped `parseSessionReferenceText`.
 *
 * @module test/rewrite.spec
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeSessionReferenceUri,
  encodeSessionReferenceUri,
  parseSessionReferenceText,
} from '@deepseek-ai/dsh-session-reference'
import { decodesCanonically, encodeReferenceUri } from '../lib/canonical.js'
import { neutralizeInPlace, neutralizeText, rewriteMessage, scanMessages } from '../lib/rewrite.js'
import { contextText, userImage, userText } from './harness.mjs'

/** The canonical URI of `abc`, used wherever an accepted literal is needed. */
const GOOD = encodeReferenceUri('abc')

/** The reported literal: alphabet-valid, undecodable, and refused. */
const BAD = 'dsh-session:382'

/** Every text this suite feeds through the rewrite. */
const TEXTS = [
  `please look at ${BAD}`,
  `${BAD} at the start`,
  `${BAD}`,
  `${BAD} and ${BAD} again`,
  `two different ones: ${BAD} and ${encodeSessionReferenceUri('中文')}`,
  `mention @[old](dsh-session:382) inline`,
  `mention @[old label](dsh-session:382) inline`,
  `truncated mention @[old](dsh-session:382 no paren`,
  `fenced:\n\`\`\`\n${BAD}\n\`\`\``,
  `inline code \`${BAD}\` here`,
  `nothing to do here`,
  `scheme with no payload: dsh-session: and then text`,
  `wrong case DSH-SESSION:382`,
  `longer scheme dsh-session2:382`,
  `accepted ${GOOD} stays`,
  `accepted mention @[abc](${GOOD}) stays`,
]

test('the reported literal really is refused, and its canonical neighbour is not', () => {
  assert.equal(decodesCanonically(BAD), false)
  assert.equal(decodesCanonically(GOOD), true)
  assert.throws(() => parseSessionReferenceText(BAD), { code: 'SESSION_REFERENCE_INVALID_REFERENCE' })
})

test('a refused literal is broken by exactly one escaped colon', () => {
  const { text, escaped } = neutralizeText(`please look at ${BAD}`, decodesCanonically)
  assert.deepEqual(escaped, [BAD])
  assert.equal(text, 'please look at dsh-session\\:382')
  // Nothing was deleted and nothing invisible was added: the only difference is
  // the backslash.
  assert.equal(text.replace('\\', ''), `please look at ${BAD}`)
  assert.equal(text.length, `please look at ${BAD}`.length + 1)
})

test('an accepted literal is returned byte-identical', () => {
  const source = `accepted ${GOOD} and a mention @[abc](${GOOD})`
  const { text, escaped } = neutralizeText(source, decodesCanonically)
  assert.equal(text, source)
  assert.deepEqual(escaped, [])
})

test('a malformed Markdown mention is broken inside its parentheses', () => {
  const { text, escaped } = neutralizeText('mention @[old](dsh-session:382) inline', decodesCanonically)
  assert.deepEqual(escaped, [BAD])
  // The shipped pattern's first alternative matches the whole mention; the rewrite
  // keeps the label and the parentheses and only escapes the URI.
  assert.equal(text, 'mention @[old](dsh-session\\:382) inline')
  // And the shipped parser still reads the label/none of it: no throw, no reference.
  assert.deepEqual(parseSessionReferenceText(text), { text, references: [] })
})

test('a truncated mention is broken at the bare literal inside it', () => {
  const { text, escaped } = neutralizeText('truncated mention @[old](dsh-session:382 no paren', decodesCanonically)
  assert.deepEqual(escaped, [BAD])
  assert.equal(text, 'truncated mention @[old](dsh-session\\:382 no paren')
})

test('the pattern is the shipped one, so a fenced block is rewritten too', () => {
  // The shipped parser does not skip code fences — a fence is just text to it —
  // so a guard that skipped them would leave the throw exactly where it was.
  const fenced = `fenced:\n\`\`\`\n${BAD}\n\`\`\``
  assert.throws(() => parseSessionReferenceText(fenced))
  const { text, escaped } = neutralizeText(fenced, decodesCanonically)
  assert.deepEqual(escaped, [BAD])
  assert.doesNotThrow(() => parseSessionReferenceText(text))
})

test('a scheme with no payload is left alone', () => {
  // The shipped pattern requires a non-empty payload, so this text cannot throw;
  // touching it would be the guard damaging text on its own initiative.
  const source = 'scheme with no payload: dsh-session: and then text'
  const { text, escaped } = neutralizeText(source, decodesCanonically)
  assert.equal(text, source)
  assert.deepEqual(escaped, [])
})

test('another scheme, or another case, is left alone', () => {
  for (const source of ['wrong case DSH-SESSION:382', 'longer scheme dsh-session2:382']) {
    const { text, escaped } = neutralizeText(source, decodesCanonically)
    assert.equal(text, source)
    assert.deepEqual(escaped, [])
  }
})

test('every occurrence is broken, in first-appearance order', () => {
  const other = 'dsh-session:abc'
  const { text, escaped } = neutralizeText(`two different ones: ${BAD} and ${other}`, decodesCanonically)
  assert.deepEqual(escaped, [BAD, other])
  assert.ok(text.includes('dsh-session\\:382'))
  assert.ok(text.includes('dsh-session\\:abc'))
  assert.deepEqual(parseSessionReferenceText(text).references, [])
})

test('the rewrite is idempotent', () => {
  // The listener runs it twice per step — at its entrance and after `next` — so a
  // rewrite that could re-enter its own output would double-escape it.
  const once = neutralizeText(`please look at ${BAD}`, decodesCanonically)
  const twice = neutralizeText(once.text, decodesCanonically)
  assert.equal(twice.text, once.text)
  assert.deepEqual(twice.escaped, [])
})

test('every rewritten text is one the shipped parser accepts', () => {
  for (const source of TEXTS) {
    const { text } = neutralizeText(source, decodesCanonically)
    assert.doesNotThrow(() => parseSessionReferenceText(text), `still throws for ${JSON.stringify(source)}`)
  }
})

test('an accepted mention survives the rewrite and still resolves', () => {
  const source = `accepted mention @[abc](${GOOD}) stays`
  const { text } = neutralizeText(source, decodesCanonically)
  assert.equal(text, source)
  const parsed = parseSessionReferenceText(text)
  assert.deepEqual(parsed.references, [{ sessionId: 'abc', label: 'abc' }])
})

test('only a text block of a user message is rewritten', () => {
  const untouched = rewriteMessage(userText(`nothing here`), decodesCanonically)
  assert.equal(untouched, undefined)
  assert.equal(rewriteMessage(contextText(`please look at ${BAD}`), decodesCanonically), undefined)
  assert.equal(rewriteMessage(userImage(), decodesCanonically), undefined)
})

test('a rewritten message keeps its identity and leaves the original alone', () => {
  const original = userText(`please look at ${BAD}`)
  const rewrite = rewriteMessage(original, decodesCanonically)
  assert.ok(rewrite !== undefined)
  assert.deepEqual(rewrite.escaped, [BAD])
  assert.equal(rewrite.message.id, original.id)
  assert.equal(rewrite.message.role, 'user')
  assert.deepEqual(rewrite.message.source, original.source)
  assert.equal(rewrite.message.content[0].text, 'please look at dsh-session\\:382')
  // The original is the message the inbox claimed; a guard that mutated it would
  // be editing an object it does not own.
  assert.equal(original.content[0].text, `please look at ${BAD}`)
  assert.ok(Object.isFrozen(rewrite.message))
})

test('a non-text block next to a text block is passed through untouched', () => {
  const image = userImage(7).content[0]
  const original = userText('placeholder')
  const mixed = { ...original, content: [image, { type: 'text', text: `look at ${BAD}` }] }
  const rewrite = rewriteMessage(mixed, decodesCanonically)
  assert.ok(rewrite !== undefined)
  // `freezeMessage` clones, so this is equality rather than identity — what
  // matters is that the block is carried over unmodified.
  assert.deepEqual(rewrite.message.content[0], image)
  assert.equal(rewrite.message.content[1].text, 'look at dsh-session\\:382')
})

test('the in-place batch rewrite replaces elements and keeps the array', () => {
  const clean = userText('clean')
  const dirty = userText(`please look at ${BAD}`)
  const foreign = contextText(`also ${BAD}`)
  const messages = [clean, dirty, foreign]
  const array = messages
  const escaped = neutralizeInPlace(messages, decodesCanonically)
  assert.deepEqual(escaped, [BAD])
  assert.equal(messages, array, 'the array the waterfall payload holds must be the one rewritten')
  assert.equal(messages[0], clean, 'an untouched message must not be replaced')
  assert.notEqual(messages[1], dirty, 'a rewritten message must be replaced, not mutated')
  assert.equal(messages[1].content[0].text, 'please look at dsh-session\\:382')
  assert.equal(messages[1].id, dirty.id, 'the replacement keeps the identity the inbox claimed it by')
  assert.equal(messages[2], foreign, 'a non-user message must not be replaced')
})

test('a hole in the batch is skipped rather than fatal', () => {
  const messages = [userText('clean')]
  messages[3] = userText(`please look at ${BAD}`)
  assert.deepEqual(neutralizeInPlace(messages, decodesCanonically), [BAD])
  assert.equal(messages[3].content[0].text, 'please look at dsh-session\\:382')
})

test('the scan reports what repair would change, and changes nothing', () => {
  const messages = [userText(`please look at ${BAD}`), userText(`accepted ${GOOD}`), contextText(BAD)]
  const before = JSON.stringify(messages)
  assert.deepEqual(scanMessages(messages, decodesCanonically), [BAD])
  assert.equal(JSON.stringify(messages), before, 'report mode must not write')
})

test('the accepted literal and the refused one are told apart by the shipped decoder', () => {
  // Not by the mirror: the same assertion with the shipped function is what makes
  // the two halves one rule rather than two that happen to agree today.
  for (const uri of [BAD, 'dsh-session:abc', 'dsh-session:ImFiYyJ', GOOD, encodeSessionReferenceUri('中文')]) {
    let shipped
    try {
      decodeSessionReferenceUri(uri)
      shipped = true
    } catch {
      shipped = false
    }
    assert.equal(decodesCanonically(uri), shipped, `mirror disagrees on ${uri}`)
  }
})
