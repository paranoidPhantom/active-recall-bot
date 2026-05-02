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

export async function generateQuestions(text: string, studyKey: string, recursiveAttempt?: number): Promise<GeneratedQuestion[]> {
    if (!process.env.GROQ_API_KEY) {
        throw new Error("GROQ_API_KEY is not configured.");
    }
    if (recursiveAttempt <= 0) { return [] }

    const prompt = `
You are an expert tutor generating active recall questions.
The user is studying: '${studyKey}'.
Hint: ДМ stand for discrete mathematics, АиСД stands for algorithms and data structures, Линал stands for linear algebra.

Your goal is to parse the user's question into valid json;
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
        if (initialQuestions.length === 0) return generateQuestions(text, studyKey, (recursiveAttempt ?? 3) - 1);

        // Step 2: Context Check
        const validatedQuestions = initialQuestions; // await filterBadQuestions(initialQuestions, text);

        // Step 3: Randomize options (LLM bias fix)
        return validatedQuestions.map(shuffleOptions);

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
4. SOLUTION: Try to solve the problems yourself and fact check them.
5. UNIQUENESS: If multiple questions are essentially variations of each other, choose only the best one of them.

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

function shuffleOptions(q: GeneratedQuestion): GeneratedQuestion {
    const indices = q.options.map((_, i) => i);
    // Fisher-Yates shuffle
    for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    
    const newOptions = indices.map(i => q.options[i]);
    const newCorrectIndex = indices.indexOf(q.correct_index);
    
    return {
        ...q,
        options: newOptions,
        correct_index: newCorrectIndex
    };
}
