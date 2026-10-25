import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'src');
const output = resolve(root, 'lib');
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
await mkdir(output, { recursive: true });

// DSH 0.1.2-rc.1 loads lazy CommonJS factories and supplies one shared React identity.
await build({
  absWorkingDir: root,
  entryPoints: [resolve(source, 'client.jsx')],
  outfile: resolve(output, 'client.js'),
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  define: { 'process.env.NODE_ENV': '"production"' },
  sourcemap: true,
  plugins: [{
    name: 'sidecar-inline-css',
    setup(builder) {
      builder.onLoad({ filter: /\.css$/ }, async ({ path }) => ({
        loader: 'js',
        contents: `const css = ${JSON.stringify(await readFile(path, 'utf8'))};
let style = document.querySelector('style[data-dsh-sidecar]');
if (!style) {
  style = document.createElement('style');
  style.setAttribute('data-dsh-sidecar', '');
  document.head.appendChild(style);
}
style.textContent = css;
export default css;`,
      }));
    },
  }],
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: 'return module.exports; } });' },
});

await build({
  absWorkingDir: root,
  entryPoints: [resolve(source, 'host.mjs')],
  outfile: resolve(output, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  external: ['./service.mjs'],
  sourcemap: true,
});

// Service modules remain readable ESM alongside the loader entry; no host package is duplicated.
async function copyRuntimeModules(directory, relative = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await copyRuntimeModules(resolve(directory, entry.name), nextRelative);
    } else if (entry.name.endsWith('.mjs') && nextRelative !== 'host.mjs') {
      const destination = resolve(output, nextRelative);
      await mkdir(dirname(destination), { recursive: true });
      await cp(resolve(directory, entry.name), destination);
    }
  }
}
await copyRuntimeModules(source);
console.log(`Built ${manifest.name}: lib/index.js + lib/client.js`);
