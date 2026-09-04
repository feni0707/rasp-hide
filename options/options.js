/**
 * Страница настроек (фаза 7): тумблер вкл/выкл, radio стиля скрытия,
 * список правил (сортировка по предмету, «все» выше конкретных ФИО,
 * поиск-фильтр, счётчик N/100, лимит 100), добавление вручную,
 * подтверждения (дубликат/поглощение/сброс), обработка ошибок записи.
 * Все изменения правил — через общий lib/rules.js (RASP_HIDE_RULES).
 */
(function (global) {
  'use strict';

  const R = global.RASP_HIDE_RULES;

  let rules = [];   // текущий набор правил (последнее известное состояние)
  let filter = '';  // поисковый фильтр по названию предмета

  // Часто используемые элементы страницы.
  const el = {};
  const statusEl = {}; // блок статуса: текст + кнопки действий

  /**
   * Доступ к chrome API (для подмены моками в тестах).
   * @returns {object}
   */
  function getChrome() {
    return typeof chrome !== 'undefined' ? chrome : global.chrome;
  }

  /**
   * Загрузка глобальных настроек (enabled/style) из chrome.storage.sync.
   * @returns {Promise<{enabled: boolean, style: string}>}
   */
  function loadSettings() {
    return new Promise((resolve) => {
      getChrome().storage.sync.get(['enabled', 'style'], (res) => {
        resolve({
          enabled: !res || res.enabled !== false,
          style: res && res.style === 'strike' ? 'strike' : 'placeholder',
        });
      });
    });
  }

  /**
   * Запись глобальной настройки с обработкой chrome.runtime.lastError.
   * @param {string} key - 'enabled' или 'style'
   * @param {*} value
   * @returns {Promise<boolean>} false — при ошибке записи («Не удалось сохранить»)
   */
  function saveSetting(key, value) {
    return new Promise((resolve) => {
      const patch = {};
      patch[key] = value;
      getChrome().storage.sync.set(patch, () => {
        // lastError только читаем — снимает его рантайм после возврата
        // из коллбэка (см. lib/rules.js saveRules).
        const c = getChrome();
        resolve(!(c.runtime && c.runtime.lastError));
      });
    });
  }

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
   * Подходит ли правило под поисковый фильтр (contains по subject).
   * @param {object} rule
   * @returns {boolean}
   */
  function matchesFilter(rule) {
    if (!filter) return true;
    return R.normalize(rule.subject).toLowerCase().indexOf(filter) !== -1;
  }

  /**
   * Подпись правила: «все преподаватели» или ФИО.
   * @param {object} rule
   * @returns {string}
   */
  function teacherLabel(rule) {
    return rule.teacher === null ? 'все преподаватели' : rule.teacher;
  }

  /**
   * Отрисовка блока статуса: сообщение + необязательные кнопки-действия.
   * @param {string} text
   * @param {Array<{label: string, onClick: Function, danger?: boolean}>} [actions]
   */
  function showStatus(text, actions) {
    statusEl.text.textContent = text;
    for (const btn of statusEl.buttons) btn.remove();
    statusEl.buttons = [];
    for (const action of actions || []) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rh-btn rh-btn--sm' + (action.danger ? ' rh-btn--danger' : '');
      btn.textContent = action.label;
      btn.addEventListener('click', action.onClick);
      statusEl.root.appendChild(btn);
      statusEl.buttons.push(btn);
    }
    statusEl.root.classList.toggle('rh-status--error', true);
    statusEl.root.classList.toggle('rh-status--info', false);
    statusEl.root.hidden = false;
  }

  /**
   * Информационный статус (поглощение и т.п.).
   * @param {string} text
   * @param {Array<{label: string, onClick: Function, danger?: boolean}>} [actions]
   */
  function showInfoStatus(text, actions) {
    showStatus(text, actions);
    statusEl.root.classList.toggle('rh-status--error', false);
    statusEl.root.classList.toggle('rh-status--info', true);
  }

  /**
   * Скрытие блока статуса.
   */
  function hideStatus() {
    statusEl.root.hidden = true;
    statusEl.text.textContent = '';
    for (const btn of statusEl.buttons) btn.remove();
    statusEl.buttons = [];
  }

  /**
   * Одна строка списка правил.
   * @param {object} rule
   * @returns {HTMLElement}
   */
  function renderRuleRow(rule) {
    const row = document.createElement('div');
    row.className = 'rh-rule' + (rule.enabled ? '' : ' rh-rule--off');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = rule.enabled !== false;
    checkbox.title = rule.enabled !== false ? 'Выключить правило' : 'Включить правило';
    checkbox.addEventListener('change', () => onToggleRule(rule, checkbox));

    const subject = document.createElement('span');
    subject.className = 'rh-rule-subject';
    subject.textContent = rule.subject;

    const teacher = document.createElement('span');
    teacher.className = 'rh-rule-teacher';
    teacher.textContent = teacherLabel(rule);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'rh-btn rh-btn--sm rh-btn--danger';
    del.textContent = 'Удалить';
    del.addEventListener('click', () => onDeleteRule(rule));

    row.appendChild(checkbox);
    row.appendChild(subject);
    row.appendChild(teacher);
    row.appendChild(del);
    return row;
  }

  /**
   * Отрисовка списка правил с учётом фильтра и счётчика N/100.
   */
  function renderRules() {
    el.count.textContent = rules.length + '/' + R.MAX_RULES;
    const limitReached = rules.length >= R.MAX_RULES;
    el.limitNote.hidden = !limitReached;
    el.addButton.disabled = limitReached;
    el.subjectInput.disabled = limitReached;
    el.teacherInput.disabled = limitReached;

    el.rulesBox.textContent = '';
    const sorted = sortRules(rules).filter(matchesFilter);
    if (sorted.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'rh-empty';
      empty.textContent = rules.length === 0
        ? 'Правил пока нет. Наведите курсор на пару в расписании или добавьте вручную ниже.'
        : 'Под фильтр ничего не подошло.';
      el.rulesBox.appendChild(empty);
      return;
    }
    for (const rule of sorted) el.rulesBox.appendChild(renderRuleRow(rule));
  }

  /**
   * Перезагрузка набора правил из хранилища и перерисовка.
   */
  function refresh() {
    return R.loadRules().then((loaded) => {
      rules = loaded;
      renderRules();
    });
  }

  /**
   * Вкл/выкл правила через setEnabled с инвариантами (покрытие, поглощение).
   * @param {object} rule
   * @param {HTMLInputElement} checkbox
   */
  function onToggleRule(rule, checkbox) {
    const wantEnabled = checkbox.checked;
    R.setEnabled(rule, wantEnabled).then((res) => {
      if (res.status === 'absorb') {
        // Включение широкого правила удаляет узкие — нужно подтверждение.
        checkbox.checked = false;
        confirmAbsorb(res.absorbed, () =>
          R.setEnabled(rule, true, { autoAbsorb: true }).then(handleMutationResult)
        );
        return;
      }
      if (res.status === 'covered') {
        checkbox.checked = false;
        showCoveredMessage(res.covering);
        return;
      }
      handleMutationResult(res);
    });
  }

  /**
   * Удаление правила — с подтверждением.
   * @param {object} rule
   */
  function onDeleteRule(rule) {
    const what = rule.teacher === null
      ? rule.subject + ' — все преподаватели'
      : rule.subject + ' — ' + rule.teacher;
    if (!global.confirm('Удалить правило «' + what + '»?')) return;
    R.removeRule(rule).then(handleMutationResult);
  }

  /**
   * Кнопка «Включить существующее» при дубликате/покрытии.
   * @param {object} existing
   */
  function enableExisting(existing) {
    R.setEnabled(existing, true).then((res) => {
      if (res.status === 'absorb') {
        confirmAbsorb(res.absorbed, () =>
          R.setEnabled(existing, true, { autoAbsorb: true }).then(handleMutationResult)
        );
        return;
      }
      handleMutationResult(res);
    });
  }

  /**
   * Сообщение «Правило уже существует» + [Включить существующее].
   * @param {object} existing
   */
  function showDuplicateMessage(existing) {
    const what = existing.teacher === null
      ? existing.subject + ' — все преподаватели'
      : existing.subject + ' — ' + existing.teacher;
    showStatus(R.MSG_DUPLICATE + ': «' + what + '»', [
      { label: 'Включить существующее', onClick: () => { hideStatus(); enableExisting(existing); } },
    ]);
  }

  /**
   * Сообщение «Уже покрыто…» + [Включить существующее].
   * @param {object} covering - включённое правило «у всех»
   */
  function showCoveredMessage(covering) {
    showStatus(
      R.MSG_COVERED + ' «' + covering.subject + ' — все преподаватели»',
      [{ label: 'Включить существующее', onClick: () => { hideStatus(); enableExisting(covering); } }]
    );
  }

  /**
   * Подтверждение поглощения: «Также удалится: …» [Удалить] / [Отмена].
   * @param {object[]} absorbed - удаляемые правила
   * @param {Function} onConfirm - действие при согласии
   */
  function confirmAbsorb(absorbed, onConfirm) {
    const list = sortRules(absorbed)
      .map((r) => (r.teacher === null ? r.subject + ' — все' : r.subject + ' — ' + r.teacher))
      .join('; ');
    showInfoStatus('Также удалятся правила: ' + list, [
      { label: 'Удалить', danger: true, onClick: () => { hideStatus(); onConfirm(); } },
      { label: 'Отмена', onClick: hideStatus },
    ]);
  }

  /**
   * Единая обработка результата изменения набора правил.
   * @param {object} res - результат addRule/setEnabled/removeRule/resetRules
   */
  function handleMutationResult(res) {
    if (res.status === 'error') {
      showStatus(res.message || R.MSG_NOT_SAVED); // «Не удалось сохранить»
      refresh();
      return;
    }
    if (res.status === 'removed' || res.status === 'reset' ||
        res.status === 'enabled' || res.status === 'disabled' ||
        res.status === 'absorbed') {
      hideStatus();
    }
    refresh();
  }

  /**
   * Отправка формы добавления правила вручную (все инварианты через addRule).
   */
  function onAddSubmit() {
    const subject = el.subjectInput.value;
    const teacherRaw = el.teacherInput.value;
    const teacher = R.normalize(teacherRaw) === '' ? null : R.normalize(teacherRaw);

    R.addRule({ subject, teacher }).then((res) => {
      switch (res.status) {
        case 'added':
          el.subjectInput.value = '';
          el.teacherInput.value = '';
          el.subjectInput.focus();
          hideStatus();
          break;
        case 'duplicate':
          showDuplicateMessage(res.existing);
          break;
        case 'covered':
          showCoveredMessage(res.covering);
          break;
        case 'absorb':
          confirmAbsorb(res.absorbed, () =>
            R.addRule({ subject, teacher }, { autoAbsorb: true }).then(handleMutationResult)
          );
          return; // поля не чистим — после подтверждения правило добавится
        case 'limit':
          showStatus('Достигнут лимит ' + R.MAX_RULES + ' правил. Удалите часть правил, чтобы добавить новые.');
          break;
        case 'invalid':
          showStatus('Введите название предмета.');
          break;
        default:
          handleMutationResult(res);
          return;
      }
      renderRules();
    });
  }

  /**
   * Сброс к дефолту: только rules, с подтверждением.
   */
  function onReset() {
    if (!global.confirm(
      'Удалить все правила? Тумблер и стиль скрытия останутся без изменений.'
    )) return;
    R.resetRules().then(handleMutationResult);
  }

  /**
   * Применение настроек к элементам формы (при загрузке и по onChanged).
   * @param {{enabled: boolean, style: string}} settings
   */
  function applySettingsToForm(settings) {
    el.enabled.checked = settings.enabled;
    for (const radio of el.styleRadios) radio.checked = radio.value === settings.style;
    el.enabled.disabled = false;
    for (const radio of el.styleRadios) radio.disabled = false;
  }

  /**
   * Инициализация страницы. В тестах (Node) не вызывается.
   */
  function init() {
    el.enabled = document.getElementById('rh-enabled');
    el.styleRadios = Array.prototype.slice.call(
      document.querySelectorAll('input[name="rh-style"]')
    );
    el.count = document.getElementById('rh-count');
    el.limitNote = document.getElementById('rh-limit-note');
    el.search = document.getElementById('rh-search');
    el.rulesBox = document.getElementById('rh-rules');
    el.addForm = document.getElementById('rh-add');
    el.subjectInput = document.getElementById('rh-subject');
    el.teacherInput = document.getElementById('rh-teacher');
    el.addButton = document.getElementById('rh-add-btn');
    el.reset = document.getElementById('rh-reset');

    statusEl.root = document.getElementById('rh-status');
    statusEl.text = document.getElementById('rh-status-text');
    statusEl.buttons = [];

    el.enabled.addEventListener('change', () => {
      saveSetting('enabled', el.enabled.checked).then((ok) => {
        if (ok) return;
        showStatus(R.MSG_NOT_SAVED);
        loadSettings().then(applySettingsToForm); // откат формы к фактическому значению
      });
    });

    for (const radio of el.styleRadios) {
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        saveSetting('style', radio.value).then((ok) => {
          if (ok) return;
          showStatus(R.MSG_NOT_SAVED);
          loadSettings().then(applySettingsToForm); // откат формы к фактическому значению
        });
      });
    }

    el.search.addEventListener('input', () => {
      filter = R.normalize(el.search.value).toLowerCase();
      renderRules();
    });

    el.addForm.addEventListener('submit', (e) => {
      e.preventDefault();
      onAddSubmit();
    });

    el.reset.addEventListener('click', onReset);

    loadSettings().then(applySettingsToForm);
    refresh();

    // Правила могли измениться на странице расписания — обновляем список.
    getChrome().storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if (changes.rules) refresh();
      loadSettings().then(applySettingsToForm);
    });
  }

  const O = { sortRules, matchesFilter, renderRules, init };
  global.RASP_HIDE_OPTIONS = O;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = O;
  }

  if (typeof document === 'undefined' || typeof chrome === 'undefined') return;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
