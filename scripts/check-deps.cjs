// Exits with code 1 when any dependency from package.json is not installed,
// so the launchers know to run "npm install" (e.g. after an update adds a package).
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const missing = Object.keys(pkg.dependencies || {}).filter((name) => {
  try {
    require.resolve(`${name}/package.json`, { paths: [root] });
    return false;
  } catch {
    return true;
  }
});
if (missing.length) {
  console.log(` Missing packages: ${missing.join(', ')}`);
  process.exit(1);
}
