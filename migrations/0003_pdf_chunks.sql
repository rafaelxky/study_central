CREATE TABLE IF NOT EXISTS pdf_chunks (
    pdf_id TEXT NOT NULL REFERENCES pdfs(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content BLOB NOT NULL,
    PRIMARY KEY (pdf_id, chunk_index)
);
