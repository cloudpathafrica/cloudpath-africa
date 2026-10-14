import { parse as parseYaml } from "yaml";
import { ProjectSchema, Project } from "./schema";
import { getProvider } from "./llm";
import { SYSTEM_PROMPT } from "./prompt";

// Check 1: YAML and JSON files must parse, and workflows must have the right shape.
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

// Check 2: rules the model tends to break. Collects every problem, then throws once.
function checkRules(project: Project): void {
  const problems: string[] = [];
  let gitignoreStep = -1;
  let firstAddAllStep = -1;

  project.steps.forEach((step, i) => {
    for (const file of step.files) {
      const isGitignore = file.path === ".gitignore" || file.path.endsWith("/.gitignore");
      if (isGitignore && gitignoreStep === -1) gitignoreStep = i;
      if (/(^|\/)requirements\.txt$/i.test(file.path) && file.content.includes("==")) {
        problems.push(`${file.path} pins exact versions with ==, use unpinned package names`);
      }
    }

    for (const raw of step.commands) {
      const cmd = raw.trim();
      if (/^git\s+add\s+(\.|-A|--all)(\s|$)/.test(cmd) && firstAddAllStep === -1) {
        firstAddAllStep = i;
      }
      if (/^git\s+init\s*$/.test(cmd)) {
        problems.push(`step "${step.title}": use git init -b main`);
      }
      if (/^(pip3?|pytest)(\s|$)/.test(cmd)) {
        problems.push(`step "${step.title}": use python -m pip or python -m pytest so it works on Windows, macOS and Linux`);
      }
      if (/\bactivate\b/.test(cmd) && /venv/.test(cmd)) {
        problems.push(`step "${step.title}": do not use virtual environment activation commands, they differ between operating systems`);
      }
    }

    const verify = step.verify.trim();
    if (/^(git status|git remote -v|ls|dir|tree|(cat|ls)\s+\S.*)$/i.test(verify)) {
      problems.push(`step "${step.title}": verify "${verify}" does not prove the step worked`);
    }
  });

  if (firstAddAllStep !== -1 && (gitignoreStep === -1 || gitignoreStep > firstAddAllStep)) {
    problems.push("git add . is used without a .gitignore file created in the same or an earlier step");
  }

  const text = JSON.stringify(project);
  if (text.includes("gh repo delete") && !text.includes("delete_repo")) {
    problems.push("gh repo delete needs the delete_repo permission, add: gh auth refresh -s delete_repo");
  }

  if (problems.length > 0) {
    throw new Error(problems.join("; "));
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
      checkRules(project);
      return project;
    } catch (e) {
      lastError = String(e).slice(0, 900);
    }
  }
  throw new Error(`Generator returned invalid output after retry: ${lastError}`);
}