const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
const library = source.slice(0, source.lastIndexOf('\nwatchAndProtectMathJax();'));
for (const initial of [true, false]) test(`translation detected ${initial ? 'before' : 'after'} observer setup`, () => {
  let translated = initial, observer, scheduled = 0, calls = 0;
  const context = vm.createContext({
    document: { documentElement: { classList: { contains: () => translated } } },
    setTimeout: callback => { scheduled++; callback(); },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observer = this; }
      observe() { this.observing = true; }
      disconnect() { this.observing = false; }
    },
  });
  vm.runInContext(library, context);
  context.waitForTranslation(() => calls++);
  if (!initial) {
    assert.equal(calls, 0);
    assert.equal(observer.observing, true);
    translated = true;
    observer.callback();
  }
  assert.equal(calls, 1);
  assert.equal(scheduled, 1);
  assert.equal(observer.observing, false);
});
