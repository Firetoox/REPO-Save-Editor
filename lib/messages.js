'use strict';
/**
 * User-facing messages of the backend and the app window, in German and English.
 *
 * Errors carry a `code` (and `params`); the HTTP layer translates them into the language of the
 * page that made the request (header X-REPO-Lang). The Error's own message is the English text,
 * so logs and tests stay readable. Placeholders: {name}.
 */

const LANGUAGES = ['de', 'en'];
const DEFAULT_LANGUAGE = 'en';

const MESSAGES = {
  de: {
    // files and formats
    'file.tooLarge': 'Die Datei ist zu groß für einen Spielstand.',
    'es3.invalid': 'Keine gültige ES3-Datei.',
    'es3.invalid.damaged': 'Keine gültige ES3-Datei (falscher Schlüssel oder beschädigt).',
    'es3.invalid.unpacked': 'Keine gültige ES3-Datei (entpackt zu groß).',
    'es3.invalid.notJson': 'Keine gültige ES3-Datei (Inhalt ist kein JSON).',
    'es3.noPassword': 'Die Datei ist verschlüsselt, aber das Passwort aus den Spieldateien fehlt. Ist R.E.P.O. installiert?',
    'es3.unsafeNumber': 'Die Datei enthält Zahlen, die sich nicht verlustfrei bearbeiten lassen ({token}).',
    'format.noData': 'Unbekanntes Spielstand-Format: dictionaryOfDictionaries fehlt.',
    'format.protoKey': 'Unbekanntes Spielstand-Format: {name} enthält den ungültigen Schlüssel __proto__.',
    'format.notDict': 'Unbekanntes Spielstand-Format: {name} ist kein Dictionary.',
    'format.notNumber': 'Unbekanntes Spielstand-Format: {name} ist keine Zahl.',
    'meta.format': 'Unbekanntes MetaSave-Format (cosmeticUnlocks fehlt).',
    // input from the page
    'input.number': 'Ungültige Zahl: {value}',
    'input.changes': 'Ungültige Änderungen.',
    'input.oneCrown': 'Nur ein Spieler kann die Krone haben.',
    'input.itemName': 'Ungültiger Item-Name: {name}',
    'input.json': 'Kein gültiges JSON: {detail}',
    'save.exists': 'Diesen Spielstand gibt es noch. Stell ihn über seine Backups wieder her, dann wird der jetzige Stand vorher gesichert.',
    'raw.missing': '„{name}“ fehlt, ist im Spielstand aber vorhanden. Im Expertenmodus lassen sich Werte ändern, aber keine Bereiche entfernen.',
    'raw.typeChanged': 'Der Typ von „{name}“ hat sich geändert ({from} → {to}). Im Expertenmodus muss der Aufbau des Spielstands gleich bleiben.',
    'input.unlocks': 'Ungültige Freischaltungen.',
    'input.profiles': 'Ungültige Profilliste.',
    'input.folder': 'Unbekannter Ordner.',
    'input.saveId': 'Ungültige Spielstand-ID.',
    'input.fileName': 'Ungültiger Dateiname.',
    'input.backupSource': 'Ungültige Backup-Quelle.',
    'input.backup': 'Ungültiges Backup.',
    'input.hash': 'Prüfsumme fehlt.',
    // state of files and game
    'save.changed': 'Die Datei wurde inzwischen vom Spiel verändert. Lade sie neu und bearbeite sie dann erneut.',
    'game.running': 'R.E.P.O. läuft gerade. Schließe das Spiel und versuche es erneut.',
    'game.unknown': 'Ob R.E.P.O. läuft, ließ sich nicht prüfen. Sicherheitshalber wird nichts gespeichert. Versuche es gleich noch einmal.',
    'save.notFound': 'Spielstand nicht gefunden: {id}',
    'backup.notFound': 'Backup nicht gefunden.',
    'meta.notFound': 'MetaSave.es3 nicht gefunden.',
    'write.verifyFailed': 'Prüfung nach dem Verschlüsseln fehlgeschlagen. Nichts gespeichert.',
    'cosmetics.missing': 'Cosmetic-Liste fehlt. Nichts gespeichert.',
    'backup.noFreeName': 'Kein freier Backup-Name gefunden.',
    'save.noFreeName': 'Kein freier Spielstand-Name gefunden.',
    // HTTP and file system
    'request.forbidden': 'Nicht erlaubt.',
    'request.notFound': 'Nicht gefunden.',
    'request.invalid': 'Ungültige Anfrage.',
    'request.tooLarge': 'Anfrage zu groß.',
    'fs.busy': 'Die Datei ist gerade gesperrt. Läuft R.E.P.O. noch?',
    'fs.denied': 'Keine Berechtigung für die Datei (gesperrt oder schreibgeschützt).',
    'fs.noSpace': 'Kein freier Speicherplatz mehr.',
    'fs.notFound': 'Datei oder Ordner nicht gefunden.',
    // app window (electron/main.js)
    'app.unsaved.title': 'Nicht gespeicherte Änderungen',
    'app.unsaved.message': 'Es gibt Änderungen, die noch nicht gespeichert wurden.',
    'app.unsaved.detail': 'Beim Schließen gehen sie verloren.',
    'app.unsaved.discard': 'Verwerfen und schließen',
    'app.unsaved.cancel': 'Abbrechen',
    'app.startFailed': 'Der Editor konnte nicht gestartet werden:'
  },
  en: {
    'file.tooLarge': 'The file is too large for a save game.',
    'es3.invalid': 'Not a valid ES3 file.',
    'es3.invalid.damaged': 'Not a valid ES3 file (wrong key or damaged).',
    'es3.invalid.unpacked': 'Not a valid ES3 file (too large when unpacked).',
    'es3.invalid.notJson': 'Not a valid ES3 file (content is not JSON).',
    'es3.noPassword': 'The file is encrypted, but the password from the game files is missing. Is R.E.P.O. installed?',
    'es3.unsafeNumber': 'The file contains numbers that cannot be edited without loss ({token}).',
    'format.noData': 'Unknown save format: dictionaryOfDictionaries is missing.',
    'format.protoKey': 'Unknown save format: {name} contains the invalid key __proto__.',
    'format.notDict': 'Unknown save format: {name} is not a dictionary.',
    'format.notNumber': 'Unknown save format: {name} is not a number.',
    'meta.format': 'Unknown MetaSave format (cosmeticUnlocks is missing).',
    'input.number': 'Invalid number: {value}',
    'input.changes': 'Invalid changes.',
    'input.oneCrown': 'Only one player can have the crown.',
    'input.itemName': 'Invalid item name: {name}',
    'input.json': 'Not valid JSON: {detail}',
    'save.exists': 'This save still exists. Restore it through its backups, then its current state is backed up first.',
    'raw.missing': '"{name}" is missing but exists in the save. Expert mode can change values, not remove whole sections.',
    'raw.typeChanged': 'The type of "{name}" changed ({from} → {to}). Expert mode has to keep the structure of the save.',
    'input.unlocks': 'Invalid unlocks.',
    'input.profiles': 'Invalid profile list.',
    'input.folder': 'Unknown folder.',
    'input.saveId': 'Invalid save ID.',
    'input.fileName': 'Invalid file name.',
    'input.backupSource': 'Invalid backup source.',
    'input.backup': 'Invalid backup.',
    'input.hash': 'Checksum missing.',
    'save.changed': 'The game changed the file in the meantime. Reload it and edit it again.',
    'game.running': 'R.E.P.O. is running. Close the game and try again.',
    'game.unknown': 'Could not check whether R.E.P.O. is running. To be safe, nothing was saved. Try again in a moment.',
    'save.notFound': 'Save not found: {id}',
    'backup.notFound': 'Backup not found.',
    'meta.notFound': 'MetaSave.es3 not found.',
    'write.verifyFailed': 'The check after encrypting failed. Nothing was saved.',
    'cosmetics.missing': 'Cosmetic list missing. Nothing was saved.',
    'backup.noFreeName': 'No free backup name found.',
    'save.noFreeName': 'No free save name found.',
    'request.forbidden': 'Not allowed.',
    'request.notFound': 'Not found.',
    'request.invalid': 'Invalid request.',
    'request.tooLarge': 'Request too large.',
    'fs.busy': 'The file is locked right now. Is R.E.P.O. still running?',
    'fs.denied': 'No permission for the file (locked or read-only).',
    'fs.noSpace': 'No free disk space left.',
    'fs.notFound': 'File or folder not found.',
    'app.unsaved.title': 'Unsaved changes',
    'app.unsaved.message': 'There are changes that have not been saved yet.',
    'app.unsaved.detail': 'They will be lost when you close the editor.',
    'app.unsaved.discard': 'Discard and close',
    'app.unsaved.cancel': 'Cancel',
    'app.startFailed': 'The editor could not be started:'
  }
};

const normalize = lang => (LANGUAGES.includes(lang) ? lang : DEFAULT_LANGUAGE);

/** Message text for `code` in `lang` with {placeholders} filled in. */
function message(lang, code, params = {}) {
  const text = MESSAGES[normalize(lang)][code] || MESSAGES[DEFAULT_LANGUAGE][code] || code;
  return text.replace(/\{(\w+)\}/g, (all, name) => (params[name] !== undefined ? String(params[name]) : all));
}

/** Error with an HTTP status and a translatable code; its message is the English text. */
function appError(status, code, params = {}) {
  return Object.assign(new Error(message('en', code, params)), { status, code, params });
}

/** Text of an error for the user: translated if it has a code, otherwise its own message. */
function errorText(err, lang) {
  return err && err.code && MESSAGES.en[err.code] ? message(lang, err.code, err.params) : String(err && err.message);
}

module.exports = { LANGUAGES, MESSAGES, message, appError, errorText, normalize };
