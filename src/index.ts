import { app, runScheduled, type Bindings } from './app';

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env));
  },
};
