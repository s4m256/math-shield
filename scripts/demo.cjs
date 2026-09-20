// Reproduce the default branch's pure LaTeX transformations without a browser,
// network request, extension installation or copied transformation code.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
const startup = source.lastIndexOf('\nwatchAndProtectMathJax();');
assert.ok(startup > 0, 'content.js startup boundary changed; review the fixture');
const context = vm.createContext({});
vm.runInContext(source.slice(0, startup), context);
const examples = [
  [String.raw`v = 12\,\mathrm{км}/\mathrm{с}`, String.raw`v = 12\,\mathrm{km}/\mathrm{s}`],
  [String.raw`R = 4\,\mathrm{кОм}`, String.raw`R = 4\,\mathrm{k\Omega}`],
  [String.raw`E = mc^2 + \alpha`, String.raw`E = mc^2 + \alpha`],
];
for (const [input, expected] of examples) {
  const actual = context.applyTranslations(input, {});
  assert.equal(actual, expected);
  console.log(`${input}\n  -> ${actual}`);
}
console.log('3 examples passed using content.js; no translation provider called.');
