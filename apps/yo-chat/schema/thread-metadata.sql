CREATE TABLE IF NOT EXISTS thread_metadata (
    id TEXT PRIMARY KEY NOT NULL,
    namespace TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_message_preview TEXT NOT NULL,
    message_count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thread_metadata_namespace_updated
    ON thread_metadata (namespace, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_thread_metadata_updated_id ON thread_metadata (updated_at DESC, id DESC);
