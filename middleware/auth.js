const jwt = require('jsonwebtoken');
const db = require('../db/database');

const JWT_SECRET = process.env.JWT_SECRET || 'retaux-dev-secret-change-me';

function requireAuth(req, res, next) {
  const token = req.cookies.retaux_token;
  if (!token) return res.redirect('/login');
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.get('users').find({ id: payload.id }).value();
    if (!user) return res.redirect('/login');
    req.user = user;
    res.locals.user = user;
    next();
  } catch (err) { res.redirect('/login'); }
}

function requireVerified(req, res, next) {
  if (!req.user.emailVerified) return res.redirect('/verify-email');
  next();
}

function attachUser(req, res, next) {
  const token = req.cookies.retaux_token;
  if (!token) return next();
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.get('users').find({ id: payload.id }).value();
    if (user) { req.user = user; res.locals.user = user; }
  } catch (err) {}
  next();
}

module.exports = { requireAuth, requireVerified, attachUser, JWT_SECRET };
