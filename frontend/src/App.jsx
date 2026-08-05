import { useState, useEffect } from 'react';
import JobList      from './components/JobList.jsx';
import ApplyModal   from './components/ApplyModal.jsx';
import AddJobModal  from './components/AddJobModal.jsx';
import AdminPanel   from './components/AdminPanel.jsx';
import { jobsApi }  from './api/index.js';

export default function App() {
  const [jobs, setJobs]             = useState([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [selectedJob, setSelectedJob] = useState(null);
  const [showAddJob, setShowAddJob]   = useState(false);
  const [activeTab, setActiveTab]     = useState('jobs');

  useEffect(() => { fetchJobs(); }, []);

  const fetchJobs = async () => {
    setLoading(true);
    setError('');
    try {
      setJobs(await jobsApi.getAll());
    } catch {
      setError('Could not reach the jobs service. Make sure all containers are running.');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteJob = async (id) => {
    if (!window.confirm('Delete this job listing?')) return;
    try {
      await jobsApi.remove(id);
      setJobs(prev => prev.filter(j => j.id !== id));
    } catch {
      alert('Failed to delete job.');
    }
  };

  const handleAddJob = (newJob) => {
    setJobs(prev => [newJob, ...prev]);
    setShowAddJob(false);
  };

  return (
    <div className="app">
      <header className="header">
        <div className="header-brand">
          <h1>💼 JobBoard</h1>
          <p>DevSecOps Lab — Containerised Microservices</p>
        </div>
        <nav className="nav">
          <button className={`nav-btn ${activeTab === 'jobs'  ? 'active' : ''}`} onClick={() => setActiveTab('jobs')}>
            Browse Jobs
          </button>
          <button className={`nav-btn ${activeTab === 'admin' ? 'active' : ''}`} onClick={() => setActiveTab('admin')}>
            Admin
          </button>
        </nav>
      </header>

      <main className="main">
        {activeTab === 'jobs' && (
          <>
            <div className="section-header">
              <h2>{loading ? 'Loading…' : `${jobs.length} Open Position${jobs.length !== 1 ? 's' : ''}`}</h2>
              <button className="btn btn-secondary" onClick={fetchJobs}>↺ Refresh</button>
            </div>
            {loading ? (
              <div className="loading">
                <div className="loading-spinner" />
                <p>Fetching jobs from the API…</p>
              </div>
            ) : error ? (
              <div className="error-box">{error}</div>
            ) : (
              <JobList jobs={jobs} onApply={setSelectedJob} onDelete={null} />
            )}
          </>
        )}

        {activeTab === 'admin' && (
          <AdminPanel
            jobs={jobs}
            onApply={setSelectedJob}
            onDelete={handleDeleteJob}
            onAddJob={() => setShowAddJob(true)}
          />
        )}
      </main>

      {selectedJob && (
        <ApplyModal job={selectedJob} onClose={() => setSelectedJob(null)} />
      )}
      {showAddJob && (
        <AddJobModal onClose={() => setShowAddJob(false)} onAdd={handleAddJob} />
      )}
    </div>
  );
}
