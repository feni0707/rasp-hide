/**
 * Единая логика правил поверх chrome.storage.sync (shared: content/options/background).
 * Требует загруженного lib/text.js (общая нормализация).
 * Чистые функции (wouldAbsorb, planAdd) — без chrome/DOM, тестируются в Node;
 * асинхронные обёртки работают с chrome.storage.sync и chrome.runtime.lastError.
 *
 * Инварианты набора правил:
 *  - дубликаты запрещены (subject + teacher после нормализации, вкл или выкл);
 *  - добавление/включение широкого правила (teacher: null) поглощает включённые
 *    узкие правила того же предмета (wouldAbsorb), всегда с подтверждением;
 *  - узкое правило при включённом «у всех» того же предмета не добавляется;
 *  - лимит 100 правил;
 *  - chrome.runtime.lastError при записи → { status: 'error' } («Не удалось сохранить»).
 *
 * Импорт из файла проводит каждое правило через тот же planAdd, что и ручное
 * добавление, — инварианты при импорте те же, что и везде.
 */
(function (global) {
  'use strict';

  const RULES_KEY = 'rules';
  const MAX_RULES = 100;

  const MSG_DUPLICATE = 'Правило уже существует';
  const MSG_COVERED = 'Уже покрыто правилом';
  const MSG_NOT_SAVED = 'Не удалось сохранить';
  const MSG_BAD_FILE = 'Файл не похож на экспорт правил Rasp Hide';

  // Формат файла экспорта. Версия отдельная от версии расширения: меняется,
  // только если поменяется структура файла.
  const EXPORT_FORMAT = 'rasp-hide-rules';
  const EXPORT_VERSION = 1;

  // Общая нормализация: одна на rules и matcher — см. lib/text.js.
  const normalize = global.RASP_HIDE_TEXT.normalize;

  /**
   * Человекочитаемая подпись правила для меню, подтверждений и сообщений:
   * «Предмет — Фамилия И. О.» либо «Предмет — все преподаватели».
   * Единственное место, где эта строка собирается: раньше её независимо
   * склеивали hover-меню и четыре места в options, в трёх формулировках.
   * @param {{subject: string, teacher: string|null}} rule
   * @returns {string}
   */
  function formatRule(rule) {
    const teacher = rule && rule.teacher != null && normalize(rule.teacher) !== ''
      ? normalize(rule.teacher)
      : 'все преподаватели';
    return normalize(rule && rule.subject) + ' — ' + teacher;
  }

  /**
   * Ключ правила для сравнения (subject + teacher после нормализации; null = «все»).
   * @param {{subject: string, teacher: string|null}} rule
   * @returns {string}
   */
  function keyOf(rule) {
    const teacher = rule.teacher == null ? '' : normalize(rule.teacher);
    return normalize(rule.subject) + '\u0000' + teacher;
  }

  /**
   * Узкое ли правило (конкретный преподаватель).
   * @param {{teacher: string|null}} rule
   * @returns {boolean}
   */
  function isNarrow(rule) {
    return rule.teacher != null && normalize(rule.teacher) !== '';
  }

  /**
   * Включённое широкое правило («у всех») того же предмета.
   * @param {{subject: string}} rule
   * @param {object[]} rules
   * @returns {object|null} найденное правило или null
   */
  function getCoveringAll(rule, rules) {
    const subject = normalize(rule.subject);
    return (
      rules.find(
        (r) => r.enabled !== false && !isNarrow(r) && normalize(r.subject) === subject
      ) || null
    );
  }

  /**
   * Чистая функция: какие включённые узкие правила удалятся при добавлении/включении
   * широкого правила (rule.teacher === null) того же предмета.
   * @param {{subject: string, teacher: string|null, enabled?: boolean}} rule
   * @param {object[]} rules
   * @returns {object[]} правила, которые будут поглощены
   */
  function wouldAbsorb(rule, rules) {
    if (isNarrow(rule)) return [];
    if (rule.enabled === false) return [];
    const subject = normalize(rule.subject);
    return rules.filter(
      (r) => r.enabled !== false && isNarrow(r) && normalize(r.subject) === subject
    );
  }

  /**
   * Самое специфичное правило для возврата пары: сначала точное с преподавателем,
   * иначе включённое «у всех» того же предмета.
   * @param {string} name - название пары
   * @param {string|null} teacher - ФИО пары
   * @param {object[]} rules
   * @returns {object|null}
   */
  function findRuleToRestore(name, teacher, rules) {
    const subject = normalize(name);
    const t = teacher == null ? null : normalize(teacher);
    const specific = rules.find(
      (r) =>
        r.enabled !== false &&
        isNarrow(r) &&
        normalize(r.subject) === subject &&
        normalize(r.teacher) === t
    );
    if (specific) return specific;
    return rules.find(
      (r) => r.enabled !== false && !isNarrow(r) && normalize(r.subject) === subject
    ) || null;
  }

  /**
   * Валидация правила перед сохранением.
   * @param {{subject: string, teacher: string|null, enabled?: boolean}} rule
   * @returns {{subject: string, teacher: string|null, enabled: boolean}} чистое правило
   */
  function sanitizeRule(rule) {
    const subject = normalize(rule && rule.subject);
    if (!subject) return null;
    const teacher =
      rule.teacher != null && normalize(rule.teacher) !== '' ? normalize(rule.teacher) : null;
    return {
      subject,
      teacher,
      enabled: rule.enabled !== false,
    };
  }

  /**
   * План добавления правила без записи в storage (чистая функция).
   * Результат: { status: 'ok'|'duplicate'|'covered'|'absorb'|'limit'|'invalid' }.
   * При 'duplicate' — existing; 'covered' — covering; 'absorb' — absorbed (нужно
   * подтверждение пользователя); 'limit' — current (count после гипотетического добавления).
   * @param {{subject: string, teacher: string|null, enabled?: boolean}} rule
   * @param {object[]} rules
   * @returns {object}
   */
  function planAdd(rule, rules) {
    const clean = sanitizeRule(rule);
    if (!clean) return { status: 'invalid' };

    const existing = rules.find((r) => keyOf(r) === keyOf(clean));
    if (existing) return { status: 'duplicate', existing };

    if (isNarrow(clean)) {
      const covering = getCoveringAll(clean, rules);
      if (covering) return { status: 'covered', covering };
    }

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
   * собрать руками. Мусорные записи отбрасываются sanitizeRule.
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
   * Загрузка набора правил из chrome.storage.sync.
   * @returns {Promise<object[]>}
   */
  function loadRules() {
    return new Promise((resolve) => {
      const c = getChrome();
      c.storage.sync.get(RULES_KEY, (res) => {
        const rules = res && res[RULES_KEY];
        resolve(Array.isArray(rules) ? rules.map(sanitizeRule).filter(Boolean) : []);
      });
    });
  }

  /**
   * Запись набора правил в chrome.storage.sync с обработкой lastError.
   * @param {object[]} rules
   * @returns {Promise<{ok: boolean}>} ok: false при chrome.runtime.lastError — «Не удалось сохранить»
   */
  function saveRules(rules) {
    return new Promise((resolve) => {
      const c = getChrome();
      const patch = {};
      patch[RULES_KEY] = rules;
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
   * @param {{subject: string, teacher: string|null, enabled?: boolean}} rule
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
   * Включение широкого правила поглощает узкие (autoAbsorb с подтверждением).
   * @param {{subject: string, teacher: string|null}} rule
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
      if (isNarrow(target)) {
        const covering = getCoveringAll(target, rules);
        if (covering) return { status: 'covered', covering };
      }
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
   * @param {{subject: string, teacher: string|null}} rule
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
   * Возврат пары: удаляет самое специфичное подходящее правило (для placeholder «Вернуть»).
   * @param {string} name - название пары
   * @param {string|null} teacher - ФИО пары
   * @returns {Promise<object>} { status: 'restored'|'none'|'error' }
   */
  async function restorePair(name, teacher) {
    const rules = await loadRules();
    const target = findRuleToRestore(name, teacher, rules);
    if (!target) return { status: 'none' };
    const saved = await saveRules(rules.filter((r) => keyOf(r) !== keyOf(target)));
    return saved.ok ? { status: 'restored', rule: target } : { status: 'error', message: MSG_NOT_SAVED };
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
    MSG_DUPLICATE,
    MSG_COVERED,
    MSG_NOT_SAVED,
    MSG_BAD_FILE,
    EXPORT_FORMAT,
    EXPORT_VERSION,
    normalize,
    formatRule,
    keyOf,
    isNarrow,
    getCoveringAll,
    wouldAbsorb,
    findRuleToRestore,
    sanitizeRule,
    planAdd,
    serializeRules,
    parseRulesExport,
    planImport,
    importRules,
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