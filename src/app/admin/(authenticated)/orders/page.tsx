import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { logServerError } from "@/lib/server-log.mjs";
import { OrdersTable } from "./OrdersTable";
import { connection } from "next/server";

export const instant = false;

export default async function AdminOrdersPage() {
  await connection();
  let orders: Prisma.OrderGetPayload<{ include: { items: true } }>[] = [];
  let databaseUnavailable = false;
  try {
    orders = await prisma.order.findMany({
      orderBy: { createdAt: "desc" },
      include: { items: true },
    });
  } catch (err) {
    databaseUnavailable = true;
    logServerError("security.admin_orders.load_failed", err);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-gray-200 pb-6">
        <div>
          <h1 className="text-3xl font-serif font-bold text-gray-900">Orders</h1>
          <p className="text-sm text-gray-500 mt-1">
            Track and manage your customer orders, fulfillment, and payment statuses.
          </p>
        </div>
        <div className="text-sm font-semibold text-gray-600 bg-white px-4 py-2 rounded-xl border border-gray-200">
          Total Orders: <span className="text-brand-green font-bold">{orders.length}</span>
        </div>
      </div>

      {databaseUnavailable ? (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm font-medium text-red-800">
          Orders are unavailable because the database could not be reached. The empty list is not a confirmation that there are no orders. Check Settings → Database diagnostics.
        </div>
      ) : <OrdersTable orders={orders} />}
    </div>
  );
}
