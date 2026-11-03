/**
 * catalog.js — static site data (pure, dependency-free, testable in Node).
 *
 * Single source of truth for the bookshelf composition (cover definitions,
 * shelf order) and the featured-projects panel.
 */

/** Front-cover layout boxes for shelf A: [x, y, width, height] in cover-atlas space. */
export const coverA = [
  { box: [6, 0, 386, 575], spine: '#2c4f63', title: 'THE LAST HARBOR' },
  { box: [401, 0, 376, 575], spine: '#195433', title: 'Bright Rivers' },
  { box: [787, 0, 377, 575], spine: '#c62420', title: 'The Quiet Room' },
  { box: [1175, 0, 379, 575], spine: '#f4f3ef', title: 'STILL LIFE' },
  { box: [1564, 0, 377, 575], spine: '#2d86cf', title: 'The Salt Between Us' },
  { box: [1949, 0, 383, 575], spine: '#f7d547', title: 'THE BRIGHTER SIDE' },
  { box: [6, 583, 386, 573], spine: '#494e68', title: 'City of Ash' },
  { box: [401, 583, 376, 573], spine: '#f2ecde', title: 'The Weight of Tomorrow' },
  { box: [787, 583, 377, 573], spine: '#7893a3', title: 'Vanishing Light' },
  { box: [1175, 583, 379, 573], spine: '#0c0b0b', title: 'THE GLASS GARDEN' },
  { box: [1564, 583, 377, 573], spine: '#ddd0c1', title: 'Fragments of Us' },
  { box: [1949, 583, 383, 573], spine: '#013eb0', title: 'Blue Hours' },
  { box: [6, 1164, 386, 578], spine: '#f2f1ed', title: 'THE SILENT BELL' },
  { box: [401, 1164, 376, 578], spine: '#0a291c', title: 'All That Remains' },
  { box: [787, 1164, 377, 578], spine: '#c61111', title: 'The Red Departure' },
  { box: [1175, 1164, 379, 578], spine: '#7f7263', title: 'A Brighter Tomorrow' },
  { box: [1564, 1164, 377, 578], spine: '#ae4716', title: 'NORTH OF NOWHERE' },
  { box: [1949, 1164, 383, 578], spine: '#021f42', title: 'Paper Moons' },
];

/** Front-cover layout boxes for shelf B: [x, y, width, height] in cover-atlas space. */
export const coverB = [
  { box: [3, 2, 383, 574], spine: '#d1cd8c', title: 'The Orchard Year' },
  { box: [394, 2, 381, 574], spine: '#000621', title: 'SIGNAL' },
  { box: [784, 2, 381, 574], spine: '#b8acd3', title: 'Small Hours' },
  { box: [1172, 2, 381, 574], spine: '#e6bd7e', title: "The Cartographer's Daughter" },
  { box: [1562, 2, 381, 574], spine: '#076368', title: 'WILD SALT' },
  { box: [1952, 2, 382, 574], spine: '#ad8357', title: 'Low Tide' },
  { box: [3, 586, 383, 572], spine: '#cfa94d', title: 'The Long Field' },
  { box: [394, 586, 381, 572], spine: '#497f9d', title: 'Houses of Glass' },
  { box: [784, 586, 381, 572], spine: '#02878a', title: 'OPEN WATER' },
  { box: [1172, 586, 381, 572], spine: '#170402', title: 'Nine Lanterns' },
  { box: [1562, 586, 381, 572], spine: '#09150b', title: 'The Understory' },
  { box: [1952, 586, 382, 572], spine: '#f57664', title: 'Velvet Static' },
  { box: [3, 1167, 383, 574], spine: '#f3f3f3', title: 'Lessons in Gravity' },
  { box: [394, 1167, 381, 574], spine: '#2a2929', title: 'THE ARCHIVE' },
  { box: [784, 1167, 381, 574], spine: '#3fb1b9', title: 'Summer, Elsewhere' },
  { box: [1172, 1167, 381, 574], spine: '#6b1405', title: 'Ember & Bone' },
  { box: [1562, 1167, 381, 574], spine: '#ceba9f', title: 'A Map of Quiet Things' },
  { box: [1952, 1167, 382, 574], spine: '#1c565e', title: 'Northern Lights Hotel' },
];

/** Display order of the 32 shelf books; indices point into coverA (0–17) then coverB (18–35). */
export const bookOrder = [0, 22, 5, 30, 9, 13, 26, 2, 19, 11, 33, 7, 15, 24, 4, 28, 17, 21, 1, 31, 14, 8, 25, 35, 3, 18, 10, 29, 16, 23, 6, 34];

/** Featured projects shown in the info panel; books map onto these cyclically. */
export const projects = [
  {
    title: 'Splid',
    label: 'SELECTED PROJECT · 01',
    description: 'Who owes whom, at a glance. A no-backend expense splitter for groups, trips, and flatmates.',
    tags: ['EXPENSES', 'PRIVACY-FIRST', 'WEB APP'],
    live: 'https://splid.unfo.workers.dev/',
    liveLabel: 'Open Splid',
    source: 'https://github.com/unfotable/splid',
  },
  {
    title: 'Syncro',
    label: 'SELECTED PROJECT · 02',
    description: 'Notes, sheets, and boards in one calm browser-based workspace, built to follow your flow.',
    tags: ['PRODUCTIVITY', 'WEB APP', 'OPEN SOURCE'],
    live: 'https://syncro.unfo.workers.dev/',
    liveLabel: 'Open Syncro',
    source: 'https://github.com/unfotable/syncro',
  },
  {
    title: 'Unfochat',
    label: 'SELECTED PROJECT · 03',
    description: 'A project from the unfotable network. Visit the repository for the latest details and source.',
    tags: ['EXPERIMENT', 'OPEN SOURCE', 'HTML'],
    live: '',
    liveLabel: 'Open repository',
    source: 'https://github.com/unfotable/unfochat',
  },
];

/** Resolve a shelf slot to its cover definition. */
export function coverForSlot(slotIndex) {
  const coverIndex = bookOrder[slotIndex];
  if (coverIndex === undefined || coverIndex < 0 || coverIndex >= coverA.length + coverB.length) {
    throw new RangeError(`bookOrder slot ${slotIndex} has no cover (${coverIndex})`);
  }
  return coverIndex < coverA.length ? coverA[coverIndex] : coverB[coverIndex - coverA.length];
}
