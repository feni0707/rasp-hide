/**
 * Юнит-тесты для content/content.js (применение правил) на моках DOM/chrome.
 * Запуск: node tests/content.test.js
 */
'use strict';

const assert = require('assert');

// Модули подключаются как в content script: matcher → ui → content.
global.RASP_HIDE_MATCHER = require('../content/matcher.js');
global.RASP_HIDE_UI = require('../content/ui.js');
const M = global.RASP_HIDE_MATCHER;
const C = require('../content/content.js');

/* ---------- Мок DOM ---------- */

// Проверка соответствия селектора (поддержка используемых в matcher.js).
function matchesSel(node, sel) {
  if (sel === 'b') return node.tagName === 'B';
  if (sel === 'span') return node.tagName === 'SPAN';
  if (sel === 'a[href^="/user_"]') {
    return (
      node.tagName === 'A' &&
      typeof node.getAttribute('href') === 'string' &&
      node.getAttribute('href').startsWith('/user_')
    );
  }
  return false;
}

// DOM-like узел с нужными для content.js методами.
function makeNode(tag, attrs = {}, children = []) {
  const classList = {
    _set: new Set((attrs.class || '').split(/\s+/).filter(Boolean)),
    add(c) { this._set.add(c); },
    remove(c) { this._set.delete(c); },
    contains(c) { return this._set.has(c); },
  };
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    style: {
      display: '',
      setProperty(name, value, priority) {
        this[name] = value + (priority ? ' !important' : '');
      },
    },
    _attrs: { ...attrs },
    classList,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
    },
    setAttribute(name, value) {
      this._attrs[name] = String(value);
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    insertBefore(child, ref) {
      child.parentNode = this;
      const idx = ref ? this.children.indexOf(ref) : this.children.length;
      if (idx === -1) this.children.push(child);
      else this.children.splice(idx, 0, child);
      return child;
    },
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx !== -1) this.children.splice(idx, 1);
      child.parentNode = null;
      return child;
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    },
    querySelector(sel) {
      const stack = [...this.children];
      while (stack.length) {
        const n = stack.shift();
        if (matchesSel(n, sel)) return n;
        if (n.children) stack.push(...n.children);
      }
      return null;
    },
  };
  // className синхронизируется с classList (ui.js задаёт el.className).
  Object.defineProperty(node, 'className', {
    get() { return this._attrs.class || ''; },
    set(v) {
      this._attrs.class = String(v);
      this.classList._set = new Set(String(v).split(/\s+/).filter(Boolean));
    },
  });
  for (const child of children) node.appendChild(child);
  node.textContent = attrs.text != null ? attrs.text : children.map((c) => c.textContent || '').join('');
  return node;
}

// Пара как массив детей клетки: первый <div>(b + span), затем <div> преподавателя.
function pairDiv(name, { type = 'ПР', teacher = null } = {}) {
  const kids = [makeNode('b', { text: type })];
  if (name != null) kids.push(makeNode('span', { text: name }));
  const group = [makeNode('div', {}, kids)];
  if (teacher) {
    group.push(makeNode('div', {}, [makeNode('a', { href: '/user_123', text: teacher })]));
  }
  return group;
}

// Клетка <td> из групп пар, с <hr> между группами при sep=true.
function makeCell(groups, sep = false) {
  const cell = makeNode('td', { class: 'cell' });
  groups.forEach((g, i) => {
    if (i > 0 && sep) cell.appendChild(makeNode('hr'));
    for (const el of g) cell.appendChild(el);
  });
  return cell;
}

// Мок document с таблицей расписания.
function makeSchedule(cells) {
  const table = makeNode('table', { id: 'raspisanie-table' });
  table.querySelectorAll = (sel) => (sel === 'td.cell' ? cells : []);
  const doc = {
    documentElement: makeNode('html'),
    _table: table,
    createElement(tag) { return makeNode(tag); },
    getElementById() { return null; },
    querySelector(sel) {
      if (sel === '#raspisanie-table') return table;
      return null;
    },
  };
  return doc;
}

/* ---------- Мок chrome ---------- */

function makeChromeMock(initial = {}) {
  const state = { enabled: true, style: 'placeholder', rules: [], ...initial };
  const messages = [];
  const chrome = {
    storage: {
      sync: {
        get(keys, cb) {
          const out = {};
          for (const k of keys) out[k] = state[k];
          cb(out);
        },
      },
    },
    runtime: {
      sendMessage(msg) {
        messages.push(msg);
        return Promise.resolve();
      },
    },
  };
  return { chrome, messages, state };
}

// Базовый мок document (createElement/getElementById), переопределяется в processCells-тестах.
global.document = {
  documentElement: makeNode('html'),
  createElement(tag) { return makeNode(tag); },
  getElementById() { return null; },
  querySelector() { return null; },
};

// Правило для тестов.
function rule(subject, teacher = null, enabled = true) {
  return { subject, teacher, enabled };
}

/* ---------- hidePair / restorePair ---------- */

async function testHidePairPlaceholder() {
  const mock = makeChromeMock({ style: 'placeholder', rules: [] });
  global.chrome = mock.chrome;
  await C.loadSettings();

  const cell = makeCell([pairDiv('Математика', { teacher: 'Иванов И. И.' })]);
  const pair = M.splitIntoPairs(cell.children)[0];
  C.hidePair(pair, cell);

  // все элементы пары скрыты
  for (const el of pair) assert.strictEqual(el.style.display, 'none');
  // плейсхолдер вставлен в клетку
  const ph = cell.children.find((c) => c.classList.contains('rh-placeholder'));
  assert.ok(ph, 'плейсхолдер должен быть вставлен');
  assert.strictEqual(ph.textContent, 'скрыто');
}

async function testHidePairIdempotent() {
  const mock = makeChromeMock({ style: 'placeholder', rules: [] });
  global.chrome = mock.chrome;
  await C.loadSettings();

  const cell = makeCell([pairDiv('Математика')]);
  C.hidePair(M.splitIntoPairs(cell.children)[0], cell);
  C.hidePair(M.splitIntoPairs(cell.children)[0], cell);
  const placeholders = cell.children.filter((c) => c.classList.contains('rh-placeholder'));
  assert.strictEqual(placeholders.length, 1, 'повторный прогон не дублирует плейсхолдер');
}

async function testHidePairStrike() {
  const mock = makeChromeMock({ style: 'strike', rules: [] });
  global.chrome = mock.chrome;
  await C.loadSettings();

  const cell = makeCell([pairDiv('Математика')]);
  C.hidePair(M.splitIntoPairs(cell.children)[0], cell);

  for (const el of cell.children) {
    assert.strictEqual(el.style.display, '', 'в strike элементы остаются видимыми');
    assert.ok(el.classList.contains('rh-strike'), 'добавлен класс rh-strike');
  }
  assert.ok(!cell.children.some((c) => c.classList.contains('rh-placeholder')), 'плейсхолдера нет');
}

async function testHrHiddenWithPair() {
  const mock = makeChromeMock({ style: 'placeholder', rules: [] });
  global.chrome = mock.chrome;
  await C.loadSettings();

  const cell = makeCell([pairDiv('Математика'), pairDiv('Физика')], true);
  C.hidePair(M.splitIntoPairs(cell.children)[0], cell);
  const hr = cell.children.find((c) => c.tagName === 'HR');
  assert.strictEqual(hr.style.display, 'none', '<hr> скрывается вместе с парой');

  // возврат — <hr> восстанавливается
  C.restorePair(M.splitIntoPairs(cell.children)[0]);
  assert.strictEqual(hr.style.display, '', '<hr> восстанавливается при возврате');
}

async function testHrKeptInStrike() {
  const mock = makeChromeMock({ style: 'strike', rules: [] });
  global.chrome = mock.chrome;
  await C.loadSettings();

  // Одна пара с двумя преподавателями: <hr> внутри пары — разделитель, не граница пар.
  const cell = makeNode('td', { class: 'cell' });
  const subj = makeNode('div', {}, [makeNode('span', { text: 'АЯ' })]);
  const t1 = makeNode('div', {}, [makeNode('a', { href: '/user_1', text: 'Иванов И. И.' })]);
  const hr = makeNode('hr');
  const t2 = makeNode('div', {}, [makeNode('a', { href: '/user_2', text: 'Петров П. П.' })]);
  for (const el of [subj, t1, hr, t2]) cell.appendChild(el);

  const pair = M.splitIntoPairs(cell.children)[0];
  assert.strictEqual(M.getPairName(pair), 'АЯ', 'вся группа — одна пара');
  C.hidePair(pair, cell);

  for (const el of [subj, t1, t2]) {
    assert.strictEqual(el.style.display, '', 'содержимое пары остаётся видимым');
    assert.ok(el.classList.contains('rh-strike'), 'содержимое пары зачёркнуто');
  }
  assert.strictEqual(hr.style.display, '', '<hr> в strike не скрывается');
  assert.ok(!hr.classList.contains('rh-strike'), '<hr> без класса зачёркивания');

  // возврат — ничего не остаётся от скрытия
  C.restorePair(pair);
  assert.strictEqual(hr.style.display, '');
  assert.ok(!subj.classList.contains('rh-strike'));
}

async function testRestorePair() {
  const mock = makeChromeMock({ style: 'placeholder', rules: [] });
  global.chrome = mock.chrome;
  await C.loadSettings();

  const cell = makeCell([pairDiv('Математика')]);
  C.hidePair(M.splitIntoPairs(cell.children)[0], cell);
  C.restorePair(M.splitIntoPairs(cell.children)[0]);

  for (const el of cell.children) {
    if (el.classList.contains('rh-placeholder')) continue;
    assert.strictEqual(el.style.display, '');
  }
  assert.ok(!cell.children.some((c) => c.classList.contains('rh-placeholder')), 'плейсхолдер удалён');
}

/* ---------- updateCellBackground ---------- */

async function testCellBackgroundTransparentWhenFullyHidden() {
  const mock = makeChromeMock({ style: 'placeholder', rules: [] });
  global.chrome = mock.chrome;
  await C.loadSettings();

  const cell = makeCell([pairDiv('Математика')]);
  cell.setAttribute('style', 'background-color: #fff');
  C.hidePair(M.splitIntoPairs(cell.children)[0], cell);
  C.updateCellBackground(cell);
  assert.strictEqual(cell.style['background-color'], 'transparent !important');

  // возврат — исходный фон восстановлен
  C.restorePair(M.splitIntoPairs(cell.children)[0]);
  C.updateCellBackground(cell);
  assert.strictEqual(cell.getAttribute('style'), 'background-color: #fff');
}

async function testCellBackgroundKeptWhenOneVisible() {
  const mock = makeChromeMock({ style: 'placeholder', rules: [] });
  global.chrome = mock.chrome;
  await C.loadSettings();

  const cell = makeCell([pairDiv('Математика'), pairDiv('Физика')], true);
  cell.setAttribute('style', 'background-color: #fff');
  C.hidePair(M.splitIntoPairs(cell.children)[0], cell);
  C.updateCellBackground(cell);
  assert.strictEqual(cell.getAttribute('style'), 'background-color: #fff', 'фон не трогается');
}

async function testCellBackgroundUntouchedInStrike() {
  const mock = makeChromeMock({ style: 'strike', rules: [] });
  global.chrome = mock.chrome;
  await C.loadSettings();

  const cell = makeCell([pairDiv('Математика')]);
  cell.setAttribute('style', 'background-color: #fff');
  C.hidePair(M.splitIntoPairs(cell.children)[0], cell);
  C.updateCellBackground(cell);
  assert.strictEqual(cell.getAttribute('style'), 'background-color: #fff', 'в strike фон не трогается');
}

/* ---------- processCells / fullRollback ---------- */

async function testProcessCellsCountsAndSends() {
  const mock = makeChromeMock({
    style: 'placeholder',
    rules: [rule('Математика')],
  });
  global.chrome = mock.chrome;
  await C.loadSettings();

  const cell1 = makeCell([pairDiv('Математика')]); // скрывается
  const cell2 = makeCell([pairDiv('Физика')]); // не скрывается
  global.document = makeSchedule([cell1, cell2]);

  C.processCells();

  assert.ok(cell1.children.some((c) => c.classList.contains('rh-placeholder')), 'пара скрыта');
  assert.ok(!cell2.children.some((c) => c.classList.contains('rh-placeholder')), 'другая пара не тронута');
  assert.deepStrictEqual(mock.messages, [{ type: 'count', value: 1 }]);
}

async function testProcessCellsIgnoresNamelessPairs() {
  const mock = makeChromeMock({ style: 'placeholder', rules: [rule('ОВ')] });
  global.chrome = mock.chrome;
  await C.loadSettings();

  const cell = makeCell([pairDiv(null)]); // ОВ/ОС — без названия
  global.document = makeSchedule([cell]);

  C.processCells();

  assert.ok(!cell.children.some((c) => c.classList.contains('rh-placeholder')), 'ОВ/ОС не скрывается');
  assert.deepStrictEqual(mock.messages, [{ type: 'count', value: 0 }]);
}

async function testFullRollback() {
  const mock = makeChromeMock({ style: 'placeholder', rules: [rule('Математика')] });
  global.chrome = mock.chrome;
  await C.loadSettings();

  const cell = makeCell([pairDiv('Математика')]);
  cell.setAttribute('style', 'background-color: #fff');
  global.document = makeSchedule([cell]);

  C.processCells();
  assert.ok(cell.children.some((c) => c.classList.contains('rh-placeholder')));

  C.fullRollback();

  assert.ok(!cell.children.some((c) => c.classList.contains('rh-placeholder')), 'rh-* удалены');
  for (const el of cell.children) assert.strictEqual(el.style.display, '');
  assert.strictEqual(cell.getAttribute('style'), 'background-color: #fff', 'фон восстановлен');
  assert.deepStrictEqual(mock.messages[mock.messages.length - 1], { type: 'off' });
}

/* ---------- Запуск ---------- */

async function run() {
  console.log('content.test.js');
  const tests = [
    ['hidePair: плейсхолдер', testHidePairPlaceholder],
    ['hidePair: идемпотентность', testHidePairIdempotent],
    ['hidePair: strike', testHidePairStrike],
    ['<hr> скрывается и восстанавливается (placeholder)', testHrHiddenWithPair],
    ['<hr> не трогается в strike', testHrKeptInStrike],
    ['restorePair: возврат', testRestorePair],
    ['фон: transparent при полном скрытии', testCellBackgroundTransparentWhenFullyHidden],
    ['фон: не трогается при видимой паре', testCellBackgroundKeptWhenOneVisible],
    ['фон: не трогается в strike', testCellBackgroundUntouchedInStrike],
    ['processCells: счётчик и sendMessage', testProcessCellsCountsAndSends],
    ['processCells: ОВ/ОС не скрывается', testProcessCellsIgnoresNamelessPairs],
    ['fullRollback: полный откат', testFullRollback],
  ];
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('  ok - ' + name);
    } catch (err) {
      failed++;
      console.error('  FAIL - ' + name);
      console.error('    ' + (err && err.message));
    }
  }
  console.log('\nВсего тестов: ' + tests.length + (failed ? ', провалено: ' + failed : ''));
  clearTimeout(watchdog);
  if (failed) process.exit(1);
}

// Страховка: если тест зависнет — аварийно выйти (снимается по завершении).
const watchdog = setTimeout(() => { process.exit(2) }, 10000);

run();
