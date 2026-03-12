import { gracefulShutdown } from "../shutdown";

describe("gracefulShutdown", () => {
  it("closes all workers", async () => {
    const mockWorker = { close: jest.fn().mockResolvedValue(undefined) };
    await gracefulShutdown([mockWorker ]);
    expect(mockWorker.close).toHaveBeenCalledTimes(1);
  });

  it("closes multiple workers concurrently", async () => {
    const w1 = { close: jest.fn().mockResolvedValue(undefined) };
    const w2 = { close: jest.fn().mockResolvedValue(undefined) };
    await gracefulShutdown([w1 , w2 ]);
    expect(w1.close).toHaveBeenCalled();
    expect(w2.close).toHaveBeenCalled();
  });
});
