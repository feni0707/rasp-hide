/**
 * Чистая логика матчинга пар — без зависимостей от chrome/DOM.
 * Принимает DOM-like элементы (NodeList/дети клетки) для тестируемости в Node.
 * Подключается в content script и экспортируется в Node (module.exports) для тестов.
 */
(function (global) {
  'use strict';

  /** Точное название пары — только видимый span.textContent (без fallback на title). */

  /**
   * Нормализация текста: trim, схлопывание пробелов и &nbsp;.
   * @param {string|null|undefined} text
   * @returns {string}
   */
  function normalize(text) {
    if (text == null) return '';
    return String(text).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

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
   * Точное совпадение пары с правилом.
   * Преподаватели пары — массив: совпадение, если правило «у всех» (teacher: null)
   * или хотя бы одно ФИО пары совпало (OR внутри пары).
   * @param {string|null} name - название пары (нормализованное)
   * @param {string[]|string|null} teachers - ФИО преподавателей пары (нормализованные) или null
   * @param {object} rule - { subject, teacher: string|null, enabled }
   * @returns {boolean}
   */
  function matchRule(name, teachers, rule) {
    if (!rule) return false;
    if (rule.enabled === false) return false;
    if (!name) return false;
    if (normalize(name) !== normalize(rule.subject)) return false;
    if (rule.teacher == null) return true; // «у всех преподавателей»
    const list = Array.isArray(teachers) ? teachers : [teachers || ''];
    const target = normalize(rule.teacher);
    return list.some((t) => target === normalize(t));
  }

  /**
   * Скрыт ли отдельный элемент пары (плейсхолдер или display:none).
   * @param {Element} el
   * @returns {boolean}
   */
  function isElementHidden(el) {
    if (el.classList && typeof el.classList.contains === 'function') {
      if (el.classList.contains('rh-placeholder')) return true;
    }
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
    getPairName,
    getPairTeachers,
    matchRule,
    isCellFullyHidden,
  };

  global.RASP_HIDE_MATCHER = M;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = M;
  }
})(typeof window !== 'undefined' ? window : globalThis);