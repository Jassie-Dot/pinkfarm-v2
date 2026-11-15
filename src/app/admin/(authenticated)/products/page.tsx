import { AdminProductsTable } from "./AdminProductsTable";
import { getStoreProducts } from "@/lib/defaultProducts";

import { connection } from "next/server";
import { logServerError } from "@/lib/server-log.mjs";

export default async function AdminProductsPage() {
  await connection();
  let products;
  try {
    products = await getStoreProducts({ includeUnavailable: true });
  } catch (error) {
    logServerError("security.admin_products.load_failed", error);
    return <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm font-medium text-red-800">Products and inventory are unavailable because the database could not be reached.</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-gray-200 pb-6">
        <div>
          <h1 className="text-3xl font-serif font-bold text-gray-900">Products & Inventory</h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage product details, pricing, images, and inventory quantities.
          </p>
        </div>
      </div>

      <AdminProductsTable initialProducts={products} />
    </div>
  );
}
