/**
 * catalog.test.mjs — integrity of the static site data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bookOrder, coverA, coverB, coverForSlot, projects } from '../../assets/js/catalog.js';
import { FONT3X5 } from '../../assets/js/cover-art.js';

test('bookOrder selects 32 unique covers from the combined atlas', () => {
  assert.equal(bookOrder.length, 32);
  assert.equal(new Set(bookOrder).size, 32);
  assert.equal(coverA.length + coverB.length, 36);
  for (const idx of bookOrder) {
    assert(Number.isInteger(idx) && idx >= 0 && idx < 36, `index ${idx}`);
  }
});

test('every cover box is a positive rectangle', () => {
  for (const c of [...coverA, ...coverB]) {
    assert.equal(c.box.length, 4);
    for (const dim of c.box) assert(dim >= 0);
    assert(c.box[2] > 0 && c.box[3] > 0, `${c.title} box`);
    assert.match(c.spine, /^#[0-9a-f]{6}$/i);
  }
});

test('every cover title can be rendered by the 3x5 font', () => {
  for (const c of [...coverA, ...coverB]) {
    for (const ch of c.title.toUpperCase()) {
      if (ch === ' ') continue;
      assert(FONT3X5[ch], `${c.title}: glyph "${ch}" missing from FONT3X5`);
    }
  }
});

test('coverForSlot resolves both shelves and rejects invalid slots', () => {
  assert.equal(coverForSlot(0), coverA[0]);   // bookOrder[0] = 0
  assert.equal(coverForSlot(17), coverB[3]);  // bookOrder[17] = 21 → coverB[3]
  assert.equal(coverForSlot(18), coverA[1]);  // bookOrder[18] = 1
  assert.equal(coverForSlot(31), coverB[16]); // bookOrder[31] = 34 → coverB[16]
  assert.throws(() => coverForSlot(32), RangeError);
  assert.throws(() => coverForSlot(-1), RangeError);
});

test('projects are complete and linked', () => {
  assert.equal(projects.length, 3);
  for (const p of projects) {
    assert(p.title && p.label && p.description);
    assert(Array.isArray(p.tags) && p.tags.length > 0);
    assert(p.live || p.source, `${p.title} needs a link`);
    if (p.source) assert.match(p.source, /^https:\/\/github\.com\//);
    if (p.live) assert.match(p.live, /^https:\/\//);
  }
});

test('books map onto projects cyclically', () => {
  for (let i = 0; i < bookOrder.length; i += 1) {
    assert(i % projects.length < projects.length);
  }
});
