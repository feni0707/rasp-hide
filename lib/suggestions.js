/**
 * Подсказки для ручного ввода правила: названия предметов и ФИО, увиденные
 * на страницах расписания (REQUIREMENTS §4.1 — «автокомплит, кандидат в v2»).
 *
 * Хранилище — chrome.storage.local, НЕ sync: это кэш увиденного на странице,
 * а не настройка. Он не переносится между устройствами, не отправляется никуда
 * и очищается кнопкой в настройках. Требует загруженного lib/text.js.
 *
 * Чистая функция mergeSuggestions тестируется в Node; асинхронные обёртки
 * работают с chrome.storage.local и chrome.runtime.lastError.
 */
(function (global) {
  'use strict';

  const SUGGESTIONS_KEY = 'suggestions';
  // Потолок на каждый список. Расписание одной группы даёт десятки записей;
  // за семестр набирается несколько сотен — 500 с запасом, но не бесконечность.
  const MAX_SUGGESTIONS = 500;

  const normalize = global.RASP_HIDE_TEXT.normalize;

  /**
   * Объединение сохранённых подсказок с только что увиденными.
   * При переполнении лимита свежие вытесняют старые: увиденное на текущей
   * странице пользователю нужнее, чем строка из давно закрытой вкладки.
   * Результат нормализован, без повторов, отсортирован по алфавиту.
   * @param {string[]} stored - сохранённые ранее
   * @param {string[]} found - увиденные сейчас
   * @param {number} [limit]
   * @returns {string[]}
   */
  function mergeSuggestions(stored, found, limit = MAX_SUGGESTIONS) {
    const out = [];
    const seen = new Set();
    for (const list of [found, stored]) {
      for (const raw of list || []) {
        if (out.length >= limit) break;
        const value = normalize(raw);
        if (!value || seen.has(value)) continue;
        seen.add(value);
        out.push(value);
      }
    }
    return out.sort((a, b) => a.localeCompare(b, 'ru'));
  }

  /**
   * Совпадают ли два списка подсказок (оба уже нормализованы и отсортированы).
   * Нужно, чтобы не писать в хранилище на каждый прогон расписания.
   * @param {string[]} a
   * @param {string[]} b
   * @returns {boolean}
   */
  function sameSuggestions(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /** @returns {object} доступ к chrome API (для подмены моками в тестах) */
  function getChrome() {
    return typeof chrome !== 'undefined' ? chrome : global.chrome;
  }

  /**
   * Чтение подсказок из chrome.storage.local.
   * @returns {Promise<{subjects: string[], teachers: string[]}>}
   */
  function loadSuggestions() {
    return new Promise((resolve) => {
      getChrome().storage.local.get(SUGGESTIONS_KEY, (res) => {
        const data = (res && res[SUGGESTIONS_KEY]) || {};
        resolve({
          subjects: Array.isArray(data.subjects) ? data.subjects : [],
          teachers: Array.isArray(data.teachers) ? data.teachers : [],
        });
      });
    });
  }

  /**
   * Запись подсказок в chrome.storage.local.
   * @param {{subjects: string[], teachers: string[]}} data
   * @returns {Promise<{ok: boolean}>} ok: false при chrome.runtime.lastError
   */
  function saveSuggestions(data) {
    return new Promise((resolve) => {
      const c = getChrome();
      const patch = {};
      patch[SUGGESTIONS_KEY] = data;
      c.storage.local.set(patch, () => {
        // lastError только читаем — снимает его рантайм (см. lib/rules.js).
        resolve({ ok: !(c.runtime && c.runtime.lastError) });
      });
    });
  }

  /**
   * Добавление увиденного на странице к сохранённым подсказкам.
   * Пишет только при реальном изменении: прогон расписания идёт по дебаунсу
   * и не должен дёргать хранилище на каждую перерисовку таблицы.
   * @param {{subjects: string[], teachers: string[]}} found
   * @returns {Promise<{status: 'saved'|'unchanged'|'error', data: object}>}
   */
  async function addSuggestions(found) {
    const stored = await loadSuggestions();
    const next = {
      subjects: mergeSuggestions(stored.subjects, found && found.subjects),
      teachers: mergeSuggestions(stored.teachers, found && found.teachers),
    };
    if (sameSuggestions(stored.subjects, next.subjects) &&
        sameSuggestions(stored.teachers, next.teachers)) {
      return { status: 'unchanged', data: stored };
    }
    const saved = await saveSuggestions(next);
    return saved.ok ? { status: 'saved', data: next } : { status: 'error', data: stored };
  }

  /**
   * Очистка подсказок (кнопка в настройках).
   * @returns {Promise<{status: 'cleared'|'error'}>}
   */
  async function clearSuggestions() {
    const saved = await saveSuggestions({ subjects: [], teachers: [] });
    return { status: saved.ok ? 'cleared' : 'error' };
  }

  const S = {
    SUGGESTIONS_KEY,
    MAX_SUGGESTIONS,
    mergeSuggestions,
    sameSuggestions,
    loadSuggestions,
    saveSuggestions,
    addSuggestions,
    clearSuggestions,
  };

  global.RASP_HIDE_SUGGESTIONS = S;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = S;
  }
})(typeof window !== 'undefined' ? window : globalThis);
