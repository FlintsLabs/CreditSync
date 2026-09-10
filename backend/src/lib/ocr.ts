import { createWorker } from 'tesseract.js';

type OcrWorker = {
    recognize: (image: Buffer) => Promise<{ data: { text: string } }>;
    terminate: () => Promise<unknown>;
};

type OcrWorkerFactory = (languages: string) => Promise<OcrWorker>;

export async function extractTextFromImage(
    imageBuffer: Buffer,
    languages: string = 'eng+tha',
    workerFactory: OcrWorkerFactory = createWorker as unknown as OcrWorkerFactory,
): Promise<string> {
    let worker: OcrWorker | undefined;
    try {
        worker = await workerFactory(languages);

        const { data: { text } } = await worker.recognize(imageBuffer);
        return text;
    } finally {
        if (worker) await worker.terminate();
    }
}
