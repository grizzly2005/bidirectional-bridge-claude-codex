import { z } from "zod";
import type { ProjectResumeInput } from "@bridge/control-plane";
import type { ToolDefinition } from "./tools.js";

export const RESUME_TOOLS: readonly ToolDefinition[] = [
  {
    name: "bridge_resume_project",
    title: "Build a concise project resume card",
    description: "Discover this database's project memory scopes, proven results, open tasks and next actions for a fresh chat. Omitting branch includes every branch and the branchless scope. Returns no artifact bodies or runtime handles.",
    inputShape: {
      namespace: z.enum(["development", "bug-bounty"]).optional(),
      context_id: z.string().min(1).max(128).optional(),
      branch: z.string().min(1).max(256).nullable().optional(),
      max_bytes: z.number().int().min(2048).max(65536).optional(),
      max_items_per_section: z.number().int().min(1).max(25).optional(),
    },
    handler: (args, ctx) => ctx.cp.resume.getProjectResume(args as ProjectResumeInput),
  },
];
