/**
 * Content script: применение правил к расписанию.
 * Прогон по #raspisanie-table td.cell, скрытие пар (плейсхолдер/зачёркивание),
 * <hr> пары скрывается/восстанавливается вместе с парой в placeholder-режиме;
 * в strike-режиме <hr> не трогается (разделитель преподавателей остаётся),
 * фон клетки (при полном скрытии — как у пустой клетки, только placeholder),
 * плейсхолдеры синхронизируются только в placeholder-режиме — случайный
 * strike-прогон (MutationObserver/debounce) их не уничтожает, поэтому
 * переключение стиля не теряет «скрыто» и не ломает фон клетки,
 * WeakMap-кэш исходных стилей, MutationObserver (debounce ~120 мс),
 * chrome.storage.onChanged, счётчик скрытых пар → sendMessage,
 * сбор подсказок (названия/ФИО) для настроек в chrome.storage.local.
 * Прогон и откат защищены от «протухшего» дебаунс-таймера: processCells
 * молча выходит при выключенном тумблере, fullRollback таймер снимает.
 */
(function (global) {
  'use strict';

  const M = global.RASP_HIDE_MATCHER;
  const R = global.RASP_HIDE_RULES;
  const UI = global.RASP_HIDE_UI;
  const SUG = global.RASP_HIDE_SUGGESTIONS;

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

  // Общие с ui.js хелперы по структуре клетки — см. content/matcher.js.
  const isPh = M.isPlaceholder;
  const childIndex = M.childIndex;
  const placeholdersForPair = M.placeholdersForPair;

  /**
   * Синхронизация плейсхолдеров пары с местами скрытия (attachPoints).
   * Лишние удаляются, недостающие вставляются. Идемпотентно.
   * В strike-режиме плейсхолдеры не трогаются: случайный strike-прогон
   * (MutationObserver/debounce) не должен уничтожать их при переключении стиля
   * — плейсхолдеры живут только в placeholder-режиме и удаляются своим же
   * прогоном либо полным откатом.
   * @param {HTMLElement} cell
   * @param {HTMLElement[]} pair
   * @param {HTMLElement[]} attachPoints - элементы, после которых должен быть плейсхолдер
   */
  function syncPlaceholders(cell, pair, attachPoints) {
    if (settings.style !== 'placeholder') return;
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
   * В strike-режиме плейсхолдеры не трогаются (их синхронизирует placeholder-прогон).
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
   * Фон клетки при полном скрытии (только placeholder) — как у пустой клетки.
   * Цвет пары сайт задаёт инлайном (`background-color: … !important`), а фон
   * пустой клетки — своими стилями: белый, у текущего дня — `.cur-day`
   * (#e8f5e9 !important). Поэтому инлайновый фон снимается, а не подменяется:
   * цвет пустой клетки рисует сам сайт, в том числе подсветку сегодняшнего дня.
   * В strike фон не трогается никогда.
   * @param {HTMLElement} cell
   */
  function updateCellBackground(cell) {
    if (settings.style !== 'placeholder') {
      restoreCellStyle(cell);
      return;
    }
    if (M.isCellFullyHidden(cell)) {
      cacheCellStyle(cell);
      cell.style.removeProperty('background-color');
      cell.style.removeProperty('background');
    } else {
      restoreCellStyle(cell);
    }
  }

  /**
   * Прогон по всем клеткам расписания: скрыть/вернуть пары, фон, счётчик.
   * Пара с несколькими преподавателями скрывается поблочно: каждый блок
   * ([Преп N...] после <hr>) проверяется правилом независимо; «шапка» пары
   * скрывается, только когда скрыты ВСЕ её блоки.
   * При выключенном тумблере не делает ничего: прогон мог быть запланирован
   * дебаунсом ДО выключения и сработать уже после fullRollback — без этой
   * проверки «протухший» таймер возвращал бы скрытие и зелёный бейдж.
   */
  function processCells() {
    if (!settings.enabled) return;
    const table = document.querySelector('#raspisanie-table');
    if (!table) return;
    const cells = table.querySelectorAll('td.cell');
    let hiddenCount = 0;
    const allMeta = [];
    for (const cell of cells) {
      cacheCellStyle(cell);
      const pairs = M.splitIntoPairs(cell.children);
      for (const pair of pairs) {
        const name = M.getPairName(pair);
        if (!name) continue; // ОВ/ОС — не скрываемые
        const header = pair[0];
        const blocks = M.splitPairIntoBlocks(pair);
        const blockTeachers = blocks.map((b) => M.getBlockTeacher(b));
        const hiddenBlocks = [];
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
          allHidden = matched;
        } else {
          for (let bi = 0; bi < blocks.length; bi++) {
            const block = blocks[bi];
            const matched = settings.rules.some((r) => M.matchRule(name, blockTeachers[bi], r));
            if (matched) {
              for (const el of block) applyPairStyle(el, true);
              hiddenBlocks.push(true);
              hiddenCount++;
            } else {
              for (const el of block) applyPairStyle(el, false);
              hiddenBlocks.push(false);
              allHidden = false;
            }
          }
          applyPairStyle(header, allHidden);
          if (settings.style === 'placeholder') {
            if (allHidden) {
              attachPoints.push(pair[pair.length - 1]); // одна «скрыто» на всю пару
            } else {
              for (let bi = 0; bi < blocks.length; bi++) {
                if (hiddenBlocks[bi]) attachPoints.push(blocks[bi][blocks[bi].length - 1]);
              }
            }
          }
        }
        syncPlaceholders(cell, pair, attachPoints);
        allMeta.push({
          cell,
          pair,
          name,
          teachers: M.getPairTeachers(pair),
          blocks,
          blockTeachers,
          hidden: allHidden,
          hiddenBlocks,
        });
      }
      updateCellBackground(cell);
    }
    UI.syncHover(allMeta);
    sendCount(hiddenCount);
    rememberSuggestions(allMeta);
  }

  /**
   * Запоминание увиденных названий и ФИО для подсказок в настройках
   * (chrome.storage.local, наружу не уходит). Пишется только при изменении:
   * прогон идёт по дебаунсу и не должен дёргать хранилище на каждую
   * перерисовку таблицы.
   * @param {object[]} allMeta - метаданные пар текущей страницы
   */
  function rememberSuggestions(allMeta) {
    if (!SUG) return;
    const subjects = [];
    const teachers = [];
    for (const pm of allMeta) {
      if (pm.name) subjects.push(pm.name);
      for (const t of pm.teachers) teachers.push(t);
    }
    if (!subjects.length && !teachers.length) return;
    // Ошибки записи подсказок молчаливы: это удобство, а не данные пользователя.
    SUG.addSuggestions({ subjects, teachers }).catch(() => {});
  }

  /**
   * Полный откат при глобальном OFF: удалить rh-*, восстановить стили.
   * Снимает и запланированный дебаунсом прогон: иначе он сработает уже после
   * отката и вернёт скрытие при выключенном расширении.
   */
  function fullRollback() {
    clearTimeout(debounceTimer);
    debounceTimer = null;
    UI.removeAllRhElements();
    const table = document.querySelector('#raspisanie-table');
    if (table) {
      const cells = table.querySelectorAll('td.cell');
      for (const cell of cells) {
        restoreCellStyle(cell);
        if (cell.classList) cell.classList.remove(UI.CELL_CLASS);
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
   * Загрузка настроек из chrome.storage.sync. Правила лежат в нескольких
   * ключах (см. lib/rules.js) — читаются одним get вместе с тумблером.
   * @returns {Promise<object>}
   */
  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(['enabled', 'style', ...R.RULE_KEYS], (res) => {
        settings = {
          enabled: res.enabled !== false,
          style: res.style === 'strike' ? 'strike' : 'placeholder',
          rules: R.rulesFromStorage(res),
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

  /**
   * Элемент расширения (класс rh-*) или его потомок: плейсхолдер, кнопка, меню.
   * Мутации, вызванные расширением, повторный прогон не запускают.
   * @param {Node|null} node
   * @returns {boolean}
   */
  function isRhOrInside(node) {
    let cur = node;
    while (cur && cur.nodeType === 1) {
      if (M.isRhElement(cur)) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  /**
   * Мутация целиком от расширения (все добавленные/удалённые узлы — rh-*)?
   * @param {MutationRecord} m
   * @returns {boolean}
   */
  function isRhMutation(m) {
    const nodes = [];
    if (m.addedNodes) for (const n of m.addedNodes) nodes.push(n);
    if (m.removedNodes) for (const n of m.removedNodes) nodes.push(n);
    if (nodes.length === 0) return false;
    return nodes.every(isRhOrInside);
  }

  // Инициализация — только в браузере (в Node — только экспорт для тестов).
  if (typeof document === 'undefined' || typeof chrome === 'undefined') return;

  UI.injectStyles();

  const observer = new MutationObserver((mutations) => {
    if (!settings.enabled) return;
    if (mutations.every(isRhMutation)) return; // собственные изменения расширения
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(processCells, 120);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    loadSettings().then(() => {
      if (!settings.enabled) { fullRollback(); return; }
      // Реальный переход на «зачеркнуть»: плейсхолдеры снимаются атомарно,
      // чтобы не остались висячие «скрыто» у зачёркнутых пар.
      if (changes.style && changes.style.newValue === 'strike') UI.removeAllRhElements();
      processCells();
    });
  });

  loadSettings().then(() => {
    if (settings.enabled) processCells();
    else sendOff();
  });
})(typeof window !== 'undefined' ? window : globalThis);
