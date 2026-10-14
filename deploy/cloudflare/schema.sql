CREATE TABLE IF NOT EXISTS searches (
  day TEXT NOT NULL,
  repo TEXT NOT NULL,
  source TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, repo, source)
);

CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY,
  day TEXT NOT NULL,
  repo TEXT NOT NULL,
  sha TEXT,
  unit TEXT NOT NULL,
  rank INTEGER NOT NULL,
  vote INTEGER NOT NULL,
  stage TEXT NOT NULL,
  issue TEXT,
  session TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS one_vote_per_result ON votes (session, repo, unit);
