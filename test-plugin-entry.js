
const fs = require('fs');
const path = require('path');
const entryPath = path.join(__dirname, 'openpets.spotify-buddy', 'index.js');
const source = fs.readFileSync(entryPath, 'utf8');

console.log('Testing index.js entry...');
console.log('Entry path:', entryPath);
console.log('Entry content length:', source.length);

// Let's simulate the import
console.log('\nSimulating import...');
try {
  const mod = require(entryPath);
  console.log('Import successful! Exports:', Object.keys(mod));
  if (typeof mod.register === 'function') {
    console.log('✓ register function exists!');
  } else {
    console.error('✗ No register function exported!');
  }
} catch (e) {
  console.error('✗ Error importing entry:', e);
}
