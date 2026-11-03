/**
 * chat.test.mjs — functional tests for the legacy chat page (script.js).
 *
 * script.js is a classic (non-module) script coupled to the DOM. These tests
 * run it inside node:vm with a minimal DOM/localStorage stub, then drive the
 * captured event handlers — no jsdom, no extra dependencies.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, '..', '..', 'script.js'), 'utf-8');

function makeElement(tag) {
  const el = {
    tag,
    children: [],
    className: '',
    textContent: '',
    dataset: {},
    listeners: {},
    style: {},
    scrollTop: 0,
    scrollHeight: 100,
    focus() {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    dispatch(type, event = {}) { for (const fn of this.listeners[type] || []) fn(event); },
    appendChild(child) {
      if (child.isFragment) {
        for (const c of child.children) this.children.push(c);
        child.children.length = 0;
        return child;
      }
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i !== -1) this.children.splice(i, 1);
    },
    replaceChildren(...kids) {
      this.children.length = 0;
      for (const k of kids) this.children.push(k);
    },
    get firstChild() { return this.children[0] ?? null; },
  };
  return el;
}

function boot(storage) {
  const messages = makeElement('div#messages');
  const views = {
    'view-chat': makeElement('section#view-chat'),
    'view-id': makeElement('section#view-id'),
  };
  const tabs = [makeElement('button.tab'), makeElement('button.tab')];
  tabs[0].dataset.view = 'chat';
  tabs[1].dataset.view = 'id';
  const elements = {
    messages,
    'chat-form': makeElement('form#chat-form'),
    'chat-input': makeElement('input#chat-input'),
    'current-id': makeElement('div#current-id'),
    'make-id': makeElement('button#make-id'),
    'view-chat': views['view-chat'],
    'view-id': views['view-id'],
  };
  const ctx = {
    document: {
      querySelectorAll: (sel) => (sel === '.tab' ? tabs : []),
      getElementById: (id) => elements[id] ?? null,
      createElement: (tag) => makeElement(tag),
      createDocumentFragment: () => { const f = makeElement('#fragment'); f.isFragment = true; return f; },
    },
    localStorage: storage,
    crypto: globalThis.crypto,
    console,
    performance: { now: () => Date.now() },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'script.js' });
  return { ctx, tabs, views, elements };
}

const storageBacked = () => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, val) => map.set(k, String(val)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
};

test('boots with Chat view active and empty-state intact', () => {
  const { elements } = boot(storageBacked());
  assert.equal(elements['current-id'].textContent, '----');
});

test('submitting a message stores it, renders a bubble, clears the input', () => {
  const s = storageBacked();
  const { elements } = boot(s);
  elements['chat-input'].value = '  hello shelf  ';
  elements['chat-form'].dispatch('submit', { preventDefault() {} });
  const stored = JSON.parse(s.getItem('chat_messages'));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].text, 'hello shelf');
  assert.equal(stored[0].self, true);
  assert.equal(elements.messages.children.length, 1);
  assert.equal(elements.messages.children[0].textContent, 'hello shelf');
  assert.equal(elements.messages.children[0].className, 'bubble self');
  assert.equal(elements['chat-input'].value, '');
});

test('blank input is ignored', () => {
  const s = storageBacked();
  const { elements } = boot(s);
  elements['chat-input'].value = '   ';
  elements['chat-form'].dispatch('submit', { preventDefault() {} });
  assert.equal(s.getItem('chat_messages'), null);
  assert.equal(elements.messages.children.length, 0);
});

test('history is capped at MAX_MESSAGES on both store and DOM', () => {
  const s = storageBacked();
  const { elements } = boot(s);
  for (let i = 0; i < 210; i += 1) {
    elements['chat-input'].value = `m${i}`;
    elements['chat-form'].dispatch('submit', { preventDefault() {} });
  }
  const stored = JSON.parse(s.getItem('chat_messages'));
  assert.equal(stored.length, 200);
  assert.equal(stored[0].text, 'm10'); // oldest dropped
  assert.equal(stored[199].text, 'm209');
  assert(elements.messages.children.length <= 200);
});

test('pre-existing messages render on boot', () => {
  const s = storageBacked();
  s.setItem('chat_messages', JSON.stringify([
    { text: 'old one', self: false, time: 1 },
    { text: 'old two', self: true, time: 2 },
  ]));
  const { elements } = boot(s);
  assert.equal(elements.messages.children.length, 2);
  assert.equal(elements.messages.children[0].className, 'bubble other');
});

test('corrupt history is treated as empty (no crash)', () => {
  const s = storageBacked();
  s.setItem('chat_messages', '{not json');
  const { elements } = boot(s);
  assert.equal(elements.messages.children.length, 0);
});

test('tab switching toggles the active view', () => {
  const { tabs, views } = boot(storageBacked());
  tabs[0].dispatch('click');
  assert.equal(views['view-chat'].classList.contains('active'), true);
  tabs[1].dispatch('click');
  assert.equal(views['view-id'].classList.contains('active'), true);
  assert.equal(views['view-chat'].classList.contains('active'), false);
  assert.equal(tabs[1].classList.contains('active'), true);
  assert.equal(tabs[0].classList.contains('active'), false);
});

test('make-id generates XXXX-XXXX-XXXX-XXXX and persists it', () => {
  const s = storageBacked();
  const { elements } = boot(s);
  elements['make-id'].dispatch('click');
  const id = elements['current-id'].textContent;
  assert.match(id, /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.equal(s.getItem('my_id'), id);
  elements['make-id'].dispatch('click');
  assert.notEqual(elements['current-id'].textContent, id); // replaced every time
});

test('storage failures never break the UI (quota/privacy mode)', () => {
  const failing = {
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: () => {},
  };
  const { elements } = boot(failing);
  elements['chat-input'].value = 'still works';
  elements['chat-form'].dispatch('submit', { preventDefault() {} });
  assert.equal(elements.messages.children.length, 1);
  elements['make-id'].dispatch('click');
  assert.match(elements['current-id'].textContent, /^[0-9A-F]{4}-/);
});
