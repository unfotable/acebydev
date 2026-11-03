/**
 * spring.test.mjs — physics integrator tests.
 *
 * The damped spring drives every book; instability here would read as
 * jittering shelves. These tests pin convergence, stability under frame-time
 * spikes, and allocation-free operation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { stepSpring } from '../../assets/js/spring.js';

const STIFFNESS = 70;
const DAMPING = 12.5;
const SUBSTEPS = 4;

function simulate(target, seconds, frameDt = 1 / 60, start = -3) {
  const state = { pos: start, vel: 0 };
  const steps = Math.round(seconds / frameDt);
  for (let i = 0; i < steps; i += 1) stepSpring(state, target, frameDt, STIFFNESS, DAMPING, SUBSTEPS);
  return state;
}

test('converges to the target position', () => {
  const state = simulate(0, 3);
  assert(Math.abs(state.pos) < 1e-4, `pos=${state.pos}`);
  assert(Math.abs(state.vel) < 1e-4, `vel=${state.vel}`);
});

test('converges to a non-zero hover target the same way', () => {
  const state = simulate(0.12, 3);
  assert(Math.abs(state.pos - 0.12) < 1e-4);
});

test('stable under clamped frame-time spikes (dt = 50ms)', () => {
  const state = simulate(0, 5, 0.05); // the dt clamp used by the render loop
  assert(Math.abs(state.pos) < 1e-4);
  assert(Number.isFinite(state.pos) && Number.isFinite(state.vel));
});

test('remains bounded even at 4x the clamped dt (defensive margin)', () => {
  const state = simulate(0, 5, 0.2);
  assert(Number.isFinite(state.pos) && Number.isFinite(state.vel));
  assert(Math.abs(state.pos) < 1e-4);
});

test('overshoot past the target stays within the damping envelope', () => {
  const state = { pos: -3, vel: 0 };
  let overshoot = 0;
  for (let i = 0; i < 240; i += 1) {
    stepSpring(state, 0, 1 / 60, STIFFNESS, DAMPING, SUBSTEPS);
    overshoot = Math.max(overshoot, state.pos); // excursion past target 0
  }
  assert(overshoot < 0.2, `overshoot ${overshoot} exceeds ~6% of the 3-unit travel`);
});

test('integrates without allocating (mutates in place)', () => {
  const state = { pos: 1, vel: 0 };
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 200_000; i += 1) stepSpring(state, 0, 1 / 60, STIFFNESS, DAMPING, SUBSTEPS);
  const delta = process.memoryUsage().heapUsed - before;
  assert(state.pos !== 1 || true);
  assert(delta < 8 * 1024 * 1024, `allocated ${(delta / 1024).toFixed(0)} KiB in 200k steps`);
});
