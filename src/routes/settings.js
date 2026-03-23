const router = require('express').Router();
const pool   = require('../models/db');
const { auth, adminOnly } = require('../middleware/auth');

// Auto-create tables
const setup = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS streams (
      id SERIAL PRIMARY KEY,
      institution VARCHAR(20) NOT NULL,
      program     VARCHAR(100) NOT NULL,
      semester    VARCHAR(20) NOT NULL,
      stream_name VARCHAR(150) NOT NULL,
      created_at  TIMESTAMP DEFAULT NOW(),
      UNIQUE(institution, program, semester, stream_name)
    );
    CREATE TABLE IF NOT EXISTS stream_sections (
      id        SERIAL PRIMARY KEY,
      stream_id INTEGER REFERENCES streams(id) ON DELETE CASCADE,
      section_name VARCHAR(150) NOT NULL,
      UNIQUE(stream_id, section_name)
    );
  `);
};
setup().catch(console.error);

// GET all streams with their sections
router.get('/streams', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.*,
        json_agg(ss.section_name ORDER BY ss.section_name) 
          FILTER (WHERE ss.id IS NOT NULL) as sections
      FROM streams s
      LEFT JOIN stream_sections ss ON ss.stream_id = s.id
      GROUP BY s.id
      ORDER BY s.institution, s.program, s.semester::integer, s.stream_name
    `);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET suggested sections for a stream (keyword match from timetable)
router.get('/streams/suggest', auth, adminOnly, async (req, res) => {
  try {
    const { institution, program, semester, stream_name } = req.query;

    // Build keyword list from stream_name + program + semester
    const keywords = [];
    if(institution) keywords.push(institution.toUpperCase());
    
    // Extract branch keywords from stream_name
    const streamLower = (stream_name||'').toLowerCase();
    if(streamLower.includes('cse')) keywords.push('CSE');
    if(streamLower.includes('ece')) keywords.push('ECE');
    if(streamLower.includes('me') || streamLower.includes('mechanical')) keywords.push('ME');
    if(streamLower.includes('civil')) keywords.push('CIVIL');
    if(streamLower.includes('ee') || streamLower.includes('electrical')) keywords.push('EE');
    if(streamLower.includes('bca')) keywords.push('BCA');
    if(streamLower.includes('mca')) keywords.push('MCA');
    if(streamLower.includes('bba')) keywords.push('BBA');
    if(streamLower.includes('bcom') || streamLower.includes('b.com')) keywords.push('BCOM');
    if(streamLower.includes('mba')) keywords.push('MBA');
    if(streamLower.includes('law') || streamLower.includes('llb')) keywords.push('LAW');
    if(streamLower.includes('bt') || streamLower.includes('biotech')) keywords.push('BT');
    if(streamLower.includes('aiml')) keywords.push('AIML');
    if(streamLower.includes('msc') || streamLower.includes('m.sc')) keywords.push('MSc');

    // Get all unique class names from timetable matching institution
    const result = await pool.query(`
      SELECT DISTINCT class_name
      FROM timetable
      WHERE institution = $1
      AND class_name IS NOT NULL AND class_name != ''
      ORDER BY class_name
    `, [institution]);

    const allSections = result.rows.map(r => r.class_name);

    // Filter by semester number AND branch keywords
    const semNum = semester?.toString();
    const suggested = allSections.filter(name => {
      const n = name.toUpperCase();
      // Must contain semester number
      if(semNum && !n.includes(semNum)) return false;
      // Must contain at least one branch keyword (skip institution itself)
      const branchKws = keywords.filter(k => k !== institution.toUpperCase());
      if(branchKws.length === 0) return true;
      return branchKws.some(k => n.includes(k));
    });

    res.json({ suggested, all: allSections });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST create stream
router.post('/streams', auth, adminOnly, async (req, res) => {
  try {
    const { institution, program, semester, stream_name, sections } = req.body;
    if(!institution || !program || !semester || !stream_name)
      return res.status(400).json({ error: 'institution, program, semester, stream_name required' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `INSERT INTO streams (institution, program, semester, stream_name)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (institution,program,semester,stream_name) DO UPDATE SET institution=$1
         RETURNING *`,
        [institution, program, semester.toString(), stream_name]
      );
      const streamId = r.rows[0].id;
      if(sections?.length) {
        await client.query('DELETE FROM stream_sections WHERE stream_id=$1', [streamId]);
        for(const sec of sections) {
          await client.query(
            'INSERT INTO stream_sections (stream_id, section_name) VALUES ($1,$2) ON CONFLICT DO NOTHING',
            [streamId, sec]
          );
        }
      }
      await client.query('COMMIT');
      res.status(201).json(r.rows[0]);
    } catch(e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT update stream sections
router.put('/streams/:id', auth, adminOnly, async (req, res) => {
  try {
    const { sections } = req.body;
    await pool.query('DELETE FROM stream_sections WHERE stream_id=$1', [req.params.id]);
    if(sections?.length) {
      for(const sec of sections) {
        await pool.query(
          'INSERT INTO stream_sections (stream_id, section_name) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [req.params.id, sec]
        );
      }
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE stream
router.delete('/streams/:id', auth, adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM streams WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST bulk seed streams from frontend (import from Excel data)
router.post('/streams/bulk-seed', auth, adminOnly, async (req, res) => {
  try {
    const { streams } = req.body; // [{institution, program, semester, stream_name}]
    let inserted = 0;
    for(const s of streams) {
      await pool.query(
        `INSERT INTO streams (institution, program, semester, stream_name)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [s.institution, s.program, s.semester.toString(), s.stream_name]
      );
      inserted++;
    }
    res.json({ success: true, inserted });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
