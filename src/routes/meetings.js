const router = require('express').Router();
const pool = require('../models/db');
const { auth } = require('../middleware/auth');

// Schema setup
const setupSchema = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meetings (
      id SERIAL PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      course VARCHAR(100),
      date DATE NOT NULL,
      time TIME NOT NULL,
      venue VARCHAR(200),
      description TEXT,
      scheduled_by INTEGER REFERENCES users(id),
      scheduled_by_name VARCHAR(100),
      status VARCHAR(20) DEFAULT 'scheduled',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS meeting_attendees (
      id SERIAL PRIMARY KEY,
      meeting_id INTEGER REFERENCES meetings(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id),
      user_name VARCHAR(100),
      responded VARCHAR(20) DEFAULT 'pending'
    );
    CREATE TABLE IF NOT EXISTS meeting_minutes (
      id SERIAL PRIMARY KEY,
      meeting_id INTEGER REFERENCES meetings(id) ON DELETE CASCADE,
      raw_notes TEXT,
      formatted_minutes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
};
setupSchema().catch(console.error);

// GET all meetings (admin sees all, others see own)
router.get('/', auth, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'super_admin';
    const result = await pool.query(`
      SELECT m.*,
        json_agg(json_build_object('user_id',ma.user_id,'user_name',ma.user_name,'responded',ma.responded)) as attendees,
        EXISTS(SELECT 1 FROM meeting_minutes mm WHERE mm.meeting_id=m.id) as has_minutes
      FROM meetings m
      LEFT JOIN meeting_attendees ma ON ma.meeting_id=m.id
      WHERE ${isAdmin ? '1=1' : '(m.scheduled_by=$1 OR ma.user_id=$1)'}
      GROUP BY m.id
      ORDER BY m.date DESC, m.time DESC
    `, isAdmin ? [] : [req.user.id]);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST create meeting
router.post('/', auth, async (req, res) => {
  try {
    const { title, course, date, time, venue, description, attendee_ids } = req.body;
    if(!title || !date || !time) return res.status(400).json({ error: 'Title, date and time required' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const m = await client.query(
        `INSERT INTO meetings (title,course,date,time,venue,description,scheduled_by,scheduled_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [title, course||null, date, time, venue||null, description||null, req.user.id, req.user.name]
      );
      const meeting = m.rows[0];

      // Add attendees
      if(attendee_ids && attendee_ids.length > 0) {
        const users = await client.query('SELECT id,name FROM users WHERE id=ANY($1)', [attendee_ids]);
        for(const u of users.rows) {
          await client.query(
            'INSERT INTO meeting_attendees (meeting_id,user_id,user_name) VALUES ($1,$2,$3)',
            [meeting.id, u.id, u.name]
          );
        }
      }
      await client.query('COMMIT');
      res.status(201).json(meeting);
    } catch(e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT update meeting
router.put('/:id', auth, async (req, res) => {
  try {
    const { title, course, date, time, venue, description, status, attendee_ids } = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE meetings SET title=$1,course=$2,date=$3,time=$4,venue=$5,description=$6,status=COALESCE($7,status)
         WHERE id=$8 RETURNING *`,
        [title, course||null, date, time, venue||null, description||null, status||null, req.params.id]
      );
      if(attendee_ids) {
        await client.query('DELETE FROM meeting_attendees WHERE meeting_id=$1', [req.params.id]);
        const users = await client.query('SELECT id,name FROM users WHERE id=ANY($1)', [attendee_ids]);
        for(const u of users.rows) {
          await client.query(
            'INSERT INTO meeting_attendees (meeting_id,user_id,user_name) VALUES ($1,$2,$3)',
            [req.params.id, u.id, u.name]
          );
        }
      }
      await client.query('COMMIT');
      res.json(result.rows[0]);
    } catch(e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE meeting
router.delete('/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM meetings WHERE id=$1', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST save meeting minutes (raw notes)
router.post('/:id/minutes', auth, async (req, res) => {
  try {
    const { raw_notes } = req.body;
    if(!raw_notes) return res.status(400).json({ error: 'Notes required' });
    const existing = await pool.query('SELECT id FROM meeting_minutes WHERE meeting_id=$1', [req.params.id]);
    if(existing.rows.length > 0) {
      await pool.query('UPDATE meeting_minutes SET raw_notes=$1, created_by=$2, created_at=NOW() WHERE meeting_id=$3',
        [raw_notes, req.user.id, req.params.id]);
    } else {
      await pool.query('INSERT INTO meeting_minutes (meeting_id,raw_notes,created_by) VALUES ($1,$2,$3)',
        [req.params.id, raw_notes, req.user.id]);
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET meeting minutes
router.get('/:id/minutes', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM meeting_minutes WHERE meeting_id=$1', [req.params.id]);
    res.json(result.rows[0] || null);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
