import { describe, it, expect } from "@effectionx/vitest";
import {
  isProgressMessage,
  isLogMessage,
  isOutOfBandMessage,
  type WorkerSampleRequest,
  type WorkerSampleResponse,
  type WorkerProgressMessage,
  type WorkerLogMessage,
} from "../types.ts";

describe("Worker Transport Type Guards", () => {
  describe("isProgressMessage", () => {
    it("should return true for progress messages", function* () {
      const msg: WorkerProgressMessage = {
        type: "progress",
        message: "Loading...",
        progress: 0.5,
      };
      expect(isProgressMessage(msg)).toBe(true);
    });

    it("should return true for progress message without progress value", function* () {
      const msg: WorkerProgressMessage = {
        type: "progress",
        message: "Processing",
      };
      expect(isProgressMessage(msg)).toBe(true);
    });

    it("should return false for log messages", function* () {
      const msg: WorkerLogMessage = {
        type: "log",
        level: "info",
        message: "Hello",
      };
      expect(isProgressMessage(msg)).toBe(false);
    });

    it("should return false for null/undefined", function* () {
      expect(isProgressMessage(null)).toBe(false);
      expect(isProgressMessage(undefined)).toBe(false);
    });

    it("should return false for non-objects", function* () {
      expect(isProgressMessage("progress")).toBe(false);
      expect(isProgressMessage(123)).toBe(false);
    });

    it("should return false for objects without type field", function* () {
      expect(isProgressMessage({ message: "test" })).toBe(false);
    });
  });

  describe("isLogMessage", () => {
    it("should return true for log messages", function* () {
      const msg: WorkerLogMessage = {
        type: "log",
        level: "info",
        message: "Test log",
      };
      expect(isLogMessage(msg)).toBe(true);
    });

    it("should return true for all log levels", function* () {
      const levels: WorkerLogMessage["level"][] = ["debug", "info", "warning", "error"];
      for (const level of levels) {
        const msg: WorkerLogMessage = {
          type: "log",
          level,
          message: `${level} message`,
        };
        expect(isLogMessage(msg)).toBe(true);
      }
    });

    it("should return false for progress messages", function* () {
      const msg: WorkerProgressMessage = {
        type: "progress",
        message: "Loading...",
      };
      expect(isLogMessage(msg)).toBe(false);
    });

    it("should return false for null/undefined", function* () {
      expect(isLogMessage(null)).toBe(false);
      expect(isLogMessage(undefined)).toBe(false);
    });
  });

  describe("isOutOfBandMessage", () => {
    it("should return true for progress messages", function* () {
      const msg: WorkerProgressMessage = {
        type: "progress",
        message: "Loading...",
      };
      expect(isOutOfBandMessage(msg)).toBe(true);
    });

    it("should return true for log messages", function* () {
      const msg: WorkerLogMessage = {
        type: "log",
        level: "info",
        message: "Test",
      };
      expect(isOutOfBandMessage(msg)).toBe(true);
    });

    it("should return false for request messages", function* () {
      const request: WorkerSampleRequest = {
        id: "req-1",
        type: "sample",
        messages: [{ role: "user", content: "Hello" }],
      };
      expect(isOutOfBandMessage(request)).toBe(false);
    });

    it("should return false for response messages", function* () {
      const response: WorkerSampleResponse = {
        id: "req-1",
        type: "sample",
        status: "accepted",
        text: "Hello back!",
      };
      expect(isOutOfBandMessage(response)).toBe(false);
    });
  });
});
