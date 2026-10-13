/**
 * Defect injection: mutate the source, rebuild, run the suite, and require that
 * the mutation is caught. An arm whose mutation leaves the suite green is SILENT —
 * it proves nothing about the test that was supposed to hold the line.
 *
 * The suite imports `lib/*.js`, not `src/*.ts`, so every arm rebuilds with tsc
 * first; a mutation that fails to type-check proves nothing either, and is
 * reported separately as UNBUILDABLE. The source is restored **and rebuilt**
 * whatever happened: an injector that can leave a mutation (or a stale `lib/`) in
 * the tree would be worse than no injector, and a stale `lib/` is exactly how an
 * arm goes SILENT.
 *
 * Every mutation here is a defect this plugin could plausibly ship — a predicate
 * loosened, a gate inverted, a pass dropped, a bookkeeping map left behind. None
 * is engineered to be caught: each names the shape of mistake the arm exists for.
 *
 * The whole suite runs for every arm (it takes a fraction of a second), so an arm
 * may be caught by more than one test; what is asserted is that SOMETHING goes
 * red, which is the only thing a mutation can prove on its own.
 *
 * Run from the plugin root: `npm run test:inject`.
 *
 * The control arm is the unmutated suite, run first: every mutant is compared
 * against a suite that is known green, so a manifest-wide failure (a broken
 * dependency, a missing build) cannot be mistaken for a caught defect.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const SUITE = '*.spec.mjs'

const MUTATIONS = [
  {
    name: 'the canonicality re-encode is dropped, so a URI whose trailing bits are not zero counts as canonical',
    file: 'src/canonical.ts',
    edits: [['    return encodeReferenceUri(parsed) === uri', '    return true']],
  },
  {
    name: 'the mirrored alphabet is narrowed to digits, so an accepted mention is refused and broken',
    file: 'src/canonical.ts',
    edits: [['const PAYLOAD = /^[A-Za-z0-9_-]+$/', 'const PAYLOAD = /^[0-9]+$/']],
  },
  {
    name: 'the loader rejects instead of degrading, so a deployment without the guarded package cannot mount',
    file: 'src/canonical.ts',
    edits: [[
      '  } catch {\n    return undefined\n  }\n}',
      '  } catch (error: unknown) {\n    throw error\n  }\n}',
    ]],
  },
  {
    name: 'the oracle never calls the decoder, so every literal it is asked about is called canonical',
    file: 'src/canonical.ts',
    edits: [['        decoder(uri)\n        return true', '        return true']],
  },
  {
    name: 'the escape is dropped, so the literal the resolver refuses is handed to it unchanged',
    file: 'src/rewrite.ts',
    edits: [['  return `${SCHEME_HEAD}\\\\:${uri.slice(SESSION_REFERENCE_SCHEME.length)}`', '  return `${SCHEME_HEAD}:${uri.slice(SESSION_REFERENCE_SCHEME.length)}`']],
  },
  {
    name: 'a backslash is put in front of the whole URI, which still contains the literal the pattern keys on',
    file: 'src/rewrite.ts',
    edits: [['  return `${SCHEME_HEAD}\\\\:${uri.slice(SESSION_REFERENCE_SCHEME.length)}`', '  return `\\\\${uri}`']],
  },
  {
    name: 'the predicate is inverted, so accepted mentions are broken and refused literals are left for the resolver',
    file: 'src/rewrite.ts',
    edits: [['    if (isCanonical(uri)) return match', '    if (!isCanonical(uri)) return match']],
  },
  {
    name: 'the Markdown branch drops the closing parenthesis, so the mention it rewrote is left malformed',
    file: 'src/rewrite.ts',
    edits: [['    return match === uri ? neutralized : `${match.slice(0, match.length - uri.length - 1)}${neutralized})`', '    return match === uri ? neutralized : `${match.slice(0, match.length - uri.length - 1)}${neutralized}`']],
  },
  {
    name: 'the source gate reads the wrong kind, so a message the resolver never reads is rewritten too',
    file: 'src/rewrite.ts',
    edits: [["  if (message.source.kind !== 'user') return undefined", "  if (message.source.kind !== 'model') return undefined"]],
  },
  {
    name: 'the rewritten block is discarded, so the replaced message still carries the original text',
    file: 'src/rewrite.ts',
    edits: [['    return { ...block, text }', '    return block']],
  },
  {
    name: 'the changed flag is inverted, so a rewritten message is dropped instead of returned',
    file: 'src/rewrite.ts',
    edits: [['  if (!changed) return undefined', '  if (changed) return undefined']],
  },
  {
    name: 'the batch rewrite stops replacing elements, so the resolver still reads the original literal',
    file: 'src/rewrite.ts',
    edits: [['    messages[index] = rewrite.message', '    messages[index] = message']],
  },
  {
    name: 'the cancellation check is inverted, so an ordinary step is passed through and nothing is rewritten',
    file: 'src/index.ts',
    edits: [['    if (signal.aborted) return await next()', '    if (!signal.aborted) return await next()']],
  },
  {
    name: 'report mode writes after all, so a diagnostic deployment rewrites the message it only meant to count',
    file: 'src/index.ts',
    edits: [[
      "      const escaped = settings.mode === 'repair'\n        ? neutralizeInPlace(messages, isCanonical)\n        : scanMessages(messages, isCanonical)",
      '      const escaped = neutralizeInPlace(messages, isCanonical)',
    ]],
  },
  {
    name: 'the guard rethrows its own failure, so one malformed payload fails the step it was meant to protect',
    file: 'src/index.ts',
    edits: [[
      "      ctx.logger.warn(`${LOG_PREFIX} leaving this step alone: ${String(error)}`)\n    }",
      "      ctx.logger.warn(`${LOG_PREFIX} leaving this step alone: ${String(error)}`)\n      throw error\n    }",
    ]],
  },
  {
    name: 'the second pass is dropped, so a message appended by an inner listener keeps its literal',
    file: 'src/index.ts',
    edits: [['        const escaped = neutralizeInPlace(decision.messages, isCanonical)', '        const escaped = neutralizeInPlace([], isCanonical)']],
  },
  {
    name: 'the per-agent report record is never matched, so every step of a session logs again',
    file: 'src/index.ts',
    edits: [['  if (reported.get(agent) === digest) return', "  if (reported.get(agent) === digest + '\\n') return"]],
  },
  {
    name: 'repair stops being the default, so a deployment that configures nothing only reports',
    file: 'src/config.ts',
    edits: [["  const requested: string = config.mode ?? 'repair'", "  const requested: string = config.mode ?? 'report'"]],
  },
  {
    name: 'the mode is not validated, so a misspelled mode mounts and quietly gets a different one',
    file: 'src/config.ts',
    edits: [[
      '  const mode = MODES.find(candidate => candidate === requested)',
      '  const mode = MODES.find(candidate => candidate === candidate)',
    ]],
  },
]

/** Rebuild `lib/` from `src/`; true when tsc accepted the tree. */
function build() {
  try {
    execFileSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')], { cwd: ROOT, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/** Run the suite; true when it failed, plus its output. */
function runSuite() {
  try {
    execFileSync(process.execPath, ['--test', `test/${SUITE}`], { cwd: ROOT, stdio: 'pipe' })
    return { failed: false, output: '' }
  } catch (error) {
    return { failed: true, output: String(error.stdout ?? '') + String(error.stderr ?? '') }
  }
}

// The control arm: the unmutated tree. A suite that is red on its own makes every
// CAUGHT below meaningless, so it is asserted rather than assumed.
if (!build()) {
  console.log('CONTROL UNBUILDABLE: src/ does not compile, no arm below proves anything')
  process.exit(1)
}
const control = runSuite()
if (control.failed) {
  console.log('CONTROL RED: the unmutated suite fails, no arm below proves anything')
  console.log(control.output)
  process.exit(1)
}
console.log('CONTROL: the unmutated suite is green')

let silent = 0
let unbuildable = 0
let missing = 0
for (const mutation of MUTATIONS) {
  const path = join(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  let mutated = original
  let anchored = true
  for (const [find, replace] of mutation.edits) {
    if (!original.includes(find)) {
      anchored = false
      console.log(`SKIP (anchor missing): ${mutation.name}`)
    }
    mutated = mutated.replace(find, replace)
  }
  if (!anchored) {
    missing += 1
    continue
  }

  writeFileSync(path, mutated)
  let built = false
  let result = { failed: false, output: '' }
  try {
    built = build()
    if (built) result = runSuite()
  } finally {
    // Restore the source and rebuild, whatever happened: leaving either a mutation
    // or a stale `lib/` behind is the failure mode this file exists to avoid.
    writeFileSync(path, original)
    build()
  }

  if (!built) {
    unbuildable += 1
    console.log(`UNBUILDABLE (proves nothing): ${mutation.name}`)
    continue
  }
  const caught = result.failed && /fail [1-9]/.test(result.output)
  if (!caught) silent += 1
  console.log(`${caught ? 'CAUGHT' : 'SILENT'}: ${mutation.name}`)
}
console.log(`SILENT ARMS: ${silent === 0 ? 'none' : String(silent)}; UNBUILDABLE: ${String(unbuildable)}; ANCHOR MISSING: ${String(missing)}`)
if (silent > 0 || unbuildable > 0 || missing > 0) process.exit(1)
