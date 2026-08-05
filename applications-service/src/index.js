'use strict';

require('dotenv').config();

const express = require('express');
const cors    = require('cors');

const { pool, initDB }     = require('./db');
const applicationsRouter   = require('./routes/applications');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

/**
 * Liveness: is this process alive and able to answer at all?
 *
 * Deliberately shallow -- it must NOT touch the database. A liveness failure
 * causes the kubelet to KILL and restart the container, so making it depend on
 * an external service turns a database blip into a restart storm that removes
 * the very capacity needed to recover. Use /ready for the dependency check.
 */
app.get('/health', (_req, res) => {
  res.json({
    status: 'healthy',
    service: 'applications-service',
    version: process.env.APP_VERSION || '1.0.0',
  });
});

/**
 * Readiness: can this instance actually serve requests right now?
 *
 * Executes a real query, so the answer reflects the database dependency.
 * Returning 503 removes the pod from the Service endpoints without restarting
 * it; it rejoins automatically once the query succeeds again.
 *
 * This exists because the original /health returned a hard-coded "healthy"
 * regardless of database state, so the service reported healthy while failing
 * 100% of real requests with PostgreSQL down.
 */
app.get('/ready', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'ready',
      service: 'applications-service',
      database: 'connected',
    });
  } catch (err) {
    res.status(503).json({
      status: 'not-ready',
      service: 'applications-service',
      error: `database unavailable: ${err.message}`,
    });
  }
});

app.use('/applications', applicationsRouter);

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error' });
});

async function start() {
  try {
    await initDB();

    const server = app.listen(PORT, () => {
      console.log(`[applications-service] listening on port ${PORT}`);
    });

    /**
     * Graceful shutdown.
     *
     * Node does not handle SIGTERM by default -- the process dies immediately
     * and every in-flight request is dropped. That is measurable: during a
     * Kubernetes rolling update, endpoint removal and SIGTERM delivery race each
     * other, so a terminating pod can still receive requests for a short window.
     *
     * server.close() stops accepting NEW connections while letting in-flight
     * requests finish, then the pool is drained so PostgreSQL sees a clean
     * disconnect rather than a reset.
     *
     * This pairs with the preStop hook in k8s/04-applications-service.yaml,
     * which holds the container open long enough for the endpoint removal to
     * propagate to the ingress controller and kube-proxy before shutdown starts.
     */
    const shutdown = (signal) => {
      console.log(`[applications-service] ${signal} received, shutting down gracefully`);

      // Failsafe: if connections refuse to drain, exit anyway rather than wait
      // for SIGKILL. Must be shorter than terminationGracePeriodSeconds (30s).
      const failsafe = setTimeout(() => {
        console.error('[applications-service] graceful shutdown timed out, forcing exit');
        process.exit(1);
      }, 15000);
      failsafe.unref();

      server.close(async (err) => {
        if (err) {
          console.error('[applications-service] error closing server:', err.message);
          process.exit(1);
        }
        try {
          await pool.end();
          console.log('[applications-service] database pool drained, exiting cleanly');
          process.exit(0);
        } catch (poolErr) {
          console.error('[applications-service] error draining pool:', poolErr.message);
          process.exit(1);
        }
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    console.error('Failed to start service:', err);
    process.exit(1);
  }
}

start();
