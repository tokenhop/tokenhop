import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { SKILLS } from "@/shared/constants/skills";

export const dynamic = "force-dynamic";

const VALID_SKILL_IDS = new Set(SKILLS.map((skill) => skill.id));

/**
 * Public route: serves gateway-hosted agent skills as raw markdown.
 * Accessible at:
 *   /skills/[id]
 *   /skills/[id]/SKILL.md
 *
 * Safe against path traversal: only allowlisted skill ids are accepted.
 * @param {Request} _request Incoming request (unused).
 * @param {{ params: Promise<{ slug: string[] }> }} context Route params.
 * @returns {Promise<NextResponse>} Markdown body or 404.
 */
export async function GET(_request, { params }) {
  const resolvedParams = await params;
  const segments = resolvedParams?.slug;
  if (!Array.isArray(segments) || segments.length === 0 || segments.length > 2) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const [id, filename] = segments;
  if (!VALID_SKILL_IDS.has(id)) {
    return new NextResponse("Not Found", { status: 404 });
  }
  if (filename && filename !== "SKILL.md") {
    return new NextResponse("Not Found", { status: 404 });
  }

  const filePath = path.join(process.cwd(), "skills", id, "SKILL.md");
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return new NextResponse(content, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch {
    return new NextResponse("Skill content unavailable", { status: 404 });
  }
}
