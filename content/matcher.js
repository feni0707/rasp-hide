/**
 * Чистая логика матчинга и структуры клетки — без зависимостей от chrome
 * и от настоящего DOM API. Принимает DOM-like элементы (NodeList/дети клетки)
 * для тестируемости в Node. Подключается в content script и экспортируется
 * в Node (module.exports) для тестов.
 *
 * Требует загруженного lib/text.js (в манифесте и options.html он идёт первым).
 */
(function (global) {
  'use strict';

  /** Точное название пары — только видимый span.textContent (без fallback на title). */

  // Общая нормализация: одна на matcher и rules — см. lib/text.js.
  const normalize = global.RASP_HIDE_TEXT.normalize;

  /**
   * Признак старта новой пары: <div> c <b> (тип ЛК/ПР/ЛБ),
   * либо (только если группа ещё не начата) <div> c <span>.
   * @param {Element} el
   * @param {boolean} hasCurrent - начата ли текущая группа
   * @returns {boolean}
   */
  function isPairStart(el, hasCurrent) {
    if (!el || el.tagName !== 'DIV' || typeof el.querySelector !== 'function') return false;
    if (el.querySelector('b')) return true;
    return !hasCurrent && !!el.querySelector('span');
  }

  /**
   * Элемент интерфейса расширения: плейсхолдер, hover-кнопка, меню.
   * В структуру пар не попадают.
   * ВАЖНО: класс rh-strike — это стиль скрытия на элементах САМОЙ пары,
   * а не UI-элемент расширения, поэтому такие элементы НЕ отбрасываются:
   * иначе зачёркнутая пара выпала бы из прогона и её нельзя было бы
   * вернуть или переключить стиль.
   * @param {Element|null} el
   * @returns {boolean}
   */
  function isRhElement(el) {
    if (!el || !el.classList || typeof el.classList.contains !== 'function') return false;
    const cls = el.className;
    if (typeof cls !== 'string') return false;
    const classes = cls.split(/\s+/);
    return classes.indexOf('rh-placeholder') !== -1 ||
      classes.some((c) => c.indexOf('rh-hover') === 0) ||
      classes.some((c) => c.indexOf('rh-menu') === 0);
  }

  /**
   * Группировка детей клетки на пары.
   * Старт пары — <div> с <b> (или, пока группа не начата, <div> со <span>);
   * <hr> прикрепляется к текущей паре; остальные <div> — в текущую пару.
   * @param {ArrayLike<Element>} cellChildren - children клетки
   * @returns {Element[][]}
   */
  function splitIntoPairs(cellChildren) {
    const pairs = [];
    let current = [];
    for (const child of cellChildren) {
      // Элементы расширения (плейсхолдеры, hover-кнопки, меню) в пары не попадают.
      if (isRhElement(child)) continue;
      if (child.tagName === 'HR') {
        if (current.length) current.push(child);
        continue;
      }
      if (isPairStart(child, current.length > 0)) {
        if (current.length) pairs.push(current);
        current = [child];
      } else {
        current.push(child);
      }
    }
    if (current.length) pairs.push(current);
    return pairs;
  }

  /**
   * Видимое короткое название пары из первого <div> (span.textContent).
   * @param {Element[]} pair
   * @returns {string|null} null, если названия нет (ОВ/ОС) — пара не скрываема.
   */
  function getPairName(pair) {
    const first = pair && pair[0];
    if (!first || typeof first.querySelector !== 'function') return null;
    const span = first.querySelector('span');
    if (!span) return null;
    const name = normalize(span.textContent);
    return name || null;
  }

  /**
   * Все видимые ФИО преподавателей пары из ссылок href="/user_...".
   * У пары может быть несколько преподавателей (ПР Преп1 <hr> Преп2 — одна пара).
   * @param {Element[]} pair
   * @returns {string[]} уникальные нормализованные ФИО; пустой, если преподавателей нет.
   */
  function getPairTeachers(pair) {
    if (!pair) return [];
    const teachers = [];
    for (const el of pair) {
      if (typeof el.querySelector !== 'function') continue;
      const a = el.querySelector('a[href^="/user_"]');
      if (!a) continue;
      const name = normalize(a.textContent);
      if (name && teachers.indexOf(name) === -1) teachers.push(name);
    }
    return teachers;
  }

  /**
   * Разбиение пары на «блоки» преподавателей, разделённые <hr>.
   * Первый элемент пары (div с названием/типом) — «шапка», в блоки не входит:
   * пара вида [шапка, Преп1, <hr>, Преп2] → блоки [[Преп1], [<hr>, Преп2]].
   * <hr> принадлежит следующему за ним блоку (скрывается вместе с ним).
   * @param {Element[]} pair
   * @returns {Element[][]}
   */
  function splitPairIntoBlocks(pair) {
    if (!pair || pair.length < 2) return [];
    const body = pair.slice(1);
    const blocks = [];
    let current = [];
    for (const el of body) {
      if (el.tagName === 'HR') {
        if (current.length) blocks.push(current);
        current = [el];
      } else {
        current.push(el);
      }
    }
    if (current.length) blocks.push(current);
    return blocks;
  }

  /**
   * ФИО преподавателя блока — первый <a href="/user_..."> (видимый текст).
   * @param {Element[]} block
   * @returns {string|null} null, если преподавателя в блоке нет.
   */
  function getBlockTeacher(block) {
    if (!block) return null;
    for (const el of block) {
      if (typeof el.querySelector !== 'function') continue;
      const a = el.querySelector('a[href^="/user_"]');
      if (a) {
        const name = normalize(a.textContent);
        if (name) return name;
      }
    }
    return null;
  }

  /**
   * Совпадение правила с ФИО преподавателя (одна клетка — преподаватель пары/блока).
   * «У всех» (teacher: null) совпадает с любым преподавателем; конкретное ФИО —
   * только с точным совпадением. Для пары с несколькими преподавателями матчинг
   * выполняется по каждому блоку отдельно (см. splitPairIntoBlocks).
   * @param {string|null} name - название пары (нормализованное)
   * @param {string|null} teacher - ФИО преподавателя блока/пары или null
   * @param {object} rule - { subject, teacher: string|null, enabled }
   * @returns {boolean}
   */
  function matchRule(name, teacher, rule) {
    if (!rule) return false;
    if (rule.enabled === false) return false;
    if (!name) return false;
    if (normalize(name) !== normalize(rule.subject)) return false;
    if (rule.teacher == null) return true; // «у всех преподавателей»
    return normalize(rule.teacher) === normalize(teacher || '');
  }

  /**
   * Плейсхолдер «скрыто» расширения.
   * @param {Element|null} el
   * @returns {boolean}
   */
  function isPlaceholder(el) {
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
   * Плейсхолдеры пары: в диапазоне её элементов плюс одна позиция после
   * последнего — там стоит «скрыто» полностью скрытой пары.
   * Список снимается до обхода: вызывающий (syncPlaceholders) удаляет лишние
   * прямо по ходу, а живой children при этом сдвигается.
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
      if (isPlaceholder(snapshot[i])) result.push(snapshot[i]);
    }
    return result;
  }

  /**
   * Скрыт ли отдельный элемент пары (плейсхолдер или display:none).
   * @param {Element} el
   * @returns {boolean}
   */
  function isElementHidden(el) {
    if (isPlaceholder(el)) return true;
    return !!(el.style && el.style.display === 'none');
  }

  /**
   * Все ли пары клетки скрыты (для решения по фону в режиме placeholder).
   * Вызывается только в режиме placeholder; в strike фон клетки не трогается.
   * @param {Element} cell - клетка <td>
   * @returns {boolean}
   */
  function isCellFullyHidden(cell) {
    const pairs = splitIntoPairs(cell.children);
    if (!pairs.length) return false;
    return pairs.every((pair) => pair.every(isElementHidden));
  }

  const M = {
    normalize,
    splitIntoPairs,
    splitPairIntoBlocks,
    getPairName,
    getPairTeachers,
    getBlockTeacher,
    matchRule,
    isRhElement,
    isPlaceholder,
    childIndex,
    placeholdersForPair,
    isCellFullyHidden,
  };

  global.RASP_HIDE_MATCHER = M;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = M;
  }
})(typeof window !== 'undefined' ? window : globalThis);