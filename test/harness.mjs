/**
 * The harness: a REAL cordis context, the REAL `agent/pre-step` waterfall
 * dispatched through `agentEvents(ctx, agent)` — the same dispatcher the agent
 * loop calls — and, for the arms that need the defect itself, the REAL shipped
 * parser (`parseSessionReferenceText`, imported from
 * `@deepseek-ai/dsh-session-reference`) sitting behind a listener with the
 * shipped listener's shape.
 *
 * Two things are deliberately not simulated:
 *
 * - **The dispatcher.** `propose` goes through `agentEvents`, so scope
 *   filtering, `{ prepend: true }` ordering and the waterfall's value passing
 *   are the shipped ones. An arm that passes here passes for the same reason
 *   the loop would.
 * - **The parser.** `mountShippedResolverStyleListener` calls the exported
 *   `parseSessionReferenceText` on the shipped pattern, so "the plugin prevented
 *   the throw" is measured against the function that throws.
 *
 * One thing IS a stand-in, and it is named here rather than left implicit: the
 * shipped `SessionReferenceResolver` continues past a successful parse into
 * snapshot capture, which reads sessions through `sessionQuery` and appends the
 * prepared context. That half is not what any arm in this suite measures, so the
 * listener below stops at the parsed content and returns the message without the
 * appended context. Everything the plugin can affect happens before that point.
 *
 * `world({ mounted: false })` is the control arm for every "the plugin
 * prevented X" claim: the same context, the same listener, the same message,
 * with nothing mounted.
 *
 * @module test/harness
 */

import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { parseSessionReferenceText } from '@deepseek-ai/dsh-session-reference'
import plugin, * as namespace from '../lib/index.js'

/** The module namespace, for the arm that asserts both export forms mount. */
export { namespace }

/**
 * Collect every structured log record this process publishes.
 *
 * `levels` is not decoration: an exporter that declares none falls back to
 * `LoggerLevel.INFO` as its threshold, and `warn` is *above* INFO, so a capture
 * registered without it silently drops exactly the records these arms assert on.
 */
export function captureLogs(ctx) {
  const records = []
  ctx.logger.exporter({ colors: false, levels: { default: 3 }, export: message => records.push(message) })
  return {
    records,
    /** Every captured record of one severity whose format string contains `needle`. */
    matching(needle, type = 'warn') {
      return records.filter(record => record.type === type && String(record.args[0]).includes(needle))
    },
  }
}

/** The `Agent` shell a step is dispatched against; only its identity matters here. */
export function agentFor(id = 'session-reference-guard-agent') {
  return { id, options: {}, ctx: new Context(), status: 'idle' }
}

/** One direct user message carrying a single text block. */
export function userText(text) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/**
 * One user-role message from a producer that is NOT the user.
 *
 * The shipped resolver only parses messages whose source is `user`, so a literal
 * inside this one must survive untouched — that is the arm this builder exists
 * for.
 */
export function contextText(text, kind = 'compact-checkpoint') {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind, compactionId: 'harness' } })
}

/** One user message whose only block is an image, which has no text to parse. */
export function userImage(attachmentId = 1) {
  return createUserMessage({
    content: [{ type: 'image', attachment: { attachmentId, mediaType: 'image/png' } }],
    source: { kind: 'user' },
  })
}

/**
 * The shipped resolver's `agent/pre-step` listener, with the shipped shape.
 *
 * Registered with `{ prepend: true }` exactly as
 * `SessionReferenceResolver` registers it, and it calls `next()` first exactly as
 * that listener does — so the parse happens on the decision the whole chain
 * produced, which is why a guard that rewrites the payload at its own entrance
 * still wins.
 * @param ctx - the world's context.
 */
export function mountShippedResolverStyleListener(ctx) {
  ctx.on('agent/pre-step', async ({ messages }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    return { ...decision, messages: prepareDirectMessages(decision.messages) }
  }, { prepend: true })
}

/**
 * The part of `prepareDirectMessages` this suite measures: parse every text block
 * of every direct user message with the shipped parser, which throws on the first
 * literal it refuses.
 * @param messages - the decision's messages.
 * @returns the messages with their text blocks re-rendered.
 */
function prepareDirectMessages(messages) {
  return messages.map(message => {
    if (message.source.kind !== 'user') return message
    const content = message.content.map(block => {
      if (block.type !== 'text') return block
      const parsed = parseSessionReferenceText(block.text)
      return { type: 'text', text: parsed.text }
    })
    return { ...message, content }
  })
}

/**
 * Build one world.
 * @param world.mounted - `false` mounts nothing, which is the control arm.
 * @param world.config - the plugin configuration to mount with.
 * @param world.form - which export to mount: the `default` (what a Loader entry
 *   resolves) or the module `namespace`.
 * @param world.resolver - `true` mounts the shipped-shaped listener too.
 * @param world.mountFirst - `true` registers the shipped-shaped listener BEFORE
 *   the plugin, so the two `{ prepend: true }` registrations arrive in the other
 *   order; both orders must work.
 * @returns the context, the agent shell, the log capture, and the dispatch entry.
 */
export async function world({ mounted = true, config = {}, form = 'default', resolver = false, mountFirst = false } = {}) {
  const ctx = new Context()
  const agent = agentFor()
  const logs = captureLogs(ctx)
  if (mountFirst && resolver) mountShippedResolverStyleListener(ctx)
  if (mounted) await ctx.plugin(form === 'namespace' ? namespace : plugin, config)
  if (!mountFirst && resolver) mountShippedResolverStyleListener(ctx)
  return {
    ctx,
    agent,
    logs,
    /** Dispatch one step through the real waterfall. */
    propose: (messages, options = {}) => propose(ctx, agent, messages, options),
  }
}

/**
 * Dispatch one `agent/pre-step`, exactly as the loop does.
 *
 * The terminal is the loop's own: it builds the entering batch from the payload's
 * array, appending the projected runtime context when there is one — which is the
 * branch that copies the array, and the reason a guard cannot rely on mutating an
 * array that happens to be returned by reference.
 * @param ctx - the world's context.
 * @param agent - the agent whose step this is.
 * @param messages - the batch the loop proposes.
 * @param options.turn - the turn number.
 * @param options.step - the step number.
 * @param options.signal - a cancellation signal; defaults to a fresh, un-aborted one.
 * @param options.context - a runtime-context message to append, mirroring the loop.
 * @returns the decision the waterfall composed.
 */
export async function propose(ctx, agent, messages, { turn = 1, step = 1, signal = new AbortController().signal, context } = {}) {
  return await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages, turn, step, signal },
    () => Promise.resolve({
      kind: 'enter',
      messages: context === undefined ? messages : [...messages, context],
    }),
  )
}

/** The text of one message, joined across its text blocks. */
export function textOf(message) {
  return message.content.map(block => block.text ?? '').join('')
}
