/**
 * Единая логика правил поверх chrome.storage.sync (shared: content/options/background).
 * Требует загруженного lib/text.js (общая нормализация).
 * Чистые функции (wouldAbsorb, planAdd) — без chrome/DOM, тестируются в Node;
 * асинхронные обёртки работают с chrome.storage.sync и chrome.runtime.lastError.
 *
 * Правило — три признака: предмет (обязателен), преподаватель и вид занятия
 * (ЛК/ПР/ЛБ — видимый <b> пары). null у преподавателя или вида = «любой».
 * Правило A «покрывает» B (covers), если A скрывает всё, что скрывает B:
 * тот же предмет, а преподаватель и вид у A либо те же, либо «любые».
 *
 * Инварианты набора правил:
 *  - дубликаты запрещены (все три признака после нормализации, вкл или выкл);
 *  - добавление/включение правила поглощает включённые правила, которые оно
 *    покрывает (wouldAbsorb), всегда с подтверждением;
 *  - правило, уже покрытое включённым правилом, не добавляется («уже покрыто»);
 *  - лимит 100 правил;
 *  - chrome.runtime.lastError при записи → { status: 'error' } («Не удалось сохранить»).
 *
 * Пересекаться, не покрывая друг друга, правила могут («у Иванова» и «лекции
 * у всех»): поэтому «Вернуть» может снять сразу несколько правил — с подтверждением.
 *
 * Набор хранится частями в нескольких ключах chrome.storage.sync: в один ключ
 * (8 КБ) сотня правил с кириллицей не помещается.
 *
 * Импорт из файла проводит каждое правило через тот же planAdd, что и ручное
 * добавление, — инварианты при импорте те же, что и везде.
 */
(function (global) {
  'use strict';

  const RULES_KEY = 'rules';
  const MAX_RULES = 100;

  // Части набора: первая — прежний ключ 'rules' (данные v1.0 читаются как есть).
  // 4 × ~7,4 КБ — с большим запасом на 100 правил: в среднем правило ~100 байт.
  const RULE_KEYS = [RULES_KEY, 'rules_1', 'rules_2', 'rules_3'];
  // Квота sync на ключ — 8192 байта (ключ + JSON значения, UTF-8); берём с запасом.
  const CHUNK_BYTES = 7400;

  // Виды занятий — видимый текст <b> пары. Подписи — для меню и списка правил;
  // неизвестный сайту вид всё равно работает, просто подписывается своим кодом.
  const PAIR_TYPES = [
    { code: 'ЛК', label: 'лекции' },
    { code: 'ПР', label: 'практики' },
    { code: 'ЛБ', label: 'лабораторные' },
  ];
  const ANY_TYPE_LABEL = 'все занятия';

  const MSG_DUPLICATE = 'Правило уже существует';
  const MSG_COVERED = 'Уже покрыто правилом';
  const MSG_NOT_SAVED = 'Не удалось сохранить';
  const MSG_BAD_FILE = 'Файл не похож на экспорт правил Rasp Hide';

  // Формат файла экспорта. Версия отдельная от версии расширения: меняется,
  // только если поменяется структура файла. 2 — у правила появился вид занятия;
  // файлы версии 1 читаются как есть (вид = любой).
  const EXPORT_FORMAT = 'rasp-hide-rules';
  const EXPORT_VERSION = 2;

  // Общая нормализация: одна на rules и matcher — см. lib/text.js.
  const normalize = global.RASP_HIDE_TEXT.normalize;

  /**
   * Необязательный признак правила: нормализованная строка или null («любой»).
   * Пустая строка — тоже «любой».
   * @param {string|null|undefined} value
   * @returns {string|null}
   */
  function optional(value) {
    if (value == null) return null;
    const v = normalize(value);
    return v === '' ? null : v;
  }

  /**
   * Подпись вида занятия: «лекции», «практики»… null — «все занятия».
   * @param {string|null} type
   * @returns {string}
   */
  function typeLabel(type) {
    const code = optional(type);
    if (code === null) return ANY_TYPE_LABEL;
    const known = PAIR_TYPES.find((t) => t.code === code);
    return known ? known.label : code;
  }

  /**
   * Человекочитаемая подпись правила для меню, подтверждений и сообщений:
   * «Предмет — Фамилия И. О.», «Предмет (ЛК) — все преподаватели».
   * Вид занятия пишется так же, как его показывает сам сайт: «Название (ЛК)».
   * Единственное место, где эта строка собирается.
   * @param {{subject: string, teacher: string|null, type?: string|null}} rule
   * @returns {string}
   */
  function formatRule(rule) {
    const teacher = optional(rule && rule.teacher) || 'все преподаватели';
    const type = optional(rule && rule.type);
    return normalize(rule && rule.subject) + (type ? ' (' + type + ')' : '') + ' — ' + teacher;
  }

  /**
   * Ключ правила для сравнения: все три признака после нормализации
   * (пустая строка = «любой»).
   * @param {{subject: string, teacher: string|null, type?: string|null}} rule
   * @returns {string}
   */
  function keyOf(rule) {
    return normalize(rule.subject) + '\u0000' + (optional(rule.teacher) || '') +
      '\u0000' + (optional(rule.type) || '');
  }

  /**
   * Покрывает ли правило a правило b: a скрывает всё, что скрывает b.
   * Тот же предмет; преподаватель и вид у a те же или «любые». Само себя
   * правило не покрывает (это дубликат).
   * @param {object} a
   * @param {object} b
   * @returns {boolean}
   */
  function covers(a, b) {
    if (normalize(a.subject) !== normalize(b.subject)) return false;
    if (keyOf(a) === keyOf(b)) return false;
    const teacher = optional(a.teacher);
    if (teacher !== null && teacher !== optional(b.teacher)) return false;
    const type = optional(a.type);
    if (type !== null && type !== optional(b.type)) return false;
    return true;
  }

  /**
   * Скрывает ли правило пару (блок) с такими признаками. Определено через
   * covers: пара — это «правило» с конкретными признаками. content/matcher.js
   * обязан матчить так же (сверяется тестом).
   * @param {object} rule
   * @param {{subject: string, teacher: string|null, type: string|null}} pair
   * @returns {boolean}
   */
  function ruleMatchesPair(rule, pair) {
    if (!rule || rule.enabled === false) return false;
    if (!pair || !normalize(pair.subject)) return false;
    return keyOf(rule) === keyOf(pair) || covers(rule, pair);
  }

  /**
   * Включённое правило, которое уже покрывает данное.
   * @param {object} rule
   * @param {object[]} rules
   * @returns {object|null} найденное правило или null
   */
  function getCovering(rule, rules) {
    return rules.find((r) => r.enabled !== false && covers(r, rule)) || null;
  }

  /**
   * Чистая функция: какие включённые правила удалятся при добавлении/включении
   * правила — все, которые оно покрывает.
   * @param {{subject: string, teacher: string|null, type?: string|null, enabled?: boolean}} rule
   * @param {object[]} rules
   * @returns {object[]} правила, которые будут поглощены
   */
  function wouldAbsorb(rule, rules) {
    if (rule.enabled === false) return [];
    return rules.filter((r) => r.enabled !== false && covers(rule, r));
  }

  /**
   * Включённые правила, из-за которых скрыта пара или её блок, — их снимает «Вернуть».
   * Для пары целиком перебираются преподаватели всех её блоков.
   * Обычно правило одно, но пересекающиеся правила («у Иванова» и «лекции
   * у всех») могут скрывать один блок вдвоём.
   * @param {{subject: string, teachers?: Array<string|null>, type?: string|null}} target
   * @param {object[]} rules
   * @returns {object[]}
   */
  function findRulesToRestore(target, rules) {
    const teachers = target.teachers && target.teachers.length ? target.teachers : [null];
    const type = optional(target.type);
    return rules.filter((r) =>
      teachers.some((teacher) =>
        ruleMatchesPair(r, { subject: target.subject, teacher, type })));
  }

  /**
   * Валидация правила перед сохранением.
   * @param {{subject: string, teacher: string|null, type?: string|null, enabled?: boolean}} rule
   * @returns {{subject: string, teacher: string|null, type: string|null, enabled: boolean}|null}
   *   чистое правило; правила v1.0 без вида получают type: null («все занятия»)
   */
  function sanitizeRule(rule) {
    const subject = normalize(rule && rule.subject);
    if (!subject) return null;
    return {
      subject,
      teacher: optional(rule.teacher),
      type: optional(rule.type),
      enabled: rule.enabled !== false,
    };
  }

  /**
   * План добавления правила без записи в storage (чистая функция).
   * Результат: { status: 'ok'|'duplicate'|'covered'|'absorb'|'limit'|'invalid' }.
   * При 'duplicate' — existing; 'covered' — covering; 'absorb' — absorbed (нужно
   * подтверждение пользователя); 'limit' — current (count после гипотетического добавления).
   * @param {{subject: string, teacher: string|null, type?: string|null, enabled?: boolean}} rule
   * @param {object[]} rules
   * @returns {object}
   */
  function planAdd(rule, rules) {
    const clean = sanitizeRule(rule);
    if (!clean) return { status: 'invalid' };

    const existing = rules.find((r) => keyOf(r) === keyOf(clean));
    if (existing) return { status: 'duplicate', existing };

    const covering = getCovering(clean, rules);
    if (covering) return { status: 'covered', covering };

    const absorbed = wouldAbsorb(clean, rules);
    if (absorbed.length > 0) return { status: 'absorb', absorbed };

    // После поглощения набор сокращается, поэтому лимит считаем по итоговому размеру.
    const finalCount = rules.length - absorbed.length + 1;
    if (finalCount > MAX_RULES) return { status: 'limit', current: rules.length };

    return { status: 'ok', rule: clean };
  }

  /**
   * Сериализация набора правил в текст файла экспорта (чистая функция).
   * Время передаётся аргументом, чтобы результат был воспроизводимым.
   * @param {object[]} rules
   * @param {{exportedAt?: string}} [opts]
   * @returns {string} JSON с отступами — файл предполагается читаемым глазами
   */
  function serializeRules(rules, opts = {}) {
    const clean = (Array.isArray(rules) ? rules : []).map(sanitizeRule).filter(Boolean);
    return JSON.stringify({
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: opts.exportedAt || null,
      rules: clean,
    }, null, 2) + '\n';
  }

  /**
   * Разбор файла экспорта (чистая функция). Принимает как объект-обёртку
   * { format, version, rules }, так и голый массив правил — файл могли
   * собрать руками. Мусорные записи отбрасываются sanitizeRule; у правил
   * из файлов версии 1 вида занятия нет — они читаются как «все занятия».
   * @param {string} text - содержимое файла
   * @returns {{status: 'ok', rules: object[]}|{status: 'invalid', message: string}}
   */
  function parseRulesExport(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { status: 'invalid', message: MSG_BAD_FILE };
    }
    const raw = Array.isArray(data) ? data : data && data.rules;
    if (!Array.isArray(raw)) return { status: 'invalid', message: MSG_BAD_FILE };
    if (!Array.isArray(data) && data.format != null && data.format !== EXPORT_FORMAT) {
      return { status: 'invalid', message: MSG_BAD_FILE };
    }
    const rules = raw.map(sanitizeRule).filter(Boolean);
    return { status: 'ok', rules };
  }

  /**
   * План импорта без записи в storage (чистая функция).
   * Каждое правило из файла проводится через тот же planAdd, что и ручное
   * добавление, — инварианты набора (дубликаты, поглощение, «уже покрыто»,
   * лимит) при импорте те же, что и везде.
   *
   * absorbed — только те правила, которые пропадут из ТЕКУЩЕГО набора
   * (пользователю важно именно это); правила, поглощённые внутри самого файла,
   * просто не попадают в результат.
   *
   * При нехватке лимита импорт не выполняется частично: status 'limit'
   * и сколько правил поместилось бы (fits) — предсказуемее половинчатого набора.
   * @param {object[]} incoming - правила из файла
   * @param {object[]} existing - текущий набор
   * @param {{replace?: boolean}} [opts] - replace: заменить набор целиком
   * @returns {{status: 'ok'|'limit', result: object[], added: object[],
   *            skipped: Array<{rule: object, reason: string}>, absorbed: object[], fits?: number}}
   */
  function planImport(incoming, existing, opts = {}) {
    const existingKeys = new Set((existing || []).map(keyOf));
    let acc = opts.replace ? [] : (existing || []).slice();
    const added = [];
    const skipped = [];
    const absorbed = [];

    for (const raw of incoming || []) {
      const plan = planAdd(raw, acc);
      if (plan.status === 'ok') {
        acc = [...acc, plan.rule];
        added.push(plan.rule);
        continue;
      }
      if (plan.status === 'absorb') {
        const absorbedKeys = new Set(plan.absorbed.map(keyOf));
        for (const r of plan.absorbed) {
          if (existingKeys.has(keyOf(r))) absorbed.push(r);
        }
        const kept = acc.filter((r) => !absorbedKeys.has(keyOf(r)));
        const clean = sanitizeRule(raw);
        if (kept.length + 1 > MAX_RULES) {
          return { status: 'limit', result: acc, added, skipped, absorbed, fits: acc.length };
        }
        acc = [...kept, clean];
        added.push(clean);
        continue;
      }
      if (plan.status === 'limit') {
        return { status: 'limit', result: acc, added, skipped, absorbed, fits: acc.length };
      }
      skipped.push({ rule: sanitizeRule(raw) || raw, reason: plan.status });
    }
    return { status: 'ok', result: acc, added, skipped, absorbed };
  }

  /** @returns {chrome} доступ к chrome API (для подмены моками в тестах) */
  function getChrome() {
    return typeof chrome !== 'undefined' ? chrome : global.chrome;
  }

  /**
   * Размер строки в байтах UTF-8 — так квоту считает Chrome (кириллица — 2 байта).
   * @param {string} text
   * @returns {number}
   */
  function utf8Bytes(text) {
    return new TextEncoder().encode(text).length;
  }

  /**
   * Раскладка набора по частям хранилища (чистая функция): каждая часть
   * в JSON не больше CHUNK_BYTES. Порядок правил сохраняется.
   * @param {object[]} rules
   * @returns {object[][]|null} null — набор не помещается во все части
   */
  function chunkRules(rules) {
    const chunks = [];
    let current = [];
    let size = 2; // «[]»
    for (const rule of rules) {
      const bytes = utf8Bytes(JSON.stringify(rule)) + 1; // + запятая
      if (current.length && size + bytes > CHUNK_BYTES) {
        chunks.push(current);
        current = [];
        size = 2;
      }
      if (size + bytes > CHUNK_BYTES) return null; // одно правило больше части
      current.push(rule);
      size += bytes;
    }
    if (current.length) chunks.push(current);
    return chunks.length > RULE_KEYS.length ? null : chunks;
  }

  /**
   * Набор правил из результата chrome.storage.sync.get (все части по порядку).
   * Нужен и content script, который читает правила вместе с тумблером одним get.
   * @param {object} res
   * @returns {object[]}
   */
  function rulesFromStorage(res) {
    const all = [];
    for (const key of RULE_KEYS) {
      const part = res && res[key];
      if (Array.isArray(part)) all.push(...part);
    }
    return all.map(sanitizeRule).filter(Boolean);
  }

  /**
   * Касается ли изменение хранилища набора правил (любой из его частей).
   * @param {object} changes - аргумент chrome.storage.onChanged
   * @returns {boolean}
   */
  function hasRulesChange(changes) {
    return !!changes && RULE_KEYS.some((key) => key in changes);
  }

  /**
   * Загрузка набора правил из chrome.storage.sync.
   * @returns {Promise<object[]>}
   */
  function loadRules() {
    return new Promise((resolve) => {
      const c = getChrome();
      c.storage.sync.get(RULE_KEYS, (res) => resolve(rulesFromStorage(res)));
    });
  }

  /**
   * Запись набора правил в chrome.storage.sync с обработкой lastError.
   * Пишутся все части одним set — запись атомарна, и от прежнего, более
   * длинного набора не остаётся «хвостов» в старших частях.
   * @param {object[]} rules
   * @returns {Promise<{ok: boolean}>} ok: false при chrome.runtime.lastError — «Не удалось сохранить»
   */
  function saveRules(rules) {
    return new Promise((resolve) => {
      const c = getChrome();
      const chunks = chunkRules(rules);
      if (!chunks) { resolve({ ok: false }); return; }
      const patch = {};
      RULE_KEYS.forEach((key, i) => { patch[key] = chunks[i] || []; });
      c.storage.sync.set(patch, () => {
        // lastError достаточно прочитать: чтение гасит предупреждение
        // «Unchecked runtime.lastError», а снимает свойство сам рантайм,
        // как только коллбэк вернул управление. Запись в него — не часть API.
        const err = c.runtime && c.runtime.lastError;
        resolve({ ok: !err });
      });
    });
  }

  /**
   * Добавление правила (hover-меню, options).
   * Обязательное подтверждение поглощения: без autoAbsorb: true при status 'absorb'
   * ничего не записывается — вызывающий показывает список absorbed и повторяет вызов.
   * @param {{subject: string, teacher: string|null, type?: string|null, enabled?: boolean}} rule
   * @param {{autoAbsorb?: boolean}} [opts]
   * @returns {Promise<object>} { status: 'added'|'absorbed'|'duplicate'|'covered'|'absorb'|'limit'|'invalid'|'error', ... }
   */
  async function addRule(rule, opts = {}) {
    const rules = await loadRules();
    const plan = planAdd(rule, rules);
    if (plan.status === 'ok') {
      const saved = await saveRules([...rules, plan.rule]);
      return saved.ok ? { status: 'added', rule: plan.rule } : { status: 'error', message: MSG_NOT_SAVED };
    }
    if (plan.status === 'absorb' && opts.autoAbsorb) {
      const absorbedKeys = new Set(plan.absorbed.map(keyOf));
      const kept = rules.filter((r) => !absorbedKeys.has(keyOf(r)));
      const clean = sanitizeRule(rule);
      const saved = await saveRules([...kept, clean]);
      return saved.ok
        ? { status: 'absorbed', absorbed: plan.absorbed, rule: clean }
        : { status: 'error', message: MSG_NOT_SAVED };
    }
    return plan;
  }

  /**
   * Включение/выключение существующего правила (options, «Включить существующее»).
   * Включение правила поглощает покрытые им (autoAbsorb с подтверждением).
   * @param {{subject: string, teacher: string|null, type?: string|null}} rule
   * @param {boolean} enabled
   * @param {{autoAbsorb?: boolean}} [opts]
   * @returns {Promise<object>} { status: 'enabled'|'disabled'|'covered'|'absorb'|'absorbed'|'notFound'|'error' }
   */
  async function setEnabled(rule, enabled, opts = {}) {
    const clean = sanitizeRule({ ...rule, enabled });
    if (!clean) return { status: 'notFound' };
    const rules = await loadRules();
    const idx = rules.findIndex((r) => keyOf(r) === keyOf(clean));
    if (idx === -1) return { status: 'notFound' };

    const target = { ...rules[idx] };
    if (enabled) {
      const covering = getCovering(target, rules);
      if (covering) return { status: 'covered', covering };
      const absorbed = wouldAbsorb({ ...target, enabled: true }, rules);
      if (absorbed.length > 0) {
        if (!opts.autoAbsorb) return { status: 'absorb', absorbed };
        const absorbedKeys = new Set(absorbed.map(keyOf));
        const kept = rules.filter((r) => !absorbedKeys.has(keyOf(r)) || keyOf(r) === keyOf(target));
        const res = kept.map((r) => (keyOf(r) === keyOf(target) ? { ...r, enabled: true } : r));
        const saved = await saveRules(res);
        return saved.ok
          ? { status: 'absorbed', absorbed }
          : { status: 'error', message: MSG_NOT_SAVED };
      }
      target.enabled = true;
    } else {
      target.enabled = false;
    }

    const next = rules.map((r) => (keyOf(r) === keyOf(target) ? target : r));
    const saved = await saveRules(next);
    if (!saved.ok) return { status: 'error', message: MSG_NOT_SAVED };
    return { status: enabled ? 'enabled' : 'disabled', rule: target };
  }

  /**
   * Удаление правила (options).
   * @param {{subject: string, teacher: string|null, type?: string|null}} rule
   * @returns {Promise<object>} { status: 'removed'|'notFound'|'error' }
   */
  async function removeRule(rule) {
    const clean = sanitizeRule({ ...rule, enabled: true });
    if (!clean) return { status: 'notFound' };
    const rules = await loadRules();
    const idx = rules.findIndex((r) => keyOf(r) === keyOf(clean));
    if (idx === -1) return { status: 'notFound' };
    const removed = rules[idx];
    const saved = await saveRules(rules.filter((r) => keyOf(r) !== keyOf(clean)));
    return saved.ok ? { status: 'removed', rule: removed } : { status: 'error', message: MSG_NOT_SAVED };
  }

  /**
   * Возврат пары или блока (кнопка «Вернуть»): снимает правила, которые их скрывают.
   * Одно правило снимается сразу. Несколько (пересекающиеся правила) — только
   * с confirmed: true, иначе status 'confirm' и список: «Вернуть» тогда
   * затрагивает и другие пары, и пользователь должен это увидеть.
   * @param {{subject: string, teachers?: Array<string|null>, type?: string|null}} target
   * @param {{confirmed?: boolean}} [opts]
   * @returns {Promise<object>} { status: 'restored'|'confirm'|'none'|'error', rules? }
   */
  async function restorePair(target, opts = {}) {
    const rules = await loadRules();
    const matched = findRulesToRestore(target, rules);
    if (!matched.length) return { status: 'none' };
    if (matched.length > 1 && !opts.confirmed) return { status: 'confirm', rules: matched };
    const keys = new Set(matched.map(keyOf));
    const saved = await saveRules(rules.filter((r) => !keys.has(keyOf(r))));
    return saved.ok ? { status: 'restored', rules: matched } : { status: 'error', message: MSG_NOT_SAVED };
  }

  /**
   * Импорт правил из файла.
   * Разрушительные импорты (поглощение существующих правил или replace)
   * требуют подтверждения: без confirmed: true возвращается status 'confirm'
   * с планом, вызывающий показывает сводку и повторяет вызов — та же схема,
   * что у addRule с autoAbsorb.
   * @param {object[]} incoming - правила из файла (после parseRulesExport)
   * @param {{replace?: boolean, confirmed?: boolean}} [opts]
   * @returns {Promise<object>} { status: 'imported'|'confirm'|'limit'|'error', ... }
   */
  async function importRules(incoming, opts = {}) {
    const existing = await loadRules();
    const plan = planImport(incoming, existing, opts);
    if (plan.status !== 'ok') return plan;
    const destructive = plan.absorbed.length > 0 ||
      (opts.replace === true && existing.length > 0);
    if (destructive && !opts.confirmed) return { ...plan, status: 'confirm' };
    const saved = await saveRules(plan.result);
    if (!saved.ok) return { status: 'error', message: MSG_NOT_SAVED };
    return { ...plan, status: 'imported' };
  }

  /**
   * Сброс к дефолту: обнуляет только список правил (тумблер и стиль не трогаются).
   * @returns {Promise<object>} { status: 'reset'|'error' }
   */
  async function resetRules() {
    const saved = await saveRules([]);
    return saved.ok ? { status: 'reset' } : { status: 'error', message: MSG_NOT_SAVED };
  }

  const R = {
    MAX_RULES,
    RULES_KEY,
    RULE_KEYS,
    CHUNK_BYTES,
    PAIR_TYPES,
    MSG_DUPLICATE,
    MSG_COVERED,
    MSG_NOT_SAVED,
    MSG_BAD_FILE,
    EXPORT_FORMAT,
    EXPORT_VERSION,
    normalize,
    typeLabel,
    formatRule,
    keyOf,
    covers,
    ruleMatchesPair,
    getCovering,
    wouldAbsorb,
    findRulesToRestore,
    sanitizeRule,
    planAdd,
    serializeRules,
    parseRulesExport,
    planImport,
    importRules,
    chunkRules,
    rulesFromStorage,
    hasRulesChange,
    loadRules,
    saveRules,
    addRule,
    setEnabled,
    removeRule,
    restorePair,
    resetRules,
  };

  global.RASP_HIDE_RULES = R;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = R;
  }
})(typeof window !== 'undefined' ? window : globalThis);