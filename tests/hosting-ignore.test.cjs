// Guards firebase.json: hosting serves "." so anything not ignored is public.
// Run: node tests/hosting-ignore.test.cjs
const fs = require('fs');
const path = require('path');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'firebase.json'), 'utf8'));
const ignore = cfg.hosting.ignore;
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}
ok('hosting still serves the project root', cfg.hosting.public === '.');
// These must stay unserved. A literal-entry check keeps the test free of extra dependencies.
['tests/**', 'buildme.sh', '_to_delete/**', 'package*.json', '*.py', '*.patch',
 'CLAUDE.md', 'regression-checklist.md', 'firestore.*', 'firebase.json', '**/.*',
 '**/node_modules/**', '**/*adminsdk*.json', '**/*service-account*.json'
].forEach(p => ok('ignores ' + p, ignore.includes(p)));
// Files the app needs must not be hidden by a broad pattern.
const needed = ['index.html', 'app.js', 'tree-utils.js', 'styles.css', 'sw.js', 'manifest.json', 'firebase-config.js'];
ok('no catch-all pattern hides the app', !ignore.some(p => ['**', '*', '**/*', '*.js', '**/*.js', '*.html'].includes(p)));
needed.forEach(f => ok('app file exists: ' + f, fs.existsSync(path.join(__dirname, '..', f))));
console.log('\n' + pass + ' passed' + (fail ? ', ' + fail + ' FAILED' : ''));
process.exit(fail ? 1 : 0);
