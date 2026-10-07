const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const root = path.resolve(__dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-copilot-runtime-'));
process.env.BEEZI_COPILOT_HOME = home;
process.env.COPILOT_HOME = path.join(home, 'copilot');
const files = ['lib', 'scripts'].reduce((all, dir) => all.concat(fs.readdirSync(path.join(root, dir))
  .filter(name => name.endsWith('.mjs')).map(name => path.join(root, dir, name))), []);
const failures = [];
const firstLine = text => String(text).trim().split('\n')[0];
for (const file of files) {
  const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (checked.status !== 0) failures.push('syntax ' + path.relative(root, file) + ': ' + firstLine(checked.stderr));
}
const libs = files.filter(file => path.dirname(file) === path.join(root, 'lib'));
Promise.all(libs.map(file => import(pathToFileURL(file).href).then(() => null,
  error => 'import ' + path.relative(root, file) + ': ' + firstLine(error && error.message ? error.message : error))))
  .then(results => {
    results.forEach(result => { if (result) failures.push(result); });
    failures.forEach(line => console.error(line));
    console.log(process.version + ': parsed ' + files.length + ' runtime files, imported ' + libs.length
      + ' library modules, ' + failures.length + ' failure(s)');
    process.exitCode = failures.length ? 1 : 0;
  });
