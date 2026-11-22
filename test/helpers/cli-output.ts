import { vi } from "vitest";

export function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  return {
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
    restore() {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}
