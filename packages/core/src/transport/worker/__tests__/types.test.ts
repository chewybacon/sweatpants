import { describe, it, expect } from "@effectionx/vitest";
import {
  isWorkerProgressMessage,
  isWorkerLogMessage,
  isWorkerOutOfBandMessage,
  type WorkerSampleRequest,
  type WorkerSampleResponse,
  type WorkerProgressMessage,
  type WorkerLogMessage,
} from "../types.ts";

describe("Worker Transport Type Guards", () => {
  describe("isWorkerProgressMessage", () => {
    it("should return true for progress messages", function* () {
      const msg: WorkerProgressMessage = {
        type: "progress",
        message: "Loading...",
        progress: 0.5,
      };
      expect(isWorkerProgressMessage(msg)).toBe(true);
    });

    it("should return true for progress message without progress value", function* () {
      const msg: WorkerProgressMessage = {
        type: "progress",
        message: "Processing",
      };
      expect(isWorkerProgressMessage(msg)).toBe(true);
    });

    it("should return false for log messages", function* () {
      const msg: WorkerLogMessage = {
        type: "log",
        level: "info",
        message: "Hello",
      };
      expect(isWorkerProgressMessage(msg)).toBe(false);
    });

    it("should return false for null/undefined", function* () {
      expect(isWorkerProgressMessage(null)).toBe(false);
      expect(isWorkerProgressMessage(undefined)).toBe(false);
    });

    it("should return false for non-objects", function* () {
      expect(isWorkerProgressMessage("progress")).toBe(false);
      expect(isWorkerProgressMessage(123)).toBe(false);
    });

    it("should return false for objects without type field", function* () {
      expect(isWorkerProgressMessage({ message: "test" })).toBe(false);
    });
  });

  describe("isWorkerLogMessage", () => {
    it("should return true for log messages", function* () {
      const msg: WorkerLogMessage = {
        type: "log",
        level: "info",
        message: "Test log",
      };
      expect(isWorkerLogMessage(msg)).toBe(true);
    });

    it("should return true for all log levels", function* () {
      const levels: WorkerLogMessage["level"][] = ["debug", "info", "warning", "error"];
      for (const level of levels) {
        const msg: WorkerLogMessage = {
          type: "log",
          level,
          message: `${level} message`,
        };
        expect(isWorkerLogMessage(msg)).toBe(true);
      }
    });

    it("should return false for progress messages", function* () {
      const msg: WorkerProgressMessage = {
        type: "progress",
        message: "Loading...",
      };
      expect(isWorkerLogMessage(msg)).toBe(false);
    });

    it("should return false for null/undefined", function* () {
      expect(isWorkerLogMessage(null)).toBe(false);
      expect(isWorkerLogMessage(undefined)).toBe(false);
    });
  });

  describe("isWorkerOutOfBandMessage", () => {
    it("should return true for progress messages", function* () {
      const msg: WorkerProgressMessage = {
        type: "progress",
        message: "Loading...",
      };
      expect(isWorkerOutOfBandMessage(msg)).toBe(true);
    });

    it("should return true for log messages", function* () {
      const msg: WorkerLogMessage = {
        type: "log",
        level: "info",
        message: "Test",
      };
      expect(isWorkerOutOfBandMessage(msg)).toBe(true);
    });

    it("should return false for request messages", function* () {
      const request: WorkerSampleRequest = {
        id: "req-1",
        type: "sample",
        messages: [{ role: "user", content: "Hello" }],
      };
      expect(isWorkerOutOfBandMessage(request)).toBe(false);
    });

    it("should return false for response messages", function* () {
      const response: WorkerSampleResponse = {
        id: "req-1",
        type: "sample",
        status: "accepted",
        text: "Hello back!",
      };
      expect(isWorkerOutOfBandMessage(response)).toBe(false);
    });
  });
});
