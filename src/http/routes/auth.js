import { Router } from 'express';
import { z } from 'zod';
import { parseOrThrow } from '../../lib/validate.js';
import { login, register } from '../../services/authService.js';
import { authenticate } from '../middleware/authenticate.js';

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
  tenant_name: z.string().trim().min(1).max(120).optional(),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200),
});

authRouter.post('/api/auth/register', async (req, res) => {
  const body = parseOrThrow(registerSchema, req.body);
  const result = await register({
    email: body.email,
    password: body.password,
    tenantName: body.tenant_name,
  });
  res.status(201).json(result);
});

authRouter.post('/api/auth/login', async (req, res) => {
  const body = parseOrThrow(loginSchema, req.body);
  res.status(200).json(await login(body));
});

authRouter.get('/api/auth/me', authenticate, (req, res) => {
  res.json({ user_id: req.auth.userId, tenant_id: req.auth.tenantId, email: req.auth.email });
});
