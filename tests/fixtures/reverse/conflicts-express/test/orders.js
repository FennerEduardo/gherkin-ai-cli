// Tests written for an older version of the API.
import request from 'supertest';
import { app } from '../src/server.js';

describe('orders', () => {
  it('places an order', async () => {
    await request(app).post('/orders').send({}).expect(200);
  });

  it('ships an order and announces it', async () => {
    const res = await request(app).get('/orders/1');
    expect(res.status).toBe(200);
    expect(published).toContain('order.shipped');
  });

  it('lists the history of an order', async () => {
    await request(app).get('/orders/1/history').expect(200);
  });
});
