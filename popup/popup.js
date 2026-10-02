/**
 * Popup по клику на иконку — основная поверхность расширения:
 * тумблер, состояние текущей вкладки, список правил с поиском, добавление
 * вручную, вид скрытой пары. Редкое (импорт/экспорт, сброс, подсказки)
 * осталось на полной странице настроек — кнопка в подвале.
 *
 * Список правил и операции над ним — общие с options (ui/rules-list.js):
 * инварианты набора обязаны быть одинаковыми на обеих поверхностях.
 *
 * Счётчик скрытого на вкладке берётся из бейджа (chrome.action.getBadgeText),
 * а не отдельным запросом в content script: бейдж уже содержит ровно это
 * число, и читать его можно без права tabs.
 */
(function (global) {
  'use strict';

  const R = global.RASP_HIDE_RULES;
  const S = global.RASP_HIDE_SUGGESTIONS;
  const LIST = global.RASP_HIDE_RULES_LIST;
  const STATUS = global.RASP_HIDE_STATUS;

  // Поиск появляется, только когда список перестаёт охватываться взглядом.
  const SEARCH_FROM = 6;

  const el = {};
  let rules = [];
  let filter = '';
  const status = STATUS.createStatus('rh-status', 'rh-status-text');

  /**
   * Доступ к chrome API (для подмены моками в тестах).
   * @returns {object}
   */
  function getChrome() {
    return typeof chrome !== 'undefined' ? chrome : global.chrome;
  }

  /**
   * Загрузка глобальных настроек.
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
   * Запись глобальной настройки.
   * @param {string} key
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

  /**
   * Текст бейджа активной вкладки — им content script уже сообщил счётчик.
   * @returns {Promise<string|null>} null, если вкладку или бейдж не прочитать
   */
  function readActiveBadge() {
    return new Promise((resolve) => {
      const c = getChrome();
      if (!c.tabs || !c.action) { resolve(null); return; }
      c.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs && tabs[0] && tabs[0].id;
        if (typeof tabId !== 'number') { resolve(null); return; }
        c.action.getBadgeText({ tabId }, (text) => {
          if (c.runtime && c.runtime.lastError) { resolve(null); return; }
          resolve(typeof text === 'string' ? text : null);
        });
      });
    });
  }

  /**
   * Фраза о состоянии текущей вкладки (чистая функция).
   * Собирается целиком, а не по кускам: скринридер должен получить
   * законченное предложение, а не «3».
   * @param {boolean} enabled - глобальный тумблер
   * @param {string|null} badge - текст бейджа вкладки
   * @returns {string}
   */
  function pageStateText(enabled, badge) {
    if (!enabled) return 'Скрытие выключено — на страницах ничего не скрывается.';
    if (badge == null || badge === '') {
      return 'Откройте расписание на ro-rasp.tpu.ru, чтобы увидеть счётчик.';
    }
    if (badge === 'OFF') return 'Скрытие выключено — на страницах ничего не скрывается.';
    const count = Number(badge);
    if (!Number.isFinite(count)) return 'Счётчик недоступен для этой вкладки.';
    if (count === 0) return 'На этой странице ничего не скрыто.';
    return 'Скрыто пар на этой странице: ' + count + '.';
  }

  /** Обновление строки состояния вкладки. */
  function refreshPageState() {
    return Promise.all([loadSettings(), readActiveBadge()]).then(([settings, badge]) => {
      el.pageState.textContent = pageStateText(settings.enabled, badge);
    });
  }

  /** Перерисовка списка правил, счётчика и доступности поиска. */
  function renderRules() {
    el.count.textContent = rules.length + '/' + R.MAX_RULES;
    // Поиск в коротком списке — лишний элемент управления.
    el.searchBox.hidden = rules.length < SEARCH_FROM;
    if (el.searchBox.hidden && filter) {
      filter = '';
      el.search.value = '';
    }
    const limitReached = rules.length >= R.MAX_RULES;
    el.addOpen.disabled = limitReached;
    el.addOpen.title = limitReached
      ? 'Достигнут лимит ' + R.MAX_RULES + ' правил'
      : '';
    LIST.renderList(el.rulesBox, rules, filter, {
      onToggle: actions.toggle,
      onDelete: actions.remove,
    });
  }

  /** Перечитывание набора правил из хранилища и перерисовка. */
  function refresh() {
    return R.loadRules().then((loaded) => {
      rules = loaded;
      renderRules();
    });
  }

  const actions = LIST.createActions({ status, onRefresh: refresh });

  /** Заполнение подсказок для ручного ввода. */
  function refreshSuggestions() {
    return S.loadSuggestions().then((data) => {
      fillDatalist(el.subjectList, data.subjects);
      fillDatalist(el.teacherList, data.teachers);
    });
  }

  /**
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
   * Раскрытие/сворачивание формы добавления (прогрессивное раскрытие:
   * основной путь добавления — кнопка «Скрыть» на самой странице расписания).
   * @param {boolean} open
   */
  function toggleAddForm(open) {
    el.addForm.hidden = !open;
    el.addOpen.hidden = open;
    el.addOpen.setAttribute('aria-expanded', String(open));
    if (open) el.subjectInput.focus();
    else el.addOpen.focus();
  }

  /** Применение настроек к элементам управления. */
  function applySettings(settings) {
    el.enabled.checked = settings.enabled;
    for (const radio of el.styleRadios) radio.checked = radio.value === settings.style;
  }

  /** Инициализация страницы. */
  function init() {
    el.enabled = document.getElementById('rh-enabled');
    el.pageState = document.getElementById('rh-page-state');
    el.count = document.getElementById('rh-count');
    el.searchBox = document.getElementById('rh-search-box');
    el.search = document.getElementById('rh-search');
    el.rulesBox = document.getElementById('rh-rules');
    el.addOpen = document.getElementById('rh-add-open');
    el.addForm = document.getElementById('rh-add');
    el.addCancel = document.getElementById('rh-add-cancel');
    el.subjectInput = document.getElementById('rh-subject');
    el.teacherInput = document.getElementById('rh-teacher');
    el.subjectList = document.getElementById('rh-subjects');
    el.teacherList = document.getElementById('rh-teachers');
    el.options = document.getElementById('rh-options');
    el.styleRadios = Array.prototype.slice.call(
      document.querySelectorAll('input[name="rh-style"]')
    );

    status.init();
    el.addOpen.setAttribute('aria-expanded', 'false');

    el.enabled.addEventListener('change', () => {
      saveSetting('enabled', el.enabled.checked).then((ok) => {
        if (!ok) {
          status.show(R.MSG_NOT_SAVED);
          loadSettings().then(applySettings);
          return;
        }
        refreshPageState();
      });
    });

    for (const radio of el.styleRadios) {
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        saveSetting('style', radio.value).then((ok) => {
          if (ok) return;
          status.show(R.MSG_NOT_SAVED);
          loadSettings().then(applySettings);
        });
      });
    }

    el.search.addEventListener('input', () => {
      filter = R.normalize(el.search.value).toLowerCase();
      renderRules();
    });

    el.addOpen.addEventListener('click', () => toggleAddForm(true));
    el.addCancel.addEventListener('click', () => {
      status.hide();
      toggleAddForm(false);
    });
    el.addForm.addEventListener('submit', (e) => {
      e.preventDefault();
      actions.add(el.subjectInput.value, el.teacherInput.value, () => {
        el.subjectInput.value = '';
        el.teacherInput.value = '';
        toggleAddForm(false);
      });
    });

    // Escape закрывает форму, а не окно: у раскрытой формы должен быть
    // предсказуемый путь назад.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || el.addForm.hidden) return;
      e.preventDefault();
      status.hide();
      toggleAddForm(false);
    });

    el.options.addEventListener('click', () => {
      getChrome().runtime.openOptionsPage();
    });

    loadSettings().then(applySettings);
    refresh();
    refreshSuggestions();
    refreshPageState();

    getChrome().storage.onChanged.addListener((changes, area) => {
      if (area === 'local') {
        if (changes[S.SUGGESTIONS_KEY]) refreshSuggestions();
        return;
      }
      if (area !== 'sync') return;
      if (changes.rules) refresh();
      if (changes.enabled || changes.style) {
        loadSettings().then(applySettings);
        refreshPageState();
      }
    });
  }

  const P = { pageStateText, SEARCH_FROM, init };
  global.RASP_HIDE_POPUP = P;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = P;
  }

  if (typeof document === 'undefined' || typeof chrome === 'undefined') return;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
