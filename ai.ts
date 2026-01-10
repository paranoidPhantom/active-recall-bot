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
        return await filterBadQuestions(initialQuestions);

    } catch (error) {
        console.error("Error generating questions:", error);
        return [];
    }
}

async function filterBadQuestions(questions: GeneratedQuestion[]): Promise<GeneratedQuestion[]> {
    // Only verify if we have questions
    if (questions.length === 0) return [];

    const prompt = `
You are a strict quality control bot.
You will be given a list of questions.
Your job is to identify questions that are AMBIGUOUS, LACK CONTEXT, or refer to "the text", "this paragraph", "the author", etc. WITHOUT naming the specific subject.

These questions will be presented to a user in isolation (randomly).
They MUST be answerable without seeing the original source text.

Examples of BAD questions (Reject):
- "What does the author say about this?" (Who is the author? What is 'this'?)
- "Which of the following is true according to the text?" (What text?)
- "What are the three main components mentioned?" (Mentioned where?)

Examples of GOOD questions (Keep):
- "What are the three main components of Newton's Second Law?"
- "According to the dependency injection pattern, what is a service?"

Review the following questions:
${JSON.stringify(questions.map((q, i) => ({ index: i, question: q.question })), null, 2)}

Return a JSON array of integers representing the INDICES of the questions that are GOOD and SELF-CONTAINED.
Discard any questions that lack context.
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
