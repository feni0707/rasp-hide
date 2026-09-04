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
    addEventListener() {},
    removeEventListener() {},
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
    addEventListener() {},
    removeEventListener() {},
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
  C.restorePair(pair, cell);
  assert.strictEqual(hr.style.display, '');
  assert.ok(!subj.classList.contains('rh-strike'));
}

async function testRestorePair() {
  const mock = makeChromeMock({ style: 'placeholder', rules: [] });
  global.chrome = mock.chrome;
  await C.loadSettings();

  const cell = makeCell([pairDiv('Математика')]);
  C.hidePair(M.splitIntoPairs(cell.children)[0], cell);
  C.restorePair(M.splitIntoPairs(cell.children)[0], cell);

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
  C.restorePair(M.splitIntoPairs(cell.children)[0], cell);
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

async function testStrikeRunDoesNotRemovePlaceholders() {
  // Переключение значения/стиля между прогонами порождает «случайный» strike-прогон
  // (MutationObserver/debounce) поверх placeholder-состояния: он НЕ должен уничтожать
  // плейсхолдеры — иначе после возврата в placeholder пары исчезают без «скрыто».
  const mock = makeChromeMock({ style: 'placeholder', rules: [rule('Математика')] });
  global.chrome = mock.chrome;
  await C.loadSettings();

  const cell = makeCell([pairDiv('Математика')]);
  cell.setAttribute('style', 'background-color: #fff');
  global.document = makeSchedule([cell]);

  C.processCells();
  assert.ok(cell.children.some((c) => c.classList.contains('rh-placeholder')), 'placeholder: плейсхолдер создан');

  mock.state.style = 'strike';
  await C.loadSettings();
  C.processCells();
  assert.ok(cell.children.some((c) => c.classList.contains('rh-placeholder')), 'strike-прогон не трогает плейсхолдер');

  mock.state.style = 'placeholder';
  await C.loadSettings();
  C.processCells();
  const phs = cell.children.filter((c) => c.classList.contains('rh-placeholder'));
  assert.strictEqual(phs.length, 1, 'плейсхолдер не задвоился');
  assert.strictEqual(cell.children[0].style.display, 'none', 'пара остаётся скрытой');
  assert.strictEqual(cell.style['background-color'], 'transparent !important', 'фон transparent после возврата');
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

function makeTwoTeacherCell(subject) {
  const cell = makeNode('td', { class: 'cell' });
  const subj = makeNode('div', {}, [makeNode('span', { text: subject })]);
  const t1 = makeNode('div', {}, [makeNode('a', { href: '/user_1', text: 'Аксёнова Н. В.' })]);
  const hr = makeNode('hr');
  const t2 = makeNode('div', {}, [makeNode('a', { href: '/user_2', text: 'Макаровских А. В.' })]);
  for (const el of [subj, t1, hr, t2]) cell.appendChild(el);
  return { cell, subj, t1, hr, t2 };
}

async function testProcessCellsHidesSecondTeacherBlock() {
  // Правило по второму преподавателю скрывает ТОЛЬКО его блок: шапка и первый
  // преподаватель остаются видимыми (поблочное скрытие одной пары).
  const mock = makeChromeMock({
    style: 'placeholder',
    rules: [rule('АЯ д/акад.целей.В1', 'Макаровских А. В.')],
  });
  global.chrome = mock.chrome;
  await C.loadSettings();

  const cell = makeTwoTeacherCell('АЯ д/акад.целей.В1').cell;
  global.document = makeSchedule([cell]);

  C.processCells();

  const t1 = cell.children[1];
  const hr = cell.children[2];
  const t2 = cell.children[3];
  assert.strictEqual(cell.children[0].style.display, '', 'шапка пары видима');
  assert.strictEqual(t1.style.display, '', 'блок Аксёновой видим');
  assert.strictEqual(hr.style.display, 'none', '<hr> скрыт вместе со вторым блоком');
  assert.strictEqual(t2.style.display, 'none', 'блок Макаровских скрыт');

  const ph = cell.children.find((c) => c.classList.contains('rh-placeholder'));
  assert.ok(ph, 'плейсхолдер вставлен после скрытого блока');
  assert.strictEqual(cell.children.indexOf(ph), 4, 'плейсхолдер после второго блока');
  assert.deepStrictEqual(mock.messages, [{ type: 'count', value: 1 }]);
}

async function testProcessCellsHidesSecondTeacherBlockStrike() {
  const mock = makeChromeMock({
    style: 'strike',
    rules: [rule('АЯ д/акад.целей.В1', 'Макаровских А. В.')],
  });
  global.chrome = mock.chrome;
  await C.loadSettings();

  const { cell, subj, t1, hr, t2 } = makeTwoTeacherCell('АЯ д/акад.целей.В1');
  global.document = makeSchedule([cell]);

  C.processCells();

  assert.ok(!subj.classList.contains('rh-strike'), 'шапка не зачёркнута');
  assert.ok(!t1.classList.contains('rh-strike'), 'Аксёнова не зачёркнута');
  assert.ok(t2.classList.contains('rh-strike'), 'Макаровских зачёркнут');
  assert.strictEqual(hr.style.display, '', '<hr> в strike не трогается');
  assert.ok(!cell.children.some((c) => c.classList.contains('rh-placeholder')), 'плейсхолдеров нет');
  assert.deepStrictEqual(mock.messages, [{ type: 'count', value: 1 }]);
}

async function testProcessCellsFullHidePairByAllTeachers() {
  // Оба преподавателя скрыты → скрывается и «шапка», одна «скрыто» на всю пару.
  const mock = makeChromeMock({
    style: 'placeholder',
    rules: [
      rule('АЯ д/акад.целей.В1', 'Аксёнова Н. В.'),
      rule('АЯ д/акад.целей.В1', 'Макаровских А. В.'),
    ],
  });
  global.chrome = mock.chrome;
  await C.loadSettings();

  const { cell, subj, t1, hr, t2 } = makeTwoTeacherCell('АЯ д/акад.целей.В1');
  global.document = makeSchedule([cell]);

  C.processCells();

  for (const el of [subj, t1, hr, t2]) assert.strictEqual(el.style.display, 'none');
  const phs = cell.children.filter((c) => c.classList.contains('rh-placeholder'));
  assert.strictEqual(phs.length, 1, 'одна «скрыто» при полном скрытии пары');
  assert.strictEqual(cell.children.indexOf(phs[0]), 4, 'плейсхолдер после последнего элемента пары');
  assert.strictEqual(M.isCellFullyHidden(cell), true, 'клетка полностью скрыта');
  assert.deepStrictEqual(mock.messages, [{ type: 'count', value: 2 }]);
}

async function testProcessCellsFullHidePairByAllTeachersRule() {
  // «У всех» скрывает всю пару целиком.
  const mock = makeChromeMock({
    style: 'placeholder',
    rules: [rule('АЯ д/акад.целей.В1')],
  });
  global.chrome = mock.chrome;
  await C.loadSettings();

  const { cell, subj, t1, hr, t2 } = makeTwoTeacherCell('АЯ д/акад.целей.В1');
  global.document = makeSchedule([cell]);

  C.processCells();

  for (const el of [subj, t1, hr, t2]) assert.strictEqual(el.style.display, 'none');
  const phs = cell.children.filter((c) => c.classList.contains('rh-placeholder'));
  assert.strictEqual(phs.length, 1);
  assert.deepStrictEqual(mock.messages, [{ type: 'count', value: 2 }]);
}

async function testProcessCellsKeepsPairForOtherTeacher() {
  // Тот же предмет, но правило по другому преподавателю — пара не скрывается.
  const mock = makeChromeMock({
    style: 'placeholder',
    rules: [rule('АЯ д/акад.целей.В1', 'Петров П. П.')],
  });
  global.chrome = mock.chrome;
  await C.loadSettings();

  const cell = makeNode('td', { class: 'cell' });
  const subj = makeNode('div', {}, [makeNode('span', { text: 'АЯ д/акад.целей.В1' })]);
  const t1 = makeNode('div', {}, [makeNode('a', { href: '/user_1', text: 'Аксёнова Н. В.' })]);
  const hr = makeNode('hr');
  const t2 = makeNode('div', {}, [makeNode('a', { href: '/user_2', text: 'Макаровских А. В.' })]);
  for (const el of [subj, t1, hr, t2]) cell.appendChild(el);
  global.document = makeSchedule([cell]);

  C.processCells();

  assert.ok(!cell.children.some((c) => c.classList.contains('rh-placeholder')), 'пара не скрыта');
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

// Регресс: «протухший» дебаунс-таймер после выключения тумблера.
// MutationObserver планирует прогон, пока расширение включено; fullRollback
// снимает таймер, но даже если прогон всё-таки дойдёт до processCells,
// при enabled: false он обязан ничего не делать (REQUIREMENTS §3.4).
async function testProcessCellsDoesNothingWhenDisabled() {
  const mock = makeChromeMock({ enabled: false, style: 'placeholder', rules: [rule('Математика')] });
  global.chrome = mock.chrome;
  await C.loadSettings();

  const cell = makeCell([pairDiv('Математика', { teacher: 'Иванов И. И.' })]);
  global.document = makeSchedule([cell]);

  C.processCells();

  for (const el of cell.children) {
    assert.strictEqual(el.style.display, '', 'при OFF пара не скрывается');
  }
  assert.ok(
    !cell.children.some((c) => c.classList.contains('rh-placeholder')),
    'при OFF плейсхолдер не появляется'
  );
  assert.deepStrictEqual(mock.messages, [], 'при OFF счётчик в SW не уходит');
}

// Клетка позиционируется классом rh-cell, а не инлайн-стилем: инлайн-запись
// position протекала в кэш «исходного» стиля и оставалась после отката.
async function testCellPositionIsClassNotInlineStyle() {
  const mock = makeChromeMock({ style: 'placeholder', rules: [rule('Математика')] });
  global.chrome = mock.chrome;
  await C.loadSettings();

  const cell = makeCell([pairDiv('Математика', { teacher: 'Иванов И. И.' })]);
  cell.setAttribute('style', 'background-color: #fff');
  global.document = makeSchedule([cell]);

  C.processCells();
  assert.ok(cell.classList.contains('rh-cell'), 'клетка помечена классом rh-cell');
  assert.ok(!cell.style.position, 'инлайн-стиль position не пишется');

  C.fullRollback();
  assert.ok(!cell.classList.contains('rh-cell'), 'класс снимается при полном откате');
  assert.strictEqual(cell.getAttribute('style'), 'background-color: #fff', 'стиль клетки исходный');
}

async function testProcessCellsIdempotentHoverButtons() {
  // Регресс-тест зацикливания MutationObserver: ключ контроллера — стабильный
  // DOM-узел (pair[0]), а НЕ массив пары (splitIntoPairs создаёт новый массив
  // каждый прогон). Повторный прогон не должен плодить hover-кнопки/меню.
  const mock = makeChromeMock({ style: 'placeholder', rules: [rule('Математика')] });
  global.chrome = mock.chrome;
  await C.loadSettings();

  const cell = makeCell([pairDiv('Математика', { teacher: 'Иванов И. И.' })]);
  global.document = makeSchedule([cell]);

  C.processCells();
  C.processCells();

  const btns = cell.children.filter((c) => c.classList.contains('rh-hover-btn'));
  assert.strictEqual(btns.length, 1, 'повторный прогон не создаёт лишние hover-кнопки');
  const menus = cell.children.filter((c) => c.classList.contains('rh-menu'));
  assert.strictEqual(menus.length, 1, 'повторный прогон не создаёт лишние меню');
  const phs = cell.children.filter((c) => c.classList.contains('rh-placeholder'));
  assert.strictEqual(phs.length, 1, 'плейсхолдер один');
}

async function testStrikeToPlaceholderRemovesStrike() {
  // Переключение стиля strike → placeholder: зачёркивание снимается,
  // пара скрывается по-новому (display:none + плейсхолдер).
  const mock = makeChromeMock({ style: 'strike', rules: [rule('Математика')] });
  global.chrome = mock.chrome;
  await C.loadSettings();

  const cell = makeCell([pairDiv('Математика')]);
  global.document = makeSchedule([cell]);

  C.processCells();
  assert.ok(cell.children[0].classList.contains('rh-strike'), 'в strike пара зачёркнута');

  mock.state.style = 'placeholder';
  await C.loadSettings();
  C.processCells();

  for (const el of cell.children) {
    if (el.classList.contains('rh-placeholder')) continue;
    if (el.classList.contains('rh-hover-btn')) continue;
    if (el.classList.contains('rh-menu')) continue;
    assert.ok(!el.classList.contains('rh-strike'), 'rh-strike снят после перехода на placeholder');
  }
  assert.strictEqual(cell.children[0].style.display, 'none', 'пара скрыта (placeholder)');
  assert.ok(cell.children.some((c) => c.classList.contains('rh-placeholder')), 'плейсхолдер создан');
}

async function testRollbackFromStrikeRemovesStrike() {
  // Глобальный OFF при активном strike: зачёркивание должно сниматься
  // (раньше не снималось — пара выпадала из splitIntoPairs из-за rh-strike).
  const mock = makeChromeMock({ style: 'strike', rules: [rule('Математика')] });
  global.chrome = mock.chrome;
  await C.loadSettings();

  const cell = makeCell([pairDiv('Математика')]);
  global.document = makeSchedule([cell]);

  C.processCells();
  assert.ok(cell.children[0].classList.contains('rh-strike'), 'в strike пара зачёркнута');

  mock.state.enabled = false;
  await C.loadSettings();
  C.fullRollback();

  for (const el of cell.children) {
    assert.ok(!el.classList.contains('rh-strike'), 'rh-strike снят при полном откате');
    assert.strictEqual(el.style.display, '', 'элементы видимы');
  }
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
    ['переключение стиля: strike не удаляет плейсхолдеры', testStrikeRunDoesNotRemovePlaceholders],
    ['processCells: счётчик и sendMessage', testProcessCellsCountsAndSends],
    ['processCells: ОВ/ОС не скрывается', testProcessCellsIgnoresNamelessPairs],
    ['processCells: второй преподаватель скрывает только свой блок', testProcessCellsHidesSecondTeacherBlock],
    ['processCells: второй преподаватель скрывает блок (strike)', testProcessCellsHidesSecondTeacherBlockStrike],
    ['processCells: оба преподавателя → шапка + одна «скрыто»', testProcessCellsFullHidePairByAllTeachers],
    ['processCells: «у всех» скрывает всю пару', testProcessCellsFullHidePairByAllTeachersRule],
    ['processCells: другой преподаватель не скрывает', testProcessCellsKeepsPairForOtherTeacher],
    ['fullRollback: полный откат', testFullRollback],
    ['processCells: при выключенном тумблере ничего не делает', testProcessCellsDoesNothingWhenDisabled],
    ['клетка позиционируется классом rh-cell, не инлайн-стилем', testCellPositionIsClassNotInlineStyle],
    ['processCells: идемпотентность hover-кнопок', testProcessCellsIdempotentHoverButtons],
    ['переключение стиля: strike → placeholder снимает зачёркивание', testStrikeToPlaceholderRemovesStrike],
    ['полный откат: strike снимается при OFF', testRollbackFromStrikeRemovesStrike],
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
