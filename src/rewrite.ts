/**
 * The rewrite: find every reference-shaped literal the shipped parser would
 * refuse, and break it — without touching anything else.
 *
 * The pattern below is the shipped one (`session-reference/src/uri.ts`,
 * `parseSessionReferenceText`), character for character and alternative for
 * alternative, including the order of the alternatives. That matters: for a
 * malformed Markdown mention the shipped pattern falls through to its bare-text
 * alternative and matches *inside* the parentheses, so a rewrite that only
 * considered whole Markdown mentions would leave the resolver exactly the string
 * it throws on.
 *
 * The rewrite itself is one backslash. `:` is ASCII punctuation, so CommonMark
 * treats `\:` as an escape of `:`, which means `dsh-session\:382` renders as
 * `dsh-session:382` for a reader who sees the rendered form, while the raw text
 * no longer contains the literal `dsh-session:` the pattern requires. Nothing is
 * deleted and no invisible character is introduced: in a context where the
 * backslash is not an escape (a fenced code block, a terminal), the reader sees
 * the text the guard changed, which is the honest outcome for a change the guard
 * made.
 *
 * @module @argszero/dsh-session-reference-guard/rewrite
 */

import { freezeMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_REFERENCE_SCHEME, type Canonicality } from './canonical.ts'

/** The scheme without its colon, so the colon can be escaped instead of the token. */
const SCHEME_HEAD = SESSION_REFERENCE_SCHEME.slice(0, -1)

/** The shipped parser's pattern. Not "similar to" it — the same expression. */
const REFERENCE_PATTERN = /@\[((?:\\.|[^\\\]])*)\]\((dsh-session:[^\s)]*)\)|(dsh-session:[A-Za-z0-9_-]+)/gu

/** What rewriting one text value produced. */
export interface TextRewrite {
  /** The text, with every refused literal neutralized. */
  readonly text: string
  /** The refused URIs, in first-appearance order. */
  readonly escaped: readonly string[]
}

/** What rewriting one message produced. */
export interface MessageRewrite {
  /** A frozen copy of the message, carrying the neutralized text. */
  readonly message: UserMessage
  /** The refused URIs, in first-appearance order. */
  readonly escaped: readonly string[]
}

/**
 * Break the scheme's colon, which is what the pattern keys on.
 * @param uri - a complete `dsh-session:` URI.
 * @returns the same URI with an escaped colon in its scheme.
 */
function escapeScheme(uri: string): string {
  return `${SCHEME_HEAD}\\:${uri.slice(SESSION_REFERENCE_SCHEME.length)}`
}

/**
 * Neutralize every literal in one text value that {@link Canonicality} refuses.
 *
 * A literal the predicate accepts is returned untouched — the call is the guard's
 * only opinion, and the predicate is the shipped decoder's, so a working mention
 * can never be damaged by this function.
 * @param text - the text to rewrite.
 * @param isCanonical - the predicate, normally the shipped decoder wrapped.
 * @returns the rewritten text and the URIs that were neutralized.
 */
export function neutralizeText(text: string, isCanonical: Canonicality): TextRewrite {
  const escaped: string[] = []
  const rewritten = text.replace(REFERENCE_PATTERN, (
    match: string,
    _label: string | undefined,
    markdownUri: string | undefined,
    bareUri: string | undefined,
  ): string => {
    const uri = markdownUri ?? bareUri
    /* v8 ignore next -- the pattern's two alternatives always capture exactly one URI */
    if (uri === undefined) return match
    if (isCanonical(uri)) return match
    escaped.push(uri)
    const neutralized = escapeScheme(uri)
    // A bare match IS the URI; a Markdown match is `@[label](` + URI + `)`.
    return match === uri ? neutralized : `${match.slice(0, match.length - uri.length - 1)}${neutralized})`
  })
  return { text: rewritten, escaped }
}

/**
 * Rewrite one message when, and only when, it is one the resolver reads.
 *
 * The two conditions mirror `SessionReferenceResolver.prepareDirectMessages`:
 * the message must carry the `user` source, and only `text` blocks are parsed.
 * Anything else is returned untouched, so the guard's footprint is exactly the
 * surface of the defect.
 * @param message - the candidate message.
 * @param isCanonical - the predicate.
 * @returns the replacement message and what was neutralized, or `undefined` when
 *   this message carries nothing the resolver would refuse.
 */
export function rewriteMessage(message: UserMessage, isCanonical: Canonicality): MessageRewrite | undefined {
  if (message.source.kind !== 'user') return undefined
  const escaped: string[] = []
  let changed = false
  const content = message.content.map((block): ContentBlock => {
    if (block.type !== 'text') return block
    const { text, escaped: found } = neutralizeText(block.text, isCanonical)
    if (found.length === 0) return block
    changed = true
    escaped.push(...found)
    return { ...block, text }
  })
  if (!changed) return undefined
  // The replacement is built the way the resolver builds its own rewrites — it
  // freezes each prepared message with `freezeMessage` — and it keeps the
  // identity, because the inbox tracks a claimed message by its `id`.
  return { message: freezeMessage({ ...message, content }), escaped }
}

/**
 * Rewrite a batch of messages in place, replacing each one that carried a
 * refused literal.
 *
 * In place is the point. At the entrance of a waterfall listener the payload's
 * array is the array the innermost `next` will read, so replacing an element here
 * is seen by every consumer downstream of the chain — whatever order the
 * listeners happen to have been registered in.
 * @param messages - the batch to rewrite.
 * @param isCanonical - the predicate.
 * @returns every URI that was neutralized, in batch order.
 */
export function neutralizeInPlace(messages: UserMessage[], isCanonical: Canonicality): readonly string[] {
  const escaped: string[] = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message === undefined) continue
    const rewrite = rewriteMessage(message, isCanonical)
    if (rewrite === undefined) continue
    messages[index] = rewrite.message
    escaped.push(...rewrite.escaped)
  }
  return escaped
}

/**
 * Count what {@link neutralizeInPlace} would change, without changing anything.
 * @param messages - the batch to inspect.
 * @param isCanonical - the predicate.
 * @returns every URI that would be neutralized, in batch order.
 */
export function scanMessages(messages: readonly UserMessage[], isCanonical: Canonicality): readonly string[] {
  const escaped: string[] = []
  for (const message of messages) {
    if (message.source.kind !== 'user') continue
    for (const block of message.content) {
      if (block.type !== 'text') continue
      escaped.push(...neutralizeText(block.text, isCanonical).escaped)
    }
  }
  return escaped
}
