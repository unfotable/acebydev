/**
 * spring.js — damped spring integrator used by the book physics.
 *
 * Pure math, no DOM/THREE. Extracted from the render loop so the smoothness-
 * critical integration can be regression-tested in Node (stability under
 * frame-time spikes, convergence, zero-allocation by design).
 */

/**
 * Advance a damped spring toward `target` using fixed substeps.
 *
 * @param {{pos: number, vel: number}} state  mutated in place
 * @param {number} target    resting position
 * @param {number} dt        frame delta in seconds (clamped by caller)
 * @param {number} stiffness spring constant (original: 70)
 * @param {number} damping   velocity damping (original: 12.5)
 * @param {number} substeps  fixed integration substeps (original: 4)
 */
export function stepSpring(state, target, dt, stiffness = 70, damping = 12.5, substeps = 4) {
  const h = dt / substeps;
  for (let i = 0; i < substeps; i += 1) {
    state.vel += ((target - state.pos) * stiffness - state.vel * damping) * h;
    state.pos += state.vel * h;
  }
  return state;
}
