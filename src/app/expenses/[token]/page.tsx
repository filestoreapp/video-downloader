import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getExpenseToken, getFriendName } from "@/lib/expenses";
import Tracker from "./tracker";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Expense Tracker",
  robots: { index: false, follow: false },
};

/**
 * Private expense tracker. The token in the URL is the only gate —
 * a wrong token renders the 404 page, so the tracker is invisible
 * to anyone without the link.
 */
export default async function ExpensePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (token !== getExpenseToken()) notFound();
  return <Tracker token={token} friendName={getFriendName()} />;
}
