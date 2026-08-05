import axios from 'axios';

const jobsClient = axios.create({ baseURL: '/api/jobs' });
const appsClient = axios.create({ baseURL: '/api/applications' });

export const jobsApi = {
  getAll:  ()           => jobsClient.get('/').then(r => r.data),
  getOne:  (id)         => jobsClient.get(`/${id}`).then(r => r.data),
  create:  (data)       => jobsClient.post('/', data).then(r => r.data),
  update:  (id, data)   => jobsClient.put(`/${id}`, data).then(r => r.data),
  remove:  (id)         => jobsClient.delete(`/${id}`),
};

export const applicationsApi = {
  getAll:       ()           => appsClient.get('/').then(r => r.data),
  getForJob:    (jobId)      => appsClient.get(`/job/${jobId}`).then(r => r.data),
  submit:       (data)       => appsClient.post('/', data).then(r => r.data),
  updateStatus: (id, status) => appsClient.patch(`/${id}/status`, { status }).then(r => r.data),
};
