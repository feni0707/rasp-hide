/**
 * Полная страница настроек: тумблер, вид скрытой пары, список правил
 * (поиск, счётчик, добавление вручную, сброс), подсказки, экспорт/импорт.
 *
 * Часть этого есть и в popup — там то, что нужно часто. Общее не дублируется:
 * список правил и операции над ним берутся из ui/rules-list.js, блок статуса —
 * из ui/status.js, оформление — из ui/theme.css. Здесь остаётся только то,
 * что живёт исключительно на полной странице: перенос правил, сброс и очистка
 * подсказок.
 *
 * Все изменения правил — через lib/rules.js: инварианты набора одинаковы
 * и для страницы, и для popup, и для меню на самом расписании.
 */
(function (global) {
  'use strict';

  const R = global.RASP_HIDE_RULES;
  const S = global.RASP_HIDE_SUGGESTIONS;
  const LIST = global.RASP_HIDE_RULES_LIST;
  const STATUS = global.RASP_HIDE_STATUS;

  let rules = [];   // текущий набор правил (последнее известное состояние)
  let filter = '';  // поисковый фильтр

  const el = {};
  const status = STATUS.createStatus('rh-status', 'rh-status-text');
  const ioStatus = STATUS.createStatus('rh-io-status', 'rh-io-status-text');

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
   * @returns {Promise<boolean>} false — при ошибке записи
   */
  function saveSetting(key, value) {
    return new Promise((resolve) => {
      const patch = {};
      patch[key] = value;
      getChrome().storage.sync.set(patch, () => {
        // lastError только читаем — снимает его рантайм (см. lib/rules.js).
        const c = getChrome();
        resolve(!(c.runtime && c.runtime.lastError));
      });
    });
  }

  /* ---------- Список правил ---------- */

  /** Отрисовка списка, счётчика и состояния формы добавления. */
  function renderRules() {
    el.count.textContent = rules.length + '/' + R.MAX_RULES;
    const limitReached = rules.length >= R.MAX_RULES;
    el.limitNote.hidden = !limitReached;
    el.addButton.disabled = limitReached;
    el.subjectInput.disabled = limitReached;
    el.teacherInput.disabled = limitReached;
    el.typeSelect.disabled = limitReached;
    LIST.renderList(el.rulesBox, rules, filter, {
      onToggle: actions.toggle,
      onDelete: actions.remove,
    });
  }

  /** Перезагрузка набора правил из хранилища и перерисовка. */
  function refresh() {
    return R.loadRules().then((loaded) => {
      rules = loaded;
      renderRules();
    });
  }

  const actions = LIST.createActions({ status, onRefresh: refresh });

  /** Сброс правил — с подтверждением; тумблер и вид не трогаются. */
  function onReset() {
    if (rules.length === 0) {
      status.show('Правил и так нет.', [], 'info');
      return;
    }
    status.confirm(
      'Удалить все правила (' + rules.length + ')? Тумблер и вид скрытой пары останутся как есть.',
      () => R.resetRules().then((res) => {
        if (res.status === 'error') status.show(res.message || R.MSG_NOT_SAVED);
        else status.hide();
        refresh();
      })
    );
  }

  /* ---------- Подсказки для ручного ввода ---------- */

  /**
   * Заполнение <datalist> значениями.
   * @param {HTMLDataListElement} list
   * @param {string[]} values
   */
  function fillDatalist(list, values) {
    list.textContent = '';
    for (const value of values) {
      const option = document.createElement('option');
      option.value = value;
      list.appendChild(option);
    }
  }

  /**
   * Перечитывание подсказок из chrome.storage.local и перерисовка списков.
   * @returns {Promise<void>}
   */
  function refreshSuggestions() {
    return S.loadSuggestions().then((data) => {
      fillDatalist(el.subjectList, data.subjects);
      fillDatalist(el.teacherList, data.teachers);
      el.sugClear.disabled = data.subjects.length + data.teachers.length === 0;
    });
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

  /** Экспорт: файл формируется через blob-ссылку, сеть не используется. */
  function onExport() {
    if (rules.length === 0) {
      ioStatus.show('Нечего выгружать: список правил пуст.', [], 'info');
      return;
    }
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
   * существующих правил) сначала показывает сводку и требует подтверждения.
   * @param {object[]} incoming
   * @param {boolean} replace
   * @param {boolean} confirmed
   */
  function runImport(incoming, replace, confirmed) {
    const currentCount = rules.length;
    R.importRules(incoming, { replace, confirmed }).then((res) => {
      if (res.status === 'confirm') {
        ioStatus.confirm(
          importSummary(res, { phase: 'confirm', replace, currentCount }),
          () => runImport(incoming, replace, true),
          { label: 'Импортировать' }
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

  /* ---------- Инициализация ---------- */

  /**
   * Применение настроек к элементам формы (при загрузке и по onChanged).
   * @param {{enabled: boolean, style: string}} settings
   */
  function applySettingsToForm(settings) {
    el.enabled.checked = settings.enabled;
    for (const radio of el.styleRadios) radio.checked = radio.value === settings.style;
  }

  /** Инициализация страницы. В тестах (Node) не вызывается. */
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
    el.typeSelect = document.getElementById('rh-type');
    el.addButton = document.getElementById('rh-add-btn');
    el.reset = document.getElementById('rh-reset');
    el.export = document.getElementById('rh-export');
    el.import = document.getElementById('rh-import');
    el.file = document.getElementById('rh-file');
    el.replace = document.getElementById('rh-replace');
    el.subjectList = document.getElementById('rh-subjects');
    el.teacherList = document.getElementById('rh-teachers');
    el.sugClear = document.getElementById('rh-sug-clear');

    status.init();
    ioStatus.init();
    LIST.fillTypeSelect(el.typeSelect);

    el.enabled.addEventListener('change', () => {
      saveSetting('enabled', el.enabled.checked).then((ok) => {
        if (ok) return;
        status.show(R.MSG_NOT_SAVED);
        loadSettings().then(applySettingsToForm); // откат формы к фактическому значению
      });
    });

    for (const radio of el.styleRadios) {
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        saveSetting('style', radio.value).then((ok) => {
          if (ok) return;
          status.show(R.MSG_NOT_SAVED);
          loadSettings().then(applySettingsToForm);
        });
      });
    }

    el.search.addEventListener('input', () => {
      filter = R.normalize(el.search.value).toLowerCase();
      renderRules();
    });

    el.addForm.addEventListener('submit', (e) => {
      e.preventDefault();
      actions.add(el.subjectInput.value, el.teacherInput.value, el.typeSelect.value, () => {
        el.subjectInput.value = '';
        el.teacherInput.value = '';
        el.typeSelect.value = '';
        el.subjectInput.focus();
      });
    });

    el.reset.addEventListener('click', onReset);
    el.sugClear.addEventListener('click', () => {
      S.clearSuggestions().then(refreshSuggestions);
    });

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
    refreshSuggestions();

    getChrome().storage.onChanged.addListener((changes, area) => {
      // Подсказки копит content script в local — расписание могли открыть
      // уже после того, как настройки были открыты.
      if (area === 'local') {
        if (changes[S.SUGGESTIONS_KEY]) refreshSuggestions();
        return;
      }
      // Правила и тумблер могли измениться на странице расписания или в popup.
      if (area !== 'sync') return;
      if (R.hasRulesChange(changes)) refresh();
      if (changes.enabled || changes.style) loadSettings().then(applySettingsToForm);
    });
  }

  const O = { exportFileName, importSummary, renderRules, init };
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
