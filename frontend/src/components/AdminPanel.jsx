import { useState, useEffect } from 'react';
import { applicationsApi } from '../api/index.js';
import JobList from './JobList.jsx';

export default function AdminPanel({ jobs, onApply, onDelete, onAddJob }) {
  const [applications, setApplications] = useState([]);
  const [loadingApps, setLoadingApps]   = useState(false);
  const [appsError, setAppsError]       = useState('');
  const [activeSection, setActiveSection] = useState('jobs');

  useEffect(() => {
    if (activeSection === 'applications') fetchApplications();
  }, [activeSection]);

  const fetchApplications = async () => {
    setLoadingApps(true);
    setAppsError('');
    try {
      const data = await applicationsApi.getAll();
      setApplications(data);
    } catch {
      setAppsError('Failed to load applications. Is the applications-service running?');
    } finally {
      setLoadingApps(false);
    }
  };

  const handleStatusChange = async (id, status) => {
    try {
      const updated = await applicationsApi.updateStatus(id, status);
      setApplications(applications.map(a => a.id === id ? updated : a));
    } catch {
      alert('Failed to update status');
    }
  };

  const statusColor = (s) => ({
    pending:  '#f59e0b', reviewed: '#3b82f6',
    accepted: '#10b981', rejected: '#ef4444',
  }[s] || '#64748b');

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1.4rem', fontWeight: 600 }}>Admin Panel</h2>
        <button className="btn btn-primary" onClick={onAddJob}>+ Post Job</button>
      </div>

      <div style={{ display: 'flex', gap: '.5rem', marginBottom: '1.5rem' }}>
        {['jobs', 'applications'].map(s => (
          <button
            key={s}
            className={`btn ${activeSection === s ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveSection(s)}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
            {s === 'applications' && applications.length > 0 &&
              <span style={{ marginLeft: '.4rem', background: 'rgba(255,255,255,.3)', borderRadius: '999px', padding: '0 .45rem', fontSize: '.75rem' }}>
                {applications.length}
              </span>
            }
          </button>
        ))}
      </div>

      {activeSection === 'jobs' && (
        <JobList jobs={jobs} onApply={onApply} onDelete={onDelete} />
      )}

      {activeSection === 'applications' && (
        <div className="applications-section">
          {loadingApps ? (
            <div className="loading"><div className="loading-spinner" /><p>Loading applications…</p></div>
          ) : appsError ? (
            <div className="error-box">{appsError}</div>
          ) : applications.length === 0 ? (
            <div className="empty-state"><h3>No applications yet</h3><p>They will appear here once candidates apply.</p></div>
          ) : (
            <table className="app-table">
              <thead>
                <tr>
                  <th>Applicant</th>
                  <th>Email</th>
                  <th>Job ID</th>
                  <th>Date</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {applications.map(app => (
                  <tr key={app.id}>
                    <td><strong>{app.applicant_name}</strong></td>
                    <td>{app.applicant_email}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: '.78rem', color: '#64748b' }}>{app.job_id.slice(0, 12)}…</td>
                    <td style={{ color: '#64748b', fontSize: '.8rem' }}>{new Date(app.created_at).toLocaleDateString()}</td>
                    <td>
                      <select
                        className="select-status"
                        value={app.status}
                        onChange={e => handleStatusChange(app.id, e.target.value)}
                        style={{ borderColor: statusColor(app.status), color: statusColor(app.status) }}
                      >
                        {['pending', 'reviewed', 'accepted', 'rejected'].map(s => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
