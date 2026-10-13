/**
 * The predicate is the whole safety argument, and it has two halves that must
 * agree with the shipped parser — one used when the package is reachable, one
 * used when it is not.
 *
 * The shipped half is measured directly against `decodeSessionReferenceUri`: the
 * corpus below is asserted BOTH ways, so a change in the harness that moves the
 * canonical boundary fails here rather than letting the guard damage a mention
 * that used to work (too strict) or miss one that throws (too loose).
 *
 * The mirrored half is the fallback, and it is asserted over the same corpus so
 * the two can never drift apart in silence.
 *
 * @module test/canonicality.spec
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SESSION_REFERENCE_SCHEME,
  decodeSessionReferenceUri,
  encodeSessionReferenceUri,
} from '@deepseek-ai/dsh-session-reference'
import { decodesCanonically, encodeReferenceUri, loadCanonicality } from '../lib/canonical.js'

/** Ids whose canonical URIs cover short, empty, non-ASCII and long payloads. */
const IDS = ['', 'a', 'abc', 'session', 'sess-1', 'a b', '中文', 'x'.repeat(300)]

/**
 * URIs the shipped decoder accepts or refuses for a reason worth pinning.
 *
 * Every entry is a literal a user could type or paste, which is the whole point:
 * the guard only ever sees text somebody wrote.
 */
const CORPUS = [
  // Refused: base64url-shaped but not decodable, which is the reported defect.
  'dsh-session:382',
  'dsh-session:abc',
  'dsh-session:__-',
  'dsh-session:A',
  'dsh-session:AA',
  // Refused: decodable bytes that are not JSON.
  'dsh-session:AAAA',
  'dsh-session:AAAAA',
  // Refused: decodes to a string, but base64url's unused trailing bits are not
  // zero, so the re-encode differs. This is the entry a predicate that stopped at
  // "does it parse" gets wrong.
  'dsh-session:ImFiYyJ',
  'dsh-session:ImFiYyK',
  // Refused: decodes to JSON that is not a string.
  'dsh-session:MTIzNA',
  // Refused: no payload at all, so nothing to decode.
  'dsh-session:',
  // Refused: not the scheme at all.
  '',
  'x',
  'DSH-SESSION:382',
  'dsh-session2:382',
  'dsh-session',
  '@[label](dsh-session:382)',
  // Accepted: the canonical forms of every id above.
  ...IDS.map(encodeSessionReferenceUri),
]

/** Would the shipped decoder accept this URI? */
function shippedAccepts(uri) {
  try {
    decodeSessionReferenceUri(uri)
    return true
  } catch {
    return false
  }
}

test('the scheme constant is the shipped one', () => {
  assert.equal(SESSION_REFERENCE_SCHEME, 'dsh-session:')
})

test('the corpus exercises both answers', () => {
  // A corpus that only ever says "refused" would make the agree-arms below pass
  // against a predicate that returns false unconditionally.
  const accepted = CORPUS.filter(shippedAccepts)
  assert.ok(accepted.length > 0, 'the corpus must contain at least one accepted URI')
  assert.ok(accepted.length < CORPUS.length, 'the corpus must contain at least one refused URI')
})

test('the mirrored encoder is byte-identical to the shipped one', () => {
  for (const id of IDS) {
    assert.equal(encodeReferenceUri(id), encodeSessionReferenceUri(id), `encoder disagrees on ${JSON.stringify(id)}`)
  }
})

test('the mirrored predicate agrees with the shipped decoder over the corpus', () => {
  for (const uri of CORPUS) {
    assert.equal(
      decodesCanonically(uri),
      shippedAccepts(uri),
      `mirror disagrees on ${JSON.stringify(uri)}`,
    )
  }
})

test('the loaded oracle agrees with the shipped decoder over the corpus', async () => {
  const oracle = await loadCanonicality()
  assert.equal(typeof oracle, 'function', 'the shipped decoder must be reachable from this suite')
  for (const uri of CORPUS) {
    assert.equal(oracle(uri), shippedAccepts(uri), `oracle disagrees on ${JSON.stringify(uri)}`)
  }
})

test('a refused URI is refused, and an accepted one is not', () => {
  assert.equal(decodesCanonically('dsh-session:382'), false)
  assert.equal(decodesCanonically(encodeReferenceUri('abc')), true)
})

test('the trailing-bits rule is enforced, not just the alphabet', () => {
  // `ImFiYyJ` and `ImFiYyI` decode to the same bytes; only the second is the
  // canonical encoding of `"abc"`.
  assert.equal(decodesCanonically('dsh-session:ImFiYyI'), true)
  assert.equal(decodesCanonically('dsh-session:ImFiYyJ'), false)
  assert.equal(decodeSessionReferenceUri('dsh-session:ImFiYyI'), 'abc')
})

test('an unreachable package degrades to the mirror instead of failing', async () => {
  assert.equal(await loadCanonicality(() => Promise.reject(new Error('not installed'))), undefined)
})

test('a reached module without the decoder degrades to the mirror', async () => {
  assert.equal(await loadCanonicality(async () => ({})), undefined)
  assert.equal(await loadCanonicality(async () => ({ decodeSessionReferenceUri: 'not a function' })), undefined)
})

test('a loader that throws synchronously degrades to the mirror', async () => {
  assert.equal(await loadCanonicality(() => { throw new Error('module hook refused') }), undefined)
})

test('the loaded oracle turns a throw into false and a return into true', async () => {
  const oracle = await loadCanonicality(async () => ({
    decodeSessionReferenceUri: uri => {
      if (uri === 'dsh-session:throw') throw new Error('refused')
      return 'id'
    },
  }))
  assert.equal(oracle('dsh-session:throw'), false)
  assert.equal(oracle('dsh-session:keep'), true)
})
