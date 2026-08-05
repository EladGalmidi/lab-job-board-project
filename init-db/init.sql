-- ============================================================
-- Job Board Database Initialization Script
-- This runs automatically when the PostgreSQL container starts
-- ============================================================

-- Jobs Table (also created by SQLAlchemy on service startup)
CREATE TABLE IF NOT EXISTS jobs (
    id          VARCHAR(255) PRIMARY KEY,
    title       VARCHAR(200) NOT NULL,
    description TEXT         NOT NULL,
    company     VARCHAR(200) NOT NULL,
    location    VARCHAR(200) NOT NULL,
    salary_range VARCHAR(100),
    created_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- Applications Table (also created by Node.js service on startup)
CREATE TABLE IF NOT EXISTS applications (
    id              UUID         PRIMARY KEY,
    job_id          VARCHAR(255) NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    applicant_name  VARCHAR(200) NOT NULL,
    applicant_email VARCHAR(200) NOT NULL,
    cover_letter    TEXT,
    status          VARCHAR(50)  DEFAULT 'pending' CHECK (status IN ('pending','reviewed','accepted','rejected')),
    created_at      TIMESTAMP    DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_applications_job_id ON applications(job_id);
CREATE INDEX IF NOT EXISTS idx_applications_status  ON applications(status);

-- ============================================================
-- Seed Data
-- ============================================================
INSERT INTO jobs (id, title, description, company, location, salary_range) VALUES
  ('job-001',
   'Senior DevOps Engineer',
   'We are looking for an experienced DevOps engineer to design, implement and maintain our cloud infrastructure. You will work with Kubernetes, Terraform, and CI/CD pipelines to ensure high availability and scalability of our platform.',
   'TechCorp Ltd.',
   'Remote',
   '$120,000 – $160,000'),

  ('job-002',
   'Backend Developer (Python)',
   'Join our growing team as a backend developer. You will build and maintain RESTful APIs using Python and FastAPI, design PostgreSQL schemas, and collaborate with frontend engineers to deliver new product features.',
   'StartupXYZ',
   'Tel Aviv, Israel',
   '$90,000 – $120,000'),

  ('job-003',
   'Cloud Architect',
   'Design and implement cloud-native solutions across AWS and GCP. Lead architecture reviews, mentor junior engineers, and drive the adoption of Infrastructure as Code using Terraform and Pulumi.',
   'CloudSystems Inc.',
   'Hybrid – Berlin, Germany',
   '$140,000 – $180,000'),

  ('job-004',
   'Frontend Engineer (React)',
   'Build beautiful, performant web applications using React, TypeScript and modern tooling. You will work closely with our UX team to translate designs into pixel-perfect, accessible components.',
   'ProductLab',
   'Remote',
   '$80,000 – $110,000'),

  ('job-005',
   'Security Engineer (DevSecOps)',
   'Own the security posture of our engineering organisation. Integrate SAST/DAST tools into CI/CD, run threat-modelling sessions, and respond to security incidents. Experience with OWASP Top 10 is required.',
   'SecureOps',
   'London, UK',
   '$130,000 – $165,000')
ON CONFLICT (id) DO NOTHING;
