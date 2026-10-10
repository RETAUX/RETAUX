const fs = require('fs');
const path = require('path');

const SUPPORTED = ['es', 'en', 'fr', 'it'];
const locales = {};
SUPPORTED.forEach(lang => {
  try {
    locales[lang] = JSON.parse(fs.readFileSync(path.join(__dirname, '../locales', lang + '.json'), 'utf8'));
  } catch(e) { locales[lang] = {}; }
});

function get(obj, key) {
  return key.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : null), obj);
}

function t(lang, key, fallback) {
  if (!SUPPORTED.includes(lang)) lang = 'en';
  return get(locales[lang], key) ?? get(locales['en'], key) ?? fallback ?? key;
}

function middleware(req, res, next) {
  const lang = (req.cookies?.lang && SUPPORTED.includes(req.cookies.lang)) ? req.cookies.lang : 'en';
  res.locals.lang = lang;
  res.locals.__ = (key, fb) => t(lang, key, fb);
  req.__ = res.locals.__;
  next();
}

module.exports = { middleware, t };
