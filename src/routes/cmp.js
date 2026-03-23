const router  = require('express').Router();
const pool    = require('../models/db');
const { auth } = require('../middleware/auth');
const multer  = require('multer');
const XLSX    = require('xlsx');
const crypto  = require('crypto');
const FormData = require('form-data');
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ── Exact interaction column map per sheet (from Excel inspection) ──
const SHEET_INT_COLS = {
  'Amjad':     [45, 49, 53, 59, 63],
  'Susanta':   [40, 44, 48, 54, 58],
  'Snigdha':   [40, 44, 48, 54, 58],
  'Geetika':   [40, 44, 48, 54, 58],
  'Monika':    [40, 44, 48, 54, 58],
  'Vipin':     [41, 45, 49, 55, 59],
  'Karan':     [40, 44, 48, 54, 58],
  'Sahil':     [40, 44, 48, 54, 58],
  'Prakash':   [40, 44, 48, 54, 58],
  'Akshi':     [40, 44, 48, 54, 58],
  'Sonia':     [40, 44, 48, 54, 58],
  'Pranamika': [40, 44, 48, 54, 58],
  'Swapnil':   [40, 44, 48, 54, 58],
  'Prema':     [40, 44, 48, 54, 58],
  'Anand':     [40, 44, 48, 54, 58],
  'Avik':      [40, 44, 48, 54, 58],
  'Shivangee': [40, 44, 48, 54, 58],
  'Priya':     [40, 44, 48, 54, 58],
};

const ALL_MENTOR_SHEETS = Object.keys(SHEET_INT_COLS);

// ── Helpers ───────────────────────────────────────────────────────
const safeStr = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return ['#NAME?','#REF!','#VALUE!','','None','undefined'].includes(s) ? null : s;
};
const safeInt = (v) => {
  const n = parseInt(v);
  return isNaN(n) ? null : n;
};
const safeFloat = (v) => {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
};
const parseDate = (v) => {
  if (!v) return null;
  if (v instanceof Date && !isNaN(v)) return v.toISOString().split('T')[0];
  const s = String(v).trim().replace(/--/g,'-').replace(/\//g,'-');
  const parts = s.split('-');
  if (parts.length === 3) {
    let [a, b, c] = parts;
    // Try dd-mm-yyyy
    if (c && c.length >= 4) return `${c}-${b.padStart(2,'0')}-${a.padStart(2,'0')}`;
    // Try yyyy-mm-dd
    if (a && a.length === 4) return `${a}-${b.padStart(2,'0')}-${c.padStart(2,'0')}`;
  }
  return null;
};

async function notifyUser(userId, title, message) {
  try {
    await pool.query(
      `INSERT INTO notifications(user_id,title,message,type) VALUES($1,$2,$3,'cmp')`,
      [userId, title, message]
    );
  } catch(e) { /* silent */ }
}

async function uploadToCloudinary(buffer, filename, mimetype) {
  const cloudName  = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey     = process.env.CLOUDINARY_API_KEY;
  const apiSecret  = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) throw new Error('Cloudinary not configured');

  const timestamp   = Math.round(Date.now() / 1000);
  const folder      = 'cdc_cmp_resumes';
  const isImage     = mimetype.startsWith('image/');
  const resourceType = isImage ? 'image' : 'raw';
  const sigStr      = `folder=${folder}&timestamp=${timestamp}${apiSecret}`;
  const signature   = crypto.createHash('sha1').update(sigStr).digest('hex');

  const form = new FormData();
  form.append('file', buffer, { filename, contentType: mimetype });
  form.append('timestamp', String(timestamp));
  form.append('api_key', apiKey);
  form.append('signature', signature);
  form.append('folder', folder);

  const res  = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`, {
    method: 'POST', body: form, headers: form.getHeaders()
  });
  const data = await res.json();
  if (!data.secure_url) throw new Error(data.error?.message || 'Cloudinary upload failed');
  return data.secure_url;
}

async function callGroq(prompt, maxTokens = 2500) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role:'user', content: prompt }],
      max_tokens: maxTokens, temperature: 0.72,
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'AI failed');
  return data.choices?.[0]?.message?.content || '';
}

// ── Schema ────────────────────────────────────────────────────────
const setup = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cmp_mentees (
      id              SERIAL PRIMARY KEY,
      roll_no         VARCHAR(60) UNIQUE NOT NULL,
      name            VARCHAR(150) NOT NULL,
      program         VARCHAR(80),
      university      VARCHAR(20),
      email           VARCHAR(200),
      phone           VARCHAR(20),
      cgpa            NUMERIC(4,2),
      backlogs        INTEGER DEFAULT 0,
      amcat_logical   INTEGER,
      amcat_quant     INTEGER,
      amcat_english   INTEGER,
      amcat_automata  INTEGER,
      certifications  TEXT,
      internships     TEXT,
      projects        TEXT,
      career_goal     TEXT,
      domain_interest TEXT,
      strengths       TEXT,
      weaknesses      TEXT,
      mentor_id       INTEGER REFERENCES users(id),
      resume_url      TEXT,
      resume_name     VARCHAR(200),
      resume_type     VARCHAR(50),
      resume_uploaded_at TIMESTAMP,
      created_at      TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS cmp_phone_map (
      roll_no   VARCHAR(60) PRIMARY KEY,
      phone     VARCHAR(20)
    );

    CREATE TABLE IF NOT EXISTS cmp_group_meeting (
      id          SERIAL PRIMARY KEY,
      mentor_id   INTEGER REFERENCES users(id) UNIQUE,
      held_date   DATE,
      notes       TEXT,
      created_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS cmp_group_attendance (
      id          SERIAL PRIMARY KEY,
      mentee_id   INTEGER REFERENCES cmp_mentees(id) ON DELETE CASCADE,
      mentor_id   INTEGER REFERENCES users(id),
      attended    BOOLEAN DEFAULT false,
      observation TEXT,
      UNIQUE(mentee_id, mentor_id)
    );

    CREATE TABLE IF NOT EXISTS cmp_interactions (
      id              SERIAL PRIMARY KEY,
      mentee_id       INTEGER REFERENCES cmp_mentees(id) ON DELETE CASCADE,
      mentor_id       INTEGER REFERENCES users(id),
      interaction_no  INTEGER NOT NULL CHECK(interaction_no BETWEEN 1 AND 5),
      meeting_date    DATE,
      attendance      VARCHAR(10) DEFAULT 'present',
      career_goal     TEXT,
      domain_interest TEXT,
      score_resume    INTEGER CHECK(score_resume BETWEEN 1 AND 5),
      score_comm      INTEGER CHECK(score_comm BETWEEN 1 AND 5),
      score_grooming  INTEGER CHECK(score_grooming BETWEEN 1 AND 5),
      score_attitude  INTEGER CHECK(score_attitude BETWEEN 1 AND 5),
      score_technical INTEGER CHECK(score_technical BETWEEN 1 AND 5),
      strengths       TEXT,
      weaknesses      TEXT,
      notes           TEXT,
      feedback        TEXT,
      action_plan     TEXT,
      ai_report       TEXT,
      referrals       JSONB DEFAULT '[]',
      created_at      TIMESTAMP DEFAULT NOW(),
      UNIQUE(mentee_id, interaction_no)
    );

    CREATE TABLE IF NOT EXISTS cmp_referrals (
      id              SERIAL PRIMARY KEY,
      mentee_id       INTEGER REFERENCES cmp_mentees(id) ON DELETE CASCADE,
      from_mentor     INTEGER REFERENCES users(id),
      to_trainer      INTEGER REFERENCES users(id),
      domain          VARCHAR(50),
      interaction_no  INTEGER,
      note            TEXT,
      trainer_review  TEXT,
      trainer_score   INTEGER,
      status          VARCHAR(20) DEFAULT 'pending',
      reviewed_at     TIMESTAMP,
      created_at      TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS cmp_links (
      id         SERIAL PRIMARY KEY,
      label      VARCHAR(100) NOT NULL,
      url        TEXT NOT NULL,
      icon       VARCHAR(10) DEFAULT '🔗',
      sort_order INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_cmp_mentee_mentor ON cmp_mentees(mentor_id);
    CREATE INDEX IF NOT EXISTS idx_cmp_inter_mentee  ON cmp_interactions(mentee_id);
    CREATE INDEX IF NOT EXISTS idx_cmp_ref_to        ON cmp_referrals(to_trainer);
  `);

  // Add resume + phone columns if upgrading from old schema
  await pool.query(`
    ALTER TABLE cmp_mentees ADD COLUMN IF NOT EXISTS resume_url          TEXT;
    ALTER TABLE cmp_mentees ADD COLUMN IF NOT EXISTS resume_name         VARCHAR(200);
    ALTER TABLE cmp_mentees ADD COLUMN IF NOT EXISTS resume_type         VARCHAR(50);
    ALTER TABLE cmp_mentees ADD COLUMN IF NOT EXISTS resume_uploaded_at  TIMESTAMP;
    ALTER TABLE cmp_mentees ADD COLUMN IF NOT EXISTS phone               VARCHAR(20);
  `).catch(()=>{});

  // Seed default links if empty
  const lk = await pool.query('SELECT id FROM cmp_links LIMIT 1');
  if (!lk.rows.length) {
    await pool.query(`INSERT INTO cmp_links(label,url,icon,sort_order) VALUES
      ('Mentorship Sheet','https://docs.google.com/spreadsheets/d/1Zy7EYUIiTQT8GBTyEN-G50DQglqXNSVEIGk8mQc3iYU','📊',1),
      ('CDC Feedback Form','https://tinyurl.com/CMP26FEEDBACK','📝',2),
      ('Photos Drive','https://drive.google.com/drive/folders/1czoPwsvgffAbNPnsOyeCfExPQSyw5Wtp','📸',3),
      ('CMP Drive','https://drive.google.com/drive/folders/1PxxSxaUAx6D-JDA9YaH6GoNkt-rBIaz8','📁',4)`);
  }
  console.log('✅ CMP schema ready');
};
setup().catch(e => console.error('CMP setup error:', e.message));

// ══════════════════════════════════════════════════════════════════
// CORE EXCEL PARSER — used by both admin full-sync and trainer upload
// sheetName: which sheet tab to read (null = auto-detect from trainer name)
// onlyThisTrainer: if true, only import mentees for this trainer
// ══════════════════════════════════════════════════════════════════
async function parseAndSync(buffer, client, requestingUser, sheetNameOverride) {
  const wb = XLSX.read(buffer, { type:'buffer', cellDates:true });

  // Phone numbers are read directly from each trainer sheet col G (index 6)
  // No need to read from Google form Response or MCA Students Details
  const phoneMap = {};

  // Determine which sheets to process
  let sheetsToProcess = [];
  if (sheetNameOverride) {
    // Single sheet upload by trainer
    sheetsToProcess = [sheetNameOverride];
  } else {
    // Admin uploaded full workbook — process all known sheets
    sheetsToProcess = ALL_MENTOR_SHEETS.filter(s => wb.SheetNames.includes(s));
  }

  const stats = { mentees_new:0, mentees_updated:0, interactions_new:0, interactions_updated:0, group_updated:0, skipped_sheets:[] };

  for (const sheetName of sheetsToProcess) {
    if (!wb.SheetNames.includes(sheetName)) {
      stats.skipped_sheets.push(sheetName);
      continue;
    }

    // Find the mentor user in portal
    const mentorR = await client.query(
      `SELECT id, name FROM users WHERE LOWER(name) LIKE LOWER($1) AND is_active=true LIMIT 1`,
      [`%${sheetName}%`]
    );
    if (!mentorR.rows.length) { stats.skipped_sheets.push(sheetName + ' (user not found)'); continue; }
    const mentorId = mentorR.rows[0].id;

    // Security: trainer can only sync their own sheet
    if (requestingUser.role !== 'super_admin' && requestingUser.id !== mentorId) {
      stats.skipped_sheets.push(sheetName + ' (not your sheet)');
      continue;
    }

    const intCols = SHEET_INT_COLS[sheetName];
    const ws      = wb.Sheets[sheetName];
    const rows    = XLSX.utils.sheet_to_json(ws, { header:1, defval:null });

    // Ensure group meeting record exists
    await client.query(
      `INSERT INTO cmp_group_meeting(mentor_id, held_date) VALUES($1, NOW())
       ON CONFLICT(mentor_id) DO NOTHING`,
      [mentorId]
    );

    for (const row of rows.slice(2)) {
      if (!row[1] || !row[4]) continue;
      const rollNo = safeStr(row[1]);
      const name   = safeStr(row[4]);
      if (!rollNo || !name) continue;

      // Phone is in column G (index 6) of each trainer sheet
      const rawPhone = row[6];
      if (rawPhone) {
        const strPh = String(rawPhone).trim().replace(/[^0-9]/g,'');
        if (strPh.length >= 10) phoneMap[rollNo] = strPh.slice(-10);
      }

      // ── Upsert mentee ──────────────────────────────────────────
      const existM = await client.query(
        `SELECT id FROM cmp_mentees WHERE roll_no=$1 LIMIT 1`, [rollNo]
      );

      const menteeData = {
        roll_no:        rollNo,
        name,
        program:        safeStr(row[2]),
        university:     safeStr(row[3]),
        cgpa:           safeFloat(row[9]) ?? safeFloat(row[8]),
        backlogs:       safeInt(row[10]) ?? 0,
        certifications: safeStr(row[17]),
        internships:    safeStr(row[18]),
        projects:       safeStr(row[19]),
        career_goal:    safeStr(row[30]),
        domain_interest:safeStr(row[31]),
        strengths:      safeStr(row[28]),
        weaknesses:     safeStr(row[29]),
      };

      let menteeId;
      if (!existM.rows.length) {
        const phone = phoneMap[menteeData.roll_no] || null;
        const ins = await client.query(`
          INSERT INTO cmp_mentees(roll_no,name,program,university,cgpa,backlogs,
            certifications,internships,projects,career_goal,domain_interest,
            strengths,weaknesses,mentor_id,phone)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          RETURNING id
        `, [menteeData.roll_no, menteeData.name, menteeData.program, menteeData.university,
            menteeData.cgpa, menteeData.backlogs, menteeData.certifications,
            menteeData.internships, menteeData.projects, menteeData.career_goal,
            menteeData.domain_interest, menteeData.strengths, menteeData.weaknesses,
            mentorId, phone]);
        menteeId = ins.rows[0].id;
        stats.mentees_new++;
      } else {
        menteeId = existM.rows[0].id;
        // Update only fields that are non-null in sheet
        const phoneUpd = phoneMap[menteeData.roll_no] || null;
        await client.query(`
          UPDATE cmp_mentees SET
            cgpa            = COALESCE($1, cgpa),
            certifications  = COALESCE($2, certifications),
            internships     = COALESCE($3, internships),
            projects        = COALESCE($4, projects),
            career_goal     = COALESCE($5, career_goal),
            domain_interest = COALESCE($6, domain_interest),
            strengths       = COALESCE($7, strengths),
            weaknesses      = COALESCE($8, weaknesses),
            mentor_id       = $9,
            phone           = COALESCE($10, phone)
          WHERE id=$11
        `, [menteeData.cgpa, menteeData.certifications, menteeData.internships,
            menteeData.projects, menteeData.career_goal, menteeData.domain_interest,
            menteeData.strengths, menteeData.weaknesses, mentorId, phoneUpd, menteeId]);
        stats.mentees_updated++;
      }

      // ── Group meeting attendance (col 20 = attendance, 21 = observation) ──
      const grpAtt = safeStr(row[20]);
      if (grpAtt) {
        const attended = grpAtt.toLowerCase().includes('present');
        await client.query(`
          INSERT INTO cmp_group_attendance(mentee_id, mentor_id, attended, observation)
          VALUES($1,$2,$3,$4)
          ON CONFLICT(mentee_id, mentor_id)
          DO UPDATE SET
            attended    = CASE WHEN $3=true THEN true ELSE cmp_group_attendance.attended END,
            observation = COALESCE(NULLIF($4,''), cmp_group_attendance.observation)
        `, [menteeId, mentorId, attended, safeStr(row[21])]);
        stats.group_updated++;
      }

      // ── Scores from cols 22-26 (from first meeting / group observation) ──
      // These are stored ON THE MENTEE record as baseline, NOT as Interaction 1
      const sc_resume = safeInt(row[22]);
      const sc_comm   = safeInt(row[23]);
      const sc_grm    = safeInt(row[24]);
      const sc_att    = safeInt(row[25]);
      const sc_tech   = safeInt(row[26]);
      // We don't store these as interactions — they stay as mentee profile data

      // ── Interactions 1-5: ONLY import if status = 'done' ──────
      for (let n = 0; n < 5; n++) {
        const iStart  = intCols[n];
        if (!row[iStart]) continue;
        const iStatus = safeStr(row[iStart]);
        // STRICT: only 'done' counts as a completed interaction
        if (!iStatus || iStatus.toLowerCase() !== 'done') continue;

        const iDate = parseDate(row[iStart + 1]);
        const iFb   = safeStr(row[iStart + 2]);
        const iPlan = safeStr(row[iStart + 3]);
        const interNo = n + 1;

        const existI = await client.query(
          `SELECT id FROM cmp_interactions WHERE mentee_id=$1 AND interaction_no=$2 LIMIT 1`,
          [menteeId, interNo]
        );

        if (!existI.rows.length) {
          await client.query(`
            INSERT INTO cmp_interactions(
              mentee_id, mentor_id, interaction_no, meeting_date,
              score_resume, score_comm, score_grooming, score_attitude, score_technical,
              career_goal, domain_interest, strengths, weaknesses, feedback, action_plan
            ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          `, [menteeId, mentorId, interNo, iDate,
              // Only use scores for interaction 1 (they come from cols 22-26)
              interNo === 1 ? sc_resume : null,
              interNo === 1 ? sc_comm   : null,
              interNo === 1 ? sc_grm    : null,
              interNo === 1 ? sc_att    : null,
              interNo === 1 ? sc_tech   : null,
              menteeData.career_goal, menteeData.domain_interest,
              menteeData.strengths, menteeData.weaknesses,
              iFb, iPlan]);
          stats.interactions_new++;
        } else {
          // Update feedback/plan if sheet has data portal doesn't
          if (iFb || iPlan) {
            await client.query(`
              UPDATE cmp_interactions SET
                feedback     = COALESCE(NULLIF($1,''), feedback),
                action_plan  = COALESCE(NULLIF($2,''), action_plan),
                meeting_date = COALESCE($3, meeting_date)
              WHERE id=$4
            `, [iFb, iPlan, iDate, existI.rows[0].id]);
            stats.interactions_updated++;
          }
        }
      }
    }
  }

  return stats;
}

// ══════════════════════════════════════════════════════════════════
// SYNC ENDPOINTS
// ══════════════════════════════════════════════════════════════════

// Admin: upload full workbook (all sheets)
router.post('/sync-full', auth, upload.single('file'), async (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Admin only' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const stats = await parseAndSync(req.file.buffer, client, req.user, null);
    await client.query('COMMIT');
    res.json({ success: true, ...stats });
  } catch(e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// Trainer: upload their own sheet only
router.post('/sync-mine', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  // Find which sheet name matches this trainer
  const trainerR = await pool.query(`SELECT name FROM users WHERE id=$1`, [req.user.id]);
  const trainerName = trainerR.rows[0]?.name || '';
  // Match to sheet name (first name match)
  const sheetName = ALL_MENTOR_SHEETS.find(s =>
    trainerName.toLowerCase().includes(s.toLowerCase()) ||
    s.toLowerCase().includes(trainerName.split(' ')[0].toLowerCase())
  );
  if (!sheetName) return res.status(400).json({ error: `No sheet found for ${trainerName}. Sheets available: ${ALL_MENTOR_SHEETS.join(', ')}` });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const stats = await parseAndSync(req.file.buffer, client, req.user, sheetName);
    await client.query('COMMIT');
    res.json({ success: true, sheet: sheetName, ...stats });
  } catch(e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});


// ══════════════════════════════════════════════════════════════════
// GOOGLE SHEETS AUTO-SYNC
// ══════════════════════════════════════════════════════════════════

const GSHEET_ID   = '1Zy7EYUIiTQT8GBTyEN-G50DQglqXNSVEIGk8mQc3iYU';
const GSHEET_URL  = `https://docs.google.com/spreadsheets/d/${GSHEET_ID}/export?format=xlsx`;

let autoSyncTimer = null;
let lastAutoSync  = null;
let lastSyncStats = null;

async function fetchSheetBuffer() {
  const res = await fetch(GSHEET_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CDCPortal/1.0)' },
    signal: AbortSignal.timeout(30000)
  });
  if(!res.ok) throw new Error(`Google Sheets fetch failed: ${res.status}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function runGSheetSync() {
  const client = await pool.connect();
  try {
    console.log('🔄 CMP Google Sheets auto-sync started...');
    const buffer = await fetchSheetBuffer();
    await client.query('BEGIN');
    // Use a fake super_admin user object for auto-sync
    const fakeAdmin = { id: 0, role: 'super_admin', name: 'AutoSync' };
    const stats = await parseAndSync(buffer, client, fakeAdmin, null);
    await client.query('COMMIT');
    lastAutoSync  = new Date();
    lastSyncStats = stats;
    console.log(`✅ CMP auto-sync done: ${stats.mentees_new} new, ${stats.mentees_updated} updated`);
    return stats;
  } catch(e) {
    await client.query('ROLLBACK');
    console.error('❌ CMP auto-sync failed:', e.message);
    throw e;
  } finally { client.release(); }
}

// Start auto-sync every 30 minutes
function startAutoSync() {
  if(autoSyncTimer) clearInterval(autoSyncTimer);
  // Run once on startup after 10 seconds
  setTimeout(() => runGSheetSync().catch(console.error), 10000);
  // Then every 30 minutes
  autoSyncTimer = setInterval(() => runGSheetSync().catch(console.error), 30 * 60 * 1000);
  console.log('✅ CMP auto-sync scheduled every 30 minutes');
}
startAutoSync();

// POST /api/cmp/sync-gsheet — manual sync from Google Sheets (admin only)
router.post('/sync-gsheet', auth, async (req, res) => {
  if(req.user.role !== 'super_admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const stats = await runGSheetSync();
    res.json({ success: true, source: 'Google Sheets', last_sync: lastAutoSync, ...stats });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/cmp/sync-status — check last sync time and stats
router.get('/sync-status', auth, async (req, res) => {
  res.json({
    last_sync:   lastAutoSync,
    next_sync:   lastAutoSync ? new Date(lastAutoSync.getTime() + 30*60*1000) : null,
    stats:       lastSyncStats,
    sheet_url:   `https://docs.google.com/spreadsheets/d/${GSHEET_ID}`,
  });
});

// ══════════════════════════════════════════════════════════════════
// MENTEES
// ══════════════════════════════════════════════════════════════════
router.get('/mentees', auth, async (req, res) => {
  try {
    const mentorId = (req.user.role === 'super_admin' && req.query.mentor_id)
      ? parseInt(req.query.mentor_id)
      : req.user.id;

    const r = await pool.query(`
      SELECT
        m.*,
        ga.attended     AS grp_attended,
        ga.observation  AS grp_observation,
        gm.held_date    AS grp_date,
        -- Latest interaction number
        (SELECT interaction_no FROM cmp_interactions
         WHERE mentee_id=m.id ORDER BY interaction_no DESC LIMIT 1) AS last_interaction,
        -- Latest scores
        (SELECT score_resume    FROM cmp_interactions WHERE mentee_id=m.id ORDER BY interaction_no DESC LIMIT 1) AS last_score_resume,
        (SELECT score_comm      FROM cmp_interactions WHERE mentee_id=m.id ORDER BY interaction_no DESC LIMIT 1) AS last_score_comm,
        (SELECT score_grooming  FROM cmp_interactions WHERE mentee_id=m.id ORDER BY interaction_no DESC LIMIT 1) AS last_score_grooming,
        (SELECT score_attitude  FROM cmp_interactions WHERE mentee_id=m.id ORDER BY interaction_no DESC LIMIT 1) AS last_score_attitude,
        (SELECT score_technical FROM cmp_interactions WHERE mentee_id=m.id ORDER BY interaction_no DESC LIMIT 1) AS last_score_technical
      FROM cmp_mentees m
      LEFT JOIN cmp_group_attendance ga ON ga.mentee_id=m.id AND ga.mentor_id=$1
      LEFT JOIN cmp_group_meeting gm    ON gm.mentor_id=$1
      WHERE m.mentor_id=$1
      ORDER BY m.name
    `, [mentorId]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/mentee/:id', auth, async (req, res) => {
  try {
    const m = await pool.query(
      `SELECT m.*, u.name AS mentor_name FROM cmp_mentees m
       JOIN users u ON u.id=m.mentor_id WHERE m.id=$1`,
      [req.params.id]
    );
    if (!m.rows.length) return res.status(404).json({ error: 'Not found' });

    const interactions = await pool.query(
      `SELECT * FROM cmp_interactions WHERE mentee_id=$1 ORDER BY interaction_no`,
      [req.params.id]
    );
    const referrals = await pool.query(
      `SELECT cr.*, u.name AS trainer_name FROM cmp_referrals cr
       JOIN users u ON u.id=cr.to_trainer WHERE cr.mentee_id=$1 ORDER BY cr.created_at DESC`,
      [req.params.id]
    );
    const grpAtt = await pool.query(
      `SELECT ga.*, gm.held_date FROM cmp_group_attendance ga
       LEFT JOIN cmp_group_meeting gm ON gm.mentor_id=ga.mentor_id
       WHERE ga.mentee_id=$1 LIMIT 1`,
      [req.params.id]
    );
    res.json({
      mentee:       m.rows[0],
      interactions: interactions.rows,
      referrals:    referrals.rows,
      group:        grpAtt.rows[0] || null,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
// RESUME UPLOAD
// ══════════════════════════════════════════════════════════════════
router.post('/mentee/:id/resume', auth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const url = await uploadToCloudinary(req.file.buffer, req.file.originalname, req.file.mimetype);
    await pool.query(`
      UPDATE cmp_mentees SET
        resume_url=$1, resume_name=$2, resume_type=$3, resume_uploaded_at=NOW()
      WHERE id=$4
    `, [url, req.file.originalname, req.file.mimetype, req.params.id]);
    res.json({ success:true, url, name: req.file.originalname });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
// INTERACTIONS
// ══════════════════════════════════════════════════════════════════
router.post('/interaction', auth, async (req, res) => {
  try {
    const {
      mentee_id, interaction_no, meeting_date, attendance,
      career_goal, domain_interest,
      score_resume, score_comm, score_grooming, score_attitude, score_technical,
      strengths, weaknesses, notes, feedback, action_plan, referrals,
    } = req.body;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(`
        INSERT INTO cmp_interactions(
          mentee_id, mentor_id, interaction_no, meeting_date, attendance,
          career_goal, domain_interest,
          score_resume, score_comm, score_grooming, score_attitude, score_technical,
          strengths, weaknesses, notes, feedback, action_plan, referrals
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        ON CONFLICT(mentee_id, interaction_no) DO UPDATE SET
          meeting_date=$4, attendance=$5, career_goal=$6, domain_interest=$7,
          score_resume=$8, score_comm=$9, score_grooming=$10, score_attitude=$11,
          score_technical=$12, strengths=$13, weaknesses=$14, notes=$15,
          feedback=$16, action_plan=$17, referrals=$18, created_at=NOW()
      `, [mentee_id, req.user.id, interaction_no, meeting_date, attendance||'present',
          career_goal, domain_interest, score_resume, score_comm,
          score_grooming, score_attitude, score_technical,
          strengths, weaknesses, notes, feedback, action_plan,
          JSON.stringify(referrals||[])]);

      // Update mentee career goal
      if (career_goal) {
        await client.query(
          `UPDATE cmp_mentees SET career_goal=COALESCE($1,career_goal),
           domain_interest=COALESCE($2,domain_interest) WHERE id=$3`,
          [career_goal, domain_interest, mentee_id]
        );
      }

      // Send referral notifications
      for (const ref of (referrals||[])) {
        if (!ref.trainer_id) continue;
        await client.query(`
          INSERT INTO cmp_referrals(mentee_id,from_mentor,to_trainer,domain,interaction_no,note)
          VALUES($1,$2,$3,$4,$5,$6)
        `, [mentee_id, req.user.id, ref.trainer_id, ref.domain, interaction_no, ref.note||null]);

        const mn = await client.query(`SELECT name FROM cmp_mentees WHERE id=$1`, [mentee_id]);
        await notifyUser(ref.trainer_id,
          `🎓 CMP Referral — ${ref.domain}`,
          `${req.user.name} referred ${mn.rows[0]?.name} to you for ${ref.domain} support.`
        );
      }

      await client.query('COMMIT');
      res.json({ success: true });
    } catch(e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
// GROUP MEETING
// ══════════════════════════════════════════════════════════════════
router.post('/group-meeting', auth, async (req, res) => {
  try {
    const { held_date, notes, attendance } = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        INSERT INTO cmp_group_meeting(mentor_id, held_date, notes)
        VALUES($1,$2,$3)
        ON CONFLICT(mentor_id) DO UPDATE SET held_date=$2, notes=$3
      `, [req.user.id, held_date, notes]);
      for (const a of (attendance||[])) {
        await client.query(`
          INSERT INTO cmp_group_attendance(mentee_id, mentor_id, attended, observation)
          VALUES($1,$2,$3,$4)
          ON CONFLICT(mentee_id, mentor_id) DO UPDATE SET attended=$3, observation=$4
        `, [a.mentee_id, req.user.id, a.attended, a.observation||null]);
      }
      await client.query('COMMIT');
      res.json({ success: true });
    } catch(e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/group-meeting', auth, async (req, res) => {
  try {
    const mid = req.query.mentor_id || req.user.id;
    const gm  = await pool.query(`SELECT * FROM cmp_group_meeting WHERE mentor_id=$1`, [mid]);
    const att = await pool.query(`
      SELECT ga.*, m.name AS mentee_name, m.roll_no, m.program
      FROM cmp_group_attendance ga
      JOIN cmp_mentees m ON m.id=ga.mentee_id
      WHERE ga.mentor_id=$1 ORDER BY m.name
    `, [mid]);
    res.json({ meeting: gm.rows[0]||null, attendance: att.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
// STATS & COMPLIANCE
// ══════════════════════════════════════════════════════════════════
router.get('/my-stats', auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const r = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM cmp_mentees WHERE mentor_id=$1) AS total_mentees,
        (SELECT COUNT(*) FROM cmp_group_attendance WHERE mentor_id=$1 AND attended=true) AS grp_present,
        (SELECT COUNT(DISTINCT ci.mentee_id) FROM cmp_interactions ci
         JOIN cmp_mentees m ON m.id=ci.mentee_id
         WHERE m.mentor_id=$1 AND ci.interaction_no=1) AS i1,
        (SELECT COUNT(DISTINCT ci.mentee_id) FROM cmp_interactions ci
         JOIN cmp_mentees m ON m.id=ci.mentee_id
         WHERE m.mentor_id=$1 AND ci.interaction_no=2) AS i2,
        (SELECT COUNT(DISTINCT ci.mentee_id) FROM cmp_interactions ci
         JOIN cmp_mentees m ON m.id=ci.mentee_id
         WHERE m.mentor_id=$1 AND ci.interaction_no=3) AS i3,
        (SELECT COUNT(DISTINCT ci.mentee_id) FROM cmp_interactions ci
         JOIN cmp_mentees m ON m.id=ci.mentee_id
         WHERE m.mentor_id=$1 AND ci.interaction_no=4) AS i4,
        (SELECT COUNT(DISTINCT ci.mentee_id) FROM cmp_interactions ci
         JOIN cmp_mentees m ON m.id=ci.mentee_id
         WHERE m.mentor_id=$1 AND ci.interaction_no=5) AS i5,
        (SELECT held_date FROM cmp_group_meeting WHERE mentor_id=$1 LIMIT 1) AS grp_date
    `, [uid]);

    const refs = await pool.query(
      `SELECT COUNT(*) AS given FROM cmp_referrals WHERE from_mentor=$1`, [uid]
    );
    const rcvd = await pool.query(
      `SELECT COUNT(*) AS cnt FROM cmp_referrals WHERE to_trainer=$1`, [uid]
    );

    const row = r.rows[0] || {};
    res.json({
      total_mentees: parseInt(row.total_mentees)||0,
      grp_present:   parseInt(row.grp_present)||0,
      grp_date:      row.grp_date,
      i1: parseInt(row.i1)||0,
      i2: parseInt(row.i2)||0,
      i3: parseInt(row.i3)||0,
      i4: parseInt(row.i4)||0,
      i5: parseInt(row.i5)||0,
      referrals_given:    parseInt(refs.rows[0]?.given)||0,
      referrals_received: parseInt(rcvd.rows[0]?.cnt)||0,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/compliance', auth, async (req, res) => {
  try {
    if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Admin only' });
    const r = await pool.query(`
      SELECT
        u.id   AS mentor_id,
        u.name AS mentor_name,
        -- Total mentees
        (SELECT COUNT(*) FROM cmp_mentees WHERE mentor_id=u.id) AS total,
        -- Group meeting
        gm.held_date AS grp_date,
        (SELECT COUNT(*) FROM cmp_group_attendance ga
         WHERE ga.mentor_id=u.id AND ga.attended=true) AS grp_present,
        -- Interactions — correlated subqueries avoid cartesian product
        (SELECT COUNT(DISTINCT ci.mentee_id) FROM cmp_interactions ci
         JOIN cmp_mentees m ON m.id=ci.mentee_id
         WHERE m.mentor_id=u.id AND ci.interaction_no=1) AS i1,
        (SELECT COUNT(DISTINCT ci.mentee_id) FROM cmp_interactions ci
         JOIN cmp_mentees m ON m.id=ci.mentee_id
         WHERE m.mentor_id=u.id AND ci.interaction_no=2) AS i2,
        (SELECT COUNT(DISTINCT ci.mentee_id) FROM cmp_interactions ci
         JOIN cmp_mentees m ON m.id=ci.mentee_id
         WHERE m.mentor_id=u.id AND ci.interaction_no=3) AS i3,
        (SELECT COUNT(DISTINCT ci.mentee_id) FROM cmp_interactions ci
         JOIN cmp_mentees m ON m.id=ci.mentee_id
         WHERE m.mentor_id=u.id AND ci.interaction_no=4) AS i4,
        (SELECT COUNT(DISTINCT ci.mentee_id) FROM cmp_interactions ci
         JOIN cmp_mentees m ON m.id=ci.mentee_id
         WHERE m.mentor_id=u.id AND ci.interaction_no=5) AS i5,
        -- Referrals
        (SELECT COUNT(*) FROM cmp_referrals WHERE from_mentor=u.id) AS ref_given,
        (SELECT COUNT(*) FROM cmp_referrals WHERE to_trainer=u.id)  AS ref_received
      FROM users u
      LEFT JOIN cmp_group_meeting gm ON gm.mentor_id=u.id
      WHERE u.is_active=true
        AND EXISTS(SELECT 1 FROM cmp_mentees WHERE mentor_id=u.id)
      ORDER BY u.name
    `);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
// REFERRALS
// ══════════════════════════════════════════════════════════════════
router.get('/my-referrals', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT cr.*, m.name AS mentee_name, m.roll_no, m.program, m.university,
             m.career_goal, u.name AS from_mentor_name
      FROM cmp_referrals cr
      JOIN cmp_mentees m ON m.id=cr.mentee_id
      JOIN users u ON u.id=cr.from_mentor
      WHERE cr.to_trainer=$1 ORDER BY cr.created_at DESC
    `, [req.user.id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/referral-review/:id', auth, async (req, res) => {
  try {
    const { trainer_review, trainer_score } = req.body;
    const r = await pool.query(`
      UPDATE cmp_referrals
      SET trainer_review=$1, trainer_score=$2, status='reviewed', reviewed_at=NOW()
      WHERE id=$3 AND to_trainer=$4
      RETURNING *, (SELECT name FROM cmp_mentees WHERE id=mentee_id) AS mentee_name
    `, [trainer_review, trainer_score||null, req.params.id, req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const ref = r.rows[0];
    await notifyUser(ref.from_mentor,
      `✅ Review Done — ${ref.mentee_name}`,
      `${req.user.name} reviewed ${ref.mentee_name} for ${ref.domain}: "${(trainer_review||'').slice(0,80)}"`
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
// ALL TRAINERS (for referral dropdown)
// ══════════════════════════════════════════════════════════════════
router.get('/trainers', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, designation FROM users WHERE is_active=true ORDER BY name`
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
// QUICK LINKS
// ══════════════════════════════════════════════════════════════════
router.get('/links', auth, async (req, res) => {
  const r = await pool.query('SELECT * FROM cmp_links ORDER BY sort_order');
  res.json(r.rows);
});

router.put('/links/:id', auth, async (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Admin only' });
  const { label, url, icon } = req.body;
  const r = await pool.query(
    `UPDATE cmp_links SET label=$1,url=$2,icon=$3 WHERE id=$4 RETURNING *`,
    [label, url, icon||'🔗', req.params.id]
  );
  res.json(r.rows[0]);
});

// ══════════════════════════════════════════════════════════════════
// AI REPORT
// ══════════════════════════════════════════════════════════════════
router.post('/generate-report', auth, async (req, res) => {
  try {
    const {
      mentee_id, interaction_no, student_name, roll_no, program, university,
      cgpa, career_goal, domain_interest, score_resume, score_comm,
      score_grooming, score_attitude, score_technical, strengths, weaknesses,
      notes, certifications, internships, projects, prev_scores, mentor_name,
    } = req.body;

    const isFirst = interaction_no === 1;
    const sl = s => !s ? 'Not assessed' : ['','Poor','Below Average','Average','Good','Excellent'][s];

    let prompt;
    if (isFirst) {
      prompt = `You are an expert career mentor at Manav Rachna Educational Institutions (MREI).
Generate a comprehensive personalised mentorship report. Address the student DIRECTLY by first name.

STUDENT: ${student_name} | ${roll_no} | ${program} | ${university} | CGPA: ${cgpa||'N/A'}
CAREER GOAL: ${career_goal||'Not specified'} | DOMAIN: ${domain_interest||'Not specified'}
Certifications: ${certifications||'None'} | Internships: ${internships||'None'} | Projects: ${projects||'None'}
Mentor: ${mentor_name} | Date: ${new Date().toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'})}

SCORES (1=Poor → 5=Excellent):
Resume: ${score_resume}/5 (${sl(score_resume)}) | Communication: ${score_comm}/5 (${sl(score_comm)})
Grooming: ${score_grooming}/5 (${sl(score_grooming)}) | Attitude: ${score_attitude}/5 (${sl(score_attitude)}) | Technical: ${score_technical}/5 (${sl(score_technical)})
Strengths: ${strengths||'Not noted'} | Weaknesses: ${weaknesses||'Not noted'}
Meeting notes: ${notes||'None'}

Write a FULL 2-PAGE MENTORSHIP REPORT with:
## OPENING — address by first name warmly
## CURRENT PROFILE ASSESSMENT
## RESUME IMPROVEMENT PLAN (specific to score ${score_resume}/5 and goal: ${career_goal})
## COMMUNICATION IMPROVEMENT PLAN (specific to score ${score_comm}/5)
## APTITUDE PREPARATION PLAN (topics + daily targets for ${career_goal} roles)
## TECHNICAL SKILL ROADMAP (exact skills/tools for ${career_goal})
## 30-DAY ACTION PLAN (5-7 specific tasks with deadlines)
## MENTOR'S CLOSING NOTE
Be specific. Use bullet points inside sections.`;
    } else {
      const changes = ['resume','comm','grooming','attitude','technical'].map(k => {
        const prev = prev_scores?.[`score_${k}`], curr = req.body[`score_${k}`];
        if (!prev || !curr) return null;
        const d = curr - prev;
        return `${k}: ${prev}→${curr} (${d>0?'+'+d+' ✅':d<0?d+' ⚠️':'no change'})`;
      }).filter(Boolean).join(' | ');

      prompt = `Career mentor at MREI. Write a PROGRESS UPDATE report for session ${interaction_no}.
Address student ${student_name} directly by first name.
Goal: ${career_goal||'Not specified'} | Mentor: ${mentor_name}
Date: ${new Date().toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'})}

SCORE CHANGES: ${changes||'First comparison'}
CURRENT: Resume=${score_resume}/5 Comm=${score_comm}/5 Grooming=${score_grooming}/5 Attitude=${score_attitude}/5 Tech=${score_technical}/5
Notes: ${notes||'None'} | Strengths: ${strengths||'N/A'} | Weaknesses: ${weaknesses||'N/A'}

Write a 1-PAGE PROGRESS REPORT:
## PROGRESS OVERVIEW (address by name, honest assessment)
## SCORE ANALYSIS (what improved, what declined, why it matters)
## UPDATED ACTION PLAN (5 specific next steps)
## FOCUS AREAS FOR NEXT MONTH
## MENTOR'S NOTE`;
    }

    const report = await callGroq(prompt, isFirst ? 2500 : 1500);
    if (mentee_id && interaction_no) {
      await pool.query(
        `UPDATE cmp_interactions SET ai_report=$1 WHERE mentee_id=$2 AND interaction_no=$3`,
        [report, mentee_id, interaction_no]
      );
    }
    res.json({ report });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
// AI PROGRAM REPORT (admin)
// ══════════════════════════════════════════════════════════════════
router.post('/program-report', auth, async (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const [totals, mentorwise, scores, careers] = await Promise.all([
      pool.query(`
        SELECT COUNT(DISTINCT m.id) AS total,
          COUNT(DISTINCT gm.mentor_id) AS grp_done,
          COUNT(DISTINCT CASE WHEN ci.interaction_no=1 THEN ci.mentee_id END) AS i1,
          COUNT(DISTINCT CASE WHEN ci.interaction_no>=2 THEN ci.mentee_id END) AS i2plus,
          COUNT(DISTINCT CASE WHEN ga.attended=true THEN ga.mentee_id END) AS grp_present
        FROM cmp_mentees m
        LEFT JOIN cmp_group_meeting gm ON gm.mentor_id=m.mentor_id
        LEFT JOIN cmp_group_attendance ga ON ga.mentee_id=m.id
        LEFT JOIN cmp_interactions ci ON ci.mentee_id=m.id
      `),
      pool.query(`
        SELECT u.name,COUNT(DISTINCT m.id) AS tot,
          COUNT(DISTINCT CASE WHEN ci.interaction_no=1 THEN ci.mentee_id END) AS i1,
          gm.held_date
        FROM users u JOIN cmp_mentees m ON m.mentor_id=u.id
        LEFT JOIN cmp_interactions ci ON ci.mentee_id=m.id
        LEFT JOIN cmp_group_meeting gm ON gm.mentor_id=u.id
        WHERE u.is_active=true GROUP BY u.id,u.name,gm.held_date ORDER BY i1 DESC
      `),
      pool.query(`
        SELECT ROUND(AVG(score_resume),1) AS resume, ROUND(AVG(score_comm),1) AS comm,
          ROUND(AVG(score_technical),1) AS tech
        FROM cmp_interactions WHERE interaction_no=1 AND score_resume IS NOT NULL
      `),
      pool.query(`
        SELECT career_goal, COUNT(*) AS cnt FROM cmp_mentees
        WHERE career_goal IS NOT NULL GROUP BY career_goal ORDER BY cnt DESC LIMIT 8
      `),
    ]);
    const t  = totals.rows[0];
    const sc = scores.rows[0];
    const summary = mentorwise.rows.map(r =>
      `${r.name}: ${r.tot} mentees | Grp meeting: ${r.held_date?'✅':'❌'} | 1-on-1: ${r.i1}/${r.tot}`
    ).join('\n');

    const prompt = `Write a professional CMP 2026 status report for CDC, MREI.
Date: ${new Date().toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'})}

DATA:
Total mentees: ${t.total} | Group meetings done: ${t.grp_done} | Group attended: ${t.grp_present}
First 1-on-1 completed: ${t.i1}/${t.total} (${Math.round(t.i1/t.total*100)}%)
Interaction 2+: ${t.i2plus} students
Avg scores (I1): Resume ${sc?.resume||'N/A'} | Comm ${sc?.comm||'N/A'} | Technical ${sc?.tech||'N/A'}
Career goals: ${careers.rows.map(r=>`${r.career_goal}(${r.cnt})`).join(', ')}

MENTOR STATUS:
${summary}

Write sections: ## Executive Summary | ## Progress Overview | ## Mentor Compliance | ## Student Insights | ## Concerns | ## Recommendations | ## Conclusion`;

    const report = await callGroq(prompt, 3000);
    res.json({ report });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
// DOWNLOAD REPORT AS WORD
// ══════════════════════════════════════════════════════════════════
router.post('/download-report', auth, async (req, res) => {
  try {
    const { Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle, WidthType, Table, TableRow, TableCell } = require('docx');
    const { report_text, student_name, roll_no, program, university, mentor_name, interaction_no, meeting_date } = req.body;

    const NAVY = '1E3A5F'; const ACC = '2563EB'; const LIGHT = 'EBF4FF'; const W = 'FFFFFF';
    const nb = { style: BorderStyle.NONE, size:0, color:W };
    const nbs = { top:nb, bottom:nb, left:nb, right:nb };

    const children = [
      new Paragraph({ children:[new TextRun({ text:'CDC MENTORSHIP PROGRAM 2026', bold:true, size:28, color:W, font:'Calibri' })], alignment:AlignmentType.CENTER, shading:{ type:'clear', fill:NAVY }, spacing:{ before:0, after:0 }, indent:{ left:200, right:200 } }),
      new Paragraph({ children:[new TextRun({ text:`Mentorship Report — Session ${interaction_no}`, size:22, color:W, font:'Calibri' })], alignment:AlignmentType.CENTER, shading:{ type:'clear', fill:ACC }, spacing:{ before:0, after:240 } }),
    ];

    const infoRows = [
      ['Student', student_name, 'Roll No', roll_no],
      ['Program', `${program} | ${university}`, 'Mentor', mentor_name],
      ['Date', meeting_date || new Date().toLocaleDateString('en-IN'), 'Session', `${interaction_no} of 5`],
    ];
    children.push(new Table({ width:{ size:100, type:WidthType.PERCENTAGE }, borders: { top:nb, bottom:nb, left:nb, right:nb, insideH:nb, insideV:nb },
      rows: infoRows.map(row => new TableRow({ children: [
        new TableCell({ children:[new Paragraph({ children:[new TextRun({ text:row[0], bold:true, size:20, color:NAVY, font:'Calibri' })] })], borders:nbs, shading:{ type:'clear', fill:LIGHT } }),
        new TableCell({ children:[new Paragraph({ children:[new TextRun({ text:row[1], size:20, font:'Calibri' })] })], borders:nbs }),
        new TableCell({ children:[new Paragraph({ children:[new TextRun({ text:row[2], bold:true, size:20, color:NAVY, font:'Calibri' })] })], borders:nbs, shading:{ type:'clear', fill:LIGHT } }),
        new TableCell({ children:[new Paragraph({ children:[new TextRun({ text:row[3], size:20, font:'Calibri' })] })], borders:nbs }),
      ]}))
    }));
    children.push(new Paragraph({ spacing:{ after:200 } }));

    for (const line of report_text.split('\n').filter(l=>l.trim())) {
      if (line.startsWith('## ') || line.startsWith('# ')) {
        children.push(new Paragraph({ children:[new TextRun({ text:line.replace(/^#+\s*/,'').replace(/\*/g,'').trim(), bold:true, size:24, color:W, font:'Calibri' })], shading:{ type:'clear', fill:NAVY }, spacing:{ before:240, after:80 }, indent:{ left:80, right:80 } }));
      } else if (line.match(/^[-•*]\s/)) {
        children.push(new Paragraph({ children:[new TextRun({ text:`• ${line.replace(/^[-•*]\s/,'').replace(/\*\*/g,'').trim()}`, size:20, font:'Calibri' })], spacing:{ before:60, after:60 }, indent:{ left:360 } }));
      } else {
        children.push(new Paragraph({ children:[new TextRun({ text:line.replace(/\*\*/g,'').trim(), size:20, font:'Calibri' })], spacing:{ before:80, after:80 } }));
      }
    }

    children.push(new Paragraph({ spacing:{ before:400 } }));
    children.push(new Paragraph({ children:[new TextRun({ text:'Career Development Centre (CDC) | Manav Rachna Educational Institutions | CMP 2026', size:16, color:'888888', font:'Calibri', italics:true })], alignment:AlignmentType.CENTER }));

    const doc = new Document({ sections:[{ properties:{}, children }] });
    const buffer = await Packer.toBuffer(doc);
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition',`attachment; filename="CMP_Report_${(student_name||'Report').replace(/\s+/g,'_')}_S${interaction_no}.docx"`);
    res.send(buffer);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
// RICH ANALYTICS — admin only
// trainer_id = null means all mentors combined
// ══════════════════════════════════════════════════════════════════
// ANALYTICS — admin only, clean SQL, no broken WHERE clauses
// ══════════════════════════════════════════════════════════════════
router.get('/analytics', auth, async (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const tid = req.query.trainer_id ? parseInt(req.query.trainer_id) : null;

    // Use parameterised queries — no string interpolation in WHERE clauses
    const menteeFilter  = tid ? [tid] : [];
    const menteeSQL     = tid ? 'WHERE mentor_id=$1'  : '';
    const menteeAND     = tid ? 'AND m.mentor_id=$1'  : '';
    const interJoinWhere= tid ? 'WHERE m.mentor_id=$1': '';
    const groupFilter   = tid ? 'AND mentor_id=$1'     : '';

    const [
      totals, progression, scores, careers, domains,
      cgpaDist, backlogDist, certDist, introDist, topStudents
    ] = await Promise.all([

      // 1. Overview totals
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM cmp_mentees ${menteeSQL}) AS total_mentees,
          (SELECT COUNT(*) FROM cmp_mentees WHERE resume_url IS NOT NULL ${tid ? 'AND mentor_id=$1' : ''}) AS resumes_uploaded,
          (SELECT COUNT(*) FROM cmp_group_attendance WHERE attended=true ${groupFilter}) AS grp_present,
          (SELECT COUNT(*) FROM cmp_group_attendance WHERE attended=false ${groupFilter}) AS grp_absent,
          (SELECT COUNT(DISTINCT ci.mentee_id)
           FROM cmp_interactions ci JOIN cmp_mentees m ON m.id=ci.mentee_id
           ${interJoinWhere}) AS total_interacted,
          (SELECT COUNT(DISTINCT ci.mentee_id)
           FROM cmp_interactions ci JOIN cmp_mentees m ON m.id=ci.mentee_id
           WHERE ci.interaction_no=1 ${tid ? 'AND m.mentor_id=$1' : ''}) AS i1_done,
          (SELECT COUNT(*) FROM cmp_referrals ${tid ? 'WHERE from_mentor=$1' : ''}) AS refs_given
      `, menteeFilter),

      // 2. Interaction progression
      pool.query(`
        SELECT ci.interaction_no, COUNT(DISTINCT ci.mentee_id) AS done
        FROM cmp_interactions ci
        JOIN cmp_mentees m ON m.id=ci.mentee_id
        ${interJoinWhere}
        GROUP BY ci.interaction_no ORDER BY ci.interaction_no
      `, menteeFilter),

      // 3. Average scores per interaction number
      pool.query(`
        SELECT
          ci.interaction_no,
          ROUND(AVG(ci.score_resume),1)    AS resume,
          ROUND(AVG(ci.score_comm),1)      AS comm,
          ROUND(AVG(ci.score_grooming),1)  AS grooming,
          ROUND(AVG(ci.score_attitude),1)  AS attitude,
          ROUND(AVG(ci.score_technical),1) AS technical,
          COUNT(*) AS count
        FROM cmp_interactions ci
        JOIN cmp_mentees m ON m.id=ci.mentee_id
        ${interJoinWhere}
        GROUP BY ci.interaction_no ORDER BY ci.interaction_no
      `, menteeFilter),

      // 4. Career goal distribution
      pool.query(`
        SELECT career_goal, COUNT(*) AS cnt
        FROM cmp_mentees
        WHERE career_goal IS NOT NULL AND career_goal != ''
        ${tid ? 'AND mentor_id=$1' : ''}
        GROUP BY career_goal ORDER BY cnt DESC LIMIT 10
      `, menteeFilter),

      // 5. Domain interest distribution
      pool.query(`
        SELECT domain_interest, COUNT(*) AS cnt
        FROM cmp_mentees
        WHERE domain_interest IS NOT NULL AND domain_interest != ''
        ${tid ? 'AND mentor_id=$1' : ''}
        GROUP BY domain_interest ORDER BY cnt DESC LIMIT 10
      `, menteeFilter),

      // 6. CGPA bands
      pool.query(`
        SELECT
          CASE
            WHEN cgpa >= 9   THEN '9.0+'
            WHEN cgpa >= 8   THEN '8.0-8.9'
            WHEN cgpa >= 7   THEN '7.0-7.9'
            WHEN cgpa >= 6   THEN '6.0-6.9'
            WHEN cgpa >= 5   THEN '5.0-5.9'
            ELSE 'Below 5'
          END AS band,
          COUNT(*) AS cnt
        FROM cmp_mentees
        WHERE cgpa IS NOT NULL
        ${tid ? 'AND mentor_id=$1' : ''}
        GROUP BY band ORDER BY MIN(cgpa) DESC
      `, menteeFilter),

      // 7. Backlog distribution
      pool.query(`
        SELECT
          CASE
            WHEN backlogs=0   THEN 'Clean (0)'
            WHEN backlogs<=2  THEN '1-2 Backlogs'
            WHEN backlogs<=5  THEN '3-5 Backlogs'
            ELSE '6+ Backlogs'
          END AS band,
          COUNT(*) AS cnt
        FROM cmp_mentees
        ${menteeSQL}
        GROUP BY band ORDER BY cnt DESC
      `, menteeFilter),

      // 8. Certifications status
      pool.query(`
        SELECT
          CASE WHEN certifications IS NOT NULL AND certifications != ''
               THEN 'Has Certifications' ELSE 'None' END AS status,
          COUNT(*) AS cnt
        FROM cmp_mentees ${menteeSQL}
        GROUP BY status
      `, menteeFilter),

      // 9. Internship status
      pool.query(`
        SELECT
          CASE WHEN internships IS NOT NULL AND internships != ''
               THEN 'Has Internship' ELSE 'None' END AS status,
          COUNT(*) AS cnt
        FROM cmp_mentees ${menteeSQL}
        GROUP BY status
      `, menteeFilter),

      // 10. Top students by avg score (only those with at least 1 interaction)
      pool.query(`
        SELECT
          m.name, m.roll_no, m.program, m.university, m.career_goal,
          u.name AS mentor_name,
          COUNT(ci.id) AS sessions_done,
          ROUND(AVG(
            (COALESCE(ci.score_resume,0) + COALESCE(ci.score_comm,0) +
             COALESCE(ci.score_technical,0) + COALESCE(ci.score_attitude,0)) / 4.0
          ), 1) AS avg_score
        FROM cmp_mentees m
        JOIN cmp_interactions ci ON ci.mentee_id = m.id
        JOIN users u ON u.id = m.mentor_id
        WHERE ci.score_resume IS NOT NULL
        ${tid ? 'AND m.mentor_id=$1' : ''}
        GROUP BY m.id, m.name, m.roll_no, m.program, m.university, m.career_goal, u.name
        ORDER BY avg_score DESC LIMIT 10
      `, menteeFilter),
    ]);

    res.json({
      overview:     totals.rows[0],
      total:        parseInt(totals.rows[0]?.total_mentees) || 0,
      progression:  progression.rows,
      scores:       scores.rows,
      careers:      careers.rows,
      domains:      domains.rows,
      cgpa_dist:    cgpaDist.rows,
      backlog_dist: backlogDist.rows,
      cert_dist:    certDist.rows,
      intro_dist:   introDist.rows,
      top_students: topStudents.rows,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ══════════════════════════════════════════════════════════════════
// MANUAL ATTENDANCE UPDATE — mark one student present/absent manually
// ══════════════════════════════════════════════════════════════════
router.patch('/group-attendance/:mentee_id', auth, async (req, res) => {
  try {
    const { attended, observation } = req.body;
    const mentorId = req.user.id;

    // Make sure group meeting exists for this mentor
    await pool.query(`
      INSERT INTO cmp_group_meeting(mentor_id, held_date)
      VALUES($1, NOW())
      ON CONFLICT(mentor_id) DO NOTHING
    `, [mentorId]);

    // Upsert the attendance record
    await pool.query(`
      INSERT INTO cmp_group_attendance(mentee_id, mentor_id, attended, observation)
      VALUES($1, $2, $3, $4)
      ON CONFLICT(mentee_id, mentor_id)
      DO UPDATE SET attended=$3, observation=$4
    `, [req.params.mentee_id, mentorId, attended, observation || null]);

    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
// ANALYTICS AI REPORT — trainer performance report for admin
// type = 'combined' (all) or 'individual' (one trainer)
// ══════════════════════════════════════════════════════════════════
router.post('/analytics-report', auth, async (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const { type, trainer_id } = req.body;
    const tid = trainer_id ? parseInt(trainer_id) : null;

    // Helper: fetch analytics data for one trainer or all
    const getAnalytics = async (t) => {
      const filter = t ? [t] : [];
      const mWhere = t ? 'WHERE mentor_id=$1'   : '';
      const mAnd   = t ? 'AND m.mentor_id=$1'   : '';
      const ijWhere= t ? 'WHERE m.mentor_id=$1' : '';
      const gFilter= t ? 'AND mentor_id=$1'      : '';

      const [ov, prog, sc, careers, cgpa, backlogs] = await Promise.all([
        pool.query(`SELECT
          (SELECT COUNT(*) FROM cmp_mentees ${mWhere}) AS total,
          (SELECT COUNT(*) FROM cmp_group_attendance WHERE attended=true ${gFilter}) AS grp_present,
          (SELECT COUNT(*) FROM cmp_group_attendance WHERE attended=false ${gFilter}) AS grp_absent,
          (SELECT COUNT(DISTINCT ci.mentee_id) FROM cmp_interactions ci
           JOIN cmp_mentees m ON m.id=ci.mentee_id WHERE ci.interaction_no=1 ${t?'AND m.mentor_id=$1':''}) AS i1,
          (SELECT COUNT(DISTINCT ci.mentee_id) FROM cmp_interactions ci
           JOIN cmp_mentees m ON m.id=ci.mentee_id WHERE ci.interaction_no=2 ${t?'AND m.mentor_id=$1':''}) AS i2,
          (SELECT COUNT(DISTINCT ci.mentee_id) FROM cmp_interactions ci
           JOIN cmp_mentees m ON m.id=ci.mentee_id WHERE ci.interaction_no=3 ${t?'AND m.mentor_id=$1':''}) AS i3,
          (SELECT COUNT(*) FROM cmp_referrals ${t?'WHERE from_mentor=$1':''}) AS refs_given,
          (SELECT COUNT(*) FROM cmp_mentees WHERE resume_url IS NOT NULL ${t?'AND mentor_id=$1':''}) AS resumes
        `, filter),
        pool.query(`SELECT ci.interaction_no, COUNT(DISTINCT ci.mentee_id) AS done
          FROM cmp_interactions ci JOIN cmp_mentees m ON m.id=ci.mentee_id ${ijWhere}
          GROUP BY ci.interaction_no ORDER BY ci.interaction_no`, filter),
        pool.query(`SELECT ROUND(AVG(score_resume),1) AS resume,
          ROUND(AVG(score_comm),1) AS comm, ROUND(AVG(score_technical),1) AS tech,
          ROUND(AVG(score_attitude),1) AS attitude, ROUND(AVG(score_grooming),1) AS grooming,
          COUNT(*) AS cnt
          FROM cmp_interactions ci JOIN cmp_mentees m ON m.id=ci.mentee_id
          WHERE ci.interaction_no=1 AND score_resume IS NOT NULL ${t?mAnd:''}`, filter),
        pool.query(`SELECT career_goal, COUNT(*) AS cnt FROM cmp_mentees
          WHERE career_goal IS NOT NULL AND career_goal != '' ${t?'AND mentor_id=$1':''}
          GROUP BY career_goal ORDER BY cnt DESC LIMIT 6`, filter),
        pool.query(`SELECT ROUND(AVG(cgpa),2) AS avg_cgpa,
          MIN(cgpa) AS min_cgpa, MAX(cgpa) AS max_cgpa,
          COUNT(CASE WHEN cgpa>=8 THEN 1 END) AS above_8,
          COUNT(CASE WHEN cgpa<6 THEN 1 END) AS below_6
          FROM cmp_mentees WHERE cgpa IS NOT NULL ${t?'AND mentor_id=$1':''}`, filter),
        pool.query(`SELECT COUNT(CASE WHEN backlogs=0 THEN 1 END) AS clean,
          COUNT(CASE WHEN backlogs>0 THEN 1 END) AS has_backlogs,
          COUNT(CASE WHEN backlogs>5 THEN 1 END) AS serious
          FROM cmp_mentees ${mWhere}`, filter),
      ]);
      return { ov:ov.rows[0], prog:prog.rows, sc:sc.rows[0], careers:careers.rows,
               cgpa:cgpa.rows[0], backlogs:backlogs.rows[0] };
    };

    const today = new Date().toLocaleDateString('en-IN', {day:'numeric',month:'long',year:'numeric'});

    if (type === 'individual' && tid) {
      // Single trainer report
      const trainerR = await pool.query(`SELECT name, designation FROM users WHERE id=$1`, [tid]);
      if (!trainerR.rows.length) return res.status(404).json({ error: 'Trainer not found' });
      const tName = trainerR.rows[0].name;
      const tDesg = trainerR.rows[0].designation || 'Trainer';
      const d = await getAnalytics(tid);
      const total = parseInt(d.ov.total) || 1;
      const i1pct = Math.round((parseInt(d.ov.i1)||0) / total * 100);
      const grpPct= Math.round((parseInt(d.ov.grp_present)||0) / total * 100);

      const prompt = `You are a senior CDC coordinator writing a confidential trainer performance report for management.

TRAINER: ${tName} (${tDesg})
PROGRAM: CDC Mentorship Program (CMP) 2026
REPORT DATE: ${today}

=== PERFORMANCE DATA ===

ASSIGNED COHORT:
- Total students: ${total}
- Career goals: ${d.careers.map(c=>`${c.career_goal}(${c.cnt})`).join(', ')||'Not captured yet'}
- CGPA: Avg=${d.cgpa.avg_cgpa||'N/A'}, Above 8.0: ${d.cgpa.above_8||0}, Below 6.0: ${d.cgpa.below_6||0}
- Students with backlogs: ${d.backlogs.has_backlogs||0}, Serious (6+): ${d.backlogs.serious||0}

ENGAGEMENT COMPLIANCE:
- Group meeting: ${d.ov.grp_present}/${total} present (${grpPct}%), ${d.ov.grp_absent} absent
- 1-on-1 Session 1: ${d.ov.i1}/${total} (${i1pct}%)
- Session 2: ${d.ov.i2||0}/${total}
- Session 3: ${d.ov.i3||0}/${total}
- Resumes collected: ${d.ov.resumes||0}
- Referrals made: ${d.ov.refs_given||0}

ASSESSMENT QUALITY (from ${d.sc?.cnt||0} scored interactions):
- Resume scoring avg: ${d.sc?.resume||'N/A'}/5
- Communication avg: ${d.sc?.comm||'N/A'}/5
- Technical avg: ${d.sc?.tech||'N/A'}/5
- Attitude avg: ${d.sc?.attitude||'N/A'}/5
- Grooming avg: ${d.sc?.grooming||'N/A'}/5

Write a PROFESSIONAL TRAINER PERFORMANCE REPORT for CDC management with these sections:

## EXECUTIVE SUMMARY
## COMPLIANCE STATUS (with clear rating: On Track / Needs Attention / Critical)
## COHORT PROFILE (student background analysis)
## ENGAGEMENT QUALITY (scoring patterns, feedback quality)
## AREAS OF STRENGTH
## AREAS OF CONCERN
## RECOMMENDATIONS FOR CDC MANAGEMENT
## SUGGESTED ACTIONS FOR NEXT REVIEW CYCLE

Be analytical, honest, and specific. Use the exact numbers. This is for internal management use only.
No more than 2 pages.`;

      const report = await callGroq(prompt, 2500);
      res.json({ report, trainer_name: tName, type: 'individual', data: d });

    } else {
      // Combined all-mentors report
      const d = await getAnalytics(null);
      const total = parseInt(d.ov.total) || 1;

      // Also get per-mentor breakdown
      const mentorBreakdown = await pool.query(`
        SELECT u.name,
          (SELECT COUNT(*) FROM cmp_mentees WHERE mentor_id=u.id) AS total,
          (SELECT COUNT(DISTINCT ci.mentee_id) FROM cmp_interactions ci
           JOIN cmp_mentees m ON m.id=ci.mentee_id WHERE m.mentor_id=u.id AND ci.interaction_no=1) AS i1,
          gm.held_date
        FROM users u
        LEFT JOIN cmp_group_meeting gm ON gm.mentor_id=u.id
        WHERE u.is_active=true AND EXISTS(SELECT 1 FROM cmp_mentees WHERE mentor_id=u.id)
        ORDER BY i1 DESC, total DESC
      `);

      const topMentors    = mentorBreakdown.rows.filter(m => parseInt(m.i1) > 0)
        .map(m => `${m.name}: ${m.i1}/${m.total} done`).join(' | ');
      const behindMentors = mentorBreakdown.rows.filter(m => parseInt(m.i1) === 0)
        .map(m => m.name).join(', ');
      const noGrpMtg      = mentorBreakdown.rows.filter(m => !m.held_date)
        .map(m => m.name).join(', ');

      const prompt = `You are a senior CDC coordinator writing a confidential department-level performance report for management.

PROGRAM: CDC Mentorship Program (CMP) 2026
INSTITUTION: Manav Rachna Educational Institutions (MREI)
REPORT DATE: ${today}

=== PROGRAM-WIDE DATA ===

SCALE:
- Total mentees enrolled: ${total} students across 18 mentors
- Career goal distribution: ${d.careers.map(c=>`${c.career_goal}(${c.cnt})`).join(', ')||'Not captured yet'}
- CGPA profile: Avg=${d.cgpa.avg_cgpa||'N/A'}, Above 8.0: ${d.cgpa.above_8||0} students, Below 6.0: ${d.cgpa.below_6||0} students
- Students with active backlogs: ${d.backlogs.has_backlogs||0} (${d.backlogs.serious||0} serious)

MENTORSHIP ACTIVITY:
- Group meetings: ${d.ov.grp_present} students attended (${Math.round(parseInt(d.ov.grp_present)/total*100)}%)
- First 1-on-1 completed: ${d.ov.i1} students (${Math.round(parseInt(d.ov.i1||0)/total*100)}%)
- Session 2+: ${d.ov.i2||0} students
- Total referrals to specialists: ${d.ov.refs_given||0}
- Resumes collected: ${d.ov.resumes||0}

MENTOR PERFORMANCE SPLIT:
- Mentors with 1-on-1 progress: ${topMentors||'None yet'}
- Mentors yet to start 1-on-1: ${behindMentors||'None'}
- Mentors without group meeting logged: ${noGrpMtg||'None — all done'}

ASSESSMENT DATA (where scored):
- Avg Resume: ${d.sc?.resume||'N/A'}/5 | Comm: ${d.sc?.comm||'N/A'}/5 | Technical: ${d.sc?.tech||'N/A'}/5

Write a PROFESSIONAL DEPARTMENT PERFORMANCE REPORT with:

## EXECUTIVE SUMMARY
## PROGRAM PROGRESS OVERVIEW
## MENTOR TEAM PERFORMANCE ANALYSIS
  - Highlight top performers by name
  - Flag mentors needing follow-up by name
  - Patterns observed across the team
## STUDENT COHORT PROFILE INSIGHTS
## PLACEMENT READINESS ASSESSMENT
## KEY RISKS AND CONCERNS
## STRATEGIC RECOMMENDATIONS FOR CDC HEAD
## ACTION ITEMS WITH SUGGESTED DEADLINES

Be analytical, data-driven, candid. Name names where relevant. This is for CDC management only.
2-3 pages.`;

      const report = await callGroq(prompt, 3000);
      res.json({ report, type: 'combined', data: d, mentor_breakdown: mentorBreakdown.rows });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
// EDIT MENTEE — trainer can update any detail of their own student
// admin can update any student
// ══════════════════════════════════════════════════════════════════
router.put('/mentee/:id', auth, async (req, res) => {
  try {
    // Security: trainer can only edit their own mentees
    if (req.user.role !== 'super_admin') {
      const check = await pool.query(
        `SELECT id FROM cmp_mentees WHERE id=$1 AND mentor_id=$2`,
        [req.params.id, req.user.id]
      );
      if (!check.rows.length) return res.status(403).json({ error: 'Not your student' });
    }

    const {
      name, program, university, phone, email,
      cgpa, backlogs,
      career_goal, domain_interest,
      strengths, weaknesses,
      certifications, internships, projects,
    } = req.body;

    const r = await pool.query(`
      UPDATE cmp_mentees SET
        name            = COALESCE(NULLIF($1,''),  name),
        program         = COALESCE(NULLIF($2,''),  program),
        university      = COALESCE(NULLIF($3,''),  university),
        phone           = $4,
        email           = COALESCE(NULLIF($5,''),  email),
        cgpa            = COALESCE($6,             cgpa),
        backlogs        = COALESCE($7,             backlogs),
        career_goal     = COALESCE(NULLIF($8,''),  career_goal),
        domain_interest = COALESCE(NULLIF($9,''),  domain_interest),
        strengths       = COALESCE(NULLIF($10,''), strengths),
        weaknesses      = COALESCE(NULLIF($11,''), weaknesses),
        certifications  = COALESCE(NULLIF($12,''), certifications),
        internships     = COALESCE(NULLIF($13,''), internships),
        projects        = COALESCE(NULLIF($14,''), projects)
      WHERE id=$15
      RETURNING *
    `, [
      name, program, university,
      phone || null,           // phone can be set to null to clear
      email,
      cgpa ? parseFloat(cgpa) : null,
      backlogs !== undefined && backlogs !== '' ? parseInt(backlogs) : null,
      career_goal, domain_interest,
      strengths, weaknesses,
      certifications, internships, projects,
      req.params.id,
    ]);

    res.json({ success: true, mentee: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
