const db = require('../db/database')

function generateReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code
  do {
    let part = ''
    for (let i = 0; i < 6; i++) {
      part += chars[Math.floor(Math.random() * chars.length)]
    }
    code = `RTX-${part}`
  } while (db.get('users').find({ referralCode: code }).value())
  return code
}

function findUserByReferralCode(code) {
  if (!code) return null
  return db.get('users').find({ referralCode: code.toUpperCase() }).value()
}

module.exports = { generateReferralCode, findUserByReferralCode }
