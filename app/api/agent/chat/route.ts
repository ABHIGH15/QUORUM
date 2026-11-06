import { getPool } from '@/lib/db/pool';
import { runAgent } from '@/lib/agent/agent';

/**
 * AI Agent Chat & Adapt Loop Endpoint (§9)
 * 
 * Invokes the Quorum Purchasing Agent (Gemini 3.8 Flash / Deterministic Adapt Loop)
 * to research items, evaluate against policy, and draft proposals.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { groupId, message } = body;

    if (!groupId || !message) {
      return Response.json(
        { error: 'Missing required fields: groupId and message are required.' },
        { status: 400 }
      );
    }

    const pool = getPool();
    const result = await runAgent({
      pool,
      groupId,
      query: message,
    });

    return Response.json(result);
  } catch (err: any) {
    console.error('[API Agent Chat Error]', err);
    return Response.json(
      { error: err.message || 'Agent failed to process request' },
      { status: 500 }
    );
  }
}
