// Billing written in the route handlers: no services, no repositories, SQL inline (golden G-R2).
import express from 'express';
import { EventEmitter } from 'node:events';
import { pool } from './db.js';

export const invoices = express.Router();
const eventBus = new EventEmitter();

invoices.post('/invoices', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'sign in first' });
  if (!req.body?.customerId) return res.status(422).json({ error: 'customer is required' });
  if (!(req.body.amount > 0)) return res.status(422).json({ error: 'amount must be positive' });
  const { rows } = await pool.query('insert into invoices (customer_id, amount, status) values ($1, $2, $3) returning *', [req.body.customerId, req.body.amount, 'ISSUED']);
  const invoice = { ...rows[0], status: 'ISSUED' };
  eventBus.emit('invoice.issued', invoice);
  res.status(201).json(invoice);
});

invoices.post('/invoices/:id/pay', async (req, res) => {
  const { rows } = await pool.query('select * from invoices where id = $1', [req.params.id]);
  const invoice = rows[0];
  if (!invoice) return res.status(404).json({ error: 'invoice not found' });
  if (invoice.status !== 'ISSUED') return res.status(409).json({ error: 'only issued invoices can be paid' });
  invoice.status = 'PAID';
  await pool.query('update invoices set status = $1 where id = $2', [invoice.status, invoice.id]);
  eventBus.emit('invoice.paid', invoice);
  res.json(invoice);
});

invoices.post('/invoices/:id/void', async (req, res) => {
  if (!req.user?.roles?.includes('accountant')) return res.status(403).json({ error: 'accountants only' });
  const { rows } = await pool.query('select * from invoices where id = $1', [req.params.id]);
  const invoice = rows[0];
  if (!invoice) return res.status(404).json({ error: 'invoice not found' });
  if (invoice.status === 'PAID') return res.status(409).json({ error: 'paid invoices cannot be voided' });
  invoice.status = 'VOIDED';
  await pool.query('update invoices set status = $1 where id = $2', [invoice.status, invoice.id]);
  eventBus.emit('invoice.voided', invoice);
  res.json(invoice);
});
