export default function JobCard({ job, onApply, onDelete }) {
  const fmt = (d) =>
    new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="job-card">
      <div className="job-card-top">
        <div>
          <div className="job-company">{job.company}</div>
          <div className="job-title">{job.title}</div>
        </div>
        {job.salary_range && (
          <span className="salary-badge">{job.salary_range}</span>
        )}
      </div>

      <div className="job-meta">
        <span className="job-meta-item">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
          </svg>
          {job.location}
        </span>
        <span className="job-meta-item">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
          {fmt(job.created_at)}
        </span>
      </div>

      <p className="job-description">{job.description}</p>

      <div className="job-card-actions">
        {onDelete && (
          <button className="btn btn-danger btn-sm" onClick={() => onDelete(job.id)}>
            Delete
          </button>
        )}
        <button className="btn btn-primary btn-sm" onClick={() => onApply(job)}>
          Apply Now
        </button>
      </div>
    </div>
  );
}
