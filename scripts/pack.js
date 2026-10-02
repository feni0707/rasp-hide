/**
 * Сборка архива для Chrome Web Store: dist/rasp-hide-<версия>.zip.
 *
 * В архив попадают только файлы, на которые ссылаются манифест и страницы
 * расширения (popup, options), плюс LICENSE. Тесты, документация, .DS_Store
 * и прочие служебные файлы в пакет не идут: список не ведётся руками,
 * а выводится из манифеста — забытый или лишний файл исключён.
 *
 * Запуск: npm run pack
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/**
 * Локальные ссылки страницы расширения: <script src>, <link href>.
 * Внешних ссылок в расширении быть не должно (это проверяет тест манифеста).
 * @param {string} rel - путь страницы от корня
 * @returns {string[]} пути от корня
 */
function pageReferences(rel) {
  const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const dir = path.posix.dirname(rel);
  const refs = [];
  for (const m of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]+)"/g)) {
    if (/^[a-z]+:/i.test(m[1])) continue; // внешняя ссылка — не файл пакета
    refs.push(path.posix.normalize(path.posix.join(dir, m[1])));
  }
  return refs;
}

/**
 * Файлы пакета: всё, на что ссылается манифест, и всё, что подключают
 * страницы расширения.
 * @returns {string[]} отсортированные пути от корня
 */
function shippedFiles() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const files = new Set(['manifest.json', 'LICENSE']);
  const pages = [];
  if (manifest.background && manifest.background.service_worker) {
    files.add(manifest.background.service_worker);
  }
  for (const cs of manifest.content_scripts || []) {
    for (const f of [...(cs.js || []), ...(cs.css || [])]) files.add(f);
  }
  if (manifest.action) {
    if (manifest.action.default_popup) pages.push(manifest.action.default_popup);
    for (const f of Object.values(manifest.action.default_icon || {})) files.add(f);
  }
  if (manifest.options_ui && manifest.options_ui.page) pages.push(manifest.options_ui.page);
  for (const f of Object.values(manifest.icons || {})) files.add(f);
  for (const page of pages) {
    files.add(page);
    for (const ref of pageReferences(page)) files.add(ref);
  }
  return [...files].sort();
}

/** Сборка архива. */
function pack() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const files = shippedFiles();
  const missing = files.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length) {
    console.error('Нет файлов, на которые ссылается манифест: ' + missing.join(', '));
    process.exit(1);
  }
  const dist = path.join(ROOT, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  const out = path.join(dist, 'rasp-hide-' + manifest.version + '.zip');
  fs.rmSync(out, { force: true });
  // -X: без служебных атрибутов файловой системы (uid/gid, resource fork).
  execFileSync('zip', ['-X', '-q', out, ...files], { cwd: ROOT, stdio: 'inherit' });
  const kb = (fs.statSync(out).size / 1024).toFixed(1);
  console.log('Готово: ' + path.relative(ROOT, out) + ' (' + kb + ' КБ, файлов: ' + files.length + ')');
  for (const f of files) console.log('  ' + f);
}

module.exports = { shippedFiles, pageReferences };

if (require.main === module) pack();
