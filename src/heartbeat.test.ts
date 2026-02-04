// Heartbeat unit tests. These verify the module's exports and types.
// Integration tests with Redis run via docker-compose.test.yml.

describe("heartbeat", () => {
  it("exports createHeartbeat function", () => {
    const { createHeartbeat } = require("./heartbeat");
    expect(typeof createHeartbeat).toBe("function");
  });

  it("exports stopHeartbeat function", () => {
    const { stopHeartbeat } = require("./heartbeat");
    expect(typeof stopHeartbeat).toBe("function");
  });
});
