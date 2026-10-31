CREATE TABLE IF NOT EXISTS pdfs (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    content BLOB NOT NULL,
    size_bytes INTEGER NOT NULL,
    uploaded_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS pdfs_user_uploaded_at ON pdfs(user_id, uploaded_at DESC);
