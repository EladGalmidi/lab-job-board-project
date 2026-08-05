--
-- PostgreSQL database dump
--

\restrict 5zT0qnZsfheqAoZrAlCgsNPr7xKVHya8KdHUaIUOsrBGv34Q6UtOzOWq2bANTFY

-- Dumped from database version 16.14
-- Dumped by pg_dump version 16.14

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: applications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.applications (
    id uuid NOT NULL,
    job_id character varying(255) NOT NULL,
    applicant_name character varying(200) NOT NULL,
    applicant_email character varying(200) NOT NULL,
    cover_letter text,
    status character varying(50) DEFAULT 'pending'::character varying,
    created_at timestamp without time zone DEFAULT now(),
    CONSTRAINT applications_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'reviewed'::character varying, 'accepted'::character varying, 'rejected'::character varying])::text[])))
);


--
-- Name: jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jobs (
    id character varying(255) NOT NULL,
    title character varying(200) NOT NULL,
    description text NOT NULL,
    company character varying(200) NOT NULL,
    location character varying(200) NOT NULL,
    salary_range character varying(100),
    created_at timestamp with time zone DEFAULT now()
);


--
-- Data for Name: applications; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.applications (id, job_id, applicant_name, applicant_email, cover_letter, status, created_at) FROM stdin;
\.


--
-- Data for Name: jobs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.jobs (id, title, description, company, location, salary_range, created_at) FROM stdin;
job-001	Senior DevOps Engineer	We are looking for an experienced DevOps engineer to design, implement and maintain our cloud infrastructure. You will work with Kubernetes, Terraform, and CI/CD pipelines to ensure high availability and scalability of our platform.	TechCorp Ltd.	Remote	$120,000 – $160,000	2026-08-05 05:13:58.69438+00
job-002	Backend Developer (Python)	Join our growing team as a backend developer. You will build and maintain RESTful APIs using Python and FastAPI, design PostgreSQL schemas, and collaborate with frontend engineers to deliver new product features.	StartupXYZ	Tel Aviv, Israel	$90,000 – $120,000	2026-08-05 05:13:58.69438+00
job-003	Cloud Architect	Design and implement cloud-native solutions across AWS and GCP. Lead architecture reviews, mentor junior engineers, and drive the adoption of Infrastructure as Code using Terraform and Pulumi.	CloudSystems Inc.	Hybrid – Berlin, Germany	$140,000 – $180,000	2026-08-05 05:13:58.69438+00
job-004	Frontend Engineer (React)	Build beautiful, performant web applications using React, TypeScript and modern tooling. You will work closely with our UX team to translate designs into pixel-perfect, accessible components.	ProductLab	Remote	$80,000 – $110,000	2026-08-05 05:13:58.69438+00
job-005	Security Engineer (DevSecOps)	Own the security posture of our engineering organisation. Integrate SAST/DAST tools into CI/CD, run threat-modelling sessions, and respond to security incidents. Experience with OWASP Top 10 is required.	SecureOps	London, UK	$130,000 – $165,000	2026-08-05 05:13:58.69438+00
de1138c5-58bd-4eba-856e-470f8b2a9bc7	Persistence Test Job	Testing Docker volumes	Lab Inc	Docker	\N	2026-08-05 05:18:11.647692+00
\.


--
-- Name: applications applications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_pkey PRIMARY KEY (id);


--
-- Name: jobs jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);


--
-- Name: idx_applications_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_applications_job_id ON public.applications USING btree (job_id);


--
-- Name: idx_applications_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_applications_status ON public.applications USING btree (status);


--
-- Name: applications applications_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict 5zT0qnZsfheqAoZrAlCgsNPr7xKVHya8KdHUaIUOsrBGv34Q6UtOzOWq2bANTFY

