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
 * Assemble a connection URL from discrete parts, encoding the credentials.
 *
 * Percent-encoding is the whole point of this helper. A password containing
 * @ : / ? or # corrupts the URI when interpolated naively, and neither a Docker
 * secret nor a Kubernetes secret lets us constrain which characters it holds.
 */
function composeUrl(password) {
  const user = process.env.POSTGRES_USER || 'postgres';
  const database = process.env.POSTGRES_DB || 'jobboard';
  const host = process.env.POSTGRES_HOST || 'postgres';
  const port = process.env.POSTGRES_PORT || '5432';
  return (
    `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}` +
    `@${host}:${port}/${database}`
  );
}

/**
 * Resolve the connection string from whichever configuration style is present.
 *
 * Three modes, in precedence order:
 *   1. DB_PASSWORD_FILE  -> read the password from that path (Docker secret, or
 *      a Kubernetes secret mounted as a volume) and compose the URL.
 *   2. DATABASE_URL      -> use it verbatim (the default Compose stack).
 *   3. POSTGRES_PASSWORD -> compose the URL from the discrete POSTGRES_* vars.
 *
 * Mode 3 exists because building the URL in YAML is unsafe.
 * k8s/04-applications-service.yaml originally did this:
 *
 *   value: "postgresql://$(POSTGRES_USER):$(POSTGRES_PASSWORD)@postgres:5432/$(POSTGRES_DB)"
 *
 * Kubernetes performs plain textual substitution with no encoding, so a password
 * generated the way k8s/README-k8s.md instructs -- `openssl rand -base64 20`,
 * whose alphabet includes '+', '/' and '=' -- produces a malformed URI and this
 * container died with ERR_INVALID_URL. Letting the application compose the URL
 * keeps the encoding responsibility in the one place that can do it correctly.
 *
 * There is deliberately no hard-coded fallback. The original module defaulted to
 * 'postgresql://postgres:jobboard123@localhost:5432/jobboard', which masked a
 * misconfigured deployment and committed a real password to source control.
 */
function buildConnectionString() {
  const passwordFile = process.env.DB_PASSWORD_FILE;
  if (passwordFile) {
    return composeUrl(readSecret(passwordFile));
  }

  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  if (process.env.POSTGRES_PASSWORD) {
    return composeUrl(process.env.POSTGRES_PASSWORD);
  }

  throw new Error(
    'No database configuration: set DB_PASSWORD_FILE, DATABASE_URL, or ' +
      'POSTGRES_PASSWORD (with the accompanying POSTGRES_* variables).'
  );
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
