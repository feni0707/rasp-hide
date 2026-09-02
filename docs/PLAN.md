# Rasp Hide — план разработки

> Статус: согласовано. Реализация v1.0 по docs/REQUIREMENTS.md и docs/ARCHITECTURE.md.

## 0. Git-процесс

- Ветки: `main` (только релизы), `dev` (интеграция); фича-ветки от `dev` на каждую фазу.
- Влитие фичи в `dev` — merge `--no-ff`; при релизе — `dev → main` + тег `v1.0.0`.
- Коммиты: русские, префиксы `feat:`, `fix:`, `docs:`, `chore:`.
- `.gitignore`: `.DS_Store`, `node_modules/`, `*.log`, `.idea/`, `.vscode/`, `Thumbs.db`.
- Публичный репозиторий GitHub `rasp-hide` — по договорённости (remote/настройки — отдельно, перед CI).

## 1. Фазы

Каждая фаза — фича-ветка от `dev`; сливается после зелёных тестов и (где указано) ручной проверки.

1. **Каркас** — `git init`, `.gitignore`, `manifest.json` (MV3, `permissions: ["storage"]`, без `host_permissions`), структура папок, иконки (копия из `~/OpenCodeProjects/schedule/icons`, позже заменю на новые), `package.json` с `scripts.test` → `node tests/matcher.test.js`. Ветка `main` + `dev`.
2. **`content/matcher.js` + `tests/matcher.test.js`** — разбиение на пары, normalize, имя/преподаватель пары, matchRule, isCellFullyHidden. Тесты: кейсы ARCHITECTURE §6 + hr-кейсы.
3. **`lib/rules.js` + тесты** — CRUD + инварианты (дубликаты, поглощение, «уже покрыто», лимит 100) на `chrome.storage.sync`-моке; `wouldAbsorb`; обработка `lastError` («Не удалось сохранить»).
4. **Content script: применение** (`content/content.js` + `content/ui.js`) — прогон по `#raspisanie-table td.cell`, скрытие пары → плейсхолдер «скрыто» (или strike), **`<hr>` пары скрывается/восстанавливается вместе с парой только в placeholder-режиме** (фикс бага старой версии со «старой полосой»; в strike-режиме `<hr>` не трогается — разделитель преподавателей одной пары остаётся), фон клетки (transparent при полном скрытии, только placeholder), WeakMap-кэш исходных стилей, MutationObserver (debounce ~120 мс), `storage.onChanged`, счётчик → sendMessage. Ручная проверка №1.
5. **Hover-UI** (`content/ui.js`) — кнопка «Скрыть», мини-меню (3 пункта / 1 пункт), подтверждение поглощения, плейсхолдер + «Вернуть», закрытие по клику вне и Escape. Ручная проверка №2.
6. **Background** (`background.js`) — тумблер по `chrome.action.onClicked`, per-tab бейдж (зелёная цифра-счётчик, серый «OFF», без «ON»), очистка по `tabs.onUpdated`, `onInstalled`-дефолты (`enabled: true`, `style: 'placeholder'`, `rules: []`).
7. **Options** (`options/`) — тумблер, radio стиля, список правил (сортировка, поиск-фильтр, «N/100», лимит 100), добавление вручную, подтверждения, «сброс к дефолту» (только rules), обработка ошибок записи.
8. **Релиз-пакет** — README, LICENSE (MIT), CI (GitHub Actions: push/PR в `dev` и `main` → Node 22 → `npm test`), прогон по docs/STORE_CHECKLIST.md, тег `v1.0.0`.

## 2. Проверка

- Юнит-тесты: `node tests/matcher.test.js` (+ тесты rules на моке chrome) — после фаз 2 и 3, далее каждый merge.
- Ручные проверки на реальных страницах ro-rasp.tpu.ru: после фаз 4 и 5 (инструкция пользователю: установка распакованного расширения + конкретные сценарии).
- Финальный прогон по STORE_CHECKLIST.md — фаза 8.

## 3. Замечания согласования

- Название пары для матчинга — только видимый `span.textContent` (fallback на `title` НЕ используется).
- `<hr>` пары скрывается/восстанавливается вместе с парой только в режиме «плейсхолдер» (фикс «старой полосы»); в режиме «зачеркнуть» `<hr>` не трогается — разделитель преподавателей одной пары (`ПР Т1 <hr> Т2`) остаётся на месте.
- Комментарии в коде — короткие, русские (JSDoc на публичных функциях).
- Тесты пишутся с нуля (референс `test_lib.js` на диске не найден).