/**
 * Юнит-тесты для lib/suggestions.js (подсказки предметов и ФИО) на моке
 * chrome.storage.local. Запуск: node tests/suggestions.test.js
 */
'use strict';

const assert = require('assert');

require('../lib/text.js'); // общая нормализация — грузится первой, как в манифесте
const S = require('../lib/suggestions.js');

/* ---------- Мок chrome.storage.local ---------- */

// Мок chrome: in-memory local storage, lastError с семантикой Chrome.
function makeChromeMock(initial = null) {
  const state = { suggestions: initial };
  let failNextSet = false;
  const chrome = {
    storage: {
      local: {
        get(key, cb) {
          const out = {};
          out[key] = state[key] == null ? undefined : JSON.parse(JSON.stringify(state[key]));
          cb(out);
        },
        set(patch, cb) {
          if (failNextSet) {
            chrome.runtime.lastError = { message: 'QUOTA_BYTES' };
            failNextSet = false;
            cb();
            chrome.runtime.lastError = null;
            return;
          }
          for (const k of Object.keys(patch)) state[k] = JSON.parse(JSON.stringify(patch[k]));
          cb();
        },
      },
    },
    runtime: { lastError: null },
  };
  return {
    chrome,
    stored: () => state.suggestions,
    failNextSet: () => { failNextSet = true; },
  };
}

function install(mock) {
  global.chrome = mock.chrome;
}

const TESTS = [];
function t(name, fn) {
  TESTS.push([name, fn]);
}

/* ---------- mergeSuggestions (чистая) ---------- */

t('mergeSuggestions: объединяет, нормализует, сортирует по-русски', () => {
  const out = S.mergeSuggestions(['Физика', 'Матан'], ['  АЯ д/акад. ', 'Матан']);
  assert.deepStrictEqual(out, ['АЯ д/акад.', 'Матан', 'Физика']);
});

t('mergeSuggestions: пустые и мусорные значения отбрасываются', () => {
  assert.deepStrictEqual(S.mergeSuggestions([], ['', '   ', null, undefined, 'Матан']), ['Матан']);
  assert.deepStrictEqual(S.mergeSuggestions(null, null), []);
});

t('mergeSuggestions: при переполнении свежее вытесняет старое', () => {
  // Лимит 2: обе увиденные сейчас записи должны остаться, старые — уйти.
  const out = S.mergeSuggestions(['Старое A', 'Старое B'], ['Новое A', 'Новое B'], 2);
  assert.deepStrictEqual(out, ['Новое A', 'Новое B']);
});

t('mergeSuggestions: свободное место добирается сохранённым', () => {
  const out = S.mergeSuggestions(['Старое A', 'Старое B'], ['Новое A'], 2);
  assert.deepStrictEqual(out, ['Новое A', 'Старое A']);
});

t('sameSuggestions: сравнение списков', () => {
  assert.ok(S.sameSuggestions(['а', 'б'], ['а', 'б']));
  assert.ok(!S.sameSuggestions(['а'], ['а', 'б']));
  assert.ok(!S.sameSuggestions(['а', 'б'], ['б', 'а']));
  assert.ok(!S.sameSuggestions(null, []));
});

/* ---------- storage ---------- */

t('loadSuggestions: пустое хранилище → пустые списки', async () => {
  install(makeChromeMock(null));
  assert.deepStrictEqual(await S.loadSuggestions(), { subjects: [], teachers: [] });
});

t('loadSuggestions: битые данные не роняют чтение', async () => {
  install(makeChromeMock({ subjects: 'не массив' }));
  assert.deepStrictEqual(await S.loadSuggestions(), { subjects: [], teachers: [] });
});

t('addSuggestions: первая запись сохраняет увиденное', async () => {
  const mock = makeChromeMock(null);
  install(mock);
  const res = await S.addSuggestions({ subjects: ['Матан', 'Матан'], teachers: ['Иванов И. И.'] });
  assert.strictEqual(res.status, 'saved');
  assert.deepStrictEqual(mock.stored(), {
    subjects: ['Матан'],
    teachers: ['Иванов И. И.'],
  });
});

t('addSuggestions: без изменений в хранилище не пишет', async () => {
  const mock = makeChromeMock({ subjects: ['Матан'], teachers: [] });
  install(mock);
  const res = await S.addSuggestions({ subjects: ['Матан'], teachers: [] });
  assert.strictEqual(res.status, 'unchanged', 'повторный прогон расписания не дёргает storage');
});

t('addSuggestions: новое имя добавляется к сохранённым', async () => {
  const mock = makeChromeMock({ subjects: ['Матан'], teachers: [] });
  install(mock);
  await S.addSuggestions({ subjects: ['Физика'], teachers: ['Петров П. П.'] });
  assert.deepStrictEqual(mock.stored(), {
    subjects: ['Матан', 'Физика'],
    teachers: ['Петров П. П.'],
  });
});

t('addSuggestions: lastError при записи → error, сохранённое не теряется', async () => {
  const mock = makeChromeMock({ subjects: ['Матан'], teachers: [] });
  install(mock);
  mock.failNextSet();
  const res = await S.addSuggestions({ subjects: ['Физика'], teachers: [] });
  assert.strictEqual(res.status, 'error');
  assert.deepStrictEqual(mock.stored(), { subjects: ['Матан'], teachers: [] });
});

t('clearSuggestions: обнуляет оба списка', async () => {
  const mock = makeChromeMock({ subjects: ['Матан'], teachers: ['Иванов И. И.'] });
  install(mock);
  assert.deepStrictEqual(await S.clearSuggestions(), { status: 'cleared' });
  assert.deepStrictEqual(mock.stored(), { subjects: [], teachers: [] });
});

/* ---------- Запуск ---------- */

async function run() {
  console.log('suggestions.test.js');
  let failed = 0;
  for (const [name, fn] of TESTS) {
    try {
      await fn();
      console.log('  ok - ' + name);
    } catch (err) {
      failed++;
      console.error('  FAIL - ' + name);
      console.error('    ' + (err && err.message));
    }
  }
  console.log('\nВсего тестов: ' + TESTS.length + (failed ? ', провалено: ' + failed : ''));
  if (failed) process.exit(1);
}

run();
