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
  const listeners = { installed: [], command: [], message: [], tabUpdated: [] };
  const mock = {
    _calls: calls,
    _listeners: listeners,
    action: {
      setBadgeText: (opts) => calls.badgeText.push(opts),
      setBadgeBackgroundColor: (opts) => calls.badgeColor.push(opts),
      // onClicked не подписывается: у действия есть popup, клик уходит ему.
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
    commands: {
      onCommand: { addListener: (fn) => listeners.command.push(fn) },
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

// Реестр именованных тестов — как в matcher/rules/content: провал называет
// сценарий и не обрывает остальные проверки, npm test печатает счётчик.
const TESTS = [];
function t(name, fn) {
  TESTS.push([name, fn]);
}

/* ---------- Тесты ---------- */

t('badgeTextForCount: число текстом, в т.ч. зелёный «0»', () => {
  assert.strictEqual(BG.badgeTextForCount(0), '0');
  assert.strictEqual(BG.badgeTextForCount(7), '7');
  assert.strictEqual(BG.badgeTextForCount(100), '100');
});

t('{type:\'count\'} — зелёная цифра для вкладки-отправителя', () => {
  const { chromeMock } = setup();
  chromeMock._listeners.message[0]({ type: 'count', value: 3 }, { tab: { id: 42 } });
  assert.deepStrictEqual(chromeMock._calls.badgeText, [{ tabId: 42, text: '3' }]);
  assert.strictEqual(chromeMock._calls.badgeColor.length, 1);
  assert.strictEqual(chromeMock._calls.badgeColor[0].tabId, 42);
  assert.strictEqual(chromeMock._calls.badgeColor[0].color, '#16a34a');
});

t('{type:\'count\', value:0} — зелёный «0», не пусто и не OFF', () => {
  const { chromeMock } = setup();
  chromeMock._listeners.message[0]({ type: 'count', value: 0 }, { tab: { id: 1 } });
  assert.deepStrictEqual(chromeMock._calls.badgeText, [{ tabId: 1, text: '0' }]);
});

t('{type:\'off\'} — серый «OFF»; текст «ON» не используется', () => {
  const { chromeMock } = setup();
  chromeMock._listeners.message[0]({ type: 'off' }, { tab: { id: 5 } });
  assert.deepStrictEqual(chromeMock._calls.badgeText, [{ tabId: 5, text: 'OFF' }]);
  assert.strictEqual(chromeMock._calls.badgeColor[0].color, '#6b7280');
});

t('Сообщение без tab.id (например, из options) — бейдж не трогается', () => {
  const { chromeMock } = setup();
  chromeMock._listeners.message[0]({ type: 'count', value: 3 }, {});
  chromeMock._listeners.message[0](null, { tab: { id: 1 } });
  chromeMock._listeners.message[0]({ type: 'unknown' }, { tab: { id: 1 } });
  assert.strictEqual(chromeMock._calls.badgeText.length, 0);
});

t('Бейдж per-tab: сообщения из разных вкладок не смешиваются', () => {
  const { chromeMock } = setup();
  const onMessage = chromeMock._listeners.message[0];
  onMessage({ type: 'count', value: 1 }, { tab: { id: 10 } });
  onMessage({ type: 'off' }, { tab: { id: 20 } });
  assert.deepStrictEqual(chromeMock._calls.badgeText, [
    { tabId: 10, text: '1' },
    { tabId: 20, text: 'OFF' },
  ]);
});

t('Горячая клавиша: enabled:true → false', () => {
  const { chromeMock, storage } = setup({ enabled: true, style: 'placeholder', rules: [] });
  chromeMock._listeners.command[0]('toggle-hiding');
  assert.strictEqual(storage._store.enabled, false);
});

t('Горячая клавиша: enabled:false → true', () => {
  const { chromeMock, storage } = setup({ enabled: false });
  chromeMock._listeners.command[0]('toggle-hiding');
  assert.strictEqual(storage._store.enabled, true);
});

t('Горячая клавиша: ключа нет (дефолт true) → false', () => {
  const { chromeMock, storage } = setup({});
  chromeMock._listeners.command[0]('toggle-hiding');
  assert.strictEqual(storage._store.enabled, false);
});

t('onInstalled: пустое хранилище → все дефолты (enabled:true, placeholder, rules:[])', () => {
  const { chromeMock, storage } = setup({});
  chromeMock._listeners.installed[0]();
  assert.deepStrictEqual(storage._store, {
    enabled: true,
    style: 'placeholder',
    rules: [],
  });
});

t('onInstalled: существующие настройки не перезаписываются', () => {
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
});

t('onInstalled: частичное хранилище → только отсутствующие ключи', () => {
  const { chromeMock, storage } = setup({ enabled: false });
  chromeMock._listeners.installed[0]();
  assert.strictEqual(storage._store.enabled, false); // не тронут
  assert.strictEqual(storage._store.style, 'placeholder'); // добавлен
  assert.deepStrictEqual(storage._store.rules, []); // добавлен
});

t('tabs.onUpdated: начало навигации → бейдж вкладки очищается', () => {
  const { chromeMock } = setup();
  chromeMock._listeners.tabUpdated[0](7, { status: 'loading' });
  assert.deepStrictEqual(chromeMock._calls.badgeText, [{ tabId: 7, text: '' }]);
  assert.strictEqual(chromeMock._calls.badgeColor.length, 0); // цвет не нужен для очистки
});

t('tabs.onUpdated: прочие события (\'complete\' и т.п.) — бейдж не трогается', () => {
  const { chromeMock } = setup();
  chromeMock._listeners.tabUpdated[0](7, { status: 'complete' });
  chromeMock._listeners.tabUpdated[0](7, {});
  assert.strictEqual(chromeMock._calls.badgeText.length, 0);
});

t('Ошибка записи (lastError) при клике — состояние не меняется, исключений нет', () => {
  const storage = makeStorage({ enabled: true });
  chromeMock = makeChrome(storage);
  const bg = BG.createBackground(chromeMock);
  storage.sync._failNextSet = true;
  bg.toggleEnabled();
  assert.strictEqual(storage._store.enabled, true); // запись не удалась — не изменилось
});

t('init() регистрирует все четыре слушателя', () => {
  setup();
  assert.strictEqual(chromeMock._listeners.installed.length, 1);
  assert.strictEqual(chromeMock._listeners.message.length, 1);
  assert.strictEqual(chromeMock._listeners.tabUpdated.length, 1);
  assert.strictEqual(chromeMock._listeners.command.length, 1);
});

// Чужая команда тумблер не трогает.
t('handleCommand: неизвестная команда игнорируется', () => {
  const { chromeMock, storage } = setup({ enabled: true });
  chromeMock._listeners.command[0]('что-то-другое');
  assert.strictEqual(storage._store.enabled, true);
});

// Старые сборки Chrome могут не отдать chrome.commands — init не должен падать.
t('init() без chrome.commands не падает', () => {
  const storage = makeStorage({});
  chromeMock = makeChrome(storage);
  delete chromeMock.commands;
  BG.createBackground(chromeMock).init();
  assert.strictEqual(chromeMock._listeners.message.length, 1);
});

/* ---------- Запуск ---------- */

console.log('background.test.js');
let failed = 0;
for (const [name, fn] of TESTS) {
  try {
    fn();
    console.log('  ok - ' + name);
  } catch (err) {
    failed++;
    console.error('  FAIL - ' + name);
    console.error('    ' + (err && err.message));
  }
}
console.log('\nВсего тестов: ' + TESTS.length + (failed ? ', провалено: ' + failed : ''));
if (failed) process.exit(1);
