const router  = require('express').Router();
const pool    = require('../models/db');
const multer  = require('multer');
const XLSX    = require('xlsx');
const { auth, adminOnly } = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10*1024*1024 } });

// ── AUTO MIGRATE ──────────────────────────────────────
(async () => {
  try {
    await pool.query(`
      -- sections: drop trainer/domain columns, keep rest
      ALTER TABLE sections ADD COLUMN IF NOT EXISTS program    VARCHAR(100);
      ALTER TABLE sections ADD COLUMN IF NOT EXISTS sem        VARCHAR(20);

      -- section_domains: one row per section+domain+trainer
      CREATE TABLE IF NOT EXISTS section_domains (
        id         SERIAL PRIMARY KEY,
        section_id INTEGER REFERENCES sections(id) ON DELETE CASCADE,
        domain     VARCHAR(50) NOT NULL,
        trainer_id INTEGER REFERENCES users(id),
        is_active  BOOLEAN DEFAULT true,
        UNIQUE(section_id, domain)
      );

      -- audit table
      CREATE TABLE IF NOT EXISTS attendance_audit (
        id              SERIAL PRIMARY KEY,
        session_id      INTEGER,
        student_id      INTEGER,
        changed_by      INTEGER REFERENCES users(id),
        changed_by_name VARCHAR(100),
        old_status      VARCHAR(5),
        new_status      VARCHAR(5),
        reason          TEXT,
        changed_at      TIMESTAMP DEFAULT NOW()
      );
    `);
  } catch(e) { console.error('Attendance migrate:', e.message); }
})();

// ── HELPER ───────────────────────────────────────────
const isAdmin = (req) => req.user.role === 'super_admin';

// ── SECTIONS ─────────────────────────────────────────

// GET sections — trainer sees own, admin sees all
router.get('/sections', auth, async (req, res) => {
  try {
    let query, params;
    if(isAdmin(req)) {
      query = `
        SELECT s.*,
          COUNT(DISTINCT st.id) as student_count,
          COUNT(DISTINCT asn.id) as sessions_conducted,
          json_agg(DISTINCT jsonb_build_object('domain',sd.domain,'trainer_id',sd.trainer_id,'trainer_name',u2.name))
            FILTER (WHERE sd.id IS NOT NULL) as domain_trainers
        FROM sections s
        LEFT JOIN students st ON st.section_id=s.id AND st.is_active=true
        LEFT JOIN attendance_sessions asn ON asn.section_id=s.id
        LEFT JOIN section_domains sd ON sd.section_id=s.id AND sd.is_active=true
        LEFT JOIN users u2 ON u2.id=sd.trainer_id
        WHERE s.is_active=true
        GROUP BY s.id ORDER BY s.name`;
      params = [];
    } else {
      query = `
        SELECT s.*,
          COUNT(DISTINCT st.id) as student_count,
          COUNT(DISTINCT asn.id) as sessions_conducted,
          sd.domain as my_domain,
          json_agg(DISTINCT jsonb_build_object('domain',sd2.domain,'trainer_id',sd2.trainer_id,'trainer_name',u2.name))
            FILTER (WHERE sd2.id IS NOT NULL) as domain_trainers
        FROM sections s
        JOIN section_domains sd ON sd.section_id=s.id AND sd.trainer_id=$1 AND sd.is_active=true
        LEFT JOIN section_domains sd2 ON sd2.section_id=s.id AND sd2.is_active=true
        LEFT JOIN users u2 ON u2.id=sd2.trainer_id
        LEFT JOIN students st ON st.section_id=s.id AND st.is_active=true
        LEFT JOIN attendance_sessions asn ON asn.section_id=s.id AND asn.trainer_id=$1
        WHERE s.is_active=true
        GROUP BY s.id, sd.domain ORDER BY s.name`;
      params = [req.user.id];
    }
    const r = await pool.query(query, params);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST create section
router.post('/sections', auth, async (req, res) => {
  try {
    const { name, institution, program, sem, domain, trainer_id,
            cr1_name, cr1_phone, cr2_name, cr2_phone, semester_start } = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Create section
      const r = await client.query(
        `INSERT INTO sections (name, institution, program, sem, cr1_name, cr1_phone, cr2_name, cr2_phone, semester_start)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (name) DO UPDATE SET institution=$2, program=$3, sem=$4
         RETURNING *`,
        [name, institution||null, program||null, sem||null,
         cr1_name||null, cr1_phone||null, cr2_name||null, cr2_phone||null, semester_start||null]
      );
      const sec = r.rows[0];
      // Link domain-trainer if provided
      if(domain && trainer_id) {
        await client.query(
          `INSERT INTO section_domains (section_id, domain, trainer_id)
           VALUES ($1,$2,$3) ON CONFLICT (section_id,domain) DO UPDATE SET trainer_id=$3`,
          [sec.id, domain, trainer_id]
        );
      }
      await client.query('COMMIT');
      res.status(201).json(sec);
    } catch(e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT update section
router.put('/sections/:id', auth, adminOnly, async (req, res) => {
  try {
    const { name, institution, program, sem, cr1_name, cr1_phone, cr2_name, cr2_phone } = req.body;
    const r = await pool.query(
      `UPDATE sections SET name=COALESCE($1,name), institution=COALESCE($2,institution),
       program=COALESCE($3,program), sem=COALESCE($4,sem),
       cr1_name=$5, cr1_phone=$6, cr2_name=$7, cr2_phone=$8
       WHERE id=$9 RETURNING *`,
      [name, institution, program, sem, cr1_name, cr1_phone, cr2_name, cr2_phone, req.params.id]
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET section students
router.get('/sections/:id/students', auth, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM students WHERE section_id=$1 AND is_active=true ORDER BY roll_no',
      [req.params.id]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST upload students
router.post('/sections/:id/upload-students', auth, upload.single('file'), async (req, res) => {
  try {
    const wb = XLSX.read(req.file.buffer, { type:'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header:1 });
    const mode = req.body.mode || 'replace';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if(mode === 'replace') {
        await client.query('UPDATE students SET is_active=false WHERE section_id=$1', [req.params.id]);
      }
      let inserted = 0;
      const preview = [];
      for(const row of rows) {
        const rollNo = row[0]?.toString()?.trim();
        const name   = row[1]?.toString()?.trim();
        if(!rollNo || !name || rollNo.toLowerCase().includes('roll')) continue;
        await client.query(
          `INSERT INTO students (section_id, roll_no, name, is_active)
           VALUES ($1,$2,$3,true)
           ON CONFLICT (section_id, roll_no) DO UPDATE SET name=$3, is_active=true`,
          [req.params.id, rollNo, name]
        );
        inserted++;
        if(preview.length < 5) preview.push({ roll_no: rollNo, name });
      }
      await client.query('COMMIT');
      res.json({ success:true, inserted, preview });
    } catch(e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET template
router.get('/template', auth, (req, res) => {
  const wb = XLSX.utils.book_new();
  const data = [['Roll No.','Name'],['2K23CSUN01001','STUDENT NAME HERE'],['2K23CSUN01002','ANOTHER STUDENT']];
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [{wch:20},{wch:35}];
  XLSX.utils.book_append_sheet(wb, ws, 'Students');
  const buf = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition','attachment; filename=student_template.xlsx');
  res.send(buf);
});

// ── DATE-BASED SLOT FETCHING ──────────────────────────

// GET slots for any date (trainer sees own, admin sees all with filters)
router.get('/by-date', auth, async (req, res) => {
  try {
    const { date, trainer_id } = req.query;
    if(!date) return res.status(400).json({ error:'date required' });
    const d = new Date(date + 'T00:00:00');
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dayName = days[d.getDay()];
    if(dayName === 'Sunday') return res.json({ date, day:dayName, slots:[] });

    // Who are we fetching for?
    const fetchForId = isAdmin(req) && trainer_id ? parseInt(trainer_id) : 
                       isAdmin(req) ? null : req.user.id;

    let trainerFilter = fetchForId ? 'AND t.trainer_id = $3' : '';
    let params = [date, dayName];
    if(fetchForId) params.push(fetchForId);

    const result = await pool.query(`
      SELECT t.id as timetable_id, t.trainer_id, u.name as trainer_name,
        t.class_name, t.session_type as domain, t.room, t.institution,
        t.slot_number, t.day,
        s.id as section_id,
        s.cr1_name, s.cr1_phone, s.cr2_name, s.cr2_phone,
        COUNT(DISTINCT st.id) as student_count,
        -- lesson plan exists?
        EXISTS(
          SELECT 1 FROM lesson_plans lp
          WHERE lp.trainer_id=t.trainer_id AND lp.class_name=t.class_name AND lp.domain=t.session_type
        ) as has_lesson_plan,
        -- students uploaded?
        COUNT(DISTINCT st.id) > 0 as has_students,
        -- already marked today?
        asn.id as session_id,
        asn.topic_covered,
        asn.is_locked
      FROM timetable t
      JOIN users u ON u.id=t.trainer_id
      -- match section via section_domains (trainer+domain) or by class_name
      LEFT JOIN section_domains sd ON sd.trainer_id=t.trainer_id 
        AND sd.domain=t.session_type AND sd.is_active=true
      LEFT JOIN sections s ON s.id=sd.section_id
      LEFT JOIN students st ON st.section_id=s.id AND st.is_active=true
      LEFT JOIN attendance_sessions asn ON asn.section_id=s.id 
        AND asn.date=$1 AND asn.slot_number=t.slot_number AND asn.trainer_id=t.trainer_id
      WHERE t.day=$2
        AND t.class_name IS NOT NULL AND t.class_name != ''
        ${trainerFilter}
      GROUP BY t.id, u.name, s.id, asn.id
      ORDER BY t.slot_number
    `, params);

    res.json({ date, day:dayName, slots:result.rows });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// GET admin pending report for a date
router.get('/pending-report', auth, adminOnly, async (req, res) => {
  try {
    const { date } = req.query;
    if(!date) return res.status(400).json({ error:'date required' });
    const d = new Date(date + 'T00:00:00');
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dayName = days[d.getDay()];
    if(dayName === 'Sunday') return res.json({ date, day:dayName, pending:[], marked:[] });

    const result = await pool.query(`
      SELECT t.trainer_id, u.name as trainer_name, u.designation,
        t.class_name, t.session_type as domain, t.slot_number,
        s.id as section_id,
        COUNT(DISTINCT st.id) as student_count,
        asn.id as session_id,
        CASE WHEN asn.id IS NOT NULL THEN true ELSE false END as is_marked
      FROM timetable t
      JOIN users u ON u.id=t.trainer_id
      LEFT JOIN section_domains sd ON sd.trainer_id=t.trainer_id AND sd.domain=t.session_type AND sd.is_active=true
      LEFT JOIN sections s ON s.id=sd.section_id
      LEFT JOIN students st ON st.section_id=s.id AND st.is_active=true
      LEFT JOIN attendance_sessions asn ON asn.section_id=s.id 
        AND asn.date=$1 AND asn.slot_number=t.slot_number AND asn.trainer_id=t.trainer_id
      WHERE t.day=$2 AND t.class_name IS NOT NULL AND t.class_name != ''
      GROUP BY t.id, u.name, u.designation, s.id, asn.id
      ORDER BY u.name, t.slot_number
    `, [date, dayName]);

    const pending = result.rows.filter(r => !r.is_marked);
    const marked  = result.rows.filter(r => r.is_marked);
    res.json({ date, day:dayName, pending, marked, total:result.rows.length });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── SESSIONS & MARKING ────────────────────────────────

// POST start/get session
router.post('/sessions/start', auth, async (req, res) => {
  try {
    const { section_id, date, slot_number, domain } = req.body;
    if(!section_id || !date || !slot_number) 
      return res.status(400).json({ error:'section_id, date, slot_number required' });

    const sessionResult = await pool.query(
      `INSERT INTO attendance_sessions (section_id, trainer_id, date, slot_number, domain)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (section_id, date, slot_number, trainer_id) DO UPDATE 
       SET domain=COALESCE($5, attendance_sessions.domain)
       RETURNING *`,
      [section_id, req.user.id, date, slot_number, domain||null]
    );
    const session = sessionResult.rows[0];

    const students = await pool.query(
      `SELECT st.*, COALESCE(ar.status,'P') as status
       FROM students st
       LEFT JOIN attendance_records ar ON ar.student_id=st.id AND ar.session_id=$1
       WHERE st.section_id=$2 AND st.is_active=true
       ORDER BY st.roll_no`,
      [session.id, section_id]
    );
    res.json({ session, students: students.rows });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// POST submit with audit
router.post('/sessions/:id/submit-with-audit', auth, async (req, res) => {
  try {
    const { records, topic_covered, remarks, edit_reason } = req.body;
    if(!records?.length) return res.status(400).json({ error:'No records provided' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        'SELECT student_id, status FROM attendance_records WHERE session_id=$1',
        [req.params.id]
      );
      const existingMap = {};
      existing.rows.forEach(r => { existingMap[r.student_id] = r.status; });
      const isEdit = existing.rows.length > 0;

      if(isEdit && !edit_reason?.trim())
        return res.status(400).json({ error:'edit_reason required when editing attendance' });

      for(const r of records) {
        const oldStatus = existingMap[r.student_id] || null;
        await client.query(
          `INSERT INTO attendance_records (session_id, student_id, status)
           VALUES ($1,$2,$3)
           ON CONFLICT (session_id, student_id) DO UPDATE SET status=$3, marked_at=NOW()`,
          [req.params.id, r.student_id, r.status]
        );
        if(isEdit && oldStatus && oldStatus !== r.status) {
          await client.query(
            `INSERT INTO attendance_audit 
             (session_id, student_id, changed_by, changed_by_name, old_status, new_status, reason)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [req.params.id, r.student_id, req.user.id, req.user.name, oldStatus, r.status, edit_reason]
          );
        }
      }
      if(topic_covered !== undefined || remarks !== undefined) {
        await client.query(
          'UPDATE attendance_sessions SET topic_covered=$1, remarks=$2 WHERE id=$3',
          [topic_covered||null, remarks||null, req.params.id]
        );
      }
      await client.query('COMMIT');
      res.json({ success:true, marked:records.length, is_edit:isEdit });
    } catch(e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// GET summary for a section
router.get('/summary/:section_id', auth, async (req, res) => {
  try {
    const { domain } = req.query;
    let domainFilter = domain && domain !== 'all' ? 'AND asn.domain=$2' : '';
    let params = [req.params.section_id];
    if(domain && domain !== 'all') params.push(domain);

    const students = await pool.query(`
      SELECT st.id, st.roll_no, st.name,
        COUNT(DISTINCT asn.id) as total_sessions,
        COUNT(DISTINCT CASE WHEN ar.status='P' THEN ar.session_id END) as present_count,
        ROUND(
          COUNT(DISTINCT CASE WHEN ar.status='P' THEN ar.session_id END)*100.0/
          NULLIF(COUNT(DISTINCT asn.id),0)
        ,1) as percentage
      FROM students st
      LEFT JOIN attendance_sessions asn ON asn.section_id=$1 ${domainFilter}
      LEFT JOIN attendance_records ar ON ar.student_id=st.id AND ar.session_id=asn.id
      WHERE st.section_id=$1 AND st.is_active=true
      GROUP BY st.id ORDER BY st.roll_no
    `, params);

    const below75 = students.rows.filter(s => parseFloat(s.percentage||0) < 75).length;
    const warning = students.rows.filter(s => { const p=parseFloat(s.percentage||0); return p>=75&&p<80; }).length;
    const safe    = students.rows.filter(s => parseFloat(s.percentage||0) >= 80).length;

    res.json({ students:students.rows, below75, warning, safe });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// GET alerts — students below 75%
router.get('/alerts', auth, async (req, res) => {
  try {
    const trainerFilter = isAdmin(req) ? '' : 'AND asn.trainer_id=$1';
    const params = isAdmin(req) ? [] : [req.user.id];

    const result = await pool.query(`
      SELECT st.roll_no, st.name, s.name as section_name,
        s.institution, asn.domain,
        u.name as trainer_name,
        COUNT(DISTINCT asn.id) as total_sessions,
        COUNT(DISTINCT CASE WHEN ar.status='P' THEN ar.session_id END) as present_count,
        ROUND(
          COUNT(DISTINCT CASE WHEN ar.status='P' THEN ar.session_id END)*100.0/
          NULLIF(COUNT(DISTINCT asn.id),0)
        ,1) as percentage
      FROM students st
      JOIN sections s ON s.id=st.section_id
      JOIN attendance_sessions asn ON asn.section_id=s.id
      JOIN users u ON u.id=asn.trainer_id
      LEFT JOIN attendance_records ar ON ar.student_id=st.id AND ar.session_id=asn.id
      WHERE st.is_active=true AND s.is_active=true ${trainerFilter}
      GROUP BY st.id, st.roll_no, st.name, s.name, s.institution, asn.domain, u.name
      HAVING ROUND(
        COUNT(DISTINCT CASE WHEN ar.status='P' THEN ar.session_id END)*100.0/
        NULLIF(COUNT(DISTINCT asn.id),0)
      ,1) < 75
      ORDER BY percentage ASC
      LIMIT 200
    `, params);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// GET audit trail
router.get('/audit/:section_id', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT aa.*, st.name as student_name, st.roll_no,
        asn.date as session_date, asn.slot_number, asn.domain
      FROM attendance_audit aa
      JOIN students st ON st.id=aa.student_id
      JOIN attendance_sessions asn ON asn.id=aa.session_id
      WHERE asn.section_id=$1
      ORDER BY aa.changed_at DESC LIMIT 100
    `, [req.params.section_id]);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// GET export
router.get('/export', auth, async (req, res) => {
  try {
    const { section_id, domain, institution } = req.query;
    const trainerFilter = isAdmin(req) ? '' : 'AND asn.trainer_id=$1';
    let params = isAdmin(req) ? [] : [req.user.id];

    let filters = trainerFilter;
    if(section_id && section_id !== 'all') { params.push(section_id); filters += ` AND s.id=$${params.length}`; }
    if(domain && domain !== 'all') { params.push(domain); filters += ` AND asn.domain=$${params.length}`; }
    if(institution && institution !== 'all') { params.push(institution); filters += ` AND s.institution=$${params.length}`; }

    const result = await pool.query(`
      SELECT st.roll_no, st.name, s.name as section_name,
        s.institution, asn.domain,
        COUNT(DISTINCT asn.id) as total_sessions,
        COUNT(DISTINCT CASE WHEN ar.status='P' THEN ar.session_id END) as present_count,
        ROUND(
          COUNT(DISTINCT CASE WHEN ar.status='P' THEN ar.session_id END)*100.0/
          NULLIF(COUNT(DISTINCT asn.id),0)
        ,1) as percentage
      FROM students st
      JOIN sections s ON s.id=st.section_id
      JOIN attendance_sessions asn ON asn.section_id=s.id
      LEFT JOIN attendance_records ar ON ar.student_id=st.id AND ar.session_id=asn.id
      WHERE st.is_active=true AND s.is_active=true ${filters}
      GROUP BY st.id, st.roll_no, st.name, s.name, s.institution, asn.domain
      ORDER BY s.name, st.roll_no
    `, params);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── MONITORING ────────────────────────────────────────

router.get('/monitoring/sections', auth, async (req, res) => {
  try {
    const { stream_id, domain, institution } = req.query;
    const trainerFilter = isAdmin(req) ? '' : `AND sd.trainer_id=$1`;
    let params = isAdmin(req) ? [] : [req.user.id];
    if(stream_id) { params.push(stream_id); trainerFilter; }
    if(institution && institution !== 'all') { params.push(institution); }

    const result = await pool.query(`
      SELECT s.id, s.name, s.institution, s.program, s.sem,
        COUNT(DISTINCT st.id) as total_students,
        COUNT(DISTINCT asn.id) as sessions_conducted,
        ROUND(
          COUNT(DISTINCT CASE WHEN ar.status='P' THEN ar.id END)*100.0/
          NULLIF(COUNT(DISTINCT asn.id)*NULLIF(COUNT(DISTINCT st.id),0),0)
        ,1) as avg_attendance_pct,
        COUNT(DISTINCT CASE WHEN sub.pct < 75 THEN sub.sid END) as below_75,
        COUNT(DISTINCT CASE WHEN sub.pct < 65 THEN sub.sid END) as below_65,
        COUNT(DISTINCT CASE WHEN sub.pct = 0  THEN sub.sid END) as zero_attendance,
        json_agg(DISTINCT jsonb_build_object('domain',sd.domain,'trainer_name',u.name))
          FILTER (WHERE sd.id IS NOT NULL) as domain_trainers
      FROM sections s
      LEFT JOIN section_domains sd ON sd.section_id=s.id AND sd.is_active=true ${isAdmin(req)?'':'AND sd.trainer_id=$1'}
      LEFT JOIN users u ON u.id=sd.trainer_id
      LEFT JOIN students st ON st.section_id=s.id AND st.is_active=true
      LEFT JOIN attendance_sessions asn ON asn.section_id=s.id
      LEFT JOIN attendance_records ar ON ar.session_id=asn.id
      LEFT JOIN (
        SELECT s2.id as sid, sec2.id as secid,
          ROUND(COUNT(CASE WHEN ar2.status='P' THEN 1 END)*100.0/NULLIF(COUNT(asn2.id),0),1) as pct
        FROM students s2 JOIN sections sec2 ON sec2.id=s2.section_id
        JOIN attendance_sessions asn2 ON asn2.section_id=sec2.id
        LEFT JOIN attendance_records ar2 ON ar2.student_id=s2.id AND ar2.session_id=asn2.id
        WHERE s2.is_active=true GROUP BY s2.id, sec2.id
      ) sub ON sub.secid=s.id
      WHERE s.is_active=true
      GROUP BY s.id ORDER BY s.name
    `, params);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.get('/monitoring/at-risk', auth, async (req, res) => {
  try {
    const { threshold=75, domain, institution } = req.query;
    const trainerFilter = isAdmin(req) ? '' : 'AND asn.trainer_id=$2';
    let params = [parseFloat(threshold)];
    if(!isAdmin(req)) params.push(req.user.id);
    if(domain && domain !== 'all') { params.push(domain); }
    if(institution && institution !== 'all') { params.push(institution); }

    const result = await pool.query(`
      SELECT st.roll_no, st.name, s.name as section_name,
        s.institution, asn.domain, u.name as trainer_name,
        COUNT(DISTINCT asn.id) as total_sessions,
        COUNT(DISTINCT CASE WHEN ar.status='P' THEN ar.session_id END) as present_count,
        ROUND(
          COUNT(DISTINCT CASE WHEN ar.status='P' THEN ar.session_id END)*100.0/
          NULLIF(COUNT(DISTINCT asn.id),0)
        ,1) as percentage
      FROM students st JOIN sections s ON st.section_id=s.id
      JOIN attendance_sessions asn ON asn.section_id=s.id
      JOIN users u ON u.id=asn.trainer_id
      LEFT JOIN attendance_records ar ON ar.student_id=st.id AND ar.session_id=asn.id
      WHERE st.is_active=true ${trainerFilter}
      GROUP BY st.id, st.roll_no, st.name, s.name, s.institution, asn.domain, u.name
      HAVING ROUND(
        COUNT(DISTINCT CASE WHEN ar.status='P' THEN ar.session_id END)*100.0/
        NULLIF(COUNT(DISTINCT asn.id),0)
      ,1) < $1
      ORDER BY percentage ASC LIMIT 500
    `, params);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.get('/monitoring/trainers', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.name, u.designation, u.profile_picture,
        COUNT(DISTINCT sd.section_id) as total_sections,
        COUNT(DISTINCT asn.id) as sessions_conducted,
        ROUND(AVG(
          CASE WHEN ar_counts.total > 0 THEN ar_counts.present*100.0/ar_counts.total ELSE NULL END
        ),1) as avg_attendance_pct
      FROM users u
      LEFT JOIN section_domains sd ON sd.trainer_id=u.id AND sd.is_active=true
      LEFT JOIN attendance_sessions asn ON asn.trainer_id=u.id
      LEFT JOIN LATERAL (
        SELECT COUNT(*) as total,
          COUNT(CASE WHEN ar.status='P' THEN 1 END) as present
        FROM attendance_records ar WHERE ar.session_id=asn.id
      ) ar_counts ON true
      WHERE u.is_active=true AND u.role!='super_admin'
      GROUP BY u.id ORDER BY sessions_conducted DESC
    `);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.get('/monitoring/trend', auth, async (req, res) => {
  try {
    const trainerFilter = isAdmin(req) ? '' : 'AND asn.trainer_id=$1';
    const params = isAdmin(req) ? [] : [req.user.id];
    const result = await pool.query(`
      SELECT TO_CHAR(asn.date,'Mon YYYY') as month_label,
        DATE_TRUNC('month',asn.date) as month_date,
        COUNT(DISTINCT asn.id) as sessions,
        COUNT(DISTINCT ar.id) as total_records,
        COUNT(DISTINCT CASE WHEN ar.status='P' THEN ar.id END) as present_count,
        ROUND(
          COUNT(DISTINCT CASE WHEN ar.status='P' THEN ar.id END)*100.0/
          NULLIF(COUNT(DISTINCT ar.id),0)
        ,1) as attendance_pct
      FROM attendance_sessions asn
      JOIN sections s ON s.id=asn.section_id
      LEFT JOIN attendance_records ar ON ar.session_id=asn.id
      WHERE s.is_active=true ${trainerFilter}
      GROUP BY DATE_TRUNC('month',asn.date), TO_CHAR(asn.date,'Mon YYYY')
      ORDER BY month_date
    `, params);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.get('/monitoring/defaulters', auth, async (req, res) => {
  try {
    const { threshold=75, domain, institution } = req.query;
    const trainerFilter = isAdmin(req) ? '' : 'AND asn.trainer_id=$2';
    let params = [parseFloat(threshold)];
    if(!isAdmin(req)) params.push(req.user.id);

    const result = await pool.query(`
      SELECT st.roll_no, st.name as student_name, s.name as section_name,
        s.institution, asn.domain, u.name as trainer_name,
        COUNT(DISTINCT asn.id) as total_sessions,
        COUNT(DISTINCT CASE WHEN ar.status='P' THEN ar.session_id END) as present,
        COUNT(DISTINCT asn.id)-COUNT(DISTINCT CASE WHEN ar.status='P' THEN ar.session_id END) as absent,
        ROUND(
          COUNT(DISTINCT CASE WHEN ar.status='P' THEN ar.session_id END)*100.0/
          NULLIF(COUNT(DISTINCT asn.id),0)
        ,1) as percentage
      FROM students st JOIN sections s ON st.section_id=s.id
      JOIN attendance_sessions asn ON asn.section_id=s.id
      JOIN users u ON u.id=asn.trainer_id
      LEFT JOIN attendance_records ar ON ar.student_id=st.id AND ar.session_id=asn.id
      WHERE st.is_active=true ${trainerFilter}
      GROUP BY st.id, st.roll_no, st.name, s.name, s.institution, asn.domain, u.name
      HAVING ROUND(
        COUNT(DISTINCT CASE WHEN ar.status='P' THEN ar.session_id END)*100.0/
        NULLIF(COUNT(DISTINCT asn.id),0)
      ,1) < $1
      ORDER BY s.name, percentage ASC LIMIT 1000
    `, params);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── TIMETABLE IMPORT — bulk create sections from Excel ──
router.post('/import-from-timetable', auth, adminOnly, async (req, res) => {
  try {
    const { sections } = req.body;
    // sections = [{name, institution, program, sem, domain, trainer_first_name}]
    let created=0, linked=0, skipped=[];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for(const sec of sections) {
        // 1. Find trainer by first name
        let trainerId = null;
        if(sec.trainer_first_name && sec.trainer_first_name !== 'NA') {
          const firstName = sec.trainer_first_name.toLowerCase()
            .replace(/^dr\.?\s*/i,'').trim().split(/\s+/)[0];
          const tr = await client.query(
            `SELECT id FROM users WHERE LOWER(name) LIKE $1 AND is_active=true LIMIT 1`,
            [`%${firstName}%`]
          );
          if(tr.rows.length) trainerId = tr.rows[0].id;
          else skipped.push(`${sec.trainer_first_name} (trainer not found)`);
        }

        // 2. Upsert section
        const r = await client.query(
          `INSERT INTO sections (name, institution, program, sem)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (name) DO UPDATE SET institution=$2, program=$3, sem=$4
           RETURNING id`,
          [sec.name, sec.institution, sec.program, sec.sem?.toString()]
        );
        const sectionId = r.rows[0].id;
        created++;

        // 3. Link domain-trainer
        if(sec.domain && trainerId) {
          await client.query(
            `INSERT INTO section_domains (section_id, domain, trainer_id)
             VALUES ($1,$2,$3)
             ON CONFLICT (section_id, domain) DO UPDATE SET trainer_id=$3`,
            [sectionId, sec.domain, trainerId]
          );
          linked++;
        }
      }
      await client.query('COMMIT');
      res.json({ success:true, created, linked, skipped });
    } catch(e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// GET lesson plan suggest (used during marking)
router.get('/sessions/suggest-lp', auth, async (req, res) => {
  try {
    const { class_name, domain, date } = req.query;
    const lp = await pool.query(
      `SELECT * FROM lesson_plans WHERE trainer_id=$1 AND class_name=$2 AND domain=$3 LIMIT 1`,
      [req.user.id, class_name, domain]
    );
    if(!lp.rows.length) return res.json({ plan_exists:false, sessions:[] });
    const plan = lp.rows[0];
    const sessions = await pool.query(
      `SELECT lps.*, 
        CASE WHEN lps.planned_date::date <= $1::date THEN true ELSE false END as is_due
       FROM lesson_plan_sessions lps
       WHERE lps.plan_id=$2 ORDER BY lps.session_no`,
      [date, plan.id]
    );
    // Find suggested: first not-yet-covered session
    const covered = await pool.query(
      `SELECT lesson_plan_session_id FROM attendance_lesson_plan WHERE attendance_session_id IN (
        SELECT id FROM attendance_sessions WHERE section_id IN (
          SELECT id FROM sections WHERE name=$1
        ) AND trainer_id=$2
      )`, [class_name, req.user.id]
    );
    const coveredIds = new Set(covered.rows.map(r=>r.lesson_plan_session_id));
    const suggested = sessions.rows.find(s => !coveredIds.has(s.id));
    res.json({ plan_exists:true, sessions:sessions.rows, suggested_id:suggested?.id||null });
  } catch(e) { res.json({ plan_exists:false, sessions:[] }); }
});

module.exports = router;
