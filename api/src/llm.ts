import { GoogleGenAI } from "@google/genai";

export interface LlmProvider {
  generate(system: string, user: string): Promise<string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const gemini: LlmProvider = {
  async generate(system, user) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
    const ai = new GoogleGenAI({ apiKey });
    const model = process.env.LLM_MODEL ?? "gemini-3.8-flash";

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await ai.models.generateContent({
          model,
          contents: user,
          config: {
            systemInstruction: system,
            responseMimeType: "application/json",
            temperature: 0.2,
          },
        });
        return res.text ?? "";
      } catch (err: any) {
        // Retry once on temporary overload (503) only.
        // A 429 means the quota is used up, so fail fast.
        if (err?.status !== 503 || attempt === 1) throw err;
        await sleep(3000);
      }
    }
    throw new Error("Model call failed");
  },
};

const providers: Record<string, LlmProvider> = { gemini };

export function getProvider(): LlmProvider {
  const name = process.env.LLM_PROVIDER ?? "gemini";
  const provider = providers[name];
  if (!provider) throw new Error(`Unknown LLM_PROVIDER: ${name}`);
  return provider;
}