const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.webp']);

// Comprime imágenes a JPEG 80%, máx 1800px ancho — legible y liviano.
// Devuelve el nuevo tamaño en bytes.
async function compressImage(filePath) {
  const tmpPath = filePath + '.tmp.jpg';
  try {
    await sharp(filePath)
      .rotate()                        // respetar orientación EXIF
      .resize({ width: 1800, withoutEnlargement: true })
      .jpeg({ quality: 80, mozjpeg: true })
      .toFile(tmpPath);
    fs.renameSync(tmpPath, filePath);
    return fs.statSync(filePath).size;
  } catch (e) {
    // Si falla la compresión, dejar el original intacto
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    console.error('[COMPRESS] Error comprimiendo imagen:', e.message);
    return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const taxYear = req.params.taxYear || (req.body && req.body.taxYear) || 'general';
    const isSelfie = (req.body && req.body.category === 'selfie_id') || req.route?.path?.includes('selfie') || file.fieldname === 'selfie';
    const dir = isSelfie
      ? path.join(UPLOAD_ROOT, req.user.id)
      : path.join(UPLOAD_ROOT, req.user.id, taxYear);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname).toLowerCase();
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9.\-_]/g, '_');
    // Las imágenes siempre quedan como .jpg después de la compresión
    const finalExt = IMAGE_EXTS.has(ext) ? '.jpg' : ext;
    cb(null, `${timestamp}-${base}${finalExt}`);
  }
});

const allowedExt = ['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.webp', '.doc', '.docx', '.xls', '.xlsx', '.csv'];

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExt.includes(ext)) cb(null, true);
    else cb(new Error(`Tipo de archivo no permitido: ${ext}`));
  }
});

module.exports = { upload, UPLOAD_ROOT, compressImage, IMAGE_EXTS };
