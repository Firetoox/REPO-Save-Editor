'use strict';
// ESLint for the JavaScript files and for the inline script of public/index.html, which ESLint
// cannot read from the HTML itself. Problems in the page are reported with index.html line numbers.
//   npm run lint

const fs = require('fs');
const path = require('path');
const { ESLint } = require('eslint');
const { inlineScripts } = require('../lib/server');

const ROOT = path.join(__dirname, '..');
const PAGE = path.join(ROOT, 'public', 'index.html');

(async () => {
  const eslint = new ESLint({ cwd: ROOT });
  const results = await eslint.lintFiles(['.']);

  const html = fs.readFileSync(PAGE, 'utf8');
  const [script] = inlineScripts(html);
  const lineOffset = html.slice(0, script.start).split('\n').length - 1;
  for (const r of await eslint.lintText(script.text, { filePath: PAGE + '.js' })) {
    r.filePath = PAGE;
    for (const m of r.messages) {
      m.line += lineOffset;
      if (m.endLine) m.endLine += lineOffset;
    }
    results.push(r);
  }

  const output = (await eslint.loadFormatter('stylish')).format(results);
  if (output) console.log(output);
  const problems = results.reduce((n, r) => n + r.errorCount + r.warningCount, 0);
  if (!problems) console.log('No lint problems.');
  process.exitCode = problems ? 1 : 0;
})().catch(e => {
  console.error(e);
  process.exitCode = 2;
});
