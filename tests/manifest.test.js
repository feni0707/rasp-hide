/**
 * Проверки пакета перед публикацией в магазинах расширений (STORE_CHECKLIST §1):
 * манифест, права, файлы пакета, запрещённые конструкции, иконки.
 * Всё, что модерация отклонит или что ломает установку, ловится здесь,
 * а не при ручном прогоне чек-листа.
 * Запуск: node tests/manifest.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { shippedFiles } = require('../scripts/pack.js');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const TESTS = [];
function t(name, fn) {
  TESTS.push([name, fn]);
}

/** @returns {string} содержимое файла пакета */
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/* ---------- Манифест ---------- */

t('Manifest V3', () => {
  assert.strictEqual(manifest.manifest_version, 3);
});

t('права: ровно ["storage"], без host_permissions и необязательных прав', () => {
  assert.deepStrictEqual(manifest.permissions, ['storage']);
  for (const key of ['host_permissions', 'optional_permissions', 'optional_host_permissions']) {
    assert.ok(!(key in manifest), key + ' не должно быть');
  }
});

t('фон: один и тот же файл как service worker (Chrome) и как scripts (Firefox)', () => {
  // Firefox не запускает service worker в фоне; Chrome до 121 не грузит манифест
  // с background.scripts, поэтому нижняя граница версии обязательна.
  assert.deepStrictEqual(manifest.background.scripts, [manifest.background.service_worker]);
  assert.ok(Number(manifest.minimum_chrome_version) >= 121, 'minimum_chrome_version >= 121');
});

t('Firefox: постоянный id, нижняя версия и заявление «данные не собираются»', () => {
  const gecko = manifest.browser_specific_settings.gecko;
  assert.ok(/^[\w.+-]+@[\w.-]+$/.test(gecko.id), 'gecko.id: ' + gecko.id);
  assert.ok(/^\d+\.\d+$/.test(gecko.strict_min_version), gecko.strict_min_version);
  assert.deepStrictEqual(gecko.data_collection_permissions, { required: ['none'] });
});

t('content script — только на ro-rasp.tpu.ru, общая нормализация грузится первой', () => {
  assert.strictEqual(manifest.content_scripts.length, 1);
  const cs = manifest.content_scripts[0];
  assert.deepStrictEqual(cs.matches, ['https://ro-rasp.tpu.ru/*']);
  assert.strictEqual(cs.js[0], 'lib/text.js');
  // ui.js и content.js берут правила из lib/rules.js — он должен быть раньше.
  assert.ok(cs.js.indexOf('lib/rules.js') < cs.js.indexOf('content/ui.js'));
  assert.ok(cs.js.indexOf('lib/rules.js') < cs.js.indexOf('content/content.js'));
});

t('CSP не ослаблен (нет unsafe-eval и внешних источников)', () => {
  const csp = JSON.stringify(manifest.content_security_policy || {});
  assert.ok(!/unsafe-eval|unsafe-inline|https?:/.test(csp), csp);
});

t('версия: семвер и совпадает с package.json', () => {
  assert.ok(/^\d+\.\d+\.\d+$/.test(manifest.version), manifest.version);
  assert.strictEqual(manifest.version, pkg.version);
});

t('название и описание укладываются в лимиты CWS (75 и 132 символа)', () => {
  assert.ok(manifest.name.length <= 75, 'name: ' + manifest.name.length);
  assert.ok(manifest.description.length <= 132, 'description: ' + manifest.description.length);
});

/* ---------- Файлы пакета ---------- */

t('все файлы пакета существуют', () => {
  const missing = shippedFiles().filter((f) => !fs.existsSync(path.join(ROOT, f)));
  assert.deepStrictEqual(missing, []);
});

t('в пакет не попадают тесты, документация и служебные файлы', () => {
  for (const f of shippedFiles()) {
    assert.ok(!/^(tests|docs|scripts|\.github|\.claude|\.agents|node_modules|dist)\//.test(f), f);
    assert.ok(!/\.DS_Store$|\.md$/.test(f), f);
  }
});

t('popup и options подключают общие модули в порядке зависимостей', () => {
  const order = ['lib/text.js', 'lib/rules.js', 'ui/rules-list.js'];
  for (const page of ['popup/popup.html', 'options/options.html']) {
    const html = read(page);
    const at = order.map((f) => html.indexOf('../' + f));
    assert.ok(at.every((i) => i !== -1), page + ': подключены не все модули');
    assert.deepStrictEqual([...at].sort((a, b) => a - b), at, page + ': порядок');
  }
});

/* ---------- Код ---------- */

// Модерация CWS отклоняет удалённый код и eval-подобные конструкции.
const FORBIDDEN = [
  [/\beval\s*\(/, 'eval()'],
  [/new\s+Function\s*\(/, 'new Function()'],
  [/set(?:Timeout|Interval)\s*\(\s*['"`]/, 'строковый таймер'],
  [/<script[^>]+src=["']https?:/i, 'внешний <script src>'],
  [/<link[^>]+href=["']https?:/i, 'внешний стиль или шрифт'],
  [/@import|url\(\s*['"]?https?:/i, 'внешний ресурс в CSS'],
  [/\bimportScripts\s*\(/, 'importScripts'],
  [/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon/, 'сеть'],
  [/\.innerHTML\s*=|insertAdjacentHTML|document\.write/, 'HTML из строки'],
];

t('в пакете нет eval, строковых таймеров, удалённого кода, сети и внешних ресурсов', () => {
  for (const f of shippedFiles().filter((x) => /\.(js|html|css)$/.test(x))) {
    const src = read(f);
    for (const [re, what] of FORBIDDEN) assert.ok(!re.test(src), f + ': ' + what);
  }
});

/* ---------- Иконки ---------- */

/**
 * Размер PNG из заголовка IHDR.
 * @param {string} rel
 * @returns {{width: number, height: number}}
 */
function pngSize(rel) {
  const buf = fs.readFileSync(path.join(ROOT, rel));
  assert.strictEqual(buf.toString('ascii', 1, 4), 'PNG', rel + ': не PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

t('иконки: PNG заявленного размера, есть 128×128 для витрины', () => {
  assert.ok(manifest.icons['128'], 'нужна иконка 128×128');
  for (const icons of [manifest.icons, manifest.action.default_icon]) {
    for (const [size, file] of Object.entries(icons)) {
      const { width, height } = pngSize(file);
      assert.strictEqual(width, Number(size), file);
      assert.strictEqual(height, Number(size), file);
    }
  }
});

/* ---------- Запуск ---------- */

console.log('manifest.test.js');
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
