/* server.js — Productivity App (all-in-one) */

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const http = require('http');
const { Server } = require('socket.io');
const cron = require('node-cron');
const nodemailer = require('nodemailer');

dotenv.config();

/* ---------- Config ---------- */
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'supersecret';
const TOKEN_TTL = '7d'; // adjust as needed

/* ---------- App & Sockets ---------- */
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

/* ---------- Middleware ---------- */
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ensure uploads folder exists
if (!fs.existsSync(path.join(__dirname, 'uploads'))) {
  fs.mkdirSync(path.join(__dirname, 'uploads'));
}

// Static files (serve frontend from /public)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- Database ---------- */
const DB_FILE = path.join(__dirname, 'database.db'); // keep using your existing database.db
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) console.error('❌ Database error:', err.message);
  else console.log('✅ Connected to SQLite database');
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT UNIQUE,
      password TEXT,
      profilePic TEXT,
      points INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER,
      title TEXT,
      description TEXT,
      deadline TEXT,
      priority TEXT DEFAULT 'low', -- low | medium | high
      status TEXT DEFAULT 'Pending',
      FOREIGN KEY(userId) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS friends(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER,
      friendId INTEGER,
      status TEXT DEFAULT 'pending', -- pending | accepted
      UNIQUE(userId, friendId),
      FOREIGN KEY(userId) REFERENCES users(id),
      FOREIGN KEY(friendId) REFERENCES users(id)
    )
  `);
});

/* ---------- Multer (profile pics) ---------- */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) =>
    cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '_')),
});
const upload = multer({ storage });

/* ---------- Helpers ---------- */
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function authenticateToken(req, res, next) {
  const token =
    req.headers['authorization']?.split(' ')[1] ||
    req.query.token ||
    req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Forbidden' });
    req.user = user;
    next();
  });
}

// Socket helpers: each user joins their own room
io.on('connection', (socket) => {
  socket.on('join', (userId) => {
    if (userId) socket.join(`user:${userId}`);
  });
});

/* ---------- Email (Nodemailer) ---------- */
let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  console.log('✉️  Email transport configured.');
} else {
  console.log('✉️  Email transport NOT configured (set SMTP_* env to enable).');
}

async function sendMail(to, subject, html) {
  if (!transporter) return;
  const from = process.env.FROM_EMAIL || 'no-reply@example.com';
  try {
    await transporter.sendMail({ from, to, subject, html });
  } catch (e) {
    console.error('Email error:', e.message);
  }
}

/* ---------- AUTH ---------- */
// POST /signup
app.post('/signup', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password)
    return res.status(400).json({ error: 'All fields are required' });

  try {
    const hashed = await bcrypt.hash(password, 10);
    db.run(
      `INSERT INTO users(name, email, password) VALUES(?,?,?)`,
      [name, email, hashed],
      function (err) {
        if (err) {
          const msg = err.message.includes('UNIQUE')
            ? 'Email already registered'
            : err.message;
          return res.status(400).json({ error: msg });
        }
        return res.json({ message: 'User registered successfully' });
      }
    );
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /login
app.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' });

  db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
    if (err || !user) return res.status(400).json({ error: 'User not found' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(403).json({ error: 'Invalid password' });

    const token = signToken({ id: user.id, email: user.email });
    res.json({ token });
  });
});

/* ---------- TASKS (CRUD + search + filter + priority + edit) ---------- */
// GET /tasks
app.get('/tasks', authenticateToken, (req, res) => {
  db.all(
    `SELECT * FROM tasks WHERE userId = ? ORDER BY id DESC`,
    [req.user.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// POST /tasks
app.post('/tasks', authenticateToken, (req, res) => {
  const { title, description, deadline, priority } = req.body || {};
  if (!title || !deadline)
    return res.status(400).json({ error: 'Title and deadline are required' });

  db.run(
    `INSERT INTO tasks(userId, title, description, deadline, priority)
     VALUES(?,?,?,?,?)`,
    [req.user.id, title, description || '', deadline, (priority || 'low').toLowerCase()],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res
        .status(201)
        .json({ message: 'Task added successfully', taskId: this.lastID });
    }
  );
});

// PUT /tasks/:id  (edit title/description/deadline/priority/status)
app.put('/tasks/:id', authenticateToken, (req, res) => {
  const { title, description, deadline, priority, status } = req.body || {};
  const fields = [];
  const params = [];

  if (title !== undefined) {
    fields.push('title = ?');
    params.push(title);
  }
  if (description !== undefined) {
    fields.push('description = ?');
    params.push(description);
  }
  if (deadline !== undefined) {
    fields.push('deadline = ?');
    params.push(deadline);
  }
  if (priority !== undefined) {
    fields.push('priority = ?');
    params.push(priority.toLowerCase());
  }
  if (status !== undefined) {
    fields.push('status = ?');
    params.push(status);
  }

  if (!fields.length) return res.json({ message: 'Nothing to update' });

  params.push(req.params.id, req.user.id);

  db.run(
    `UPDATE tasks SET ${fields.join(', ')} WHERE id = ? AND userId = ?`,
    params,
    function (err) {
      if (err) return res.status(500).json({ error: err.message });

      // Add points and socket notification on completion
      if (status === 'Completed') {
        db.run(
          `UPDATE users SET points = points + 10 WHERE id = ?`,
          [req.user.id],
          () => {}
        );
        io.to(`user:${req.user.id}`).emit('taskCompleted', {
          taskId: req.params.id,
        });
      }

      res.json({ message: 'Task updated successfully' });
    }
  );
});

// DELETE /tasks/:id
app.delete('/tasks/:id', authenticateToken, (req, res) => {
  db.run(
    `DELETE FROM tasks WHERE id = ? AND userId = ?`,
    [req.params.id, req.user.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: 'Task deleted successfully' });
    }
  );
});

// GET /tasks/search?q=...
app.get('/tasks/search', authenticateToken, (req, res) => {
  const q = `%${(req.query.q || '').toLowerCase()}%`;
  db.all(
    `SELECT * FROM tasks WHERE userId = ? AND LOWER(title) LIKE ? ORDER BY id DESC`,
    [req.user.id, q],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// GET /tasks/filter?status=Pending|Completed
app.get('/tasks/filter', authenticateToken, (req, res) => {
  const status = req.query.status || 'Pending';
  db.all(
    `SELECT * FROM tasks WHERE userId = ? AND status = ? ORDER BY id DESC`,
    [req.user.id, status],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

/* ---------- PROFILE ---------- */
// GET /profile
app.get('/profile', authenticateToken, (req, res) => {
  db.get(
    `SELECT id, name, email, profilePic, points FROM users WHERE id = ?`,
    [req.user.id],
    (err, user) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!user) return res.status(404).json({ error: 'User not found' });

      db.get(
        `SELECT
           SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN status != 'Completed' THEN 1 ELSE 0 END) AS pending
         FROM tasks WHERE userId = ?`,
        [req.user.id],
        (err2, stats) => {
          if (err2) return res.status(500).json({ error: err2.message });
          res.json({
            ...user,
            completed: stats?.completed || 0,
            pending: stats?.pending || 0,
          });
        }
      );
    }
  );
});

// PUT /profile  { name, email?, password? }
app.put('/profile', authenticateToken, async (req, res) => {
  const { name, email, password } = req.body || {};
  const updates = [];
  const params = [];

  if (name) {
    updates.push('name = ?');
    params.push(name);
  }
  if (email) {
    updates.push('email = ?');
    params.push(email);
  }
  if (password) {
    const hashed = await bcrypt.hash(password, 10);
    updates.push('password = ?');
    params.push(hashed);
  }
  if (!updates.length) return res.json({ message: 'Nothing to update' });

  params.push(req.user.id);
  db.run(
    `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
    params,
    function (err) {
      if (err) {
        const msg = err.message.includes('UNIQUE')
          ? 'Email already in use'
          : err.message;
        return res.status(400).json({ error: msg });
      }
      res.json({ message: 'Profile updated successfully' });
    }
  );
});

// POST /profile/upload  (multipart/form-data: profilePic)
app.post(
  '/profile/upload',
  authenticateToken,
  upload.single('profilePic'),
  (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const picPath = `/uploads/${req.file.filename}`;
    db.run(
      `UPDATE users SET profilePic = ? WHERE id = ?`,
      [picPath, req.user.id],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Profile picture uploaded successfully', pic: picPath });
      }
    );
  }
);

/* ---------- FRIENDS ---------- */
// POST /friends/request  { toEmail }
app.post('/friends/request', authenticateToken, (req, res) => {
  const { toEmail } = req.body || {};
  if (!toEmail) return res.status(400).json({ error: 'toEmail required' });

  db.get(`SELECT id FROM users WHERE email = ?`, [toEmail], (err, target) => {
    if (err || !target) return res.status(404).json({ error: 'User not found' });
    if (target.id === req.user.id)
      return res.status(400).json({ error: 'Cannot add yourself' });

    db.run(
      `INSERT OR IGNORE INTO friends(userId, friendId, status) VALUES(?,?, 'pending')`,
      [req.user.id, target.id],
      function (err2) {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json({ message: 'Friend request sent' });
      }
    );
  });
});

// POST /friends/accept  { requesterId }
app.post('/friends/accept', authenticateToken, (req, res) => {
  const { requesterId } = req.body || {};
  if (!requesterId) return res.status(400).json({ error: 'requesterId required' });

  // requesterId -> req.user.id
  db.run(
    `UPDATE friends SET status = 'accepted'
     WHERE userId = ? AND friendId = ?`,
    [requesterId, req.user.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0)
        return res.status(400).json({ error: 'No pending request' });

      // Create reverse edge to make friendship bidirectional
      db.run(
        `INSERT OR IGNORE INTO friends(userId, friendId, status) VALUES(?,?,'accepted')`,
        [req.user.id, requesterId],
        () => res.json({ message: 'Friend request accepted' })
      );
    }
  );
});

// GET /friends (list accepted)
app.get('/friends', authenticateToken, (req, res) => {
  db.all(
    `SELECT u.id, u.name, u.email, u.profilePic
     FROM friends f
     JOIN users u ON u.id = f.friendId
     WHERE f.userId = ? AND f.status = 'accepted'`,
    [req.user.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

/* ---------- LEADERBOARD ---------- */
// GET /leaderboard?scope=global|friends
app.get('/leaderboard', authenticateToken, (req, res) => {
  const scope = (req.query.scope || 'global').toLowerCase();

  if (scope === 'friends') {
    // friends-only
    db.all(
      `SELECT u.name, u.email,
              SUM(CASE WHEN t.status='Completed' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN t.status!='Completed' THEN 1 ELSE 0 END) AS incomplete
       FROM friends f
       JOIN users u ON u.id = f.friendId
       LEFT JOIN tasks t ON t.userId = u.id
       WHERE f.userId = ? AND f.status='accepted'
       GROUP BY u.id
       ORDER BY completed DESC, u.name ASC`,
      [req.user.id],
      (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
      }
    );
  } else {
    // global
    db.all(
      `SELECT u.name, u.email,
              SUM(CASE WHEN t.status='Completed' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN t.status!='Completed' THEN 1 ELSE 0 END) AS incomplete
       FROM users u
       LEFT JOIN tasks t ON t.userId = u.id
       GROUP BY u.id
       ORDER BY completed DESC, u.name ASC`,
      [],
      (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
      }
    );
  }
});

/* ---------- REMINDERS (cron) ---------- */
// Every 5 minutes, email reminders for tasks due in the next 60 minutes
cron.schedule('*/5 * * * *', () => {
  if (!transporter) return;

  const now = Date.now();
  const soon = now + 60 * 60 * 1000; // next 60 minutes
  db.all(
    `SELECT t.*, u.email, u.name
     FROM tasks t
     JOIN users u ON u.id = t.userId
     WHERE t.status != 'Completed'`,
    [],
    (err, rows) => {
      if (err || !rows?.length) return;
      rows.forEach((r) => {
        if (!r.deadline) return;
        const due = new Date(r.deadline).getTime();
        if (due >= now && due <= soon) {
          sendMail(
            r.email,
            '⏰ Task Reminder',
            `<p>Hi ${r.name},</p><p>Your task <strong>${r.title}</strong> is due at <strong>${r.deadline}</strong>.</p>`
          );
        }
      });
    }
  );
});

// Every Monday 8:00 AM weekly summary
cron.schedule('0 8 * * 1', () => {
  if (!transporter) return;

  db.all(`SELECT id, name, email FROM users`, [], (err, users) => {
    if (err || !users?.length) return;
    users.forEach((u) => {
      db.get(
        `SELECT
           SUM(CASE WHEN status='Completed' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN status!='Completed' THEN 1 ELSE 0 END) AS pending
         FROM tasks WHERE userId = ?`,
        [u.id],
        (err2, s) => {
          if (err2) return;
          sendMail(
            u.email,
            '📊 Weekly Productivity Summary',
            `<p>Hi ${u.name},</p>
             <p>Completed: <b>${s?.completed || 0}</b><br/>
             Pending: <b>${s?.pending || 0}</b></p>`
          );
        }
      );
    });
  });
});

/* ---------- Root/Index ---------- */
// Serve welcome page as entry (your file is public/welcome.html)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'welcome.html'));
});

/* ---------- Start ---------- */
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
