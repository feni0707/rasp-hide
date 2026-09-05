/**
 * Блок статуса: сообщение + кнопки действий + подтверждение.
 * Общий для popup и options — раньше жил внутри options.js и был недоступен
 * второй странице.
 *
 * Подтверждение показывается здесь же, а не через window.confirm: системный
 * диалог в popup выглядит чужеродно, а на части платформ его открытие
 * закрывает сам popup. Инлайновое подтверждение к тому же оставляет видимым
 * то, что подтверждают.
 */
(function (global) {
  'use strict';

  /**
   * @param {string} rootId - id контейнера статуса
   * @param {string} textId - id элемента с текстом
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
        // Фокус не переносим: скринридер объявит сообщение через aria-live,
        // а увод фокуса посреди работы со списком сбивает навигацию.
      },

      /**
       * Подтверждение разрушительного действия.
       * @param {string} text - что именно произойдёт
       * @param {Function} onConfirm
       * @param {{label?: string}} [opts] - label: подпись подтверждающей кнопки
       */
      confirm(text, onConfirm, opts = {}) {
        st.show(text, [
          {
            label: opts.label || 'Удалить',
            danger: true,
            onClick: () => { st.hide(); onConfirm(); },
          },
          { label: 'Отмена', onClick: () => st.hide() },
        ], 'info');
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

  const S = { createStatus };

  global.RASP_HIDE_STATUS = S;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = S;
  }
})(typeof window !== 'undefined' ? window : globalThis);
