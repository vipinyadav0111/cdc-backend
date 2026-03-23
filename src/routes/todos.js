const router = require('express').Router();
const pool = require('../models/db');
const { auth } = require('../middleware/auth');

// Schema setup
const setup = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS todos (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      date DATE NOT NULL,
      punch_in_time TIME NOT NULL,
      submitted_at TIMESTAMP,
      UNIQUE(user_id, date)
    );
    CREATE TABLE IF NOT EXISTS todo_slots (
      id SERIAL PRIMARY KEY,
      todo_id INTEGER REFERENCES todos(id) ON DELETE CASCADE,
      slot_start TIME NOT NULL,
      slot_end TIME NOT NULL,
      slot_label VARCHAR(20),
      task TEXT,
      class_name VARCHAR(150),
      is_class BOOLEAN DEFAULT false,
      is_locked BOOLEAN DEFAULT false
    );
    CREATE TABLE IF NOT EXISTS todo_comments (
      id SERIAL PRIMARY KEY,
      todo_slot_id INTEGER REFERENCES todo_slots(id) ON DELETE CASCADE,
      author_id INTEGER REFERENCES users(id),
      author_name VARCHAR(100),
      comment TEXT NOT NULL,
      type VARCHAR(20) DEFAULT 'explanation_request',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_todos_date ON todos(date);
    CREATE INDEX IF NOT EXISTS idx_todos_user ON todos(user_id);
  `);
};
setup().catch(console.error);

// Slot times matching timetable exactly
const TIMETABLE_SLOTS = [
  { start: '09:00', end: '09:50', label: 'Slot 1' },
  { start: '09:50', end: '10:40', label: 'Slot 2' },
  { start: '10:40', end: '11:30', label: 'Slot 3' },
  { start: '11:30', end: '12:20', label: 'Slot 4' },
  { start: '12:20', end: '13:10', label: 'Slot 5' },
  { start: '13:10', end: '14:00', label: 'Slot 6' },
  { start: '14:00', end: '14:50', label: 'Slot 7' },
  { start: '14:50', end: '15:40', label: 'Slot 8' },
  { start: '15:40', end: '16:30', label: 'Slot 9' },
];

function timeToMins(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function minsToTime(m) {
  const h = Math.floor(m / 60);
  const mins = m % 60;
  return `${String(h).padStart(2,'0')}:${String(mins).padStart(2,'0')}`;
}

// Round punch-in time to next timetable boundary (:00 or :50)
function roundToNextSlotBoundary(punchInTime) {
  const mins = timeToMins(punchInTime);
  // All boundary minutes in a day from timetable
  const boundaries = [];
  for(const s of TIMETABLE_SLOTS) {
    boundaries.push(timeToMins(s.start));
    boundaries.push(timeToMins(s.end));
  }
  // Add 8:00 as earliest possible
  boundaries.push(8*60);
  boundaries.sort((a,b)=>a-b);

  // Find the first boundary AFTER punch-in time
  // If punch-in is exactly on a boundary, use it
  for(const b of boundaries) {
    if(b >= mins) return minsToTime(b);
  }
  return minsToTime(boundaries[boundaries.length-1]);
}

// Generate slots from first boundary to end of 8.5hr shift
function generateSlots(punchInTime) {
  const firstBoundary = roundToNextSlotBoundary(punchInTime);
  const firstMins = timeToMins(firstBoundary);
  const endMins = timeToMins(punchInTime) + 8*60+30; // 8.5 hours from actual punch-in

  const slots = [];
  // First partial slot: punch-in → first boundary
  const punchMins = timeToMins(punchInTime);
  if(punchMins < firstMins) {
    slots.push({
      slot_start: punchInTime,
      slot_end: firstBoundary,
      slot_label: 'Pre-shift'
    });
  }

  // Now generate 50-min slots from firstBoundary onward
  // Align with timetable slots where possible
  let current = firstMins;
  while(current < endMins) {
    // Check if this matches a timetable slot
    const ttSlot = TIMETABLE_SLOTS.find(s => timeToMins(s.start) === current);
    const slotEnd = ttSlot ? timeToMins(ttSlot.end) : current + 50;
    const actualEnd = Math.min(slotEnd, endMins);
    slots.push({
      slot_start: minsToTime(current),
      slot_end: minsToTime(actualEnd),
      slot_label: ttSlot ? ttSlot.label : `${minsToTime(current)}–${minsToTime(actualEnd)}`
    });
    current = slotEnd;
  }
  return slots;
}

// GET today's todo for current user (or create skeleton)
router.get('/today', auth, async (req, res) => {
  try {
    const istOffset = 5*60+30;
    const now = new Date();
    const istDate = new Date(now.getTime() + istOffset*60000);
    const today = req.query.date || istDate.toISOString().split('T')[0];

    const existing = await pool.query(
      `SELECT t.*, json_agg(
        json_build_object(
          'id',ts.id,'slot_start',ts.slot_start,'slot_end',ts.slot_end,
          'slot_label',ts.slot_label,'task',ts.task,'class_name',ts.class_name,
          'is_class',ts.is_class,'is_locked',ts.is_locked,
          'comments', (SELECT json_agg(json_build_object('id',tc.id,'author_name',tc.author_name,'comment',tc.comment,'type',tc.type,'created_at',tc.created_at))
                       FROM todo_comments tc WHERE tc.todo_slot_id=ts.id)
        ) ORDER BY ts.slot_start
      ) as slots
      FROM todos t
      LEFT JOIN todo_slots ts ON ts.todo_id=t.id
      WHERE t.user_id=$1 AND t.date=$2
      GROUP BY t.id`,
      [req.user.id, today]
    );
    res.json(existing.rows[0] || { date: today, slots: null, needs_setup: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST initialize todo with punch-in time
router.post('/init', auth, async (req, res) => {
  try {
    const { punch_in_time, date } = req.body;
    if(!punch_in_time) return res.status(400).json({ error: 'Punch-in time required' });

    const todoDate = date || new Date().toISOString().split('T')[0];

    // Get trainer's timetable for that day
    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dayName = dayNames[new Date(todoDate).getDay()];

    const ttResult = await pool.query(
      `SELECT t.slot_number, t.class_name, t.room, t.institution
       FROM timetable t
       WHERE t.trainer_id=$1 AND t.day=$2 AND t.class_name IS NOT NULL`,
      [req.user.id, dayName]
    );
    const ttMap = {};
    for(const r of ttResult.rows) ttMap[r.slot_number] = r;

    // Also get duties for that day
    const dutiesResult = await pool.query(
      `SELECT slot_number, class_name FROM duties WHERE trainer_id=$1 AND date=$2`,
      [req.user.id, todoDate]
    );
    const dutiesMap = {};
    for(const r of dutiesResult.rows) dutiesMap[r.slot_number] = r;

    // Generate slot skeleton
    const generatedSlots = generateSlots(punch_in_time);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Upsert todo
      const todoRes = await client.query(
        `INSERT INTO todos (user_id, date, punch_in_time)
         VALUES ($1,$2,$3)
         ON CONFLICT (user_id, date) DO UPDATE SET punch_in_time=$3
         RETURNING *`,
        [req.user.id, todoDate, punch_in_time]
      );
      const todoId = todoRes.rows[0].id;

      // Delete existing slots and recreate
      await client.query('DELETE FROM todo_slots WHERE todo_id=$1', [todoId]);

      for(const slot of generatedSlots) {
        // Find matching timetable slot
        const ttSlot = TIMETABLE_SLOTS.find(s => s.start === slot.slot_start);
        const slotNum = ttSlot ? TIMETABLE_SLOTS.indexOf(ttSlot) + 1 : null;
        const classInfo = slotNum ? (dutiesMap[slotNum] || ttMap[slotNum]) : null;

        await client.query(
          `INSERT INTO todo_slots (todo_id, slot_start, slot_end, slot_label, class_name, is_class, task)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [todoId, slot.slot_start, slot.slot_end, slot.slot_label,
           classInfo?.class_name || null,
           !!classInfo,
           classInfo ? `📚 ${classInfo.class_name}${classInfo.room?' @ '+classInfo.room:''}` : null]
        );
      }
      await client.query('COMMIT');

      // Return full todo
      const result = await client.query(
        `SELECT t.*, json_agg(
          json_build_object('id',ts.id,'slot_start',ts.slot_start,'slot_end',ts.slot_end,
            'slot_label',ts.slot_label,'task',ts.task,'class_name',ts.class_name,
            'is_class',ts.is_class,'is_locked',ts.is_locked,'comments',null)
          ORDER BY ts.slot_start
        ) as slots
        FROM todos t LEFT JOIN todo_slots ts ON ts.todo_id=t.id
        WHERE t.id=$1 GROUP BY t.id`,
        [todoId]
      );
      res.json(result.rows[0]);
    } catch(e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT update a slot task
router.put('/slots/:id', auth, async (req, res) => {
  try {
    const { task } = req.body;
    const result = await pool.query(
      `UPDATE todo_slots SET task=$1 WHERE id=$2
       AND todo_id IN (SELECT id FROM todos WHERE user_id=$3)
       RETURNING *`,
      [task, req.params.id, req.user.id]
    );
    if(!result.rows.length) return res.status(403).json({ error: 'Not allowed' });
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT submit todo for the day
router.put('/submit', auth, async (req, res) => {
  try {
    const { date } = req.body;
    const today = date || new Date().toISOString().split('T')[0];
    await pool.query(
      `UPDATE todos SET submitted_at=NOW() WHERE user_id=$1 AND date=$2`,
      [req.user.id, today]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET history (last 10 working days) for own todos
router.get('/history', auth, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'super_admin';
    const { user_id } = req.query;
    const targetId = isAdmin && user_id ? user_id : req.user.id;

    const result = await pool.query(
      `SELECT t.date, t.punch_in_time, t.submitted_at,
        u.name as user_name,
        COUNT(ts.id) as total_slots,
        COUNT(CASE WHEN ts.task IS NOT NULL AND ts.task!='' THEN 1 END) as filled_slots
       FROM todos t
       JOIN users u ON u.id=t.user_id
       LEFT JOIN todo_slots ts ON ts.todo_id=t.id
       WHERE t.user_id=$1
       AND t.date >= CURRENT_DATE - INTERVAL '14 days'
       GROUP BY t.id, u.name
       ORDER BY t.date DESC
       LIMIT 10`,
      [targetId]
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET specific date todo (admin can see anyone's)
router.get('/date/:date', auth, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'super_admin';
    const { user_id } = req.query;
    const targetId = isAdmin && user_id ? parseInt(user_id) : req.user.id;

    const result = await pool.query(
      `SELECT t.*, u.name as user_name,
        json_agg(
          json_build_object(
            'id',ts.id,'slot_start',ts.slot_start,'slot_end',ts.slot_end,
            'slot_label',ts.slot_label,'task',ts.task,'class_name',ts.class_name,
            'is_class',ts.is_class,
            'comments',(SELECT json_agg(json_build_object('id',tc.id,'author_id',tc.author_id,'author_name',tc.author_name,'comment',tc.comment,'type',tc.type,'created_at',tc.created_at))
                        FROM todo_comments tc WHERE tc.todo_slot_id=ts.id)
          ) ORDER BY ts.slot_start
        ) as slots
       FROM todos t
       JOIN users u ON u.id=t.user_id
       LEFT JOIN todo_slots ts ON ts.todo_id=t.id
       WHERE t.user_id=$1 AND t.date=$2
       GROUP BY t.id, u.name`,
      [targetId, req.params.date]
    );
    res.json(result.rows[0] || null);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET admin overview — who filled today and who didn't
router.get('/admin/overview', auth, async (req, res) => {
  try {
    if(req.user.role !== 'super_admin') return res.status(403).json({ error: 'Admin only' });
    const { date } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];

    const result = await pool.query(
      `SELECT u.id, u.name, u.designation, u.profile_picture,
        t.id as todo_id, t.punch_in_time, t.submitted_at,
        COUNT(ts.id) as total_slots,
        COUNT(CASE WHEN ts.task IS NOT NULL AND ts.task!='' THEN 1 END) as filled_slots,
        COUNT(tc.id) as pending_explanations
       FROM users u
       LEFT JOIN todos t ON t.user_id=u.id AND t.date=$1
       LEFT JOIN todo_slots ts ON ts.todo_id=t.id
       LEFT JOIN todo_comments tc ON tc.todo_slot_id=ts.id AND tc.type='explanation_request'
       WHERE u.is_active=true AND u.role != 'super_admin'
       GROUP BY u.id, t.id
       ORDER BY t.submitted_at DESC NULLS LAST, u.name`,
      [targetDate]
    );
    res.json({ date: targetDate, trainers: result.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST admin asks for explanation on a slot
router.post('/slots/:id/comment', auth, async (req, res) => {
  try {
    const { comment, type } = req.body;
    if(!comment) return res.status(400).json({ error: 'Comment required' });

    // Get slot + todo owner info
    const slotInfo = await pool.query(
      `SELECT ts.*, t.user_id, t.date, u.name as trainer_name
       FROM todo_slots ts
       JOIN todos t ON t.id=ts.todo_id
       JOIN users u ON u.id=t.user_id
       WHERE ts.id=$1`,
      [req.params.id]
    );
    if(!slotInfo.rows.length) return res.status(404).json({ error: 'Slot not found' });
    const slot = slotInfo.rows[0];

    const commentRes = await pool.query(
      `INSERT INTO todo_comments (todo_slot_id, author_id, author_name, comment, type)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, req.user.id, req.user.name, comment, type||'explanation_request']
    );

    // Send notification to trainer
    if(slot.user_id !== req.user.id) {
      await pool.query(
        `INSERT INTO notifications (user_id, title, message, type)
         VALUES ($1,$2,$3,$4)`,
        [slot.user_id,
         '📋 Explanation Requested on To Do',
         `${req.user.name} has asked for an explanation on your To Do slot (${slot.slot_start}–${slot.slot_end}) for ${slot.date}`,
         'todo_comment']
      );
    }
    res.status(201).json(commentRes.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST trainer replies to explanation request
router.post('/slots/:id/reply', auth, async (req, res) => {
  try {
    const { comment } = req.body;
    if(!comment) return res.status(400).json({ error: 'Reply required' });

    const commentRes = await pool.query(
      `INSERT INTO todo_comments (todo_slot_id, author_id, author_name, comment, type)
       VALUES ($1,$2,$3,$4,'reply') RETURNING *`,
      [req.params.id, req.user.id, req.user.name, comment]
    );

    // Notify admin who asked
    const adminComments = await pool.query(
      `SELECT DISTINCT author_id FROM todo_comments
       WHERE todo_slot_id=$1 AND type='explanation_request'`,
      [req.params.id]
    );
    for(const ac of adminComments.rows) {
      if(ac.author_id !== req.user.id) {
        await pool.query(
          `INSERT INTO notifications (user_id, title, message, type)
           VALUES ($1,$2,$3,$4)`,
          [ac.author_id,
           '✅ To Do Explanation Received',
           `${req.user.name} has replied to your explanation request`,
           'todo_reply']
        );
      }
    }
    res.status(201).json(commentRes.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

// GET admin pending actions summary
router.get('/admin/pending-summary', auth, async (req, res) => {
  try {
    if(req.user.role !== 'super_admin') return res.status(403).json({ error: 'Admin only' });
    const istOffset = 5*60+30;
    const now = new Date();
    const istDate = new Date(now.getTime() + istOffset*60000);
    const today = istDate.toISOString().split('T')[0];
    const dayOfWeek = istDate.getDay(); // 0=Sun

    // 1. Todo: who hasn't filled today
    const todoResult = await pool.query(`
      SELECT u.id, u.name, u.designation, u.profile_picture,
        t.id as todo_id, t.submitted_at, t.punch_in_time
      FROM users u
      LEFT JOIN todos t ON t.user_id = u.id AND t.date = $1
      WHERE u.is_active = true AND u.role != 'super_admin'
      ORDER BY t.id DESC NULLS LAST, u.name
    `, [today]);

    const todoNotFilled = todoResult.rows.filter(r => !r.todo_id);
    const todoFilled    = todoResult.rows.filter(r => r.todo_id);
    const todoSubmitted = todoResult.rows.filter(r => r.submitted_at);

    // 2. Attendance: sessions from today's timetable not yet marked
    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dayName = dayNames[dayOfWeek];
    const attendancePending = await pool.query(`
      SELECT u.name as trainer_name, t.class_name, t.slot_number
      FROM timetable t
      JOIN users u ON u.id = t.trainer_id
      WHERE t.day = $1 AND t.class_name IS NOT NULL AND t.class_name != ''
      AND NOT EXISTS (
        SELECT 1 FROM attendance_sessions asn
        JOIN sections sec ON sec.id = asn.section_id
        WHERE asn.date = $2
        AND sec.name = t.class_name
        AND asn.trainer_id = t.trainer_id
      )
      ORDER BY t.slot_number
    `, [dayName, today]);

    // 3. Lesson plans pending
    const lpPending = await pool.query(`
      SELECT DISTINCT u.name as trainer_name,
        t.class_name as section_name, t.session_type as domain
      FROM timetable t
      JOIN users u ON u.id = t.trainer_id
      WHERE t.class_name IS NOT NULL AND t.class_name != ''
      AND NOT EXISTS (
        SELECT 1 FROM lesson_plans lp
        WHERE lp.trainer_id = t.trainer_id
        AND lp.class_name = t.class_name
        AND lp.domain = t.session_type
      )
      ORDER BY u.name
      LIMIT 50
    `);

    // Student list pending
    const stuPending = await pool.query(`
      SELECT DISTINCT u.name as trainer_name,
        t.class_name as section_name, t.session_type as domain
      FROM timetable t
      JOIN users u ON u.id = t.trainer_id
      WHERE t.class_name IS NOT NULL AND t.class_name != ''
      AND NOT EXISTS (
        SELECT 1 FROM students s
        JOIN sections sec ON sec.id = s.section_id
        WHERE sec.name = t.class_name
        AND sec.trainer_id = t.trainer_id
      )
      ORDER BY u.name
      LIMIT 50
    `);

    // Sections below 75%
    const atRisk = await pool.query(`
      SELECT sec.name as section_name, sec.institution, sec.domain,
        u.name as trainer_name,
        COUNT(DISTINCT s.id) as total_students,
        COUNT(DISTINCT CASE WHEN att_pct.pct < 40 THEN s.id END) as critical_count
      FROM sections sec
      JOIN users u ON u.id = sec.trainer_id
      JOIN students s ON s.section_id = sec.id AND s.is_active = true
      LEFT JOIN (
        SELECT s2.id as student_id,
          CASE WHEN COUNT(asn.id) > 0
            THEN COUNT(CASE WHEN ar.status='P' THEN 1 END) * 100.0 / COUNT(asn.id)
            ELSE 0 END as pct
        FROM students s2
        CROSS JOIN attendance_sessions asn
        LEFT JOIN attendance_records ar ON ar.student_id = s2.id AND ar.session_id = asn.id
        WHERE asn.section_id = s2.section_id
        GROUP BY s2.id
      ) att_pct ON att_pct.student_id = s.id
      WHERE sec.is_active = true
      GROUP BY sec.id, sec.name, sec.institution, sec.domain, u.name
      HAVING COUNT(DISTINCT CASE WHEN att_pct.pct < 40 THEN s.id END) > 0
      ORDER BY critical_count DESC
      LIMIT 20
    `);

    // 4. CMP compliance — interactions pending this month
    const cmpResult = await pool.query(`
      SELECT
        u.name as mentor_name,
        COUNT(DISTINCT m.id) as total_mentees,
        COUNT(DISTINCT ci.mentee_id) as met_count
      FROM users u
      JOIN cmp_mentees m ON m.mentor_id = u.id
      LEFT JOIN cmp_interactions ci ON ci.mentee_id = m.id
        AND EXTRACT(MONTH FROM ci.interaction_date) = EXTRACT(MONTH FROM NOW())
        AND EXTRACT(YEAR FROM ci.interaction_date) = EXTRACT(YEAR FROM NOW())
      WHERE u.is_active = true
      GROUP BY u.id, u.name
      HAVING COUNT(DISTINCT m.id) > 0
      ORDER BY met_count ASC
    `).catch(() => ({ rows: [] }));

    res.json({
      date: today,
      todo: {
        not_filled: todoNotFilled.map(r => ({ id:r.id, name:r.name, designation:r.designation, pic:r.profile_picture })),
        filled_count: todoFilled.length,
        submitted_count: todoSubmitted.length,
        total: todoResult.rows.length
      },
      attendance: {
        pending_sessions: attendancePending.rows,
        pending_count: attendancePending.rows.length
      },
      lesson_plans: {
        lp_pending: lpPending.rows,
        lp_pending_count: lpPending.rows.length,
        students_pending: stuPending.rows,
        students_pending_count: stuPending.rows.length,
        at_risk_sections: atRisk.rows,
        at_risk_count: atRisk.rows.length
      },
      mentorship: {
        mentors: cmpResult.rows,
        behind_count: cmpResult.rows.filter(r => parseInt(r.met_count) < parseInt(r.total_mentees) * 0.5).length,
        total_mentors: cmpResult.rows.length
      }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
