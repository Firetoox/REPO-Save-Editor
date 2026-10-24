'use strict';
// Regenerates the shipped cosmetic list (lib/cosmetics.json) from the installed game. The editor
// uses that list when it cannot read the game files itself. Only reads the game folder.
//   npm run update-cosmetics [-- <game folder>]
// After a parser change also bump the cache stamp ('cosmetics-vN') in lib/cosmetics.js.

const fs = require('fs');
const path = require('path');
const { findGameDir } = require('../lib/catalog');
const { scanCosmetics, RARITIES } = require('../lib/cosmetics');

const gameDir = findGameDir(process.argv[2]);
if (!gameDir) {
  console.error('R.E.P.O. not found. Name the game folder: npm run update-cosmetics -- "<Steam>\\steamapps\\common\\REPO"');
  process.exit(1);
}

const list = scanCosmetics(gameDir);
const target = path.join(__dirname, '..', 'lib', 'cosmetics.json');
const old = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : [];
// one cosmetic per line: small, readable diffs when the game adds or renames cosmetics
fs.writeFileSync(target, '[\n' + list.map(c => '  ' + JSON.stringify(c)).join(',\n') + '\n]\n');

const changed = list.filter((c, i) => JSON.stringify(c) !== JSON.stringify(old[i])).length;
const perRarity = RARITIES.map((r, i) => r + ' ' + list.filter(c => c.rarity === i).length).join(', ');
console.log(list.length + ' cosmetics written (' + perRarity + '), ' + changed + ' changed or new.');
