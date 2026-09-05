/**
 * Юнит-тесты для общего интерфейса (ui/): чистые функции списка правил,
 * иконки, согласованность разметки со скриптами и тема (токены, контраст).
 * Проверяется и popup, и options — обе страницы стоят на одних модулях.
 * Запуск: node tests/ui.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../lib/text.js');
global.RASP_HIDE_RULES = require('../lib/rules.js');
const R = global.RASP_HIDE_RULES;

// Иконкам нужен document.createElementNS; в Node подставляем минимальный узел.
global.document = {
  createElementNS(ns, tag) {
    const node = { ns, tag, attrs: {}, children: [] };
    node.setAttribute = (k, v) => { node.attrs[k] = v; };
    node.appendChild = (c) => { node.children.push(c); return c; };
    return node;
  },
  createElement(tag) {
    const node = { tag, attrs: {}, children: [], className: '', textContent: '' };
    node.setAttribute = (k, v) => { node.attrs[k] = v; };
    node.appendChild = (c) => { node.children.push(c); return c; };
    node.addEventListener = () => {};
    return node;
  },
};
global.RASP_HIDE_ICONS = require('../ui/icons.js');
const ICONS = global.RASP_HIDE_ICONS;
const LIST = require('../ui/rules-list.js');

function rule(subject, teacher = null, enabled = true) {
  return { subject, teacher, enabled };
}

const TESTS = [];
function t(name, fn) {
  TESTS.push([name, fn]);
}

/** @returns {string} путь к файлу проекта */
function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

/* ---------- Список правил ---------- */

t('sortRules: алфавит предмета, «все» выше конкретных ФИО', () => {
  const sorted = LIST.sortRules([
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
  LIST.sortRules(list);
  assert.deepStrictEqual(list, copy);
});

t('matchesFilter: ищет и по предмету, и по преподавателю', () => {
  const r = rule('Математический анализ', 'Петрова А. С.');
  assert.ok(LIST.matchesFilter(r, ''), 'пустой фильтр пропускает всё');
  assert.ok(LIST.matchesFilter(r, 'анализ'), 'подстрока предмета');
  assert.ok(LIST.matchesFilter(r, 'петров'), 'подстрока ФИО — «всё от Петровой»');
  assert.ok(!LIST.matchesFilter(r, 'физика'));
});

t('matchesFilter: правило «у всех» не падает на пустом преподавателе', () => {
  assert.ok(!LIST.matchesFilter(rule('Матан', null), 'иванов'));
  assert.ok(LIST.matchesFilter(rule('Матан', null), 'мат'));
});

t('teacherLabel: «все преподаватели» вместо пустоты', () => {
  assert.strictEqual(LIST.teacherLabel(rule('Матан', null)), 'все преподаватели');
  assert.strictEqual(LIST.teacherLabel(rule('Матан', 'Иванов И. И.')), 'Иванов И. И.');
});

/* ---------- Иконки ---------- */

t('icon: SVG скрыт от скринридера и не содержит эмодзи', () => {
  for (const name of ICONS.NAMES) {
    const svg = ICONS.icon(name);
    assert.strictEqual(svg.attrs['aria-hidden'], 'true', name + ': декоративная иконка');
    assert.strictEqual(svg.attrs.focusable, 'false', name + ': не в порядке обхода');
    assert.ok(svg.children.length > 0, name + ': контур не пустой');
    assert.ok(/\brh-i\b/.test(svg.attrs.class), name + ': общий класс иконки');
  }
});

t('иконки в разметке нарисованы, а не набраны эмодзи', () => {
  // Эмодзи как иконки разъезжаются по платформам и не наследуют цвет текста.
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  for (const page of ['popup/popup.html', 'options/options.html']) {
    assert.ok(!emoji.test(read(page)), page + ': найден эмодзи');
  }
});

/* ---------- Согласованность разметки и скриптов ---------- */

// Опечатка в id ломает страницу целиком и юнит-тестами чистых функций
// не ловится: init() падает на первом же обращении к несуществующему элементу.
for (const [page, script] of [
  ['popup/popup.html', 'popup/popup.js'],
  ['options/options.html', 'options/options.js'],
]) {
  t('все id из ' + script + ' есть в ' + page, () => {
    const js = read(script);
    const html = read(page);
    const wanted = [...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
    assert.ok(wanted.length >= 10, 'ожидались обращения по id, найдено ' + wanted.length);
    const present = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const missing = wanted.filter((id) => !present.has(id));
    assert.deepStrictEqual(missing, [], 'нет элементов: ' + missing.join(', '));
  });

  t('селекторы по name из ' + script + ' есть в ' + page, () => {
    const js = read(script);
    const html = read(page);
    const names = [...js.matchAll(/querySelectorAll\('input\[name="([^"]+)"\]'\)/g)].map((m) => m[1]);
    for (const name of names) {
      assert.ok(html.includes('name="' + name + '"'), 'нет input[name="' + name + '"]');
    }
  });

  t(page + ': каждое поле ввода подписано', () => {
    const html = read(page);
    // Плейсхолдер — не подпись: он исчезает при вводе. Нужен <label for>.
    const ids = [...html.matchAll(/<input[^>]*\bid="([^"]+)"[^>]*>/g)]
      .filter((m) => !/type="(checkbox|radio|file)"/.test(m[0]))
      .map((m) => m[1]);
    assert.ok(ids.length > 0, 'ожидались текстовые поля');
    for (const id of ids) {
      assert.ok(html.includes('for="' + id + '"'), page + ': нет <label for="' + id + '">');
    }
  });

  t(page + ': кнопка без видимого текста имеет доступное имя', () => {
    const html = read(page);
    for (const m of html.matchAll(/<button\b[\s\S]*?<\/button>/g)) {
      const markup = m[0];
      const visible = markup.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').trim();
      if (visible) continue;
      assert.ok(/aria-label="/.test(markup),
        page + ': кнопка-иконка без aria-label: ' + markup.slice(0, 80));
    }
  });

  t(page + ': блоки статуса объявлены живой областью', () => {
    const html = read(page);
    for (const m of html.matchAll(/<div class="rh-status"[^>]*>/g)) {
      assert.ok(/role="status"/.test(m[0]) && /aria-live="polite"/.test(m[0]),
        page + ': статус без role/aria-live: ' + m[0]);
    }
  });
}

/* ---------- Тема ---------- */

/** @returns {string} общая таблица стилей */
function theme() {
  return read('ui/theme.css');
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

/**
 * Значения цветовых переменных блока.
 * @param {string} css
 * @param {string} selector
 * @returns {Object<string, string>}
 */
function colorsIn(css, selector) {
  const at = css.indexOf(selector);
  const body = css.slice(at + selector.length, css.indexOf('}', at));
  const out = {};
  for (const m of body.matchAll(/(--rh-[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/g)) out[m[1]] = m[2];
  return out;
}

/**
 * Контраст по WCAG.
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

t('тёмная тема переопределяет ровно тот же набор переменных, что и светлая', () => {
  const css = theme();
  const light = declaredIn(css, ':root{');
  const darkAt = css.indexOf('@media (prefers-color-scheme: dark)');
  assert.notStrictEqual(darkAt, -1, 'нет блока prefers-color-scheme: dark');
  const dark = declaredIn(css.slice(darkAt), ':root{');
  assert.ok(light.size >= 20, 'ожидался набор токенов, найдено ' + light.size);
  // Отступы и тайминги в тёмной теме не меняются — сравниваем только цвета.
  const isColor = (v) => !/^--rh-(s\d|radius|dur|ease)/.test(v);
  assert.deepStrictEqual([...light].filter((v) => isColor(v) && !dark.has(v)), [],
    'в тёмной теме не переопределены цветовые переменные');
  assert.deepStrictEqual([...dark].filter((v) => !light.has(v)), [],
    'в тёмной теме есть переменные, которых нет в светлой');
});

t('все использованные переменные объявлены', () => {
  const css = theme();
  const declared = declaredIn(css, ':root{');
  const used = new Set();
  for (const source of [css, read('popup/popup.html'), read('options/options.html')]) {
    for (const m of source.matchAll(/var\((--rh-[\w-]+)\)/g)) used.add(m[1]);
  }
  assert.ok(used.size > 0);
  assert.deepStrictEqual([...used].filter((v) => !declared.has(v)), [], 'не объявлены');
});

t('цвета не захардкожены мимо переменных', () => {
  for (const page of ['popup/popup.html', 'options/options.html']) {
    const html = read(page);
    // Инлайн-стили тему не подхватывают.
    assert.strictEqual((html.match(/\sstyle="/g) || []).length, 0, page + ': инлайн-стиль');
    const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), page + ': цвет мимо переменной');
  }
  // Комментарии не в счёт: цвет в пояснении — это документация, а не стиль.
  const css = theme().replace(/\/\*[\s\S]*?\*\//g, '');
  for (const line of css.split('\n')) {
    if (!/#[0-9a-fA-F]{3,8}\b/.test(line)) continue;
    assert.ok(/--rh-[\w-]+\s*:/.test(line) || /rgba?\(/.test(line),
      'цвет мимо переменной: ' + line.trim());
  }
});

t('текст читается в обеих темах', () => {
  const css = theme();
  const darkAt = css.indexOf('@media (prefers-color-scheme: dark)');
  const themes = {
    светлая: colorsIn(css, ':root{'),
    тёмная: colorsIn(css.slice(darkAt), ':root{'),
  };
  // 4.5 — обычный текст по WCAG AA; 3.0 — приглушённый и нетекстовые элементы.
  const checks = [
    ['--rh-text', '--rh-surface', 4.5],
    ['--rh-text', '--rh-bg', 4.5],
    ['--rh-muted', '--rh-surface', 4.5],
    ['--rh-strong', '--rh-surface', 4.5],
    ['--rh-dim', '--rh-surface', 3],
    ['--rh-danger', '--rh-danger-bg', 4.5],
    ['--rh-info', '--rh-info-bg', 4.5],
    ['--rh-accent-text', '--rh-surface', 4.5],
    ['--rh-on-accent', '--rh-accent', 4.5],
    ['--rh-ring', '--rh-surface', 3],
  ];
  for (const [name, v] of Object.entries(themes)) {
    for (const [fg, bg, min] of checks) {
      const ratio = contrast(v[fg], v[bg]);
      assert.ok(ratio >= min,
        name + ': ' + fg + ' на ' + bg + ' — контраст ' + ratio.toFixed(2) + ', нужно ' + min);
    }
  }
});

t('color-scheme объявлен — штатные контролы следуют теме', () => {
  assert.ok(/color-scheme\s*:\s*light dark/.test(theme()));
});

t('движение отключается по prefers-reduced-motion', () => {
  assert.ok(/@media \(prefers-reduced-motion: reduce\)/.test(theme()));
});

t('фокус виден и нигде не подавлен', () => {
  const css = theme().replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(/:focus-visible\{[^}]*outline:2px solid var\(--rh-ring\)/.test(css),
    'нет общего кольца фокуса');
  // Снять outline можно только у визуально скрытого input, и только если
  // кольцо тут же перенесено на видимого соседа (дорожку/подпись).
  for (const m of css.matchAll(/([^{}]+)\{[^}]*outline\s*:\s*(?:none|0)\b[^}]*\}/g)) {
    const selector = m[1].trim();
    assert.ok(/input:focus-visible$/.test(selector),
      'outline снят не у скрытого input: ' + selector);
    const proxy = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      '\\s*\\+\\s*[^{]+\\{[^}]*outline:2px solid var\\(--rh-ring\\)');
    assert.ok(proxy.test(css), 'нет замены кольца для: ' + selector);
  }
});

t('красным подсвечивается только разрушительное', () => {
  // .rh-btn--icon — и удаление правила, и нейтральная шестерёнка в подвале:
  // общий hover в danger-цвете обещал бы удаление там, где его нет.
  const css = theme().replace(/\/\*[\s\S]*?\*\//g, '');
  const iconHover = css.match(/\.rh-btn--icon:hover[^{]*\{([^}]*)\}/);
  assert.ok(iconHover, 'нет правила hover для кнопки-иконки');
  assert.ok(!/--rh-danger/.test(iconHover[1]),
    'нейтральная кнопка-иконка краснеет при наведении');
  assert.ok(/\.rh-btn--icon\.rh-btn--danger:hover[^{]*\{[^}]*--rh-danger/.test(css),
    'у разрушительной кнопки-иконки нет красного hover');

  // И сама кнопка удаления правила должна просить этот модификатор.
  const list = require('fs').readFileSync(
    require('path').join(__dirname, '../ui/rules-list.js'), 'utf8');
  assert.ok(/del\.className = '[^']*rh-btn--danger/.test(list),
    'кнопка удаления правила не помечена как разрушительная');
});

t('скрытое через [hidden] действительно скрыто', () => {
  // Компоненты раскладываются flex-ом, а он перебивает [hidden] из UA-стилей.
  assert.ok(/\[hidden\]\{display:none !important;\}/.test(theme()),
    'нет глобального правила [hidden]');
});

/* ---------- Запуск ---------- */

console.log('ui.test.js');
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
