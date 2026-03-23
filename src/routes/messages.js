const router = require('express').Router();
const pool = require('../models/db');
const { auth } = require('../middleware/auth');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── SCHEMA SETUP ─────────────────────────────────────
const setupSchema = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      type VARCHAR(20) DEFAULT 'direct' CHECK (type IN ('direct','group','broadcast')),
      name VARCHAR(100),
      icon_color VARCHAR(20) DEFAULT '#3b82f6',
      created_by INTEGER REFERENCES users(id),
      is_default BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS conversation_members (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      joined_at TIMESTAMP DEFAULT NOW(),
      last_read_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(conversation_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id INTEGER REFERENCES users(id),
      sender_name VARCHAR(100),
      content TEXT,
      file_url TEXT,
      file_name VARCHAR(200),
      file_type VARCHAR(50),
      file_size INTEGER,
      is_deleted BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW(),
      expires_at TIMESTAMP DEFAULT (NOW() + INTERVAL '3 months')
    );
    CREATE TABLE IF NOT EXISTS message_reactions (
      id SERIAL PRIMARY KEY,
      message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id),
      user_name VARCHAR(100),
      emoji VARCHAR(10),
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(message_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS message_reads (
      id SERIAL PRIMARY KEY,
      message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id),
      read_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(message_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS user_presence (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      last_seen TIMESTAMP DEFAULT NOW(),
      is_online BOOLEAN DEFAULT false
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_conv_members_user ON conversation_members(user_id);

    -- Auto-delete old messages job (runs on query)
    -- Handled via WHERE clause in queries
  `);

  // Create default CDC All Staff group if not exists
  const existing = await pool.query("SELECT id FROM conversations WHERE is_default=true LIMIT 1");
  if(existing.rows.length === 0) {
    const conv = await pool.query(
      "INSERT INTO conversations (type,name,icon_color,is_default) VALUES ('group','CDC Team Meeting','#1e3a5f',true) RETURNING id"
    );
    const convId = conv.rows[0].id;
    // Add all active users
    await pool.query(
      `INSERT INTO conversation_members (conversation_id, user_id)
       SELECT $1, id FROM users WHERE is_active=true
       ON CONFLICT DO NOTHING`,
      [convId]
    );
  }
};
setupSchema().catch(console.error);

// ── PRESENCE ─────────────────────────────────────────

// POST heartbeat — update online status
router.post('/presence', auth, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO user_presence (user_id, last_seen, is_online)
       VALUES ($1, NOW(), true)
       ON CONFLICT (user_id) DO UPDATE SET last_seen=NOW(), is_online=true`,
      [req.user.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET online users
router.get('/presence', auth, async (req, res) => {
  try {
    // Mark users offline if not seen in 90 seconds
    await pool.query(
      "UPDATE user_presence SET is_online=false WHERE last_seen < NOW() - INTERVAL '90 seconds'"
    );
    const result = await pool.query(
      `SELECT u.id, u.name, u.designation, u.profile_picture,
        COALESCE(p.is_online, false) as is_online,
        p.last_seen
       FROM users u
       LEFT JOIN user_presence p ON p.user_id = u.id
       WHERE u.is_active = true
       ORDER BY p.is_online DESC NULLS LAST, u.name`
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CONVERSATIONS ─────────────────────────────────────

// GET all conversations for current user
router.get('/conversations', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        c.id, c.type, c.name, c.icon_color, c.is_default, c.created_by,
        cm.last_read_at,
        -- Last message
        (SELECT json_build_object('id',m.id,'content',m.content,'sender_name',m.sender_name,
           'file_name',m.file_name,'file_type',m.file_type,'created_at',m.created_at)
         FROM messages m WHERE m.conversation_id=c.id AND m.is_deleted=false
         AND m.expires_at > NOW()
         ORDER BY m.created_at DESC LIMIT 1) as last_message,
        -- Unread count
        (SELECT COUNT(*) FROM messages m
         WHERE m.conversation_id=c.id AND m.sender_id != $1
         AND m.created_at > cm.last_read_at AND m.is_deleted=false
         AND m.expires_at > NOW()) as unread_count,
        -- Members (for direct chat: other person's name)
        (SELECT json_agg(json_build_object('id',u.id,'name',u.name,'profile_picture',u.profile_picture,'designation',u.designation))
         FROM conversation_members cm2
         JOIN users u ON u.id = cm2.user_id
         WHERE cm2.conversation_id = c.id AND u.id != $1) as other_members,
        -- Total member count
        (SELECT COUNT(*) FROM conversation_members WHERE conversation_id=c.id) as member_count
      FROM conversations c
      JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $1
      ORDER BY COALESCE((SELECT created_at FROM messages WHERE conversation_id=c.id ORDER BY created_at DESC LIMIT 1), c.created_at) DESC
    `, [req.user.id]);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST create direct conversation or group
router.post('/conversations', auth, async (req, res) => {
  try {
    const { type, name, member_ids, icon_color } = req.body;

    if(type === 'direct') {
      const otherId = member_ids[0];
      // Check if direct conv already exists
      const existing = await pool.query(`
        SELECT c.id FROM conversations c
        JOIN conversation_members cm1 ON cm1.conversation_id=c.id AND cm1.user_id=$1
        JOIN conversation_members cm2 ON cm2.conversation_id=c.id AND cm2.user_id=$2
        WHERE c.type='direct'
        LIMIT 1
      `, [req.user.id, otherId]);
      if(existing.rows.length > 0) return res.json({ id: existing.rows[0].id, existing: true });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const conv = await client.query(
        `INSERT INTO conversations (type, name, icon_color, created_by)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [type||'group', name||null, icon_color||'#3b82f6', req.user.id]
      );
      const convId = conv.rows[0].id;

      // Add creator
      await client.query('INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2)', [convId, req.user.id]);

      // Add other members
      const allIds = [...new Set([...(member_ids||[]), req.user.id])];
      for(const uid of allIds) {
        if(uid !== req.user.id) {
          await client.query(
            'INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
            [convId, uid]
          );
        }
      }
      await client.query('COMMIT');
      res.status(201).json(conv.rows[0]);
    } catch(e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST add members to group
router.post('/conversations/:id/members', auth, async (req, res) => {
  try {
    const { user_ids } = req.body;
    for(const uid of user_ids) {
      await pool.query(
        'INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [req.params.id, uid]
      );
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE leave group
router.delete('/conversations/:id/leave', auth, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM conversation_members WHERE conversation_id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MESSAGES ─────────────────────────────────────────

// GET messages in a conversation
router.get('/conversations/:id/messages', auth, async (req, res) => {
  try {
    const { before } = req.query;
    const params = [req.params.id];
    let beforeClause = '';
    if(before) { params.push(before); beforeClause = `AND m.id < $${params.length}`; }

    const result = await pool.query(`
      SELECT
        m.*,
        json_agg(DISTINCT jsonb_build_object('emoji',r.emoji,'user_name',r.user_name,'user_id',r.user_id))
          FILTER (WHERE r.id IS NOT NULL) as reactions,
        (SELECT COUNT(*) FROM message_reads mr WHERE mr.message_id=m.id) as read_count
      FROM messages m
      LEFT JOIN message_reactions r ON r.message_id = m.id
      WHERE m.conversation_id=$1 AND m.is_deleted=false AND m.expires_at > NOW()
      ${beforeClause}
      GROUP BY m.id
      ORDER BY m.created_at DESC
      LIMIT 50
    `, params);

    // Mark as read
    await pool.query(
      `UPDATE conversation_members SET last_read_at=NOW()
       WHERE conversation_id=$1 AND user_id=$2`,
      [req.params.id, req.user.id]
    );

    // Insert read receipts for unread messages
    await pool.query(`
      INSERT INTO message_reads (message_id, user_id)
      SELECT m.id, $2 FROM messages m
      WHERE m.conversation_id=$1 AND m.sender_id != $2
      AND m.expires_at > NOW()
      ON CONFLICT DO NOTHING
    `, [req.params.id, req.user.id]);

    res.json(result.rows.reverse());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST send message (text)
router.post('/conversations/:id/messages', auth, async (req, res) => {
  try {
    const { content } = req.body;
    if(!content?.trim()) return res.status(400).json({ error: 'Message cannot be empty' });

    const result = await pool.query(
      `INSERT INTO messages (conversation_id, sender_id, sender_name, content)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, req.user.id, req.user.name, content.trim()]
    );
    res.status(201).json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST send file message (Cloudinary upload)
router.post('/conversations/:id/upload', auth, upload.single('file'), async (req, res) => {
  try {
    if(!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if(!cloudName || !apiKey || !apiSecret) {
      // Fallback: store as base64 if Cloudinary not configured
      const base64 = req.file.buffer.toString('base64');
      const dataUrl = `data:${req.file.mimetype};base64,${base64}`;
      const result = await pool.query(
        `INSERT INTO messages (conversation_id, sender_id, sender_name, content, file_url, file_name, file_type, file_size)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [req.params.id, req.user.id, req.user.name,
         `📎 ${req.file.originalname}`, dataUrl,
         req.file.originalname, req.file.mimetype, req.file.size]
      );
      return res.status(201).json(result.rows[0]);
    }

    // Upload to Cloudinary using multipart form
    const crypto = require('crypto');
    const FormData = require('form-data');

    const timestamp = Math.round(Date.now() / 1000);
    const folder = 'cdc_messages';
    const signatureStr = `folder=${folder}&timestamp=${timestamp}${apiSecret}`;
    const signature = crypto.createHash('sha1').update(signatureStr).digest('hex');

    // Determine resource type
    const isImage = req.file.mimetype.startsWith('image/');
    const resourceType = isImage ? 'image' : 'raw';

    const form = new FormData();
    form.append('file', req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype
    });
    form.append('timestamp', String(timestamp));
    form.append('api_key', apiKey);
    form.append('signature', signature);
    form.append('folder', folder);

    const uploadUrl = `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`;

    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      body: form,
      headers: form.getHeaders()
    });
    const uploadData = await uploadRes.json();

    if(!uploadData.secure_url) {
      console.error('Cloudinary error:', uploadData);
      throw new Error(uploadData.error?.message || 'Cloudinary upload failed');
    }

    const result = await pool.query(
      `INSERT INTO messages (conversation_id, sender_id, sender_name, content, file_url, file_name, file_type, file_size)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.params.id, req.user.id, req.user.name,
       `📎 ${req.file.originalname}`, uploadData.secure_url,
       req.file.originalname, req.file.mimetype, req.file.size]
    );
    res.status(201).json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST react to message
router.post('/messages/:id/react', auth, async (req, res) => {
  try {
    const { emoji } = req.body;
    // Toggle reaction
    const existing = await pool.query(
      'SELECT id, emoji FROM message_reactions WHERE message_id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    );
    if(existing.rows.length > 0) {
      if(existing.rows[0].emoji === emoji) {
        await pool.query('DELETE FROM message_reactions WHERE id=$1', [existing.rows[0].id]);
      } else {
        await pool.query('UPDATE message_reactions SET emoji=$1 WHERE id=$2', [emoji, existing.rows[0].id]);
      }
    } else {
      await pool.query(
        'INSERT INTO message_reactions (message_id, user_id, user_name, emoji) VALUES ($1,$2,$3,$4)',
        [req.params.id, req.user.id, req.user.name, emoji]
      );
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE message (soft delete)
router.delete('/messages/:id', auth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE messages SET is_deleted=true WHERE id=$1 AND sender_id=$2',
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST broadcast message to selected users
router.post('/broadcast', auth, async (req, res) => {
  try {
    const { content, user_ids } = req.body;
    if(!content?.trim()) return res.status(400).json({ error: 'Message required' });

    const targets = user_ids && user_ids.length > 0
      ? user_ids
      : (await pool.query('SELECT id FROM users WHERE is_active=true AND id!=$1', [req.user.id])).rows.map(r=>r.id);

    const created = [];
    for(const uid of targets) {
      // Find or create direct conversation
      const existing = await pool.query(`
        SELECT c.id FROM conversations c
        JOIN conversation_members cm1 ON cm1.conversation_id=c.id AND cm1.user_id=$1
        JOIN conversation_members cm2 ON cm2.conversation_id=c.id AND cm2.user_id=$2
        WHERE c.type='direct' LIMIT 1
      `, [req.user.id, uid]);

      let convId;
      if(existing.rows.length > 0) {
        convId = existing.rows[0].id;
      } else {
        const conv = await pool.query(
          'INSERT INTO conversations (type,created_by) VALUES ($1,$2) RETURNING id',
          ['direct', req.user.id]
        );
        convId = conv.rows[0].id;
        await pool.query('INSERT INTO conversation_members (conversation_id,user_id) VALUES ($1,$2),($1,$3)', [convId, req.user.id, uid]);
      }

      const msg = await pool.query(
        `INSERT INTO messages (conversation_id,sender_id,sender_name,content)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [convId, req.user.id, req.user.name, `📢 [Broadcast] ${content.trim()}`]
      );
      created.push(msg.rows[0].id);
    }
    res.json({ success: true, sent_to: targets.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET search messages
router.get('/search', auth, async (req, res) => {
  try {
    const { q } = req.query;
    if(!q) return res.json([]);
    const result = await pool.query(`
      SELECT m.*, c.name as conv_name, c.type as conv_type
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.user_id=$1
      WHERE m.content ILIKE $2 AND m.is_deleted=false AND m.expires_at > NOW()
      ORDER BY m.created_at DESC LIMIT 20
    `, [req.user.id, `%${q}%`]);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET total unread count
router.get('/unread', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT COUNT(*) as total FROM messages m
      JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=$1
      WHERE m.sender_id != $1 AND m.created_at > cm.last_read_at
      AND m.is_deleted=false AND m.expires_at > NOW()
    `, [req.user.id]);
    res.json({ unread: parseInt(result.rows[0].total) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
