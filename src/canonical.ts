/**
 * "Would the shipped parser resolve this URI?" — the one question the guard asks.
 *
 * The predicate is deliberately **not** a re-implementation when the shipped
 * parser can be reached: `loadCanonicality` imports
 * `@deepseek-ai/dsh-session-reference` at runtime and makes the shipped
 * `decodeSessionReferenceUri` the oracle, wrapped so that its throw becomes
 * `false`. That is the same call the resolver makes on the same string, so the
 * guard cannot disagree with the parser it is guarding — including about the
 * canonicality re-encode at the end of the decoder, which is the half a
 * hand-written predicate most easily gets wrong.
 *
 * {@link decodesCanonically} is the same rule written out, and it is what runs
 * when the package cannot be reached. It matters less than it looks: a
 * deployment without `@deepseek-ai/dsh-session-reference` has no parser to throw,
 * so the guard has nothing to guard. It exists so that a missing import degrades
 * to a working guard rather than to a plugin that silently does nothing, and it
 * is pinned against the shipped function by `test/canonicality.spec.mjs`.
 *
 * @module @argszero/dsh-session-reference-guard/canonical
 */

/** The URI scheme reserved for session references (`session-reference/src/uri.ts`). */
export const SESSION_REFERENCE_SCHEME = 'dsh-session:'

/**
 * The payload alphabet the shipped decoder tests before it decodes
 * (`session-reference/src/uri.ts`, `decodeSessionReferenceUri`).
 */
const PAYLOAD = /^[A-Za-z0-9_-]+$/

/**
 * Would the shipped parser resolve this URI?
 *
 * `true` means `@deepseek-ai/dsh-session-reference`'s `decodeSessionReferenceUri`
 * returns for this exact string; `false` means it throws, which in the resolver's
 * `prepareDirectMessages` is a throw with no `try`/`catch` around it.
 */
export type Canonicality = (uri: string) => boolean

/**
 * Encode a session id exactly as `encodeSessionReferenceUri` does.
 * @param sessionId - the id to serialize.
 * @returns the canonical URI.
 */
export function encodeReferenceUri(sessionId: string): string {
  return `${SESSION_REFERENCE_SCHEME}${Buffer.from(JSON.stringify(sessionId), 'utf8').toString('base64url')}`
}

/**
 * The mirrored predicate: decode the payload, require a string, and require the
 * re-encoding to be byte-identical to the URI that was handed in.
 *
 * The last step is the one that makes canonicality a property of the whole URI
 * rather than of the alphabet. `dsh-session:ImFiYyJ` is alphabet-valid and
 * decodes to the string `"abc"` — and is still refused, because base64url's
 * unused trailing bits must be zero and re-encoding gives
 * `dsh-session:ImFiYyI`. A predicate that stopped at "does it parse" would call
 * that URI canonical, let it through, and let the resolver throw on it.
 * @param uri - a candidate URI.
 * @returns whether the shipped decoder would accept it.
 */
export function decodesCanonically(uri: string): boolean {
  if (!uri.startsWith(SESSION_REFERENCE_SCHEME)) return false
  const payload = uri.slice(SESSION_REFERENCE_SCHEME.length)
  if (!PAYLOAD.test(payload)) return false
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof parsed !== 'string') return false
    return encodeReferenceUri(parsed) === uri
  } catch {
    return false
  }
}

/**
 * Load the shipped decoder and express it as a {@link Canonicality}.
 *
 * Never rejects: a package that is absent, broken, or simply not the version
 * that exports the decoder returns `undefined`, and the caller falls back to
 * {@link decodesCanonically}.
 * @param load - how to reach the module; the default is the real import, and the
 *   seam exists so the fallback path can be exercised rather than assumed.
 * @returns the predicate, or `undefined` when the shipped decoder is unreachable.
 */
export async function loadCanonicality(load: () => Promise<unknown> = defaultLoad): Promise<Canonicality | undefined> {
  try {
    const module: unknown = await load()
    const decode = (module as { decodeSessionReferenceUri?: unknown }).decodeSessionReferenceUri
    if (typeof decode !== 'function') return undefined
    const decoder = decode as (uri: string) => unknown
    return uri => {
      try {
        decoder(uri)
        return true
      } catch {
        return false
      }
    }
  } catch {
    return undefined
  }
}

/**
 * Import the guarded package by name.
 *
 * The specifier is written out rather than held in a constant because the
 * package's own packaging guard reads the built artifact for bare specifiers —
 * it walks the emitted JavaScript and every import it can see — and a dynamic
 * import of a variable is invisible to it. One source of truth beats two.
 * @returns the module namespace.
 */
function defaultLoad(): Promise<unknown> {
  return import('@deepseek-ai/dsh-session-reference')
}
