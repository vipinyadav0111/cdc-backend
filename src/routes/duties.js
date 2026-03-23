const router = require('express').Router();
const pool = require('../models/db');
const { auth, adminOnly } = require('../middleware/auth');

// GET /api/duties
router.get('/', auth, async (req, res) => {
  try {
    const { trainer_id, date, type } = req.query;
    let query = `SELECT d.*, u.name as trainer_name, u.email as trainer_email,
                 a.name as assigned_by_name
                 FROM duties d
                 JOIN users u ON d.trainer_id = u.id
                 LEFT JOIN users a ON d.assigned_by = a.id
                 WHERE 1=1`;
    const params = [];

    if (trainer_id) { params.push(trainer_id); query += ` AND d.trainer_id = $${params.length}`; }
    if (date) { params.push(date); query += ` AND d.date = $${params.length}`; }
    if (type) { params.push(type); query += ` AND d.type = $${params.length}`; }

    query += ' ORDER BY d.date DESC, d.slot_number';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error', message: err.message });
  }
});

// POST /api/duties
router.post('/', auth, async (req, res) => {
  try {
    const { trainer_id, date, slot_number, type, class_name, room, topic, instructions, note } = req.body;
    if (!trainer_id || !date || !slot_number || !type) {
      return res.status(400).json({ error: 'trainer_id, date, slot_number, type required' });
    }

    const result = await pool.query(
      `INSERT INTO duties (trainer_id, date, slot_number, type, class_name, room, topic, instructions, note, assigned_by, acknowledged)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false) RETURNING *`,
      [trainer_id, date, slot_number, type, class_name, room, topic, instructions, note, req.user.id]
    );

    // Send email notification (non-blocking)
    try {
      const trainerResult = await pool.query('SELECT name, email FROM users WHERE id=$1', [trainer_id]);
      if (trainerResult.rows.length > 0) {
        const emailService = require('../services/emailService');
        emailService.sendDutyNotification(trainerResult.rows[0], result.rows[0], req.user.name);
      }
    } catch (emailErr) {
      console.error('Email error (non-fatal):', emailErr.message);
    }

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error', message: err.message });
  }
});

// PATCH /api/duties/:id/acknowledge
router.patch('/:id/acknowledge', auth, async (req, res) => {
  try {
    await pool.query('UPDATE duties SET acknowledged=true, acknowledged_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ message: 'Acknowledged' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/duties/:id
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM duties WHERE id=$1', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/duties/free-trainers?date=2026-03-20&slot=5
router.get('/free-trainers', auth, async (req, res) => {
  try {
    const { date, slot } = req.query;
    if (!date || !slot) return res.status(400).json({ error: 'date and slot required' });

    const dateObj = new Date(date);
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dayName = days[dateObj.getDay()];

    // Get all trainers
    const allTrainers = await pool.query(
      'SELECT id, name, email FROM users WHERE role = $1 AND is_active = true ORDER BY name',
      ['trainer']
    );

    // Get busy trainers (have class in timetable OR have duty assigned)
    const busyInTT = await pool.query(
      'SELECT trainer_id, class_name FROM timetable WHERE day=$1 AND slot_number=$2 AND class_name IS NOT NULL AND class_name != \'\'',
      [dayName, slot]
    );

    const busyInDuties = await pool.query(
      'SELECT trainer_id, class_name FROM duties WHERE date=$1 AND slot_number=$2',
      [date, slot]
    );

    const busyIds = new Set([
      ...busyInTT.rows.map(r => r.trainer_id),
      ...busyInDuties.rows.map(r => r.trainer_id)
    ]);

    const busyMap = {};
    busyInTT.rows.forEach(r => { busyMap[r.trainer_id] = r.class_name; });
    busyInDuties.rows.forEach(r => { busyMap[r.trainer_id] = r.class_name; });

    const free = [];
    const busy = [];

    allTrainers.rows.forEach(t => {
      if (busyIds.has(t.id)) {
        busy.push({ ...t, current_class: busyMap[t.id] });
      } else {
        free.push(t);
      }
    });

    res.json({ free, busy, day: dayName, slot: parseInt(slot) });
  } catch (err) {
    res.status(500).json({ error: 'Server error', message: err.message });
  }
});

module.exports = router;
