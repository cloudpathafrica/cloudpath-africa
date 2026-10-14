import { z } from "zod";

export const TRACKS = ["devops", "cloud", "security"] as const;
export const DIFFICULTIES = ["beginner", "intermediate", "advanced"] as const;

export const ProjectSchema = z.object({
  title: z.string().min(5),
  track: z.enum(TRACKS),
  difficulty: z.enum(DIFFICULTIES),
  objective: z.string().min(20),
  prerequisites: z.array(z.string()).min(1),
  costWarning: z.string().min(10),
  steps: z
    .array(
      z.object({
        title: z.string(),
        instructions: z.string(),
                commands: z.array(z.string()).default([]),
        files: z
          .array(z.object({ path: z.string().min(1), content: z.string() }))
          .default([]),
        verify: z.string(),
      })
    )
    .min(3),
  verificationCheck: z.string(),
  cleanup: z.array(z.string()).min(1),
  documentationTips: z.array(z.string()).min(1),
});

export type Project = z.infer<typeof ProjectSchema>;