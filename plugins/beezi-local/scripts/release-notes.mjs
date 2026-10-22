import { parseReleaseNotesArgs, releaseNotes, USAGE } from '../lib/commands/release-notes.mjs';

const parsed = parseReleaseNotesArgs(process.argv.slice(2));
if (parsed == null) {
  console.error(USAGE);
  process.exit(1);
}
releaseNotes(parsed.arg).then((text) => {
  process.stdout.write(text);
}).catch((error) => {
  console.error(`✗ Beezi: could not show the release notes (${error.message})`);
  process.exit(1);
});
