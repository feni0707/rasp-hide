/**
 * Юнит-тесты для options/options.js — то, что есть только на полной странице:
 * имя файла экспорта и сводка импорта. Общее с popup (список правил, тема,
 * согласованность разметки) проверяет tests/ui.test.js.
 * DOM и chrome не нужны: options.js при отсутствии document/chrome только
 * экспортирует модуль, не инициализируясь.
 * Запуск: node tests/options.test.js
 */
'use strict';

const assert = require('assert');

// Порядок как в options.html: text → rules → suggestions → ui/* → options.
require('../lib/text.js');
global.RASP_HIDE_RULES = require('../lib/rules.js');
global.RASP_HIDE_SUGGESTIONS = require('../lib/suggestions.js');
// icons.js создаёт SVG — в Node подставляем минимальный document.
global.document = {
  createElementNS(ns, tag) {
    const node = { ns, tag, attrs: {}, children: [] };
    node.setAttribute = (k, v) => { node.attrs[k] = v; };
    node.appendChild = (c) => { node.children.push(c); return c; };
    return node;
  },
  createElement(tag) {
    const node = { tag, attrs: {}, children: [] };
    node.setAttribute = (k, v) => { node.attrs[k] = v; };
    node.appendChild = (c) => { node.children.push(c); return c; };
    node.addEventListener = () => {};
    return node;
  },
};
global.RASP_HIDE_ICONS = require('../ui/icons.js');
global.RASP_HIDE_STATUS = require('../ui/status.js');
global.RASP_HIDE_RULES_LIST = require('../ui/rules-list.js');
const R = global.RASP_HIDE_RULES;
const O = require('../options/options.js');

// Правило для тестов.
function rule(subject, teacher = null, enabled = true) {
  return { subject, teacher, enabled };
}

const TESTS = [];
function t(name, fn) {
  TESTS.push([name, fn]);
}

/* ---------- Имя файла экспорта ---------- */

t('exportFileName: дата с ведущими нулями', () => {
  assert.strictEqual(O.exportFileName(new Date(2026, 8, 5)), 'rasp-hide-rules-2026-09-05.json');
  assert.strictEqual(O.exportFileName(new Date(2026, 11, 31)), 'rasp-hide-rules-2026-12-31.json');
  assert.strictEqual(O.exportFileName(new Date(2027, 0, 1)), 'rasp-hide-rules-2027-01-01.json');
});

/* ---------- Сводка импорта ---------- */

t('importSummary: подтверждение — что пропадёт и что добавится', () => {
  const plan = R.planImport([rule('АЯ', null)], [rule('АЯ', 'Иванов И. И.')]);
  const text = O.importSummary(plan, { phase: 'confirm', replace: false, currentCount: 1 });
  assert.ok(text.includes('АЯ — Иванов И. И.'), 'названо поглощаемое правило: ' + text);
  assert.ok(text.includes('Добавится: 1'), text);
});

t('importSummary: подтверждение замены называет текущее количество', () => {
  const plan = R.planImport([rule('Химия', null)], [rule('Матан', null)], { replace: true });
  const text = O.importSummary(plan, { phase: 'confirm', replace: true, currentCount: 1 });
  assert.ok(text.includes('заменены (сейчас 1)'), text);
});

t('importSummary: подтверждение считает пропущенные', () => {
  const plan = R.planImport(
    [rule('Матан', null), rule('Химия', null)],
    [rule('Матан', null)]
  );
  const text = O.importSummary(plan, { phase: 'confirm', replace: false, currentCount: 1 });
  assert.ok(text.includes('Добавится: 1'), text);
  assert.ok(text.includes('пропущено: 1'), text);
});

t('importSummary: итог без лишних хвостов', () => {
  const plan = R.planImport([rule('Химия', null)], []);
  assert.strictEqual(
    O.importSummary(plan, { phase: 'done' }),
    'Импортировано правил: 1.'
  );
});

t('importSummary: итог с поглощением и пропусками', () => {
  const plan = R.planImport(
    [rule('АЯ', null), rule('Матан', null)],
    [rule('АЯ', 'Иванов И. И.'), rule('Матан', null)]
  );
  const text = O.importSummary(plan, { phase: 'done' });
  assert.strictEqual(
    text,
    'Импортировано правил: 1, удалено поглощённых: 1, пропущено: 1 (дубликаты и уже покрытые).'
  );
});

/* ---------- Запуск ---------- */

console.log('options.test.js');
let failed = 0;
for (const [name, fn] of TESTS) {
  try {
    fn();
    console.log('  ok - ' + name);
  } catch (err) {
    failed++;
    console.error('  FAIL - ' + name);
    console.error('    ' + (err && err.message));
  }
}
console.log('\nВсего тестов: ' + TESTS.length + (failed ? ', провалено: ' + failed : ''));
if (failed) process.exit(1);
