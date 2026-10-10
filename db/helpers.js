const crypto = require('crypto');

function genId() {
  return crypto.randomBytes(8).toString('hex');
}

// Generates a referral code like RT-AB12CD from the user's name + random chars
function genReferralCode(fullName) {
  const initials = (fullName || 'RX')
    .trim()
    .split(/\s+/)
    .map(p => p[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
    .padEnd(2, 'X');
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `RTX-${initials}${rand}`;
}

// Australian financial years run 1 July - 30 June.
// Returns an array of FY labels, most recent first, e.g. ["2025-26","2024-25","2023-24"]
function getFinancialYears(count = 4) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed, June = 5
  // If we're in Jan-Jun, the current FY started last calendar year
  const currentFYStart = month >= 6 ? year : year - 1;

  const years = [];
  for (let i = 0; i < count; i++) {
    const start = currentFYStart - i;
    const end = (start + 1).toString().slice(-2);
    years.push(`${start}-${end}`);
  }
  return years;
}

module.exports = { genId, genReferralCode, getFinancialYears };
