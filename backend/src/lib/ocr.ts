import { createWorker } from 'tesseract.js';

export async function extractTextFromImage(imageBuffer: Buffer, languages: string = 'eng+tha'): Promise<string> {
    try {
        // V6 usage: createWorker('eng+tha')
        const worker = await createWorker(languages);

        const { data: { text } } = await worker.recognize(imageBuffer);

        await worker.terminate();
        return text;
    } catch (error) {
        console.error("OCR Error", error);
        throw error;
    }
}
