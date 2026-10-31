const { GoogleGenAI } = require('@google/genai');
const { withRetry } = require('../utils/retry');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function analyzeDiff(diff, staticFindings = []) {
  const prompt = `
You are a senior developer explaining code review findings to a teammate. A static analysis tool has already identified the following technical issues in this code. Your job is to review the surrounding code changes and provide additional context: readability, logic, and best-practice observations that a static tool might miss. Do not restate the security findings below - they're already known. Focus on other code quality aspects (naming, structure, edge cases, error handling).

Known static analysis findings (for context only, do not repeat these):
${JSON.stringify(staticFindings, null, 2)}

Respond ONLY with a valid JSON array using this structure:
[
  {
    "filePath": "string",
    "severity": "blocking" | "warning" | "nitpick",
    "category": "maintainability" | "readability" | "performance",
    "issue": "string",
    "suggestion": "string"
  }
]

If nothing additional is found, respond with exactly: []

Here is the diff:
${diff}
`;

  const response = await withRetry(() =>
    ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: prompt,
      config: {
        httpOptions: {
          timeout: 60000, // fail fast instead of hanging if Gemini is slow/unresponsive
          maxRetries: 0, // withRetry() already handles retries at a higher level
        },
      },
    })
  );

  let text = response.text.trim();

  if (text.startsWith('```')) {
    text = text.replace(/^```(json)?\n?/, '').replace(/```$/, '').trim();
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    console.error('Failed to parse Gemini response as JSON:', text);
    return [];
  }
}

module.exports = { analyzeDiff };