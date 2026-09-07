import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import * as geometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import * as gltf from 'three/examples/jsm/exporters/GLTFExporter.js';
import * as obj from 'three/examples/jsm/exporters/OBJExporter.js';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = fileURLToPath(new URL('../', import.meta.url));

// Execute production TypeScript with the installed compiler, without a second bundler.
// Three's ESM helpers are loaded normally so these tests use actual geometry/export code.
export function createLoader(overrides = {}) {
  const cache = new Map();
  const externals = {
    three: THREE,
    'three/examples/jsm/utils/BufferGeometryUtils.js': geometryUtils,
    'three/examples/jsm/exporters/GLTFExporter.js': gltf,
    'three/examples/jsm/exporters/OBJExporter.js': obj,
    ...overrides,
  };
  function load(name, parent = root) {
    if (name in externals) return externals[name];
    if (!name.startsWith('.') && !name.startsWith('@/')) return require(name);
    let filename = name.startsWith('@/')
      ? path.join(root, 'src', name.slice(2))
      : path.resolve(parent, name);
    if (!path.extname(filename))
      filename = ['.ts', '.tsx', '/index.ts'].map((ext) => filename + ext).find(fs.existsSync);
    if (!filename) throw new Error(`Cannot resolve ${name}`);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    });
    const run = vm.runInThisContext(`(function(require,module,exports){${outputText}\n})`, {
      filename,
    });
    run((specifier) => load(specifier, path.dirname(filename)), module, module.exports);
    return module.exports;
  }
  return load;
}
