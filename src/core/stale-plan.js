/** Stable rejection contract for previews that no longer match their dependencies. */
export function stalePlan(message = 'Notes changed after this preview. Review an updated plan before applying it.') {
  return Object.assign(new Error(message), { code: 'stale_plan' });
}
