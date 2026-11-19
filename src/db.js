// D1 数据访问层：所有笔记查询都带 user_id，强制按用户隔离

export async function findUserByUsername(db, username) {
  return db.prepare(
    'SELECT id, username, password_hash, created_at FROM users WHERE username = ?'
  ).bind(username).first();
}

export async function findUserById(db, id) {
  return db.prepare(
    'SELECT id, username, created_at FROM users WHERE id = ?'
  ).bind(id).first();
}

// 单用户模式：登录时按环境变量用户名自动建档，密码校验不依赖库内哈希
export async function getOrCreateUser(db, username) {
  const existing = await findUserByUsername(db, username);
  if (existing) return existing;

  const now = Date.now();
  const info = await db.prepare(
    'INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)'
  ).bind(username, '', now).run();
  return { id: Number(info.meta.last_row_id), username, created_at: now };
}

export async function listNotes(db, userId) {
  const result = await db.prepare(`
    SELECT id, title, substr(content, 1, 160) AS excerpt, created_at, updated_at
    FROM notes WHERE user_id = ?
    ORDER BY updated_at DESC
    LIMIT 500
  `).bind(userId).all();
  return result.results || [];
}

export async function findNote(db, userId, id) {
  return db.prepare(
    'SELECT id, title, content, created_at, updated_at FROM notes WHERE id = ? AND user_id = ?'
  ).bind(id, userId).first();
}

export async function insertNote(db, userId, title, content) {
  const now = Date.now();
  const info = await db.prepare(
    'INSERT INTO notes (user_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(userId, title, content, now, now).run();
  return findNote(db, userId, Number(info.meta.last_row_id));
}

export async function updateNote(db, userId, id, title, content) {
  const now = Date.now();
  const info = await db.prepare(
    'UPDATE notes SET title = ?, content = ?, updated_at = ? WHERE id = ? AND user_id = ?'
  ).bind(title, content, now, id, userId).run();
  if (!info.meta.changes) return null;
  return findNote(db, userId, id);
}

export async function removeNote(db, userId, id) {
  const info = await db.prepare(
    'DELETE FROM notes WHERE id = ? AND user_id = ?'
  ).bind(id, userId).run();
  return (info.meta.changes || 0) > 0;
}

// ---------------- 会话登记 ----------------

export async function insertSession(db, userId, tokenHash, expiresAt) {
  await db.prepare(
    'INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
  ).bind(tokenHash, userId, expiresAt, Date.now()).run();
}

export async function findSession(db, tokenHash) {
  return db.prepare(
    'SELECT token_hash, user_id, expires_at FROM sessions WHERE token_hash = ?'
  ).bind(tokenHash).first();
}

export async function deleteSession(db, tokenHash) {
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
}

export async function deleteExpiredSessions(db) {
  await db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()).run();
}
