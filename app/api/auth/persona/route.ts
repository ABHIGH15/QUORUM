/**
 * Member Persona Switcher Session Cookie Endpoint (§11.1)
 * 
 * Sets or retrieves the `quorum_member_id` cookie for hackathon evaluation
 * allowing judges to seamlessly act as any of the 6 group members.
 */

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const memberId = body.memberId;

    if (!memberId || typeof memberId !== 'string') {
      return Response.json({ error: 'Valid memberId is required' }, { status: 400 });
    }

    const response = Response.json({ success: true, memberId });
    response.headers.set(
      'Set-Cookie',
      `quorum_member_id=${encodeURIComponent(memberId)}; Path=/; SameSite=Lax; Max-Age=2592000`
    );
    return response;
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const cookieHeader = request.headers.get('cookie') || '';
  const match = cookieHeader.match(/(?:^|;\s*)quorum_member_id=([^;]+)/);
  const memberId = match ? decodeURIComponent(match[1].trim()) : null;
  return Response.json({ memberId });
}
