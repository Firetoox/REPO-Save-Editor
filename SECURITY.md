# Security

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private reporting instead:
**Security → Report a vulnerability** in this repository. You will get an answer as soon as possible.

Do not attach real save files or `MetaSave.es3`: they contain Steam IDs and player names.

## What the editor does

- It runs only on your PC. The backend listens on `127.0.0.1` only, on a random port, and answers
  only its own page (session token, Host/Origin checks, strict Content-Security-Policy).
- It writes only to the R.E.P.O. save folder, `MetaSave.es3`, its own backup folder and its settings
  folder `%APPDATA%\REPO Save Editor` (profiles, settings, list caches, window size, log). It reads
  the game's data files (never changes them) to list items and cosmetics and to find the password of
  the saves. The password is kept in memory only; a cache in the settings folder stores just its
  position in the game file.
- The log (`main.log`) shows your user folder as `%USERPROFILE%`; still check it before sharing.
- It sends nothing to the internet: no telemetry, no update checks, no external resources.

## Supported versions

Only the latest release receives fixes.
