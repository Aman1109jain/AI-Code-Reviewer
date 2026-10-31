-- One row per review session (one PR review, or one uploaded file review)
CREATE TABLE reviews (
  id SERIAL PRIMARY KEY,
  source_type VARCHAR(20) NOT NULL,      -- 'github_pr' or 'upload'
  repo_owner VARCHAR(255),               -- null if uploaded file
  repo_name VARCHAR(255),                -- null if uploaded file
  pr_number INTEGER,                     -- null if uploaded file
  file_name VARCHAR(255),                -- null if from a PR
  overall_score INTEGER,                 -- optional, used by scoring feature
  created_at TIMESTAMP DEFAULT NOW()
);

-- One row per individual issue found within a review
CREATE TABLE findings (
  id SERIAL PRIMARY KEY,
  review_id INTEGER REFERENCES reviews(id),
  file_path VARCHAR(500),
  severity VARCHAR(20),                  -- 'blocking', 'warning', 'nitpick'
  category VARCHAR(50),                  -- 'security', 'performance', 'maintainability'
  issue TEXT,
  suggestion TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Helpful indexes for the dashboard queries (list + drilldown + trends)
CREATE INDEX idx_findings_review_id ON findings(review_id);
CREATE INDEX idx_reviews_created_at ON reviews(created_at DESC);
CREATE INDEX idx_findings_severity ON findings(severity);
