import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { readFile, writeFile, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const app = express();
const PORT = process.env.PORT || 3000;
const VIDEOS_DIR = join(import.meta.dirname, 'videos');

if (!existsSync(VIDEOS_DIR)) {
  mkdirSync(VIDEOS_DIR, { recursive: true });
}

app.use(cors({ origin: '*' }));
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
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

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
    const { firstName, lastName, email, joinDraw, phone, source } = req.body;

    if (!firstName || !lastName || !email) {
      return res.status(400).json({ error: 'firstName, lastName, and email are required' });
    }

    const stmt = db.prepare(`
      INSERT INTO submissions (firstName, lastName, email, joinDraw, phone, source)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      firstName.trim(),
      lastName.trim(),
      email.trim(),
      joinDraw === true || joinDraw === 'yes' || joinDraw === 'true' ? 'yes' : 'no',
      (phone || '').trim(),
      (source || '').trim()
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

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
