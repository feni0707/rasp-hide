/**
 * Фоновый скрипт: в Chrome, Edge и Opera — service worker, в Firefox — фоновая
 * страница событий (тот же файл в background.scripts; REQUIREMENTS §11.11).
 * Per-tab бейдж (зелёная цифра-счётчик, в т.ч. «0»;
 * серый «OFF» при выключении), очистка бейджа вкладки при навигации,
 * дефолтные настройки при установке, тумблер по горячей клавише.
 * Текст «ON» не используется — цвет и цифра его заменяют.
 * Права «tabs» не нужны: setBadgeText({tabId}) и tabs.onUpdated работают без него.
 *
 * Клик по иконке открывает popup, поэтому chrome.action.onClicked больше
 * не срабатывает: тумблер переехал в popup, а одним движением он доступен
 * по горячей клавише (команда toggle-hiding, по умолчанию Alt+Shift+H —
 * пользователь может переназначить её на chrome://extensions/shortcuts,
 * в Firefox — about:addons → «Управление горячими клавишами»).
 * Команды не требуют разрешения в permissions: это ключ манифеста.
 */
(function (global) {
  'use strict';

  // Дефолтные настройки (onInstalled — только отсутствующие ключи).
  const DEFAULTS = { enabled: true, style: 'placeholder', rules: [] };

  // Цвета бейджа: зелёный — включено, серый — выключено.
  const BADGE_COLOR_ON = '#16a34a';
  const BADGE_COLOR_OFF = '#6b7280';

  const OFF_BADGE_TEXT = 'OFF';

  /**
   * Текст бейджа для счётчика скрытых пар (в т.ч. «0»).
   * @param {number} value
   * @returns {string}
   */
  function badgeTextForCount(value) {
    return String(value);
  }

  /**
   * Фабрика обработчиков поверх chrome-like API (в тестах — мок).
   * @param {object} api - chrome-подобный объект (action, storage, runtime, tabs)
   * @returns {{init: Function, handleMessage: Function, handleTabUpdated: Function,
   *            handleActionClick: Function, initDefaults: Function}}
   */
  function createBackground(api) {
    /**
     * Установка per-tab бейджа: текст + цвет для конкретной вкладки.
     * @param {number} tabId
     * @param {string} text
     * @param {string} color
     */
    function setBadge(tabId, text, color) {
      api.action.setBadgeText({ tabId, text });
      api.action.setBadgeBackgroundColor({ tabId, color });
    }

    /**
     * Сообщение content script: {type:'count', value} — зелёная цифра,
     * {type:'off'} — серый «OFF». Бейдж ставится только для вкладки-отправителя.
     * @param {{type?: string, value?: number}} message
     * @param {{tab?: {id?: number}}} sender
     * @returns {boolean} false — ответ через sendResponse не нужен
     */
    function handleMessage(message, sender) {
      if (!message || typeof message !== 'object') return false;
      const tabId = sender && sender.tab && sender.tab.id;
      if (typeof tabId !== 'number') return false;
      if (message.type === 'count') {
        setBadge(tabId, badgeTextForCount(message.value), BADGE_COLOR_ON);
      } else if (message.type === 'off') {
        setBadge(tabId, OFF_BADGE_TEXT, BADGE_COLOR_OFF);
      }
      return false;
    }

    /**
     * Начало навигации в вкладке — бейдж очищается; если это снова расписание,
     * content script выставит счётчик заново.
     * @param {number} tabId
     * @param {{status?: string}} changeInfo
     */
    function handleTabUpdated(tabId, changeInfo) {
      if (changeInfo && changeInfo.status === 'loading') {
        api.action.setBadgeText({ tabId, text: '' });
      }
    }

    /**
     * Инверсия тумблера enabled в storage.sync (горячая клавиша).
     * Дальше вкладки сами применяют/откатывают изменения и чинят свой бейдж.
     */
    function toggleEnabled() {
      api.storage.sync.get(['enabled'], (res) => {
        if (api.runtime.lastError) return; // хранилище недоступно — инвертировать нечего
        const enabled = !!res && res.enabled !== false;
        api.storage.sync.set({ enabled: !enabled }, () => {
          if (api.runtime.lastError) { /* запись не удалась — состояние не меняем */ }
        });
      });
    }

    /**
     * Дефолтные настройки при установке/обновлении: записываются только
     * отсутствующие ключи (enabled, style, rules), существующие не трогаются.
     */
    function initDefaults() {
      api.storage.sync.get(Object.keys(DEFAULTS), (res) => {
        if (api.runtime.lastError) return;
        const toSet = {};
        for (const key of Object.keys(DEFAULTS)) {
          if (!res || res[key] === undefined) toSet[key] = DEFAULTS[key];
        }
        if (Object.keys(toSet).length === 0) return;
        api.storage.sync.set(toSet, () => {
          if (api.runtime.lastError) { /* не удалось записать дефолты */ }
        });
      });
    }

    /**
     * Горячая клавиша: единственная команда расширения — тумблер.
     * @param {string} command
     */
    function handleCommand(command) {
      if (command === 'toggle-hiding') toggleEnabled();
    }

    /**
     * Регистрация слушателей (один раз при старте SW).
     * onClicked не подписываем: у действия есть popup, и клик уходит ему.
     */
    function init() {
      api.runtime.onInstalled.addListener(initDefaults);
      api.runtime.onMessage.addListener(handleMessage);
      api.tabs.onUpdated.addListener(handleTabUpdated);
      if (api.commands && api.commands.onCommand) {
        api.commands.onCommand.addListener(handleCommand);
      }
    }

    return { init, handleMessage, handleTabUpdated, handleCommand, toggleEnabled, initDefaults };
  }

  // Экспорт для тестов (Node); в SW — инициализация на реальном chrome.
  global.RASP_HIDE_BG = { createBackground, badgeTextForCount, OFF_BADGE_TEXT };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.RASP_HIDE_BG;
  }
  if (typeof chrome !== 'undefined' && chrome.action && chrome.runtime) {
    createBackground(chrome).init();
  }
})(typeof self !== 'undefined' ? self : globalThis);
