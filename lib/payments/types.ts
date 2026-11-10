/**
 * Quorum Payment Types & Adapter Interfaces
 * 
 * Invariants:
 * - Money strictly in integer cents (USD)
 * - Deterministic idempotency keys (q_<proposal_id>_<attempt>)
 * - Single source of truth for vendor payouts
 */

import { GuardResult } from '../guard/types';

export type PaymentStatus =
  | 'CREATED'
  | 'PENDING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'RETURNED'
  | 'UNCLAIMED';

export type PaymentKind = 'PAYOUT' | 'CHECKOUT' | 'REFUND';

export class DefinitePaymentFailure extends Error {
  public readonly code: string;
  public readonly rawResponse?: any;

  constructor(message: string, code: string = 'DEFINITE_PAYMENT_FAILURE', rawResponse?: any) {
    super(message);
    this.name = 'DefinitePaymentFailure';
    this.code = code;
    this.rawResponse = rawResponse;
    Object.setPrototypeOf(this, DefinitePaymentFailure.prototype);
  }
}

export class AmbiguousPaymentFailure extends Error {
  public readonly code: string;
  public readonly rawResponse?: any;

  constructor(message: string, code: string = 'AMBIGUOUS_PAYMENT_FAILURE', rawResponse?: any) {
    super(message);
    this.name = 'AmbiguousPaymentFailure';
    this.code = code;
    this.rawResponse = rawResponse;
    Object.setPrototypeOf(this, AmbiguousPaymentFailure.prototype);
  }
}

export interface PaymentRecord {
  id: string;
  group_id: string;
  proposal_id: string;
  kind: PaymentKind;
  status: PaymentStatus;
  amount_cents: number;
  sender_batch_id: string;
  paypal_batch_id?: string;
  paypal_item_id?: string;
  paypal_order_id?: string;
  paypal_capture_id?: string;
  error_code?: string;
  created_at: string;
  updated_at: string;
}

export interface PaymentExecutionParams {
  groupId: string;
  proposalId: string;
  amountCents: number;
  vendorEmail: string;
  senderBatchId: string;
  attempt?: number;
}

export interface PaymentExecutionOutcome {
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'UNCLAIMED';
  batchId: string;
  itemId?: string;
  rawResponse: any;
  recoveredDuplicate?: boolean;
}

export interface VendorPaymentAdapter {
  executePayment(params: PaymentExecutionParams): Promise<PaymentExecutionOutcome>;
}

export interface ExecutionTransactionResult {
  success: boolean;
  phase:
    | 'GUARD_BLOCKED'
    | 'PAYMENT_SUBMITTED'
    | 'PAYMENT_SUCCEEDED'
    | 'PAYMENT_FAILED'
    | 'PAYMENT_PENDING_RECOVERY';
  paymentId?: string;
  senderBatchId?: string;
  paypalBatchId?: string;
  guardResult?: GuardResult;
  error?: string;
  code?: string;
}
