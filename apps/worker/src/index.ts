// B1 stub. Real BullMQ workers, Stagehand factory, and per-platform agents
// land in B3 / C1+. For now we just announce ourselves and stay alive so the
// container has a long-running PID 1 that can receive SIGTERM cleanly.

console.log('worker starting');

const heartbeat = setInterval(() => {
  /* keep the event loop alive */
}, 1 << 30);

const shutdown = (signal: string) => {
  console.log(`worker received ${signal}, exiting`);
  clearInterval(heartbeat);
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
