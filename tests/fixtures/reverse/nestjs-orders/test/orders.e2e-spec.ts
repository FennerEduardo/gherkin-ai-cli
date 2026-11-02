import request from 'supertest';

describe('Orders (e2e)', () => {
  it('places an order', async () => {
    await request(app.getHttpServer()).post('/api/v1/orders').send({ customerEmail: 'a@b.co', items: ['x'], quantity: 1 }).expect(201);
  });
});
declare const app: any;
