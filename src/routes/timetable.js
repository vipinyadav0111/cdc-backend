// Fixed: force IST timezone (UTC+5:30) for slot detection
const router = require('express').Router();
const pool = require('../models/db');
const { auth, adminOnly } = require('../middleware/auth');

const SLOT_TIMES = [
  { slot: 1, start: 9*60+0,   end: 9*60+50  },
  { slot: 2, start: 9*60+50,  end: 10*60+40 },
  { slot: 3, start: 10*60+40, end: 11*60+30 },
  { slot: 4, start: 11*60+30, end: 12*60+20 },
  { slot: 5, start: 12*60+20, end: 13*60+10 },
  { slot: 6, start: 13*60+10, end: 14*60+0  },
  { slot: 7, start: 14*60+0,  end: 14*60+50 },
  { slot: 8, start: 14*60+50, end: 15*60+40 },
  { slot: 9, start: 15*60+40, end: 16*60+30 },
];

function getISTTime() {
  const now = new Date();
  // IST = UTC + 5:30 = UTC + 330 minutes
  const istOffset = 5 * 60 + 30;
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const istMinutes = (utcMinutes + istOffset) % (24 * 60);
  
  // IST day of week
  const utcTotalMins = now.getUTCDay() * 24 * 60 + now.getUTCHours() * 60 + now.getUTCMinutes();
  const istTotalMins = utcTotalMins + istOffset;
  const istDay = Math.floor(istTotalMins / (24 * 60)) % 7;
  
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  return { minutesFromMidnight: istMinutes, dayName: days[istDay] };
}

router.get('/', auth, async (req, res) => {
  try {
    const { day, trainer_id } = req.query;
    let query = 'SELECT t.*, u.name as trainer_name FROM timetable t JOIN users u ON t.trainer_id = u.id WHERE 1=1';
    const params = [];
    if (day) { params.push(day); query += ` AND t.day = $${params.length}`; }
    if (trainer_id) { params.push(trainer_id); query += ` AND t.trainer_id = $${params.length}`; }
    query += ' ORDER BY u.name, t.day, t.slot_number';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error', message: err.message });
  }
});

router.get('/current', auth, async (req, res) => {
  try {
    const { minutesFromMidnight, dayName } = getISTTime();
    const currentSlotObj = SLOT_TIMES.find(s => minutesFromMidnight >= s.start && minutesFromMidnight <= s.end);

    if (!currentSlotObj) {
      return res.json({ inClass: [], currentSlot: null, currentDay: dayName, istTime: minutesFromMidnight });
    }

    const result = await pool.query(
      `SELECT t.*, u.name as trainer_name, u.email as trainer_email
       FROM timetable t JOIN users u ON t.trainer_id = u.id
       WHERE t.day = $1 AND t.slot_number = $2 AND t.class_name IS NOT NULL AND t.class_name != ''`,
      [dayName, currentSlotObj.slot]
    );
    res.json({ inClass: result.rows, currentSlot: currentSlotObj.slot, currentDay: dayName, istTime: minutesFromMidnight });
  } catch (err) {
    res.status(500).json({ error: 'Server error', message: err.message });
  }
});

router.get('/trainer/:id', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM timetable WHERE trainer_id = $1 ORDER BY day, slot_number', [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const { trainer_id, day, slot_number, class_name, session_type, room, institution } = req.body;
    const result = await pool.query(
      `INSERT INTO timetable (trainer_id,day,slot_number,class_name,session_type,room,institution)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (trainer_id,day,slot_number)
       DO UPDATE SET class_name=$4,session_type=$5,room=$6,institution=$7 RETURNING *`,
      [trainer_id, day, slot_number, class_name, session_type, room, institution]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error', message: err.message });
  }
});

router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM timetable WHERE id=$1', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
