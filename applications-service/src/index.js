'use strict';

require('dotenv').config();

const express = require('express');
const cors    = require('cors');

const { initDB }           = require('./db');
const applicationsRouter   = require('./routes/applications');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'healthy', service: 'applications-service', version: '1.0.0' });
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
    app.listen(PORT, () => {
      console.log(`[applications-service] listening on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start service:', err);
    process.exit(1);
  }
}

start();
