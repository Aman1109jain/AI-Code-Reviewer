-- GitHub OAuth login and app-managed webhook registration have been removed.
-- The app now authenticates to GitHub with a single static GITHUB_TOKEN
-- (see .env), and webhooks are added manually per repo in GitHub's own
-- settings, pointed at SMEE_URL. These tables are no longer used.
DROP TABLE IF EXISTS github_oauth_sessions;
DROP TABLE IF EXISTS repo_connections;
