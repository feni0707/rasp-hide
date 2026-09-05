/**
 * Страница настроек (фаза 7): тумблер вкл/выкл, radio стиля скрытия,
 * список правил (сортировка по предмету, «все» выше конкретных ФИО,
 * поиск-фильтр, счётчик N/100, лимит 100), добавление вручную,
 * подтверждения (дубликат/поглощение/сброс), обработка ошибок записи,
 * экспорт/импорт правил в JSON.
 * Все изменения правил — через общий lib/rules.js (RASP_HIDE_RULES):
 * импорт проходит те же инварианты, что и ручное добавление.
 */
(function (global) {
  'use strict';

  const R = global.RASP_HIDE_RULES;

  let rules = [];   // текущий набор правил (последнее известное состояние)
  let filter = '';  // поисковый фильтр по названию предмета

  // Часто используемые элементы страницы.
  const el = {};

  /**
   * Блок статуса: текст + кнопки действий. Их на странице два — у списка
   * правил и у экспорта/импорта, — поэтому фабрика, а не singleton.
   * @param {string} rootId
   * @param {string} textId
   * @returns {object}
   */
  function createStatus(rootId, textId) {
    const st = {
      root: null,
      text: null,
      buttons: [],

      /** Привязка к DOM (после загрузки страницы). */
      init() {
        st.root = document.getElementById(rootId);
        st.text = document.getElementById(textId);
        st.buttons = [];
      },

      /**
       * @param {string} text
       * @param {Array<{label: string, onClick: Function, danger?: boolean}>} [actions]
       * @param {string} [kind] - 'error' (по умолчанию) или 'info'
       */
      show(text, actions, kind) {
        st.text.textContent = text;
        for (const btn of st.buttons) btn.remove();
        st.buttons = [];
        for (const action of actions || []) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'rh-btn rh-btn--sm' + (action.danger ? ' rh-btn--danger' : '');
          btn.textContent = action.label;
          btn.addEventListener('click', action.onClick);
          st.root.appendChild(btn);
          st.buttons.push(btn);
        }
        st.root.classList.toggle('rh-status--error', kind !== 'info');
        st.root.classList.toggle('rh-status--info', kind === 'info');
        st.root.hidden = false;
      },

      /** Скрытие блока. */
      hide() {
        st.root.hidden = true;
        st.text.textContent = '';
        for (const btn of st.buttons) btn.remove();
        st.buttons = [];
      },
    };
    return st;
  }

  const statusEl = createStatus('rh-status', 'rh-status-text');
  const ioStatus = createStatus('rh-io-status', 'rh-io-status-text');

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
   * Статус у списка правил: ошибка.
   * @param {string} text
   * @param {Array<{label: string, onClick: Function, danger?: boolean}>} [actions]
   */
  function showStatus(text, actions) {
    statusEl.show(text, actions, 'error');
  }

  /**
   * Статус у списка правил: информация (поглощение и т.п.).
   * @param {string} text
   * @param {Array<{label: string, onClick: Function, danger?: boolean}>} [actions]
   */
  function showInfoStatus(text, actions) {
    statusEl.show(text, actions, 'info');
  }

  /** Скрытие статуса у списка правил. */
  function hideStatus() {
    statusEl.hide();
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
    if (!global.confirm('Удалить правило «' + R.formatRule(rule) + '»?')) return;
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
    showStatus(R.MSG_DUPLICATE + ': «' + R.formatRule(existing) + '»', [
      { label: 'Включить существующее', onClick: () => { hideStatus(); enableExisting(existing); } },
    ]);
  }

  /**
   * Сообщение «Уже покрыто…» + [Включить существующее].
   * @param {object} covering - включённое правило «у всех»
   */
  function showCoveredMessage(covering) {
    showStatus(
      R.MSG_COVERED + ' «' + R.formatRule(covering) + '»',
      [{ label: 'Включить существующее', onClick: () => { hideStatus(); enableExisting(covering); } }]
    );
  }

  /**
   * Подтверждение поглощения: «Также удалится: …» [Удалить] / [Отмена].
   * @param {object[]} absorbed - удаляемые правила
   * @param {Function} onConfirm - действие при согласии
   */
  function confirmAbsorb(absorbed, onConfirm) {
    const list = sortRules(absorbed).map(R.formatRule).join('; ');
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

  /* ---------- Экспорт / импорт ---------- */

  /**
   * Имя файла экспорта: rasp-hide-rules-ГГГГ-ММ-ДД.json (чистая функция).
   * @param {Date} date
   * @returns {string}
   */
  function exportFileName(date) {
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
    return 'rasp-hide-rules-' + stamp + '.json';
  }

  /**
   * Текст сводки импорта (чистая функция) — до записи и после неё.
   * @param {object} plan - результат planImport/importRules
   * @param {{phase: 'confirm'|'done', replace?: boolean, currentCount?: number}} opts
   * @returns {string}
   */
  function importSummary(plan, opts) {
    const skipped = plan.skipped.length
      ? ', пропущено: ' + plan.skipped.length + ' (дубликаты и уже покрытые)'
      : '';
    if (opts.phase === 'confirm') {
      const parts = [];
      if (opts.replace) {
        parts.push('Текущие правила будут заменены (сейчас ' + opts.currentCount + ').');
      }
      if (plan.absorbed.length) {
        parts.push('Будут удалены как поглощённые: ' +
          plan.absorbed.map(R.formatRule).join('; ') + '.');
      }
      parts.push('Добавится: ' + plan.added.length + skipped + '.');
      return parts.join(' ');
    }
    const removed = plan.absorbed.length ? ', удалено поглощённых: ' + plan.absorbed.length : '';
    return 'Импортировано правил: ' + plan.added.length + removed + skipped + '.';
  }

  /**
   * Экспорт: файл скачивается через blob-ссылку, сеть не используется.
   */
  function onExport() {
    const text = R.serializeRules(rules, { exportedAt: new Date().toISOString() });
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFileName(new Date());
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Отзыв ссылки — следующим тиком, чтобы скачивание успело стартовать.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    ioStatus.show('Сохранено правил: ' + rules.length + '.', [], 'info');
  }

  /**
   * Импорт разобранных правил. Разрушительный (замена набора или поглощение
   * существующих правил) сначала показывает сводку и требует подтверждения —
   * тот же инвариант, что и при ручном добавлении.
   * @param {object[]} incoming
   * @param {boolean} replace
   * @param {boolean} confirmed
   */
  function runImport(incoming, replace, confirmed) {
    const currentCount = rules.length;
    R.importRules(incoming, { replace, confirmed }).then((res) => {
      if (res.status === 'confirm') {
        ioStatus.show(
          importSummary(res, { phase: 'confirm', replace, currentCount }),
          [
            {
              label: 'Импортировать',
              danger: true,
              onClick: () => runImport(incoming, replace, true),
            },
            { label: 'Отмена', onClick: () => ioStatus.hide() },
          ],
          'info'
        );
        return;
      }
      if (res.status === 'limit') {
        ioStatus.show('Не помещается в лимит ' + R.MAX_RULES + ' правил (поместилось бы ' +
          res.fits + '). Удалите часть правил и повторите.');
        return;
      }
      if (res.status === 'error') {
        ioStatus.show(res.message || R.MSG_NOT_SAVED);
        refresh();
        return;
      }
      ioStatus.show(importSummary(res, { phase: 'done' }), [], 'info');
      refresh();
    });
  }

  /**
   * Чтение выбранного файла и запуск импорта.
   * @param {File} file
   */
  function onImportFile(file) {
    const reader = new FileReader();
    reader.onerror = () => ioStatus.show('Не удалось прочитать файл.');
    reader.onload = () => {
      const parsed = R.parseRulesExport(String(reader.result));
      if (parsed.status !== 'ok') {
        ioStatus.show(parsed.message);
        return;
      }
      if (parsed.rules.length === 0) {
        ioStatus.show('В файле нет правил.');
        return;
      }
      runImport(parsed.rules, el.replace.checked, false);
    };
    reader.readAsText(file);
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
    el.export = document.getElementById('rh-export');
    el.import = document.getElementById('rh-import');
    el.file = document.getElementById('rh-file');
    el.replace = document.getElementById('rh-replace');

    statusEl.init();
    ioStatus.init();

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

    el.export.addEventListener('click', onExport);
    // Скрытый <input type="file"> открывается кнопкой — иначе в форме
    // видна серая «Файл не выбран», которая ничего не объясняет.
    el.import.addEventListener('click', () => {
      ioStatus.hide();
      el.file.click();
    });
    el.file.addEventListener('change', () => {
      const file = el.file.files && el.file.files[0];
      // Сброс значения: повторный выбор того же файла тоже должен сработать.
      el.file.value = '';
      if (file) onImportFile(file);
    });

    loadSettings().then(applySettingsToForm);
    refresh();

    // Правила могли измениться на странице расписания — обновляем список.
    getChrome().storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if (changes.rules) refresh();
      loadSettings().then(applySettingsToForm);
    });
  }

  const O = { sortRules, matchesFilter, renderRules, exportFileName, importSummary, init };
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
