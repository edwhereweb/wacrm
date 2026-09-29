import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    
    const { data, error } = await ctx.supabase
      .from("tags")
      .select("id, name, color")
      .eq("account_id", ctx.accountId)
      .order("name");

    if (error) {
      console.error("[GET /api/tags] db error:", error);
      return NextResponse.json(
        { error: "Failed to fetch tags" },
        { status: 500 },
      );
    }

    return NextResponse.json({ tags: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
