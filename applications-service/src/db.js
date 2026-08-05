'use strict';

const fs = require('fs');
const { Pool } = require('pg');

/**
 * Read a Docker secret from disk, failing loudly if it is unusable.
 *
 * Docker mounts secrets as files under /run/secrets/. Reading the password from
 * a file rather than an environment variable matters because environment
 * variables leak: they are visible in `docker inspect`, in /proc/<pid>/environ
 * to anything sharing the namespace, and they are inherited by every child
 * process the service spawns.
 */
function readSecret(path) {
  let secret;
  try {
    secret = fs.readFileSync(path, 'utf8').trim();
  } catch (err) {
    throw new Error(`DB_PASSWORD_FILE=${path} could not be read: ${err.message}`);
  }
  if (!secret) {
    throw new Error(`DB_PASSWORD_FILE=${path} is empty`);
  }
  return secret;
}

/**
 * Resolve the connection string, preferring a Docker secret when configured.
 *
 * There is deliberately no hard-coded fallback. The original module defaulted to
 * 'postgresql://postgres:jobboard123@localhost:5432/jobboard', which masked a
 * misconfigured deployment and committed a real password to source control.
 */
function buildConnectionString() {
  const passwordFile = process.env.DB_PASSWORD_FILE;

  if (passwordFile) {
    const password = readSecret(passwordFile);
    const user = process.env.POSTGRES_USER || 'postgres';
    const database = process.env.POSTGRES_DB || 'jobboard';
    const host = process.env.POSTGRES_HOST || 'postgres';
    const port = process.env.POSTGRES_PORT || '5432';
    // Percent-encode the credentials: a password containing @ : / or # would
    // otherwise corrupt the URI, and the point of a secret is that we do not get
    // to constrain which characters it contains.
    return (
      `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}` +
      `@${host}:${port}/${database}`
    );
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'No database configuration: set DATABASE_URL, or set DB_PASSWORD_FILE to ' +
        'the path of a mounted Docker secret.'
    );
  }
  return url;
}

const pool = new Pool({
  connectionString: buildConnectionString(),
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err.message);
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS applications (
      id              UUID         PRIMARY KEY,
      job_id          VARCHAR(255) NOT NULL,
      applicant_name  VARCHAR(200) NOT NULL,
      applicant_email VARCHAR(200) NOT NULL,
      cover_letter    TEXT,
      status          VARCHAR(50)  DEFAULT 'pending'
                      CHECK (status IN ('pending', 'reviewed', 'accepted', 'rejected')),
      created_at      TIMESTAMP    DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_applications_job_id ON applications(job_id)
  `);

  console.log('[db] Applications table ready');
}

module.exports = { pool, initDB, buildConnectionString };
