import { useState } from 'react';
import { jobsApi } from '../api/index.js';

const EMPTY = { title: '', description: '', company: '', location: '', salary_range: '' };

export default function AddJobModal({ onClose, onAdd }) {
  const [form, setForm]       = useState(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  const handle = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const newJob = await jobsApi.create(form);
      onAdd(newJob);
    } catch (err) {
      setError(err.response?.data?.detail?.[0]?.msg || err.response?.data?.detail || 'Failed to create job.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <div className="modal-title">Post a New Job</div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <form onSubmit={submit}>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Job Title *</label>
              <input className="form-input" name="title" placeholder="Senior DevOps Engineer" value={form.title} onChange={handle} required />
            </div>
            <div className="form-group">
              <label className="form-label">Company *</label>
              <input className="form-input" name="company" placeholder="TechCorp Ltd." value={form.company} onChange={handle} required />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Location *</label>
              <input className="form-input" name="location" placeholder="Remote / Tel Aviv" value={form.location} onChange={handle} required />
            </div>
            <div className="form-group">
              <label className="form-label">Salary Range</label>
              <input className="form-input" name="salary_range" placeholder="$90k – $120k" value={form.salary_range} onChange={handle} />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Description *</label>
            <textarea className="form-textarea" name="description" placeholder="Describe the role, responsibilities and requirements…" value={form.description} onChange={handle} rows={5} required />
          </div>

          {error && <div className="error-box">{error}</div>}

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Posting…' : 'Post Job'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
