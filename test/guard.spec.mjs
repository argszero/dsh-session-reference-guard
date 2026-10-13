/**
 * The end-to-end arms: the plugin mounted in a real context, the real waterfall,
 * and the real shipped parser behind a listener with the shipped listener's shape.
 *
 * The central pair is control-versus-mounted on the SAME message through the SAME
 * dispatcher — the unmounted arm has to fail for the mounted arm to mean anything.
 * Everything after it is an ordering or a mode: which `{ prepend: true }`
 * registration lands first, whether the loop's terminal copies the array when it
 * appends runtime context, and what each of the three modes actually does.
 *
 * @module test/guard.spec
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { encodeSessionReferenceUri, parseSessionReferenceText } from '@deepseek-ai/dsh-session-reference'
import { textOf, userText, world } from './harness.mjs'

/** The reported literal: alphabet-valid, undecodable, and refused by the parser. */
const BAD = 'dsh-session:382'

/** A message body carrying it, phrased the way the report phrased it. */
const REPORTABLE = `the step died with: invalid session reference URI "dsh-session:382"`

test('the reported literal fails a step when nothing is mounted', async () => {
  const { propose } = await world({ mounted: false, resolver: true })
  await assert.rejects(
    () => propose([userText(REPORTABLE)]),
    { code: 'SESSION_REFERENCE_INVALID_REFERENCE' },
  )
})

test('the same step proceeds when the guard is mounted, with the literal broken', async () => {
  const { propose } = await world({ resolver: true })
  const decision = await propose([userText(REPORTABLE)])
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 1)
  // Broken, and only by the one escape: strip it and the user's text is back.
  assert.equal(textOf(decision.messages[0]).replaceAll('\\', ''), REPORTABLE)
  assert.ok(!textOf(decision.messages[0]).includes('dsh-session:'))
})

test('the guard wins whichever order the two prepended listeners arrive in', async () => {
  // Both listeners register with `{ prepend: true }`, so the shipped resolver may
  // be the outer one. It calls `next()` before parsing, which is why the guard's
  // entrance pass is enough in both directions — but "which is why" is a claim,
  // so both directions are measured.
  for (const mountFirst of [false, true]) {
    const { propose } = await world({ resolver: true, mountFirst })
    const decision = await propose([userText(REPORTABLE)])
    assert.equal(decision.kind, 'enter', `mountFirst=${String(mountFirst)}`)
    assert.ok(!textOf(decision.messages[0]).includes('dsh-session:'), `mountFirst=${String(mountFirst)}`)
  }
})

test('the guard still wins when the loop appends runtime context', async () => {
  // The loop's terminal returns `[...claimed, context]` when there is projected
  // runtime context, so the array the resolver parses is not the array the guard
  // was handed. Replacing elements is what survives that copy.
  const { propose } = await world({ resolver: true })
  const context = userText('runtime context, appended by the loop')
  const decision = await propose([userText(REPORTABLE)], { context })
  assert.equal(decision.messages.length, 2)
  assert.ok(!textOf(decision.messages[0]).includes('dsh-session:'))
  assert.equal(textOf(decision.messages[1]), 'runtime context, appended by the loop')
})

test('a message appended by an inner listener after the entrance pass is still broken', async () => {
  // The entrance pass sees the batch the loop proposed. A listener inner to the
  // guard can return a different batch, and the resolver parses whatever comes out
  // of the chain — so the guard runs a second pass on the decision `next()` gave
  // it, which is the only point still ahead of the resolver.
  const { ctx, propose } = await world({ resolver: true })
  ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    return { ...decision, messages: [...decision.messages, userText('appended later: dsh-session:382')] }
  })
  const decision = await propose([userText('an ordinary message')])
  assert.equal(decision.messages.length, 2)
  assert.ok(!textOf(decision.messages[1]).includes('dsh-session:'))
  assert.ok(textOf(decision.messages[1]).includes('dsh-session\\:382'))
})

test('a message the resolver never reads is not touched', async () => {
  const { propose } = await world({ resolver: true })
  const decision = await propose([{ ...userText(REPORTABLE), source: { kind: 'compact-checkpoint', compactionId: 'x' } }])
  // The guard leaves it alone, and the shipped listener leaves it alone, because
  // neither parses a non-user source. The literal survives.
  assert.ok(textOf(decision.messages[0]).includes('dsh-session:382'))
})

test('a canonical mention still resolves, end to end', async () => {
  const { propose } = await world({ resolver: true })
  const decision = await propose([userText(`see @[abc](${encodeSessionReferenceUri('abc')}) please`)])
  assert.equal(textOf(decision.messages[0]), 'see @abc please')
  // And that is the shipped parser's own rendering, not the guard's.
  assert.equal(parseSessionReferenceText(`see @[abc](${encodeSessionReferenceUri('abc')}) please`).text, 'see @abc please')
})

test('report mode counts without writing, so the step still fails', async () => {
  const { propose, logs } = await world({ resolver: true, config: { mode: 'report' } })
  await assert.rejects(() => propose([userText(REPORTABLE)]), { code: 'SESSION_REFERENCE_INVALID_REFERENCE' })
  assert.equal(logs.matching('would neutralize').length, 1)
})

test('report mode names the literal it would have broken, in a form that cannot be pasted back', async () => {
  const { propose, logs } = await world({ config: { mode: 'report' } })
  const decision = await propose([userText(REPORTABLE)])
  assert.equal(textOf(decision.messages[0]), REPORTABLE, 'report mode must not write')
  const [record] = logs.matching('would neutralize')
  assert.ok(record !== undefined)
  const line = String(record.args[0])
  assert.ok(line.includes('382'), 'the refused literal must be named')
  // The defect is that the refusal message carries its own trigger, so a user
  // who copies the diagnostic re-breaks the turn. This plugin's diagnostic is
  // one more place that could happen; the escaped form reads the same and is
  // inert.
  assert.ok(!line.includes('dsh-session:'), 'the diagnostic must not itself be a literal')
})

test('off mode installs no listener at all', async () => {
  const { propose } = await world({ config: { mode: 'off' } })
  const decision = await propose([userText(REPORTABLE)])
  assert.equal(textOf(decision.messages[0]), REPORTABLE)
})

test('repair is the default and writes', async () => {
  const { propose, logs } = await world({})
  const decision = await propose([userText(REPORTABLE)])
  assert.ok(!textOf(decision.messages[0]).includes('dsh-session:'))
  assert.equal(logs.matching('neutralized').length, 1)
})

test('a mode this plugin does not implement is refused at mount', async () => {
  const ctx = new Context()
  const { default: plugin } = await import('../lib/index.js')
  // `ctx.plugin` returns a Fiber, not a Promise, so the throw is observed by
  // awaiting it inside an async wrapper — the mount is still refused, which is
  // the property under test, not the shape of the rejection.
  await assert.rejects(async () => { await ctx.plugin(plugin, { mode: 'repiar' }) }, TypeError)
})

test('nothing is logged when nothing would be refused', async () => {
  const { propose, logs } = await world({})
  await propose([userText('an ordinary message with no reference in it')])
  assert.deepEqual(logs.matching('session-reference-guard'), [])
})

test('the same literal in consecutive steps is reported once per agent', async () => {
  // A guard that logged every step would put a line in the log for every turn of
  // a session that kept the text in context.
  const { propose, logs } = await world({})
  await propose([userText(REPORTABLE)])
  await propose([userText(REPORTABLE)])
  assert.equal(logs.matching('neutralized').length, 1)
})

test('a different literal in a later step is reported again', async () => {
  const { propose, logs } = await world({})
  await propose([userText(REPORTABLE)])
  await propose([userText('and also dsh-session:abc')])
  assert.equal(logs.matching('neutralized').length, 2)
})

test('a guard whose own predicate throws leaves the step alone instead of failing it', async () => {
  // The defect this answers is a failure with no `try`/`catch`; a guard that
  // reproduced that shape would be worse than no guard. A message with no source
  // at all is what makes the guard's own read throw.
  const { propose, logs } = await world({})
  const decision = await propose([{ id: 'malformed', role: 'user', content: [{ type: 'text', text: REPORTABLE }] }])
  assert.equal(decision.kind, 'enter')
  assert.equal(logs.matching('leaving this step alone').length, 1)
})

test('an aborted step is passed through untouched', async () => {
  const { propose } = await world({})
  const controller = new AbortController()
  controller.abort()
  const decision = await propose([userText(REPORTABLE)], { signal: controller.signal })
  assert.equal(textOf(decision.messages[0]), REPORTABLE)
})

test('the namespace export mounts and behaves like the default export', async () => {
  const { propose } = await world({ form: 'namespace' })
  const decision = await propose([userText(REPORTABLE)])
  assert.ok(!textOf(decision.messages[0]).includes('dsh-session:'))
})
