const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const distDir = path.resolve(__dirname, 'dist');
const pluginZip = path.resolve(__dirname, 'plugin.zip');

// Run Vite build
console.log('Building with Vite...');
execSync('npx vite build', { stdio: 'inherit', cwd: __dirname });

// Copy plugin.js and manifest.json to dist
const filesToCopy = ['plugin.js', 'manifest.json'];
for (const file of filesToCopy) {
  const src = path.resolve(__dirname, file);
  const dest = path.resolve(distDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`Copied ${file} to dist/`);
  }
}

// Create plugin.zip
console.log('Creating plugin.zip...');
if (fs.existsSync(pluginZip)) {
  fs.unlinkSync(pluginZip);
}

const { execSync: exec } = require('child_process');
exec(`cd ${distDir} && zip -r ${pluginZip} .`, { stdio: 'inherit' });

console.log('Done! plugin.zip created.');
