/**
 * Юнит-тесты для popup/popup.js — чистая часть (фраза о состоянии вкладки).
 * DOM и chrome не нужны: popup.js при отсутствии document/chrome только
 * экспортирует модуль, не инициализируясь.
 * Разметку и общий список правил проверяет tests/ui.test.js.
 * Запуск: node tests/popup.test.js
 */
'use strict';

const assert = require('assert');

// Порядок как в popup.html: text → rules → suggestions → ui/* → popup.
require('../lib/text.js');
global.RASP_HIDE_RULES = require('../lib/rules.js');
global.RASP_HIDE_SUGGESTIONS = require('../lib/suggestions.js');
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
const P = require('../popup/popup.js');

const TESTS = [];
function t(name, fn) {
  TESTS.push([name, fn]);
}

/* ---------- Состояние вкладки ---------- */

// Счётчик берётся из бейджа вкладки. Скринридеру нужна законченная фраза,
// а не голое число, поэтому текст собирается целиком.
t('pageStateText: выключенный тумблер важнее любого бейджа', () => {
  for (const badge of ['3', '0', 'OFF', '', null]) {
    assert.strictEqual(
      P.pageStateText(false, badge),
      'Скрытие выключено — на страницах ничего не скрывается.'
    );
  }
});

t('pageStateText: бейдж OFF — тоже выключено', () => {
  assert.strictEqual(
    P.pageStateText(true, 'OFF'),
    'Скрытие выключено — на страницах ничего не скрывается.'
  );
});

t('pageStateText: пустой бейдж — расписание не открыто', () => {
  const expected = 'Откройте расписание на ro-rasp.tpu.ru, чтобы увидеть счётчик.';
  assert.strictEqual(P.pageStateText(true, ''), expected);
  assert.strictEqual(P.pageStateText(true, null), expected);
});

t('pageStateText: ноль скрытых — это не «нет данных»', () => {
  // Зелёный «0» на бейдже значит «расписание открыто, скрывать нечего».
  assert.strictEqual(P.pageStateText(true, '0'), 'На этой странице ничего не скрыто.');
});

t('pageStateText: счётчик числом', () => {
  assert.strictEqual(P.pageStateText(true, '1'), 'Скрыто пар на этой странице: 1.');
  assert.strictEqual(P.pageStateText(true, '42'), 'Скрыто пар на этой странице: 42.');
});

t('pageStateText: неожиданный текст бейджа не притворяется числом', () => {
  assert.strictEqual(P.pageStateText(true, 'ой'), 'Счётчик недоступен для этой вкладки.');
});

t('поиск появляется только у длинного списка', () => {
  // Поле поиска над списком из трёх правил — лишний элемент управления.
  assert.ok(P.SEARCH_FROM >= 5, 'порог должен быть заметно больше нуля');
});

/* ---------- Запуск ---------- */

console.log('popup.test.js');
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
