/**
 * A non-canonical `dsh-session:` literal in ordinary text fails the whole turn —
 * and the failure republishes itself.
 *
 * ## The defect
 *
 * `@deepseek-ai/dsh-session-reference` reads direct user messages at
 * `agent/pre-step` (`SessionReferenceResolver`, registered with `{ prepend: true }`)
 * and hands every `text` block to `parseSessionReferenceText`
 * (`context/session-reference/src/index.ts`, `prepareDirectMessages`). There is no
 * `try`/`catch` at that call site, so a throw there leaves the step: the turn ends
 * with `code: UNKNOWN` before a model is ever asked anything.
 *
 * The pattern that decides what is a reference admits text nobody meant as one.
 * Its bare-text alternative is `(dsh-session:[A-Za-z0-9_-]+)`, and the payload
 * check that follows admits *any* base64url run — including three digits. So
 * `dsh-session:382` is parsed as a URI, decoded as base64url, turned into two
 * invalid UTF-8 bytes, and refused by `JSON.parse`. Markdown mentions are worse
 * rather than better: when one is malformed the pattern falls through to the bare
 * alternative and matches inside its parentheses.
 *
 * What makes it self-propagating is the refusal message: it quotes the URI it
 * refused, so the literal is inside the text a user would paste into the next
 * message to report the failure — which fails the same way, in the same place.
 * Discussion #9613 is that report.
 *
 * ## What this plugin does
 *
 * It joins the same waterfall, ahead of the parser, and neutralizes only the
 * literals the shipped parser would refuse. It asks the shipped decoder itself
 * (`loadCanonicality` imports `decodeSessionReferenceUri` and wraps it), so a
 * mention that works can never be touched, and the ones that would have thrown
 * are rewritten as `dsh-session\:382` — the escaped colon renders as a colon for a
 * Markdown reader, and the raw text no longer contains the literal `dsh-session:`
 * the pattern keys on. Nothing is deleted, and the turn proceeds.
 *
 * The rewrite happens at **listener entrance**, before this listener calls `next`,
 * because the payload's message array is the array the innermost `next` reads:
 * replacing an element there is visible to every consumer downstream, whatever
 * order the listeners were registered in. A second pass runs after `next`, for the
 * one case where a message carrying a refused literal exists only once the chain
 * has been given its chance to add one.
 *
 * ## What it is not
 *
 * It is not the fix, and the message is not what the user wrote. The fix is
 * upstream, and it is small: a `try`/`catch` (or a canonicality check) at the
 * parse call site in `prepareDirectMessages`, plus a payload check that requires
 * a decodable reference rather than a base64url-shaped one. A guard that rewrites
 * text is the second-best answer to a defect that fails a whole turn — but it is
 * an answer available to a deployment that cannot patch the package.
 *
 * It is also not a general text sanitizer: it touches only the messages its
 * guarded parser actually reads (the `user` source, `text` blocks), and leaves
 * everything else byte-identical.
 *
 * @module @argszero/dsh-session-reference-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { decodesCanonically, loadCanonicality, type Canonicality } from './canonical.ts'
import { normalizeConfig, type Config, type Mode } from './config.ts'
import { escapeScheme, neutralizeInPlace, scanMessages } from './rewrite.ts'

/** Cordis plugin name, used by loader diagnostics. */
export const name = 'session-reference-guard'

/**
 * The services this plugin needs before its listener is dispatched.
 *
 * None: the guard reads nothing but the step payload it is handed, so it mounts
 * on any composition that has an agent loop and fails on none that does not.
 */
export const inject: readonly string[] = []

/** The prefix of every diagnostic this plugin logs. */
const LOG_PREFIX = 'session-reference-guard:'

/** Bound on one URI rendered into a log line. */
const URI_LOG_BOUND = 120

/** The last set of URIs a given agent was told about, so a step does not repeat it. */
const reported = new WeakMap<Agent, string>()

/**
 * Install the plugin.
 * @param ctx - the plugin context; the listener is disposed with it.
 * @param config - the configuration as mounted, possibly empty. Defaults are
 *   applied here rather than in an exported `Config` object, because a plain
 *   object under that name is read as a schema by the Loader and makes the plugin
 *   unmountable.
 * @throws {TypeError} when `mode` names no mode this plugin implements.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const settings = normalizeConfig(config)
  if (settings.mode === 'off') return
  // Started once, at mount: the import is a module resolution, and the first step
  // of a session should not be the thing that waits for it.
  const canonicality: Promise<Canonicality> = loadCanonicality().then(shipped => shipped ?? decodesCanonically)

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<PreStepDecision> => {
    if (signal.aborted) return await next()
    const isCanonical = await canonicality
    try {
      const escaped = settings.mode === 'repair'
        ? neutralizeInPlace(messages, isCanonical)
        : scanMessages(messages, isCanonical)
      announce(ctx, agent, escaped, settings.mode)
    } catch (error: unknown) {
      // A guard whose own bug fails a step is a worse failure than the one it
      // answers: report it and let the step proceed unmodified.
      ctx.logger.warn(`${LOG_PREFIX} leaving this step alone: ${String(error)}`)
    }
    const decision = await next()
    if (settings.mode === 'repair' && decision.kind === 'enter') {
      try {
        // A listener inner to this one may have appended a message after the
        // entrance pass; the resolver is outer to nothing here, so this is the
        // only place those are still ahead of it.
        const escaped = neutralizeInPlace(decision.messages, isCanonical)
        announce(ctx, agent, escaped, settings.mode)
      } catch (error: unknown) {
        ctx.logger.warn(`${LOG_PREFIX} leaving this step's later messages alone: ${String(error)}`)
      }
    }
    return decision
  }, { prepend: true })
}

/**
 * Say once per agent what was neutralized, and say nothing when nothing was.
 * @param ctx - the plugin context, for logging.
 * @param agent - the agent whose step this is; the dedup key.
 * @param escaped - the URIs this step neutralized, in order.
 * @param mode - the running mode, which decides the wording.
 */
function announce(ctx: Context, agent: Agent, escaped: readonly string[], mode: Mode): void {
  if (escaped.length === 0) return
  const digest = escaped.join('\n')
  if (reported.get(agent) === digest) return
  reported.set(agent, digest)
  const verb = mode === 'repair' ? 'neutralized' : 'would neutralize'
  const listed = escaped.map(describe).join(', ')
  ctx.logger.warn(`${LOG_PREFIX} ${verb} ${escaped.length} non-canonical session-reference literal(s) in this step: ${listed}`)
}

/**
 * Render one URI for a log line, bounded — and inert.
 *
 * The colon is escaped here too. A warning that quotes a refused literal
 * verbatim is a warning a user can copy into their next message, which is the
 * failure this plugin exists to stop one level down; the escaped form reads the
 * same and cannot be pasted back into a broken turn.
 *
 * @param uri - the refused URI.
 * @returns a quoted, bounded rendering whose text is not itself a literal.
 */
function describe(uri: string): string {
  const escaped = escapeScheme(uri)
  const rendered = escaped.length <= URI_LOG_BOUND ? escaped : `${escaped.slice(0, URI_LOG_BOUND)}…`
  return JSON.stringify(rendered)
}

export default { name, inject, apply }
