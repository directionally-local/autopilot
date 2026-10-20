/**
 * The name Autopilot reports itself under to observability tools: the OTel
 * `service.name`, instrumentation scope and `beacon.harness.name`, and the
 * `client` / `beacon.harness.name` fields on hook payloads. One constant so a
 * session never shows up under two names.
 */
export const HARNESS_NAME = "autopilot";

/** Attribute key Agent Beacon reads first when naming the harness. */
export const BEACON_HARNESS_ATTR = "beacon.harness.name";
