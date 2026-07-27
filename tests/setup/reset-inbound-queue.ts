import { afterEach } from "vitest";
import { resetInboundSessionQueueForTest } from "../../src/gateway/inbound-session-queue";

// The inbound session-queue holds module-level state (the per-conversation
// promise-chain map). Reset it after every test so a handler that hangs or
// leaves a queue busy in one test cannot leak into the next.
afterEach(() => {
  resetInboundSessionQueueForTest();
});
