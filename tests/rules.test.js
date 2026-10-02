/**
 * Юнит-тесты для lib/rules.js на моке chrome.storage.sync (Node, без chrome API).
 * Запуск: node tests/rules.test.js
 */
'use strict';

const assert = require('assert');
require('../lib/text.js'); // общая нормализация — грузится первой, как в манифесте
const R = require('../lib/rules.js');

/* ---------- Мок chrome.storage.sync ---------- */

// Мок chrome: in-memory storage, lastError с семантикой Chrome, флаг сбоя записи.
function makeChromeMock(initialRules = []) {
  const state = { rules: JSON.parse(JSON.stringify(initialRules)) };
  let failNextSet = false;
  const chrome = {
    storage: {
      sync: {
        get(key, cb) {
          const keys = Array.isArray(key) ? key : [key];
          const out = {};
          for (const k of keys) {
            if (state[k] !== undefined) out[k] = JSON.parse(JSON.stringify(state[k]));
          }
          cb(out);
        },
        set(patch, cb) {
          // Квота sync на ключ, как в Chrome: ключ + JSON значения в UTF-8.
          const overQuota = Object.keys(patch).some((k) =>
            Buffer.byteLength(k + JSON.stringify(patch[k]), 'utf8') > 8192);
          if (overQuota) {
            chrome.runtime.lastError = { message: 'QUOTA_BYTES_PER_ITEM quota exceeded' };
            cb();
            chrome.runtime.lastError = null;
            return;
          }
          if (failNextSet) {
            // Как в Chrome: lastError выставлен на время коллбэка и снимается
            // рантаймом сразу после возврата — код под тестом его не чистит.
            chrome.runtime.lastError = { message: 'Quota exceeded bytes' };
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
    state,
    // Набор целиком — все части хранилища по порядку (см. R.RULE_KEYS).
    rules: () => R.RULE_KEYS.flatMap((k) => state[k] || []),
    failNextSet: () => {
      failNextSet = true;
    },
  };
}

/** Установка мока chrome для следующего теста. */
function install(mock) {
  global.chrome = mock.chrome;
}

// Правило для тестов (без вида занятия — как правила v1.0).
function rule(subject, teacher = null, enabled = true) {
  return { subject, teacher, enabled };
}

// Правило с видом занятия.
function typed(subject, teacher, type, enabled = true) {
  return { subject, teacher, type, enabled };
}

const TESTS = [];
function t(name, fn) {
  TESTS.push([name, fn]);
}

/* ---------- normalize / keyOf / wouldAbsorb (чистые) ---------- */

t('normalize: пробелы и NBSP', () => {
  assert.strictEqual(R.normalize('  АЯ\u00a0д/акад.целей.  '), 'АЯ д/акад.целей.');
  assert.strictEqual(R.normalize(null), '');
});

// Контракт общей нормализации: rules и matcher обязаны нормализовать
// одинаково, иначе правило перестанет совпадать с парой молча.
t('normalize: rules, matcher и lib/text — одна и та же функция', () => {
  const T = require('../lib/text.js');
  const M = require('../content/matcher.js');
  assert.strictEqual(R.normalize, T.normalize, 'rules берёт normalize из lib/text');
  assert.strictEqual(M.normalize, T.normalize, 'matcher берёт normalize из lib/text');
  for (const sample of ['  АЯ\u00a0д/акад.  ', 'Иванов\u00a0И.\u00a0И.', '', ' \t\n ']) {
    assert.strictEqual(R.normalize(sample), M.normalize(sample));
  }
});

t('formatRule: подпись правила для меню и сообщений', () => {
  assert.strictEqual(R.formatRule(rule('Матан', 'Иванов И. И.')), 'Матан — Иванов И. И.');
  assert.strictEqual(R.formatRule(rule('Матан', null)), 'Матан — все преподаватели');
  // Пустой преподаватель — то же, что «все» (см. sanitizeRule/isNarrow).
  assert.strictEqual(R.formatRule(rule('Матан', '  ')), 'Матан — все преподаватели');
  // Подпись нормализована так же, как ключи правил.
  assert.strictEqual(R.formatRule(rule(' АЯ\u00a0д/акад. ', null)), 'АЯ д/акад. — все преподаватели');
});

t('keyOf: одинаковый ключ при разном форматировании', () => {
  const a = R.keyOf(rule('АЯ\u00a0д/акад.', null));
  const b = R.keyOf(rule(' АЯ  д/акад. ', null));
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, R.keyOf(rule('АЯ д/акад.', 'Иванов И. И.')));
});

t('wouldAbsorb: только включённые узкие того же предмета', () => {
  const rules = [
    rule('Математика', 'Иванов И. И.'), // включённое узкое — поглощается
    rule('Математика', 'Петров П. П.', false), // выключенное узкое — нет
    rule('Физика', 'Иванов И. И.'), // другой предмет — нет
    rule('Математика'), // широкое того же предмета — нет (не узкое)
  ];
  const absorbed = R.wouldAbsorb(rule('Математика'), rules);
  assert.strictEqual(absorbed.length, 1);
  assert.strictEqual(absorbed[0].teacher, 'Иванов И. И.');
});

t('wouldAbsorb: узкое правило не поглощает', () => {
  const rules = [rule('Математика', 'Иванов И. И.')];
  assert.strictEqual(R.wouldAbsorb(rule('Математика', 'Иванов И. И.'), rules).length, 0);
});

t('wouldAbsorb: выключенное широкое правило не поглощает', () => {
  const rules = [rule('Математика', 'Иванов И. И.')];
  assert.strictEqual(R.wouldAbsorb(rule('Математика', null, false), rules).length, 0);
});

/* ---------- planAdd ---------- */

t('planAdd: ok для нового правила', () => {
  assert.strictEqual(R.planAdd(rule('Математика'), []).status, 'ok');
});

t('planAdd: невалидное правило', () => {
  assert.strictEqual(R.planAdd({ subject: '   ', teacher: null }, []).status, 'invalid');
});

t('planAdd: дубликат (вкл или выкл) не создаётся', () => {
  const rules = [rule('Математика', 'Иванов И. И.')];
  const plan = R.planAdd(rule('Математика', 'Иванов И. И.', false), rules);
  assert.strictEqual(plan.status, 'duplicate');
  assert.strictEqual(plan.existing.teacher, 'Иванов И. И.');
});

t('planAdd: узкое при активном «у всех» — covered', () => {
  const rules = [rule('Математика')]; // включённое широкое
  const plan = R.planAdd(rule('Математика', 'Иванов И. И.'), rules);
  assert.strictEqual(plan.status, 'covered');
  assert.strictEqual(plan.covering.teacher, null);
});

t('planAdd: широкое требует подтверждения поглощения', () => {
  const rules = [rule('Математика', 'Иванов И. И.')];
  const plan = R.planAdd(rule('Математика'), rules);
  assert.strictEqual(plan.status, 'absorb');
  assert.strictEqual(plan.absorbed.length, 1);
});

t('planAdd: поглощение считает лимит по итогу', () => {
  const rules = [];
  for (let i = 0; i < 99; i++) rules.push(rule('Предмет ' + i, 'Иванов И. И.'));
  const plan = R.planAdd(rule('Общий'), rules); // поглощает 99 узких
  assert.strictEqual(plan.status, 'ok');
});

t('planAdd: лимит 100', () => {
  const rules = [];
  for (let i = 0; i < 100; i++) rules.push(rule('Предмет ' + i, 'Иванов И. И.'));
  const plan = R.planAdd(rule('Еще один'), rules);
  assert.strictEqual(plan.status, 'limit');
  assert.strictEqual(plan.current, 100);
});

/* ---------- Вид занятия (ЛК/ПР/ЛБ) ---------- */

t('sanitizeRule: правило v1.0 без вида — «все занятия» (type: null)', () => {
  assert.deepStrictEqual(R.sanitizeRule(rule('Матан', 'Иванов И. И.')),
    { subject: 'Матан', teacher: 'Иванов И. И.', type: null, enabled: true });
  assert.strictEqual(R.sanitizeRule(typed('Матан', null, '  ')).type, null, 'пустой вид — любой');
  assert.strictEqual(R.sanitizeRule(typed('Матан', null, ' ЛК ')).type, 'ЛК');
});

t('formatRule: вид занятия — как на сайте, «Название (ЛК)»', () => {
  assert.strictEqual(R.formatRule(typed('Матан', null, 'ЛК')), 'Матан (ЛК) — все преподаватели');
  assert.strictEqual(R.formatRule(typed('Матан', 'Иванов И. И.', 'ПР')), 'Матан (ПР) — Иванов И. И.');
  assert.strictEqual(R.formatRule(typed('Матан', null, null)), 'Матан — все преподаватели');
});

t('typeLabel: подписи видов и «все занятия»', () => {
  assert.strictEqual(R.typeLabel('ЛК'), 'лекции');
  assert.strictEqual(R.typeLabel('ПР'), 'практики');
  assert.strictEqual(R.typeLabel('ЛБ'), 'лабораторные');
  assert.strictEqual(R.typeLabel(null), 'все занятия');
  assert.strictEqual(R.typeLabel('КСР'), 'КСР', 'незнакомый вид подписывается кодом');
});

t('keyOf: вид занятия — часть ключа', () => {
  assert.notStrictEqual(R.keyOf(typed('Матан', null, 'ЛК')), R.keyOf(typed('Матан', null, 'ПР')));
  assert.notStrictEqual(R.keyOf(typed('Матан', null, 'ЛК')), R.keyOf(rule('Матан')));
  assert.strictEqual(R.keyOf(typed('Матан', null, null)), R.keyOf(rule('Матан')),
    'правило v1.0 и правило «все занятия» — одно и то же');
});

t('covers: «любой» покрывает конкретный, пересечение — не покрытие', () => {
  const all = rule('Матан');
  const lk = typed('Матан', null, 'ЛК');
  const ivanov = rule('Матан', 'Иванов И. И.');
  const ivanovLk = typed('Матан', 'Иванов И. И.', 'ЛК');
  assert.ok(R.covers(all, lk) && R.covers(all, ivanov) && R.covers(all, ivanovLk));
  assert.ok(R.covers(lk, ivanovLk), 'лекции у всех ⊇ лекции у Иванова');
  assert.ok(R.covers(ivanov, ivanovLk), 'всё у Иванова ⊇ его лекции');
  assert.ok(!R.covers(lk, ivanov) && !R.covers(ivanov, lk), 'пересекаются, но не покрывают');
  assert.ok(!R.covers(lk, typed('Матан', null, 'ПР')), 'другой вид');
  assert.ok(!R.covers(all, rule('Физика')), 'другой предмет');
  assert.ok(!R.covers(all, rule('Матан')), 'само себя правило не покрывает — это дубликат');
});

t('wouldAbsorb: «все занятия» поглощает правила по видам того же предмета', () => {
  const rules = [
    typed('Матан', null, 'ЛК'),
    typed('Матан', 'Иванов И. И.', 'ПР'),
    typed('Матан', null, 'ЛБ', false), // выключенное — нет
    typed('Физика', null, 'ЛК'), // другой предмет — нет
  ];
  assert.deepStrictEqual(R.wouldAbsorb(rule('Матан'), rules).map(R.formatRule), [
    'Матан (ЛК) — все преподаватели',
    'Матан (ПР) — Иванов И. И.',
  ]);
});

t('wouldAbsorb: «лекции у всех» не трогает «у Иванова» (пересечение)', () => {
  const rules = [rule('Матан', 'Иванов И. И.'), typed('Матан', 'Петров П. П.', 'ЛК')];
  assert.deepStrictEqual(R.wouldAbsorb(typed('Матан', null, 'ЛК'), rules).map(R.formatRule),
    ['Матан (ЛК) — Петров П. П.']);
});

t('planAdd: правило по виду при «все занятия» — covered', () => {
  const plan = R.planAdd(typed('Матан', null, 'ПР'), [rule('Матан')]);
  assert.strictEqual(plan.status, 'covered');
  assert.strictEqual(plan.covering.subject, 'Матан');
});

t('planAdd: лекции и практики одного предмета — разные правила', () => {
  assert.strictEqual(R.planAdd(typed('Матан', null, 'ПР'), [typed('Матан', null, 'ЛК')]).status, 'ok');
  assert.strictEqual(R.planAdd(typed('Матан', null, 'ЛК'), [typed('Матан', null, 'ЛК', false)]).status,
    'duplicate');
});

t('planAdd: пересекающиеся правила добавляются без поглощения', () => {
  const plan = R.planAdd(typed('Матан', null, 'ЛК'), [rule('Матан', 'Иванов И. И.')]);
  assert.strictEqual(plan.status, 'ok');
});

t('parseRulesExport: файл версии 1 (без вида) читается как «все занятия»', () => {
  const v1 = JSON.stringify({ format: 'rasp-hide-rules', version: 1,
    rules: [{ subject: 'Матан', teacher: null, enabled: true }] });
  assert.deepStrictEqual(R.parseRulesExport(v1).rules,
    [{ subject: 'Матан', teacher: null, type: null, enabled: true }]);
});

t('экспорт: вид занятия попадает в файл и возвращается импортом', () => {
  const text = R.serializeRules([typed('Матан', null, 'ЛК')], {});
  assert.strictEqual(JSON.parse(text).version, 2);
  assert.deepStrictEqual(R.parseRulesExport(text).rules,
    [{ subject: 'Матан', teacher: null, type: 'ЛК', enabled: true }]);
});

t('ruleMatchesPair: та же семантика, что matchRule в content/matcher.js', () => {
  const M = require('../content/matcher.js');
  const rules = [
    rule('Матан'), rule('Матан', 'Иванов И. И.'), typed('Матан', null, 'ЛК'),
    typed('Матан', 'Иванов И. И.', 'ПР'), rule('Матан', null, false), rule('Физика'),
    typed('Матан', null, '  '), rule('Матан', '  '),
  ];
  const pairs = [];
  for (const teacher of ['Иванов И. И.', 'Петров П. П.', null]) {
    for (const type of ['ЛК', 'ПР', null]) pairs.push({ subject: 'Матан', teacher, type });
  }
  for (const r of rules) {
    for (const p of pairs) {
      assert.strictEqual(R.ruleMatchesPair(r, p), M.matchRule(p.subject, p.teacher, r, p.type),
        R.formatRule(r) + ' / ' + JSON.stringify(p));
    }
  }
});

/* ---------- Хранение частями ---------- */

/** @returns {number} размер значения так, как его считает квота sync (UTF-8) */
function syncBytes(key, value) {
  return Buffer.byteLength(key + JSON.stringify(value), 'utf8');
}

/** Сотня «тяжёлых» правил: длинная кириллица, преподаватель и вид. */
function heavyRules(n = R.MAX_RULES) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(R.sanitizeRule(typed('Иностранный язык (английский) подгруппа ' + i,
      'Константинопольская-Щедрина А. В.', 'ПР')));
  }
  return out;
}

t('chunkRules: сотня длинных правил раскладывается в квоту sync', () => {
  const rules = heavyRules();
  // В один ключ это не влезает — ради этого набор и хранится частями.
  assert.ok(syncBytes('rules', rules) > 8192, 'тест должен превышать квоту одного ключа');
  const chunks = R.chunkRules(rules);
  assert.ok(chunks && chunks.length <= R.RULE_KEYS.length, 'помещается во все части');
  chunks.forEach((chunk, i) => {
    assert.ok(syncBytes(R.RULE_KEYS[i], chunk) <= 8192, 'часть ' + i + ' в квоте ключа');
  });
  assert.deepStrictEqual(chunks.flat(), rules, 'порядок и содержимое сохранены');
});

t('chunkRules: неподъёмный набор — null (а не порча хранилища)', () => {
  const huge = [R.sanitizeRule(rule('Я'.repeat(5000)))];
  assert.strictEqual(R.chunkRules(huge), null);
});

t('saveRules/loadRules: сотня правил — запись и чтение по частям', async () => {
  const mock = makeChromeMock([]);
  install(mock);
  const rules = heavyRules();
  const saved = await R.saveRules(rules);
  assert.strictEqual(saved.ok, true);
  for (const key of R.RULE_KEYS) {
    assert.ok(Array.isArray(mock.state[key]), key + ' записан');
    assert.ok(syncBytes(key, mock.state[key]) <= 8192, key + ' в квоте ключа');
  }
  assert.deepStrictEqual(await R.loadRules(), rules);
});

t('saveRules: короткий набор после длинного не оставляет «хвостов»', async () => {
  const mock = makeChromeMock([]);
  install(mock);
  await R.saveRules(heavyRules());
  await R.saveRules([R.sanitizeRule(rule('Матан'))]);
  assert.deepStrictEqual(mock.rules().map(R.formatRule), ['Матан — все преподаватели']);
});

t('loadRules: данные v1.0 в одном ключе rules читаются как есть', async () => {
  const mock = makeChromeMock([rule('Матан', 'Иванов И. И.')]); // только ключ rules
  install(mock);
  assert.deepStrictEqual(await R.loadRules(),
    [{ subject: 'Матан', teacher: 'Иванов И. И.', type: null, enabled: true }]);
});

t('hasRulesChange: изменение любой части набора', () => {
  assert.ok(R.hasRulesChange({ rules: {} }));
  assert.ok(R.hasRulesChange({ rules_2: {} }));
  assert.ok(!R.hasRulesChange({ enabled: {}, style: {} }));
  assert.ok(!R.hasRulesChange(null));
});

t('addRule: сотое правило записывается и при длинных названиях', async () => {
  const mock = makeChromeMock(heavyRules(R.MAX_RULES - 1));
  install(mock);
  const res = await R.addRule(typed('Ещё один очень длинный предмет с кириллицей', null, 'ЛК'));
  assert.strictEqual(res.status, 'added');
  assert.strictEqual((await R.loadRules()).length, R.MAX_RULES);
});

/* ---------- addRule ---------- */

t('addRule: добавляет правило', async () => {
  const mock = makeChromeMock();
  install(mock);
  const res = await R.addRule(rule('Математика', 'Иванов И. И.'));
  assert.strictEqual(res.status, 'added');
  assert.strictEqual(mock.rules().length, 1);
  assert.strictEqual(mock.rules()[0].subject, 'Математика');
});

t('addRule: дубликат блокируется, storage не меняется', async () => {
  const mock = makeChromeMock([rule('Математика', 'Иванов И. И.')]);
  install(mock);
  const res = await R.addRule(rule('Математика', 'Иванов И. И.', false));
  assert.strictEqual(res.status, 'duplicate');
  assert.strictEqual(mock.rules().length, 1);
});

t('addRule: covered не записывается', async () => {
  const mock = makeChromeMock([rule('Математика')]);
  install(mock);
  const res = await R.addRule(rule('Математика', 'Иванов И. И.'));
  assert.strictEqual(res.status, 'covered');
  assert.strictEqual(mock.rules().length, 1);
});

t('addRule: поглощение без autoAbsorb — только план, ничего не записано', async () => {
  const mock = makeChromeMock([rule('Математика', 'Иванов И. И.')]);
  install(mock);
  const res = await R.addRule(rule('Математика'));
  assert.strictEqual(res.status, 'absorb');
  assert.strictEqual(res.absorbed.length, 1);
  assert.strictEqual(mock.rules().length, 1); // не тронуто
});

t('addRule: autoAbsorb удаляет узкие и добавляет широкое', async () => {
  const mock = makeChromeMock([
    rule('Математика', 'Иванов И. И.'),
    rule('Математика', 'Петров П. П.'),
  ]);
  install(mock);
  const res = await R.addRule(rule('Математика'), { autoAbsorb: true });
  assert.strictEqual(res.status, 'absorbed');
  assert.strictEqual(res.absorbed.length, 2);
  assert.strictEqual(mock.rules().length, 1);
  assert.strictEqual(mock.rules()[0].teacher, null);
  assert.strictEqual(mock.rules()[0].enabled, true);
});

t('addRule: лимит 100 — 101-е правило блокируется', async () => {
  const rules = [];
  for (let i = 0; i < 100; i++) rules.push(rule('Предмет ' + i, 'Иванов И. И.'));
  const mock = makeChromeMock(rules);
  install(mock);
  const res = await R.addRule(rule('Еще один', 'Иванов И. И.'));
  assert.strictEqual(res.status, 'limit');
  assert.strictEqual(mock.rules().length, 100);
});

t('addRule: lastError при записи → error, данные не теряются', async () => {
  const mock = makeChromeMock([rule('Математика')]);
  install(mock);
  mock.failNextSet();
  const res = await R.addRule(rule('Физика'));
  assert.strictEqual(res.status, 'error');
  assert.strictEqual(res.message, R.MSG_NOT_SAVED);
  assert.strictEqual(mock.rules().length, 1); // старый набор не тронут
});

/* ---------- setEnabled ---------- */

t('setEnabled: выключенное правило включается без поглощения', async () => {
  const mock = makeChromeMock([rule('Математика', null, false)]);
  install(mock);
  const res = await R.setEnabled({ subject: 'Математика', teacher: null }, true);
  assert.strictEqual(res.status, 'enabled');
  assert.strictEqual(mock.rules()[0].enabled, true);
});

t('setEnabled: включённое выключается', async () => {
  const mock = makeChromeMock([rule('Математика')]);
  install(mock);
  const res = await R.setEnabled({ subject: 'Математика', teacher: null }, false);
  assert.strictEqual(res.status, 'disabled');
  assert.strictEqual(mock.rules()[0].enabled, false);
});

t('setEnabled: включение широкого поглощает узкого (с подтверждением)', async () => {
  const mock = makeChromeMock([rule('Математика', 'Иванов И. И.'), rule('Математика', null, false)]);
  install(mock);
  // сначала без autoAbsorb — только план
  const plan = await R.setEnabled({ subject: 'Математика', teacher: null }, true);
  assert.strictEqual(plan.status, 'absorb');
  assert.strictEqual(plan.absorbed.length, 1);
  assert.strictEqual(mock.rules().length, 2);
  // с подтверждением — поглощает
  const res = await R.setEnabled({ subject: 'Математика', teacher: null }, true, {
    autoAbsorb: true,
  });
  assert.strictEqual(res.status, 'absorbed');
  assert.strictEqual(mock.rules().length, 1);
  assert.strictEqual(mock.rules()[0].teacher, null);
  assert.strictEqual(mock.rules()[0].enabled, true);
});

t('setEnabled: узкое при активном «у всех» не включается', async () => {
  const mock = makeChromeMock([rule('Математика'), rule('Математика', 'Иванов И. И.', false)]);
  install(mock);
  const res = await R.setEnabled({ subject: 'Математика', teacher: 'Иванов И. И.' }, true);
  assert.strictEqual(res.status, 'covered');
  assert.strictEqual(mock.rules().length, 2);
});

t('setEnabled: правило не найдено', async () => {
  const mock = makeChromeMock([]);
  install(mock);
  const res = await R.setEnabled({ subject: 'Нет', teacher: null }, true);
  assert.strictEqual(res.status, 'notFound');
});

/* ---------- removeRule ---------- */

t('removeRule: удаляет правило', async () => {
  const mock = makeChromeMock([rule('Математика')]);
  install(mock);
  const res = await R.removeRule({ subject: 'Математика', teacher: null });
  assert.strictEqual(res.status, 'removed');
  assert.strictEqual(mock.rules().length, 0);
});

t('removeRule: несуществующее правило — notFound', async () => {
  const mock = makeChromeMock([]);
  install(mock);
  const res = await R.removeRule({ subject: 'Нет', teacher: null });
  assert.strictEqual(res.status, 'notFound');
});

/* ---------- restorePair ---------- */

t('restorePair: одно правило снимается сразу', async () => {
  const mock = makeChromeMock([rule('Математика', 'Иванов И. И.'), rule('Физика')]);
  install(mock);
  const res = await R.restorePair({ subject: 'Математика', teachers: ['Иванов И. И.'], type: 'ЛК' });
  assert.strictEqual(res.status, 'restored');
  assert.strictEqual(res.rules.length, 1);
  assert.strictEqual(res.rules[0].teacher, 'Иванов И. И.');
  assert.deepStrictEqual(mock.rules().map(R.formatRule), ['Физика — все преподаватели']);
});

t('restorePair: только широкое — удаляет его', async () => {
  const mock = makeChromeMock([rule('Математика')]);
  install(mock);
  const res = await R.restorePair({ subject: 'Математика', teachers: ['Иванов И. И.'], type: 'ПР' });
  assert.strictEqual(res.status, 'restored');
  assert.strictEqual(mock.rules().length, 0);
});

t('restorePair: пересекающиеся правила — только с подтверждением, снимаются все', async () => {
  // «у Иванова» и «лекции у всех» не покрывают друг друга, но вместе скрывают его лекцию.
  const mock = makeChromeMock([
    rule('Математика', 'Иванов И. И.'),
    typed('Математика', null, 'ЛК'),
    typed('Математика', null, 'ПР'),
  ]);
  install(mock);
  const target = { subject: 'Математика', teachers: ['Иванов И. И.'], type: 'ЛК' };
  const first = await R.restorePair(target);
  assert.strictEqual(first.status, 'confirm');
  assert.deepStrictEqual(first.rules.map(R.formatRule).sort(), [
    'Математика (ЛК) — все преподаватели',
    'Математика — Иванов И. И.',
  ]);
  assert.strictEqual(mock.rules().length, 3, 'без подтверждения ничего не удалено');

  const second = await R.restorePair(target, { confirmed: true });
  assert.strictEqual(second.status, 'restored');
  assert.deepStrictEqual(mock.rules().map(R.formatRule), ['Математика (ПР) — все преподаватели'],
    'правило другого вида не тронуто');
});

t('restorePair: пара целиком — правила всех её блоков', async () => {
  // Пара скрыта целиком, потому что скрыты оба блока — своими правилами.
  const mock = makeChromeMock([rule('АЯ', 'Иванов И. И.'), rule('АЯ', 'Петров П. П.')]);
  install(mock);
  const target = { subject: 'АЯ', teachers: ['Иванов И. И.', 'Петров П. П.'], type: 'ПР' };
  assert.strictEqual((await R.restorePair(target)).status, 'confirm');
  assert.strictEqual((await R.restorePair(target, { confirmed: true })).status, 'restored');
  assert.strictEqual(mock.rules().length, 0);
});

t('restorePair: выключенные и чужие правила не трогаются', async () => {
  const mock = makeChromeMock([rule('Математика', null, false), typed('Математика', null, 'ПР')]);
  install(mock);
  const res = await R.restorePair({ subject: 'Математика', teachers: [null], type: 'ЛК' });
  assert.strictEqual(res.status, 'none');
  assert.strictEqual(mock.rules().length, 2);
});

t('restorePair: нет подходящего — none', async () => {
  const mock = makeChromeMock([]);
  install(mock);
  const res = await R.restorePair({ subject: 'Математика', teachers: [], type: null });
  assert.strictEqual(res.status, 'none');
});

/* ---------- resetRules ---------- */

t('resetRules: обнуляет только rules', async () => {
  const mock = makeChromeMock([rule('Математика')]);
  install(mock);
  const res = await R.resetRules();
  assert.strictEqual(res.status, 'reset');
  assert.strictEqual(mock.rules().length, 0);
});

t('resetRules: lastError → error', async () => {
  const mock = makeChromeMock([rule('Математика')]);
  install(mock);
  mock.failNextSet();
  const res = await R.resetRules();
  assert.strictEqual(res.status, 'error');
  assert.strictEqual(mock.rules().length, 1); // не тронуто
});

/* ---------- Экспорт / импорт ---------- */

t('serializeRules: формат файла, санитизация, воспроизводимость', () => {
  const text = R.serializeRules(
    [rule(' Матан ', null), rule('АЯ', ' Иванов И. И. ', false), { subject: '  ' }],
    { exportedAt: '2026-09-05T00:00:00.000Z' }
  );
  const data = JSON.parse(text);
  assert.strictEqual(data.format, R.EXPORT_FORMAT);
  assert.strictEqual(data.version, R.EXPORT_VERSION);
  assert.strictEqual(data.exportedAt, '2026-09-05T00:00:00.000Z');
  assert.deepStrictEqual(data.rules, [
    { subject: 'Матан', teacher: null, type: null, enabled: true },
    { subject: 'АЯ', teacher: 'Иванов И. И.', type: null, enabled: false },
  ], 'правила нормализованы, правило без предмета отброшено');
  // Тот же вход — тот же файл (время приходит аргументом, не Date.now()).
  assert.strictEqual(text, R.serializeRules([rule('Матан'), rule('АЯ', 'Иванов И. И.', false)],
    { exportedAt: '2026-09-05T00:00:00.000Z' }));
});

t('parseRulesExport: свой файл, голый массив, мусор', () => {
  const own = R.serializeRules([rule('Матан', 'Иванов И. И.')], {});
  assert.deepStrictEqual(R.parseRulesExport(own), {
    status: 'ok',
    rules: [{ subject: 'Матан', teacher: 'Иванов И. И.', type: null, enabled: true }],
  });

  // Голый массив — файл могли собрать руками.
  const bare = R.parseRulesExport('[{"subject":"Физика","teacher":null}]');
  assert.deepStrictEqual(bare.rules, [{ subject: 'Физика', teacher: null, type: null, enabled: true }]);

  // Мусорные записи внутри валидного файла отбрасываются, не роняют разбор.
  const dirty = R.parseRulesExport('{"rules":[{"subject":""},null,7,{"subject":"ОС"}]}');
  assert.deepStrictEqual(dirty.rules, [{ subject: 'ОС', teacher: null, type: null, enabled: true }]);

  for (const bad of ['не json', '{}', '{"rules":{}}', '{"format":"other","rules":[]}']) {
    assert.strictEqual(R.parseRulesExport(bad).status, 'invalid', bad);
    assert.strictEqual(R.parseRulesExport(bad).message, R.MSG_BAD_FILE);
  }
});

t('planImport: слияние — дубликаты и покрытые пропускаются', () => {
  const existing = [rule('Матан', null), rule('Физика', 'Петров П. П.')];
  const plan = R.planImport(
    [rule('Матан', null), rule('Матан', 'Иванов И. И.'), rule('Химия', null)],
    existing
  );
  assert.strictEqual(plan.status, 'ok');
  assert.deepStrictEqual(plan.added, [{ subject: 'Химия', teacher: null, type: null, enabled: true }]);
  assert.deepStrictEqual(plan.skipped.map((x) => x.reason), ['duplicate', 'covered']);
  assert.deepStrictEqual(plan.absorbed, [], 'ничего из текущего набора не пропало');
  assert.strictEqual(plan.result.length, 3);
});

t('planImport: широкое правило из файла поглощает узкие — с указанием, что пропадёт', () => {
  const narrow = rule('АЯ', 'Иванов И. И.');
  const plan = R.planImport([rule('АЯ', null)], [narrow, rule('Матан', null)]);
  assert.strictEqual(plan.status, 'ok');
  assert.deepStrictEqual(plan.absorbed, [narrow], 'узкое правило пропадёт — это надо показать');
  assert.deepStrictEqual(
    plan.result.map(R.formatRule).sort(),
    ['АЯ — все преподаватели', 'Матан — все преподаватели']
  );
});

t('planImport: поглощение внутри самого файла в absorbed не попадает', () => {
  // Файл сам нарушает инвариант: и узкое, и широкое правило одного предмета.
  const plan = R.planImport([rule('АЯ', 'Иванов И. И.'), rule('АЯ', null)], []);
  assert.strictEqual(plan.status, 'ok');
  assert.deepStrictEqual(plan.absorbed, [], 'из текущего набора не пропало ничего');
  assert.deepStrictEqual(plan.result, [{ subject: 'АЯ', teacher: null, type: null, enabled: true }]);
});

t('planImport: replace заменяет набор целиком', () => {
  const plan = R.planImport([rule('Химия', null)], [rule('Матан', null)], { replace: true });
  assert.strictEqual(plan.status, 'ok');
  assert.deepStrictEqual(plan.result, [{ subject: 'Химия', teacher: null, type: null, enabled: true }]);
});

t('planImport: не помещается в лимит — импорт не выполняется наполовину', () => {
  const existing = [];
  for (let i = 0; i < R.MAX_RULES - 1; i++) existing.push(rule('Предмет ' + i, null));
  const plan = R.planImport([rule('Новый A', null), rule('Новый B', null)], existing);
  assert.strictEqual(plan.status, 'limit');
  assert.strictEqual(plan.fits, R.MAX_RULES, 'сообщение может назвать, сколько поместилось бы');
});

t('importRules: разрушительный импорт требует подтверждения', async () => {
  const mock = makeChromeMock([rule('АЯ', 'Иванов И. И.')]);
  install(mock);

  const first = await R.importRules([rule('АЯ', null)]);
  assert.strictEqual(first.status, 'confirm', 'поглощение — только с подтверждением');
  assert.deepStrictEqual(mock.rules(), [{ subject: 'АЯ', teacher: 'Иванов И. И.', enabled: true }],
    'без подтверждения ничего не записано (правило v1.0 — как лежало)');

  const second = await R.importRules([rule('АЯ', null)], { confirmed: true });
  assert.strictEqual(second.status, 'imported');
  assert.deepStrictEqual(mock.rules(), [{ subject: 'АЯ', teacher: null, type: null, enabled: true }]);
});

t('importRules: неразрушительный импорт идёт сразу', async () => {
  const mock = makeChromeMock([rule('Матан', null)]);
  install(mock);
  const res = await R.importRules([rule('Химия', null)]);
  assert.strictEqual(res.status, 'imported');
  assert.strictEqual(mock.rules().length, 2);
});

t('importRules: replace поверх непустого набора требует подтверждения', async () => {
  const mock = makeChromeMock([rule('Матан', null)]);
  install(mock);
  assert.strictEqual((await R.importRules([rule('Химия', null)], { replace: true })).status, 'confirm');
  assert.deepStrictEqual(mock.rules(), [{ subject: 'Матан', teacher: null, enabled: true }]);

  const res = await R.importRules([rule('Химия', null)], { replace: true, confirmed: true });
  assert.strictEqual(res.status, 'imported');
  assert.deepStrictEqual(mock.rules(), [{ subject: 'Химия', teacher: null, type: null, enabled: true }]);
});

t('importRules: lastError при записи → error, данные не теряются', async () => {
  const mock = makeChromeMock([rule('Матан', null)]);
  install(mock);
  mock.failNextSet();
  const res = await R.importRules([rule('Химия', null)]);
  assert.strictEqual(res.status, 'error');
  assert.strictEqual(res.message, R.MSG_NOT_SAVED);
  assert.deepStrictEqual(mock.rules(), [{ subject: 'Матан', teacher: null, enabled: true }]);
});

t('экспорт → импорт: круговой рейс сохраняет набор', async () => {
  const set = [rule('Матан', null), rule('АЯ', 'Иванов И. И.', false)];
  const text = R.serializeRules(set, { exportedAt: '2026-09-05T00:00:00.000Z' });
  const parsed = R.parseRulesExport(text);
  assert.strictEqual(parsed.status, 'ok');

  const mock = makeChromeMock([]);
  install(mock);
  const res = await R.importRules(parsed.rules);
  assert.strictEqual(res.status, 'imported');
  assert.deepStrictEqual(mock.rules(), [
    { subject: 'Матан', teacher: null, type: null, enabled: true },
    { subject: 'АЯ', teacher: 'Иванов И. И.', type: null, enabled: false },
  ]);
});

/* ---------- Запуск ---------- */

async function run() {
  console.log('rules.test.js');
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
  clearTimeout(watchdog);
  if (failed) process.exit(1);
}

run();

// Страховка: если тест зависнет — аварийно выйти (снимается по завершении).
const watchdog = setTimeout(() => { process.exit(2) }, 10000);