const fs = require('fs');
const path = require('path');

try {
  const constantsPath = path.join(__dirname, 'node_modules', 'instagram-private-api', 'dist', 'core', 'constants.js');
  if (fs.existsSync(constantsPath)) {
    let content = fs.readFileSync(constantsPath, 'utf8');
    content = content.replace(/exports\.APP_VERSION = '[^']+';/, "exports.APP_VERSION = '393.1.0.50.76';");
    content = content.replace(/exports\.APP_VERSION_CODE = '[^']+';/, "exports.APP_VERSION_CODE = '776586932';");
    fs.writeFileSync(constantsPath, content, 'utf8');
    console.log('✅ [Patch] Patched instagram-private-api constants to version 393.1.0.50.76');
  }

  const devicesPath = path.join(__dirname, 'node_modules', 'instagram-private-api', 'dist', 'samples', 'devices.json');
  if (fs.existsSync(devicesPath)) {
    const modernDevices = [
      "34/14; 480dpi; 1080x2340; samsung; SM-S911B; dm1q; qcom",
      "34/14; 480dpi; 1344x2992; Google; Pixel 8 Pro; husky; zuma",
      "33/13; 480dpi; 1080x2400; OnePlus; CPH2413; OP591BL1; qcom",
      "33/13; 440dpi; 1080x2400; Xiaomi; 2210132G; fuxi; qcom",
      "34/14; 560dpi; 1440x3120; samsung; SM-S928B; e3q; qcom"
    ];
    fs.writeFileSync(devicesPath, JSON.stringify(modernDevices, null, 2), 'utf8');
    console.log('✅ [Patch] Patched instagram-private-api devices.json with modern Android 13/14 devices');
  }
} catch (err) {
  console.warn('⚠️ [Patch] Failed to patch instagram-private-api:', err.message);
}
