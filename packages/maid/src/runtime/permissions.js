/**
 * Read-only session detection (`S-09`, `§11.5`).
 *
 * The permission service reports a *preset name*, and the preset carries the
 * sandbox knob. A deployment may name its presets freely, so the name alone is
 * not decisive: the resolved spec's `sandbox` is. `custom` and `auto` have no
 * resolvable bundle and are treated as writable.
 * @module file-maid/runtime/permissions
 */

/**
 * Whether the owning session may not persist anything.
 * @param {object | undefined} ctx - plugin context.
 * @param {object | undefined} session - owning session.
 * @returns {boolean} true for a read-only session.
 */
export function isReadOnlySession(ctx, session) {
  if (session === undefined || session === null) return false;
  // The enforcing source first: tool layers call `ctx.sandboxPolicy.resolve()` for
  // every execution, so a session that reports `read-only` there is the same one whose
  // writes the sandbox refuses. Reading it keeps this plugin's "persist nothing" rule
  // aligned with the sandbox instead of with a preset's display name.
  try {
    const policy = typeof ctx?.get === 'function' ? ctx.get('sandboxPolicy') : undefined;
    if (policy !== undefined && typeof policy.resolve === 'function') {
      const resolved = policy.resolve({ session });
      if (typeof resolved?.mode === 'string') return resolved.mode === 'read-only';
    }
  } catch {
    /* fall through to the preset layer */
  }
  try {
    const presets = typeof ctx?.get === 'function' ? ctx.get('permissionPresets') : undefined;
    if (presets === undefined || typeof presets.current !== 'function') return false;
    const name = presets.current(session);
    if (name === 'read-only') return true;
    if (typeof presets.resolve !== 'function') return false;
    if (name === 'custom' || name === 'auto') return false;
    try {
      const spec = presets.resolve(name);
      return spec?.sandbox === 'read-only';
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}
