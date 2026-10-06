const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

module.exports = function load(file, imports = {}, globals = {}) {
  const module = { exports: {} };
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, { module, exports: module.exports, URL, URLSearchParams, Request, Response, Headers,
    setTimeout, clearTimeout, TextEncoder, Uint8Array, crypto: globalThis.crypto, ...globals,
    require: (name) => imports[name] ?? (name.startsWith('.') ? load(path.resolve(path.dirname(file), name), imports, globals) : require(name)),
  }, { filename: file });
  return module.exports;
};
