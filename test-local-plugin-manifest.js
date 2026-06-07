
const fs = require('fs').promises;
const path = require('path');
const { readLocalPluginSourceManifest } = require('./openpets-repo/apps/desktop/src/plugin-local-loader.js');

async function test() {
  const sourceFolder = 'c:\\Users\\user\\Downloads\\pets\\openpets.spotify-buddy';
  console.log('Testing readLocalPluginSourceManifest with:', sourceFolder);
  try {
    const result = await readLocalPluginSourceManifest({ sourceFolder });
    console.log('✅ Success! Manifest:', result.manifest);
    console.log('Entry text length:', (result.entryText || '').length);
  } catch (e) {
    console.error('❌ Error:', e);
    console.error('Stack:', e.stack);
  }
}

test();
