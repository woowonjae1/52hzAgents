const fs = require('fs');
const path = require('path');

let cachedPkg = null;
function getPackageMeta() {
  if (cachedPkg) return cachedPkg;
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    if (fs.existsSync(pkgPath)) {
      cachedPkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      return cachedPkg;
    }
  } catch (_) {}
  return { name: '52hzagents-desktop', version: '1.0.0' };
}

/**
 * Get comprehensive version and distribution info.
 * @param {Object} [options]
 * @param {import('./storage').Storage} [options.storage]
 * @param {string} [options.userDataPath]
 * @returns {Object}
 */
function getVersionInfo({ storage = null, userDataPath = null } = {}) {
  const pkg = getPackageMeta();
  const channel = process.env.OPENAGENTS_RELEASE_CHANNEL || 'stable';
  const schemaVersion = storage && storage.manager ? storage.manager.getSchemaVersion() : 3;

  return {
    appName: '52hzAgents',
    appVersion: pkg.version || '1.0.0',
    productName: pkg.build?.productName || '52hzAgents',
    channel,
    schemaVersion,
    sqliteVersion: process.versions.sqlite || '3.53.4',
    nodeVersion: process.versions.node,
    electronVersion: process.versions.electron || null,
    platform: process.platform,
    arch: process.arch,
    userDataPath: userDataPath || process.env.OPENAGENTS_USER_DATA_DIR || null,
    isPackaged: Boolean(process.resourcesPath && !process.defaultApp),
  };
}

module.exports = {
  getVersionInfo,
  getPackageMeta,
};
