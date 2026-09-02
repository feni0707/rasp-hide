/**
 * Content script: применение правил к расписанию.
 * Прогон по #raspisanie-table td.cell, скрытие пар (плейсхолдер/зачёркивание),
 * <hr> пары скрывается/восстанавливается вместе с парой в placeholder-режиме;
 * в strike-режиме <hr> не трогается (разделитель преподавателей остаётся),
 * фон клетки (transparent при полном скрытии, только placeholder),
 * WeakMap-кэш исходных стилей, MutationObserver (debounce ~120 мс),
 * chrome.storage.onChanged, счётчик скрытых пар → sendMessage.
 */
(function (global) {
  'use strict';

  const M = global.RASP_HIDE_MATCHER;
  const UI = global.RASP_HIDE_UI;

  const originalCellStyles = new WeakMap();
  let settings = { enabled: true, style: 'placeholder', rules: [] };
  let debounceTimer = null;
  let lastCount = null;

  /**
   * Кэширование исходного атрибута style клетки до любых изменений.
   * @param {HTMLElement} cell
   */
  function cacheCellStyle(cell) {
    if (!originalCellStyles.has(cell)) {
      originalCellStyles.set(cell, cell.getAttribute('style') || '');
    }
  }

  /**
   * Восстановление исходного стиля клетки из кэша.
   * @param {HTMLElement} cell
   */
  function restoreCellStyle(cell) {
    if (originalCellStyles.has(cell)) {
      cell.setAttribute('style', originalCellStyles.get(cell));
      originalCellStyles.delete(cell);
    }
  }

  /**
   * Применение стиля скрытия к одному элементу пары.
   * <hr> скрывается вместе с парой только в режиме placeholder (фикс «старой полосы»);
   * в strike-режиме <hr> не трогаем — разделитель преподавателей/подпар остаётся на месте.
   * @param {HTMLElement} el
   * @param {boolean} hidden
   */
  function applyPairStyle(el, hidden) {
    if (el.tagName === 'HR') {
      if (settings.style === 'strike') return;
      el.style.display = hidden ? 'none' : '';
      return;
    }
    if (hidden && settings.style === 'strike') {
      el.style.display = '';
      el.classList.add('rh-strike');
      return;
    }
    el.style.display = hidden ? 'none' : '';
    el.classList.remove('rh-strike');
  }

  /**
   * Плейсхолдер пары, если он есть среди элементов пары.
   * @param {HTMLElement[]} pair
   * @returns {HTMLElement|null}
   */
  function findPlaceholder(pair) {
    for (const el of pair) {
      if (el.classList && el.classList.contains('rh-placeholder')) return el;
    }
    return null;
  }

  /**
   * Скрытие пары: display:none (или зачёркивание) + плейсхолдер.
   * Идемпотентно — повторный прогон не дублирует плейсхолдер.
   * @param {HTMLElement[]} pair
   * @param {HTMLElement} cell
   */
  function hidePair(pair, cell) {
    cacheCellStyle(cell);
    for (const el of pair) applyPairStyle(el, true);
    const ph = findPlaceholder(pair);
    if (settings.style === 'strike') {
      if (ph) ph.remove();
      return;
    }
    if (!ph) {
      const placeholder = UI.createPlaceholder();
      const last = pair[pair.length - 1];
      last.parentNode.insertBefore(placeholder, last.nextSibling);
    }
  }

  /**
   * Возврат пары: снять скрытие, удалить плейсхолдер.
   * @param {HTMLElement[]} pair
   */
  function restorePair(pair) {
    for (const el of pair) applyPairStyle(el, false);
    const ph = findPlaceholder(pair);
    if (ph) ph.remove();
  }

  /**
   * Фон клетки: transparent при полном скрытии (только placeholder);
   * в strike фон не трогается никогда.
   * @param {HTMLElement} cell
   */
  function updateCellBackground(cell) {
    if (settings.style !== 'placeholder') {
      restoreCellStyle(cell);
      return;
    }
    if (M.isCellFullyHidden(cell)) {
      cacheCellStyle(cell);
      cell.style.setProperty('background-color', 'transparent', 'important');
    } else {
      restoreCellStyle(cell);
    }
  }

  /**
   * Прогон по всем клеткам расписания: скрыть/вернуть пары, фон, счётчик.
   */
  function processCells() {
    const table = document.querySelector('#raspisanie-table');
    if (!table) return;
    const cells = table.querySelectorAll('td.cell');
    let hiddenCount = 0;
    for (const cell of cells) {
      const pairs = M.splitIntoPairs(cell.children);
      for (const pair of pairs) {
        const name = M.getPairName(pair);
        if (!name) continue; // ОВ/ОС — не скрываемые
        const teacher = M.getPairTeacher(pair);
        const matched = settings.rules.some((r) => M.matchRule(name, teacher, r));
        if (matched) {
          hidePair(pair, cell);
          hiddenCount++;
        } else {
          restorePair(pair);
        }
      }
      updateCellBackground(cell);
    }
    sendCount(hiddenCount);
  }

  /**
   * Полный откат при глобальном OFF: удалить rh-*, восстановить стили.
   */
  function fullRollback() {
    UI.removeAllRhElements();
    const table = document.querySelector('#raspisanie-table');
    if (table) {
      const cells = table.querySelectorAll('td.cell');
      for (const cell of cells) {
        restoreCellStyle(cell);
        const pairs = M.splitIntoPairs(cell.children);
        for (const pair of pairs) restorePair(pair);
      }
    }
    lastCount = null;
    sendOff();
  }

  /**
   * Счётчик скрытых пар → в SW для бейджа (только при изменении).
   * @param {number} value
   */
  function sendCount(value) {
    if (value === lastCount) return;
    lastCount = value;
    try {
      const p = chrome.runtime.sendMessage({ type: 'count', value });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { /* SW может быть недоступен */ }
  }

  /**
   * Сигнал «выключено» → в SW для бейджа (серый OFF).
   */
  function sendOff() {
    try {
      const p = chrome.runtime.sendMessage({ type: 'off' });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { /* SW может быть недоступен */ }
  }

  /**
   * Загрузка настроек из chrome.storage.sync.
   * @returns {Promise<object>}
   */
  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(['enabled', 'style', 'rules'], (res) => {
        settings = {
          enabled: res.enabled !== false,
          style: res.style === 'strike' ? 'strike' : 'placeholder',
          rules: Array.isArray(res.rules) ? res.rules : [],
        };
        resolve(settings);
      });
    });
  }

  const C = {
    cacheCellStyle,
    restoreCellStyle,
    applyPairStyle,
    findPlaceholder,
    hidePair,
    restorePair,
    updateCellBackground,
    processCells,
    fullRollback,
    loadSettings,
  };
  global.RASP_HIDE_CONTENT = C;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = C;
  }

  // Инициализация — только в браузере (в Node — только экспорт для тестов).
  if (typeof document === 'undefined' || typeof chrome === 'undefined') return;

  UI.injectStyles();

  const observer = new MutationObserver(() => {
    if (!settings.enabled) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(processCells, 120);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    loadSettings().then(() => {
      if (settings.enabled) processCells();
      else fullRollback();
    });
  });

  loadSettings().then(() => {
    if (settings.enabled) processCells();
    else sendOff();
  });
})(typeof window !== 'undefined' ? window : globalThis);
