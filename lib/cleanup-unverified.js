const db = require('../db/database');

function cleanupUnverified() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const removed = db.get('users')
    .remove(u => !u.emailVerified && u.createdAt < cutoff)
    .write();
  if (removed.length > 0) {
    console.log(`[CLEANUP] Eliminadas ${removed.length} cuentas sin verificar (>24h)`);
  }
}

module.exports = { cleanupUnverified };
