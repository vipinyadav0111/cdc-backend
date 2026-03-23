const router = require('express').Router();
const pool   = require('../models/db');
const { auth, adminOnly } = require('../middleware/auth');

// ── GET KPI overview ──────────────────────────────────────────────
router.get('/overview', auth, adminOnly, async (req, res) => {
  try {
    const { from, to } = req.query;
    const dateFrom = from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
    const dateTo   = to   || new Date().toISOString().split('T')[0];

    // Sessions conducted in range
    const conducted = await pool.query(
      `SELECT COUNT(*) as count FROM attendance_sessions WHERE date >= $1 AND date <= $2`,
      [dateFrom, dateTo]
    );

    // Sessions planned: count timetable slots × working days in range
    const workingDays = await pool.query(`
      SELECT COUNT(*) as days FROM generate_series($1::date, $2::date, '1 day'::interval) d
      WHERE EXTRACT(DOW FROM d) BETWEEN 1 AND 6
    `, [dateFrom, dateTo]);

    const ttSlots = await pool.query(`SELECT COUNT(*) as slots FROM timetable WHERE class_name IS NOT NULL AND class_name != ''`);
    const wdays = parseInt(workingDays.rows[0].days);
    const slotsPerDay = parseInt(ttSlots.rows[0].slots) / 6; // 6 working days a week
    const planned = Math.round(slotsPerDay * wdays);

    // Average attendance
    const avgAtt = await pool.query(`
      SELECT ROUND(AVG(pct),1) as avg_pct FROM (
        SELECT
          CASE WHEN COUNT(DISTINCT asn.id) > 0
            THEN COUNT(DISTINCT CASE WHEN ar.status='P' THEN ar.id END) * 100.0 / COUNT(DISTINCT asn.id)
            ELSE 0 END as pct
        FROM students st
        JOIN sections sec ON st.section_id = sec.id
        JOIN attendance_sessions asn ON asn.section_id = sec.id AND asn.date >= $1 AND asn.date <= $2
        LEFT JOIN attendance_records ar ON ar.student_id = st.id AND ar.session_id = asn.id
        WHERE st.is_active = true AND sec.is_active = true
        GROUP BY st.id
      ) sub
    `, [dateFrom, dateTo]);

    // At-risk sections (>20% students below 40%)
    const atRisk = await pool.query(`
      SELECT COUNT(*) as count FROM (
        SELECT sec.id,
          COUNT(DISTINCT st.id) as total,
          COUNT(DISTINCT CASE WHEN
            (SELECT COALESCE(COUNT(ar2.id)*100.0/NULLIF(COUNT(asn2.id),0),0)
             FROM attendance_sessions asn2
             LEFT JOIN attendance_records ar2 ON ar2.session_id=asn2.id AND ar2.student_id=st.id AND ar2.status='P'
             WHERE asn2.section_id=sec.id AND asn2.date >= $1 AND asn2.date <= $2) < 40
          THEN st.id END) as below40
        FROM sections sec
        JOIN students st ON st.section_id = sec.id AND st.is_active = true
        WHERE sec.is_active = true
        GROUP BY sec.id
        HAVING COUNT(DISTINCT st.id) > 0
           AND COUNT(DISTINCT CASE WHEN
            (SELECT COALESCE(COUNT(ar2.id)*100.0/NULLIF(COUNT(asn2.id),0),0)
             FROM attendance_sessions asn2
             LEFT JOIN attendance_records ar2 ON ar2.session_id=asn2.id AND ar2.student_id=st.id AND ar2.status='P'
             WHERE asn2.section_id=sec.id AND asn2.date >= $1 AND asn2.date <= $2) < 40
          THEN st.id END) * 100.0 / NULLIF(COUNT(DISTINCT st.id),0) > 20
      ) sub
    `, [dateFrom, dateTo]);

    // Trainer count
    const activeTrainers = await pool.query(
      `SELECT COUNT(*) as count FROM users WHERE is_active=true AND role='trainer'`
    );

    res.json({
      conducted:       parseInt(conducted.rows[0].count),
      planned:         planned,
      completion_pct:  planned > 0 ? Math.round(parseInt(conducted.rows[0].count) * 100 / planned) : 0,
      avg_attendance:  parseFloat(avgAtt.rows[0].avg_pct) || 0,
      at_risk_sections:parseInt(atRisk.rows[0].count),
      active_trainers: parseInt(activeTrainers.rows[0].count),
      date_from:       dateFrom,
      date_to:         dateTo,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET weekly sessions chart data ───────────────────────────────
router.get('/weekly', auth, adminOnly, async (req, res) => {
  try {
    const { from, to } = req.query;
    const dateFrom = from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
    const dateTo   = to   || new Date().toISOString().split('T')[0];

    // Conducted per week
    const conducted = await pool.query(`
      SELECT
        DATE_TRUNC('week', date::date)::date as week_start,
        COUNT(*) as conducted
      FROM attendance_sessions
      WHERE date >= $1 AND date <= $2
      GROUP BY week_start
      ORDER BY week_start
    `, [dateFrom, dateTo]);

    // Build week array
    const weeks = [];
    const start = new Date(dateFrom);
    const end   = new Date(dateTo);
    // Align to Monday
    const day = start.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    start.setDate(start.getDate() + diff);

    while (start <= end) {
      const wStr = start.toISOString().split('T')[0];
      const cRow = conducted.rows.find(r => r.week_start.toISOString?.().slice(0,10) === wStr || String(r.week_start).slice(0,10) === wStr);

      // Working days in this week within range
      const wEnd = new Date(start); wEnd.setDate(wEnd.getDate() + 5);
      const wFrom2 = new Date(Math.max(start, new Date(dateFrom)));
      const wTo2   = new Date(Math.min(wEnd,  new Date(dateTo)));
      const wDays  = Math.max(0, Math.round((wTo2 - wFrom2) / 86400000) + 1);

      weeks.push({
        week: wStr,
        label: start.toLocaleDateString('en-IN', { day:'numeric', month:'short' }),
        conducted: parseInt(cRow?.conducted || 0),
        planned: Math.round((parseInt(ttSlotsPerDay || 10)) * wDays),
      });
      start.setDate(start.getDate() + 7);
    }

    // Get avg timetable slots per day for planning
    const ttSlots = await pool.query(`SELECT COUNT(*) as slots FROM timetable WHERE class_name IS NOT NULL AND class_name != ''`);
    const perDay  = Math.round(parseInt(ttSlots.rows[0].slots) / 6);

    // Recalculate planned with correct perDay
    const result = weeks.map(w => ({ ...w, planned: Math.round(perDay * Math.min(6, w.planned / (perDay||1))) }));

    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET domain attendance health ──────────────────────────────────
router.get('/domains', auth, adminOnly, async (req, res) => {
  try {
    const { from, to } = req.query;
    const dateFrom = from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
    const dateTo   = to   || new Date().toISOString().split('T')[0];

    const result = await pool.query(`
      SELECT
        sec.domain,
        COUNT(DISTINCT st.id) as total_students,
        ROUND(AVG(CASE WHEN asn_count.total > 0 THEN asn_count.present * 100.0 / asn_count.total ELSE 0 END),1) as avg_pct,
        COUNT(DISTINCT CASE WHEN asn_count.total > 0 AND asn_count.present * 100.0 / asn_count.total < 75 THEN st.id END) as below75,
        COUNT(DISTINCT CASE WHEN asn_count.total > 0 AND asn_count.present * 100.0 / asn_count.total >= 75 AND asn_count.present * 100.0 / asn_count.total < 80 THEN st.id END) as warning,
        COUNT(DISTINCT CASE WHEN asn_count.total > 0 AND asn_count.present * 100.0 / asn_count.total >= 80 THEN st.id END) as safe
      FROM sections sec
      JOIN students st ON st.section_id = sec.id AND st.is_active = true
      JOIN (
        SELECT asn.section_id,
          COUNT(DISTINCT asn.id) as total,
          COUNT(DISTINCT CASE WHEN ar.status='P' THEN ar.id END) as present,
          ar.student_id
        FROM attendance_sessions asn
        LEFT JOIN attendance_records ar ON ar.session_id = asn.id
        WHERE asn.date >= $1 AND asn.date <= $2
        GROUP BY asn.section_id, ar.student_id
      ) asn_count ON asn_count.section_id = sec.id AND asn_count.student_id = st.id
      WHERE sec.is_active = true AND sec.domain IS NOT NULL
      GROUP BY sec.domain
      ORDER BY avg_pct ASC
    `, [dateFrom, dateTo]);

    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET section health list ───────────────────────────────────────
router.get('/sections', auth, adminOnly, async (req, res) => {
  try {
    const { from, to, institution, domain } = req.query;
    const dateFrom = from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
    const dateTo   = to   || new Date().toISOString().split('T')[0];

    const params = [dateFrom, dateTo];
    let extra = '';
    if (institution && institution !== 'all') { params.push(institution); extra += ` AND sec.institution=$${params.length}`; }
    if (domain && domain !== 'all')           { params.push(domain);      extra += ` AND sec.domain=$${params.length}`; }

    const result = await pool.query(`
      SELECT
        sec.id, sec.name, sec.institution, sec.domain, sec.branch,
        u.name as trainer_name,
        COUNT(DISTINCT st.id) as total_students,
        COUNT(DISTINCT asn.id) as sessions_conducted,
        COUNT(DISTINCT CASE WHEN student_pct.pct < 75 THEN student_pct.student_id END) as below75,
        COUNT(DISTINCT CASE WHEN student_pct.pct >= 75 AND student_pct.pct < 80 THEN student_pct.student_id END) as warning,
        COUNT(DISTINCT CASE WHEN student_pct.pct >= 80 THEN student_pct.student_id END) as safe,
        COUNT(DISTINCT CASE WHEN student_pct.pct < 40 THEN student_pct.student_id END) as below40,
        ROUND(AVG(student_pct.pct),1) as avg_pct
      FROM sections sec
      JOIN users u ON sec.trainer_id = u.id
      JOIN students st ON st.section_id = sec.id AND st.is_active = true
      LEFT JOIN attendance_sessions asn ON asn.section_id = sec.id AND asn.date >= $1 AND asn.date <= $2
      LEFT JOIN (
        SELECT
          ar_sub.student_id,
          asn_sub.section_id,
          COALESCE(COUNT(CASE WHEN ar_sub.status='P' THEN 1 END)*100.0/NULLIF(COUNT(asn_sub.id),0),0) as pct
        FROM attendance_sessions asn_sub
        LEFT JOIN attendance_records ar_sub ON ar_sub.session_id = asn_sub.id
        WHERE asn_sub.date >= $1 AND asn_sub.date <= $2
        GROUP BY ar_sub.student_id, asn_sub.section_id
      ) student_pct ON student_pct.section_id = sec.id AND student_pct.student_id = st.id
      WHERE sec.is_active = true ${extra}
      GROUP BY sec.id, sec.name, sec.institution, sec.domain, sec.branch, u.name
      HAVING COUNT(DISTINCT st.id) > 0
      ORDER BY avg_pct ASC NULLS LAST
    `, params);

    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET trainer health scores ─────────────────────────────────────
// Score: 25% attendance_marked + 20% LP_uploaded + 10% plan_adherence + 45% todo_filled
router.get('/trainers', auth, adminOnly, async (req, res) => {
  try {
    const { from, to } = req.query;
    const dateFrom = from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
    const dateTo   = to   || new Date().toISOString().split('T')[0];

    const trainers = await pool.query(`
      SELECT u.id, u.name, u.designation,
        -- Sessions: due vs conducted
        COUNT(DISTINCT asn.id) as sessions_conducted,

        -- Attendance marking rate (sessions with at least 1 record)
        COUNT(DISTINCT CASE WHEN ar_check.session_id IS NOT NULL THEN asn.id END) as sessions_marked,

        -- Lesson plans uploaded vs sections owned
        COUNT(DISTINCT sec.id) as sections_owned,
        COUNT(DISTINCT lp.id) as plans_uploaded,

        -- Plan adherence: sessions taught on topic vs total sessions conducted
        COUNT(DISTINCT CASE WHEN at.lesson_plan_session_id IS NOT NULL THEN asn.id END) as on_topic,
        COUNT(DISTINCT CASE WHEN at.not_covered=true THEN asn.id END) as not_covered,

        -- Todo filled days
        COUNT(DISTINCT td.date) as todo_days_filled

      FROM users u
      LEFT JOIN sections sec ON sec.trainer_id = u.id AND sec.is_active = true
      LEFT JOIN attendance_sessions asn ON asn.trainer_id = u.id AND asn.date >= $1 AND asn.date <= $2
      LEFT JOIN (
        SELECT DISTINCT session_id FROM attendance_records
      ) ar_check ON ar_check.session_id = asn.id
      LEFT JOIN lesson_plans lp ON lp.trainer_id = u.id
      LEFT JOIN attendance_topics at ON at.attendance_session_id = asn.id
      LEFT JOIN todos td ON td.user_id = u.id AND td.date >= $1 AND td.date <= $2 AND td.submitted_at IS NOT NULL
      WHERE u.is_active = true AND u.role IN ('trainer','super_admin')
      GROUP BY u.id, u.name, u.designation
      ORDER BY u.name
    `, [dateFrom, dateTo]);

    // Working days in range
    const wdResult = await pool.query(`
      SELECT COUNT(*) as days FROM generate_series($1::date, $2::date, '1 day'::interval) d
      WHERE EXTRACT(DOW FROM d) BETWEEN 1 AND 6
    `, [dateFrom, dateTo]);
    const workingDays = parseInt(wdResult.rows[0].days) || 1;

    const scored = trainers.rows.map(t => {
      const conducted   = parseInt(t.sessions_conducted) || 0;
      const marked      = parseInt(t.sessions_marked)    || 0;
      const sections    = parseInt(t.sections_owned)     || 0;
      const plans       = parseInt(t.plans_uploaded)     || 0;
      const onTopic     = parseInt(t.on_topic)           || 0;
      const todoDays    = parseInt(t.todo_days_filled)   || 0;

      // Component scores (0-100 each)
      const attMarkScore   = conducted > 0 ? Math.round(marked / conducted * 100) : 100;
      const lpScore        = sections  > 0 ? Math.round(plans  / sections  * 100) : 100;
      const adherenceScore = conducted > 0 ? Math.round(onTopic / conducted * 100) : 100;
      const todoScore      = Math.min(100, Math.round(todoDays / workingDays * 100));

      // Weighted: 25% att marking + 20% LP + 10% adherence + 45% todo
      const overall = Math.round(
        attMarkScore * 0.25 +
        lpScore      * 0.20 +
        adherenceScore * 0.10 +
        todoScore    * 0.45
      );

      return {
        ...t,
        working_days:     workingDays,
        att_mark_score:   attMarkScore,
        lp_score:         lpScore,
        adherence_score:  adherenceScore,
        todo_score:       todoScore,
        overall_score:    overall,
      };
    });

    res.json(scored);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET student drill-down for a section ─────────────────────────
router.get('/section-students/:section_id', auth, adminOnly, async (req, res) => {
  try {
    const { from, to } = req.query;
    const dateFrom = from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
    const dateTo   = to   || new Date().toISOString().split('T')[0];

    const result = await pool.query(`
      SELECT
        st.roll_no, st.name,
        COUNT(DISTINCT asn.id) as total_sessions,
        COUNT(DISTINCT CASE WHEN ar.status='P' THEN ar.id END) as present,
        ROUND(COALESCE(COUNT(DISTINCT CASE WHEN ar.status='P' THEN ar.id END)*100.0/NULLIF(COUNT(DISTINCT asn.id),0),0),1) as pct
      FROM students st
      LEFT JOIN attendance_sessions asn ON asn.section_id = st.section_id AND asn.date >= $1 AND asn.date <= $2
      LEFT JOIN attendance_records ar ON ar.student_id = st.id AND ar.session_id = asn.id
      WHERE st.section_id = $3 AND st.is_active = true
      GROUP BY st.id, st.roll_no, st.name
      ORDER BY pct ASC
    `, [dateFrom, dateTo, req.params.section_id]);

    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
