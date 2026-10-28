// Bündelt das Giphy-SDK (@giphy/js-components) für den Browser nach public/vendor/giphy.js.
// Aufruf: npm run build:giphy  (nur nötig nach einem SDK-Update; das Ergebnis liegt im Repo,
// damit der Container ohne Build-Schritt auskommt).
// Die Markenschriften, die das SDK sonst von Amazon S3 nachlädt, werden entfernt: Wir zeigen
// keine Giphy-Attribution im Gitter, und die CSP erlaubt nur eigene Schriften.
import { build } from 'esbuild';
import fs from 'node:fs/promises';

const noBrandFonts = {
  name: 'no-brand-fonts',
  setup(b) {
    b.onLoad({ filter: /@giphy[\\/]js-brand[\\/]dist[\\/]index\.c?js$/ }, async (args) => {
      const src = await fs.readFile(args.path, 'utf8');
      const out = src.replace(/var addFonts = \(\) => (?:import_emotion\d*\.)?injectGlobal`[\s\S]*?`;/, 'var addFonts = () => {};');
      if (out === src) throw new Error('js-brand: addFonts nicht gefunden – SDK-Version prüfen');
      return { contents: out, loader: 'js' };
    });
  },
};

await build({
  entryPoints: ['scripts/giphy-entry.js'],
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'safari15',
  legalComments: 'eof',
  outfile: 'public/vendor/giphy.js',
  plugins: [noBrandFonts],
});
console.log('public/vendor/giphy.js gebaut');
