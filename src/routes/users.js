const router = require('express').Router();
const bcrypt = require('bcryptjs');
const pool = require('../models/db');
const { auth, adminOnly } = require('../middleware/auth');

// GET /api/users — all authenticated users can see trainer list (needed for timetable)
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, role, employee_id, is_active, must_change_password, created_at FROM users ORDER BY name'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/users
router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const { name, email, employee_id, role } = req.body;
    if (!name || !email || !employee_id) {
      return res.status(400).json({ error: 'Name, email and employee_id required' });
    }
    const hash = await bcrypt.hash(employee_id, 10);
    const result = await pool.query(
      'INSERT INTO users (name, email, employee_id, password_hash, role, must_change_password) VALUES ($1, $2, $3, $4, $5, true) RETURNING id, name, email, role, employee_id',
      [name, email, employee_id, hash, role || 'trainer']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Email or Employee ID already exists' });
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/users/:id
router.put('/:id', auth, adminOnly, async (req, res) => {
  try {
    const { name, email, employee_id, role, is_active } = req.body;
    const result = await pool.query(
      'UPDATE users SET name=$1, email=$2, employee_id=$3, role=$4, is_active=$5 WHERE id=$6 RETURNING id, name, email, role, employee_id, is_active',
      [name, email, employee_id, role, is_active, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/users/:id/reset-password
router.post('/:id/reset-password', auth, adminOnly, async (req, res) => {
  try {
    const userResult = await pool.query('SELECT employee_id FROM users WHERE id=$1', [req.params.id]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const { employee_id } = userResult.rows[0];
    const hash = await bcrypt.hash(employee_id, 10);
    await pool.query(
      'UPDATE users SET password_hash=$1, must_change_password=true WHERE id=$2',
      [hash, req.params.id]
    );
    res.json({ message: 'Password reset to Employee ID' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
