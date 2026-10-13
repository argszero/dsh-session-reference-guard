/** The plugin's configuration surface. */

/** The modes this plugin implements, in the order they are documented. */
export const MODES = ['repair', 'report', 'off'] as const

/**
 * What the guard does with a non-canonical reference literal in a step.
 *
 * - `repair` (default) — break the literal so the shipped resolver cannot read
 *   it as a reference, and let the step proceed.
 * - `report` — leave every message untouched and log what `repair` would have
 *   changed. Diagnostic only: the step still fails, because the text the
 *   resolver rejects is still there.
 * - `off` — install no listener at all.
 */
export type Mode = typeof MODES[number]

/** The configuration as mounted. */
export interface Config {
  /** Which of {@link MODES} to run. Defaults to `repair`. */
  readonly mode?: Mode
}

/** The configuration after validation, with every default applied. */
export interface Settings {
  readonly mode: Mode
}

/**
 * Validate the mounted configuration.
 *
 * A plain object exported as `Config` would be read by the Loader as a schema and
 * make the plugin unmountable, so the defaults live here instead — and an
 * unrecognised `mode` is refused rather than quietly replaced, because a
 * deployment that misspells a mode must not silently get a different one.
 * @param config - the configuration as mounted, possibly empty.
 * @returns the resolved settings.
 * @throws {TypeError} when `mode` names no mode this plugin implements.
 */
export function normalizeConfig(config: Config): Settings {
  const requested: string = config.mode ?? 'repair'
  const mode = MODES.find(candidate => candidate === requested)
  if (mode === undefined) {
    throw new TypeError(`session-reference-guard: mode must be one of ${MODES.join(', ')} — got ${JSON.stringify(config.mode)}`)
  }
  return { mode }
}
