const { google } = require('googleapis');
const fs = require('fs');
const { Readable } = require('stream');

const KEY_PATH = '/home/deploy/retaux-drive-key.json';
const PARENT_FOLDER_ID = '1fhXga8RCeXZgUsz-yF4o399k3WCl_quk';

async function getAuth() {
  const keyFile = fs.existsSync(KEY_PATH)
    ? KEY_PATH
    : require('path').join(__dirname, '..', 'assets', 'retaux-drive-key.json');
  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return auth.getClient();
}

async function createFolder(name) {
  const auth = await getAuth();
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [PARENT_FOLDER_ID],
    },
    fields: 'id',
  });
  return res.data.id;
}

async function uploadBuffer(folderId, filename, buffer, mimeType = 'application/pdf') {
  const auth = await getAuth();
  const drive = google.drive({ version: 'v3', auth });
  await drive.files.create({
    requestBody: { name: filename, parents: [folderId] },
    media: { mimeType, body: Readable.from(buffer) },
  });
}

async function uploadFile(folderId, filename, filePath) {
  const auth = await getAuth();
  const drive = google.drive({ version: 'v3', auth });
  const ext = filePath.split('.').pop().toLowerCase();
  const mimeMap = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic' };
  const mimeType = mimeMap[ext] || 'application/octet-stream';
  await drive.files.create({
    requestBody: { name: filename, parents: [folderId] },
    media: { mimeType, body: fs.createReadStream(filePath) },
  });
}

module.exports = { createFolder, uploadBuffer, uploadFile };
