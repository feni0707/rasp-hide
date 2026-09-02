/**
 * UI-элементы расширения: плейсхолдер «скрыто», стили, очистка rh-* элементов.
 * Фаза 4: только плейсхолдер; hover-кнопки/меню добавляются в фазе 5.
 * Все добавляемые элементы имеют класс с префиксом rh- и регистрируются
 * для полного отката (глобальный OFF).
 */
(function (global) {
  'use strict';

  const STYLE_ID = 'rh-styles';
  const rhElements = new Set();

  /**
   * Внедрение стилей расширения (rh-strike, rh-placeholder). Идемпотентно.
   */
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '.rh-strike{opacity:.35 !important;text-decoration:line-through !important;}' +
      '.rh-strike a,.rh-strike b{text-decoration:line-through;}' +
      '.rh-placeholder{color:#9ca3af;font-size:12px;padding:4px 0;opacity:.7;user-select:none;}';
    document.documentElement.appendChild(style);
  }

  /**
   * Регистрация созданного элемента расширения (для полного отката).
   * @param {HTMLElement} el
   * @returns {HTMLElement}
   */
  function registerRhElement(el) {
    rhElements.add(el);
    return el;
  }

  /**
   * Создание плейсхолдера «скрыто» (бледный, занимает место пары).
   * @returns {HTMLElement}
   */
  function createPlaceholder() {
    const el = document.createElement('div');
    el.className = 'rh-placeholder';
    el.textContent = 'скрыто';
    return registerRhElement(el);
  }

  /**
   * Удаление всех элементов расширения (rh-*) — полный откат при глобальном OFF.
   */
  function removeAllRhElements() {
    for (const el of rhElements) {
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    rhElements.clear();
  }

  const UI = { injectStyles, createPlaceholder, removeAllRhElements };
  global.RASP_HIDE_UI = UI;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = UI;
  }
})(typeof window !== 'undefined' ? window : globalThis);
