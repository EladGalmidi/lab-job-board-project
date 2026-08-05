'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');

const router = express.Router();

const VALID_STATUSES = ['pending', 'reviewed', 'accepted', 'rejected'];

// GET /applications
router.get('/', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM applications ORDER BY created_at DESC'
    );
    res.json(rows);
  } catch (err) {
    console.error('[GET /applications]', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /applications/:id
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM applications WHERE id = $1',
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Application not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('[GET /applications/:id]', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /applications/job/:jobId  – all applications for a specific job
router.get('/job/:jobId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM applications WHERE job_id = $1 ORDER BY created_at DESC',
      [req.params.jobId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[GET /applications/job/:jobId]', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /applications
router.post('/', async (req, res) => {
  const { job_id, applicant_name, applicant_email, cover_letter } = req.body;

  if (!job_id || !applicant_name || !applicant_email) {
    return res.status(400).json({
      error: 'job_id, applicant_name, and applicant_email are required',
    });
  }

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(applicant_email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  try {
    const id = uuidv4();
    const { rows } = await pool.query(
      `INSERT INTO applications
         (id, job_id, applicant_name, applicant_email, cover_letter)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, job_id, applicant_name.trim(), applicant_email.trim(), cover_letter || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[POST /applications]', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /applications/:id/status
router.patch('/:id/status', async (req, res) => {
  const { status } = req.body;

  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({
      error: `Status must be one of: ${VALID_STATUSES.join(', ')}`,
    });
  }

  try {
    const { rows } = await pool.query(
      'UPDATE applications SET status = $1 WHERE id = $2 RETURNING *',
      [status, req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Application not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('[PATCH /applications/:id/status]', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /applications/:id
router.delete('/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM applications WHERE id = $1',
      [req.params.id]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Application not found' });
    }
    res.status(204).send();
  } catch (err) {
    console.error('[DELETE /applications/:id]', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
