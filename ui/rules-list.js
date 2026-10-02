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
   * Порядок вида занятия в списке: «все занятия», затем ЛК, ПР, ЛБ,
   * затем незнакомые сайту виды по алфавиту.
   * @param {string|null|undefined} type
   * @returns {number}
   */
  function typeRank(type) {
    if (type == null) return -1;
    const idx = R.PAIR_TYPES.findIndex((t) => t.code === type);
    return idx === -1 ? R.PAIR_TYPES.length : idx;
  }

  /**
   * Сортировка правил: алфавит предмета, «все» выше конкретных ФИО,
   * затем по алфавиту ФИО, затем вид занятия («все занятия» первыми).
   * @param {object[]} list
   * @returns {object[]} новый отсортированный массив
   */
  function sortRules(list) {
    return [...list].sort((a, b) => {
      const bySubject = a.subject.localeCompare(b.subject, 'ru');
      if (bySubject !== 0) return bySubject;
      if (a.teacher == null && b.teacher != null) return -1;
      if (a.teacher != null && b.teacher == null) return 1;
      const byTeacher = (a.teacher || '').localeCompare(b.teacher || '', 'ru');
      if (byTeacher !== 0) return byTeacher;
      const byType = typeRank(a.type) - typeRank(b.type);
      if (byType !== 0) return byType;
      return (a.type || '').localeCompare(b.type || '', 'ru');
    });
  }

  /**
   * Подходит ли правило под поисковый фильтр.
   * Ищем по предмету, ФИО и виду занятия: «покажи всё от Иванова» — такой же
   * естественный запрос, как «покажи всё по матанализу» или «лекции».
   * @param {object} rule
   * @param {string} filter - уже нормализованный и в нижнем регистре
   * @returns {boolean}
   */
  function matchesFilter(rule, filter) {
    if (!filter) return true;
    const fields = [rule.subject, rule.teacher || '', rule.type || '',
      rule.type ? R.typeLabel(rule.type) : ''];
    return fields.some((f) => R.normalize(f).toLowerCase().indexOf(filter) !== -1);
  }

  /**
   * Подпись преподавателя в строке списка.
   * @param {object} rule
   * @returns {string}
   */
  function teacherLabel(rule) {
    return rule.teacher == null ? 'все преподаватели' : rule.teacher;
  }

  /**
   * Вторая строка правила в списке: кто и какие занятия —
   * «Иванов И. И. · лекции», «все преподаватели · все занятия».
   * Оба признака пишутся явно: «все занятия» у старых правил тоже видно.
   * @param {object} rule
   * @returns {string}
   */
  function scopeLabel(rule) {
    return teacherLabel(rule) + ' · ' + R.typeLabel(rule.type);
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
    teacher.textContent = scopeLabel(rule);
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
       * @param {string} typeRaw - код вида (ЛК/ПР/ЛБ); пустая строка = «все занятия»
       * @param {Function} [onAdded] - вызывается только при успешном добавлении
       */
      add(subject, teacherRaw, typeRaw, onAdded) {
        const teacher = R.normalize(teacherRaw) === '' ? null : R.normalize(teacherRaw);
        const type = R.normalize(typeRaw) === '' ? null : R.normalize(typeRaw);
        const rule = { subject, teacher, type };
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

  /**
   * Варианты выбора вида занятия для формы ручного добавления
   * (первый — «все занятия»). Общие для popup и options.
   * @param {HTMLSelectElement} select
   */
  function fillTypeSelect(select) {
    select.textContent = '';
    const options = [{ value: '', text: 'Все занятия' }].concat(R.PAIR_TYPES.map((t) => ({
      value: t.code,
      text: t.label.charAt(0).toUpperCase() + t.label.slice(1) + ' (' + t.code + ')',
    })));
    for (const o of options) {
      const option = document.createElement('option');
      option.value = o.value;
      option.textContent = o.text;
      select.appendChild(option);
    }
  }

  const L = {
    sortRules, matchesFilter, teacherLabel, scopeLabel, fillTypeSelect,
    renderList, createActions,
  };

  global.RASP_HIDE_RULES_LIST = L;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = L;
  }
})(typeof window !== 'undefined' ? window : globalThis);
