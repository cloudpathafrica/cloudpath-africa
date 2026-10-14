import { parse as parseYaml } from "yaml";
import { ProjectSchema, Project } from "./schema";
import { getProvider } from "./llm";
import { SYSTEM_PROMPT } from "./prompt";

function checkFiles(project: Project): void {
  for (const step of project.steps) {
    for (const file of step.files) {
      if (/\.ya?ml$/i.test(file.path)) {
        const doc = parseYaml(file.content); // throws on invalid YAML
        if (file.path.includes(".github/workflows/")) {
          const on = doc?.on;
          if (!on || !doc?.jobs) {
            throw new Error(`${file.path}: workflow needs "on" and "jobs"`);
          }
          for (const key of ["branches", "tags", "paths"]) {
            if (typeof on === "object" && key in on) {
              throw new Error(`${file.path}: "${key}" must be nested under an event such as push`);
            }
          }
          for (const [name, job] of Object.entries<any>(doc.jobs)) {
            if (!job["runs-on"] && !job.uses) {
              throw new Error(`${file.path}: job "${name}" needs runs-on`);
            }
          }
        }
      } else if (/\.json$/i.test(file.path)) {
        JSON.parse(file.content);
      }
    }
  }
}

export async function generateProject(prompt: string): Promise<Project> {
  const provider = getProvider();
  let lastError = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    const user =
      attempt === 0
        ? prompt
        : `${prompt}\n\nYour previous output failed validation: ${lastError}\nReturn corrected JSON only.`;
    const raw = await provider.generate(SYSTEM_PROMPT, user);
    try {
      const project = ProjectSchema.parse(JSON.parse(raw));
      checkFiles(project);
      return project;
    } catch (e) {
      lastError = String(e).slice(0, 500);
    }
  }
    throw new Error(`Generator returned invalid output after retry: ${lastError}`);
}