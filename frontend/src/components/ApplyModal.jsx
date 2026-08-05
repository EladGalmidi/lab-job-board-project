import { useState } from 'react';
import { applicationsApi } from '../api/index.js';

export default function ApplyModal({ job, onClose }) {
  const [form, setForm]       = useState({ applicant_name: '', applicant_email: '', cover_letter: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState(false);

  const handle = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await applicationsApi.submit({ job_id: job.id, ...form });
      setSuccess(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Submission failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <div>
            <div className="modal-title">Apply for Position</div>
            <div className="modal-subtitle">{job.title} · {job.company}</div>
          </div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {success ? (
          <div className="success-box">
            <strong>Application submitted! 🎉</strong><br />
            We'll be in touch soon. Good luck!
          </div>
        ) : (
          <form onSubmit={submit}>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Full Name *</label>
                <input
                  className="form-input"
                  name="applicant_name"
                  placeholder="Jane Smith"
                  value={form.applicant_name}
                  onChange={handle}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">Email *</label>
                <input
                  className="form-input"
                  type="email"
                  name="applicant_email"
                  placeholder="jane@example.com"
                  value={form.applicant_email}
                  onChange={handle}
                  required
                />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Cover Letter</label>
              <textarea
                className="form-textarea"
                name="cover_letter"
                placeholder="Tell us why you're the right fit..."
                value={form.cover_letter}
                onChange={handle}
                rows={5}
              />
            </div>

            {error && <div className="error-box">{error}</div>}

            <div className="form-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={loading}>
                {loading ? 'Submitting…' : 'Submit Application'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
