const router = require('express').Router();
const pool   = require('../models/db');
const { auth, adminOnly } = require('../middleware/auth');
const multer = require('multer');
const XLSX   = require('xlsx');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Schema + Migration ───────────────────────────────────────────
// Runs on every server start. IF NOT EXISTS is safe to re-run.
// The ALTER TABLE steps handle upgrading old Railway deployments
// that had the old schema (section_id-based).
const setup = async () => {
  // 1. Create tables fresh if they don't exist at all
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lesson_plans (
      id             SERIAL PRIMARY KEY,
      trainer_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
      class_name     VARCHAR(150),
      institution    VARCHAR(20),
      domain         VARCHAR(50) NOT NULL,
      semester       VARCHAR(60) DEFAULT 'Even Semester 2026',
      total_sessions INTEGER DEFAULT 0,
      uploaded_at    TIMESTAMP DEFAULT NOW(),
      uploaded_by    INTEGER REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS lesson_plan_sessions (
      id           SERIAL PRIMARY KEY,
      plan_id      INTEGER REFERENCES lesson_plans(id) ON DELETE CASCADE,
      session_no   INTEGER NOT NULL,
      planned_date DATE,
      topic        TEXT NOT NULL,
      UNIQUE(plan_id, session_no)
    );
    CREATE TABLE IF NOT EXISTS attendance_topics (
      id                     SERIAL PRIMARY KEY,
      attendance_session_id  INTEGER REFERENCES attendance_sessions(id) ON DELETE CASCADE UNIQUE,
      lesson_plan_session_id INTEGER REFERENCES lesson_plan_sessions(id),
      not_covered            BOOLEAN DEFAULT false,
      comment                TEXT,
      created_at             TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_lp_trainer  ON lesson_plans(trainer_id);
    CREATE INDEX IF NOT EXISTS idx_lps_plan    ON lesson_plan_sessions(plan_id);
    CREATE INDEX IF NOT EXISTS idx_at_session  ON attendance_topics(attendance_session_id);
  `);

  // 2. MIGRATION: Add class_name + institution columns if missing
  //    (old Railway schema had section_id instead)
  await pool.query(`
    ALTER TABLE lesson_plans ADD COLUMN IF NOT EXISTS class_name  VARCHAR(150);
    ALTER TABLE lesson_plans ADD COLUMN IF NOT EXISTS institution VARCHAR(20);
  `);

  // 3. MIGRATION: Drop old section_id-based unique constraint if it exists
  //    (constraint name from old schema was lesson_plans_trainer_id_section_id_domain_key)
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'lesson_plans_trainer_id_section_id_domain_key'
      ) THEN
        ALTER TABLE lesson_plans
          DROP CONSTRAINT lesson_plans_trainer_id_section_id_domain_key;
      END IF;
    END$$;
  `);

  // 4. Add new unique constraint on (trainer_id, class_name, domain) if missing
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'lesson_plans_trainer_id_class_name_domain_key'
      ) THEN
        ALTER TABLE lesson_plans
          ADD CONSTRAINT lesson_plans_trainer_id_class_name_domain_key
          UNIQUE (trainer_id, class_name, domain);
      END IF;
    END$$;
  `);

  // 5. MIGRATION: Make class_name NOT NULL for existing rows that have it null
  //    (safe: only rows that were already inserted with new schema have data)
  await pool.query(`
    DELETE FROM lesson_plans WHERE class_name IS NULL OR class_name = '';
  `);

  console.log('✅ lesson_plans schema ready');
};
setup().catch(e => console.error('Schema setup error:', e.message));

// ── Helper: notify ────────────────────────────────────────────────
async function notify(userId, title, body) {
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, title, body, type) VALUES ($1,$2,$3,'lesson_plan')`,
      [userId, title, body]
    );
  } catch(e) { /* silent */ }
}

// ── Helper: ensure section exists (auto-create from timetable data) ──
async function ensureSection(client, trainerId, className, institution, domain) {
  const existing = await client.query(
    `SELECT id FROM sections WHERE name=$1 AND trainer_id=$2 AND domain=$3 AND is_active=true LIMIT 1`,
    [className, trainerId, domain]
  );
  if (existing.rows.length) return existing.rows[0].id;
  const created = await client.query(
    `INSERT INTO sections (name, trainer_id, institution, domain, is_active)
     VALUES ($1,$2,$3,$4,true)
     ON CONFLICT (name, domain, institution) DO UPDATE SET trainer_id=$2, is_active=true
     RETURNING id`,
    [className, trainerId, institution || null, domain]
  );
  return created.rows[0].id;
}

// ══════════════════════════════════════════════════════════════════
// MASTER STATUS — pulls directly from timetable as source of truth
// Returns every (trainer, class_name, institution, domain) combo
// with LP status + student list status
// ══════════════════════════════════════════════════════════════════
router.get('/status', auth, async (req, res) => {
  try {
    const isAdmin   = req.user.role === 'super_admin';
    const filterTid = req.query.trainer_id ? parseInt(req.query.trainer_id) : null;

    // Build inner WHERE using plain column names (no alias — alias "tt" is assigned AFTER)
    // This fixes the critical bug where "t.class_name" was used inside the subquery
    // before the alias "t" was defined.
    let innerWhere = `WHERE class_name IS NOT NULL AND class_name != ''`;
    const params = [];

    if (!isAdmin) {
      params.push(req.user.id);
      innerWhere += ` AND trainer_id = $${params.length}`;
    } else if (filterTid) {
      params.push(filterTid);
      innerWhere += ` AND trainer_id = $${params.length}`;
    }
    // Admin with no filter → see ALL trainers, no extra WHERE needed

    const result = await pool.query(`
      SELECT
        tt.trainer_id,
        u.name                                   AS trainer_name,
        u.designation                            AS trainer_designation,
        tt.class_name,
        tt.institution,
        COALESCE(tt.session_type, 'General')     AS domain,

        -- Lesson plan status
        lp.id                                    AS plan_id,
        lp.total_sessions,
        lp.uploaded_at                           AS lp_uploaded_at,
        uploader.name                            AS lp_uploaded_by_name,

        -- Student list status (via sections table)
        s.id                                     AS section_id,
        COALESCE(stu_count.cnt, 0)               AS student_count,

        -- Attendance sessions count
        COALESCE(asn_count.cnt, 0)               AS sessions_conducted

      FROM (
        SELECT DISTINCT trainer_id, class_name, institution, session_type
        FROM timetable
        ${innerWhere}
      ) tt

      JOIN users u
        ON  u.id        = tt.trainer_id
        AND u.is_active = true

      LEFT JOIN lesson_plans lp
        ON  lp.trainer_id = tt.trainer_id
        AND lp.class_name = tt.class_name
        AND lp.domain     = COALESCE(tt.session_type, 'General')

      LEFT JOIN users uploader
        ON  uploader.id = lp.uploaded_by

      LEFT JOIN sections s
        ON  s.name       = tt.class_name
        AND s.trainer_id = tt.trainer_id
        AND s.domain     = COALESCE(tt.session_type, 'General')
        AND s.is_active  = true

      LEFT JOIN (
        SELECT section_id, COUNT(*) AS cnt
        FROM students
        WHERE is_active = true
        GROUP BY section_id
      ) stu_count ON stu_count.section_id = s.id

      LEFT JOIN (
        SELECT section_id, COUNT(*) AS cnt
        FROM attendance_sessions
        GROUP BY section_id
      ) asn_count ON asn_count.section_id = s.id

      ORDER BY u.name, tt.institution, tt.class_name, tt.session_type
    `, params);

    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET all trainers list (for admin filter dropdown) ─────────────
router.get('/trainers', auth, adminOnly, async (req, res) => {
  try {
    // Only trainers who have timetable entries
    const result = await pool.query(`
      SELECT DISTINCT u.id, u.name, u.designation
      FROM users u
      JOIN timetable t ON t.trainer_id = u.id
      WHERE u.is_active = true AND t.class_name IS NOT NULL AND t.class_name != ''
      ORDER BY u.name
    `);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET summary stats for admin (counts for dashboard badge) ──────
router.get('/summary', auth, adminOnly, async (req, res) => {
  try {
    const all = await pool.query(`
      SELECT
        COUNT(DISTINCT t.trainer_id || '-' || t.class_name || '-' || COALESCE(t.session_type,'General')) AS total_combos,
        COUNT(DISTINCT lp.trainer_id || '-' || lp.class_name || '-' || lp.domain) AS lp_uploaded
      FROM (
        SELECT DISTINCT trainer_id, class_name, session_type
        FROM timetable WHERE class_name IS NOT NULL AND class_name != ''
      ) t
      LEFT JOIN lesson_plans lp
        ON lp.trainer_id = t.trainer_id
        AND lp.class_name = t.class_name
        AND lp.domain = COALESCE(t.session_type,'General')
    `);
    res.json({
      total:       parseInt(all.rows[0].total_combos),
      lp_uploaded: parseInt(all.rows[0].lp_uploaded),
      lp_pending:  parseInt(all.rows[0].total_combos) - parseInt(all.rows[0].lp_uploaded),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET sessions of a lesson plan ─────────────────────────────────
router.get('/sessions', auth, async (req, res) => {
  try {
    const { trainer_id, class_name, domain } = req.query;
    const tid = req.user.role === 'super_admin'
      ? (parseInt(trainer_id) || req.user.id)
      : req.user.id;

    const plan = await pool.query(
      `SELECT * FROM lesson_plans WHERE trainer_id=$1 AND class_name=$2 AND domain=$3`,
      [tid, class_name, domain]
    );
    if (!plan.rows.length) return res.json({ plan: null, sessions: [] });

    const sessions = await pool.query(`
      SELECT lps.*,
        at.not_covered, at.comment,
        asn.date AS taught_date, asn.id AS attendance_session_id
      FROM lesson_plan_sessions lps
      LEFT JOIN attendance_topics at ON at.lesson_plan_session_id = lps.id
      LEFT JOIN attendance_sessions asn ON asn.id = at.attendance_session_id
      WHERE lps.plan_id = $1
      ORDER BY lps.session_no
    `, [plan.rows[0].id]);

    res.json({ plan: plan.rows[0], sessions: sessions.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET suggest topic for today ───────────────────────────────────
router.get('/suggest', auth, async (req, res) => {
  try {
    const { class_name, domain, date } = req.query;
    const today = date || new Date().toISOString().split('T')[0];

    const plan = await pool.query(
      `SELECT id FROM lesson_plans WHERE trainer_id=$1 AND class_name=$2 AND domain=$3`,
      [req.user.id, class_name, domain]
    );
    if (!plan.rows.length) return res.json({ plan_exists: false, sessions: [] });

    const sessions = await pool.query(`
      SELECT lps.*, at.not_covered, at.comment, asn.date AS taught_date
      FROM lesson_plan_sessions lps
      LEFT JOIN attendance_topics at ON at.lesson_plan_session_id = lps.id
      LEFT JOIN attendance_sessions asn ON asn.id = at.attendance_session_id
      WHERE lps.plan_id = $1
      ORDER BY lps.session_no
    `, [plan.rows[0].id]);

    const rows = sessions.rows;
    const suggested = rows.find(s =>
      !s.taught_date && !s.not_covered &&
      s.planned_date && String(s.planned_date).slice(0,10) <= today
    ) || rows.find(s => !s.taught_date && !s.not_covered);

    res.json({ plan_exists: true, sessions: rows, suggested_id: suggested?.id || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST upload lesson plan Excel ─────────────────────────────────
// section_id is optional — we work by (trainer_id, class_name, domain)
router.post('/upload', auth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { class_name, institution, domain, semester, trainer_id } = req.body;
    if (!class_name || !domain) return res.status(400).json({ error: 'class_name and domain are required' });

    const tid = req.user.role === 'super_admin'
      ? (parseInt(trainer_id) || req.user.id)
      : req.user.id;

    // Parse Excel — Col A=session_no(0), Col C=planned_date(2), Col D=topic(3)
    const wb   = XLSX.read(req.file.buffer, { type:'buffer', cellDates:true });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header:1, defval:null });

    const sessions = [];
    for (let i = 1; i < rows.length; i++) {
      const row       = rows[i];
      const sessionNo = row[0];
      const rawDate   = row[2];
      const topic     = row[3];
      if (!sessionNo || !topic) continue;
      const sNo = parseInt(sessionNo);
      if (isNaN(sNo)) continue;

      let plannedDate = null;
      if (rawDate) {
        if (rawDate instanceof Date) {
          plannedDate = rawDate.toISOString().split('T')[0];
        } else if (typeof rawDate === 'number') {
          const d = XLSX.SSF.parse_date_code(rawDate);
          if (d) plannedDate = `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
        } else if (typeof rawDate === 'string' && rawDate.trim()) {
          const d = new Date(rawDate);
          if (!isNaN(d)) plannedDate = d.toISOString().split('T')[0];
        }
      }
      sessions.push({ session_no: sNo, planned_date: plannedDate, topic: String(topic).trim() });
    }

    if (!sessions.length)
      return res.status(400).json({ error: 'No valid sessions found. Check Col A=Session No, Col C=Date, Col D=Topic.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Upsert lesson plan by (trainer_id, class_name, domain)
      const planResult = await client.query(`
        INSERT INTO lesson_plans (trainer_id, class_name, institution, domain, semester, total_sessions, uploaded_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (trainer_id, class_name, domain)
        DO UPDATE SET institution=$3, semester=$5, total_sessions=$6, uploaded_at=NOW(), uploaded_by=$7
        RETURNING id
      `, [tid, class_name, institution||null, domain, semester||'Even Semester 2026', sessions.length, req.user.id]);

      const planId = planResult.rows[0].id;

      // Replace sessions
      await client.query('DELETE FROM lesson_plan_sessions WHERE plan_id=$1', [planId]);
      for (const s of sessions) {
        await client.query(
          `INSERT INTO lesson_plan_sessions (plan_id, session_no, planned_date, topic) VALUES ($1,$2,$3,$4)`,
          [planId, s.session_no, s.planned_date, s.topic]
        );
      }

      await client.query('COMMIT');

      // Notify admins
      if (req.user.role !== 'super_admin') {
        const admins = await pool.query(`SELECT id FROM users WHERE role='super_admin' AND is_active=true`);
        for (const admin of admins.rows) {
          await notify(admin.id, '📋 Lesson Plan Uploaded',
            `${req.user.name} uploaded lesson plan for ${class_name} (${domain}) — ${sessions.length} sessions`);
        }
      }

      res.json({ success:true, plan_id:planId, sessions_parsed:sessions.length, preview:sessions.slice(0,5) });
    } catch(e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST upload student list ──────────────────────────────────────
// Auto-creates section if it doesn't exist
router.post('/upload-students', auth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { class_name, institution, domain, trainer_id, mode } = req.body;
    if (!class_name || !domain) return res.status(400).json({ error: 'class_name and domain required' });

    const tid = req.user.role === 'super_admin'
      ? (parseInt(trainer_id) || req.user.id)
      : req.user.id;

    // Parse Excel (Roll No + Name)
    const wb   = XLSX.read(req.file.buffer, { type:'buffer' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval:'' });

    const students = [];
    for (const row of rows) {
      const keys    = Object.keys(row);
      const rollKey = keys.find(k => k.toLowerCase().includes('roll'));
      const nameKey = keys.find(k => k.toLowerCase().includes('name'));
      if (!rollKey || !nameKey) continue;
      const roll = String(row[rollKey]).trim();
      const name = String(row[nameKey]).trim();
      if (roll && name && roll !== 'Roll No.' && roll !== 'Roll No') {
        students.push({ roll_no: roll, name });
      }
    }
    if (!students.length) return res.status(400).json({ error: 'No valid students found. Need Roll No and Name columns.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Auto-create section if missing
      const sectionId = await ensureSection(client, tid, class_name, institution, domain);

      if (mode === 'replace') {
        await client.query('DELETE FROM students WHERE section_id=$1', [sectionId]);
      }

      let inserted = 0;
      for (const s of students) {
        await client.query(
          `INSERT INTO students (roll_no, name, section_id)
           VALUES ($1,$2,$3)
           ON CONFLICT (roll_no, section_id) DO UPDATE SET name=$2, is_active=true`,
          [s.roll_no, s.name, sectionId]
        );
        inserted++;
      }

      await client.query('COMMIT');

      if (req.user.role !== 'super_admin') {
        const admins = await pool.query(`SELECT id FROM users WHERE role='super_admin' AND is_active=true`);
        for (const admin of admins.rows) {
          await notify(admin.id, '👥 Student List Uploaded',
            `${req.user.name} uploaded ${inserted} students for ${class_name} (${domain})`);
        }
      }

      res.json({ success:true, inserted, total:students.length, preview:students.slice(0,5) });
    } catch(e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST save topic for attendance session ────────────────────────
router.post('/topic', auth, async (req, res) => {
  try {
    const { attendance_session_id, lesson_plan_session_id, not_covered, comment } = req.body;
    if (!attendance_session_id) return res.status(400).json({ error: 'attendance_session_id required' });
    const result = await pool.query(`
      INSERT INTO attendance_topics (attendance_session_id, lesson_plan_session_id, not_covered, comment)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (attendance_session_id)
      DO UPDATE SET lesson_plan_session_id=$2, not_covered=$3, comment=$4, created_at=NOW()
      RETURNING *
    `, [attendance_session_id, lesson_plan_session_id||null, not_covered||false, comment||null]);
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST notify pending trainers ──────────────────────────────────
router.post('/notify-pending', auth, adminOnly, async (req, res) => {
  try {
    const pending = await pool.query(`
      SELECT DISTINCT u.id, u.name
      FROM timetable t
      JOIN users u ON u.id = t.trainer_id AND u.is_active = true
      LEFT JOIN lesson_plans lp
        ON lp.trainer_id = t.trainer_id
        AND lp.class_name = t.class_name
        AND lp.domain = COALESCE(t.session_type,'General')
      WHERE t.class_name IS NOT NULL AND t.class_name != '' AND lp.id IS NULL
    `);
    let sent = 0;
    for (const trainer of pending.rows) {
      await notify(trainer.id,
        '📋 Action Required: Lesson Plan Pending',
        'Please upload your lesson plans for all assigned sections in Lesson Plans page.'
      );
      sent++;
    }
    res.json({ sent });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET download template ─────────────────────────────────────────
router.get('/template', auth, (req, res) => {
  try {
    const wb = XLSX.utils.book_new();
    const data = [
      ['Lec.No','Duration(in minute)','Proposed Date','Points To Covered','Mode','Methodology/Activities'],
      [1,50,'13-01-2026','Introduction & Syllabus Discussion','Offline Mode','Lecture with interaction'],
      [2,50,'16-01-2026','Topic 2 — Enter here','Offline Mode','Lecture with interaction'],
      [3,50,'20-01-2026','Topic 3 — Enter here','Offline Mode','Lecture with interaction'],
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{wch:8},{wch:20},{wch:18},{wch:45},{wch:15},{wch:28}];
    XLSX.utils.book_append_sheet(wb, ws, 'Lesson Plan');
    const buf = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition','attachment; filename=lesson_plan_template.xlsx');
    res.send(buf);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET student list template ─────────────────────────────────────
router.get('/student-template', auth, (req, res) => {
  try {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['Roll No.','Name'],
      ['2K23CSUN01001','STUDENT NAME HERE'],
      ['2K23CSUN01002','ANOTHER STUDENT'],
    ]);
    ws['!cols'] = [{wch:20},{wch:35}];
    XLSX.utils.book_append_sheet(wb, ws, 'Students');
    const buf = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition','attachment; filename=student_list_template.xlsx');
    res.send(buf);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
