--
-- PostgreSQL database dump
--

\restrict JicvPrPKek5A6oEJuLqCB6ZXl1SoSWgParrZk7oGb4X6qM0w9WJZ2n3IYxMxFOh

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
3890608d-c648-47be-a08a-43cf9a2e3065	6667d5e1-9f55-4e92-9dc8-663c2b2ce074	K8s Trace	k8s@lab.com	\N	pending	2026-08-05 06:02:55.012372
\.


--
-- Data for Name: jobs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.jobs (id, title, description, company, location, salary_range, created_at) FROM stdin;
6667d5e1-9f55-4e92-9dc8-663c2b2ce074	Senior DevOps Engineer	Design and maintain cloud infrastructure using Kubernetes, Terraform, and CI/CD pipelines to ensure high availability.	TechCorp Ltd.	Remote	$120,000 - $160,000	2026-08-05 05:56:32.684569+00
42550fd9-423d-4bf3-bfe6-9d5f2b8e7eeb	Backend Developer (Python)	Build and maintain RESTful APIs using Python and FastAPI. Design PostgreSQL schemas and collaborate with frontend engineers.	StartupXYZ	Tel Aviv, Israel	$90,000 - $120,000	2026-08-05 05:56:32.78336+00
00602a0e-3f81-4dfc-8ac5-cb5399997086	Cloud Architect	Design cloud-native solutions on AWS and GCP. Lead architecture reviews and drive Infrastructure as Code adoption with Terraform.	CloudSystems Inc.	Hybrid – Berlin, Germany	$140,000 - $180,000	2026-08-05 05:56:32.877884+00
7cb63941-92d3-4742-917b-558fc57f105b	Frontend Engineer (React)	Build performant web applications using React and TypeScript. Translate UX designs into accessible components.	ProductLab	Remote	$80,000 - $110,000	2026-08-05 05:56:33.07696+00
0f667b99-dfec-4e28-b621-1884dacb4a16	Security Engineer (DevSecOps)	Own security posture of the engineering organisation. Integrate SAST/DAST tools into CI/CD and run threat-modelling sessions.	SecureOps	London, UK	$130,000 - $165,000	2026-08-05 05:56:33.177885+00
7e3d3efc-773f-4d2e-8c20-520a13a66cd4	K8s Persistence Test	This job must survive a pod restart	Lab Inc	Kubernetes	\N	2026-08-05 06:04:08.937859+00
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
-- Name: ix_jobs_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_jobs_id ON public.jobs USING btree (id);


--
-- PostgreSQL database dump complete
--

\unrestrict JicvPrPKek5A6oEJuLqCB6ZXl1SoSWgParrZk7oGb4X6qM0w9WJZ2n3IYxMxFOh

