import express from 'express';
import enrichRouter        from './routes/enrich';
import retrieveRouter      from './routes/retrieve';
import { tenantsRouter }   from './routes/tenants';
import { usersRouter }     from './routes/users';
import { demoRouter }      from './routes/demo';
import { adminRouter }     from './routes/admin';
import { apiKeyAuth, adminAuth } from './middleware/auth';

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', project: 'lexos', version: '0.1.0' });
});

// SDK hot path — API key required in production (resolves tenant from the key)
app.use('/enrich',    apiKeyAuth, enrichRouter);
app.use('/retrieve',  apiKeyAuth, retrieveRouter);

// Tenant config + user personalisation
app.use('/tenants', tenantsRouter);
app.use('/users',   usersRouter);

// Demo (side-by-side comparison + corpus browser)
app.use('/demo', demoRouter);

// Admin dashboard (WiseOrder) — tenant/menu/key management. Admin-key protected.
app.use('/admin', adminAuth, adminRouter);

export default app;
