import OpenAI from "openai";

const apiKey = process.env.GROQ_API_KEY;

if (!apiKey) {
    console.error("Warning: GROQ_API_KEY is not set.");
}

const openai = new OpenAI({
    apiKey: apiKey || "dummy", // Prevent crash if not set, but calls will fail
    baseURL: "https://api.groq.com/openai/v1",
});

interface GeneratedQuestion {
    question: string;
    options: string[];
    correct_index: number;
}

export async function generateQuestions(text: string, studyKey: string): Promise<GeneratedQuestion[]> {
    if (!process.env.GROQ_API_KEY) {
        throw new Error("GROQ_API_KEY is not configured.");
    }

    const prompt = `
You are an expert tutor generating active recall questions.
The user is studying: '${studyKey}'.

Your goal is to generate as many multiple-choice questions as necessary to cover the key concepts in the text below.
- Do not limit yourself to 3 questions; generate more if the text contains enough information.
- Ensure the questions are NOT REDUNDANT (do not ask the same thing in different ways).
- Use your best judgment to determine the appropriate number of questions.

INPUT HANDLING:
- The user text may be partially malformed, contain "garbage" characters, or be copy-pasted LaTeX that lost formatting.
- Do your best to interpret the intended meaning and reconstruct valid concepts.
- If the text is completely unintelligible, return an empty array.
- It is OK to use LaTeX notation (e.g., $x^2$, $\\sum$) in the questions and options if appropriate and correct.

CRITICAL: Since these questions will be reviewed randomly later, they must be SELF-CONTAINED.
- DO NOT use words like "this theory", "the text", "here", "above".
- Explicitly state the subject/context in the question text itself.
- Example Bad: "What is the primary relationship in this theory?"
- Example Good: "What is the primary relationship in Zermelo-Fraenkel set theory?"
- LANGUAGE: The questions and options MUST be in the SAME LANGUAGE as the User Text. If the text is in Russian, generate Russian questions. If English, English.

User Text:
"""
${text}
"""

Return ONLY a raw JSON array (no markdown code blocks) of objects with this structure:
[
  {
    "question": "The question text",
    "options": ["Option A", "Option B", "Option C"],
    "correct_index": 0 // The index of the correct option in the array
  }
]
`;

    try {
        const completion = await openai.chat.completions.create({
            model: "moonshotai/kimi-k2-instruct-0905",
            messages: [
                { role: "system", content: "You are a helpful AI tutor that generates JSON output." },
                { role: "user", content: prompt }
            ],
            temperature: 0.7,
        });

        const content = completion.choices[0]?.message?.content?.trim();
        if (!content) return [];

        // Clean up markdown code blocks if present (despite instruction)
        const cleanContent = content.replace(/```json/g, "").replace(/```/g, "").trim();
        
        const initialQuestions = JSON.parse(cleanContent) as GeneratedQuestion[];
        if (initialQuestions.length === 0) return [];

        // Step 2: Context Check
        return await filterBadQuestions(initialQuestions, text);

    } catch (error) {
        console.error("Error generating questions:", error);
        return [];
    }
}

async function filterBadQuestions(questions: GeneratedQuestion[], originalText: string): Promise<GeneratedQuestion[]> {
    // Only verify if we have questions
    if (questions.length === 0) return [];

    const prompt = `
You are a strict quality control bot.
You will be given a list of questions generated from a source text.

Your job is to VALIDATE each question for:
1. CONTEXT: Questions must be SELF-CONTAINED. They must NOT refer to "the text", "this paragraph", etc. without naming the subject.
2. CORRECTNESS: The "correct_index" must point to the actually correct option based on the source text provided below.
3. LOGIC: The question and answer must make sense, even if the original text was partially malformed.

Source Text:
"""
${originalText}
"""

Questions to Review:
${JSON.stringify(questions, null, 2)}

Return a JSON array of integers representing the INDICES of the questions that are GOOD, SELF-CONTAINED, and CORRECT.
Discard any questions that lack context or are factually wrong based on the text.
Example Output: [0, 2, 5]
`;

    try {
        const completion = await openai.chat.completions.create({
            model: "moonshotai/kimi-k2-instruct-0905",
            messages: [
                { role: "system", content: "You are a quality control bot that outputs JSON arrays of indices." },
                { role: "user", content: prompt }
            ],
            temperature: 0.1, // Low temp for strict logic
        });

        const content = completion.choices[0]?.message?.content?.trim();
        if (!content) return questions; // Fallback: keep all if check fails

        const cleanContent = content.replace(/```json/g, "").replace(/```/g, "").trim();
        const goodIndices = JSON.parse(cleanContent) as number[];

        if (!Array.isArray(goodIndices)) return questions;

        // Filter original array
        return questions.filter((_, i) => goodIndices.includes(i));
    } catch (e) {
        console.error("Error in context check:", e);
        return questions; // Fallback
    }
}
