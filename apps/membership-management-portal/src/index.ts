import { Hono } from "hono";

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.get("/boilerplate", (c) => {
  return c.text("Boilerplate!");
});

export default app;
