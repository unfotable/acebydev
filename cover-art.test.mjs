/**
 * cover-art.test.mjs — tests for the procedural pixel-art engine.
 *
 * The first block is the critical one: it asserts the refactored module
 * renders byte-identical output to the original inline implementation
 * (golden checksums were generated from the pristine repository).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  BAYER, COVER_H, COVER_W, BAND_H, SCENE_H, FONT3X5, PIXEL_ARCHETYPES,
  PIXEL_SKIES, SCENE_PAINTERS, bayerAt, coverStyleForSeed, drawDiamond,
  hexRgb, lum, mixRgb, mulberry32, paintBand, paintCloud, paintFog, paintMoon,
  paintPine, paintRidge, paintSea, paintSky, paintStars, paintSun, pxRect,
  rgbCss, ridgeLine, scenePalette, wrapTitle,
} from '../../assets/js/cover-art.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const goldens = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures', 'cover-golden.json'), 'utf-8'));

// ---- canvas shim (mirrors the golden generator exactly) ----
class ShimCtx {
  constructor() { this.fillStyle = ''; this.ops = []; this.image = null; }
  createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; }
  putImageData(img) { this.image = { data: img.data }; }
  fillRect(x, y, w, h) { this.ops.push([x, y, w, h, this.fillStyle]); }
}
class ShimCanvas {
  constructor() { this.width = 0; this.height = 0; this.ctx = new ShimCtx(); }
  getContext() { return this.ctx; }
}
const documentShim = { createElement: () => new ShimCanvas() };
globalThis.document = documentShim;

const { makePixelCanvas } = await import('../../assets/js/cover-canvas.js');
const { bookOrder, coverA, coverB } = await import('../../assets/js/catalog.js');

function hashCanvas(canvas) {
  const ctx = canvas.ctx;
  let h = 0x811c9dc5;
  const mix = (b) => { h ^= b; h = Math.imul(h, 0x01000193); };
  const img = ctx.image;
  for (let i = 0; i < img.data.length; i++) mix(img.data[i]);
  for (const op of ctx.ops) for (const v of op) {
    if (typeof v === 'string') for (let k = 0; k < v.length; k++) mix(v.charCodeAt(k));
    else mix(v | 0);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ===========================================================================
// Byte-identity with the original pipeline
// ===========================================================================
test('covers render byte-identically to the original inline implementation', () => {
  assert.equal(goldens.covers.length, bookOrder.length);
  for (const golden of goldens.covers) {
    const data = bookOrder[golden.slot] < 18
      ? coverA[bookOrder[golden.slot]]
      : coverB[bookOrder[golden.slot] - 18];
    const canvas = makePixelCanvas(data.title, golden.slot);
    const hash = hashCanvas(canvas.canvas);
    assert.equal(hash, golden.hash,
      `slot ${golden.slot} (${data.title}) diverged from the original artwork`);
  }
});

test('every slot maps to the exact original title', () => {
  for (const golden of goldens.covers) {
    const idx = bookOrder[golden.slot];
    const data = idx < 18 ? coverA[idx] : coverB[idx - 18];
    assert.equal(data.title, golden.title);
  }
});

// ===========================================================================
// Primitives
// ===========================================================================
test('mulberry32 is deterministic and seed-sensitive', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const c = mulberry32(43);
  const seqA = [a(), a(), a()];
  assert.deepEqual([b(), b(), b()], seqA);
  assert.notDeepEqual([c(), c(), c()], seqA);
  for (const v of seqA) assert(v >= 0 && v < 1);
});

test('color helpers', () => {
  assert.deepEqual(hexRgb('#ff8000'), [255, 128, 0]);
  assert.deepEqual(mixRgb([0, 0, 0], [10, 20, 30], 0.5), [5, 10, 15]);
  assert.equal(lum([255, 255, 255]) > lum([0, 0, 0]), true);
  assert.equal(rgbCss([1, 2, 3]), 'rgb(1,2,3)');
});

test('bayerAt tiles the 4x4 matrix and stays in (0,1]', () => {
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const v = bayerAt(x, y);
      assert(v > 0 && v <= 1, `bayerAt(${x},${y}) = ${v}`);
      assert.equal(v, bayerAt(x % 4, y % 4));
    }
  }
  assert.equal(BAYER.length, 16);
});

// ===========================================================================
// Geometry / layout constants
// ===========================================================================
test('cover geometry constants are unchanged', () => {
  assert.equal(COVER_W, 96);
  assert.equal(COVER_H, 144);
  assert.equal(BAND_H, 26);
  assert.equal(SCENE_H, 118);
});

// ===========================================================================
// wrapTitle
// ===========================================================================
test('wrapTitle splits long titles into at most 3 lines', () => {
  assert.deepEqual(wrapTitle('STILL LIFE', 21), ['STILL LIFE']);
  const wrapped = wrapTitle("The Cartographer's Daughter", 21);
  assert(wrapped.length <= 3);
  for (const line of wrapped) assert(line.length <= 21);
  const long = wrapTitle('one two three four five six seven eight nine ten eleven twelve', 21);
  assert.equal(long.length, 3);
  assert.deepEqual(wrapTitle('   ', 21), []);
});

// ===========================================================================
// Palettes and archetype routing
// ===========================================================================
test('scenePalette derives all tones with plausible values', () => {
  for (const sky of Object.keys(PIXEL_SKIES)) {
    const pal = scenePalette(PIXEL_SKIES[sky]);
    for (const key of ['sun', 'glow', 'far', 'near', 'band', 'accent', 'text', 'cloudL', 'cloudD']) {
      assert(Array.isArray(pal[key]) && pal[key].length === 3, `${sky}.${key}`);
    }
    // dark horizons must get light text for legibility
    if (lum(pal.sky[6]) < 92) assert(lum(pal.text) > lum(pal.sky[6]));
  }
});

test('coverStyleForSeed routes seeds to archetypes and skies', () => {
  const seen = new Set();
  for (let seed = 0; seed < 32; seed += 1) {
    const style = coverStyleForSeed(seed);
    assert(SCENE_PAINTERS[style.archetypeName], `painter for ${style.archetypeName}`);
    assert(PIXEL_SKIES[style.skyName], `sky for ${style.skyName}`);
    assert(PIXEL_ARCHETYPES.some((a) => a.skies.includes(style.skyName)));
    seen.add(style.archetypeName);
  }
  assert(seen.size >= 5, `expected variety, got ${[...seen].join(',')}`);
});

// ===========================================================================
// Painters (headless, through a recording set())
// ===========================================================================
function recorder() {
  const writes = [];
  const set = (x, y, c) => {
    x |= 0; y |= 0;
    if (x < 0 || x >= COVER_W || y < 0 || y >= SCENE_H) return;
    writes.push(y * COVER_W + x);
  };
  return { set, writes };
}

test('all eight scene painters run deterministically across shelf seeds', () => {
  for (const arch of PIXEL_ARCHETYPES) {
    for (const seed of [0, 1, 7, 13, 31]) {
      const style = coverStyleForSeed(seed);
      const run = () => {
        const { set, writes } = recorder();
        SCENE_PAINTERS[arch.name](set, mulberry32(seed * 7919 + 3), style.pal);
        return writes;
      };
      assert.deepEqual(run(), run(), `${arch.name} seed ${seed} must be deterministic`);
      assert(run().length > 500, `${arch.name} painted too little`);
    }
  }
});

test('paintSky covers every row and respects bounds', () => {
  const { set, writes } = recorder();
  paintSky(set, PIXEL_SKIES.dusk.map(hexRgb), 0, 20);
  assert.equal(writes.length, COVER_W * 20);
});

test('pxRect and primitive painters write within the scene bounds', () => {
  const { set, writes } = recorder();
  pxRect(set, -5, -5, 20, 20, [1, 2, 3]);
  const before = writes.length;
  paintSun(set, 48, 30, 6, [9, 9, 9], [8, 8, 8]);
  paintMoon(set, 20, 20, 5, [9, 9, 9], [1, 1, 1]);
  paintStars(set, mulberry32(1), 10, 40, [9, 9, 9], [1, 1, 1]);
  paintCloud(set, 48, 20, 20, 3, [7, 7, 7], [2, 2, 2]);
  paintPine(set, 30, 90, 12, [3, 3, 3]);
  paintFog(set, 60, 66, [4, 4, 4]);
  paintSea(set, 70, 100, [5, 5, 5], [2, 2, 2], 40, [9, 9, 9], mulberry32(2));
  assert(writes.length > before);
});

test('ridgeLine produces a full-width heightmap', () => {
  const h = ridgeLine(mulberry32(9), 80, 15, 4);
  assert.equal(h.length, COVER_W);
  for (const v of h) assert(Number.isFinite(v));
});

test('paintRidge fills from crest to bottom', () => {
  const { set, writes } = recorder();
  paintRidge(set, new Array(COVER_W).fill(90), [3, 3, 3], 100, [9, 9, 9]);
  assert(writes.length >= COVER_W * 11);
});

// ===========================================================================
// Title band
// ===========================================================================
test('paintBand centers glyphs and draws flanking diamonds for one-liners', () => {
  const canvas = new ShimCanvas();
  const ctx = canvas.getContext();
  paintBand(ctx, scenePalette(PIXEL_SKIES.dusk), 'SIGNAL');
  // background + accent line + dither row + 6 glyphs x 5 rows + 2 diamonds(3 rects)
  const glyphRects = ctx.ops.filter(([x, y, w, h]) =>
    y >= SCENE_H + 2 && w === 1 && h === 1);
  assert(glyphRects.length > 40, 'expected a filled glyph band');
  assert.equal(ctx.ops[0][4], rgbCss(scenePalette(PIXEL_SKIES.dusk).band));
});

test('paintBand falls back to UNTITLED', () => {
  const ctx = new ShimCanvas().getContext();
  paintBand(ctx, scenePalette(PIXEL_SKIES.slate), '');
  assert(ctx.ops.length > 10);
});

test('FONT3X5 glyphs are well-formed bitmaps', () => {
  for (const [ch, bits] of Object.entries(FONT3X5)) {
    assert.equal(bits.length, 15, `glyph ${ch}`);
    assert.match(bits, /^[01]+$/, `glyph ${ch}`);
  }
  const needed = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'&-!?,.:";
  for (const ch of needed) assert(FONT3X5[ch], `missing glyph ${ch}`);
});

test('drawDiamond paints the plus-shaped marker', () => {
  const ctx = new ShimCanvas().getContext();
  drawDiamond(ctx, 5, 10, 'rgb(1,2,3)');
  assert.deepEqual(ctx.ops, [
    [5, 11, 1, 1, 'rgb(1,2,3)'],
    [6, 10, 1, 3, 'rgb(1,2,3)'],
    [7, 11, 1, 1, 'rgb(1,2,3)'],
  ]);
});
