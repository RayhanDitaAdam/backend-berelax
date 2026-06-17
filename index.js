import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { readFile, writeFile, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const app = express();
const PORT = process.env.PORT || 3000;
const VIDEOS_DIR = join(import.meta.dirname, 'videos');
const ASSETS_DIR = join(import.meta.dirname, 'assets');

if (!existsSync(VIDEOS_DIR)) {
  mkdirSync(VIDEOS_DIR, { recursive: true });
}
if (!existsSync(ASSETS_DIR)) {
  mkdirSync(ASSETS_DIR, { recursive: true });
}

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Range'],
  exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length']
}));

app.use('/api/collect-data', express.json());
app.use('/api/collect-data', express.urlencoded({ extended: true }));

const db = new Database('data.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    firstName TEXT NOT NULL,
    lastName TEXT NOT NULL,
    email TEXT NOT NULL,
    joinDraw TEXT NOT NULL DEFAULT 'no',
    phone TEXT DEFAULT '',
    source TEXT DEFAULT '',
    loseCount INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Add loseCount column if upgrading from old schema
try { db.exec(`ALTER TABLE submissions ADD COLUMN loseCount INTEGER NOT NULL DEFAULT 0`); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS game_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

// Seed default config if empty
const row = db.prepare('SELECT COUNT(*) as count FROM game_config').get();
if (row.count === 0) {
  const insert = db.prepare('INSERT INTO game_config (key, value) VALUES (?, ?)');
  insert.run('gameDuration', '60');
  insert.run('level8CatchTarget', '10');

  // Asset path mappings (filenames in /api/assets/ or full URLs)
  insert.run('asset_logo', 'logo.webp');
  insert.run('asset_background', 'background.webp');
  insert.run('asset_yuki_nori', 'yuki-and-nori.webp');
  insert.run('asset_yuki_nori_success', 'yuki-and-nori-success.webp');
  insert.run('asset_almost_there', 'almost-there.webp');
  insert.run('asset_hot_gun', 'hot-gun.webp');
  insert.run('asset_bola', 'bola.webp');
  insert.run('asset_koper_game_8', 'koper-game-8.webp');
  insert.run('asset_card1', 'card1.webp');
  insert.run('asset_card2', 'card2.webp');
  insert.run('asset_card3', 'card3.webp');
  insert.run('asset_timer_icon', 'Icon-timer.png');
  insert.run('asset_koper_level1', 'step-koper-game/game1.webp');
  insert.run('asset_koper_level2', 'step-koper-game/game2-3-4.webp');
  insert.run('asset_koper_level5', 'step-koper-game/game4-5-6.webp');
  insert.run('asset_koper_level7', 'step-koper-game/game7-8.webp');
}

app.get('/', (req, res) => {
  res.json({ message: 'Hello World — Backend is running' });
});

app.get('/api/collect-data', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM submissions ORDER BY createdAt DESC').all();
    res.json(rows);
  } catch (err) {
    console.error('Error fetching data:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/collect-data', (req, res) => {
  try {
    const { firstName, lastName, email, joinDraw, phone, source, loseCount } = req.body;

    if (!firstName || !lastName || !email) {
      return res.status(400).json({ error: 'firstName, lastName, and email are required' });
    }

    const stmt = db.prepare(`
      INSERT INTO submissions (firstName, lastName, email, joinDraw, phone, source, loseCount)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      firstName.trim(),
      lastName.trim(),
      email.trim(),
      joinDraw === true || joinDraw === 'yes' || joinDraw === 'true' ? 'yes' : 'no',
      (phone || '').trim(),
      (source || '').trim(),
      loseCount != null ? loseCount : 0
    );

    res.status(201).json({
      message: 'Data collected successfully',
      id: result.lastInsertRowid
    });
  } catch (err) {
    console.error('Error saving data:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Visitor Tracking ──────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS visitor_logs (
    date TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 1
  )
`);

app.post('/api/visitors', (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`
      INSERT INTO visitor_logs (date, count) VALUES (?, 1)
      ON CONFLICT(date) DO UPDATE SET count = count + 1
    `).run(today);
    res.json({ message: 'Visitor tracked' });
  } catch (err) {
    console.error('Error tracking visitor:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/visitors', (req, res) => {
  try {
    const rows = db.prepare('SELECT date, count FROM visitor_logs ORDER BY date ASC').all();
    const total = rows.reduce((sum, r) => sum + r.count, 0);
    res.json({ total, daily: rows });
  } catch (err) {
    console.error('Error fetching visitors:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Upsert Submission ─────────────────────────────────────────
app.put('/api/collect-data/:email', express.json(), (req, res) => {
  try {
    const { email } = req.params;
    const { firstName, lastName, joinDraw, phone, source, loseCount } = req.body;

    const existing = db.prepare('SELECT id FROM submissions WHERE email = ?').get(email);

    if (existing) {
      db.prepare(`
        UPDATE submissions SET
          firstName = COALESCE(NULLIF(?, ''), firstName),
          lastName = COALESCE(NULLIF(?, ''), lastName),
          joinDraw = COALESCE(NULLIF(?, ''), joinDraw),
          phone = COALESCE(NULLIF(?, ''), phone),
          source = COALESCE(NULLIF(?, ''), source),
          loseCount = COALESCE(?, loseCount)
        WHERE email = ?
      `).run(
        (firstName || '').trim(),
        (lastName || '').trim(),
        joinDraw ? (joinDraw === true || joinDraw === 'yes' ? 'yes' : 'no') : '',
        (phone || '').trim(),
        (source || '').trim(),
        loseCount != null ? loseCount : null,
        email
      );
      res.json({ message: 'Submission updated', email });
    } else {
      const result = db.prepare(`
        INSERT INTO submissions (firstName, lastName, email, joinDraw, phone, source, loseCount)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        (firstName || '').trim(),
        (lastName || '').trim(),
        email,
        joinDraw ? (joinDraw === true || joinDraw === 'yes' ? 'yes' : 'no') : 'no',
        (phone || '').trim(),
        (source || 'game-lose').trim(),
        loseCount != null ? loseCount : 0
      );
      res.status(201).json({ message: 'Submission created', email, id: result.lastInsertRowid });
    }
  } catch (err) {
    console.error('Error upserting submission:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Game Config ──────────────────────────────────────────────
app.use('/api/game-config', express.json());

app.get('/api/game-config', (req, res) => {
  try {
    const rows = db.prepare('SELECT key, value FROM game_config').all();
    const config = {};
    for (const row of rows) config[row.key] = row.value;
    res.json(config);
  } catch (err) {
    console.error('Error fetching game config:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/game-config', (req, res) => {
  try {
    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'Request body must be an object' });
    }
    const upsert = db.prepare(`
      INSERT INTO game_config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    const tx = db.transaction((entries) => {
      for (const [key, value] of Object.entries(entries)) {
        upsert.run(key, String(value));
      }
    });
    tx(payload);
    const rows = db.prepare('SELECT key, value FROM game_config').all();
    const config = {};
    for (const row of rows) config[row.key] = row.value;
    res.json(config);
  } catch (err) {
    console.error('Error updating game config:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Asset Management ─────────────────────────────────────────
const ASSET_MIME_MAP = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

app.get('/api/assets', async (req, res) => {
  try {
    const files = await readdir(ASSETS_DIR);
    const assets = files
      .filter(f => Object.keys(ASSET_MIME_MAP).some(ext => f.toLowerCase().endsWith(ext)))
      .map(f => {
        const stats = existsSync(join(ASSETS_DIR, f)) ? statSync(join(ASSETS_DIR, f)) : null;
        return {
          filename: f,
          size: stats?.size || 0,
          updatedAt: stats?.mtime?.toISOString() || null,
          url: `/api/assets/${f}`,
        };
      })
      .sort((a, b) => b.updatedAt?.localeCompare(a.updatedAt));
    res.json(assets);
  } catch (err) {
    console.error('Error listing assets:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/assets/:filename', (req, res) => {
  const { filename } = req.params;
  // Prevent directory traversal
  if (filename.includes('..') || filename.includes('/')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const ext = '.' + filename.split('.').pop().toLowerCase();
  const mime = ASSET_MIME_MAP[ext] || 'application/octet-stream';
  const filePath = join(ASSETS_DIR, filename);
  if (!existsSync(filePath)) {
    return res.status(404).json({ error: 'Asset not found' });
  }
  res.set('Content-Type', mime);
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(filePath);
});

app.post('/api/assets', async (req, res) => {
  try {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.startsWith('multipart/form-data')) {
      return res.status(400).json({ error: 'Content-Type must be multipart/form-data' });
    }
    const boundary = '--' + contentType.split('boundary=')[1];
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);

    // Simple multipart parser
    const parts = raw.toString('latin1').split(boundary).filter(p => p.includes('filename="'));
    const saved = [];
    for (const part of parts) {
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;
      const header = part.slice(0, headerEnd);
      const filenameMatch = header.match(/filename="(.+)"/);
      if (!filenameMatch) continue;
      const filename = filenameMatch[1].replace(/[^a-zA-Z0-9._-]/g, '');
      if (!filename) continue;

      const dataStart = headerEnd + 4;
      const dataEnd = part.lastIndexOf('\r\n');
      const fileData = Buffer.from(part.slice(dataStart, dataEnd === -1 ? undefined : dataEnd), 'latin1');

      await writeFile(join(ASSETS_DIR, filename), fileData);
      saved.push({ filename, size: fileData.length, url: `/api/assets/${filename}` });
    }
    res.json({ message: 'Assets uploaded', assets: saved });
  } catch (err) {
    console.error('Error uploading assets:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/assets/:filename', async (req, res) => {
  const { filename } = req.params;
  if (filename.includes('..') || filename.includes('/')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const ext = '.' + filename.split('.').pop().toLowerCase();
  if (!ASSET_MIME_MAP[ext]) {
    return res.status(400).json({ error: 'Unsupported file type' });
  }
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (chunks.length === 0) {
      return res.status(400).json({ error: 'Empty file data' });
    }
    const filePath = join(ASSETS_DIR, filename);
    await writeFile(filePath, Buffer.concat(chunks));
    res.json({ message: 'Asset saved', filename, size: Buffer.concat(chunks).length, url: `/api/assets/${filename}` });
  } catch (err) {
    console.error('Error saving asset:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/assets/:filename', async (req, res) => {
  const { filename } = req.params;
  if (filename.includes('..') || filename.includes('/')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filePath = join(ASSETS_DIR, filename);
  if (!existsSync(filePath)) {
    return res.status(404).json({ error: 'Asset not found' });
  }
  await unlink(filePath);
  res.json({ message: 'Asset deleted', filename });
});

const MIME_MAP = { '.webm': 'video/webm', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo' };

app.get('/api/video-user/:id', async (req, res) => {
  try {
    const { id } = req.params;

    for (const [ext, mime] of Object.entries(MIME_MAP)) {
      const filePath = join(VIDEOS_DIR, `${id}${ext}`);
      if (existsSync(filePath)) {
        res.set('Content-Type', mime);
        res.set('Accept-Ranges', 'bytes');
        res.set('Cache-Control', 'public, max-age=3600');
        return res.sendFile(filePath);
      }
    }

    res.status(404).json({ error: 'Video not found' });
  } catch (err) {
    console.error('Error serving video:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/video-user/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const contentType = req.headers['content-type'] || 'video/webm';
    const ext = Object.keys(MIME_MAP).find(k => contentType.startsWith(MIME_MAP[k])) || '.webm';

    const filePath = join(VIDEOS_DIR, `${id}${ext}`);
    const chunks = [];

    for await (const chunk of req) {
      chunks.push(chunk);
    }

    if (chunks.length === 0) {
      return res.status(400).json({ error: 'Empty video data' });
    }

    await writeFile(filePath, Buffer.concat(chunks));
    console.log(`Video saved: ${id}${ext} (${Buffer.concat(chunks).length} bytes)`);

    res.json({ message: 'Video saved successfully', id, filename: `${id}${ext}` });
  } catch (err) {
    console.error('Error saving video:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/preview-video', async (req, res) => {
  try {
    const files = await readdir(VIDEOS_DIR);
    const videos = files
      .filter(f => Object.keys(MIME_MAP).some(ext => f.endsWith(ext)))
      .map(f => {
        const stats = existsSync(join(VIDEOS_DIR, f)) ? statSync(join(VIDEOS_DIR, f)) : null;
        const id = Object.keys(MIME_MAP).reduce((acc, ext) => f.endsWith(ext) ? f.slice(0, -ext.length) : acc, f);
        return {
          id,
          filename: f,
          size: stats?.size || 0,
          createdAt: stats?.birthtime || stats?.mtime || null
        };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(videos);
  } catch (err) {
    console.error('Error listing videos:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/video-user/:id', async (req, res) => {
  try {
    const { id } = req.params;

    for (const ext of Object.keys(MIME_MAP)) {
      const filePath = join(VIDEOS_DIR, `${id}${ext}`);
      if (existsSync(filePath)) {
        await unlink(filePath);
        return res.json({ message: 'Video deleted successfully', id });
      }
    }

    res.status(404).json({ error: 'Video not found' });
  } catch (err) {
    console.error('Error deleting video:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Catch-all 404 ────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.originalUrl });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
