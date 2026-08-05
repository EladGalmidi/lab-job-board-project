import JobCard from './JobCard.jsx';

export default function JobList({ jobs, onApply, onDelete }) {
  if (jobs.length === 0) {
    return (
      <div className="empty-state">
        <h3>No jobs found</h3>
        <p>Check back later or add one via the Admin panel.</p>
      </div>
    );
  }

  return (
    <div className="job-grid">
      {jobs.map((job) => (
        <JobCard
          key={job.id}
          job={job}
          onApply={onApply}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}
