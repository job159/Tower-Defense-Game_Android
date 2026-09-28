// Dev server: esbuild watch + serve with live reload. http://localhost:5173
import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 5173);

const ctx = await esbuild.context({
  entryPoints: [path.join(root, 'game', 'src', 'main.js')],
  bundle: true,
  format: 'iife',
  target: ['chrome87', 'safari15'],
  sourcemap: 'inline',
  define: { __DEV__: 'true', __VERSION__: '"dev"' },
  outfile: path.join(root, 'game', 'game.js'),
  write: false,
  logLevel: 'info',
});
await ctx.watch();
await ctx.serve({ servedir: path.join(root, 'game'), port, host: '0.0.0.0' });
console.log(`dev server: http://localhost:${port}/`);
