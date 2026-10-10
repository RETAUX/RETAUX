const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('./auth');

function requireAdmin(req, res, next) {
  const token = req.cookies.retax_admin;
  if (!token) return res.redirect('/admin/login');
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload.admin) return res.redirect('/admin/login');
    next();
  } catch (err) {
    return res.redirect('/admin/login');
  }
}

module.exports = { requireAdmin };
