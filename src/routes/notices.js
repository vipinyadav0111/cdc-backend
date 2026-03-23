const router = require('express').Router();
const pool = require('../models/db');
const { auth, adminOnly } = require('../middleware/auth');

// GET all notices
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT n.*, u.name as author_name, u.designation as author_designation, u.profile_picture as author_pic
       FROM notices n LEFT JOIN users u ON n.author_id = u.id
       WHERE n.is_active = true
       ORDER BY n.priority DESC, n.created_at DESC
       LIMIT 50`
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST create notice (admin only)
router.post('/', auth, async (req, res) => {
  try {
    const { title, content, category, priority } = req.body;
    if(!title || !content) return res.status(400).json({ error: 'Title and content required' });
    const result = await pool.query(
      `INSERT INTO notices (title, content, category, priority, author_id, author_name)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [title, content, category||'general', priority||'normal', req.user.id, req.user.name]
    );
    res.status(201).json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT update notice
router.put('/:id', auth, adminOnly, async (req, res) => {
  try {
    const { title, content, category, priority, is_active } = req.body;
    const result = await pool.query(
      `UPDATE notices SET title=$1, content=$2, category=$3, priority=$4, is_active=$5, updated_at=NOW()
       WHERE id=$6 RETURNING *`,
      [title, content, category, priority, is_active, req.params.id]
    );
    if(!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE notice
router.delete('/:id', auth, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'super_admin';
    if(isAdmin) {
      await pool.query('DELETE FROM notices WHERE id=$1', [req.params.id]);
    } else {
      // Trainers can only delete their own notices
      const r = await pool.query('DELETE FROM notices WHERE id=$1 AND author_id=$2 RETURNING id', [req.params.id, req.user.id]);
      if(!r.rows.length) return res.status(403).json({ error: 'You can only delete your own notices' });
    }
    res.json({ message: 'Deleted' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
