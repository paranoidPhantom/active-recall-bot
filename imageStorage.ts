import { promises as fs } from 'fs';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';

export const IMAGE_STORAGE_ROOT = '/data/images';

// Ensure storage directory exists
if (!existsSync(IMAGE_STORAGE_ROOT)) {
    mkdirSync(IMAGE_STORAGE_ROOT, { recursive: true });
}

export async function saveQuestionImage(questionId: number, imageBuffer: Buffer): Promise<string> {
    const questionDir = path.join(IMAGE_STORAGE_ROOT, questionId.toString());
    
    if (!existsSync(questionDir)) {
        mkdirSync(questionDir, { recursive: true });
    }
    
    const imagePath = path.join(questionDir, 'question.png');
    await fs.writeFile(imagePath, imageBuffer);
    
    return imagePath;
}

export function getQuestionImagePath(questionId: number): string {
    return path.join(IMAGE_STORAGE_ROOT, questionId.toString(), 'question.png');
}

export function imageExists(questionId: number): boolean {
    const imagePath = getQuestionImagePath(questionId);
    return existsSync(imagePath);
}

export async function deleteQuestionImage(questionId: number): Promise<void> {
    const imagePath = getQuestionImagePath(questionId);
    const questionDir = path.dirname(imagePath);
    
    try {
        if (existsSync(imagePath)) {
            await fs.unlink(imagePath);
        }
        // Remove directory if empty
        const files = await fs.readdir(questionDir);
        if (files.length === 0) {
            await fs.rmdir(questionDir);
        }
    } catch (error) {
        console.error(`Error deleting image for question ${questionId}:`, error);
    }
}
