/** Base class for every error this plugin raises deliberately. */
export class CowayError extends Error {}

/** Credentials rejected by Coway's identity server. */
export class CowayAuthError extends CowayError {}

/**
 * Coway forces a password change every 60 days. The IoCare app can defer this,
 * but a headless login cannot, so surface it as an actionable error.
 */
export class PasswordExpiredError extends CowayError {}

/**
 * Coway blocks an account after repeated failed logins, typically for 24 hours.
 * Retrying makes this worse, so callers must back off rather than loop.
 */
export class RateLimitedError extends CowayError {}

/** Coway's servers are in a maintenance window. */
export class ServerMaintenanceError extends CowayError {}
