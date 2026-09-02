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
   * Признак элемента расширения (плейсхолдер).
   * @param {Element|null} el
   * @returns {boolean}
   */
  function isPh(el) {
    return !!(el && el.classList &&
      typeof el.classList.contains === 'function' &&
      el.classList.contains('rh-placeholder'));
  }

  /**
   * Индекс элемента среди children клетки.
   * @param {HTMLElement} cell
   * @param {Element} el
   * @returns {number} -1, если не найден.
   */
  function childIndex(cell, el) {
    for (let i = 0; i < cell.children.length; i++) {
      if (cell.children[i] === el) return i;
    }
    return -1;
  }

  /**
   * Элементы расширения (плейсхолдеры) в диапазоне пары клетки.
   * @param {HTMLElement} cell
   * @param {HTMLElement[]} pair
   * @returns {HTMLElement[]}
   */
  function placeholdersForPair(cell, pair) {
    const result = [];
    const start = childIndex(cell, pair[0]);
    const end = childIndex(cell, pair[pair.length - 1]);
    if (start < 0 || end < start) return result;
    const snapshot = Array.prototype.slice.call(cell.children);
    for (let i = start; i <= end + 1 && i < snapshot.length; i++) {
      if (isPh(snapshot[i])) result.push(snapshot[i]);
    }
    return result;
  }

  /**
   * Синхронизация плейсхолдеров пары с местами скрытия (attachPoints).
   * Лишние удаляются, недостающие вставляются. Идемпотентно.
   * @param {HTMLElement} cell
   * @param {HTMLElement[]} pair
   * @param {HTMLElement[]} attachPoints - элементы, после которых должен быть плейсхолдер
   */
  function syncPlaceholders(cell, pair, attachPoints) {
    for (const ph of placeholdersForPair(cell, pair)) {
      const idx = childIndex(cell, ph);
      const prev = idx > 0 ? cell.children[idx - 1] : null;
      if (attachPoints.indexOf(prev) === -1) ph.remove();
    }
    for (const point of attachPoints) {
      const idx = childIndex(cell, point);
      const next = idx >= 0 ? cell.children[idx + 1] : null;
      if (isPh(next)) continue; // плейсхолдер уже стоит после точки
      const placeholder = UI.createPlaceholder();
      point.parentNode.insertBefore(placeholder, point.nextSibling);
    }
  }

  /**
   * Скрытие пары целиком: display:none (или зачёркивание) + плейсхолдер.
   * Идемпотентно — повторный прогон не дублирует плейсхолдер.
   * @param {HTMLElement[]} pair
   * @param {HTMLElement} cell
   */
  function hidePair(pair, cell) {
    cacheCellStyle(cell);
    for (const el of pair) applyPairStyle(el, true);
    if (settings.style !== 'placeholder') return;
    const last = pair[pair.length - 1];
    const idx = childIndex(cell, last);
    if (idx >= 0 && !isPh(cell.children[idx + 1])) {
      const placeholder = UI.createPlaceholder();
      last.parentNode.insertBefore(placeholder, last.nextSibling);
    }
  }

  /**
   * Возврат пары: снять скрытие со всех элементов, удалить плейсхолдеры.
   * @param {HTMLElement[]} pair
   * @param {HTMLElement} [cell]
   */
  function restorePair(pair, cell) {
    for (const el of pair) applyPairStyle(el, false);
    if (cell) syncPlaceholders(cell, pair, []);
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
   * Пара с несколькими преподавателями скрывается поблочно: каждый блок
   * ([Преп N...] после <hr>) проверяется правилом независимо; «шапка» пары
   * скрывается, только когда скрыты ВСЕ её блоки.
   */
  function processCells() {
    const table = document.querySelector('#raspisanie-table');
    if (!table) return;
    const cells = table.querySelectorAll('td.cell');
    let hiddenCount = 0;
    for (const cell of cells) {
      cacheCellStyle(cell);
      const pairs = M.splitIntoPairs(cell.children);
      for (const pair of pairs) {
        const name = M.getPairName(pair);
        if (!name) continue; // ОВ/ОС — не скрываемые
        const header = pair[0];
        const blocks = M.splitPairIntoBlocks(pair);
        const attachPoints = [];
        let allHidden = true;

        if (blocks.length === 0) {
          // Пара без блоков преподавателей — скрываема только «у всех».
          const matched = settings.rules.some((r) => M.matchRule(name, null, r));
          if (matched) {
            applyPairStyle(header, true);
            if (settings.style === 'placeholder') attachPoints.push(pair[pair.length - 1]);
            hiddenCount++;
          } else {
            applyPairStyle(header, false);
          }
        } else {
          const hiddenBlocks = [];
          for (const block of blocks) {
            const t = M.getBlockTeacher(block);
            const matched = settings.rules.some((r) => M.matchRule(name, t, r));
            if (matched) {
              for (const el of block) applyPairStyle(el, true);
              hiddenBlocks.push(block[block.length - 1]);
              hiddenCount++;
            } else {
              for (const el of block) applyPairStyle(el, false);
              allHidden = false;
            }
          }
          applyPairStyle(header, allHidden);
          if (settings.style === 'placeholder') {
            if (allHidden) attachPoints.push(pair[pair.length - 1]); // одна «скрыто» на всю пару
            else attachPoints.push(...hiddenBlocks); // плейсхолдер после каждого скрытого блока
          }
        }
        syncPlaceholders(cell, pair, attachPoints);
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
        for (const pair of pairs) restorePair(pair, cell);
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
        lastCount = null; // настройки изменились — счётчик считается заново
        resolve(settings);
      });
    });
  }

  const C = {
    cacheCellStyle,
    restoreCellStyle,
    applyPairStyle,
    isPh,
    hidePair,
    restorePair,
    syncPlaceholders,
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
