const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');

const adapter = new FileSync(path.join(__dirname, 'db.json'));
const db = low(adapter);

db.defaults({
  users: [],
  admins: [],
  taxYearProfiles: [],
  documents: [],
  referrals: [],
  appointments: [],  // booked slots
  payments: [],      // stripe payment records
  daspRequests: [],  // DASP superannuation claims
  super_payments: [], // Superannuation service payments
  waConversations: [], // WhatsApp conversations per phone number (Reta)
  taxBundles: []       // Temporary secure download bundles for tax agents (large files)
}).write();

module.exports = db;
