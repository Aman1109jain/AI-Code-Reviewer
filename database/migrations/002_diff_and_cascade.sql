-- Store the raw PR diff alongside the review so the dashboard can show
-- "what changed" without sending people to GitHub.
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS diff_text TEXT;

-- Let deleting a review clean up its findings automatically at the DB level
-- (the app also deletes findings explicitly first, this is a safety net).
ALTER TABLE findings DROP CONSTRAINT IF EXISTS findings_review_id_fkey;
ALTER TABLE findings
  ADD CONSTRAINT findings_review_id_fkey
  FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE CASCADE;
