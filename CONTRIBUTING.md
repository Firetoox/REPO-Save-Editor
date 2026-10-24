# Contributing

Thanks for helping! A few rules keep the editor safe for everybody's saves.

- **No real save files** in issues, pull requests or tests. They contain Steam IDs and player
  names. Tests use synthetic files from `test/fixtures.js`.
- **Never test against your real game folder.** Use copies, see the commands below.
- The UI is available in German and English. Every page text is in `TEXTS` in `public/index.html` as `[German, English]`;
  messages from the backend are in `lib/messages.js`. Add both languages for every new text (the tests check that
  both exist and use the same placeholders). Code, comments and commit messages are in English.
- New feature → bump the version in `package.json`.
- Do not add game files (DLLs, assets) or the game's save password to the repository. The editor reads the
  password from the installed game (`lib/password.js`); tests use their own password and a fake game folder
  (`test/fixtures.js`).

## Development

Requires Windows and Node.js 22.13 or newer.

```
npm ci
npm run lint        # ESLint, including the script inside public/index.html
npm test            # unit, round trip and API tests on synthetic saves (node:test)
npm run test:ui     # drives the app offscreen (no window opens)
npm run dist        # builds the installer into dist\
```

`npm ci` ends with the `postinstall` script, which downloads the Electron binary: the `electron`
package (version 44) no longer does that on its own.

`npm run serve -- --saves-dir <copy> --meta-file <copy>` starts the backend and opens the editor in
your browser, handy for working on `public/index.html`.

Tests on copies of your own files:

```
node test/api.js <copy of saves folder> <copy of MetaSave.es3> <empty work folder>
node test/ui-hidden.js <copy of saves folder> <copy of MetaSave.es3> <empty work folder>
node test/roundtrip.js "%USERPROFILE%\AppData\LocalLow\semiwork\Repo\saves"   # only reads
```
