import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await getCurrentAccount()
  } catch (err) {
    return toErrorResponse(err)
  }

  const admin = supabaseAdmin()
  const { data: automation, error: autErr } = await admin
    .from('automations')
    .select('*')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle()

  if (autErr) return NextResponse.json({ error: autErr.message }, { status: 500 })
  if (!automation) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: logs, error: logErr } = await admin
    .from('automation_logs')
    .select('*, contact:contacts(id, name, phone)')
    .eq('automation_id', id)
    .order('created_at', { ascending: false })
    .limit(100)

  if (logErr) return NextResponse.json({ error: logErr.message }, { status: 500 })

  return NextResponse.json({ automation, logs: logs ?? [] })
}
