/**
 * Юнит-тесты для options/options.js — чистая часть (сортировка списка,
 * имя файла экспорта, сводка импорта). DOM и chrome не нужны: options.js
 * при отсутствии document/chrome только экспортирует модуль, не инициализируясь.
 * Запуск: node tests/options.test.js
 */
'use strict';

const assert = require('assert');

require('../lib/text.js'); // общая нормализация — грузится первой, как в options.html
global.RASP_HIDE_RULES = require('../lib/rules.js');
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

/* ---------- Сортировка списка правил ---------- */

t('sortRules: алфавит предмета, «все» выше конкретных ФИО', () => {
  const sorted = O.sortRules([
    rule('Физика', 'Петров П. П.'),
    rule('АЯ', 'Сидоров С. С.'),
    rule('АЯ', 'Иванов И. И.'),
    rule('АЯ', null),
    rule('Матан', null),
  ]);
  assert.deepStrictEqual(sorted.map(R.formatRule), [
    'АЯ — все преподаватели',
    'АЯ — Иванов И. И.',
    'АЯ — Сидоров С. С.',
    'Матан — все преподаватели',
    'Физика — Петров П. П.',
  ]);
});

t('sortRules: не мутирует исходный массив', () => {
  const list = [rule('Физика', null), rule('АЯ', null)];
  const copy = [...list];
  O.sortRules(list);
  assert.deepStrictEqual(list, copy);
});

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

/* ---------- Согласованность options.js и options.html ---------- */

// Опечатка в id ломает страницу целиком и юнит-тестами чистых функций
// не ловится: init() падает на первом же обращении к несуществующему элементу.
t('все id из options.js есть в options.html', () => {
  const fs = require('fs');
  const path = require('path');
  const js = fs.readFileSync(path.join(__dirname, '../options/options.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../options/options.html'), 'utf8');

  const wanted = [...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(wanted.length >= 12, 'ожидались обращения по id, найдено ' + wanted.length);

  const present = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const missing = wanted.filter((id) => !present.has(id));
  assert.deepStrictEqual(missing, [], 'в options.html нет элементов: ' + missing.join(', '));
});

t('селекторы по name из options.js есть в options.html', () => {
  const fs = require('fs');
  const path = require('path');
  const js = fs.readFileSync(path.join(__dirname, '../options/options.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../options/options.html'), 'utf8');

  const names = [...js.matchAll(/querySelectorAll\('input\[name="([^"]+)"\]'\)/g)].map((m) => m[1]);
  assert.ok(names.length > 0, 'ожидался хотя бы один селектор по name');
  for (const name of names) {
    assert.ok(html.includes('name="' + name + '"'), 'в options.html нет input[name="' + name + '"]');
  }
});

t('оба блока статуса подключены и различны', () => {
  const fs = require('fs');
  const path = require('path');
  const js = fs.readFileSync(path.join(__dirname, '../options/options.js'), 'utf8');
  const ids = [...js.matchAll(/createStatus\('([^']+)', '([^']+)'\)/g)];
  assert.strictEqual(ids.length, 2, 'ожидались два блока статуса: правила и импорт/экспорт');
  assert.notStrictEqual(ids[0][1], ids[1][1], 'блоки статуса не должны делить один корень');
});

/* ---------- Тёмная тема ---------- */

// Забытая переменная в тёмном наборе — это невидимый текст на странице
// у части пользователей, и заметить это по светлой теме нельзя.
function readStyle() {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../options/options.html'), 'utf8');
  return html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
}

/**
 * Имена переменных, объявленных в блоке, начинающемся с selector.
 * @param {string} css
 * @param {string} selector
 * @returns {Set<string>}
 */
function declaredIn(css, selector) {
  const at = css.indexOf(selector);
  assert.notStrictEqual(at, -1, 'не найден блок ' + selector);
  const body = css.slice(at + selector.length, css.indexOf('}', at));
  return new Set([...body.matchAll(/(--rh-[\w-]+)\s*:/g)].map((m) => m[1]));
}

t('тёмная тема переопределяет ровно тот же набор переменных, что и светлая', () => {
  const css = readStyle();
  const light = declaredIn(css, ':root{');
  const darkAt = css.indexOf('@media (prefers-color-scheme: dark)');
  assert.notStrictEqual(darkAt, -1, 'нет блока prefers-color-scheme: dark');
  const dark = declaredIn(css.slice(darkAt), ':root{');

  assert.ok(light.size >= 10, 'ожидался набор токенов, найдено ' + light.size);
  assert.deepStrictEqual(
    [...light].filter((v) => !dark.has(v)), [],
    'в тёмной теме не переопределены переменные'
  );
  assert.deepStrictEqual(
    [...dark].filter((v) => !light.has(v)), [],
    'в тёмной теме есть переменные, которых нет в светлой'
  );
});

t('все использованные переменные объявлены', () => {
  const css = readStyle();
  const declared = declaredIn(css, ':root{');
  const used = new Set([...css.matchAll(/var\((--rh-[\w-]+)\)/g)].map((m) => m[1]));
  assert.ok(used.size > 0, 'переменные должны использоваться, а не только объявляться');
  assert.deepStrictEqual([...used].filter((v) => !declared.has(v)), [], 'не объявлены');
});

t('цвета не захардкожены мимо переменных', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../options/options.html'), 'utf8');
  // Инлайн-стили тему не подхватывают — их на странице быть не должно.
  assert.strictEqual((html.match(/\sstyle="/g) || []).length, 0, 'найден инлайн-стиль');

  const css = readStyle();
  // Единственные литеральные цвета — внутри объявлений переменных.
  for (const line of css.split('\n')) {
    if (!/#[0-9a-fA-F]{3,8}\b/.test(line)) continue;
    assert.ok(/--rh-[\w-]+\s*:/.test(line), 'цвет мимо переменной: ' + line.trim());
  }
});

/**
 * Контраст по WCAG для пары цветов.
 * @param {string} fg
 * @param {string} bg
 * @returns {number}
 */
function contrast(fg, bg) {
  const channels = (hex) => {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  };
  const lum = (hex) => {
    const [r, g, b] = channels(hex).map((v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const a = lum(fg);
  const b = lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Значения переменных блока, начинающегося с selector.
 * @param {string} css
 * @param {string} selector
 * @returns {Object<string, string>}
 */
function valuesIn(css, selector) {
  const at = css.indexOf(selector);
  const body = css.slice(at + selector.length, css.indexOf('}', at));
  const out = {};
  for (const m of body.matchAll(/(--rh-[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/g)) out[m[1]] = m[2];
  return out;
}

t('текст читается в обеих темах', () => {
  const css = readStyle();
  const darkAt = css.indexOf('@media (prefers-color-scheme: dark)');
  const themes = {
    светлая: valuesIn(css, ':root{'),
    тёмная: valuesIn(css.slice(darkAt), ':root{'),
  };
  // Порог 4.5 — обычный текст по WCAG AA; 3.0 — для приглушённого,
  // которому достаточно уровня «крупный текст / нетекстовый элемент».
  const checks = [
    ['--rh-text', '--rh-surface', 4.5],
    ['--rh-text', '--rh-bg', 4.5],
    ['--rh-muted', '--rh-surface', 4.5],
    ['--rh-strong', '--rh-surface', 4.5],
    ['--rh-dim', '--rh-surface', 3],
    ['--rh-danger', '--rh-danger-bg', 4.5],
    ['--rh-info', '--rh-info-bg', 4.5],
  ];
  for (const [theme, v] of Object.entries(themes)) {
    for (const [fg, bg, min] of checks) {
      const ratio = contrast(v[fg], v[bg]);
      assert.ok(
        ratio >= min,
        theme + ': ' + fg + ' на ' + bg + ' — контраст ' + ratio.toFixed(2) + ', нужно ' + min
      );
    }
  }
});

t('color-scheme объявлен — штатные контролы следуют теме', () => {
  assert.ok(/color-scheme\s*:\s*light dark/.test(readStyle()));
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
