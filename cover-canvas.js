/**
 * cover-canvas.js — DOM bridge of the cover-art engine.
 *
 * The only place where the pure pixel-art pipeline (cover-art.js) touches the
 * DOM: it owns the <canvas> element, the ImageData buffer and the bounds-
 * checked set() writer. Keeping it separate lets cover-art.js run headless.
 */
import {
  BAND_H, COVER_H, COVER_W, SCENE_H, SCENE_PAINTERS, PIXEL_ARCHETYPES,
  PIXEL_SKIES, mulberry32, paintBand, scenePalette,
} from './cover-art.js';

/**
 * Render a procedural pixel-art cover.
 *
 * @param {string} title book title printed in the title band
 * @param {number} seed  deterministic seed (slot index)
 * @returns {{canvas: HTMLCanvasElement, deep: string, arch: string, sky: string}}
 */
export function makePixelCanvas(title, seed) {
  const rng = mulberry32((seed + 1) * 0x9E3779B1);
  const arch = PIXEL_ARCHETYPES[(seed * 5 + (seed >> 3)) % PIXEL_ARCHETYPES.length];
  const skyName = arch.skies[Math.floor(seed / 8) % arch.skies.length];
  const pal = scenePalette(PIXEL_SKIES[skyName]);
  const canvas = document.createElement('canvas');
  canvas.width = COVER_W;
  canvas.height = COVER_H;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(COVER_W, SCENE_H);
  const set = (x, y, c) => {
    x |= 0; y |= 0;
    if (x < 0 || x >= COVER_W || y < 0 || y >= SCENE_H) return;
    const o = (y * COVER_W + x) * 4;
    img.data[o] = c[0] | 0; img.data[o + 1] = c[1] | 0; img.data[o + 2] = c[2] | 0; img.data[o + 3] = 255;
  };
  SCENE_PAINTERS[arch.name](set, rng, pal);
  ctx.putImageData(img, 0, 0);
  paintBand(ctx, pal, title);
  return { canvas, deep: rgbCssOf(pal.band), arch: arch.name, sky: skyName };
}

function rgbCssOf(c) {
  return 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')';
}

export { BAND_H, COVER_H, COVER_W, SCENE_H };
