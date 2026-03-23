const router = require('express').Router();
const pool = require('../models/db');
const { auth, adminOnly } = require('../middleware/auth');

// GET /api/reports/load - trainer load summary
router.get('/load', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.name, u.employee_id,
        COUNT(t.id) as total_classes,
        COUNT(CASE WHEN t.institution ILIKE '%MRU%' THEN 1 END) as mru_classes,
        COUNT(CASE WHEN t.institution ILIKE '%MRIIRS%' THEN 1 END) as mriirs_classes,
        COUNT(CASE WHEN t.institution ILIKE('%CDOE%') THEN 1 END) as cdoe_classes
      FROM users u
      LEFT JOIN timetable t ON u.id = t.trainer_id AND t.class_name IS NOT NULL AND t.class_name != ''
      WHERE u.role = 'trainer'
      GROUP BY u.id, u.name, u.employee_id
      ORDER BY u.name
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error', message: err.message });
  }
});

// GET /api/reports/stats - dashboard stats
router.get('/stats', auth, async (req, res) => {
  try {
    const trainerCount = await pool.query("SELECT COUNT(*) FROM users WHERE role='trainer' AND is_active=true");
    const classCount = await pool.query("SELECT COUNT(*) FROM timetable WHERE class_name IS NOT NULL AND class_name != ''");
    const dutyCount = await pool.query("SELECT COUNT(*) FROM duties WHERE date >= CURRENT_DATE");

    res.json({
      total_trainers: parseInt(trainerCount.rows[0].count),
      total_classes: parseInt(classCount.rows[0].count),
      upcoming_duties: parseInt(dutyCount.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error', message: err.message });
  }
});

// GET /api/reports/duties - duty history
router.get('/duties', auth, adminOnly, async (req, res) => {
  try {
    const { from, to } = req.query;
    let query = `SELECT d.*, u.name as trainer_name, a.name as assigned_by_name
                 FROM duties d JOIN users u ON d.trainer_id = u.id
                 LEFT JOIN users a ON d.assigned_by = a.id WHERE 1=1`;
    const params = [];
    if (from) { params.push(from); query += ` AND d.date >= $${params.length}`; }
    if (to) { params.push(to); query += ` AND d.date <= $${params.length}`; }
    query += ' ORDER BY d.date DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

// ── REPORTS PAGE TILES ────────────────────────────────

// GET my attendance summary (trainer's own sections)
router.get('/my-attendance', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.id, s.name as section_name, s.institution, sd.domain,
        COUNT(DISTINCT st.id) as total_students,
        COUNT(DISTINCT asn.id) as sessions_conducted,
        ROUND(
          COUNT(DISTINCT CASE WHEN ar.status='P' THEN ar.id END)*100.0/
          NULLIF(COUNT(DISTINCT asn.id)*NULLIF(COUNT(DISTINCT st.id),0),0)
        ,1) as avg_pct,
        COUNT(DISTINCT CASE WHEN sub.pct < 75 THEN sub.sid END) as below_75,
        COUNT(DISTINCT CASE WHEN sub.pct < 60 THEN sub.sid END) as below_60
      FROM sections s
      JOIN section_domains sd ON sd.section_id=s.id AND sd.trainer_id=$1 AND sd.is_active=true
      LEFT JOIN students st ON st.section_id=s.id AND st.is_active=true
      LEFT JOIN attendance_sessions asn ON asn.section_id=s.id AND asn.trainer_id=$1
      LEFT JOIN attendance_records ar ON ar.session_id=asn.id
      LEFT JOIN (
        SELECT st2.id as sid, sec2.id as secid,
          ROUND(COUNT(CASE WHEN ar2.status='P' THEN 1 END)*100.0/NULLIF(COUNT(asn2.id),0),1) as pct
        FROM students st2 JOIN sections sec2 ON sec2.id=st2.section_id
        JOIN attendance_sessions asn2 ON asn2.section_id=sec2.id AND asn2.trainer_id=$1
        LEFT JOIN attendance_records ar2 ON ar2.student_id=st2.id AND ar2.session_id=asn2.id
        WHERE st2.is_active=true GROUP BY st2.id, sec2.id
      ) sub ON sub.secid=s.id
      WHERE s.is_active=true
      GROUP BY s.id, s.name, s.institution, sd.domain
      ORDER BY s.name
    `, [req.user.id]);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET my lesson plan status
router.get('/my-lessonplans', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT t.class_name, t.session_type as domain, t.institution,
        EXISTS(
          SELECT 1 FROM lesson_plans lp
          WHERE lp.trainer_id=$1 AND lp.class_name=t.class_name AND lp.domain=t.session_type
        ) as uploaded
      FROM timetable t
      WHERE t.trainer_id=$1 AND t.class_name IS NOT NULL AND t.class_name != ''
      ORDER BY t.class_name
    `, [req.user.id]);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET my todo history — last 10 working days
router.get('/my-todo-history', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.date, t.punch_in_time, t.submitted_at,
        COUNT(ts.id) as total_slots,
        COUNT(CASE WHEN ts.task IS NOT NULL AND ts.task != '' THEN 1 END) as filled_slots
      FROM todos t
      LEFT JOIN todo_slots ts ON ts.todo_id=t.id
      WHERE t.user_id=$1
        AND t.date >= CURRENT_DATE - INTERVAL '14 days'
        AND EXTRACT(DOW FROM t.date) BETWEEN 1 AND 6
      GROUP BY t.id, t.date, t.punch_in_time, t.submitted_at
      ORDER BY t.date DESC
      LIMIT 10
    `, [req.user.id]);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET my duties
router.get('/my-duties', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT d.*, u.name as assigned_by_name
      FROM duties d
      LEFT JOIN users a ON a.id=d.assigned_by
      LEFT JOIN users u ON u.id=d.assigned_by
      WHERE d.trainer_id=$1
      ORDER BY d.date DESC
      LIMIT 30
    `, [req.user.id]);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET all sections attendance (admin)
router.get('/all-attendance', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.id, s.name as section_name, s.institution,
        sd.domain, u.name as trainer_name,
        COUNT(DISTINCT st.id) as total_students,
        COUNT(DISTINCT asn.id) as sessions_conducted,
        ROUND(
          COUNT(DISTINCT CASE WHEN ar.status='P' THEN ar.id END)*100.0/
          NULLIF(COUNT(DISTINCT asn.id)*NULLIF(COUNT(DISTINCT st.id),0),0)
        ,1) as avg_pct,
        COUNT(DISTINCT CASE WHEN sub.pct < 75 THEN sub.sid END) as below_75
      FROM sections s
      JOIN section_domains sd ON sd.section_id=s.id AND sd.is_active=true
      JOIN users u ON u.id=sd.trainer_id
      LEFT JOIN students st ON st.section_id=s.id AND st.is_active=true
      LEFT JOIN attendance_sessions asn ON asn.section_id=s.id AND asn.trainer_id=sd.trainer_id
      LEFT JOIN attendance_records ar ON ar.session_id=asn.id
      LEFT JOIN (
        SELECT st2.id as sid, sec2.id as secid, asn2.trainer_id as tid,
          ROUND(COUNT(CASE WHEN ar2.status='P' THEN 1 END)*100.0/NULLIF(COUNT(asn2.id),0),1) as pct
        FROM students st2 JOIN sections sec2 ON sec2.id=st2.section_id
        JOIN attendance_sessions asn2 ON asn2.section_id=sec2.id
        LEFT JOIN attendance_records ar2 ON ar2.student_id=st2.id AND ar2.session_id=asn2.id
        WHERE st2.is_active=true GROUP BY st2.id, sec2.id, asn2.trainer_id
      ) sub ON sub.secid=s.id AND sub.tid=sd.trainer_id
      WHERE s.is_active=true
      GROUP BY s.id, s.name, s.institution, sd.domain, u.name
      ORDER BY avg_pct ASC NULLS LAST
    `);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET mentorship compliance (admin)
router.get('/mentorship', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.name as mentor_name, u.designation,
        COUNT(DISTINCT cm.id) as total_mentees,
        COUNT(DISTINCT ci.mentee_id) as interacted_this_month,
        COUNT(DISTINCT CASE WHEN ci2.id IS NOT NULL THEN cm.id END) as has_any_interaction
      FROM users u
      JOIN cmp_mentees cm ON cm.mentor_id=u.id
      LEFT JOIN cmp_interactions ci ON ci.mentee_id=cm.id
        AND EXTRACT(MONTH FROM ci.interaction_date)=EXTRACT(MONTH FROM NOW())
        AND EXTRACT(YEAR FROM ci.interaction_date)=EXTRACT(YEAR FROM NOW())
      LEFT JOIN cmp_interactions ci2 ON ci2.mentee_id=cm.id
      WHERE u.is_active=true
      GROUP BY u.id, u.name, u.designation
      HAVING COUNT(DISTINCT cm.id) > 0
      ORDER BY interacted_this_month ASC
    `).catch(() => ({ rows: [] }));
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET todo compliance all trainers (admin)
router.get('/todo-compliance', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.name, u.designation, u.profile_picture,
        COUNT(DISTINCT t.date) as days_filled,
        COUNT(DISTINCT CASE WHEN t.submitted_at IS NOT NULL THEN t.date END) as days_submitted,
        COUNT(DISTINCT CASE WHEN t.date >= CURRENT_DATE - INTERVAL '7 days' AND EXTRACT(DOW FROM t.date) BETWEEN 1 AND 6 THEN t.date END) as this_week
      FROM users u
      LEFT JOIN todos t ON t.user_id=u.id AND t.date >= CURRENT_DATE - INTERVAL '30 days'
      WHERE u.is_active=true AND u.role='trainer'
      GROUP BY u.id, u.name, u.designation, u.profile_picture
      ORDER BY days_submitted DESC
    `);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
