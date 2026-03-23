const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

const app = express();

app.use(helmet());
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','PATCH'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '10mb' })); // increased for profile pictures (base64)

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() }));

app.use('/api/auth',          require('./src/routes/auth'));
app.use('/api/users',         require('./src/routes/users'));
app.use('/api/timetable',     require('./src/routes/timetable'));
app.use('/api/duties',        require('./src/routes/duties'));
app.use('/api/notifications', require('./src/routes/notifications'));
app.use('/api/reports',       require('./src/routes/reports'));
app.use('/api/notices',       require('./src/routes/notices'));
app.use('/api/profile',       require('./src/routes/profile'));
app.use('/api/news',          require('./src/routes/news'));
app.use('/api/attendance',    require('./src/routes/attendance'));
app.use('/api/meetings',      require('./src/routes/meetings'));
app.use('/api/messages',      require('./src/routes/messages'));
app.use('/api/todos',         require('./src/routes/todos'));
app.use('/api/ai',            require('./src/routes/ai'));
app.use('/api/exams',         require('./src/routes/exams'));
app.use('/api/lessonplans',   require('./src/routes/lessonplans'));
app.use('/api/analytics',     require('./src/routes/analytics'));
app.use('/api/cmp',           require('./src/routes/cmp'));
app.use('/api/settings',      require('./src/routes/settings'));
app.use('/api/hiring',         require('./src/routes/hiringtrends'));

app.use((req, res) => res.status(404).json({ error: 'Route not found', path: req.path }));
app.use((err, req, res, next) => { console.error(err.stack); res.status(500).json({ error: 'Internal server error' }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`✅ CDC Backend running on port ${PORT}`));
module.exports = app;
