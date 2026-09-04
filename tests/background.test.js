/**
 * Юнит-тесты для background.js (service worker) на моке chrome API.
 * Запуск: node tests/background.test.js
 */
'use strict';

const assert = require('assert');

const BG = require('../background.js');

/* ---------- Мок chrome API ---------- */

// Мок storage.sync: хранилище + lastError с семантикой Chrome (снимается после коллбэка).
function makeStorage(initial = {}) {
  const store = { ...initial };
  return {
    _store: store,
    sync: {
      // Флаг живёт на sync — именно его выставляют тесты (storage.sync._failNextSet).
      _failNextSet: false,
      get(keys, cb) {
        const res = {};
        for (const k of keys) if (k in store) res[k] = store[k];
        cb(res);
      },
      set(obj, cb) {
        if (this._failNextSet) {
          // Как в Chrome: lastError виден только внутри коллбэка.
          chromeMock.runtime.lastError = new Error('QUOTA_BYTES');
          cb();
          chromeMock.runtime.lastError = null;
          return;
        }
        Object.assign(store, obj);
        cb();
      },
    },
  };
}

// Мок chrome: слушатели сохраняются, бейдж-вызовы записываются.
let chromeMock;

function makeChrome(storage) {
  const calls = { badgeText: [], badgeColor: [] };
  const listeners = { installed: [], click: [], message: [], tabUpdated: [] };
  const mock = {
    _calls: calls,
    _listeners: listeners,
    action: {
      setBadgeText: (opts) => calls.badgeText.push(opts),
      setBadgeBackgroundColor: (opts) => calls.badgeColor.push(opts),
      onClicked: { addListener: (fn) => listeners.click.push(fn) },
    },
    storage,
    runtime: {
      lastError: null,
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
    },
    tabs: {
      onUpdated: { addListener: (fn) => listeners.tabUpdated.push(fn) },
    },
  };
  return mock;
}

// Мок с запуском init() — как в браузере.
function setup(initialStorage) {
  const storage = makeStorage(initialStorage);
  chromeMock = makeChrome(storage);
  BG.createBackground(chromeMock).init();
  return { chromeMock, storage };
}

/* ---------- Тесты ---------- */

// Текст бейджа для счётчика: в т.ч. зелёный «0».
assert.strictEqual(BG.badgeTextForCount(0), '0');
assert.strictEqual(BG.badgeTextForCount(7), '7');
assert.strictEqual(BG.badgeTextForCount(100), '100');

// {type:'count'} — зелёная цифра для вкладки-отправителя.
{
  const { chromeMock } = setup();
  chromeMock._listeners.message[0]({ type: 'count', value: 3 }, { tab: { id: 42 } });
  assert.deepStrictEqual(chromeMock._calls.badgeText, [{ tabId: 42, text: '3' }]);
  assert.strictEqual(chromeMock._calls.badgeColor.length, 1);
  assert.strictEqual(chromeMock._calls.badgeColor[0].tabId, 42);
  assert.strictEqual(chromeMock._calls.badgeColor[0].color, '#16a34a');
}

// {type:'count', value:0} — зелёный «0», не пусто и не OFF.
{
  const { chromeMock } = setup();
  chromeMock._listeners.message[0]({ type: 'count', value: 0 }, { tab: { id: 1 } });
  assert.deepStrictEqual(chromeMock._calls.badgeText, [{ tabId: 1, text: '0' }]);
}

// {type:'off'} — серый «OFF»; текст «ON» не используется.
{
  const { chromeMock } = setup();
  chromeMock._listeners.message[0]({ type: 'off' }, { tab: { id: 5 } });
  assert.deepStrictEqual(chromeMock._calls.badgeText, [{ tabId: 5, text: 'OFF' }]);
  assert.strictEqual(chromeMock._calls.badgeColor[0].color, '#6b7280');
}

// Сообщение без tab.id (например, из options) — бейдж не трогается.
{
  const { chromeMock } = setup();
  chromeMock._listeners.message[0]({ type: 'count', value: 3 }, {});
  chromeMock._listeners.message[0](null, { tab: { id: 1 } });
  chromeMock._listeners.message[0]({ type: 'unknown' }, { tab: { id: 1 } });
  assert.strictEqual(chromeMock._calls.badgeText.length, 0);
}

// Бейдж per-tab: сообщения из разных вкладок не смешиваются.
{
  const { chromeMock } = setup();
  const onMessage = chromeMock._listeners.message[0];
  onMessage({ type: 'count', value: 1 }, { tab: { id: 10 } });
  onMessage({ type: 'off' }, { tab: { id: 20 } });
  assert.deepStrictEqual(chromeMock._calls.badgeText, [
    { tabId: 10, text: '1' },
    { tabId: 20, text: 'OFF' },
  ]);
}

// Клик по иконке: enabled:true → false.
{
  const { chromeMock, storage } = setup({ enabled: true, style: 'placeholder', rules: [] });
  chromeMock._listeners.click[0]();
  assert.strictEqual(storage._store.enabled, false);
}

// Клик по иконке: enabled:false → true.
{
  const { chromeMock, storage } = setup({ enabled: false });
  chromeMock._listeners.click[0]();
  assert.strictEqual(storage._store.enabled, true);
}

// Клик по иконке: ключа нет (дефолт true) → false.
{
  const { chromeMock, storage } = setup({});
  chromeMock._listeners.click[0]();
  assert.strictEqual(storage._store.enabled, false);
}

// onInstalled: пустое хранилище → все дефолты (enabled:true, placeholder, rules:[]).
{
  const { chromeMock, storage } = setup({});
  chromeMock._listeners.installed[0]();
  assert.deepStrictEqual(storage._store, {
    enabled: true,
    style: 'placeholder',
    rules: [],
  });
}

// onInstalled: существующие настройки не перезаписываются.
{
  const existingRules = [{ subject: 'Физика', teacher: null, enabled: true }];
  const { chromeMock, storage } = setup({
    enabled: false,
    style: 'strike',
    rules: existingRules,
  });
  chromeMock._listeners.installed[0]();
  assert.strictEqual(storage._store.enabled, false);
  assert.strictEqual(storage._store.style, 'strike');
  assert.strictEqual(storage._store.rules, existingRules);
}

// onInstalled: частичное хранилище → только отсутствующие ключи.
{
  const { chromeMock, storage } = setup({ enabled: false });
  chromeMock._listeners.installed[0]();
  assert.strictEqual(storage._store.enabled, false); // не тронут
  assert.strictEqual(storage._store.style, 'placeholder'); // добавлен
  assert.deepStrictEqual(storage._store.rules, []); // добавлен
}

// tabs.onUpdated: начало навигации → бейдж вкладки очищается.
{
  const { chromeMock } = setup();
  chromeMock._listeners.tabUpdated[0](7, { status: 'loading' });
  assert.deepStrictEqual(chromeMock._calls.badgeText, [{ tabId: 7, text: '' }]);
  assert.strictEqual(chromeMock._calls.badgeColor.length, 0); // цвет не нужен для очистки
}

// tabs.onUpdated: прочие события ('complete' и т.п.) — бейдж не трогается.
{
  const { chromeMock } = setup();
  chromeMock._listeners.tabUpdated[0](7, { status: 'complete' });
  chromeMock._listeners.tabUpdated[0](7, {});
  assert.strictEqual(chromeMock._calls.badgeText.length, 0);
}

// Ошибка записи (lastError) при клике — состояние не меняется, исключений нет.
{
  const storage = makeStorage({ enabled: true });
  chromeMock = makeChrome(storage);
  const bg = BG.createBackground(chromeMock);
  storage.sync._failNextSet = true;
  bg.handleActionClick();
  assert.strictEqual(storage._store.enabled, true); // запись не удалась — не изменилось
}

// init() регистрирует все четыре слушателя.
{
  setup();
  assert.strictEqual(chromeMock._listeners.installed.length, 1);
  assert.strictEqual(chromeMock._listeners.click.length, 1);
  assert.strictEqual(chromeMock._listeners.message.length, 1);
  assert.strictEqual(chromeMock._listeners.tabUpdated.length, 1);
}

console.log('tests/background.test.js: все проверки пройдены');
