import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { z } from "zod";
import { generateProject } from "../generateProject";
import { TRACKS, DIFFICULTIES } from "../schema";

const BodySchema = z.object({
  track: z.enum(TRACKS),
  difficulty: z.enum(DIFFICULTIES),
  topic: z.string().min(3).max(200),
});

export async function generate(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return { status: 400, jsonBody: { error: "Invalid request" } };
  }
  const { track, difficulty, topic } = parsed.data;

  try {
    const project = await generateProject(
      `Track: ${track}\nDifficulty: ${difficulty}\nLearner request: """${topic}"""`
    );
    return { status: 200, jsonBody: project };
  } catch (err) {
    context.error(err);
    const detail =
      process.env.DEBUG_ERRORS === "true" ? String(err).slice(0, 800) : undefined;
    return {
      status: 502,
      jsonBody: { error: "Could not generate a project, try again", detail },
    };
  }
}

app.http("generate", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: generate,
});