// Heartbeat unit tests. These verify the module's exports and types.
// Integration tests with ValKey run via docker-compose.test.yml.
import { createHeartbeat, stopHeartbeat } from "./heartbeat";

describe("heartbeat", () => {
  it("exports createHeartbeat function", () => {
    expect(typeof createHeartbeat).toBe("function");
  });

  it("exports stopHeartbeat function", () => {
    expect(typeof stopHeartbeat).toBe("function");
  });
});
