/**
 * `autopilot acp`: serve ACP over stdio (agent.ts). stdout carries only
 * JSON-RPC, so everything that would print goes to stderr, which editors
 * keep as the agent's log.
 */

import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { createAcpAgent } from "./agent.js";

/** Route console output to stderr: one stray line on stdout breaks the protocol. */
export function keepStdoutForProtocol(): void {
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;
  console.debug = console.error;
}

export async function runAcpServer(): Promise<void> {
  keepStdoutForProtocol();
  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  );
  const connection = createAcpAgent().connect(stream);
  const stop = () => connection.close();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await connection.closed;
}

/**
 * `autopilot acp --login`: the terminal sign-in an ACP client opens (the
 * "terminal" auth method): the free tier's GitHub device sign-in, as
 * `autopilot auth directionally-local`. Exit 0 once signed in.
 */
export async function runAcpLogin(): Promise<number> {
  const { runDlSignIn } = await import("../providers/dl-signin-cli.js");
  return runDlSignIn({});
}
