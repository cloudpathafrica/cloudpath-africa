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
  let hasDockerfile = false;
  let hasDockerignore = false;
  let hasTerraform = false;
  let hasFiles = false;
  let gitignoreText = "";
  let commandsText = "";

  project.steps.forEach((step, i) => {
    for (const file of step.files) {
      hasFiles = true;
      const base = file.path.split("/").pop() ?? file.path;
      if (base === ".gitignore") {
        if (gitignoreStep === -1) gitignoreStep = i;
        gitignoreText += file.content + "\n";
      }
      if (base === "Dockerfile") hasDockerfile = true;
      if (base === ".dockerignore") hasDockerignore = true;
      if (base.endsWith(".tf")) hasTerraform = true;
      if (/(^|\/)requirements\.txt$/i.test(file.path) && file.content.includes("==")) {
        problems.push(`${file.path} pins exact versions with ==, use unpinned package names`);
      }
    }

    for (const raw of step.commands) {
      const cmd = raw.trim();
      commandsText += cmd + "\n";
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

    // Web addresses must be checked with curl, not inline Python.
    for (const text of [verify, ...step.commands]) {
      if (/urlopen\s*\(/.test(text) || /python3?\s+-m\s+\S*\(/.test(text)) {
        problems.push(`step "${step.title}": check web addresses with curl, not inline Python`);
        break;
      }
    }

    // Verify must not remove things, removal belongs in cleanup.
    if (/(docker\s+(stop|rm|rmi|kill)|docker\s+compose\s+down|terraform\s+destroy|rm\s+-rf)/i.test(verify)) {
      problems.push(`step "${step.title}": do not remove resources in verify, put removal in cleanup`);
    }
  });

  if (firstAddAllStep !== -1 && (gitignoreStep === -1 || gitignoreStep > firstAddAllStep)) {
    problems.push("git add . is used without a .gitignore file created in the same or an earlier step");
  }

  if (hasDockerfile && !hasDockerignore) {
    problems.push("a project with a Dockerfile must also include a .dockerignore file");
  }

  // Terraform projects: state files hold secrets, the lock file should be committed.
  if (hasTerraform && !/tfstate/.test(gitignoreText)) {
    problems.push("a Terraform project must list *.tfstate in .gitignore so state files are never committed");
  }
  if (/terraform\.lock\.hcl/.test(gitignoreText)) {
    problems.push(".terraform.lock.hcl should be committed, do not list it in .gitignore");
  }

  // The project is the learner's portfolio deliverable, so it must reach GitHub and survive cleanup.
  if (hasFiles && !/git\s+push|--push/.test(commandsText)) {
    problems.push("include a step that pushes the project to GitHub, the project is the learner's deliverable");
  }
  if (/\brm\s+-[a-zA-Z]*r/.test(project.cleanup.join(" "))) {
    problems.push("cleanup must not delete the project folder with rm -rf, the project is the deliverable");
  }

  const cleanupText = project.cleanup.join(" ");
  if (/docker\s+(run|compose\s+up)/.test(commandsText) && !/docker\s+(stop|rm|compose\s+down)/.test(cleanupText)) {
    problems.push("cleanup must stop and remove the containers the project starts");
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