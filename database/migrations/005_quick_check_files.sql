-- Quick Check can now review several uploaded files / a whole folder at once.
-- The original files are kept here (as [{ "path": "...", "content": "..." }])
-- so "Create PR" can push all of them in a single commit.
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS source_files JSONB;
