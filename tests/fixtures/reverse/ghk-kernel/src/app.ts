import express from 'express';

// ghk:implements Order
export function createApp(commands: any) {
  const app = express();
  app.get('/health', (_req, res) => { res.json({ status: 'ok' }); });
  const routes: [string, string][] = [['/api/v1/order', 'Order']];
  for (const [route, aggregateType] of routes) app.post(`${route}/:id/:command`, async (req, res) => {
    res.status(202).json(await commands.handle({ aggregateType, aggregateId: req.params.id, command: req.params.command }));
  });
  return app;
}
