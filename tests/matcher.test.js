/**
 * Юнит-тесты для content/matcher.js (Node, без chrome API).
 * Запуск: npm test
 */
'use strict';

const assert = require('assert');
const M = require('../content/matcher.js');

/* ---------- Утилиты для сборки DOM-like моков ---------- */

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

// Создаёт DOM-like узел с querySelector по поддереву.
function el(tag, attrs = {}, children = []) {
  const node = {
    tagName: String(tag).toUpperCase(),
    style: {},
    children,
    classList: {
      contains: (c) => (attrs.class || '').split(/\s+/).includes(c),
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    setAttribute() {},
    querySelector(sel) {
      const stack = [...children];
      while (stack.length) {
        const n = stack.shift();
        if (matchesSel(n, sel)) return n;
        if (n.children) stack.push(...n.children);
      }
      return null;
    },
  };
  node.textContent = attrs.text != null ? attrs.text : children.map((c) => c.textContent || '').join('');
  return node;
}

// Пара как массив детей клетки: первый <div>(b + span), затем <div> преподавателя.
function pairDiv(name, { type = 'ПР', teacher = null } = {}) {
  const kids = [el('b', { text: type })];
  if (name != null) kids.push(el('span', { text: name }));
  const group = [el('div', {}, kids)];
  if (teacher) {
    group.push(el('div', {}, [el('a', { href: '/user_123', text: teacher })]));
  }
  return group;
}

// Клетка <td> из групп пар, с <hr> между группами при sep=true.
function makeCell(groups, sep = false) {
  const children = [];
  groups.forEach((g, i) => {
    if (i > 0 && sep) children.push(el('hr'));
    children.push(...g);
  });
  return el('td', { class: 'cell' }, children);
}

// Правило для тестов.
function rule(subject, teacher = null, enabled = true) {
  return { subject, teacher, enabled };
}

/* ---------- normalize ---------- */

function testNormalize() {
  assert.strictEqual(M.normalize('  Математика  '), 'Математика');
  assert.strictEqual(M.normalize('АЯ\u00a0д/акад.целей.\u00a0A1.1'), 'АЯ д/акад.целей. A1.1');
  assert.strictEqual(M.normalize('Иван\u00a0\u00a0Иванов'), 'Иван Иванов');
  assert.strictEqual(M.normalize(null), '');
  assert.strictEqual(M.normalize(undefined), '');
  assert.strictEqual(M.normalize('  '), '');
}

/* ---------- splitIntoPairs ---------- */

function testSplitSinglePair() {
  const cell = makeCell([pairDiv('Математика', { teacher: 'Иванов И. И.' })]);
  const pairs = M.splitIntoPairs(cell.children);
  assert.strictEqual(pairs.length, 1);
  assert.strictEqual(pairs[0].length, 2); // div названия + div преподавателя
}

function testSplitTwoPairsWithHr() {
  const cell = makeCell(
    [pairDiv('Математика'), pairDiv('Физика')],
    true // <hr> между группами
  );
  const pairs = M.splitIntoPairs(cell.children);
  assert.strictEqual(pairs.length, 2);
  // <hr> прикрепляется к первой паре
  assert.strictEqual(pairs[0][pairs[0].length - 1].tagName, 'HR');
  assert.strictEqual(M.getPairName(pairs[0]), 'Математика');
  assert.strictEqual(M.getPairName(pairs[1]), 'Физика');
}

function testSplitHrAtStartIgnored() {
  const cell = el('td', { class: 'cell' }, [el('hr'), ...pairDiv('Химия')]);
  const pairs = M.splitIntoPairs(cell.children);
  assert.strictEqual(pairs.length, 1);
  assert.strictEqual(M.getPairName(pairs[0]), 'Химия');
  // ведущий <hr> без текущей группы не попал в пару
  assert.strictEqual(pairs[0].length, 1);
}

function testSplitThreePairsTwoHideable() {
  const cell = makeCell(
    [pairDiv('Математика'), pairDiv('Физика'), pairDiv('Английский')],
    true
  );
  const pairs = M.splitIntoPairs(cell.children);
  assert.strictEqual(pairs.length, 3);
  assert.deepStrictEqual(
    pairs.map(M.getPairName),
    ['Математика', 'Физика', 'Английский']
  );
}

/* ---------- getPairName ---------- */

function testPairName() {
  assert.strictEqual(M.getPairName(pairDiv('Математика')), 'Математика');
  assert.strictEqual(M.getPairName(pairDiv('  АЯ\u00a0д/акад.целей.  ')), 'АЯ д/акад.целей.');
}

function testPairNameWithoutSubject() {
  // Пара без названия (ОВ/ОС): только <b> типа, без <span> с названием.
  assert.strictEqual(M.getPairName(pairDiv(null)), null);
  // Пустое название span тоже считается отсутствующим.
  const group = [el('div', {}, [el('b', { text: 'ЛК' }), el('span', { text: '   ' })])];
  assert.strictEqual(M.getPairName(group), null);
}

/* ---------- getPairTeacher ---------- */

function testPairTeacher() {
  assert.strictEqual(
    M.getPairTeacher(pairDiv('Математика', { teacher: 'Иванов И. И.' })),
    'Иванов И. И.'
  );
  assert.strictEqual(M.getPairTeacher(pairDiv('Математика')), null);
}

/* ---------- matchRule ---------- */

function testMatchExactSubject() {
  const name = 'Математика';
  assert.strictEqual(M.matchRule(name, null, rule('Математика')), true);
  assert.strictEqual(M.matchRule(name, null, rule('Физика')), false);
}

function testMatchSubgroupIsExact() {
  // Подгруппы не группируются: A1.1 ≠ B1 — точное совпадение.
  const a = 'АЯ д/акад.целей.A1.1';
  const b = 'АЯ д/акад.целей.B1';
  assert.strictEqual(M.matchRule(a, null, rule('АЯ д/акад.целей.A1.1')), true);
  assert.strictEqual(M.matchRule(a, null, rule('АЯ д/акад.целей.B1')), false);
  assert.strictEqual(M.matchRule(b, null, rule('АЯ д/акад.целей.A1.1')), false);
}

function testMatchAllTeachers() {
  const teacher = 'Иванов И. И.';
  // «у всех» (teacher: null) совпадает и с преподавателем, и без него.
  assert.strictEqual(M.matchRule('Математика', teacher, rule('Математика')), true);
  assert.strictEqual(M.matchRule('Математика', null, rule('Математика')), true);
}

function testMatchSpecificTeacher() {
  const ruleTeacher = rule('Математика', 'Иванов И. И.');
  assert.strictEqual(M.matchRule('Математика', 'Иванов И. И.', ruleTeacher), true);
  assert.strictEqual(M.matchRule('Математика', 'Петров П. П.', ruleTeacher), false);
  // Правило с преподавателем не сработает на паре без преподавателя.
  assert.strictEqual(M.matchRule('Математика', null, ruleTeacher), false);
  // «у всех» (null) не равно конкретному ФИО правила.
  assert.strictEqual(M.matchRule('Математика', null, rule('Математика', 'Иванов И. И.')), false);
}

function testMatchNormalizedWhitespace() {
  // Отличающийся пробел/NBSP не мешает точному совпадению.
  assert.strictEqual(
    M.matchRule('АЯ  д/акад.целей. A1.1', null, rule('АЯ\u00a0д/акад.целей.\u00a0A1.1')),
    true
  );
}

function testMatchDisabledRule() {
  assert.strictEqual(M.matchRule('Математика', null, rule('Математика', null, false)), false);
}

function testMatchEmptyName() {
  // Пары без названия не скрываемы — не матчатся.
  assert.strictEqual(M.matchRule(null, null, rule('ОВ')), false);
}

/* ---------- isCellFullyHidden ---------- */

function testCellFullyHiddenAllHidden() {
  const cell = makeCell([pairDiv('Математика'), pairDiv('Физика')], true);
  for (const el of cell.children) el.style.display = 'none';
  assert.strictEqual(M.isCellFullyHidden(cell), true);
}

function testCellNotFullyHiddenWhenOneVisible() {
  const cell = makeCell([pairDiv('Математика'), pairDiv('Физика')], true);
  const kids = cell.children;
  kids[0].style.display = 'none';
  kids[1].style.display = 'none';
  kids[2].style.display = ''; // вторая пара видима
  assert.strictEqual(M.isCellFullyHidden(cell), false);
}

function testCellFullyHiddenWithPlaceholder() {
  const cell = makeCell([pairDiv('Математика')]);
  // Пара заменена плейсхолдером (класс rh-placeholder).
  cell.children[0].classList = { contains: (c) => c === 'rh-placeholder' };
  cell.children[0].style.display = '';
  assert.strictEqual(M.isCellFullyHidden(cell), true);
}

function testCellEmptyNotHidden() {
  const cell = el('td', { class: 'cell' }, []);
  assert.strictEqual(M.isCellFullyHidden(cell), false);
}

/* ---------- Запуск ---------- */

function run(name, fn) {
  fn();
  console.log('  ok - ' + name);
}

console.log('matcher.test.js');
const tests = [
  ['normalize', testNormalize],
  ['splitIntoPairs: 1 пара', testSplitSinglePair],
  ['splitIntoPairs: 2 пары через <hr>', testSplitTwoPairsWithHr],
  ['splitIntoPairs: ведущий <hr> игнорируется', testSplitHrAtStartIgnored],
  ['splitIntoPairs: 3 пары (2 скрываемые + 1 нет)', testSplitThreePairsTwoHideable],
  ['getPairName: название', testPairName],
  ['getPairName: без названия (ОВ/ОС) — null', testPairNameWithoutSubject],
  ['getPairTeacher: ФИО / null', testPairTeacher],
  ['matchRule: точное совпадение предмета', testMatchExactSubject],
  ['matchRule: подгруппы A1.1 ≠ B1', testMatchSubgroupIsExact],
  ['matchRule: «у всех»', testMatchAllTeachers],
  ['matchRule: конкретный преподаватель', testMatchSpecificTeacher],
  ['matchRule: нормализация пробелов/NBSP', testMatchNormalizedWhitespace],
  ['matchRule: выключенное правило', testMatchDisabledRule],
  ['matchRule: пустое название не матчится', testMatchEmptyName],
  ['isCellFullyHidden: все скрыты', testCellFullyHiddenAllHidden],
  ['isCellFullyHidden: одна видимая', testCellNotFullyHiddenWhenOneVisible],
  ['isCellFullyHidden: плейсхолдер', testCellFullyHiddenWithPlaceholder],
  ['isCellFullyHidden: пустая клетка', testCellEmptyNotHidden],
];

for (const [name, fn] of tests) run(name, fn);

console.log('\nВсе тесты прошли: ' + tests.length);