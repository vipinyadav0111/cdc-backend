const router = require('express').Router();
const pool = require('../models/db');
const { auth, adminOnly } = require('../middleware/auth');

// ── Create table on startup ───────────────────────────────────────
const setupSchema = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS exam_dates (
      id          SERIAL PRIMARY KEY,
      institution VARCHAR(20) NOT NULL CHECK (institution IN ('MRU','MRIIRS')),
      exam_type   VARCHAR(20) NOT NULL CHECK (exam_type IN ('midterm','endterm')),
      title       VARCHAR(100),
      start_date  DATE NOT NULL,
      end_date    DATE NOT NULL,
      session     VARCHAR(50) DEFAULT 'Even Semester 2026',
      created_by  INTEGER REFERENCES users(id),
      created_at  TIMESTAMP DEFAULT NOW(),
      updated_at  TIMESTAMP DEFAULT NOW()
    );
  `);
};
setupSchema().catch(console.error);

// GET all exam dates (all authenticated users can read)
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT e.*, u.name as created_by_name
      FROM exam_dates e
      LEFT JOIN users u ON e.created_by = u.id
      ORDER BY e.institution, e.exam_type, e.start_date
    `);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST create exam date entry — super_admin only
router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const { institution, exam_type, title, start_date, end_date, session } = req.body;
    if (!institution || !exam_type || !start_date || !end_date)
      return res.status(400).json({ error: 'institution, exam_type, start_date, end_date are required' });

    const result = await pool.query(`
      INSERT INTO exam_dates (institution, exam_type, title, start_date, end_date, session, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [institution, exam_type, title || null, start_date, end_date, session || 'Even Semester 2026', req.user.id]);

    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT update — super_admin only
router.put('/:id', auth, adminOnly, async (req, res) => {
  try {
    const { institution, exam_type, title, start_date, end_date, session } = req.body;
    const result = await pool.query(`
      UPDATE exam_dates
      SET institution=$1, exam_type=$2, title=$3, start_date=$4, end_date=$5, session=$6, updated_at=NOW()
      WHERE id=$7 RETURNING *
    `, [institution, exam_type, title || null, start_date, end_date, session || 'Even Semester 2026', req.params.id]);

    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE — super_admin only
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM exam_dates WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
