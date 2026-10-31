'use strict';
// Checks of the project page in docs/ (GitHub Pages): node test/site.js
// Every local link and image exists, nothing is loaded from elsewhere, and the English and the
// German page have the same structure and point to each other.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { test } = require('node:test');

const DOCS = path.join(__dirname, '..', 'docs');
const SITE = 'https://firetoox.github.io/REPO-Save-Editor/';
const REPO = 'https://github.com/Firetoox/REPO-Save-Editor';
const PAGES = { en: 'index.html', de: path.join('de', 'index.html') };

const read = rel => fs.readFileSync(path.join(DOCS, rel), 'utf8');
const attrs = (html, name) => [...html.matchAll(new RegExp('\\s' + name + '="([^"]*)"', 'g'))].map(m => m[1]);
/** The file a site URL or a link relative to `from` points to ("dir/" means "dir/index.html"). */
function target(url, from) {
  const rel = url.startsWith(SITE) ? url.slice(SITE.length) : path.posix.join(path.posix.dirname(from.split(path.sep).join('/')), url.split('#')[0]);
  return path.join(DOCS, rel.endsWith('/') || rel === '' || rel === '.' ? path.join(rel, 'index.html') : rel);
}
const LD_OPEN = '<script type="application/ld+json">';
/** Every script block of a page as { open, text } (string search, like inlineScripts in lib/server.js). */
function scriptBlocks(html) {
  const blocks = [];
  for (let at = html.indexOf('<script'); at >= 0; at = html.indexOf('<script', at + 1)) {
    const tagEnd = html.indexOf('>', at);
    const end = html.indexOf('</script>', tagEnd);
    blocks.push({ open: html.slice(at, tagEnd + 1), text: end < 0 ? null : html.slice(tagEnd + 1, end) });
  }
  return blocks;
}

for (const [lang, page] of Object.entries(PAGES)) {
  test(lang + ': every local link, image and site URL exists', () => {
    const html = read(page);
    const urls = [...attrs(html, 'href'), ...attrs(html, 'src'), ...attrs(html, 'content').filter(u => u.startsWith(SITE))];
    const missing = urls.filter(u => !/^(https?:|mailto:)/.test(u) || u.startsWith(SITE))
      .filter(u => !u.startsWith('#'))
      .filter(u => !fs.existsSync(target(u, page)));
    assert.deepStrictEqual(missing, []);
    const ids = new Set(attrs(html, 'id'));
    assert.deepStrictEqual(attrs(html, 'href').filter(u => u.startsWith('#') && !ids.has(u.slice(1))), [], 'anchors without a target');
  });

  test(lang + ': nothing is loaded from other sites, links go only to the project', () => {
    const html = read(page);
    assert.deepStrictEqual(attrs(html, 'src').filter(u => /^https?:|^\/\//.test(u)), []);
    const scripts = scriptBlocks(html);
    assert.deepStrictEqual(scripts.map(s => s.open).filter(o => o !== LD_OPEN), [], 'only structured data, no scripts');
    for (const s of scripts) JSON.parse(s.text);
    assert.ok(!/<link[^>]+rel="(stylesheet|preload|icon)"[^>]+href="(https?:)?\/\//.test(html), 'stylesheets, fonts and icons are local');
    const external = attrs(html, 'href').filter(u => /^https?:/.test(u) && !u.startsWith(SITE) && !u.startsWith(REPO));
    assert.deepStrictEqual(external, []);
  });
}

test('the stylesheet uses only local files', () => {
  const css = read('site.css');
  const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map(m => m[1].replace(/['"]/g, ''));
  assert.ok(urls.length > 0);
  assert.deepStrictEqual(urls.filter(u => /^(https?:)?\/\//.test(u) || !fs.existsSync(path.join(DOCS, u))), []);
});

test('English and German page: same sections and pictures, linked to each other', () => {
  const en = read(PAGES.en), de = read(PAGES.de);
  assert.deepStrictEqual(attrs(de, 'id'), attrs(en, 'id'));
  const pictures = html => attrs(html, 'src').filter(u => u.includes('screenshots/')).map(u => u.replace(/^(\.\.\/)?screenshots\/(en|de)\//, ''));
  assert.deepStrictEqual(pictures(de), pictures(en));
  assert.ok(pictures(en).length >= 5);
  for (const [lang, html] of [['en', en], ['de', de]]) {
    assert.match(html, new RegExp('<html lang="' + lang + '">'));
    for (const tag of ['<link rel="canonical" href="' + SITE + (lang === 'de' ? 'de/' : '') + '">', 'hreflang="en" href="' + SITE + '"', 'hreflang="de" href="' + SITE + 'de/"']) {
      assert.ok(html.includes(tag), lang + ' page contains ' + tag);
    }
    assert.ok(attrs(html, 'src').filter(u => u.includes('screenshots/')).every(u => u.includes('/' + lang + '/')), lang + ' page shows ' + lang + ' pictures');
    assert.ok(attrs(html, 'alt').filter(a => a).length >= pictures(html).length, 'every picture has a description');
  }
});

test('English page: no German text (also in descriptions of pictures and in the structured data)', () => {
  const text = read(PAGES.en).replace(/\bDeutsch\b/g, '');
  assert.deepStrictEqual(text.match(/[äöüÄÖÜß„]|\b(und|oder|nicht|Spielstand|Spielstände|herunterladen|gelöscht)\b/g), null);
});

test('the sitemap lists both pages', () => {
  const xml = read('sitemap.xml');
  assert.deepStrictEqual([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]), [SITE, SITE + 'de/']);
  assert.ok(fs.existsSync(path.join(DOCS, '.nojekyll')), 'served as plain files');
});
