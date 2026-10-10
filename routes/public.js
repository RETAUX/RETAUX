const express = require('express')
const router = express.Router()
const { attachUser } = require('../middleware/auth')


router.get('/tax-info', (req, res) => {
  res.render('public/tax-info')
})

router.get('/privacy', (req, res) => {
  res.render('public/privacy', { user: req.user || null })
})

module.exports = router
