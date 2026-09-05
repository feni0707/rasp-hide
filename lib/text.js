/**
 * Общие текстовые утилиты — без chrome и DOM.
 * Подключается ПЕРВЫМ и в content_scripts, и в options.html.
 *
 * Нормализация обязана быть побайтово одной и той же в content/matcher.js
 * (сравнение с текстом страницы) и в lib/rules.js (ключи правил): разойдись
 * они хоть на пробел — правило перестанет совпадать с парой молча, без ошибки.
 * Раньше это были две независимые копии одной функции; здесь — одна.
 */
(function (global) {
  'use strict';

  /**
   * Нормализация текста: trim, схлопывание пробелов и &nbsp;.
   * @param {string|null|undefined} text
   * @returns {string}
   */
  function normalize(text) {
    if (text == null) return '';
    return String(text).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  const T = { normalize };

  global.RASP_HIDE_TEXT = T;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = T;
  }
})(typeof window !== 'undefined' ? window : globalThis);
