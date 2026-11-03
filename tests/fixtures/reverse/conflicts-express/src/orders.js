// An orders API whose tests drifted from the code (PLAN-3.3.0-reverse-plus RV-09).
import express from 'express';
import { EventEmitter } from 'node:events';

export const orders = express.Router();
const eventBus = new EventEmitter();
const store = new Map();

orders.post('/orders', (req, res) => {
  const order = { id: String(store.size + 1), status: 'PENDING' };
  store.set(order.id, order);
  eventBus.emit('order.placed', order);
  res.status(201).json(order);
});

orders.get('/orders/:id', (req, res) => {
  const order = store.get(req.params.id);
  if (!order) return res.status(404).json({ detail: 'order not found' });
  res.status(200).json(order);
});
