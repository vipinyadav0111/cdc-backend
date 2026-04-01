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
    const firstName = (student_name||'').split(' ')[0];
    const today = new Date().toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'});

    // Score band label for resume
    const resumeBand = score_resume <= 2 ? 'needs a major overhaul' : score_resume === 3 ? 'has a decent base but needs targeted improvements' : 'is good but can be sharpened further';
    const commBand   = score_comm   <= 2 ? 'requires focused daily practice' : score_comm   === 3 ? 'is functional but lacks polish and confidence' : 'is good — focus on executive presence';
    const techBand   = score_technical <= 2 ? 'needs urgent structured learning' : score_technical === 3 ? 'shows basic knowledge — depth is missing' : 'is solid — now focus on advanced topics';

    let prompt;
    if (isFirst) {
      prompt = `You are a senior career mentor at CDC, Manav Rachna Educational Institutions (MREI). Write a PROFESSIONAL, PERSONALISED mentorship report. Be direct, specific, and actionable — not generic. Address the student by first name "${firstName}" throughout.

=== STUDENT PROFILE ===
Name: ${student_name} | Roll No: ${roll_no}
Program: ${program} | University: ${university} | CGPA: ${cgpa||'N/A'}
Career Goal: ${career_goal||'Not specified'} | Domain of Interest: ${domain_interest||'Not specified'}
Certifications: ${certifications||'None listed'}
Internships: ${internships||'None listed'}
Projects: ${projects||'None listed'}
Mentor: ${mentor_name} | Session Date: ${today}

=== ASSESSMENT SCORES (1=Poor, 2=Below Average, 3=Average, 4=Good, 5=Excellent) ===
Resume Quality:      ${score_resume}/5 — ${sl(score_resume)} (${resumeBand})
Communication:       ${score_comm}/5   — ${sl(score_comm)}   (${commBand})
Professional Grooming: ${score_grooming}/5 — ${sl(score_grooming)}
Attitude & Motivation: ${score_attitude}/5 — ${sl(score_attitude)}
Technical Knowledge:   ${score_technical}/5 — ${sl(score_technical)} (${techBand})

Observed Strengths: ${strengths||'Not noted'}
Observed Weaknesses: ${weaknesses||'Not noted'}
Session Notes: ${notes||'None'}

=== REPORT INSTRUCTIONS ===
Write the report with EXACTLY these 8 sections, using these exact headings:

## OPENING
Write 3–4 lines addressing ${firstName} warmly but professionally. Reference their actual CGPA (${cgpa}), career goal (${career_goal}), and at least one specific project or certification they have listed. Do not be generic.

## CURRENT PROFILE SNAPSHOT
Give an honest, balanced assessment. Mention what's working (specific strengths observed) and what gaps exist. Reference the actual scores with context — e.g., "Your Technical score of ${score_technical}/5 indicates..." Be candid, not fluffy.

## RESUME IMPROVEMENT PLAN
Score is ${score_resume}/5. Give 4–5 SPECIFIC, ACTIONABLE improvements tailored to ${career_goal} roles:
- What sections to add/remove
- How to quantify their projects (e.g., suggest specific metrics for their listed projects)
- ATS keyword strategy for ${career_goal}
- One-line example of how to rewrite a bullet point from their actual project work

## COMMUNICATION & GROOMING PLAN
Score is Comm ${score_comm}/5, Grooming ${score_grooming}/5. Give a practical weekly routine:
- Specific speaking exercises (not just "talk to friends")
- Recommended YouTube channels or apps for communication practice
- For grooming: professional dress code expectations for ${career_goal} interviews

## QUANTITATIVE APTITUDE & LOGICAL REASONING PLAN
IMPORTANT: This section is ONLY about Aptitude Test preparation — NOT coding, NOT algorithms, NOT technical subjects.
Focus specifically on:
- QA Topics to cover for ${career_goal} company placements: (e.g., Percentages, Profit & Loss, Time-Speed-Distance, Time & Work, Simple/Compound Interest, Ratio & Proportion, Number Systems, Permutation & Combination, Probability, Averages, Mixtures)
- LR Topics: (e.g., Seating Arrangements, Blood Relations, Syllogisms, Coding-Decoding, Direction Sense, Number Series, Puzzles, Analogies, Statement & Conclusions)
- Recommended resources: IndiaBIX, R.S. Aggarwal Quantitative Aptitude book, PrepInsta, Freshersworld practice sets
- Daily target: How many questions per day, which topic to take first based on weakness pattern
- Exam-style: Which aptitude format ${career_goal} companies typically use (e.g., TCS iON, AMCAT, eLitmus, Cocubes)

## TECHNICAL SKILL ROADMAP
Based on Technical score ${score_technical}/5 and goal: ${career_goal}. Cover:
- Top 3–4 technical skills/tools they must master for ${career_goal} placements
- Specific learning path: what to learn first → what next
- Free/paid resources: specific course names on Coursera, YouTube, GeeksforGeeks, LeetCode
- Project idea they can add to resume based on their existing projects (${projects||'N/A'})
- Target: what their technical profile should look like in 60 days

## 30-DAY ACTION PLAN
Give exactly 6 tasks. For each task: the task itself + specific resource/platform + measurable target.
Format strictly as:
- Week 1 (Days 1–7): [Task] — [Resource] — [Target metric]
- Week 2 (Days 8–14): [Task] — [Resource] — [Target metric]
- Week 3 (Days 15–21): [Task] — [Resource] — [Target metric]
- Week 4 (Days 22–30): [Task] — [Resource] — [Target metric]
Plus 2 bonus daily habits (e.g., "Solve 5 QA questions on IndiaBIX every morning before class").

## MENTOR'S CLOSING NOTE
2–3 lines. Be warm but honest. Reference something specific to this student. End with a motivating line tied to their career goal (${career_goal}).

TONE: Professional, direct, encouraging. No filler phrases like "I hope this finds you well". No generic advice. Every sentence must reference something specific to this student's data.`;

    } else {
      const changes = ['resume','comm','grooming','attitude','technical'].map(k => {
        const prev = prev_scores?.[`score_${k}`], curr = req.body[`score_${k}`];
        if (!prev || !curr) return null;
        const d = curr - prev;
        return `${k}: ${prev}→${curr} (${d>0?'+'+d+' ✅':d<0?d+' ⚠️':'no change'})`;
      }).filter(Boolean).join(' | ');

      prompt = `You are a senior career mentor at CDC, MREI. Write a CONCISE BUT DETAILED PROGRESS REPORT for Session ${interaction_no}. Be specific and data-driven. Address the student as "${firstName}".

STUDENT: ${student_name} | ${roll_no} | Goal: ${career_goal||'Not specified'} | Mentor: ${mentor_name}
Date: ${today} | Session: ${interaction_no} of 5

SCORE CHANGES (Previous → Current):
${changes||'No previous scores to compare — first assessment.'}

CURRENT SCORES: Resume=${score_resume}/5 | Comm=${score_comm}/5 | Grooming=${score_grooming}/5 | Attitude=${score_attitude}/5 | Technical=${score_technical}/5
Session Notes: ${notes||'None'} | Strengths: ${strengths||'N/A'} | Weaknesses: ${weaknesses||'N/A'}

Write with EXACTLY these 5 sections:

## PROGRESS OVERVIEW
Honest 3–4 line summary for ${firstName}. What has improved? What hasn't? Be candid with the data.

## SCORE ANALYSIS
For each score that changed (up or down), explain WHY it matters for ${career_goal} roles and what it signals about their readiness. Don't just list numbers — interpret them.

## QUANTITATIVE APTITUDE & LOGICAL REASONING UPDATE
Assess their likely QA/LR preparation progress. Give 3 specific next steps for aptitude practice — new topic to tackle, daily question target, mock test recommendation. Do NOT include technical/coding topics here.

## UPDATED ACTION PLAN FOR NEXT 30 DAYS
5 specific tasks with platforms and measurable targets. Reflect what's most urgent based on the current scores.

## MENTOR'S NOTE
2 lines: what you're proud of, what you'll watch closely next session. Personal and specific.`;
    }

    const report = await callGroq(prompt, isFirst ? 2800 : 1800);
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
    const {
      Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle,
      WidthType, Table, TableRow, TableCell, ShadingType, VerticalAlign,
    } = require('docx');

    const {
      report_text, student_name, roll_no, program, university,
      mentor_name, interaction_no, meeting_date,
      score_resume, score_comm, score_grooming, score_attitude, score_technical,
      career_goal,
    } = req.body;

    // ── COLOUR PALETTE ──────────────────────────────────
    const NAVY  = '1B3A6B';
    const NAVY2 = '243F7A';
    const GOLD  = 'C8960C';
    const TEAL  = '0F7173';
    const LIGHT = 'EEF3FB';
    const LGRAY = 'F7F8FA';
    const WHITE = 'FFFFFF';
    const DTEXT = '1A1A2E';
    const MUTED = '6B7280';
    const GREEN = '059669';
    const AMBER = 'D97706';
    const RED   = 'DC2626';

    // ── BORDER HELPERS ──────────────────────────────────
    const nb    = { style: BorderStyle.NONE, size: 0, color: WHITE };
    const nbs   = { top: nb, bottom: nb, left: nb, right: nb };
    const thin  = { style: BorderStyle.SINGLE, size: 4, color: 'DDDDDD' };
    const thins = { top: thin, bottom: thin, left: thin, right: thin };

    // ── SCORE HELPERS ───────────────────────────────────
    const scoreColor = s => !s ? MUTED : s <= 2 ? RED   : s === 3 ? AMBER : GREEN;
    const scoreBg    = s => !s ? 'F3F4F6' : s <= 2 ? 'FEE2E2' : s === 3 ? 'FEF3C7' : 'D1FAE5';
    const scoreLabel = s => !s ? '—' : ['','Poor','Below Avg','Average','Good','Excellent'][s];

    // ── FACTORIES ───────────────────────────────────────
    const mkPara = (text, opts = {}) => new Paragraph({
      alignment: opts.align || AlignmentType.LEFT,
      spacing:   opts.spacing || { before: 0, after: 0 },
      children:  [new TextRun({
        text: String(text || ''),
        bold: opts.bold, italics: opts.italic,
        size: opts.size || 20,
        color: opts.color || DTEXT,
        font: opts.font || 'Calibri',
      })],
    });

    const mkCell = (children, opts = {}) => new TableCell({
      children:      Array.isArray(children) ? children : [children],
      borders:       opts.borders || nbs,
      shading:       opts.bg ? { fill: opts.bg, type: ShadingType.CLEAR } : undefined,
      verticalAlign: opts.va || VerticalAlign.CENTER,
      margins:       opts.margins || { top: 80, bottom: 80, left: 120, right: 120 },
      width:         opts.width ? { size: opts.width, type: WidthType.DXA } : undefined,
    });

    // ── SECTION HEADER ──────────────────────────────────
    const sectionHeader = (text, icon) => [
      new Paragraph({
        spacing: { before: 260, after: 0 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: TEAL, space: 2 } },
        children: [
          new TextRun({ text: icon ? icon + '   ' : '', size: 22, font: 'Segoe UI Emoji' }),
          new TextRun({ text: text.toUpperCase(), bold: true, size: 22, color: NAVY, font: 'Calibri' }),
        ],
      }),
      new Paragraph({ spacing: { before: 80, after: 0 }, children: [new TextRun('')] }),
    ];

    // ── SCORE TABLE ─────────────────────────────────────
    const scores = [
      { label: 'Resume',        val: score_resume   },
      { label: 'Communication', val: score_comm      },
      { label: 'Grooming',      val: score_grooming  },
      { label: 'Attitude',      val: score_attitude  },
      { label: 'Technical',     val: score_technical },
    ];

    const scoreTable = new Table({
      width: { size: 9200, type: WidthType.DXA },
      columnWidths: [1840, 1840, 1840, 1840, 1840],
      rows: [
        new TableRow({ children: scores.map(s => mkCell(
          mkPara(s.label, { bold: true, size: 18, color: NAVY, align: AlignmentType.CENTER }),
          { bg: LIGHT, borders: thins }
        ))}),
        new TableRow({ children: scores.map(s => mkCell(
          [
            mkPara(`${s.val || '—'}/5`, { bold: true, size: 28, color: scoreColor(s.val), align: AlignmentType.CENTER }),
            mkPara(scoreLabel(s.val),   { size: 16, color: scoreColor(s.val), align: AlignmentType.CENTER, italic: true }),
          ],
          { bg: scoreBg(s.val), borders: thins, margins: { top: 100, bottom: 100, left: 80, right: 80 } }
        ))}),
      ],
    });

    // ── PARSE AI TEXT ───────────────────────────────────
    const ICONS = {
      'OPENING':                 '\u{1F44B}',
      'CURRENT PROFILE':         '\u{1F4CA}',
      'SNAPSHOT':                '\u{1F4CA}',
      'RESUME':                  '\u{1F4C4}',
      'COMMUNICATION':           '\u{1F5E3}',
      'GROOMING':                '\u{1F454}',
      'QUANTITATIVE':            '\u{1F9EE}',
      'APTITUDE':                '\u{1F9EE}',
      'LOGICAL':                 '\u{1F9EE}',
      'TECHNICAL':               '\u{1F4BB}',
      '30-DAY':                  '\u{1F4C5}',
      'ACTION PLAN':             '\u{1F4C5}',
      'MENTOR':                  '\u{1F393}',
      'PROGRESS':                '\u{1F4C8}',
      'SCORE ANALYSIS':          '\u{1F50D}',
    };
    const getIcon = heading => {
      const up = heading.toUpperCase();
      for (const [k, v] of Object.entries(ICONS)) { if (up.includes(k)) return v; }
      return '\u25B8';
    };

    const contentKids = [];
    let insertScoreAfterNext = false;

    for (const line of (report_text || '').split('\n')) {
      const t = line.trim();
      if (!t) {
        contentKids.push(new Paragraph({ spacing: { before: 60, after: 0 }, children: [new TextRun('')] }));
        continue;
      }

      // Section headings
      if (/^#{1,2}\s/.test(t)) {
        const heading = t.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim();
        const isProfile = /PROFILE|SNAPSHOT|ASSESSMENT/i.test(heading);
        contentKids.push(...sectionHeader(heading, getIcon(heading)));
        if (isProfile) {
          contentKids.push(scoreTable);
          contentKids.push(new Paragraph({ spacing: { before: 140, after: 0 }, children: [new TextRun('')] }));
        }
        continue;
      }

      // Sub-heading (bold)
      if (t.startsWith('**') && t.endsWith('**')) {
        contentKids.push(new Paragraph({
          spacing: { before: 140, after: 40 },
          children: [new TextRun({ text: t.replace(/\*\*/g,'').trim(), bold: true, size: 20, color: TEAL, font: 'Calibri' })],
        }));
        continue;
      }

      // Week/Day labels
      if (/^(Week|Day)\s+\d/i.test(t)) {
        contentKids.push(new Paragraph({
          spacing: { before: 100, after: 40 },
          border: { left: { style: BorderStyle.SINGLE, size: 16, color: GOLD, space: 4 } },
          indent: { left: 160 },
          children: [new TextRun({ text: t.replace(/\*\*/g,''), bold: true, size: 20, color: NAVY2, font: 'Calibri' })],
        }));
        continue;
      }

      // Bullet points
      if (/^[-•*+]\s/.test(t)) {
        const content = t.replace(/^[-•*+]\s*/, '').replace(/\*\*/g, '').trim();
        const bm = content.match(/^(.+?):\s(.+)/);
        if (bm && bm[1].length < 40) {
          contentKids.push(new Paragraph({
            spacing: { before: 60, after: 60 },
            indent: { left: 360, hanging: 240 },
            children: [
              new TextRun({ text: '\u25B8   ', size: 18, color: GOLD, font: 'Calibri' }),
              new TextRun({ text: bm[1] + ': ', bold: true, size: 19, color: NAVY, font: 'Calibri' }),
              new TextRun({ text: bm[2], size: 19, color: DTEXT, font: 'Calibri' }),
            ],
          }));
        } else {
          contentKids.push(new Paragraph({
            spacing: { before: 60, after: 60 },
            indent: { left: 360, hanging: 240 },
            children: [
              new TextRun({ text: '\u25B8   ', size: 18, color: GOLD, font: 'Calibri' }),
              new TextRun({ text: content, size: 19, color: DTEXT, font: 'Calibri' }),
            ],
          }));
        }
        continue;
      }

      // Plain text
      contentKids.push(new Paragraph({
        spacing: { before: 60, after: 60 },
        children: [new TextRun({ text: t.replace(/\*\*/g,''), size: 19, color: DTEXT, font: 'Calibri' })],
      }));
    }

    // ── HEADER BANNER ───────────────────────────────────
    const headerTable = new Table({
      width: { size: 9200, type: WidthType.DXA },
      columnWidths: [5520, 3680],
      rows: [
        new TableRow({
          height: { value: 900, rule: 'exact' },
          children: [
            mkCell([
              mkPara('CAREER DEVELOPMENT CENTRE', { bold: true, size: 26, color: WHITE }),
              mkPara('Manav Rachna Educational Institutions (MREI)', { size: 17, color: 'AACCEE', italic: true }),
            ], { bg: NAVY, borders: nbs, margins: { top: 140, bottom: 140, left: 200, right: 120 } }),
            mkCell([
              mkPara('CDC MENTORSHIP PROGRAM', { bold: true, size: 20, color: GOLD, align: AlignmentType.CENTER }),
              mkPara('CMP 2026', { bold: true, size: 26, color: WHITE, align: AlignmentType.CENTER }),
              mkPara(`Session ${interaction_no || 1} of 5`, { size: 17, color: 'CCDDEE', align: AlignmentType.CENTER }),
            ], { bg: NAVY2, borders: nbs, margins: { top: 100, bottom: 100, left: 120, right: 120 } }),
          ],
        }),
        new TableRow({
          height: { value: 55, rule: 'exact' },
          children: [
            mkCell(mkPara(''), { bg: GOLD, borders: nbs, margins: { top: 0, bottom: 0, left: 0, right: 0 } }),
            mkCell(mkPara(''), { bg: TEAL, borders: nbs, margins: { top: 0, bottom: 0, left: 0, right: 0 } }),
          ],
        }),
      ],
    });

    // ── INFO TABLE ──────────────────────────────────────
    const infoRows = [
      ['\u{1F464}  Student',  student_name || '\u2014', '\u{1F393}  Roll No', roll_no || '\u2014'],
      ['\u{1F4DA}  Program',  `${program || '\u2014'} \u2014 ${university || '\u2014'}`, '\u{1F468}\u200D\u{1F3EB}  Mentor', mentor_name || '\u2014'],
      ['\u{1F4C5}  Date',     meeting_date || new Date().toLocaleDateString('en-IN'), '\u{1F3AF}  Goal', career_goal || '\u2014'],
    ];

    const infoTable = new Table({
      width: { size: 9200, type: WidthType.DXA },
      columnWidths: [1600, 3000, 1600, 3000],
      rows: infoRows.map((row, i) => new TableRow({ children: [
        mkCell(mkPara(row[0], { bold: true, size: 18, color: NAVY }), { bg: LIGHT, borders: thins }),
        mkCell(mkPara(row[1], { size: 19, color: DTEXT }),             { bg: i % 2 === 0 ? WHITE : LGRAY, borders: thins }),
        mkCell(mkPara(row[2], { bold: true, size: 18, color: NAVY }), { bg: LIGHT, borders: thins }),
        mkCell(mkPara(row[3], { size: 19, color: DTEXT }),             { bg: i % 2 === 0 ? WHITE : LGRAY, borders: thins }),
      ]})),
    });

    // ── FOOTER ──────────────────────────────────────────
    const footerPara = new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 300, after: 60 },
      border: { top: { style: BorderStyle.SINGLE, size: 6, color: TEAL, space: 4 } },
      children: [
        new TextRun({ text: 'Career Development Centre (CDC)  \u00B7  ', size: 15, color: MUTED, font: 'Calibri', italics: true }),
        new TextRun({ text: 'Manav Rachna Educational Institutions', size: 15, color: NAVY, font: 'Calibri', bold: true }),
        new TextRun({ text: '  \u00B7  CMP 2026  \u00B7  CONFIDENTIAL', size: 15, color: MUTED, font: 'Calibri', italics: true }),
      ],
    });

    // ── ASSEMBLE ────────────────────────────────────────
    const doc = new Document({
      styles: { default: { document: { run: { font: 'Calibri', size: 20, color: DTEXT } } } },
      sections: [{
        properties: {
          page: { size: { width: 11906, height: 16838 }, margin: { top: 720, right: 800, bottom: 720, left: 800 } },
        },
        children: [
          headerTable,
          new Paragraph({ spacing: { before: 160, after: 0 }, children: [new TextRun('')] }),
          infoTable,
          new Paragraph({ spacing: { before: 160, after: 0 }, children: [new TextRun('')] }),
          ...contentKids,
          new Paragraph({ spacing: { before: 120, after: 120 }, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'E5E7EB', space: 1 } }, children: [new TextRun('')] }),
          footerPara,
        ],
      }],
    });

    const buffer = await Packer.toBuffer(doc);
    const safeName = (student_name || 'Report').replace(/\s+/g, '_');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="CMP2026_${safeName}_Session${interaction_no}.docx"`);
    res.send(buffer);
  } catch(e) {
    console.error('Download report error:', e);
    res.status(500).json({ error: e.message });
  }
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

Write a PROFESSIONAL, DATA-DRIVEN TRAINER PERFORMANCE REPORT for CDC senior management. Be candid, specific — use actual numbers in every section.

Use EXACTLY these sections:

## EXECUTIVE SUMMARY
One sharp paragraph: overall verdict on this trainer. Compliance rating: On Track / Needs Attention / Critical — with justification from the data.

## COHORT PROFILE
Analyse the assigned students: career goal spread, CGPA range, backlog situation. What kind of cohort is this trainer handling?

## MENTORSHIP COMPLIANCE
Break down each activity with the actual number and rate. Group meeting attendance, 1-on-1 completion, resumes collected, referrals given. For each metric state whether it is acceptable or flags a concern.

## ASSESSMENT QUALITY
Analyse the scoring averages: what do they signal about cohort placement readiness? Are scores being assessed rigorously? Flag any anomalies.

## AREAS OF STRENGTH
Specific positives based on the numbers — not generic praise.

## AREAS OF CONCERN
Direct red flags: what is lagging, what is the risk to student placement outcomes if it continues.

## RECOMMENDATIONS FOR CDC MANAGEMENT
3-4 concrete, actionable steps for the CDC head regarding this trainer.

## NEXT REVIEW PRIORITIES
3 specific things to verify at next review with measurable targets.

Tone: Professional, frank, management-grade. No filler. Every section must cite actual data.`;

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

Write a PROFESSIONAL, ANALYTICAL PROGRAM-LEVEL PERFORMANCE REPORT for CDC senior management. Be direct, data-driven, and candid. Name names where the data demands it.

Use EXACTLY these sections:

## EXECUTIVE SUMMARY
3–4 lines. Overall CMP 2026 health: On Track / Needs Intervention / Critical. State the most important number and the biggest risk in one line each.

## PROGRAM PROGRESS OVERVIEW
Use the actual numbers: total enrolled, group meeting coverage, 1-on-1 completion %, Session 2+ penetration, resumes collected, referrals made. Interpret each — what does it mean for the program's trajectory?

## MENTOR TEAM PERFORMANCE ANALYSIS
Name specific mentors by name:
- Top performers: who has strong 1-on-1 completion and what they're doing right
- Mentors needing intervention: who is behind and by how much
- Group meeting gaps: who hasn't logged their group meeting yet
- Pattern observed across the team as a whole

## STUDENT COHORT INSIGHTS
Career goal distribution — which sectors dominate and what that means for placement strategy. CGPA profile: how many are high achievers vs at-risk. Backlog situation. What does the average student in CMP 2026 look like?

## PLACEMENT READINESS ASSESSMENT
Based on avg scores (Resume, Communication, Technical): are students on track for placements? What's the biggest skills gap? What percentage of students would be interview-ready today?

## KEY RISKS & CONCERNS
3–4 specific, honest risks. Not vague concerns — specific data-backed risks (e.g., "X mentors have not completed even 1-on-1 with Y% of students — at current pace, Z students will have zero mentorship contact before placements").

## STRATEGIC RECOMMENDATIONS FOR CDC HEAD
4–5 concrete, prioritised recommendations. Each must be actionable in the next 30 days.

## ACTION ITEMS WITH DEADLINES
6 specific action items in format: [Action] — [Owner] — [Deadline]

Tone: Management-grade. Candid. Data-first. No padding. This goes to the CDC Head.`;

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
