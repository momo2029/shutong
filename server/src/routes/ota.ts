import { Hono } from 'hono';

const app = new Hono();

app.get('/', (c) => c.json({ firmware: [] }));

export default app;
