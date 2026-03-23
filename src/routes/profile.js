const router = require('express').Router();
const pool = require('../models/db');
const { auth, adminOnly } = require('../middleware/auth');

// GET public profiles of all trainers
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, employee_id, role, designation, birthday, profile_picture, bio, phone, joined_date, is_active
       FROM users WHERE is_active = true ORDER BY name`
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET single profile
router.get('/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, employee_id, role, designation, birthday, profile_picture, bio, phone, joined_date
       FROM users WHERE id = $1`,
      [req.params.id]
    );
    if(!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT update own profile
router.put('/me/update', auth, async (req, res) => {
  try {
    const { designation, birthday, profile_picture, bio, phone, joined_date } = req.body;
    const result = await pool.query(
      `UPDATE users SET designation=$1, birthday=$2, profile_picture=$3, bio=$4, phone=$5, joined_date=$6
       WHERE id=$7 RETURNING id, name, email, designation, birthday, profile_picture, bio, phone, joined_date`,
      [designation, birthday||null, profile_picture, bio, phone, joined_date||null, req.user.id]
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT admin update any user's designation
router.put('/:id/designation', auth, adminOnly, async (req, res) => {
  try {
    const { designation } = req.body;
    const result = await pool.query(
      `UPDATE users SET designation=$1 WHERE id=$2 RETURNING id, name, designation`,
      [designation, req.params.id]
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
