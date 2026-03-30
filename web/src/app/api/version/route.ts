import { NextResponse } from "next/server";

export const dynamic = "force-static";

export function GET() {
  return NextResponse.json({
    version: process.env.NEXT_PUBLIC_APP_VERSION ?? "dev",
    sha: process.env.NEXT_PUBLIC_BUILD_SHA ?? "local",
    buildDate: process.env.NEXT_PUBLIC_BUILD_DATE ?? null,
  });
}
