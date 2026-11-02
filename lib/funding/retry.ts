/**
 * Quorum Funding Retry & Deterministic Key Utilities
 * 
 * Invariants:
 * - Deterministic idempotency keys compliant with SPEC.md §8.2
 * - Honor window is 3 calendar days (72 hours) from authorization
 * - Authorization expires after 29 calendar days
 */

import { Contribution } from './types';

export const HONOR_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;      // 3 days
export const AUTH_EXPIRATION_MS = 29 * 24 * 60 * 60 * 1000;  // 29 days

/**
 * Generates deterministic PayPal-Request-Id for captures: `cap_<contribution_id>_<attempt>`
 */
export function getCaptureRequestId(contributionId: string, attempt: number): string {
  return `cap_${contributionId}_${attempt}`;
}

/**
 * Generates deterministic PayPal-Request-Id for reauthorizations: `reauth_<contribution_id>_<attempt>`
 */
export function getReauthRequestId(contributionId: string, attempt: number): string {
  return `reauth_${contributionId}_${attempt}`;
}

/**
 * Generates deterministic PayPal-Request-Id for voids: `void_<contribution_id>`
 */
export function getVoidRequestId(contributionId: string): string {
  return `void_${contributionId}`;
}

/**
 * Generates deterministic PayPal-Request-Id for refunds: `ref_<contribution_id>`
 */
export function getRefundRequestId(contributionId: string): string {
  return `ref_${contributionId}`;
}

/**
 * Calculates honor window expiration timestamp (authorized_at + 3 days)
 */
export function calculateHonorWindow(authorizedAt: string): string {
  const timeMs = new Date(authorizedAt).getTime();
  return new Date(timeMs + HONOR_WINDOW_MS).toISOString();
}

/**
 * Calculates authorization expiration timestamp (authorized_at + 29 days)
 */
export function calculateAuthExpiration(authorizedAt: string): string {
  const timeMs = new Date(authorizedAt).getTime();
  return new Date(timeMs + AUTH_EXPIRATION_MS).toISOString();
}

/**
 * Calculates next retry timestamp based on current time and interval
 */
export function calculateNextRetry(now: string, intervalMinutes: number): string {
  const nowMs = new Date(now).getTime();
  return new Date(nowMs + intervalMinutes * 60 * 1000).toISOString();
}

/**
 * Returns true if an authorized contribution has exceeded its 3-day honor window
 * and requires reauthorization before capture.
 */
export function needsReauthorization(contribution: Contribution, now: string): boolean {
  if (contribution.status !== 'AUTHORIZED' && contribution.status !== 'CAPTURE_FAILED') {
    return false;
  }
  if (!contribution.honor_expires_at) {
    return false;
  }
  const nowMs = new Date(now).getTime();
  const honorMs = new Date(contribution.honor_expires_at).getTime();
  return nowMs > honorMs;
}

/**
 * Returns true if authorization has completely expired (past 29 days).
 * Once fully expired, funds cannot be reauthorized or captured.
 */
export function isAuthorizationExpired(contribution: Contribution, now: string): boolean {
  if (!contribution.authorization_expires_at) {
    return false;
  }
  const nowMs = new Date(now).getTime();
  const authExpMs = new Date(contribution.authorization_expires_at).getTime();
  return nowMs > authExpMs;
}

/**
 * Determines whether a failed capture can be retried.
 */
export function shouldRetryCapture(
  contribution: Contribution,
  maxAttempts: number,
  now: string
): boolean {
  if (contribution.status !== 'CAPTURE_FAILED') {
    return false;
  }
  if (contribution.capture_attempts >= maxAttempts) {
    return false;
  }
  if (!contribution.next_retry_at) {
    return true;
  }
  const nowMs = new Date(now).getTime();
  const retryMs = new Date(contribution.next_retry_at).getTime();
  return nowMs >= retryMs;
}
