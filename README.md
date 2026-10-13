# @argszero/dsh-session-reference-guard

One `dsh-session:` literal that the shipped parser refuses **ends the whole turn**
— and the refusal message contains that literal, so pasting the error to report it
ends the next turn the same way. This plugin joins the same waterfall ahead of the
parser and neutralizes exactly the literals the shipped decoder itself refuses.

A [Cordis](https://github.com/deepseek-ai/deepseek-harness) plugin for the
DeepSeek Harness — an independent npm package, mounted through `dsh.bundle.patch`.
It changes no core package and works on the released lines `0.1.7-rc.2`,
`0.2.0-rc.2` and `0.2.1-alpha.2`.

## The defect

`@deepseek-ai/dsh-session-reference` reads direct user messages at
`agent/pre-step`, in `SessionReferenceResolver.prepareDirectMessages`
(`packages/context/session-reference/src/index.ts:153`):

```ts
const content = message.content.map((block): ContentBlock => {
  if (block.type !== 'text') return block
  const parsed = parseSessionReferenceText(block.text)   // :163 — no try/catch
  ...
```

A throw there is a throw out of the step. The turn ends with `code: UNKNOWN`
before a model is asked anything.

What makes it easy to trigger is that the pattern decides what *could* be a
reference, and the decoder decides what *is* one, and the two do not agree.
`parseSessionReferenceText`'s pattern (`uri.ts:71`) is

```
/@\[((?:\\.|[^\\\]])*)\]\((dsh-session:[^\s)]*)\)|(dsh-session:[A-Za-z0-9_-]+)/gu
```

— it keys on the literal `dsh-session:` and accepts **any base64url-shaped run**
after it. `decodeSessionReferenceUri` is much stricter (`uri.ts:31`, `:36`): the
payload must decode to a JSON string, and re-encoding that string must reproduce
the URI byte for byte. Ordinary text satisfies the first and fails the second:

| Text | Why it is refused |
|---|---|
| `dsh-session:382` | `382` decodes to two invalid UTF-8 bytes; `JSON.parse` throws |
| `dsh-session:abc` | decodes to one invalid byte; `JSON.parse` throws |
| `dsh-session:ImFiYyJ` | decodes to `"abc"`, but base64url's unused trailing bits are not zero, so re-encoding gives `dsh-session:ImFiYyI` — *"URI is not canonical"* |

An issue number, a port, a build tag, a hex-free hash fragment — anything written
after `dsh-session:` is a candidate.

**And it propagates.** The refusal quotes what it refused:

```
invalid session reference URI "dsh-session:382"
```

That message is exactly what a user copies into their next message to report the
failure. The next message contains the literal. The next turn dies the same way,
in the same place. [Discussion
#9613](https://github.com/deepseek-ai/deepseek-harness/discussions/9613) is that
report.

## What it does

The plugin registers one `agent/pre-step` listener with `{ prepend: true }` — the
same seam the resolver reads — and rewrites the payload's message array **at its
own entrance**, before it calls `next()`:

1. **It asks the guarded parser itself.** `loadCanonicality()` imports
   `decodeSessionReferenceUri` from `@deepseek-ai/dsh-session-reference` at mount
   and calls it on each candidate, turning its throw into `false`. The guard
   therefore cannot be **stricter** than the parser it guards — which is the
   failure that would matter, because a mention that works must never be touched.
   When the package cannot be reached, the mirrored predicate in
   `src/canonical.ts` runs instead; `test/canonicality.spec.mjs` pins the two
   against each other over a corpus, so they cannot drift apart in silence.
2. **It breaks only the refused ones**, by escaping the scheme's colon:
   `dsh-session:382` becomes `dsh-session\:382`. `:` is ASCII punctuation, so
   CommonMark reads `\:` as an escaped colon and renders it as one — while the raw
   text no longer contains the literal `dsh-session:` the pattern requires.
   Nothing is deleted; no invisible character is introduced. Rewriting is
   idempotent, which is what lets it run safely both at the entrance and once
   more after `next()`.
3. **It says what it did**, once per agent per literal set, through `ctx.logger`.

### Why the entrance pass is enough, in either registration order

Both listeners register with `{ prepend: true }`, so the resolver may well be the
*outer* one. It does not matter, because the resolver parses the decision its own
`next()` returned (`index.ts:136–140`), and every path to that decision goes
through the array elements the guard already replaced:

- at its entrance the guard has the loop's payload, whose `messages` array *is*
  the array the loop built the step from (`agent-loop/src/agent.ts:275`);
- the loop's terminal returns that same array, or `[...claimed, context]` when
  there is projected runtime context — and an element-wise copy carries the
  replacements with it.

Both directions are measured end to end in `test/guard.spec.mjs`, as is the
`[...claimed, context]` branch.

## Install

```sh
npm install @argszero/dsh-session-reference-guard
```

Then mount it from your profile's bundle patch (`dsh.bundle.patch`):

```yaml
- insert:
    - id: session-reference-guard
      name: '@argszero/dsh-session-reference-guard'
```

Or, if you compose `cordis.yml` by hand:

```yaml
- set:
    - id: session-reference-guard
      name: '@argszero/dsh-session-reference-guard'
      config:
        mode: repair
```

## Configuration

| Key | Values | Default | Meaning |
|---|---|---|---|
| `mode` | `repair` | ✅ | Break each refused literal so the resolver cannot read it, and let the step proceed. |
| | `report` | | Write nothing; log what `repair` would have changed. Diagnostic only — the step still fails in this mode, because the text the resolver rejects is still there. |
| | `off` | | Install no listener at all. |

An unrecognised `mode` is refused at mount rather than quietly replaced, because a
deployment that misspells a mode must not silently get a different one.

## Diagnostics

`repair` reports once per agent — not once per step, because a session that keeps
the text in context would otherwise log a line every turn — naming each literal it
neutralized. It names it the way the rewrite writes it, with the colon escaped:

```
session-reference-guard: neutralized 1 non-canonical session-reference literal(s) in this step: "dsh-session\:382"
```

That rendering is not decoration. The defect this answers *is* a message that
carries its own trigger, so a warning quoting the refused literal verbatim would
be one more place to copy it from; the escaped form reads the same and cannot be
pasted back into a broken turn. `report` mode renders it identically.

## What it is not

- **It is not the fix.** The fix is upstream and it is small: a `try`/`catch` (or
  a canonicality check) around the parse call in `prepareDirectMessages`, and a
  payload check that requires a decodable reference rather than a base64url-shaped
  one. A guard that rewrites text is the second-best answer to a defect that fails
  a whole turn — but it is an answer a deployment can install today.
- **It is not lossless.** The message really is different: where the raw text said
  `dsh-session:382`, it now says `dsh-session\:382`. A Markdown reader renders both
  as `dsh-session:382`; a reader of the raw source — a terminal, a fenced code
  block — sees the backslash. That is the honest outcome for a change the guard
  made, and it is why `report` mode exists.
- **It is not a Markdown-aware parser.** The shipped pattern does not skip code
  fences, so a guard that skipped them would leave the throw exactly where it was.
  It rewrites a literal inside a fence for the same reason the parser refuses one
  there.
- **It is not a general text sanitizer.** It touches only what the resolver reads:
  the `user` source, `text` blocks. Every other message, and every non-text block,
  comes out byte-identical.

## Evidence

- `test/canonicality.spec.mjs` — the mirrored predicate and the encoder are
  asserted against the shipped `decodeSessionReferenceUri` /
  `encodeSessionReferenceUri` over a corpus that contains accepted and refused
  URIs in both shapes, and every degradation path of the loader is exercised.
- `test/rewrite.spec.mjs` — every rewritten text is fed back through the shipped
  `parseSessionReferenceText` and must not throw; every accepted literal must come
  out byte-identical.
- `test/guard.spec.mjs` — the real waterfall through `agentEvents`, the real
  parser behind a listener with the shipped listener's shape, control versus
  mounted on the same message, both registration orders, and the loop's
  context-appending branch.
- `test/packaging.spec.mjs` — the published artifact declares exactly what it
  imports, ships what it promises, and exports a mountable plugin.
- `npm run test:inject` — mutates the source, rebuilds, and requires each mutation
  to be caught by the suite. An arm whose mutation leaves the suite green proves
  nothing about the test that was supposed to hold the line, and is reported as
  `SILENT`.
- `npm run probe:lines` — runs the suite once per released line, which is where
  the supported-lines list above comes from.

## License

MIT.
