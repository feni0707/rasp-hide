/**
 * Hover-UI (фаза 5): кнопка «Скрыть»/«Вернуть» у пары, мини-меню
 * с пунктом на каждого преподавателя + «у всех» + «Отмена»,
 * подтверждение поглощения, плейсхолдер «скрыто», очистка rh-* элементов.
 * Все добавляемые элементы имеют класс с префиксом rh- и регистрируются
 * для полного отката (глобальный OFF).
 */
(function (global) {
  'use strict';

  const STYLE_ID = 'rh-styles';
  const rhElements = new Set();
  const controllers = new Set();
  const controllerByHeader = new WeakMap(); // заголовок пары (pair[0]) → контроллер.
  // Ключ — стабильный DOM-узел, а НЕ массив пары: splitIntoPairs создаёт новый массив
  // на каждый прогон, иначе контроллеры пересоздавались бы каждые 120 мс (зацикливание).
  const hoverInfo = new WeakMap();
  const buttonControllers = new WeakMap();
  let globalListenersAttached = false;

  const M = global.RASP_HIDE_MATCHER;
  const R = global.RASP_HIDE_RULES;

  /**
   * Поддержка событий (реальный браузер). В тестах (Node, мок DOM) hover-UI
   * не собирается — события страницы недоступны.
   * @returns {boolean}
   */
  function canAttachEvents() {
    return typeof document !== 'undefined' &&
      typeof document.addEventListener === 'function';
  }

  /**
   * Внедрение стилей расширения (идемпотентно).
   */
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '.rh-strike{opacity:.35 !important;text-decoration:line-through !important;}' +
      '.rh-strike a,.rh-strike b{text-decoration:line-through;}' +
      '.rh-placeholder{color:#9ca3af;font-size:12px;padding:4px 0;opacity:.7;user-select:none;}' +
      '.rh-hover-btn{position:absolute;top:2px;right:2px;z-index:20;display:none;' +
        'background:#fff;border:1px solid #cbd5e1;border-radius:4px;' +
        'padding:1px 8px;font-size:11px;line-height:1.4;color:#374151;' +
        'cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.15);user-select:none;}' +
      '.rh-hover-btn--restore{color:#166534;border-color:#86efac;background:#f0fdf4;}' +
      '.rh-menu{position:absolute;top:24px;right:2px;z-index:21;display:none;' +
        'min-width:190px;background:#fff;border:1px solid #e2e8f0;border-radius:6px;' +
        'box-shadow:0 4px 12px rgba(0,0,0,.15);padding:4px;font-size:12px;' +
        'color:#111827;text-align:left;}' +
      '.rh-menu-item{display:block;width:100%;text-align:left;background:none;border:0;' +
        'border-radius:4px;padding:4px 8px;font-size:12px;color:#111827;cursor:pointer;}' +
      '.rh-menu-item:hover{background:#f3f4f6;}' +
      '.rh-menu-item--danger{color:#b91c1c;}' +
      '.rh-menu-title{font-weight:600;padding:4px 8px;color:#374151;}' +
      '.rh-menu-absorbed{padding:2px 8px;color:#6b7280;word-break:break-word;}' +
      '.rh-menu-status{padding:4px 8px;color:#b91c1c;}';
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
   * Удаление только плейсхолдеров (переключение placeholder→strike).
   */
  function removePlaceholders() {
    for (const el of [...rhElements]) {
      if (el.classList && el.classList.contains('rh-placeholder')) el.remove();
    }
  }

  /**
   * Удаление всех элементов расширения (rh-*) — полный откат при глобальном OFF.
   * Ховер-UI полностью выключается.
   */
  function removeAllRhElements() {
    destroyAllHover();
    for (const el of rhElements) el.remove();
    rhElements.clear();
  }

  /**
   * Признак плейсхолдера.
   * @param {Element|null} el
   * @returns {boolean}
   */
  function isPh(el) {
    return !!(el && el.classList &&
      typeof el.classList.contains === 'function' &&
      el.classList.contains('rh-placeholder'));
  }

  /**
   * Индекс дочернего элемента клетки.
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
   * Плейсхолдеры пары (в диапазоне её элементов в клетке).
   * @param {HTMLElement} cell
   * @param {HTMLElement[]} pair
   * @returns {HTMLElement[]}
   */
  function placeholdersForPair(cell, pair) {
    const out = [];
    const start = childIndex(cell, pair[0]);
    const end = childIndex(cell, pair[pair.length - 1]);
    if (start < 0 || end < start) return out;
    for (let i = start; i <= end + 1 && i < cell.children.length; i++) {
      if (isPh(cell.children[i])) out.push(cell.children[i]);
    }
    return out;
  }

  /**
   * Контекст плейсхолдера: какая пара/блок за ним (для «Вернуть»).
   * @param {HTMLElement} cell
   * @param {HTMLElement} ph
   * @param {Map} pairByEl - элемент → метаданные пары
   * @param {Map} blockByEl - элемент → { pm, blockIdx }
   * @returns {{pm: object, kind: string, blockIdx: number|null}|null}
   */
  function contextForPlaceholder(cell, ph, pairByEl, blockByEl) {
    const i = childIndex(cell, ph);
    if (i < 1) return null;
    const prev = cell.children[i - 1];
    const pm = pairByEl.get(prev);
    if (!pm) return null;
    if (prev === pm.pair[pm.pair.length - 1] && pm.hidden) {
      return { pm, kind: 'pair', blockIdx: null };
    }
    const bi = blockByEl.get(prev);
    if (bi) return { pm, kind: 'block', blockIdx: bi.blockIdx };
    return null;
  }

  /**
   * Построение индексов «элемент → пара/блок» по метаданным пар.
   * @param {object[]} pairsMeta
   * @returns {{pairByEl: Map, blockByEl: Map}}
   */
  function buildPairIndexes(pairsMeta) {
    const pairByEl = new Map();
    const blockByEl = new Map();
    for (const pm of pairsMeta) {
      for (const el of pm.pair) pairByEl.set(el, pm);
      for (let bi = 0; bi < pm.blocks.length; bi++) {
        for (const el of pm.blocks[bi]) blockByEl.set(el, { pm, blockIdx: bi });
      }
    }
    return { pairByEl, blockByEl };
  }

  /**
   * Сделать клетку позиционированным контейнером (без перезаписи существующих стилей).
   * @param {HTMLElement} cell
   */
  function ensureCellPosition(cell) {
    if (!cell.style.position) cell.style.position = 'relative';
  }

  /**
   * Позиция кнопки над элементом (absolute внутри клетки).
   * @param {HTMLElement} btn
   * @param {HTMLElement} el
   */
  function positionButton(btn, el) {
    let top = 2;
    if (typeof el.getBoundingClientRect === 'function' &&
        typeof btn.parentNode.getBoundingClientRect === 'function') {
      top = el.getBoundingClientRect().top - btn.parentNode.getBoundingClientRect().top;
    } else if (typeof el.offsetTop === 'number' && el.offsetTop > 0) {
      top = el.offsetTop - 2;
    }
    btn.style.top = Math.max(2, Math.round(top)) + 'px';
  }

  /**
   * Позиция меню под кнопкой.
   * @param {object} c - контроллер
   */
  function positionMenu(c) {
    let top = 24;
    if (c.hoverBtn.style.top) top = parseFloat(c.hoverBtn.style.top) + 22;
    c.menu.style.top = top + 'px';
  }

  /**
   * Показ кнопки у элемента в нужном режиме («Скрыть»/«Вернуть»).
   * @param {object} c
   * @param {HTMLElement} el
   * @param {string} mode - 'hide' | 'restore'
   * @param {number|null} blockIdx
   */
  function showFor(c, el, mode, blockIdx) {
    clearTimeout(c.hideTimer);
    closeAllMenus();
    c.mode = mode;
    c.blockIdx = blockIdx;
    c.hoverBtn.textContent = mode === 'restore' ? 'Вернуть' : 'Скрыть';
    c.hoverBtn.classList.toggle('rh-hover-btn--restore', mode === 'restore');
    positionButton(c.hoverBtn, el);
    c.hoverBtn.style.display = 'block';
  }

  /**
   * Отложенное скрытие кнопки и меню (после ухода курсора).
   * @param {object} c
   */
  function scheduleHide(c) {
    clearTimeout(c.hideTimer);
    c.hideTimer = setTimeout(() => hideController(c), 200);
  }

  /**
   * Скрытие кнопки и меню контроллера.
   * @param {object} c
   */
  function hideController(c) {
    c.hoverBtn.style.display = 'none';
    c.menu.style.display = 'none';
  }

  /**
   * Закрытие меню всех контроллеров (при переключении на другую пару).
   */
  function closeAllMenus() {
    for (const c of controllers) c.menu.style.display = 'none';
  }

  /**
   * Очистка содержимого меню.
   * @param {HTMLElement} menu
   */
  function clearMenu(menu) {
    while (menu.firstChild) menu.removeChild(menu.firstChild);
  }

  /**
   * Заголовок меню (название пары / текст подтверждения).
   * @param {HTMLElement} menu
   * @param {string} text
   */
  function addTitle(menu, text) {
    const div = document.createElement('div');
    div.className = 'rh-menu-title';
    div.textContent = text;
    menu.appendChild(registerRhElement(div));
  }

  /**
   * Пункт меню.
   * @param {HTMLElement} menu
   * @param {string} text
   * @param {Function} action
   */
  function addMenuItem(menu, text, action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rh-menu-item';
    btn.textContent = text;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      action();
    });
    menu.appendChild(registerRhElement(btn));
  }

  /**
   * Ближайший зарегистрированный элемент вверх от узла.
   * @param {Node} node
   * @returns {{el: HTMLElement, controller: object, mode: string, blockIdx: number|null}|null}
   */
  function findHoverInfo(node) {
    let cur = node;
    while (cur && cur !== document) {
      const info = hoverInfo.get(cur);
      if (info) return info;
      cur = cur.parentNode;
    }
    return null;
  }

  /**
   * Внутри ли узел кнопки/меню контроллера (не уходим от показа).
   * @param {Node} node
   * @param {object} c
   * @returns {boolean}
   */
  function isInsideController(node, c) {
    let cur = node;
    while (cur && cur !== document) {
      if (cur === c.hoverBtn || cur === c.menu) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  /**
   * Клик по кнопке: «Вернуть» — сразу; «Скрыть» — открыть мини-меню.
   * @param {MouseEvent} e
   */
  function onBtnClick(e) {
    const c = buttonControllers.get(e.target);
    if (!c) return;
    e.stopPropagation();
    if (c.mode === 'restore') doRestore(c, c.blockIdx);
    else openHideMenu(c);
  }

  /**
   * Глобальные обработчики (одни на страницу): hover, закрытие по клику
   * вне меню и по Escape.
   */
  function ensureGlobalListeners() {
    if (globalListenersAttached) return;
    globalListenersAttached = true;
    document.addEventListener('mouseover', (e) => {
      const info = findHoverInfo(e.target);
      if (info) showFor(info.controller, info.el, info.mode, info.blockIdx);
    });
    document.addEventListener('mouseout', (e) => {
      const info = findHoverInfo(e.target);
      if (!info) return;
      const related = e.relatedTarget;
      if (related &&
          (isInsideController(related, info.controller) || findHoverInfo(related) === info)) {
        return;
      }
      scheduleHide(info.controller);
    });
    document.addEventListener('click', (e) => {
      for (const c of controllers) {
        if (isInsideController(e.target, c)) return;
      }
      closeAllMenus();
      for (const c of controllers) c.hoverBtn.style.display = 'none';
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeAllMenus();
        for (const c of controllers) c.hoverBtn.style.display = 'none';
      }
    });
  }

  /**
   * Контроллер пары: кнопка «Скрыть»/«Вернуть» + меню внутри клетки.
   * @param {object} pm - метаданные пары (из content.js)
   * @returns {object}
   */
  function makeController(pm) {
    const cell = pm.cell;
    ensureCellPosition(cell);

    const hoverBtn = registerRhElement(document.createElement('button'));
    hoverBtn.type = 'button';
    hoverBtn.className = 'rh-hover-btn';
    hoverBtn.textContent = 'Скрыть';
    hoverBtn.addEventListener('click', onBtnClick);
    cell.appendChild(hoverBtn);

    const menu = registerRhElement(document.createElement('div'));
    menu.className = 'rh-menu';
    cell.appendChild(menu);

    const c = {
      pm, cell, hoverBtn, menu,
      header: pm.pair[0], // стабильный ключ (узел шапки пары)
      mode: 'hide', blockIdx: null, hideTimer: null,
      bound: [], // элементы, на которые повешен hover (для очистки при пересборе)
    };
    buttonControllers.set(hoverBtn, c);
    controllers.add(c);
    controllerByHeader.set(c.header, c);
    return c;
  }

  /**
   * Регистрация целей hover: видимые элементы → «Скрыть»; скрытые блоки
   * (плейсхолдеры/зачёркивание) → «Вернуть».
   * @param {object} pm
   * @param {object} c
   * @param {Map} pairByEl
   * @param {Map} blockByEl
   */
  function bindHoverTargets(pm, c, pairByEl, blockByEl) {
    // Снять старые привязки (элементы пары могли изменить видимость).
    for (const el of c.bound) hoverInfo.delete(el);
    c.bound = [];
    const bind = (el, mode, blockIdx) => {
      hoverInfo.set(el, { el, controller: c, mode, blockIdx });
      c.bound.push(el);
    };
    // Видимые элементы пары: кнопка «Скрыть».
    for (const el of pm.pair) {
      if (el.tagName === 'HR') continue;
      if (el.style && el.style.display === 'none') continue;
      if (el.classList && el.classList.contains('rh-strike')) continue;
      bind(el, 'hide', null);
    }
    // Плейсхолдеры пары (placeholder-режим): «Вернуть» по контексту.
    for (const ph of placeholdersForPair(pm.cell, pm.pair)) {
      const ctx = contextForPlaceholder(pm.cell, ph, pairByEl, blockByEl);
      if (!ctx) continue;
      bind(ph, 'restore', ctx.blockIdx);
    }
    // Зачёркнутые элементы (strike-режим): «Вернуть».
    for (const el of pm.pair) {
      if (el.tagName === 'HR') continue;
      if (!(el.classList && el.classList.contains('rh-strike'))) continue;
      const bi = blockByEl.get(el);
      bind(el, 'restore', bi ? bi.blockIdx : null);
    }
  }

  /**
   * Пересборка hover-UI по метаданным пар (вызывается content.js после прогона).
   * Идемпотентно: контроллеры пар переиспользуются (без пересоздания DOM),
   * новые пары — создаются, исчезнувшие — удаляются. Без этого MutationObserver
   * зацикливался бы: добавление кнопок порождало бы новый прогон и пересоздание.
   * @param {object[]} pairsMeta
   */
  function syncHover(pairsMeta) {
    if (!canAttachEvents()) return;
    if (pairsMeta.length === 0) {
      destroyAllHover();
      return;
    }
    ensureGlobalListeners();
    // Удалить контроллеры пар, которых больше нет на странице.
    const seen = new Set(pairsMeta.map((pm) => pm.pair[0]));
    for (const c of [...controllers]) {
      if (c.header && !seen.has(c.header)) removeController(c);
    }
    const { pairByEl, blockByEl } = buildPairIndexes(pairsMeta);
    for (const pm of pairsMeta) {
      if (pm.name == null) continue; // ОВ/ОС в hover-UI не участвуют
      let c = controllerByHeader.get(pm.pair[0]);
      if (!c) c = makeController(pm);
      bindHoverTargets(pm, c, pairByEl, blockByEl);
    }
  }

  /**
   * Удаление контроллера пары (кнопка, меню, привязки hover).
   * @param {object} c
   */
  function removeController(c) {
    clearTimeout(c.hideTimer);
    if (c.hoverBtn && c.hoverBtn.parentNode) c.hoverBtn.parentNode.removeChild(c.hoverBtn);
    if (c.menu && c.menu.parentNode) c.menu.parentNode.removeChild(c.menu);
    for (const el of c.bound) hoverInfo.delete(el);
    buttonControllers.delete(c.hoverBtn);
    controllers.delete(c);
    if (c.header && controllerByHeader.get(c.header) === c) {
      controllerByHeader.delete(c.header);
    }
  }

  /**
   * Удаление всех hover-контроллеров (кнопки и меню).
   */
  function destroyAllHover() {
    for (const c of [...controllers]) removeController(c);
  }

  /**
   * Открытие мини-меню скрытия пары: пункт на каждого преподавателя,
   * «у всех»/«Скрыть пару» и «Отмена».
   * @param {object} c
   */
  function openHideMenu(c) {
    const menu = c.menu;
    clearMenu(menu);
    const name = c.pm.name;
    const teachers = c.pm.teachers;
    addTitle(menu, name);
    if (teachers.length === 0) {
      addMenuItem(menu, 'Скрыть пару', () => hideAction(c, null));
    } else {
      for (const t of teachers) {
        addMenuItem(menu, 'Скрыть: ' + t, () => hideAction(c, t));
      }
      addMenuItem(menu, 'Скрыть у всех преподавателей', () => hideAction(c, null));
    }
    addMenuItem(menu, 'Отмена', () => hideController(c));
    positionMenu(c);
    menu.style.display = 'block';
  }

  /**
   * Добавление правила скрытия из пункта меню.
   * @param {object} c
   * @param {string|null} teacher - null = «у всех»
   */
  async function hideAction(c, teacher) {
    const rule = { subject: c.pm.name, teacher };
    const res = await R.addRule(rule);
    handleAddResult(c, rule, res);
  }

  /**
   * Обработка результата добавления правила (поглощение, дубликат, лимит…).
   * @param {object} c
   * @param {object} rule
   * @param {object} res
   */
  async function handleAddResult(c, rule, res) {
    switch (res.status) {
      case 'added':
      case 'absorbed':
        hideController(c);
        break;
      case 'absorb':
        renderConfirm(c, 'Также удалится:', res.absorbed, async () => {
          const r2 = await R.addRule(rule, { autoAbsorb: true });
          if (r2.status === 'absorbed' || r2.status === 'added') hideController(c);
          else handleAddResult(c, rule, r2);
        });
        break;
      case 'duplicate':
        renderStatus(c, R.MSG_DUPLICATE, [{
          label: 'Включить существующее',
          action: () => confirmEnable(c, res.existing),
        }]);
        break;
      case 'covered':
        renderStatus(c, R.MSG_COVERED, [{
          label: 'Включить существующее',
          action: () => confirmEnable(c, res.covering),
        }]);
        break;
      case 'limit':
        renderStatus(c, 'Достигнут лимит ' + R.MAX_RULES + ' правил');
        break;
      case 'error':
        renderStatus(c, R.MSG_NOT_SAVED);
        break;
      default:
        hideController(c);
    }
  }

  /**
   * Включение существующего правила (дубликат/уже покрыто).
   * @param {object} c
   * @param {object} rule
   */
  async function confirmEnable(c, rule) {
    const res = await R.setEnabled(rule, true);
    if (res.status === 'enabled' || res.status === 'absorbed') {
      hideController(c);
      return;
    }
    if (res.status === 'absorb') {
      renderConfirm(c, 'Также удалится:', res.absorbed, async () => {
        const r2 = await R.setEnabled(rule, true, { autoAbsorb: true });
        if (r2.status === 'enabled' || r2.status === 'absorbed') hideController(c);
        else renderStatus(c, 'Не удалось включить правило');
      });
      return;
    }
    if (res.status === 'covered') {
      renderStatus(c, R.MSG_COVERED, [{
        label: 'Включить существующее',
        action: () => confirmEnable(c, res.covering),
      }]);
      return;
    }
    if (res.status === 'error') renderStatus(c, R.MSG_NOT_SAVED);
    else hideController(c);
  }

  /**
   * Подтверждение поглощения: список удаляемых правил + [Удалить] / [Отмена].
   * @param {object} c
   * @param {string} title
   * @param {object[]} absorbed
   * @param {Function} onConfirm
   */
  function renderConfirm(c, title, absorbed, onConfirm) {
    const menu = c.menu;
    clearMenu(menu);
    addTitle(menu, title);
    for (const r of absorbed) {
      const div = document.createElement('div');
      div.className = 'rh-menu-absorbed';
      div.textContent = r.subject + (r.teacher ? ' — ' + r.teacher : ' — все преподаватели');
      menu.appendChild(registerRhElement(div));
    }
    addMenuItem(menu, 'Удалить', onConfirm);
    addMenuItem(menu, 'Отмена', () => hideController(c));
    positionMenu(c);
    menu.style.display = 'block';
  }

  /**
   * Статусное сообщение в меню (ошибка/подсказка) + опциональные кнопки.
   * @param {object} c
   * @param {string} text
   * @param {Array} [buttons]
   */
  function renderStatus(c, text, buttons = []) {
    const menu = c.menu;
    clearMenu(menu);
    const div = document.createElement('div');
    div.className = 'rh-menu-status';
    div.textContent = text;
    menu.appendChild(registerRhElement(div));
    for (const b of buttons) addMenuItem(menu, b.label, b.action);
    addMenuItem(menu, 'Отмена', () => hideController(c));
    positionMenu(c);
    menu.style.display = 'block';
  }

  /**
   * Возврат пары/блока (кнопка «Вернуть»): удаляет самое специфичное правило.
   * @param {object} c
   * @param {number|null} blockIdx - null = вся пара
   */
  async function doRestore(c, blockIdx) {
    const pm = c.pm;
    let teacher = null;
    if (blockIdx != null) {
      teacher = pm.blockTeachers[blockIdx] || null;
    } else if (pm.teachers.length) {
      teacher = pm.teachers[0];
    }
    const res = await R.restorePair(pm.name, teacher);
    hideController(c);
    if (res.status === 'none') renderStatus(c, 'Не найдено правило для возврата');
    else if (res.status === 'error') renderStatus(c, R.MSG_NOT_SAVED);
  }

  const UI = {
    injectStyles,
    createPlaceholder,
    removePlaceholders,
    removeAllRhElements,
    syncHover,
    destroyAllHover,
  };

  global.RASP_HIDE_UI = UI;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = UI;
  }
})(typeof window !== 'undefined' ? window : globalThis);
