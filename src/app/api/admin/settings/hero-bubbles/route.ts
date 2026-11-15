import { NextResponse } from "next/server";
import { revalidatePath, revalidateTag } from "next/cache";
import { prisma } from "@/lib/db";
import { requireAdminSession } from "@/lib/auth";
import { isSameOriginMutation, readBoundedJson } from "@/lib/request-security.mjs";
import { logServerError } from "@/lib/server-log.mjs";

const IMAGE_FIELD_BY_POSITION = {
  center: "heroMainImage",
  topRight: "heroGheeImage",
  bottomLeft: "heroAlmondsImage",
} as const;

const MAX_IMAGE_LENGTH = 750_000;

function isValidImage(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_IMAGE_LENGTH) return false;
  return value.startsWith("/") ||
    /^https:\/\//i.test(value) ||
    /^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(value);
}

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await readBoundedJson(request, 800_000);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return NextResponse.json({ error: "Bubble image data is invalid." }, { status: 400 });
  }

  const body = parsed.value as Record<string, unknown>;
  const position = body.position as keyof typeof IMAGE_FIELD_BY_POSITION;
  const field = IMAGE_FIELD_BY_POSITION[position];
  if (!field || !isValidImage(body.image)) {
    return NextResponse.json({ error: "Choose a valid bubble image and try again." }, { status: 400 });
  }

  try {
    await prisma.storeSettings.update({
      where: { id: "default" },
      data: { [field]: body.image },
    });

    revalidateTag("store-settings", "max");
    revalidatePath("/");
    revalidatePath("/admin/settings");
    return NextResponse.json({ success: true, position });
  } catch (error) {
    logServerError("security.admin.settings.hero_bubble_update_failed", error);
    return NextResponse.json({
      error: "The database could not update this bubble image. The existing image was kept.",
    }, { status: 503 });
  }
}
