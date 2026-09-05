/**
 * Иконки интерфейса — инлайновый SVG.
 *
 * Набор и названия взяты из Phosphor (eye-slash, trash, gear, magnifying-glass,
 * plus, download-simple, upload-simple, x, broom), контуры нарисованы вручную
 * в той же манере: сетка 24, одна толщина штриха, скруглённые концы.
 * Именно нарисованы, а не взяты из пакета: расширению нельзя тянуть внешние
 * ресурсы, а тащить в сборку зависимость ради девяти иконок несоразмерно.
 *
 * Эмодзи вместо иконок не используются: они разъезжаются по платформам
 * и не наследуют цвет текста.
 */
(function (global) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Контуры на сетке 24×24. Заливки нет — только штрих (см. .rh-i в theme.css).
  const PATHS = {
    'eye-slash': ['M2.5 12S5.5 5.5 12 5.5c1.6 0 3 .4 4.2 1',
                  'M19.4 8.6c1.4 1.6 2.1 3.4 2.1 3.4S18.5 18.5 12 18.5c-1.9 0-3.5-.55-4.8-1.3',
                  'M9.9 9.9a3 3 0 0 0 4.2 4.2', 'M4 20 20 4'],
    trash: ['M4 7h16', 'M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7',
            'M6.5 7l.8 12.1a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7'],
    gear: ['M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z',
           'M19.4 12c0 .5-.05 1-.14 1.45l1.83 1.4-1.9 3.3-2.16-.86a7.5 7.5 0 0 1-2.5 1.45L14 21h-4l-.53-2.26a7.5 7.5 0 0 1-2.5-1.45l-2.16.86-1.9-3.3 1.83-1.4a7.6 7.6 0 0 1 0-2.9l-1.83-1.4 1.9-3.3 2.16.86a7.5 7.5 0 0 1 2.5-1.45L10 3h4l.53 2.26a7.5 7.5 0 0 1 2.5 1.45l2.16-.86 1.9 3.3-1.83 1.4c.09.45.14.94.14 1.45Z'],
    'magnifying-glass': ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z', 'M16 16l4.5 4.5'],
    plus: ['M12 5v14', 'M5 12h14'],
    'download-simple': ['M12 3.5v11', 'M7.5 10 12 14.5 16.5 10', 'M4 16.5v2A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-2'],
    'upload-simple': ['M12 14.5v-11', 'M7.5 8 12 3.5 16.5 8', 'M4 16.5v2A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-2'],
    x: ['M5.5 5.5l13 13', 'M18.5 5.5l-13 13'],
    broom: ['M14.5 3.5 9 9', 'M9.5 6.5 17.5 14.5', 'M12.5 11.5 6 18a4 4 0 0 1-3.5 1.2L8 13.5',
            'M17.5 14.5 21 11l-4-4-3.5 3.5'],
  };

  /**
   * SVG-иконка по имени.
   * Декоративная по умолчанию (aria-hidden): рядом с ней есть видимый текст.
   * Если иконка — единственное содержимое кнопки, доступное имя даёт сама
   * кнопка (aria-label), а не иконка.
   * @param {string} name - имя из PATHS
   * @param {{large?: boolean, className?: string}} [opts]
   * @returns {SVGElement}
   */
  function icon(name, opts = {}) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', 'rh-i' + (opts.large ? ' rh-i--lg' : '') +
      (opts.className ? ' ' + opts.className : ''));
    for (const d of PATHS[name] || []) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  }

  /**
   * Кнопка «иконка + подпись». Иконка декоративная — имя кнопке даёт текст.
   * @param {string} name - имя иконки
   * @param {string} label - видимая подпись
   * @param {{className?: string, type?: string}} [opts]
   * @returns {HTMLButtonElement}
   */
  function iconButton(name, label, opts = {}) {
    const btn = document.createElement('button');
    btn.type = opts.type || 'button';
    btn.className = 'rh-btn ' + (opts.className || '');
    btn.appendChild(icon(name));
    const span = document.createElement('span');
    span.textContent = label;
    btn.appendChild(span);
    return btn;
  }

  const I = { icon, iconButton, NAMES: Object.keys(PATHS) };

  global.RASP_HIDE_ICONS = I;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = I;
  }
})(typeof window !== 'undefined' ? window : globalThis);
