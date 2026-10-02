/**
 * Список правил и операции над ним — общее для popup и options.
 * Обе страницы показывают один и тот же список и обязаны одинаково соблюдать
 * инварианты набора (дубликаты, поглощение, «уже покрыто», лимит), поэтому
 * и отрисовка, и разбор результата мутации живут здесь, а не в каждой странице.
 *
 * Сами инварианты — в lib/rules.js; здесь только показ и подтверждения.
 * Требует загруженных lib/text.js, lib/rules.js, ui/icons.js, ui/status.js.
 */
(function (global) {
  'use strict';

  const R = global.RASP_HIDE_RULES;
  const ICONS = global.RASP_HIDE_ICONS;

  /**
   * Сортировка правил: алфавит предмета, «все» выше конкретных ФИО,
   * затем по алфавиту ФИО.
   * @param {object[]} list
   * @returns {object[]} новый отсортированный массив
   */
  function sortRules(list) {
    return [...list].sort((a, b) => {
      const bySubject = a.subject.localeCompare(b.subject, 'ru');
      if (bySubject !== 0) return bySubject;
      if (a.teacher === null && b.teacher !== null) return -1;
      if (a.teacher !== null && b.teacher === null) return 1;
      return (a.teacher || '').localeCompare(b.teacher || '', 'ru');
    });
  }

  /**
   * Подходит ли правило под поисковый фильтр.
   * Ищем и по предмету, и по ФИО: «покажи всё от Иванова» — такой же
   * естественный запрос, как «покажи всё по матанализу».
   * @param {object} rule
   * @param {string} filter - уже нормализованный и в нижнем регистре
   * @returns {boolean}
   */
  function matchesFilter(rule, filter) {
    if (!filter) return true;
    const subject = R.normalize(rule.subject).toLowerCase();
    const teacher = R.normalize(rule.teacher || '').toLowerCase();
    return subject.indexOf(filter) !== -1 || teacher.indexOf(filter) !== -1;
  }

  /**
   * Подпись преподавателя в строке списка.
   * @param {object} rule
   * @returns {string}
   */
  function teacherLabel(rule) {
    return rule.teacher === null ? 'все преподаватели' : rule.teacher;
  }

  /**
   * Одна строка списка.
   * @param {object} rule
   * @param {{onToggle: Function, onDelete: Function}} handlers
   * @returns {HTMLElement}
   */
  function renderRow(rule, handlers) {
    const enabled = rule.enabled !== false;
    const row = document.createElement('div');
    row.className = 'rh-rule' + (enabled ? '' : ' rh-rule--off');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = enabled;
    // Доступное имя чекбокса — что именно он включает, а не просто «вкл».
    checkbox.setAttribute('aria-label',
      (enabled ? 'Выключить правило: ' : 'Включить правило: ') + R.formatRule(rule));
    checkbox.addEventListener('change', () => handlers.onToggle(rule, checkbox));

    const body = document.createElement('div');
    body.className = 'rh-rule-body';
    const subject = document.createElement('span');
    subject.className = 'rh-rule-subject';
    subject.textContent = rule.subject;
    const teacher = document.createElement('span');
    teacher.className = 'rh-rule-teacher';
    teacher.textContent = teacherLabel(rule);
    body.appendChild(subject);
    body.appendChild(teacher);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'rh-btn rh-btn--icon rh-btn--danger';
    // Кнопка без видимого текста — имя обязано быть на самой кнопке.
    del.setAttribute('aria-label', 'Удалить правило: ' + R.formatRule(rule));
    del.appendChild(ICONS.icon('trash'));
    del.addEventListener('click', () => handlers.onDelete(rule));

    row.appendChild(checkbox);
    row.appendChild(body);
    row.appendChild(del);
    return row;
  }

  /**
   * Пустое состояние: не просто «пусто», а что делать дальше.
   * @param {string} text
   * @param {string} iconName
   * @returns {HTMLElement}
   */
  function renderEmpty(text, iconName) {
    const box = document.createElement('div');
    box.className = 'rh-empty';
    box.appendChild(ICONS.icon(iconName, { large: true }));
    const span = document.createElement('span');
    span.textContent = text;
    box.appendChild(span);
    return box;
  }

  /**
   * Отрисовка списка правил в контейнер.
   * @param {HTMLElement} container
   * @param {object[]} rules - весь набор
   * @param {string} filter - нормализованный фильтр в нижнем регистре
   * @param {{onToggle: Function, onDelete: Function}} handlers
   * @returns {number} сколько строк показано
   */
  function renderList(container, rules, filter, handlers) {
    container.textContent = '';
    const shown = sortRules(rules).filter((r) => matchesFilter(r, filter));
    if (shown.length === 0) {
      container.appendChild(rules.length === 0
        ? renderEmpty('Правил пока нет. Наведите курсор на пару в расписании — или добавьте вручную.', 'eye-slash')
        : renderEmpty('Под фильтр ничего не подошло.', 'magnifying-glass'));
      return 0;
    }
    for (const rule of shown) container.appendChild(renderRow(rule, handlers));
    return shown.length;
  }

  /**
   * Операции над правилами с общими подтверждениями и сообщениями.
   * Возвращает набор действий; страница подставляет свой статус-блок
   * и колбэк обновления.
   * @param {{status: object, onRefresh: Function}} ctx
   * @returns {{toggle: Function, remove: Function, add: Function}}
   */
  function createActions(ctx) {
    const status = ctx.status;

    /**
     * Общий разбор результата мутации набора.
     * @param {object} res
     */
    function handleResult(res) {
      if (res.status === 'error') {
        status.show(res.message || R.MSG_NOT_SAVED);
      } else {
        status.hide();
      }
      ctx.onRefresh();
    }

    /**
     * Включение существующего правила (кнопка «Включить существующее»).
     * @param {object} rule
     */
    function enableExisting(rule) {
      R.setEnabled(rule, true).then((res) => {
        if (res.status === 'absorb') {
          confirmAbsorb(res.absorbed, () =>
            R.setEnabled(rule, true, { autoAbsorb: true }).then(handleResult));
          return;
        }
        if (res.status === 'covered') {
          showCovered(res.covering);
          return;
        }
        handleResult(res);
      });
    }

    /**
     * Подтверждение поглощения: что именно исчезнет.
     * @param {object[]} absorbed
     * @param {Function} onConfirm
     */
    function confirmAbsorb(absorbed, onConfirm) {
      status.confirm(
        'Также удалятся правила: ' + sortRules(absorbed).map(R.formatRule).join('; '),
        onConfirm
      );
    }

    /**
     * «Уже покрыто правилом …» + переход к существующему.
     * @param {object} covering
     */
    function showCovered(covering) {
      status.show(R.MSG_COVERED + ' «' + R.formatRule(covering) + '»', [
        { label: 'Включить существующее', onClick: () => enableExisting(covering) },
      ]);
    }

    return {
      /**
       * Вкл/выкл правила.
       * @param {object} rule
       * @param {HTMLInputElement} checkbox
       */
      toggle(rule, checkbox) {
        R.setEnabled(rule, checkbox.checked).then((res) => {
          if (res.status === 'absorb') {
            checkbox.checked = false; // до подтверждения набор не менялся
            confirmAbsorb(res.absorbed, () =>
              R.setEnabled(rule, true, { autoAbsorb: true }).then(handleResult));
            return;
          }
          if (res.status === 'covered') {
            checkbox.checked = false;
            showCovered(res.covering);
            return;
          }
          handleResult(res);
        });
      },

      /**
       * Удаление правила — всегда с подтверждением.
       * @param {object} rule
       */
      remove(rule) {
        status.confirm('Удалить правило «' + R.formatRule(rule) + '»?',
          () => R.removeRule(rule).then(handleResult));
      },

      /**
       * Добавление правила вручную.
       * @param {string} subject
       * @param {string} teacherRaw - пустая строка = «у всех»
       * @param {Function} [onAdded] - вызывается только при успешном добавлении
       */
      add(subject, teacherRaw, onAdded) {
        const teacher = R.normalize(teacherRaw) === '' ? null : R.normalize(teacherRaw);
        const rule = { subject, teacher };
        R.addRule(rule).then((res) => {
          switch (res.status) {
            case 'added':
              status.hide();
              if (onAdded) onAdded();
              ctx.onRefresh();
              break;
            case 'duplicate':
              status.show(R.MSG_DUPLICATE + ': «' + R.formatRule(res.existing) + '»', [
                { label: 'Включить существующее', onClick: () => enableExisting(res.existing) },
              ]);
              break;
            case 'covered':
              showCovered(res.covering);
              break;
            case 'absorb':
              confirmAbsorb(res.absorbed, () =>
                R.addRule(rule, { autoAbsorb: true }).then((r2) => {
                  handleResult(r2);
                  if (r2.status !== 'error' && onAdded) onAdded();
                }));
              break;
            case 'limit':
              status.show('Достигнут лимит ' + R.MAX_RULES +
                ' правил. Удалите часть правил, чтобы добавить новые.');
              break;
            case 'invalid':
              status.show('Введите название предмета — точно как в расписании.');
              break;
            default:
              handleResult(res);
          }
        });
      },
    };
  }

  const L = { sortRules, matchesFilter, teacherLabel, renderList, createActions };

  global.RASP_HIDE_RULES_LIST = L;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = L;
  }
})(typeof window !== 'undefined' ? window : globalThis);
